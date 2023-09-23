import WebSocket from 'websocket';
import http from 'http';
import {EventEmitter} from 'events';
import SimplePeer from 'simple-peer';
import wrtc from 'wrtc';
import * as sodium from './mysodium.js';
import Debug from 'debug';
import KBucket from 'k-bucket';
import {Contact} from 'k-bucket';
import {encode,decode} from './encoder.js'
import { IMerkleNode } from './merkle.js';



const DEBUG=1;
export const MAX_TS_DIFF=DEBUG*5*60000+2*60*1000;
const REPLYTIMEOUT=DEBUG*60000+5000;
const VERSION=1;
const INTRODUCTIONTIMEOUT=DEBUG*60000+2*1000;
const KBUCKETSIZE=20;
const MAXMSGSIZE=1024*1024;

interface Introduction{
    id:Buffer;
    ts:number;
}

enum MessageType{
    reply=0,
    introduce,
    ping,
    store,
    findnode,
    findvalueAuthor,
    findvalueNoAuthor,
    signal,
    signalled,
    add,
    storemerkle,
    findmerkle,
}

/**
 * MessageEnvelope
 * v {number} - Version number, fixed to 1
 * a {Buffer} - author of this messageEnvelope
 * p {any} - payload
 * t {number} - timestamp of the envelope
 * c {number} - request/reply counter
 */

interface MessageEnvelope{

    /** version */
    v:number, // VERSION
    /** author */
    a:Buffer, //author
    /**  */
    m:MessageType,
    /** payload */
    p:any, 
    /** timestamp */
    t:number, // timestamp
    /** request replay matcher */
    c:number, // request reply counter
    /** signature */
    s?:Buffer
}


export interface IStorageEntry{
    author:Buffer,
    key:Buffer,
    value:Buffer,
    timestamp:number,
    version:number,
}


export interface ISignedStorageEntry{
    entry:IStorageEntry,
    signature:Buffer
}

export interface IStorageMerkleNode{
    author:Buffer,
    node:IMerkleNode,
    timestamp:number,
    version:number,
}

export interface ISignedStorageMerkleNode{
    entry:IStorageMerkleNode,
    signature:Buffer,
}

export interface FindResult{
    peers:BasePeer[];
    values:ISignedStorageEntry[];
}



/**
 * @interface IStorage
 * @method{store} - store a message envelope, Key is messageEnvelope.p.key. Author is messageEnvelope.a.
 * @method retreive - key, author optional, page number. return MessageEnvelopes in from newst to oldest
 */

export interface IStorage{
    //storeInfohash:(value:Buffer)=>Promise<Buffer>,
    //retreiveInfohash:(infoHash:Buffer)=>Promise<Buffer>,
    storeSignedEntry:(me:ISignedStorageEntry)=>Promise<void>,
    retreiveAuthor:(key:Buffer,author:Buffer)=>Promise<ISignedStorageEntry|null>,
    retreiveAnyAuthor:(key:Buffer,page:number)=>Promise<ISignedStorageEntry[]>,
    storeMerkleNode:(snm:ISignedStorageMerkleNode)=>Promise<void>,
    getMerkleNode:(infoHash:Buffer)=>Promise<ISignedStorageMerkleNode|undefined>,
}

interface IPendingRequest{
    resolve:any,
    timeout:any,
    created:number,   
}

export class BasePeer extends EventEmitter implements Contact{
    static peerCnt=0;
    _peerFactory:PeerFactory;
    _factoryDebug:Debug.Debugger;
    _debugPrefix:string;


    constructor(peerFactory:PeerFactory){
        super();
        this._debugPrefix="["+this.constructor.name+"]: ";//+peerFactory.id.toString('hex').slice(0,6)+"] ";
        this._peerFactory=peerFactory;
        this._factoryDebug=this._peerFactory._debug;
        this._debug("creating new peer");
    }

    _debug(...args: any[]){
        var format:string=args.shift();
        format=this._debugPrefix+format;
        var params=[...args];
        this._factoryDebug.call(this,format,...params)
    }

    get id():Buffer{
        throw new Error("Abstract");
    }
    get vectorClock() {return 0};
    get idString():string{
        var x=this.id;
        if (x==null) return "";
        else return x.toString('hex');
    }

    get nickName():string{
        throw new Error("Abstract");
    }

    get peerfactoryId():Buffer{
        return this._peerFactory.id;
    }
    destroy(){
        this.emit('destroy');
    }
    async added(status:boolean):Promise<void> {
        throw new Error("Abstract");
    }
    async ping():Promise<boolean>{
        throw new Error("Abstract");
    }
    async store(entry:ISignedStorageEntry,k:number):Promise<BasePeer[]|null>{
        throw new Error("Abstract");
    }
    async storeMerkleNode(signed:ISignedStorageMerkleNode,k:number):Promise<BasePeer[]|null>{
        throw new Error("Abstract");        
    }
    async findMerkleNode(key:Buffer,k:number):Promise<ISignedStorageMerkleNode|BasePeer[]>{
        throw new Error("Abstract");        
    }
    async findValueAuthor(key:Buffer,author:Buffer,k:number):Promise<FindResult|null>{
        throw new Error("Abstract");
    }
    async findValues(key:Buffer,k:number,page:number):Promise<FindResult|null>{
        throw new Error("Abstract");
    }

