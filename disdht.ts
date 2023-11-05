import { Buffer } from 'buffer'
import Kbucket from 'k-bucket';
import {IUserId,ISignedUserId,IStorageEntry,ISignedStorageEntry,ISignedStorageMerkleNode,IStorageMerkleNode,IStorage, ISignedStorageBtreeNode } from './IStorage.js'
import { PeerFactory,  BasePeer, MAX_TS_DIFF,  checkUserName, userIdHash,  MAXMSGSIZE} from './peer.js';
import Debug from 'debug';
import { MerkleReader,MerkleWriter,IMerkleNode} from './merkle.js';
import {DisDhtBtree,IBtreeNode} from './DisDhtBtree.js';
import {sha} from './mysodium.js';
import Semaphore from './semaphore.js';

const KPUT = 20;
const KGET = KPUT*4;
const MAXVALUESIZE = 2*1024;
export const NODESIZE = MAXMSGSIZE-500;
const ZEROBUF=Buffer.alloc(0);
const STREAMHIGH=5;


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

export class DisDHT {
    KEYLEN:number=sha(ZEROBUF).length;
    _opt: DisDHToptions;
    _peerFactory: PeerFactory;
    _kbucket: Kbucket;
    _debug:Debug.Debugger;
    _startup:boolean=false;

    constructor(opt: DisDHToptions) {
        this._opt = opt;

        this._peerFactory = new PeerFactory(opt.storage, opt.secretKey);


        this._debug=opt.debug || Debug("DisDHT     :"+this._peerFactory.id.toString('hex').slice(0,6));
        this._debug.color=this._peerFactory.debug.color;
        this._kbucket = this._peerFactory.kbucket;
        this._debug("created");
    }

    get id () :Buffer {
        return this._peerFactory.id;
    }

    async startUp() {
        this._debug("Startup...")

        if (this._opt.servers)
            for (var server of this._opt.servers)
                await this._peerFactory.createListener(server.port, server.host)
        if (this._opt.seed)
            for (var s of this._opt.seed)
                if (s.host)
                    await this._peerFactory.createClient(s.port, s.host);
                else
                    throw new Error("missing host name");

        await this._closestNodes(this._peerFactory.id, KPUT);
        this._startup=true;

        this._debug("Startup done")
    }

    async shutdown(){
        this._debug("shutdown...");
        if (!this._startup) throw new Error("not started up");

        await this._peerFactory.shutdown();
        this._startup=false;

        this._debug("shutdown DONE");
    }

    createSignedUserName(userId:string):ISignedUserId{
        return this._peerFactory.createSignedUserName(userId);
    }

    /**
     * put userId to point to me.
     * the close nodes are trusted not to accept changes.
     * @param signedUserId 
     * @returns 
     */

    async setUser(signedUserId:ISignedUserId):Promise<boolean>{
        this._debug("setUser...");
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

        await this._closestNodesNavigator(signedUserId.entry.userHash,KPUT,callback);

        var r=truecnt > 1 && truecnt > falsecnt
        this._debug("setUser DONE "+r);
        return r;
    }

    /**
     * 
     * @param userId get userId public key
     * @returns 
     */

