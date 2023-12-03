import { Buffer } from 'buffer'
import Kbucket from 'k-bucket';
import {IUserId,ISignedUserId,IStorageEntry,ISignedStorageEntry,ISignedStorageMerkleNode,IStorageMerkleNode,IStorage, ISignedStorageBtreeNode } from './IStorage'
import { PeerFactory,  BasePeer, MAX_TS_DIFF,  checkUserName, userIdHash,  MAXMSGSIZE, IReceiveMessagesResult} from './peer';
import Debug from 'debug';
import { MerkleReader,MerkleWriter,IMerkleNode} from './merkle';
import {DisDhtBtree,IBtreeNode} from './DisDhtBtree';
import {sha} from './mysodium';
import Semaphore from './semaphore';
import {EventEmitter} from 'events'
import { encode } from './encoder';

const KPUT = 20;
const KGET = KPUT*4;
const MAXVALUESIZE = 2*1024;
export const NODESIZE = MAXMSGSIZE-500;
const ZEROBUF=Buffer.alloc(0);
const STREAMHIGH=5;
const BACKGROUND_PAUSE=60*1000;


interface ServerIp {
    port: number,
    host?: string
}

interface DisDHToptions {
    secretKey: Buffer,
    storage: IStorage,
    seed?: ServerIp[],
    servers?: ServerIp[],
    debug?: Debug.Debugger,
}

const ONMESSAGE="message";

export interface ImessageEvent{
    author:Buffer,
    content:Buffer
}

export class DisDHT extends EventEmitter{
    private KEYLEN:number=sha(ZEROBUF).length;
    private _opt: DisDHToptions;
    private _peerFactory: PeerFactory;
    private _kbucket: Kbucket;
    private _debug:Debug.Debugger;
    private _startup:boolean=false;
    private _lastMessage:number=0;
    public _storage:IStorage;
    private _intervalBackgroundProcess:any;
    private _onceatime:Semaphore;

    constructor(opt: DisDHToptions) {
        super();
        this._onceatime=new Semaphore(1);
        this._opt = opt;
        this._storage=opt.storage;

        this._peerFactory = new PeerFactory(opt.storage, opt.secretKey);
        this._peerFactory.on("message",sse=>{
            this.emitSignedStorageEntry(sse);
        })


        this._debug=opt.debug || Debug("DisDHT     :"+this._peerFactory.id.toString('hex').slice(0,6));
        this._debug.color=this._peerFactory.debug.color;
        this._kbucket = this._peerFactory.kbucket;
        this._debug("created");
    }

    get id () :Buffer {
        return this._peerFactory.id;
    }

    async startUp() {
        this._debug("DisDHT startUp...")
        try{
            await this._onceatime.dec();
            await this._seed();
            this._startup=true;
        }finally{
            this._onceatime.inc();
        }
        await this._backgroundIteration();
        setImmediate(()=>{this._backgroundProcess()})
        this._debug("DisDHT startUp done")
    }

    private async _seed(){
        if (this._opt.servers)
            for (var server of this._opt.servers)
                await this._peerFactory.createListener(server.port, server.host)
        if (this._opt.seed)
            for (var s of this._opt.seed)
                if (s.host)
                    await this._peerFactory.createClient(s.port, s.host);
                else
                    throw new Error("missing host name");
    }

    private _backgroundProcess(){
        this._intervalBackgroundProcess=setInterval(()=>{
            this._backgroundIteration()
            .then(iter=>{
                if (!iter)
                    this._debug("_backgroundProcess did not run");
            })
            .catch(err=>{
                console.error("Background iteration FAILED due to %o",err);
            })
        },BACKGROUND_PAUSE)
    }

    async shutdown(){
        this._debug("shutdown...");
        try{
            await this._onceatime.dec();
            if (!this._startup) throw new Error("not started up");

            if (this._intervalBackgroundProcess) clearInterval(this._intervalBackgroundProcess);
            this._intervalBackgroundProcess=null;
    
            await this._peerFactory.shutdown();
            this._startup=false;
    
            this._debug("shutdown DONE");

        }finally{
            this._onceatime.inc();
        }

    }

    /**
     * put userId to point to me.
     * the close nodes are trusted not to accept changes.
     * @param signedUserId 
     * @returns 
     */