    async findNode(nodeId:Buffer,k:number):Promise<BasePeer[]>{
        throw new Error("Abstract");
    }
}

class MeAsPeer extends BasePeer{
    get id():Buffer{
        return this._peerFactory.id;
    }
    async ping():Promise<boolean>{
        return true;
    }
    async added(status:boolean):Promise<void> { }

    async store(signedentry:ISignedStorageEntry,k:number):Promise<BasePeer[]|null>{
        await this._peerFactory.storage.storeSignedEntry(signedentry);
        return this._peerFactory.findClosestPeers(signedentry.entry.key,k)
    }
    async storeMerkleNode(signed:ISignedStorageMerkleNode,k:number):Promise<BasePeer[]|null>{
        await this._peerFactory.storage.storeMerkleNode(signed);
        return this._peerFactory.findClosestPeers(signed.entry.node.infoHash,k);   
    }
    async findMerkleNode(key:Buffer,k:number):Promise<ISignedStorageMerkleNode|BasePeer[]>{
        var mn=await this._peerFactory.storage.getMerkleNode(key);
        if (mn) return mn;
        return this._peerFactory.findClosestPeers(key,k);
    }
    async findValueAuthor(key:Buffer,author:Buffer,k:number):Promise<FindResult|null>{
        var value=await this._peerFactory.storage.retreiveAuthor(key,author)
        var peers=this._peerFactory.findClosestPeers(key,k);
        return{
            peers:peers,
            values:value?[value]:[]
        }
    }
    async findValues(key:Buffer,k:number,page:number):Promise<FindResult|null>{
        var values=await this._peerFactory.storage.retreiveAnyAuthor(key,page);
        var peers=this._peerFactory.findClosestPeers(key,k);
        return{
            peers:peers,
            values:values
        }
    }
    async findNode(nodeId:Buffer,k:number):Promise<BasePeer[]>{
        var peers=this._peerFactory.findClosestPeers(nodeId,k);
        return peers;
    }
    get nickName():string{
        return "MeAsPeer";
    }
}


class Peer extends BasePeer  {
    _id:Buffer|null=null;
    _created:number;
    _seen:number;
    _reqCnt:number=1;
    _pendingRequest=new Map<number,IPendingRequest>;
    _decrypto_pk:Buffer|null=null;
    _decrypto_sk:Buffer|null=null;
    _encrypto_pk:Buffer|null=null;
    _added:boolean=true;
    _otherAdded:boolean=true;
    _nickName:string|undefined;
    _resolveIntroduction:any;
    _startStatus:boolean=false;

    constructor(peerFactory:PeerFactory,_nickName?:string){
        super(peerFactory);
        this._nickName=_nickName;
        this._created=this._seen=Date.now();
    }

    get id():Buffer{
        if (this._id==null)
            throw new Error("Peer Not Initialized")
        return this._id;
    }

    get nickName():string{
        if (this._nickName===undefined)
            return "["+this.idString.slice(0,6)+"]";
        else
            return this._nickName;
    }

    startUp():Promise<unknown>{
        if (this._startStatus) return Promise.resolve();
        var timeout:any;
        return new Promise((resolve,reject)=>{
            var {pk,sk}=sodium.crypto_box_seed_keypair();
            this._decrypto_pk=pk;
            this._decrypto_sk=sk;
            var intro=this._packRequest({pk:pk},MessageType.introduce,0);        
            resolve(this._sendMsg(intro))
        }).then(()=>{
            if (this._id) 
                return; // already received introduction;
            else
                return new Promise((resolve,reject)=>{
                    this._resolveIntroduction=resolve;
                    timeout=setTimeout(()=>reject("Introduction timeout"),INTRODUCTIONTIMEOUT);
                });
        }).then(()=>{
            if (timeout) clearTimeout(timeout);
            this._startStatus=true;
            this._peerFactory.newPeer(this);
        })
        .catch(err=>{
            this._abortPeer("failed introduction "+err)
        })
    }

    _onIntroduction(introEnvelope:MessageEnvelope){
        if (this._id!=null || this._encrypto_pk!=null) {
            return this._abortPeer("received double introduction");
        }
        this._id=introEnvelope.a;
        this._debugPrefix=this._debugPrefix+" <"+this.nickName+"> "
        this._debug("received introduction");
        this._encrypto_pk=introEnvelope.p.pk;
        if (this._resolveIntroduction) { // resolve the startup introduction
            this._resolveIntroduction();
            delete this._resolveIntroduction;
        }
    }

    destroy(){
        this._debug("destroy");
        this._id=null;
        super.destroy();
    }

