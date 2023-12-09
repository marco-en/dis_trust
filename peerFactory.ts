import {EventEmitter} from 'events';
import * as sodium from './mysodium';
import Debug from 'debug';
import {IStorage,IStorageEntry,ISignedBuffer,IUserId,ISignable } from './IStorage.js'
import KBucket from 'k-bucket';
import {MeAsPeer,PeerWebsocket,BasePeer,PeerWebsocketClient,VERSION,MAXMSGSIZE,checkUserName} from './peer';
import {encode} from './encoder';


import http from 'http';
import WebSocket from 'websocket';

const KBUCKETSIZE=20;

const EMPTYBUFFER=Buffer.alloc(0);


export function userIdHash(userId:string):Buffer{
    if (!checkUserName(userId)) throw new RangeError();
    return sodium.sha(Buffer.from(userId.toLowerCase()))
}

class PeerWebsocketServer extends PeerWebsocket{
    constructor(peerFactory:PeerFactory, connection:WebSocket.connection){
        super(peerFactory,connection);
    }
}

class PeerWebsocketListener extends EventEmitter{
    protected _peerFactory:PeerFactory|null;
    protected _port:number=0;
    protected _host?:string;
    protected  _httpServer:http.Server|null=null;
    protected _webSocket:WebSocket.server|null=null;

    constructor(peerFactory:PeerFactory){
        super();
        this._peerFactory=peerFactory;
    }

    shutdown():Promise<void>{
        return new Promise((resolve,reject)=>{
            if (this._webSocket){
                this._webSocket.shutDown();
                this._webSocket=null
            }

            if (this._httpServer){
                this._httpServer.close(err=>{
                    if (err) return reject(err);
                    resolve();
                });
                this._httpServer.closeAllConnections();
                this._httpServer=null;
            };
            this._peerFactory=null;
        })
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
                        if (this._peerFactory==null) return reject("Shutdown");
                        var p=new PeerWebsocketServer(this._peerFactory,connection);
                        p.startUp()
                        .catch(err=>{
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



export class PeerFactory extends EventEmitter{
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

    async shutdown():Promise<void>{

        const sd=async (cnt:any) => { 
            let peer:BasePeer=cnt;
            try{
                await peer.shutdown();
            }catch(err){}
        }

        for (let cnt of this._kbucket.toArray()){
            await sd(cnt);
        }

        for (let cnt of this._outofbucket.values()){
            await sd(cnt);
        }  

        for(let l of this._peerWebsocketListener){
            await l.shutdown();
        }
    }


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

    newPeer(peer:BasePeer):void{
        this._debug("newPeer %s",peer.nickName);
        this._kbucket.add(peer as any);

        peer.on('error',(err)=>{
            this._debug("Error by peer "+err);
        })    
    }

    destryedPeer(peer:BasePeer):void{
        this._kbucket.removeAllListeners('removed');
        this._kbucket.remove(peer.id);
        this._outofbucket.delete(peer.idString);
    }

    findPeerById(id:Buffer):BasePeer|null{
        if (Buffer.compare(id,this.id)==0) return this.MyselfPeer;
        var r:BasePeer|null|undefined=this._kbucket.get(id) as any;
        if (r) return r;
        r=this._outofbucket.get(id.toString('hex'));
        return r?r:null;
    }

    findClosestPeers(key:Buffer,k:number):BasePeer[]{
        if (!k) return [];
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

    writeSignature(thing:ISignable):void{
        thing.signature=null;
        thing.signature=this.sign(encode(thing,MAXMSGSIZE));
    }

    verifySignature(thing:ISignable,author:Buffer):boolean{
        if (!thing.signature) return false;
        if (!(thing.signature instanceof Buffer)) return false; 
        var signature=thing.signature;
        thing.signature=null;
        var r=this.verify(encode(thing,MAXMSGSIZE),signature,author);
        thing.signature=signature;
        return r;
    }

    createStorageEntry(key:Buffer,value:Buffer):IStorageEntry{
        var r:IStorageEntry={
            author:this.id,
            key:key,
            value:value,
            timestamp:Date.now(),
            version:VERSION, 
            signature:null           
        }
        this.writeSignature(r);
        return r;
    }

    verifyStorageEntry(signedentry:IStorageEntry):boolean{
        return this.verifySignature(signedentry,signedentry.author);
    }

    createSignedBuffer(buffer:Buffer):ISignedBuffer{
        var infoHash=sodium.sha(buffer);
        var r:ISignedBuffer={
            author:this.id,
            timestamp:Date.now(),
            version:VERSION, 
            infoHash:infoHash,
            data:buffer,
            signature:null
        }       
        this.writeSignature(r);
        return r;
    }

    verifySignedBuffer(isb:ISignedBuffer):boolean{
        var ia=sodium.sha(isb.data);
        if (Buffer.compare(ia,isb.infoHash)) return false;
        var sig=isb.signature;
        return this.verifySignature(isb,isb.author);
    }

    createSignedUserName(userId:string):IUserId{
        var r:IUserId={
            userId:userId.toLowerCase(),
            userHash:userIdHash(userId),
            author:this.id,
            timestamp:Date.now(),
            version:VERSION,
            signature:null
        }
        this.writeSignature(r);
        return r;
    }

    verifySignedUserName(signed:IUserId):boolean{
        var userId=signed.userId;
        if (!checkUserName(userId)) 
            return false;
        if (Buffer.compare(signed.userHash,sodium.sha(Buffer.from(userId))))
            return false;
        return this.verifySignature(signed,signed.author);
    }

    onReceivedMessage(signedentry:IStorageEntry){
        if (Buffer.compare(signedentry.key,this.id)) 
            return;
        this.emit("message",signedentry);
    }

    
}