    public async setUser(userId:string):Promise<boolean>{
        this._debug("setUser...");

        const signedUserId=this._peerFactory.createSignedUserName(userId);

        if (!this._startup) throw new Error("not started up");
        var falsecnt=0;
        var truecnt=0;

        const callback=async (peer:BasePeer)=>{
            var r=await peer.setUserId(signedUserId,KPUT);
            if (r==null) 
                return [];
            else if (!r) {
                falsecnt++;
                return [];
            }
            else{
                truecnt++;
                return r;
            }
        }

        try{
            await this._onceatime.dec();
            await this._closestNodesNavigator(signedUserId.entry.userHash,KPUT,callback);
        }finally{
            this._onceatime.inc();
        }

        var r=truecnt > 1 && truecnt > falsecnt
        this._debug("setUser DONE "+r);
        return r;
    }

    /**
     * 
     * @param userId get userId public key
     * @returns 
     */

    public async getUser(userId:string):Promise<Buffer|null>{
        this._debug("getUser...");    

        if (!this._startup) throw new Error("not started up");
        const userHash=userIdHash(userId);

        interface EC{
            se:ISignedUserId,
            score:number
        }
        var author2cnt:Map<string,EC>=new Map();

        const callback=async (peer:BasePeer)=>{
            let r=await peer.getUserId(userHash,KGET);
            if (r==null) return [];
            if (r.value){
                let sa=r.value.entry.author.toString('hex');
                let ec=author2cnt.get(sa);
                if (!ec){
                    ec= { se:r.value, score:0 };
                    author2cnt.set(sa,ec);
                }
                ec.score+=1;
            }
            return r.peers;
        }

        try{
            await this._onceatime.dec();
            await this._closestNodesNavigator(userHash,KPUT,callback);
        }finally{
            this._onceatime.inc();
        }
  
        let maxscore=0;
        let r=null;
        for (var se of author2cnt.values()){
            if (se.score>maxscore) {
                r=se.se;
                maxscore=se.score
            }
        }
        var rr=r?r.entry.author:null;
        this._debug("getUser DONE "+rr?.toString('hex'));
        return rr;
    }

    /**
     * store in the closed nodes {key: value:}
     * 
     * @param key:Buffer the key to save
     * @param value: the value
     * @returns number of Nodes in which it was saved
     */

    public async sendMessage(destination: Buffer, content: Buffer):Promise<number> {
        this._debug("sendMessage to %s : %o",destination.toString('hex').slice(0,6),content);
        if (!this._startup) throw new Error("not started up");

        if (!(destination instanceof Buffer) || destination.length!=this.KEYLEN)
            throw new Error("invalid key");

        if (content.length>MAXVALUESIZE){
            throw new Error("content too long");
        }

        var sse=this._peerFactory.createStorageEntry(destination,content);

        var r=0;

        const callback=async (peer:BasePeer)=>{
            r++;
            let peers= await peer.store(sse,KPUT);
            return peers;
        }

        try{
            await this._onceatime.dec();
            await this._closestNodesNavigator(destination,KPUT,callback);
        }finally{
            this._onceatime.inc();
        }

        this._debug("sendMessage DONE "+r);
        return r;
    }

    /**
     * store a stream in the DHT and return the infoHash that identify it.
     * Merkle tree algorithm: the stream will be identified by a single hashcode
     * hashcode depends on content only. 
     * 
     * @param readableStream:ReadableStream to store in the DHT
     * @returns buffer identifing the infohash
     */

    public async putStream(readableStream:ReadableStream):Promise<Buffer>{  
        this._debug("putStream....");
        try{
            await this._onceatime.dec();

            if (!this._startup) throw new Error("not started up");
            const emit = async (n:IMerkleNode) => { 
                let smn = this._peerFactory.createSignedMerkleNode(n);
                const callback = async (peer:BasePeer) => {
                    //await peer.storeMerkleNode(smn,KPUT);
                    return await peer.storeMerkleNode(smn,KPUT);
                }
                await this._closestNodesNavigator(n.infoHash,KPUT,callback);
            }
            const mw = new MerkleWriter(emit,sha,NODESIZE);
            let reader = readableStream.getReader();
            let chunk = await reader.read();
            while(!chunk.done){
                await mw.update(chunk.value);
                chunk = await reader.read();
            }
            await reader.cancel();
            var r=await mw.done();
            this._debug("putStream DONE");        
            return r;

        }finally{
            this._onceatime.inc();
        }

    }