    async added(status:boolean):Promise<void> {
        if (this._added) return;
        this._added=status;
        if (await this._fullyRemoved()) return;
        var me=await this._requestToPeer({added:this._added},MessageType.add);
        if (!me) return await this._abortPeer("failed to chage added status");
        this._otherAdded=me.p.added;
        if (await this._fullyRemoved()) return;
    }

    async _onAdded(requestEnvelope:MessageEnvelope){
        this._otherAdded=requestEnvelope.p.added;
        if (await this._fullyRemoved()) return;
        await this._replyToPeer({added:this._added},requestEnvelope);
    }

    async _fullyRemoved():Promise<boolean>{
        if (this._added || this._otherAdded) return false;
        this._debug("fully removed");
        this.destroy();
        return true;
    }

    async ping():Promise<boolean>{
        if (this._id==null)
            throw new Error("Peer not initailized");
        var r=false;
        try{
            var me=await this._requestToPeer({},MessageType.ping);
            r=!!me;
        }catch(err){}
        return r;
    }

    async _onPing(requestEnvelope:MessageEnvelope){
        this._replyToPeer({},requestEnvelope);
    }

    /**
     * 
     * @param key key to store
     * @param value value
     * @param k nearest neighb.
     * @returns list of peers
     */

    async store(signedentry:ISignedStorageEntry,k:number):Promise<BasePeer[]|null>{
        this._debug("store...");
        if (this._id==null)
            throw new Error("Peer not initialized");

        var res=await this._requestToPeer({
            entry:signedentry,
            k:k
        },MessageType.store);
        if (!res) return null;
        var r=await this._nodeids2peers(res.p.ids);
        this._debug("store done");
        return r;
    }

    async _onStore(storeEnvelope:MessageEnvelope,){
        this._debug("_onStore...");
        var signedentry:ISignedStorageEntry=storeEnvelope.p.entry;
        if(!this._peerFactory.verifyStorageEntry(signedentry)){
            return this._abortPeer("receive fake storage entry");
        }
        await this._peerFactory.storage.storeSignedEntry(signedentry);
        var ids=await this._onFindNodeInner(signedentry.entry.key,storeEnvelope.p.k)
        await this._replyToPeer({ids:ids},storeEnvelope);
        this._debug("_onStore done");
    }

    /**
     * 
     * @param signed 
     * @param k 
     * @return close nodes
     */

    async storeMerkleNode(signed:ISignedStorageMerkleNode,k:number):Promise<BasePeer[]|null>{
        this._debug("storeMerkleNode...")
        var res=await this._requestToPeer({
            entry:signed,
            k:k
        },MessageType.storemerkle);
        if (!res) return null;
        var r=await this._nodeids2peers(res.p.ids);
        this._debug("storeMerkleNode done");
        return r;
    }

    async _onStoreMerkleNode(merkleMessage:MessageEnvelope){
        this._debug("_onStoreMerkleNode ....");
        var signed:ISignedStorageMerkleNode=merkleMessage.p.entry;
        var k:number=merkleMessage.p.K;
        await this._peerFactory.storage.storeMerkleNode(signed);
        var ids=await this._onFindNodeInner(signed.entry.node.infoHash,k)
        await this._replyToPeer({ids:ids},merkleMessage);
        this._debug("_onStoreMerkleNode done");
    }

    /**
     * 
     * @param key 
     * @param k 
     */

    async findMerkleNode(key:Buffer,k:number):Promise<ISignedStorageMerkleNode|BasePeer[]>{
        this._debug("findMerkleNode...");
        var res=await this._requestToPeer({
            key:key,
            k:k
        },MessageType.findmerkle);
        if (res==null) return [];
        var r;
        if (res.p.ids) {
            this._debug("findMerkleNode not found Node");
            r=await this._nodeids2peers(res.p.ids);
        }else if (res.p.node) {
            this._debug("findMerkleNode found Node");
            r=res.p.node;
        }else{
            await this._abortPeer("invalid reply");
            r=[];
        }
        this._debug("findMerkleNode DONE");
        return r;
    }

    async _onfindMerkleNode(findMerkle:MessageEnvelope){
        this._debug("_onfindMerkleNode...");
        var key:Buffer=findMerkle.p.key;
        var k:number=findMerkle.p.k;
        var mn=await this._peerFactory.storage.getMerkleNode(key);
        if (mn===undefined){
            var ids=await this._onFindNodeInner(key,k)
            await this._replyToPeer({ids:ids},findMerkle);
        }else{
            await this._replyToPeer({node:mn},findMerkle);
        }
        this._debug("_onfindMerkleNode DONE");
    }

    /**
     * 
     * @param key node is to find
     * @param k parameter
     * @returns 
     */

    async findNode(nodeId:Buffer,k:number):Promise<BasePeer[]>{
        if (this._id==null)
            throw new Error("Peer not initialized");
        var nodesMessage=await this._requestToPeer({
            n:nodeId,
            k:k
        },MessageType.findnode);
        if (nodesMessage==null) return [];
        var nodesIds:Buffer[]=nodesMessage.p.ids;
        return await this._nodeids2peers(nodesIds);
    }


