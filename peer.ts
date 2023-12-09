import {EventEmitter} from 'events';
import Debug from 'debug';

import wrtc from 'wrtc';
import WebSocket from 'websocket';
import SimplePeer from 'simple-peer';
import * as sodium from './mysodium';
import {encode,decode} from './encoder';
import {PeerFactory} from './peerFactory';

import {IUserId,IStorageEntry,IStorage,ISignedBuffer } from './IStorage.js'


export const VERSION=1;

export const MAXMSGSIZE=131072;
const MAXSTOREVALUESIZE=1024*2;
const MAXRECORDFINDVALUES=Math.floor(MAXMSGSIZE/MAXSTOREVALUESIZE)-1
export const USER_REGEXP=/^\p{L}(\p{L}|\p{N}){3,31}$/ui;
const SIMPLEPEERCONFIG= { }/*
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, 
        { urls: 'stun1.l.google.com:19302' },
        { urls: 'stun2.l.google.com:19302' },
        { urls: 'stunserver.org'}
    ] };*/


const DEBUG=1;
export const MAX_TS_DIFF=DEBUG*5*60000+2*60*1000;
const REPLYTIMEOUT=DEBUG*60000+5000;
const INTRODUCTIONTIMEOUT=DEBUG*60000+2*1000;



interface Introduction{
    id:Buffer;
    ts:number;
}

enum MessageType{
    // reply to any message
    reply=0,
    // P2P
    introduce,
    add,
    shutdown,
    ping,
    // values
    store,
    findnode,
    findvalueAuthor,
    receiveMessages,
    // WebRTC
    signal,
    signalled,
    //UserId
    setUserId,
    getUserId,
    // infoHash storage
    storeBuffer,
    retreiveBuffer,
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
    /** MessageType enum */
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

export interface IFindResult{
    peers:BasePeer[];
    values:IStorageEntry[];
}

export interface IReceiveMessagesResult{
    sses:IStorageEntry[];
    nextTs:number;
}

export interface IGetUserResult{
    peers:BasePeer[];
    value?:IUserId;
}

interface IPendingRequest{
    resolve:any,
    timeout:any,
    created:number,   
}

export function checkUserName(userId:string):boolean{
    return !!userId.match(USER_REGEXP);
}

enum PeerStatus{
    created,
    active,
    destroyed,
}

interface Contact{
    id:Buffer,
    vectorClock:number
}

export class BasePeer extends EventEmitter implements Contact{
    static peerCnt=0;
    protected _peerFactory:PeerFactory;
    protected _factoryDebug:Debug.Debugger;
    protected _debugPrefix:string;
    protected _storage:IStorage;
    protected _PeerStatus:PeerStatus=PeerStatus.created;

    constructor(peerFactory:PeerFactory){
        super();
        this._debugPrefix="["+this.constructor.name+"]: ";//+peerFactory.id.toString('hex').slice(0,6)+"] ";
        this._peerFactory=peerFactory;
        this._storage=peerFactory.storage;
        this._factoryDebug=this._peerFactory._debug;
        this._debug("creating new peer");
    }

    protected _debug(...args: any[]){
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

    async destroy(){
        this._debug("destroy");
        this._peerFactory.destryedPeer(this);
        this._PeerStatus=PeerStatus.destroyed;
    }

    async added(status:boolean):Promise<void> {
        throw new Error("Abstract");
    }

    async ping():Promise<boolean>{
        throw new Error("Abstract");
    }

    async store(entry:IStorageEntry,k:number):Promise<BasePeer[]|null>{
        throw new Error("Abstract");
    }

    async storeBuffer(isb:ISignedBuffer,k:number):Promise<BasePeer[]>{
        throw new Error("Abstract");
    }

    async retreiveBuffer(infoHash:Buffer,k:number):Promise<ISignedBuffer|BasePeer[]>{
        throw new Error("Abstract");
    }

    async findValueAuthor(author:Buffer,k:number):Promise<IFindResult|null>{
        throw new Error("Abstract");
    }

    async receiveMessages(ts:number):Promise<IReceiveMessagesResult|null>{
        throw new Error("Abstract");
    }
    
    async findNode(k:number):Promise<BasePeer[]>{
        throw new Error("Abstract");
    }

    async setUserId(userId:IUserId,k:number):Promise<BasePeer[]|false|null>{
        throw new Error("Abstract");
    }

    async getUserId(userHash:Buffer,k:number):Promise<IGetUserResult|null>{
        throw new Error("Abstract");
    }

    async shutdown(){
    }
}

export class MeAsPeer extends BasePeer{
    constructor(peerFactory:PeerFactory){
        super(peerFactory);
        this._PeerStatus=PeerStatus.active;
    }

