import { Buffer } from 'buffer'
import Kbucket from 'k-bucket';
import { PeerFactory, IStorage, IStorageValue, BasePeer, MessageEnvelope } from './peer.js';
import Debug from 'debug';
import {encode,decode} from './encoder.js';

const KEYLEN=32;
const KPUT = 20;
const KGET = KPUT*4;
const MAXVALUESIZE=1024*1024;

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
        this._debug("put....")
        if (!(key instanceof Buffer) || key.length!=KEYLEN)
            throw new Error("invalid key");

        var r=0;

        const callback=async (peer:BasePeer)=>{
            r++;
            let peers= await peer.store(key,value,KPUT);
            return peers;
        }

        await this._closestNodesNavigator(key,KPUT,callback);

        this._debug("put done");
        return r;
    }


    /**
     * 
     * @param key 
     * @param author 
     * @param found 
     * @returns 
     */

    async getAuthor(key: Buffer, author: Buffer):Promise<IStorageValue|null> {
        var isv:IStorageValue|undefined;

        this._debug("getKeyAuthor....")

        const callback=async (peer:BasePeer)=>{
            let fr=await peer.findValueAuthor(key,author,KGET);
            if (fr==null) return undefined;
            for (var v of fr.values)
                if (isv===undefined || isv.timestamp<v.timestamp) isv=v;
            return fr.peers;
        }

        await this._closestNodesNavigator(key,KGET,callback);
    
        return isv?isv:null;
    }

    /**
     * 
     * @param key 
     * @param author 
     * @param found (messageEnvelope:MessageEnvelope) => Promise<boolean> called for each value found. retunr false if you want to stop getting values
     */

/*
    async get(key: Buffer,found:(getOutput:GetOutput)=>Promise<boolean>) {
        this._debug("get....")

        var peerIdString2Peer:Map<string,BasePeer>=new Map();

        let go=true;

        const callback=async (peer:BasePeer)=>{
            peerIdString2Peer.set(peer.idString,peer);
            let fr=await peer.findValues(key,KGET,0);
            if (fr==null) return null;
            for(let v of fr.values){
                if (go) go=await found(v);
            }
            return go?fr.peers:null;
        }

        await this._closestNodesNavigator(key,KGET,callback);
        if (!go) return;

        let page=0;
        while(peerIdString2Peer.size){
            page++;
            for (let [peerIdString,peer] of peerIdString2Peer.entries()){
                let fr=await peer.findValues(key,KGET,page);
                if (fr==null || fr.values.length==0){
                    peerIdString2Peer.delete(peerIdString);
                }else{
                    for (let v of fr.values){
                        if (!await found(v)) return;     
                    }
                }
            }
        }
    }
*/
   async _closestNodes(key: Buffer, k: number): Promise<BasePeer[]> {
        this._debug("_closestnodes.....");

        const callback=async (peer:BasePeer)=>{
            return await peer.findNode(key,k);
        }

        var r=await this._closestNodesNavigator(key,k,callback);

        this._debug("_closestnodes DONE");
        return r;
    }

    async _closestNodesNavigator(key: Buffer,k:number, callback:(peer:BasePeer)=>Promise<BasePeer[]|null|undefined>): Promise<BasePeer[]> {
        this._debug("_closestNodesNavigator.....");
        if (k<1) throw new Error("Invalid K");

        interface closenode{
            peer:BasePeer,
            queried:boolean,
        }
        var closenodes:closenode[]=[];

        for (let c of this._kbucket.closest(key)) {
            closenodes.push({
                peer:c as any,
                queried:false
            })
        }
        this._debug("_closestnodes start with %d",closenodes.length);

        const addCloseNode=(np:BasePeer)=>{
            for (let cn of closenodes){
                if (Buffer.compare(np.id as Buffer,cn.peer.id as Buffer)==0)
                    return;
            }
            closenodes.unshift({
                peer:np,
                queried:false
            });
        }

        var go_on=true;
        while(go_on){
            closenodes.sort((a,b)=>{
                let da=Kbucket.distance(a.peer.id as Buffer,key);
                let db=Kbucket.distance(a.peer.id as Buffer,key);
                return da-db;
            });

            let queriedNodes=0;
            go_on=false;
            for(let i=0;i<closenodes.length && queriedNodes<k;i++){
                if(closenodes[i].queried) continue;
                go_on=true;
                closenodes[i].queried=true;
                let newPeers=await callback(closenodes[i].peer);
                if (newPeers==null) break; // stop the nevigation
                if (!(newPeers===undefined) && newPeers.length){
                    queriedNodes++;
                    for (let np of newPeers){
                        addCloseNode(np)
                    }
                }
            }
            while (closenodes.length>k*2) closenodes.pop();
        }
        while (closenodes.length>k) closenodes.pop();
        let r=closenodes.map(v=>v.peer);
        this._debug("_closestNodesNavigator DONE");
        return r;
    }
}