    async _onFindNode(findNodeEnvelope:MessageEnvelope){
        var nodesIds=await this._onFindNodeInner(findNodeEnvelope.p.n,findNodeEnvelope.p.k)
        await this._replyToPeer({ids:nodesIds},findNodeEnvelope);
    }

    async _onFindNodeInner(key:Buffer,k:number):Promise<Buffer[]>{
        var nodes=await this._peerFactory.findClosestPeers(key,k);
        return nodes.map(peer=>peer.id) as Buffer[];
    }

    /**
     * 
     * @param key key to search.
     * @param author author id. optional/
     * @param k k closest nodes
     * @returns 
     */

    async findValueAuthor(key:Buffer,author:Buffer,k:number):Promise<FindResult|null>{
        if (this._id==null)
            throw new Error("Peer not initialized");
        var q:any={
            n:key,
            b:author,
            k:k
        }
        var me=await this._requestToPeer(q,MessageType.findvalueAuthor);
        if (!me) return null;
        var peers=await this._nodeids2peers(me.p.ids);
        return {
            peers:peers,
            values:me.p.values
        }
    }

    async _onFindValueAuthor(findValueMessage:MessageEnvelope){
        var key=findValueMessage.p.n;
        var author=findValueMessage.p.b;
        var k=findValueMessage.p.k;
        var value=await this._peerFactory.storage.retreiveAuthor(key,author);
        let ids=await this._onFindNodeInner(key,k);
        await this._replyToPeer({
            ids:ids,
            values:value?[value]:[]
        },findValueMessage);
    }

    /**
     * 
     * @param key key to search.
     * @param k k closest nodes
     * @param page page number startingt from zero. optional.
     * @returns array of messageEnvolopes previously stored, newst to oldest
     */

    async findValues(key:Buffer,k:number,page:number):Promise<FindResult|null>{
        if (this._id==null)
            throw new Error("Peer not initialized");
        var q:any={
            n:key,
            p:page,
            k:k
        }
        var me=await this._requestToPeer(q,MessageType.findvalueNoAuthor);
        if (!me) return null;
        var peers=await this._nodeids2peers(me.p.ids);
        return {
            peers:peers,
            values:me.p.values
        }   
    }

    async _onFindValue(findValueMessage:MessageEnvelope){
        var key=findValueMessage.p.n;
        var page=findValueMessage.p.p;
        var k=findValueMessage.p.k;
        let ids=await this._onFindNodeInner(key,k);
        var values=await this._peerFactory.storage.retreiveAnyAuthor(key,page);
        await this._replyToPeer({
            ids:ids,
            values:values,
        },findValueMessage);
    }


    async _nodeids2peers(ids:Buffer[]):Promise<BasePeer[]>{
        var r:BasePeer[]=[];
        for(var nodeid of ids){
            if (Buffer.compare(nodeid,this.id)==0)
                r.push(this)
            else{
                var p=this._peerFactory.findPeerById(nodeid)
                if (p)
                    r.push(p);
                else{
                    r.push(await this._signalConnect(nodeid));
                }
            }
        }
        return r;
    }

    _signalConnect(nodeid:Buffer):Promise<BasePeer>{
        this._debug("_signalConnect to %s...",nodeid.toString('hex').slice(0,6));
        return new Promise((resolve,reject)=>{
            var simplePeer:SimplePeer.Instance|undefined;
            try{
                if (Buffer.compare(nodeid,this.peerfactoryId)==0){
                    this._debug("_signalConnect to MyselfPeer DONE ");
                    return resolve(this._peerFactory.MyselfPeer);
                };
                simplePeer=new SimplePeer({initiator: true, trickle: false, wrtc: wrtc as any });
                simplePeer.on('signal', async (data:any) => {
                    this._debug("_signalConnect initiator signal...");
                    var signaldata=JSON.stringify(data)
                    if (!simplePeer) return this._debug("_signalConnect signal with no simplePeer defined");
                    const me=await this._requestToPeer({
                        signalTo:nodeid, // node to connect
                        signalData:signaldata
                    },MessageType.signal)
                    if (!me || !me.p ) {
                        simplePeer.emit('error','did not receive signal data');
                        return; 
                    }
                    if(me.p.myself){
                        simplePeer.emit('error','signalled myself');
                        return;
                    }
                    if (!me.p.signalBack){
                        simplePeer.emit('error','did not receive signal envelope');
                        return;
                    }
                    var signalEnvelope:MessageEnvelope=me.p.signalBack;
                    if (!this._verifySignedMessageEnvelope(signalEnvelope) || !signalEnvelope.p || !signalEnvelope.p.s)
                    {
                        simplePeer.emit('error','receive invalid signal data');
                        return;
                    }
                    if (Buffer.compare(signalEnvelope.a,nodeid)){ // this is _peerFactory.newPeernot from the node i am looking for....
                        simplePeer.emit("fake answer");
                        this._abortPeer("sent a fake signal data")
                        return;
                    }
                    simplePeer.signal(signalEnvelope.p.s);
                })
                simplePeer.on('connect',()=>{
                    this._debug("_signalConnect connect...");
                    if (!simplePeer) return this._debug("_signalConnect signal with no simplePeer defined");
                    let r=new VerySimplePeer(this._peerFactory,simplePeer,nodeid);
                    r.startUp()
                    .then(()=>{
                        resolve(r);
                    })
                    .catch(err=>{
                        reject(err);
                    })
                })
                simplePeer.on('error',(err:any)=>{
                    this._debug("_signalConnect error %s...",err);
                    reject(err);
                    if (!(simplePeer===undefined) && !simplePeer.closed) simplePeer.destroy();
                })

            }catch(err){
                this._debug("_signalConnect error!"+err);
                reject(err);
                if (!(simplePeer===undefined) && !simplePeer.closed) simplePeer.destroy();
            }
        })
    }