    get id():Buffer{
        return this._peerFactory.id;
    }

    async ping():Promise<boolean>{
        try{
            this._debug("ping ...");
            return true;
        }finally{
            this._debug("ping DONE");
        }

    }

    async added(status:boolean):Promise<void> { }


    async storeBuffer(isb:ISignedBuffer,k:number):Promise<BasePeer[]>{
        try{
            this._debug("storeBuffer MeAsPeer %s...",isb.infoHash.toString('hex'));
            await this._storage.storeBuffer(isb);
            return this._peerFactory.findClosestPeers(isb.infoHash,k); 
        }  
        finally{
            this._debug("storeBuffer MeAsPeer DONE");
        }
    }

    async retreiveBuffer(infoHash:Buffer,k:number):Promise<ISignedBuffer|BasePeer[]>{
        try{
            this._debug("retreiveBuffer MeAsPeer %s...",infoHash.toString('hex'));
            var mn=await this._storage.retreiveBuffer(infoHash);
            if (mn) return mn;
            return this._peerFactory.findClosestPeers(infoHash,k);
        }finally{
            this._debug("retreiveBuffer DONE");
        }
    }

    async store(signedentry:IStorageEntry,k:number):Promise<BasePeer[]|null>{
        try{
            this._debug("store ...");
            await this._storage.storeSignedEntry(signedentry);
            this._peerFactory.onReceivedMessage(signedentry);
            return this._peerFactory.findClosestPeers(signedentry.key,k)
        }finally{
            this._debug("store DONE");
        }
    }

    async receiveMessages(ts:number):Promise<IReceiveMessagesResult|null>{
        try{
            this._debug("findValues ...");

            var values=await this._storage.retreiveAnyAuthor(this.id,ts,MAXRECORDFINDVALUES)

            return{
                sses:values,
                nextTs:values.length?values[values.length-1].timestamp:0
            }
        }finally{
            this._debug("findValues DONE");
        }
    }
    
    async findValueAuthor(author:Buffer,k:number):Promise<IFindResult|null>{
        try{
            this._debug("findValueAuthor ...");
            var value=await this._storage.retreiveAuthor(this.id,author)
            var peers=this._peerFactory.findClosestPeers(this.id,k);
            let r={
                peers:peers,
                values:value?[value]:[]
            }
            this._debug("findValueAuthor DONE");
            return r;
        }catch(err){
            this._debug("findValueAuthor FAILED");
            console.log(err);
            throw(err);
        }
    }

    async findNode(k:number):Promise<BasePeer[]>{
        try{
            this._debug("findNode ...");
            var peers=this._peerFactory.findClosestPeers(this.id,k);
            return peers;
        }finally{
            this._debug("findNode DONE");
        }

    }
    get nickName():string{
        return "MeAsPeer";
    }

    async setUserId(userId:IUserId,k:number):Promise<BasePeer[]|null>{
        try{
            this._debug("setUserId ...");
            await this._storage.setUserId(userId);
            return this._peerFactory.findClosestPeers(userId.userHash,k);
        }finally{
            this._debug("setUserId DONE");
        }
    }
    async getUserId(userHash:Buffer,k:number):Promise<IGetUserResult|null>{
        try{
            this._debug("getUserId ...");
            var r:IGetUserResult={
                peers:this._peerFactory.findClosestPeers(userHash,k)
            }
            var su=await this._storage.getUserId(userHash);
            if (su) r.value=su;
            return r;
        }finally{
            this._debug("getUserId DONE");
        }
    }

}

class Peer extends BasePeer  {
    protected _id:Buffer|null=null;
    protected _created:number;
    protected _seen:number;
    protected _reqCnt:number=1;
    protected _pendingRequest=new Map<number,IPendingRequest>;
    protected _decrypto_pk:Buffer|null=null;
    protected _decrypto_sk:Buffer|null=null;
    protected _encrypto_pk:Buffer|null=null;
    protected _added:boolean=true;
    protected _otherAdded:boolean=true;
    protected _nickName:string|undefined;
    protected _resolveIntroduction:any;
    protected _startStatus:boolean=false;

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