    async getUser(userId:string):Promise<Buffer|null>{
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
  
        await this._closestNodesNavigator(userHash,KPUT,callback);

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

    async put(key: Buffer, value: Buffer):Promise<number> {
        this._debug("put....");
        if (!this._startup) throw new Error("not started up");

        if (!(key instanceof Buffer) || key.length!=this.KEYLEN)
            throw new Error("invalid key");

        if (!(value instanceof Buffer) || key.length>MAXVALUESIZE)
            throw new Error("invalid value");

        var sse=this._peerFactory.createStorageEntry(key,value);

        var r=0;

        const callback=async (peer:BasePeer)=>{
            r++;
            let peers= await peer.store(sse,KPUT);
            return peers;
        }

        await this._closestNodesNavigator(key,KPUT,callback);

        this._debug("put done "+r);
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

    async putStream(readableStream:ReadableStream):Promise<Buffer>{  
        this._debug("putStream....");

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
        await this._closestNodesNavigator(infoHash,KGET,callback);
        return r;
    }

    /**
     * get a stream stored in the DHT
     * @param infoHash:Buffer
     * @returns ReadableStream
     */

    getStream(infoHash:Buffer):ReadableStream{
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

    /**
     *  
     * @param key 
     * @param author 
     * @param found 
     * @returns 
     */

    async getAuthor(key: Buffer, author: Buffer):Promise<IStorageEntry|null> {
        this._debug("getKeyAuthor....");
        if (!this._startup) throw new Error("not started up");

        if (!(key instanceof Buffer) || key.length!=this.KEYLEN)
            throw new Error("invalid key");

        if (!(author instanceof Buffer) || author.length!=this.KEYLEN)
            throw new Error("invalid author");

        var isv:IStorageEntry|null=null;

        const callback=async (peer:BasePeer)=>{
            let fr=await peer.findValueAuthor(key,author,KGET);
            if (fr==null) return null;
            for (var v of fr.values)
                if (isv===null || isv.timestamp<v.entry.timestamp) isv=v.entry;
            return fr.peers;
        }

        await this._closestNodesNavigator(key,KGET,callback);
    
        return isv;
    }

    /**
     * 
     * @param key 
     * @param author 
     * @param found (messageEnvelope:MessageEnvelope) => Promise<boolean> called for each value found. return false if you want to stop getting values
     */


    async get(key: Buffer,found:(entry:IStorageEntry)=>Promise<boolean>) {
        this._debug("get....");
        if (!this._startup) throw new Error("not started up");

        if (!(key instanceof Buffer) || key.length!=this.KEYLEN)
            throw new Error("invalid key");

        var timestamp=Date.now();

        interface authorRes{
            res:IStorageEntry,
            sent:boolean
        }

        var authorIdString2Res:Map<string,authorRes>=new Map();
        var peerIdString2Peer:Map<string,BasePeer>=new Map();

        const sendResults=async ():Promise<boolean>=>{
            let results=[];
            let sent=false;
            for(let ar of authorIdString2Res.values())
                if(!ar.sent)
                    results.push(ar);
            results.sort((a,b)=>a.res.timestamp-b.res.timestamp);
            for(let ar of results){
                ar.sent=true;
                if (!await found(ar.res))
                    return false;
                sent=true;
            }
            return sent;
        }

        const pushRes=(peer:BasePeer,res:IStorageEntry):boolean=>{
            if (res.timestamp>=timestamp+MAX_TS_DIFF)
                return false;
            var authorIdString=res.author.toString('hex');
            let prev=authorIdString2Res.get(authorIdString);
            if (prev==null || prev.res.timestamp<res.timestamp){
                authorIdString2Res.set(authorIdString,{res:res,sent:false});
                peerIdString2Peer.set(peer.idString,peer);
                return true;
            }
            else
                return false;
        }

        const callback=async (peer:BasePeer)=>{
            let fr=await peer.findValues(key,KGET,0);
            if (fr==null) return [];
            for(let res_signed of fr.values)
                pushRes(peer,res_signed.entry);
            return fr.peers;
        }

        await this._closestNodesNavigator(key,KGET,callback);

        let page=0;
        while(peerIdString2Peer.size){
            if (!await sendResults()) 
                return;
            page++;
            let peerIdStringToDelete=[];
            for (let [peerIdString,peer] of peerIdString2Peer.entries()){
                let peerpush=false;
                let fr=await peer.findValues(key,KGET,page);
                if (fr!=null){
                    for (let v of fr.values)
                        if(pushRes(peer,v.entry))
                        peerpush=true;
                }
                if (!peerpush) peerIdStringToDelete.push(peerIdString);
            }
            for (let ids of peerIdStringToDelete) peerIdString2Peer.delete(ids);
        }
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

    async btreePut( element:any,
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
        
        var bt=new DisDhtBtree(rootHash,_readNodeBtree,_saveNode,compare,getIndex,NODESIZE);
        var r=await bt.put(element)

        this._debug("btreePut DONE");

        return r;
    }

    async btreeGet(key:any,
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

        var bt=new DisDhtBtree(rootHash,_readNodeBtree,_saveNode,compare,getIndex,NODESIZE);
        await bt.get(key,found);
    }

    protected async _closestNodes(key: Buffer, k: number): Promise<BasePeer[]> {
        this._debug("_closestnodes.....");

        const callback=async (peer:BasePeer)=>{
            return await peer.findNode(key,k);
        }

        var r=await this._closestNodesNavigator(key,k,callback);

        this._debug("_closestnodes DONE");
        return r;
    }

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