    async _onRequestSignal(signalEnvelope:MessageEnvelope){
        try{
            this._debug("_onRequestSignal...")
            var basePeerToCall=this._peerFactory.findPeerById(signalEnvelope.p.signalTo);
            if (!basePeerToCall){
                this._debug("_onRequestSignal... DONE could not find the peer")
                return await this._replyToPeer({},signalEnvelope); 
            }
            if (basePeerToCall.idString==this._peerFactory.idString)
            {
                this._debug("_onRequestSignal... signalled MeAsPeer")
                return await this._replyToPeer({myself:true},signalEnvelope); 
            }
            var peerToCall=basePeerToCall as Peer;
            if (!peerToCall._requestToPeer)
                throw new Error("Ma come e' possibile");
            var signalback=await peerToCall._requestToPeer({
                forwardedSignalEnvelope:signalEnvelope
            },MessageType.signalled);
            if (signalback==null){
                this._debug("_onRequestSignal DONE with NO SIGNAL")
                return await this._replyToPeer({},signalEnvelope); 
            }
            await this._replyToPeer({signalBack:signalback},signalEnvelope);
            this._debug("_onRequestSignal DONE")
        }catch(err){
            this._debug("_onRequestSignal error "+err);
            return await this._replyToPeer({},signalEnvelope); 
        }
    }

    _onRequestSignalled(signalledEnvelope:MessageEnvelope):Promise<void>{
        this._debug("_onRequestSignalled...");
        return new Promise(async (resolve,reject)=>{
            try{
                var forwardedSignalEnvelope:MessageEnvelope=signalledEnvelope.p.forwardedSignalEnvelope;
                if (!this._verifySignedMessageEnvelope(forwardedSignalEnvelope)){
                    reject (new Error("could not verify incoming signal"));
                    this._abortPeer("could not verify incoming signal");
                    return;
                }
                if (Buffer.compare(forwardedSignalEnvelope.p.signalTo,this.peerfactoryId)){
                    reject (new Error("received request to signal not for me"));
                    this._abortPeer("received request to signal not for me");
                }
                var nodeid:Buffer=forwardedSignalEnvelope.a;
                var inboundSignaldata:string=forwardedSignalEnvelope.p.signalData;
                var knownSimplePeer=this._peerFactory.findPeerById(nodeid)
                if (knownSimplePeer!=null){
                    // he does not know me, I know him...
                    this._debug("Received signal request from %s why???",nodeid.toString('hex').slice(0,6));
                    reject("he does not knows me i know him")
                    return;
                }
                var simplePeer=new SimplePeer({trickle: false, wrtc: wrtc as any});
                simplePeer.on('signal',async (data:string)=>{
                    try{
                        var signalData=JSON.stringify(data);
                        await this._replyToPeer({s:signalData},signalledEnvelope);
                        this._debug("_onRequestSignalled signal back");
                    }
                    catch(err){
                        simplePeer.emit('error',err);
                    }
                });
                simplePeer.on('connect',()=>{
                    this._debug("_onRequestSignalled connect");
                    var r=new VerySimplePeer(this._peerFactory,simplePeer,nodeid);
                    r.startUp()
                    .then(()=>{
                        resolve();
                        this._debug("_onRequestSignalled DONE")
                    })
                    .catch(err=>{
                        reject(err);
                    })
                })
                simplePeer.on('error',err=>{
                    reject(err);
                })
                simplePeer.signal(inboundSignaldata);
            }catch(err){
                reject(err);
            }
        })
    }