    startUp():Promise<void>{
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
            this._PeerStatus=PeerStatus.active;
            this._peerFactory.newPeer(this);
        })
        .catch(err=>{
            this._abortPeer("failed startup introduction "+err)
        })
    }

    protected _onIntroduction(introEnvelope:MessageEnvelope){
        if (this._id!=null || this._encrypto_pk!=null) {
            return this._maliciousPeer("received double introduction");
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

    async shutdown(){
        if (this._PeerStatus!=PeerStatus.active) 
            throw new Error("Peer not active");
        var me=await this._requestToPeer({},MessageType.shutdown);
        this.destroy();
    }

    protected async _onShutdown(requestEnvelope:MessageEnvelope){
        if (this._PeerStatus!=PeerStatus.active) 
            throw new Error("Peer not active");
        await this._replyToPeer({},requestEnvelope);     
        this.destroy();   
    }

    async added(status:boolean):Promise<void> {
        if (this._PeerStatus!=PeerStatus.active) 
            throw new Error("Peer not active");
        if (this._added) return;
        this._added=status;
        if (await this._fullyRemoved()) return;
        var me=await this._requestToPeer({added:this._added},MessageType.add);
        if (!me) return await this._abortPeer("failed to chage added status");
        this._otherAdded=me.p.added;
        if (await this._fullyRemoved()) return;
    }

    protected async _onAdded(requestEnvelope:MessageEnvelope){
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        this._otherAdded=requestEnvelope.p.added;
        if (await this._fullyRemoved()) return;
        await this._replyToPeer({added:this._added},requestEnvelope);
    }

    protected async _fullyRemoved():Promise<boolean>{
        if (this._added || this._otherAdded) return false;
        this._debug("fully removed");
        await this.destroy();
        return true;
    }

    async ping():Promise<boolean>{
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        if (this._id==null)
            throw new Error("Peer not initialized");
        var r=false;
        try{
            var me=await this._requestToPeer({},MessageType.ping);
            r=!!me;
        }catch(err){}
        return r;
    }

    protected async _onPing(requestEnvelope:MessageEnvelope){
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        this._replyToPeer({},requestEnvelope);
    }

    /**
     * 
     * @param key key to store
     * @param value value
     * @param k nearest neighb.
     * @returns list of peers
     */

    async store(signedentry:IStorageEntry,k:number):Promise<BasePeer[]|null>{
        this._debug("store...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
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

    protected async _onStore(storeEnvelope:MessageEnvelope,){
        this._debug("_onStore...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var signedentry:IStorageEntry=storeEnvelope.p.entry;
        if(!this._peerFactory.verifyStorageEntry(signedentry)){
            return this._maliciousPeer("receive fake storage entry");
        }
        await this._storage.storeSignedEntry(signedentry);
        this._peerFactory.onReceivedMessage(signedentry);

        var ids=this._onFindNodeInner(signedentry.key,storeEnvelope.p.k)
        await this._replyToPeer({ids:ids},storeEnvelope);
        this._debug("_onStore done");
    }

    /**
     * 
     * @param key key to search.
     * @param author author id. optional/
     * @param k k closest nodes
     * @returns 
     */

    async findValueAuthor(author:Buffer,k:number):Promise<IFindResult|null>{
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var q:any={
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

    protected async _onFindValueAuthor(findValueMessage:MessageEnvelope){
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var key=findValueMessage.a;
        var author=findValueMessage.p.b;
        var k=findValueMessage.p.k;
        var value=await this._storage.retreiveAuthor(key,author);
        if (value && !this._peerFactory.verifyStorageEntry(value)){
            this._abortPeer("invalid signature");
            return;
        }
        let ids=this._onFindNodeInner(key,k);
        await this._replyToPeer({
            ids:ids,
            values:value?[value]:[]
        },findValueMessage);
    }

    /**
     * 
     * @param k k closest nodes
     * @param page page number startingt from zero. optional.
     * @returns array of messageEnvolopes previously stored, newst to oldest
     */

    async receiveMessages(ts:number ):Promise<IReceiveMessagesResult|null>{
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var q:any={
            ts:ts
        }
        var me=await this._requestToPeer(q,MessageType.receiveMessages);
        if (!me) return null;
        const values=me.p;
        for(var se of values){
            if(!this._peerFactory.verifyStorageEntry(se)){
                this._maliciousPeer("invalid signature");
                return null;
            }
        }
        return {
            sses:values,
            nextTs:values.lenght?values[values.lenght-1].entry.timestamp:0
        }
    }

    protected async _onReceiveMessages(findValueMessage:MessageEnvelope){
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var key=findValueMessage.a;
        var ts=findValueMessage.p.ts;
        var values=await this._storage.retreiveAnyAuthor(key,ts,MAXRECORDFINDVALUES);
        await this._replyToPeer(values,findValueMessage);
    }



    /**
     * 
     * @param signedUserId 
     * @param k 
     * @returns 
     */

    async setUserId(userId:IUserId,k:number):Promise<BasePeer[]|false|null>{
        this._debug("setUserId...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        if (!checkUserName(userId.userId)) throw new RangeError("user lenght");
        var res=await this._requestToPeer({
            entry:userId,
            k:k
        },MessageType.setUserId);
        if (!res) return null;
        if (!res.p.result) return false;
        var r=await this._nodeids2peers(res.p.ids);
        this._debug("setUserId DONE");
        return r;
    }

    protected async _onSetUserId(userIdMessage:MessageEnvelope){
        this._debug("_onSetUserId...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var su:IUserId=userIdMessage.p.entry;
        var k:number=userIdMessage.p.k;

        if (!checkUserName(su.userId)){
            this._maliciousPeer("invalid userId");
            return;
        }

        if (!this._peerFactory.verifySignedUserName(su)){
            this._maliciousPeer("invalid signature");
            return;
        }

        if (await this._storage.setUserId(su)){
            let ids=this._onFindNodeInner(su.userHash,k);
            await this._replyToPeer({result:true, ids:ids},userIdMessage);
        }
        else
            await this._replyToPeer({result:false},userIdMessage);

        this._debug("_onSetUserId DONE");
    }

    async getUserId(userHash:Buffer,k:number):Promise<IGetUserResult|null>{
        this._debug("getUserId...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var res=await this._requestToPeer({
            userHash:userHash,
            k:k
        },MessageType.getUserId);
        if (!res) return null;    
        var peers=await this._nodeids2peers(res.p.ids);
        var r:IGetUserResult={
            peers:peers
        }
        var signed:IUserId=res.p.userId;
        if(signed) {
            r.value=signed;
            if (!this._peerFactory.verifySignature(signed,signed.author) || Buffer.compare(signed.userHash,userHash))
            {
                this._maliciousPeer("returned wrong userHash");
                return null;
            }
        }
        this._debug("getUserId DONE");
        return r;
    }

    protected async _onGetUserId(getUser:MessageEnvelope){
        this._debug("_onGetUserId...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var userHash:Buffer=getUser.p.userHash;
        var k:number=getUser.p.k;
        var su=await this._storage.getUserId(userHash);
        var ids=this._onFindNodeInner(userHash,k);
        if (su){
            await this._replyToPeer({signed:su,ids:ids},getUser);
        }else{
            await this._replyToPeer({ids:ids},getUser);
        }
        this._debug("_onGetUserId DONE");
    }

    async storeBuffer(isb:ISignedBuffer,k:number):Promise<BasePeer[]>{
        this._debug("storeBuffer %s...",isb.infoHash.toString('hex'));
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var res=await this._requestToPeer({
            isb:isb,
            k:k
        },MessageType.storeBuffer);
        if (!res) return [];
        var r=await this._nodeids2peers(res.p.ids);
        this._debug("storeBuffer done");
        return r;
    }

    protected async _onStoreBuffer(bufferMessage:MessageEnvelope){
        this._debug("_onStoreBuffer ....");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var signed:ISignedBuffer=bufferMessage.p.isb;
        var k:number=bufferMessage.p.K;
        if (!this._peerFactory.verifySignedBuffer(signed)){
            this._maliciousPeer("invalid buffer received");
            return;
        }
        await this._storage.storeBuffer(signed);
        var ids=this._onFindNodeInner(signed.infoHash,k)
        await this._replyToPeer({ids:ids},bufferMessage);
        this._debug("_onStoreBuffer done");
    }

    async retreiveBuffer(infoHash:Buffer,k:number):Promise<ISignedBuffer|BasePeer[]>{
        this._debug("retreiveBuffer %s...",infoHash.toString('hex'));
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var res=await this._requestToPeer({
            infoHash:infoHash,
            k:k
        },MessageType.retreiveBuffer);
        if (res==null) return [];
        var r;
        if (res.p.ids) {
            this._debug("retreiveBuffer not found Node");
            r=await this._nodeids2peers(res.p.ids);
        }else if (res.p.isb) {
            this._debug("retreiveBuffer found Node");
            r=res.p.isb;
            if(!this._peerFactory.verifySignedBuffer(r)){
                await this._maliciousPeer("invalid signature in the reply");
                r=[];                
            }
        }else{
            await this._maliciousPeer("invalid reply");
            r=[];
        }
        this._debug("retreiveBuffer DONE");
        return r;
    }

    protected async _onRetreiveBuffer(findBuffer:MessageEnvelope){
        this._debug("_onRetreiveBuffer...");
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var infoHash:Buffer=findBuffer.p.infoHash;
        var k:number=findBuffer.p.k;
        var isb=await this._storage.retreiveBuffer(infoHash);
        if (!isb){
            var ids=this._onFindNodeInner(infoHash,k)
            await this._replyToPeer({ids:ids},findBuffer);
            this._debug("_onRetreiveBuffer found");
        }else{
            await this._replyToPeer({isb:isb},findBuffer);
            this._debug("_onRetreiveBuffer NOT found");
        }
    }

    /**
     * 
     * @param key node is to find
     * @param k parameter
     * @returns 
     */
    
    async findNode(k:number):Promise<BasePeer[]>{
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var nodesMessage=await this._requestToPeer({
            k:k
        },MessageType.findnode);
        if (nodesMessage==null) return [];
        var nodesIds:Buffer[]=nodesMessage.p.ids;
        return await this._nodeids2peers(nodesIds);
    }


    protected async _onFindNode(findNodeEnvelope:MessageEnvelope){
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        var nodesIds=this._onFindNodeInner(findNodeEnvelope.a,findNodeEnvelope.p.k)
        await this._replyToPeer({ids:nodesIds},findNodeEnvelope);
    }
    

    protected _onFindNodeInner(key:Buffer,k:number):Buffer[]{
        var nodes=this._peerFactory.findClosestPeers(key,k);
        return nodes.map(peer=>peer.id) as Buffer[];
    }


    protected async _nodeids2peers(ids:Buffer[]):Promise<BasePeer[]>{
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

    protected _signalConnect(nodeid:Buffer):Promise<BasePeer>{
        this._debug("_signalConnect to %s...",nodeid.toString('hex').slice(0,6));
        if (this._PeerStatus!=PeerStatus.active) throw new Error("Peer not active");
        return new Promise((resolve,reject)=>{
            var simplePeer:SimplePeer.Instance|undefined;
            try{
                if (Buffer.compare(nodeid,this.peerfactoryId)==0){
                    this._debug("_signalConnect to MyselfPeer DONE ");
                    return resolve(this._peerFactory.MyselfPeer);
                };
                simplePeer=new SimplePeer({initiator: true, trickle: false, wrtc: wrtc as any, config:SIMPLEPEERCONFIG });
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
                        this._maliciousPeer("sent a fake signal data")
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
                simplePeer.on('error',async (err:any)=>{
                    this._debug("_signalConnect error %s...",err);
                    reject(err);
                    if (!(simplePeer===undefined) && !simplePeer.closed) await simplePeer.destroy();
                })

            }catch(err){
                this._debug("_signalConnect error!"+err);
                reject(err);
                if (!(simplePeer===undefined) && !simplePeer.closed) simplePeer.destroy();
            }
        })
    }

    protected async _onRequestSignal(signalEnvelope:MessageEnvelope){
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

    protected _onRequestSignalled(signalledEnvelope:MessageEnvelope):Promise<void>{
        this._debug("_onRequestSignalled...");
        return new Promise(async (resolve,reject)=>{
            try{
                var forwardedSignalEnvelope:MessageEnvelope=signalledEnvelope.p.forwardedSignalEnvelope;
                if (!this._verifySignedMessageEnvelope(forwardedSignalEnvelope)){
                    reject (new Error("could not verify incoming signal"));
                    this._maliciousPeer("could not verify incoming signal");
                    return;
                }
                if (Buffer.compare(forwardedSignalEnvelope.p.signalTo,this.peerfactoryId)){
                    reject (new Error("received request to signal not for me"));
                    this._maliciousPeer("received request to signal not for me");
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
                var simplePeer=new SimplePeer({trickle: false, wrtc: wrtc as any, config:SIMPLEPEERCONFIG});
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

    protected async _onMessageFromPeer(messageEnvelope:MessageEnvelope,len:number){ //incoming request is arrived
        switch(messageEnvelope.m){
            case MessageType.reply:
                return await this._onReplyFromPeer(messageEnvelope,len);
            case MessageType.introduce:
                return this._onIntroduction(messageEnvelope);
            case MessageType.ping:
                return await this._onPing(messageEnvelope);
            case MessageType.store:
                return await this._onStore(messageEnvelope);
            case MessageType.findnode:
                return await this._onFindNode(messageEnvelope);
            case MessageType.findvalueAuthor:
                return await this._onFindValueAuthor(messageEnvelope);
            case MessageType.receiveMessages:
                return await this._onReceiveMessages(messageEnvelope);
            case MessageType.signal:
                return await this._onRequestSignal(messageEnvelope);
            case MessageType.signalled:
                return await this._onRequestSignalled(messageEnvelope);
            case MessageType.add:
                return await this._onAdded(messageEnvelope);
            case MessageType.setUserId:
                return await this._onSetUserId(messageEnvelope);
            case MessageType.getUserId:
                return await this._onGetUserId(messageEnvelope);
            case MessageType.shutdown:
                return await this._onShutdown(messageEnvelope);
            case MessageType.retreiveBuffer:
                return await this._onRetreiveBuffer(messageEnvelope);
            case MessageType.storeBuffer:
                return await this._onStoreBuffer(messageEnvelope);
            default:
                await this._maliciousPeer("invalid message type");
        }
    }

    protected _requestToPeer(request:any,messageType:MessageType):Promise<MessageEnvelope|null>{
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
                this.emit('error',"cannot contact peer"+err);
                await this._abortPeer("cannot contact peer"+err);
                reject(err);
            }
        })
    }

    protected async _onReplyFromPeer(replyEnvelope:MessageEnvelope,len:number){ //incoming request is arrived
        if (this._id==null) return await this._abortPeer("not yet introduced");
        const pending=this._pendingRequest.get(replyEnvelope.c);
        if (!pending)
            return await this._maliciousPeer("cannot find matching request");
        clearTimeout(pending.timeout);
        pending.resolve(replyEnvelope,len);
        this._pendingRequest.delete(replyEnvelope.c);
    }

    protected async _replyToPeer(reply:object,requestEnvelope:MessageEnvelope,tbc?:boolean){
        var packedReply=this._packReply(reply,requestEnvelope,tbc);
        return await this._sendMsg(packedReply);
    }

    protected async _onMsg(signedbuffer:Buffer){
        if (signedbuffer.length >= MAXMSGSIZE)
            return await this._maliciousPeer("message too long");
        var messageEnvelope = this._unpacksignedBuffer(signedbuffer);
        if (messageEnvelope == null) return;
        this._seen=Date.now();
        await this._onMessageFromPeer(messageEnvelope,signedbuffer.length);
    }

    protected _packRequest(payload:any,m:MessageType,cnt:number):Buffer{
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

    protected _packReply(reply:any,requestEnvelope:any,tbc:boolean=false):Buffer{
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

    protected _packEnvelope(envelope:MessageEnvelope):Buffer{
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

    protected _unpacksignedBuffer(incomingMessage:Buffer):MessageEnvelope|null{
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
            if (!this._peerFactory.verify(signedRequestObject.m,signedRequestObject.s,messageEnvelope.a)){ // messageEnvelope.a shoudl be my peer.id
                this._maliciousPeer("cannot verify signature");
                return null;
            }
            if (messageEnvelope.v!=VERSION){
                this._abortPeer("wrong peer version");
                return null;
            }
            if (Math.abs(Date.now()-messageEnvelope.t)>MAX_TS_DIFF){
                this._abortPeer("message timestamp not in sync");
                return null;

            }
            return messageEnvelope;
        }
        catch(err){
            this._abortPeer("cannot _unpacksignedBuffer "+err);
            return null;
        }
    }

    protected _verifySignedMessageEnvelope(me:MessageEnvelope):boolean{
        if (!me) return false;
        if (!me.s) return false;
        let m={...me};
        delete m.s;
        var b=encode(m,MAXMSGSIZE);
        return this._peerFactory.verify(b,me.s,me.a);
    }

    protected _sendMsg(msg:Buffer):Promise<void>{
        throw new Error("Abstract to be implemented in sub classes"); // 
    }

    protected async _abortPeer(msg:string){
        this._debug("Abort Peer %s",msg);
        await this.destroy();
        this.emit('error',msg);
    }

    protected async _maliciousPeer(msg:string){
        this._debug("Malicious Peer %s",msg);
        //  TODO
        await this.destroy();
        this.emit('error',msg);
    }
}

export class PeerWebsocket extends Peer{
    protected _connection:WebSocket.connection;
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
        this._connection.once('close',async (reasonCode, description)=>{
            await this.destroy();
        });
        this._connection.once('error',err=>{
            this._abortPeer(" on.error "+err);
        });
    }

    protected _sendMsg(msg:Buffer):Promise<void>{ // override
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

    async destroy(){
        try{
            this._connection.close();
        }catch(err){}
        await super.destroy();
    }
}


export class PeerWebsocketClient extends PeerWebsocket{
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




class VerySimplePeer extends Peer{
    private _simplePeer:SimplePeer.Instance|null;
    private _expectednodeid:Buffer;

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
        this._simplePeer.on('close',async ()=>{
            await this.destroy();
        })
        

        this._debug("VerySimplePeer create, expecting nodeId %s",expectednodeid.toString('hex').slice(0,6));
    }

    protected async _onIntroduction(introEnvelope:MessageEnvelope){
        await super._onIntroduction(introEnvelope);
        if (!this._id || Buffer.compare(this._expectednodeid,this._id))
            this._maliciousPeer("introduction did not send expected id")
    }


    protected _sendMsg(msg:Buffer):Promise<void>{
        return new Promise((resolve,reject)=>{
            if(!this._simplePeer) return reject("destroyed");
            if (this._simplePeer.closed) return reject("closed");
            if (!this._simplePeer.connected) return reject("not connected");
            if (this._simplePeer.errored)   return reject("errored");
            if (this._simplePeer.destroyed)  return reject("destroyed WEIRD" );
            if (!this._simplePeer.writable)   return reject("not writable");
            try{
                this._simplePeer.send(msg);
                resolve();
            }catch(err){
                this._abortPeer("VerySimplePeer _sendMsg "+err);
                reject(err);
            }
        })
    }

    async destroy() {
        try{
            if (this._simplePeer){
                this._debug("destroy VerySimplePeer")
                this._simplePeer.destroy();
                this._debug("destroyed VerySimplePeer")
                this._simplePeer=null;
            }
        }catch(err){};
        await super.destroy();
    }

}