    protected async _getMerkleNode(infoHash:Buffer):Promise<IStorageMerkleNode|undefined>{
        if (!this._startup) throw new Error("not started up");
        var r:IStorageMerkleNode|undefined;

        const callback=async (peer:BasePeer)=>{
            let f=await peer.findMerkleNode(infoHash,KGET);
            if (Array.isArray(f))   
                return f;
            r=f.entry;
            return null;
        } 

        try{
            await this._onceatime.dec();
            await this._closestNodesNavigator(infoHash,KGET,callback);
        }finally{
            this._onceatime.inc();
        }

        return r;
    }

    /**
     * get a stream stored in the DHT
     * @param infoHash:Buffer
     * @returns ReadableStream
     */

    public getStream(infoHash:Buffer):ReadableStream{
        this._debug("getStream....");

        if (!this._startup) throw new Error("not started up");

        if (!(infoHash instanceof Buffer) || infoHash.length!=this.KEYLEN)
            throw new Error("invalid key");

        const high=new Semaphore(STREAMHIGH);
        const low=new Semaphore(0);
        const msgbuffer:Buffer[]=[];
        var done:boolean=false;
        var error:Error|null=null;
        var cancelled=false;

        const emitchunk=async (msg:Buffer)=>{
            msgbuffer.push(msg);
            low.inc();
            await high.dec();
        };

        const read=async (ih:Buffer)=>{
            if (cancelled) return;
            var r = await this._getMerkleNode(ih);
            if (!r) return;
            return r.node;
        };

        const mr=new MerkleReader(read,sha,emitchunk);
        mr.check(infoHash)
        .then(checkRes=>{
            if(checkRes)
                done=true;
            else
                error=new Error("stream corrupted");
            low.zero();
            high.zero();
        })
        .catch(err=>{
            error=err;
        })

        return new ReadableStream({
            async pull(controller) {     
                if (done)
                    return controller.close();
                if (error)
                    return controller.error(error);
                high.inc();
                await low.dec();
                let b=msgbuffer.shift();
                if (b) controller.enqueue(b);
            },
            async cancel(controller) {
                cancelled=true;
                low.zero();
                high.zero();
            }
        });
    }

    public receiveOwnMessage( ):Promise<Buffer|null>{
        return this.receiveMessageFromAuthor();
    }

    /**
     *  
     * @param author 
     * @param found 
     * @returns 
     */

    public async receiveMessageFromAuthor( author?: Buffer):Promise<Buffer|null> {
        this._debug("getKeyAuthor....");
        if (!this._startup) throw new Error("not started up");
        const key=this.id;

        if (!(key instanceof Buffer) || key.length!=this.KEYLEN)
            throw new Error("invalid key");

        var realAuthor=author?author:this.id;

        if (!(realAuthor instanceof Buffer) || realAuthor.length!=this.KEYLEN)
            throw new Error("invalid author");

        var isv:IStorageEntry|undefined;

        const callback=async (peer:BasePeer)=>{
            try{
                let fr=await peer.findValueAuthor(realAuthor,KGET);
                if (fr==null) return null;
                for (var v of fr.values)
                    if (isv===undefined || isv.timestamp<v.entry.timestamp) isv=v.entry;
                return fr.peers;
            }catch(err){
                console.log("receiveMessageFromAuthor callback failed");
                console.log(err);
                return null;
            }
        }

        try{
            await this._onceatime.dec();
            await this._closestNodesNavigator(key,KGET,callback);
        }finally{
            this._onceatime.inc();
        }

        if (isv){
            return isv.value;
        }else{
            return null;
        }

    }



    private async emitSignedStorageEntry(sse:ISignedStorageEntry):Promise<boolean>{
        if (!await this._storage.isNewMark(sse.entry.author,sse.entry.timestamp))
            return false;
        
        this.emit(ONMESSAGE,{author:sse.entry.author, content:sse.entry.value});
        return true
    }