    async _onRequestFromPeer(requestEnvelope:MessageEnvelope){ //incoming request is arrived
        switch(requestEnvelope.m){
            case MessageType.introduce:
                return this._onIntroduction(requestEnvelope);
            case MessageType.ping:
                return await this._onPing(requestEnvelope);
            case MessageType.store:
                return await this._onStore(requestEnvelope);
            case MessageType.findnode:
                return await this._onFindNode(requestEnvelope);
            case MessageType.findvalueAuthor:
                return await this._onFindValueAuthor(requestEnvelope);
            case MessageType.findvalueNoAuthor:
                return await this._onFindValue(requestEnvelope);
            case MessageType.signal:
                return await this._onRequestSignal(requestEnvelope);
            case MessageType.signalled:
                return await this._onRequestSignalled(requestEnvelope);
            case MessageType.add:
                return await this._onAdded(requestEnvelope);
            case MessageType.storemerkle:
                return await this._onStoreMerkleNode(requestEnvelope);
            case MessageType.findmerkle:
                return await this._onfindMerkleNode(requestEnvelope);
        }
        await this._abortPeer("invalid message type");
    }

    _requestToPeer(request:any,messageType:MessageType):Promise<MessageEnvelope|null>{
        return new Promise(async (resolve,reject)=>{
            var timeout:any=null;
            if (this.id==null) 
                return reject("not yet introduced");
            try{
                var cnt=this._reqCnt++;
                var packedRequest=this._packRequest(request,messageType,cnt);
                await this._sendMsg(packedRequest);
                timeout=setTimeout(()=>{
                    reject("timeout");
                },REPLYTIMEOUT);
                this._pendingRequest.set(cnt,{
                    resolve:resolve,
                    timeout:timeout,
                    created:Date.now()
                });
            }catch(err){
                if (timeout!=null) clearTimeout(timeout);
                this.emit('error',"cannot contact peer");
                await this._abortPeer("cannot contact peer");
                reject(err);
            }
        })
    }

    async _onReplyFromPeer(replyEnvelope:MessageEnvelope){ //incoming request is arrived
        if (this.id==null) return await this._abortPeer("not yet introduced");
        const pending=this._pendingRequest.get(replyEnvelope.c);
        if (!pending)
            return await this._abortPeer("cannot find matching request");
        clearTimeout(pending.timeout);
        pending.resolve(replyEnvelope);
        this._pendingRequest.delete(replyEnvelope.c);
    }

    async _replyToPeer(reply:object,requestEnvelope:MessageEnvelope,tbc?:boolean){
        var packedReply=this._packReply(reply,requestEnvelope,tbc);
        return await this._sendMsg(packedReply);
    }

    async _onMsg(signedbuffer:Buffer){
        var messageEnvelope=this._unpacksignedBuffer(signedbuffer);
        if (messageEnvelope==null)
            return await this._abortPeer("cannot unpack request");
        this._seen=Date.now();
        if (messageEnvelope.m==MessageType.reply){ //reply
            await this._onReplyFromPeer(messageEnvelope);
        }else{                                  //request
            await this._onRequestFromPeer(messageEnvelope);
        }
    }

    _packRequest(payload:any,m:MessageType,cnt:number):Buffer{
        var requestEnvelope:MessageEnvelope={
            v:VERSION,
            a:this.peerfactoryId,
            m:m,
            p:payload,
            t:Date.now(),
            c:cnt,
        }
        return this._packEnvelope(requestEnvelope);
    }

    _packReply(reply:any,requestEnvelope:any,tbc:boolean=false):Buffer{
        var replyEnvelope:MessageEnvelope={
            v:VERSION,
            a:this.peerfactoryId,
            m:MessageType.reply,
            p:reply,
            t:Date.now(),
            c:requestEnvelope.c,
        }
        return this._packEnvelope(replyEnvelope);
    }

    _packEnvelope(envelope:MessageEnvelope):Buffer{
        var envelopeBuffer=encode(envelope,MAXMSGSIZE);
        var requestSignature=this._peerFactory.sign(envelopeBuffer);
        var signedRequestBuffer=encode({m:envelopeBuffer,s:requestSignature},MAXMSGSIZE);
        var signedBuffer=Buffer.from(signedRequestBuffer);
        var r:any;
        if (this._encrypto_pk)
            r={e:sodium.crypto_box_encrypt(signedBuffer,this._encrypto_pk)};
        else 
            r={c:signedBuffer};
        return encode(r,MAXMSGSIZE);
    }

    _unpacksignedBuffer(incomingMessage:Buffer):MessageEnvelope|null{
        try{
            var signedBuffer:Buffer;

            let im=decode(incomingMessage);
            if (im.e){
                if (this._decrypto_pk==null || this._decrypto_sk==null)
                    throw new Error("cannot decrypt message without key");
                let sb=sodium.crypto_box_decrypt(im.e,this._decrypto_pk,this._decrypto_sk);
                if (sb==null)
                    throw new Error("cannot decrypt message");
                signedBuffer=sb;
            }else{
                signedBuffer=im.c;
            }

            var signedRequestObject=decode(signedBuffer);
            var messageEnvelope:MessageEnvelope=decode(signedRequestObject.m);
            messageEnvelope.s=signedRequestObject.s;
            if (!this._peerFactory.verify(signedRequestObject.m,signedRequestObject.s,messageEnvelope.a)) // messageEnvelope.a shoudl be my peer.id
                throw new Error("cannot verify signature")
            if (messageEnvelope.v!=VERSION)
                throw new Error("wrong version")
            if (Math.abs(Date.now()-messageEnvelope.t)>MAX_TS_DIFF)
                throw new Error("message timestamp not in sync")
            return messageEnvelope;
        }
        catch(err){
            let errmsg="cannot _unpacksignedBuffer "+err;
            this._debug(errmsg);
            this._abortPeer(errmsg);
            return null;
        }
    }

