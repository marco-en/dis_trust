import { Buffer } from 'buffer'
import Kbucket from 'k-bucket';
import { PeerFactory, IStorage, IStorageEntry, BasePeer, MAX_TS_DIFF, IStorageMerkleNode } from './peer.js';
import Debug from 'debug';
import { MerkleReader,MerkleWriter,IMerkleNode } from './merkle.js';
import {sha} from './mysodium.js';
import Semaphore from './semaphore.js';

const TESTING=true;

const KPUT = 20;
const KGET = KPUT*4;
const MAXVALUESIZE = 2*1024;
const NODESIZE = TESTING ? 2*1000 : 100*1000;
const HIGHLEVEL = 3*NODESIZE;
const ZEROBUF=Buffer.alloc(0);


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

    constructor(opt: DisDHToptions) {
        this._opt = opt;

        this._peerFactory = new PeerFactory(opt.storage, opt.secretKey);


        this._debug=opt.debug || Debug("DisDHT     :"+this._peerFactory.id.toString('hex').slice(0,6));
        this._debug.color=this._peerFactory.debug.color;
        this._kbucket = this._peerFactory.kbucket;
        this._debug("created");
    }

    get id () {
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
        this._debug("Startup done")
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

        this._debug("put done");
        return r;
    }

    /**
     * Merkle tree algorithm
     * a stream will be identified by a single hashcode
     * hashcode depends on content only. 
     * 
     * @param blob blob to store in the DHT
     * @returns buffer with infohash
     */

    async putStream(readableStream:ReadableStream):Promise<Buffer>{   
        const emit = async (n:IMerkleNode) => { 
            let smn = this._peerFactory.createSignedMerkleNode(n);
            const callback = async (peer:BasePeer) => {
                await peer.storeMerkleNode(smn,KPUT);
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
        return await mw.done();
    }

    async _getMerkleNode(infoHash:Buffer):Promise<IStorageMerkleNode|undefined>{
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

    getStream(infoHash:Buffer):ReadableStream{

        if (!(infoHash instanceof Buffer) || infoHash.length!=this.KEYLEN)
            throw new Error("invalid key");

        const high=new Semaphore(1);
        const low=new Semaphore(0);
        const msgbuffer:Buffer[]=[];
        var msgbuffersize:number=0;
        var done:boolean=false;
        var error:Error|null=null;
        var cancelled=false;

        const emitchunk=async (msg:Buffer)=>{
            if (cancelled) return;
            if (msgbuffersize==0)
                low.inc();
            msgbuffer.push(msg);
            msgbuffersize+=msg.length;
            if (msgbuffersize>=HIGHLEVEL)                 
                await high.dec();
        };

        const innerPull=(controller:ReadableStreamDefaultController)=>{
            if (done){
                controller.close();
                return true;
            }
            if (error){
                controller.error(error);
                return true;
            }
            if (msgbuffersize){
                let b=msgbuffer.shift();
                if (!b) throw new Error();
                msgbuffersize-=b.length;
                if (msgbuffersize<HIGHLEVEL)
                    high.inc();
                controller.enqueue(b);
                return true
            }
            return false;
        }

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
                if (innerPull(controller)) return;
                await low.dec();
                innerPull(controller);
            },
            async cancel(controller) {
                cancelled=true;
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

   async _closestNodes(key: Buffer, k: number): Promise<BasePeer[]> {
        this._debug("_closestnodes.....");

        const callback=async (peer:BasePeer)=>{
            return await peer.findNode(key,k);
        }

        var r=await this._closestNodesNavigator(key,k,callback);

        this._debug("_closestnodes DONE");
        return r;
    }

    async _closestNodesNavigator(key: Buffer,k:number, callback:(peer:BasePeer)=>Promise<BasePeer[]|null>): Promise<BasePeer[]> {
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