    private async _backgroundIteration():Promise<boolean>{
        this._debug("_backgroundIteration....");   
        if (!this._startup) 
            return false;

        const isNewAndMark=async (sse:ISignedStorageEntry)=>{
            return await this._storage.isNewMark(sse.entry.author,sse.entry.timestamp);
        }

        const processSses=async (rm:IReceiveMessagesResult|null)=>{
            if (!rm) return 0;
            let foundNew=false;
            for(let sse of rm.sses){
                if (await this.emitSignedStorageEntry(sse)){
                    foundNew=true;
                }
            }
            if (!foundNew) return 0;
            return rm.nextTs;
        }

        const iterationTs=Date.now();

        const callback=async (peer:BasePeer)=>{
            let ts=iterationTs;
            do{
                var rm=await peer.receiveMessages(ts);
                ts=await processSses(rm);
            }while(ts>0);
            return await peer.findNode(KGET);
        }

        try{
            await this._onceatime.dec();
            await this._closestNodesNavigator(this.id,KGET,callback);
        }finally{
            this._onceatime.inc();
        }

        this._debug("_backgroundIteration DONE");     
        return true;
    }


    private async _readNodeBtree(infoHash:Buffer) {
        var r=null;
        const callback=async (peer:BasePeer)=>{
            let f=await peer.findBTreeNode (infoHash,KGET);
            if (Array.isArray(f))
                return f;
            r=f.entry.node;
            return null;
        } 
        await this._closestNodesNavigator(infoHash,KGET,callback);
        return r;
    } 


    /**
     * btreePut put an item in a bTree. 
     * @param element 
     * @param rootHash 
     * @param compare 
     * @param getIndex 
     * @returns Buffer the new root node infohash
     */

    public async btreePut( element:any,
                    rootHash:Buffer|null,  
                    compare:(a:any,b:any)=>number,
                    getIndex:(a:any)=>any):Promise<Buffer>{
        this._debug("btreePut.....");
        
        const _saveNode= async(node:IBtreeNode)=>{

            var sbt=this._peerFactory.createSignedBtreeNode(node);

            const callback=async (peer:BasePeer)=>{
                let f=await peer.storeBTreeNode(sbt,KPUT);
                if (!f) return [];
                return f;
            }

            await this._closestNodesNavigator(sbt.entry.node.hash,KGET,callback);
        }

        const _readNodeBtree=(infoHash:Buffer)=>{
            return this._readNodeBtree(infoHash);
        }

        try{
            await this._onceatime.dec();
            var bt=new DisDhtBtree(rootHash,_readNodeBtree,_saveNode,compare,getIndex,NODESIZE);
            var r=await bt.put(element)
    
            this._debug("btreePut DONE");
    
            return r;
        }finally{
            this._onceatime.inc();
        }
        

    }

    public async btreeGet(key:any,
                rootHash:Buffer|null,
                compare:(a:any,b:any)=>number,
                getIndex:(a:any)=>any,
                found:(data:any)=>Promise<boolean>):Promise<void>{

        const _saveNode= async(node:IBtreeNode)=>{
            throw new Error();
        }

        const _readNodeBtree=(infoHash:Buffer)=>{
            return this._readNodeBtree(infoHash);
        }

        try{
            await this._onceatime.dec();
            var bt=new DisDhtBtree(rootHash,_readNodeBtree,_saveNode,compare,getIndex,NODESIZE);
            await bt.get(key,found);
        }finally{
            this._onceatime.inc();
        }


    }
    /*
    protected async _closestNodes(key: Buffer, k: number): Promise<BasePeer[]> {
        this._debug("_closestnodes.....");

        const callback=async (peer:BasePeer)=>{
            return await peer.findNode(key,k);
        }

        var r=await this._closestNodesNavigator(key,k,callback);

        this._debug("_closestnodes DONE");
        return r;
    }
    */
    protected async _closestNodesNavigator(key: Buffer,k:number, callback:(peer:BasePeer)=>Promise<BasePeer[]|null>): Promise<BasePeer[]> {
        this._debug("_closestNodesNavigator.....");
        if (k<1) throw new Error("Invalid K");
        var query:Map<String,boolean>=new Map();
        var kb=new Kbucket({localNodeId:key,numberOfNodesPerKBucket:k});
        for (let c of this._kbucket.closest(key,KGET)) kb.add(c);
        var go_on=true;
        while(go_on){
            go_on=false;
            for (let c of kb.closest(key,k)){
                var p:BasePeer=c as any;
                var ids=p.id.toString('hex');
                if (query.get(ids))
                    continue;
                let bps:BasePeer[]|null;
                bps=await callback(p);
                query.set(ids,true);
                if (bps==null)
                {
                    go_on=false;
                    break;
                }
                for (let bp of bps){
                    kb.add(bp);
                    go_on=true;
                    break;
                }
            }
        }
        var r=kb.closest(key,k);
        return r as any;
    }

}