    _verifySignedMessageEnvelope(me:MessageEnvelope):boolean{
        if (!me) return false;
        if (!me.s) return false;
        let m={...me};
        delete m.s;
        var b=encode(m,MAXMSGSIZE);
        return this._peerFactory.verify(b,me.s,me.a);
    }

    _sendMsg(msg:Buffer):Promise<void>{
        throw new Error("Abstract to be implemented in sub classes"); // 
    }

    async _abortPeer(msg:string){
        this._debug("Abort Peer %s",msg);
        this.emit('error',msg);
    }
}

class PeerWebsocket extends Peer{
    _connection:WebSocket.connection;
    constructor(peerFactory:PeerFactory, connection:WebSocket.connection){
        super(peerFactory);
        if (!connection) throw new Error("invalid connection");
        if (!connection.connected) throw new Error("connection not connected");
        this._connection=connection;

        this._connection.on("message",message=>{
            if (message.type=="binary")
                this._onMsg(message.binaryData);
            else
                this._abortPeer("wrong message data type");
        });
    }

    _sendMsg(msg:Buffer):Promise<void>{ // override
        return new Promise((resolve,reject)=>{
            try{
                this._connection.sendBytes(msg,err=>{
                    if (err) 
                        throw new Error("could not sendBytes to websocket");
                    else 
                        resolve();
                })
            }catch(err){
                this._abortPeer("websocket send msg "+err)
                reject(err);
            }
        })
    }

    destroy(){
        try{
            this._connection.close();
        }catch(err){}
        super.destroy();
    }
}


class PeerWebsocketClient extends PeerWebsocket{
    constructor(peerFactory:PeerFactory,connection:WebSocket.connection){
        super(peerFactory,connection);
    }

    static fromConnectionToServer(peerFactory:PeerFactory,address:string):Promise<Peer>{
        return new Promise((resolve,reject)=>{
            try{
                var client=new WebSocket.client({});
                client.connect('ws://'+address+'/');
                client.once("connect",(connection)=>{
                    var r=new PeerWebsocketClient(peerFactory,connection);
                    r.startUp()
                    .then(()=>{
                        resolve(r);
                    })
                });
                client.once("connectFailed",(err)=>reject(err));
            }catch(err){
                reject(err);
            }
        })
    }
}

class PeerWebsocketServer extends PeerWebsocket{
    constructor(peerFactory:PeerFactory, connection:WebSocket.connection){
        super(peerFactory,connection);
    }
}


class PeerWebsocketListener extends EventEmitter{
    _peerFactory:PeerFactory;
    _port:number=0;
    _host?:string;
    _httpServer:http.Server|null=null;
    _webSocket:WebSocket.server|null=null;

    constructor(peerFactory:PeerFactory){
        super();
        this._peerFactory=peerFactory;
    }

    startup(port:number,host?:string):Promise<void>{
        return new Promise((resolve,reject)=>{
            try{
                this._port=port;
                this._host=host;
                this._httpServer=http.createServer((req,res)=>{
    
                });
                this._httpServer.on("error",reject);
                this._httpServer.listen(this._port,this._host,()=>{
                    if (this._httpServer==null) return;
                    this._webSocket=new WebSocket.server({ httpServer: this._httpServer, autoAcceptConnections:true});
                    this._webSocket.on("connect",async connection=>{
                        var p=new PeerWebsocketServer(this._peerFactory,connection);
                        p.startUp()
                        .catch(err=>{
                            p._abortPeer("could not startup peer "+err);
                        })
                    })
                    resolve();
                });
            }catch(err){
                reject(err);
            }
        })

    };
}

class VerySimplePeer extends Peer{
    _simplePeer:SimplePeer.Instance;
    _expectednodeid:Buffer;

    constructor(peerFactory:PeerFactory,simplePeer:SimplePeer.Instance, expectednodeid:Buffer){
        super(peerFactory);
        this._expectednodeid=expectednodeid;
        this._simplePeer=simplePeer;
        this._simplePeer.on('data',async (data:Buffer)=>{
            await this._onMsg(data);
        })
        this._simplePeer.on('error',err=>{
            this._abortPeer("VerySimplePeer on error "+err);
        })

        this._debug("VerySimplePeer create, expecting nodeId %s",expectednodeid.toString('hex').slice(0,6));
    }


    _sendMsg(msg:Buffer):Promise<void>{
        return new Promise((resolve,reject)=>{
            try{
                this._simplePeer.send(msg);
                resolve();
            }catch(err){
                this._abortPeer("VerySimplePeer _sendMsg "+err);
                reject(err);
            }
        })
    }

