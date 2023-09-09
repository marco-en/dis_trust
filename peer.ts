import WebSocket from 'websocket';
import http from 'http';
import {EventEmitter} from 'events';
import SimplePeer from 'simple-peer';
import wrtc from 'wrtc';
import * as sodium from './mysodium.js';
import Debug from 'debug';
import KBucket from 'k-bucket';
import {encode,decode} from './encoder.js'


const MAX_TS_DIFF=2*60*1000;
const REPLYTIMEOUT=60*1000;
const VERSION=1;
const INTRODUCTIONTIMEOUT=2*1000;
const KBUCKETSIZE=20;

export interface DHTEntry{
    key:Buffer;
    value:Buffer;
}

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
}

/**
 * MessageEnvelope
 * v {number} - Version number, fixed to 1
 * a {Buffer} - author of this messageEnvelope
 * p {any} - payload
 * t {number} - timestamp of the envelope
 * c {number} - request/reply counter
 */

export interface MessageEnvelope{

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

export interface FindResult{
    peers:Peer[];
    values:MessageEnvelope[];
}

/**
 * @interface IStorage
 * @method{store} - store a message envelope, Key is messageEnvelope.p.key. Author is messageEnvelope.a.
 * @method retreive - key, author optional, page number. return MessageEnvelopes in from newst to oldest
 */

export interface IStorage{
    storeMessageEnvelope:(me:MessageEnvelope)=>Promise<void>,
    othersKeyStore:(version:number, author:Buffer, key:Buffer, value:Buffer, timestamp:number,  counter:number, signature?:Buffer)=>Promise<void>,
    ownKeyStore:(author:Buffer, key:Buffer, value:Buffer)=>Promise<void>,
    retreive:(key:Buffer,author:Buffer|null,page:number)=>Promise<MessageEnvelope[]>
}

interface IPendingRequest{
    resolve:any,
    timeout:any,
    created:number,   
}

export class BasePeer extends EventEmitter{
    static peerCnt=0;
    _peerFactory:PeerFactory;
    _debug:Debug.Debugger;
    constructor(peerFactory:PeerFactory){
        super();
        this._debug=Debug(this.constructor.name+": "+peerFactory.id.toString('hex').slice(0,6));
        this._debug("creating new peer")
        this._peerFactory=peerFactory;
    }

    peerfactoryId():Buffer{
        return this._peerFactory.id;
    }
    destroy(){
        throw new Error("Abstract");
    }
    async ping():Promise<boolean>{
        throw new Error("Abstract");
    }
    async store(dhtEntry:DHTEntry,k:number):Promise<Peer[]|null>{
        throw new Error("Abstract");
    }
    async findValueAuthor(key:Buffer,author:Buffer,k:number):Promise<FindResult|null>{
        throw new Error("Abstract");
    }
    async findValues(key:Buffer,k:number,page:number):Promise<FindResult|null>{
        throw new Error("Abstract");
    }

}



export class Peer extends BasePeer  {
    id:Buffer|null=null;
    idString:string='';
    get vectorClock() {return 0};
    _created:number;
    _seen:number;
    _reqCnt:number=1;
    _pendingRequest=new Map<number,IPendingRequest>;
    _introStatus=2;
    _decrypto_pk:Buffer|null=null;
    _decrypto_sk:Buffer|null=null;
    _encrypto_pk:Buffer|null=null;
    _timeout:any;

    constructor(peerFactory:PeerFactory){
        super(peerFactory);
        this._created=this._seen=Date.now();

        this._timeout=setTimeout(()=>{
            if(this._introStatus)
            {
                this.emit('error','introduction timeout');
                this.destroy();
            }
        },
        INTRODUCTIONTIMEOUT);
    }

    _introduceMyself(){
        var {pk,sk}=sodium.crypto_box_seed_keypair();
        this._decrypto_pk=pk;
        this._decrypto_sk=sk;
        var intro=this._packRequest({pk:pk},MessageType.introduce,0);
        this._sendMsg(intro)
        .then(()=>{
            this.__intro();
        })
        .catch(err=>{
            this._debug("cannot send introduction "+err);
            this.destroy();
        })
    }

    _onIntroduction(introEnvelope:MessageEnvelope){
        if (this.id!=null) {
            return this._abortPeer("received double introduction");
        }
        this.id=introEnvelope.a;
        this._debug.namespace=this._debug.namespace+" peer "+this.id.toString("hex").slice(0,6);
        this._debug("received introduction");
        this._encrypto_pk=introEnvelope.p.pk;
        this.__intro();
    }

    __intro(){
        this._introStatus--;
        if(this._introStatus==0){
            clearTimeout(this._timeout);
            this._debug("ready");
            this.emit('ready');
        }else if (this._introStatus<0){
            this._debug("duplicate introduction ");
            this.destroy();
        }
    }

    destroy(){
        this.removeAllListeners();
        this._debug("destroy");
        this.id=null;
    }

