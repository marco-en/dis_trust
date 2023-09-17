import { Buffer } from 'buffer'
import Kbucket from 'k-bucket';
import { PeerFactory, IStorage, IStorageEntry, BasePeer, MAX_TS_DIFF } from './peer.js';
import Debug from 'debug';
import {shaStream,crypto_hash_sha256_BYTES, sha} from './mysodium.js';


const KEYLEN=32;
const KPUT = 20;
const KGET = KPUT*4;
const MAXVALUESIZE=1024*1024;
const STREAMCHUNKSIZE=100*1000;

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


        if (!(key instanceof Buffer) || key.length!=KEYLEN)
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

    async putStream(blob:Blob):Promise<Buffer>{
        return Buffer.alloc(0);

        const pushchunk=async(buffer:Buffer)=>{
            var hash=sha(buffer);
            //await putLeaf(hash,buffer);

        }

        var buffer=Buffer.alloc(0);

        const push=async(bytes:Uint8Array)=>{
            buffer=Buffer.concat([buffer,bytes]);
            if (buffer.length>=STREAMCHUNKSIZE){
                await pushchunk(buffer.subarray(0,STREAMCHUNKSIZE));
                buffer=buffer.subarray(STREAMCHUNKSIZE);
            }
        }

        let readableStream=blob.stream();
        let reader=readableStream.getReader();
        let chunk=await reader.read();
        while(!chunk.done){
            ///await push(chunk.value);
        }
        await reader.cancel();
        await readableStream.cancel();
        if (buffer.length) pushchunk(buffer);

    }


    /**
     * 
     * @param key 
     * @param author 
     * @param found 
     * @returns 
     */

    async getAuthor(key: Buffer, author: Buffer):Promise<IStorageEntry|null> {
        var isv:IStorageEntry|null=null;

        this._debug("getKeyAuthor....")

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