    destroy() {
        this._simplePeer.destroy();
        super.destroy();
    }
}


export class PeerFactory{
    _secretKey:Buffer;
    id:Buffer;
    storage:IStorage;
    _kbucket:KBucket;
    _debug:Debug.Debugger;
    _peerWebsocketListener:PeerWebsocketListener[]=[];
    _meAsPeer:MeAsPeer;
    _outofbucket:Map<string,BasePeer>=new Map();

    get idString():string{
        return this.id.toString('hex');
    }


    constructor(storage: IStorage,secretKey?:Buffer){
        //super();
        var r=sodium.keygen(secretKey);
        this._secretKey=r.sk;
        this.id=r.pk;
        this._debug=Debug("PeerFactory:"+this.id.toString('hex').slice(0,6));
        this.storage=storage;
        this._kbucket=new KBucket({
            localNodeId:this.id,
            numberOfNodesPerKBucket:KBUCKETSIZE,
            numberOfNodesToPing:KBUCKETSIZE,
            arbiter: (incumbent, candidate) => { return incumbent },
        });
        this._kbucket.on('ping', async (peersToPing, aNewPeer) => {
            this._debug("ping");
            var added=false;
            for (var peer of peersToPing) {
                var p = false;
                try {
                    p = await (peer as any).ping();
                } catch (err) { }
                if (!p) {
                    this._kbucket.remove(peer.id);
                    if (!added){
                        this._kbucket.add(aNewPeer);
                        added=true;
                        this._debug("ping replaced");
                    }
                }
            }
            this._debug("ping all replied");
        });
        this._kbucket.on('added',async contact=>{
            var peer:BasePeer=contact as any;
            this._debug(" _kbucket added %s",peer.nickName);
            this._outofbucket.delete(peer.idString);
            await peer.added(true);
        });
        this._kbucket.on('removed',async contact=>{
            var peer:BasePeer=contact as any;
            this._debug(" _kbucket removed %s",peer.nickName);
            if(peer==this.MyselfPeer){
                this._debug(" _kbucket removed meAsPeer! add again");
                this._kbucket.add(contact);
            }
            else{
                await peer.added(false);
                this._outofbucket.set(peer.idString,peer);
            }
        });
        this._meAsPeer=new MeAsPeer(this);
        this._kbucket.add(this._meAsPeer);
    }

    get MyselfPeer():BasePeer{
        return this._meAsPeer;
    }

    get kbucket():KBucket{
        return this._kbucket;
    }

    get debug(){
        return this._debug;
    }

    newPeer(peer:Peer):void{
        this._debug("newPeer %s",peer.nickName);
        this._kbucket.add(peer as any);
        peer.once('destroy',()=>{
            this._kbucket.remove(peer.id);
            this._outofbucket.delete(peer.idString);
        })
        peer.on('error',(err)=>{
            this._debug("Error by peer "+err);
        })    
    }

    findPeerById(id:Buffer):BasePeer|null{
        if (Buffer.compare(id,this.id)==0) return this.MyselfPeer;
        var r:BasePeer|null|undefined=this._kbucket.get(id) as any;
        if (r) return r;
        r=this._outofbucket.get(id.toString('hex'));
        return r?r:null;
    }

    findClosestPeers(key:Buffer,k:number):BasePeer[]{
        return this._kbucket.closest(key,k) as any;
    }

    async createListener(port:number,host?:string):Promise<void>{
        var l=new PeerWebsocketListener(this);
        await l.startup(port,host);
        this._peerWebsocketListener.push(l);
    }

    async createClient(port:number,host:string):Promise<void>{
        var peer= await PeerWebsocketClient.fromConnectionToServer(this,host+":"+port)
    }

    sign(msg:Buffer):Buffer{
        return sodium.sign(msg, this._secretKey);
    }

    verify(msg:Buffer,signature:Buffer,author:Buffer):boolean{
        return sodium.verify(signature, msg, author);
    }

    createStorageEntry(key:Buffer,value:Buffer):ISignedStorageEntry{
        var r:IStorageEntry={
            author:this.id,
            key:key,
            value:value,
            timestamp:Date.now(),
            version:VERSION,            
        }
        return {
            entry:r,
            signature:this.sign(encode(r,MAXMSGSIZE))
        };
    }

    verifyStorageEntry(signedentry:ISignedStorageEntry):boolean{
        return this.verify(encode(signedentry.entry,MAXMSGSIZE),signedentry.signature,signedentry.entry.author);
    }

    createSignedMerkleNode(node:IMerkleNode):ISignedStorageMerkleNode{
        var r:IStorageMerkleNode={
            author:this.id,
            node:node,
            timestamp:Date.now(),
            version:VERSION,            
        }
        return {
            entry:r,
            signature:this.sign(encode(r,MAXMSGSIZE))
        }
    }

    verifySignedMerkleNode(signed:ISignedStorageMerkleNode):boolean{
        return this.verify(encode(signed.entry,MAXMSGSIZE),signed.signature,signed.entry.author);
    }


}