    async ping():Promise<boolean>{
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
     * @param dhtEntry ket value to store
     * @param k parameter
     * @returns 
     */

    async store(dhtEntry:DHTEntry,k:number):Promise<Peer[]|null>{
        this._debug("store...");
        await this._peerFactory.storage.ownKeyStore(
            this._peerFactory.id,
            dhtEntry.key,
            dhtEntry.value
        );
        var res=await this._requestToPeer({
            e:dhtEntry,
            k:k
        },MessageType.store);
        if (!res) return null;
        var r=await this._nodeids2peers(res.p.ids);
        this._debug("store done");
        return r;
    }

    async _onStore(storeEnvelope:MessageEnvelope,){
        this._debug("_onStore...");
        await this._peerFactory.storage.othersKeyStore(
            storeEnvelope.v,storeEnvelope.a,storeEnvelope.p.e.key,storeEnvelope.p.e.value,
            storeEnvelope.t,storeEnvelope.c,storeEnvelope.s)
        var ids=await this._onFindNodeInner(storeEnvelope.p.e.key,storeEnvelope.p.k)
        await this._replyToPeer({ids:ids},storeEnvelope);
        this._debug("_onStore done");
    }

    /**
     * 
     * @param key node is to find
     * @param k parameter
     * @returns 
     */

    async findNode(nodeId:Buffer,k:number):Promise<Peer[]|undefined>{
        var nodesMessage=await this._requestToPeer({
            n:nodeId,
            k:k
        },MessageType.findnode);
        if (!nodesMessage) return;
        var nodesIds:Buffer[]=nodesMessage.p.ids;
        return await this._nodeids2peers(nodesIds);
    }

    async _nodeids2peers(ids:Buffer[]):Promise<Peer[]>{
        var nodesIds:Buffer[]=ids;
        var r:Peer[]=[];
        for(var nodeid of nodesIds){
            if (Buffer.compare(nodeid,this._peerFactory.id)==0)
                continue;
            var p=this._peerFactory.findPeerById(nodeid)
            if (p)
                r.push(p);
            else{
                r.push(await this._signalConnect(nodeid));
            }
        }
        return r;
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
        var values=await this._peerFactory.storage.retreive(key,author,0);
        let ids=await this._onFindNodeInner(key,k);
        await this._replyToPeer({
            ids:ids,
            values:values
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
        var values=await this._peerFactory.storage.retreive(key,null,page);
        await this._replyToPeer({
            ids:ids,
            values:values,
        },findValueMessage);
    }

    _signalConnect(nodeid:Buffer):Promise<Peer>{
        this._debug("_signalConnect...");
        return new Promise((resolve,reject)=>{
            var simplePeer:SimplePeer.Instance|undefined;
            try{
                simplePeer=new SimplePeer({initiator: true, trickle: false, wrtc: wrtc as any });
                simplePeer.on('signal', async (data:any) => {
                    this._debug("_signalConnect signal...");
                    var signaldata=JSON.stringify(data)
                    if (!simplePeer) return this._debug("_signalConnect signal with no simplePeer defined");
                    const me=await this._requestToPeer({
                        p:nodeid, // node to connect
                        s:signaldata
                    },MessageType.signal)
                    if (!me || !me.p || !me.p.s) {
                        simplePeer.emit('error','did not receive signal data');
                        return; 
                    }
                    var signalEnvelope:MessageEnvelope=me.p.s;
                    if (!this._verifySignedMessageEnvelope(signalEnvelope) || !signalEnvelope.p || !signalEnvelope.p.s)
                    {
                        simplePeer.emit('error','receive invalid signal data');
                        return;
                    }
                    if (Buffer.compare(signalEnvelope.a,nodeid)){ // this is not from the node i am looki for....
                        simplePeer.emit("fake answer");
                        this._abortPeer("sent a fake signal data")
                        return;
                    }
                    simplePeer.signal(signalEnvelope.p.s);
                })
                simplePeer.on('connect',()=>{
                    this._debug("_signalConnect connect...");
                    if (!simplePeer) return this._debug("_signalConnect signal with no simplePeer defined");
                    var r=new VerySimplePeer(this._peerFactory,simplePeer);
                    r.on('ready',()=>{
                        if (r.id==null)
                            return reject("Node has no id!")
                        if (Buffer.compare(nodeid,r.id))
                            return reject("Did not receive the right node!");
                        this._debug("_signalConnect DONE...");
                        resolve(r);
                    })
                    r.on('error',reject)
                })
                simplePeer.on('error',(err:any)=>{
                    this._debug("_signalConnect error...");
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
        var peerToCall=this._peerFactory.findPeerById(signalEnvelope.p.p);
        if (peerToCall==null){
            return this._replyToPeer({},signalEnvelope); 
        }
        var signalback=await peerToCall._requestToPeer({
            s:signalEnvelope
        },MessageType.signalled);
        if (signalback==null){
            return this._replyToPeer({},signalEnvelope); 
        }
        await this._replyToPeer({s:signalback},signalEnvelope);
    }

    _onRequestSignalled(signalledEnvelope:MessageEnvelope):Promise<void>{
        return new Promise(async (resolve,reject)=>{
            try{
                if (!this._verifySignedMessageEnvelope(signalledEnvelope.p.s)){
                    reject (new Error("could not verify incoming signal"));
                    this._abortPeer("could not verify incoming signal");
                    return;
                }
                var nodeid:Buffer=signalledEnvelope.p.s.p.p;
                var inboundSignaldata:string=signalledEnvelope.p.s.p.s;
                var knownSimplePeer=this._peerFactory.findPeerById(nodeid)
                if (knownSimplePeer!=null){
                    // he does not know me, I know him...
                    console.log("That's weird!!!!!!")
                    return;
                }
                var simplePeer=new SimplePeer({trickle: false, wrtc: wrtc as any});
                simplePeer.on('signal',async (data:string)=>{
                    var signalData=JSON.stringify(data)
                    await this._replyToPeer({s:signalData},signalledEnvelope);
                });
                simplePeer.on('connect',()=>{
                    var r=new VerySimplePeer(this._peerFactory,simplePeer);
                    this._peerFactory.newPeer(r);
                    resolve();
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
        }
        await this._abortPeer("invalid message type");
    }

    _requestToPeer(request:any,messageType:MessageType):Promise<MessageEnvelope|null>{
        return new Promise(async (resolve,reject)=>{
            var timeout:any=null;
            if (this.id==null) return reject("not yet introduced");
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
                this.emit('error',"cannot contact peer")
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
            a:this.peerfactoryId(),
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
            a:this.peerfactoryId(),
            m:MessageType.reply,
            p:reply,
            t:Date.now(),
            c:requestEnvelope.c,
        }
        return this._packEnvelope(replyEnvelope);
    }

    _packEnvelope(envelope:MessageEnvelope):Buffer{
        var envelopeBuffer=encode(envelope);
        var requestSignature=this._peerFactory.sign(envelopeBuffer);
        var signedRequestBuffer=encode({m:envelopeBuffer,s:requestSignature});
        var signedBuffer=Buffer.from(signedRequestBuffer);
        var r:any;
        if (this._encrypto_pk)
            r={e:sodium.crypto_box_encrypt(signedBuffer,this._encrypto_pk)};
        else 
            r={c:signedBuffer};
        return encode(r);
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
        var b=encode(m);
        return this._peerFactory.verify(b,me.s,me.a);
    }

    _sendMsg(msg:Buffer):Promise<void>{
        this.emit("Abstract to be implemented in sub classes");
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
        this._introduceMyself();
    }

    _sendMsg(msg:Buffer):Promise<void>{ // override
        return new Promise((resolve,reject)=>{
            try{
                this._connection.sendBytes(msg,err=>{
                    if (err) 
                        reject(err);
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
                    resolve(r);
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
                        this.emit('peer',p);
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

    constructor(peerFactory:PeerFactory,simplePeer:SimplePeer.Instance){
        super(peerFactory);
        this._simplePeer=simplePeer;
        this._simplePeer.on('data',async (data:Buffer)=>{
            await this._onMsg(data);
        })
        this._introduceMyself();
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


export class PeerFactory extends EventEmitter{
    _secretKey:Buffer;
    id:Buffer;
    storage:IStorage;
    _kbucket:KBucket;
    _debug:Debug.Debugger;
    _peerWebsocketListener:PeerWebsocketListener[]=[];

    constructor(storage: IStorage,secretKey?:Buffer){
        super();
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
                    this._kbucket.remove(peer as any);
                    if (!added){
                        this._kbucket.add(aNewPeer);
                        added=true;
                        this._debug("ping replaced");
                    }
                }
            }
            this._debug("ping all replied");
        });
        this._kbucket.on('removed',peer=>{
            (peer as Peer).destroy();
        })
    }

    get kbucket():KBucket{
        return this._kbucket;
    }

    newPeer(peer:Peer):Promise<void>{
        return new Promise((resolve,reject)=>{
            const ready=()=>{
                if (peer.id==null){
                    console.log("peer.id null at ready event")
                    return;
                }
                this._kbucket.add(peer as any);
                this.emit('peer',peer);
                resolve();
            }
    
            peer.once('ready',ready);
            peer.on('error',(err)=>{
                this.removeListener('ready',ready);
                this._debug("Error by peer "+err);
                reject()
            })    
        })
    }

    findPeerById(id:Buffer):Peer|null{
        return this._kbucket.get(id) as any;
    }

    findClosestPeers(key:Buffer,k:number):Peer[]{
        return this._kbucket.closest(key,k) as any;
    }

    async createListener(port:number,host?:string):Promise<void>{
        var l=new PeerWebsocketListener(this);
        l.on('peer',(peer)=>{
            this.newPeer(peer);
        })
        await l.startup(port,host);
        this._peerWebsocketListener.push(l);
    }

    async createClient(port:number,host:string):Promise<void>{
        var peer= await PeerWebsocketClient.fromConnectionToServer(this,host+":"+port)
        await this.newPeer(peer);
    }

    sign(msg:Buffer):Buffer{
        return sodium.sign(msg, this._secretKey);
    }

    verify(msg:Buffer,signature:Buffer,author:Buffer):boolean{
        return sodium.verify(signature, msg, author);
    }

}

