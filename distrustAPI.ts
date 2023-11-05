import { EventEmitter } from "k-bucket";

import {encode,decode} from './encoder.js'

import {symmetric_encrypt,symmetric_decrypt,sha,crypto_secretbox_NONCEBYTES,randombytes} from './mysodium.js';
import {DisDHT,NODESIZE} from './disdht.js';
import {crypto_box_seed_keypair} from './mysodium.js';

import {DisDhtBtree,IBtreeNode} from './DisDhtBtree.js'
import {IStorage,Trust } from './IStorage.js'


import mime from "mime";

const VERSION=1;
const DISSCHEMA="dtp"

export interface IMediaStream{
    mime:string,
    stream:ReadableStream,
}

export interface IMediaNode{
    mime:string,
    node:Buffer,    
}

export interface IAccount{
    id:Buffer,
    secretKey:Buffer,
    timestamp:number,
    userId:string,
    tlBtreeRoot:Buffer|null,
    bio?:string;
    profilePic?:IMediaNode,
    headerPic?:IMediaNode,
    lastStatus:string
}

export interface IAccountUpdate{
    userId?:string,
    bio?:string;
    profileStream?:IMediaStream,
    headerStream?:IMediaStream,  
}

export enum TLType{
    updateAccount,
    post,
    encryptedPost,
    like,
    trust
}

export interface IMention{
    account:Buffer,
    ts:number,
}

export interface ITimelineEvent{
    version:number,
    type:TLType,
    ts:number,
}

export interface ITimelinePost extends ITimelineEvent{
    markdownText:string,
    quotedPost:IMention|null,
    replyTo:IMention|null,
    quotedAccounts:Buffer[]|null,
    media:IMediaNode[]|null
}

export enum Like{
    neutral=0,
    dislike=-1,
    like=1
}

export interface ITimelineLike extends ITimelineEvent{
    post:IMention,
    like:Like,
}



export interface ITimelineTrust extends ITimelineEvent{
    account:Buffer,
    trust:Trust,
}

export interface IAudience{

}

export default class DistrustAPI extends EventEmitter{
    _storage:IStorage;
    account:IAccount|null=null;
    _password:string="";
    _dht:DisDHT|null=null;
    _tlBtree:DisDhtBtree|null=null;

    constructor(storage:IStorage){
        super();
        this._storage=storage;
    }

    async createAccount(userId:string,password:string){
        if (this.account!=null) throw new Error("account opened");
        var {pk,sk}=crypto_box_seed_keypair();
        this.account={
            id:pk,
            secretKey:sk,
            userId:userId,
            timestamp:Date.now(),
            tlBtreeRoot:null,
            lastStatus:""
        }
        this._password=password;
        await this.saveAccount();
    }

    async exportAccount():Promise<Buffer>{
        if (this.account==null) throw new Error("account not opened");
        this.account.timestamp=Date.now();
        var accountBuffer=encode(this.account,NODESIZE);
        var nonce=sha(Buffer.from(this.account.userId)).subarray(0,crypto_secretbox_NONCEBYTES);
        var encryptedBuffer=symmetric_encrypt(accountBuffer,this._password,nonce);
        return encode(encryptedBuffer,NODESIZE);
    }

    async saveAccount(){
        if (this.account==null) throw new Error("account not opened");
        await this._storage.setAccount(this.account.userId,await this.exportAccount());
    }


    async importAccount(userId:string,encryptedAccountBuffer:Buffer,password:string):Promise<boolean>{
        try{
            var nonce=sha(Buffer.from(userId)).subarray(0,crypto_secretbox_NONCEBYTES);
            var accountBuffer=symmetric_decrypt(encryptedAccountBuffer,password,nonce);
            if (accountBuffer==null) return false;
            this.account=decode(accountBuffer);
            if (!this.account) throw new Error("cannot decode account");
            if (this.account.userId!=userId) throw new Error("mismatching userId");
            this._password=password;
            return true;
        }catch(err){
            this.account=null;
            this._password="";
            return false;
        }
    }

    async login(userId:string,password:string):Promise<boolean>{
        if (this.account==null) throw new Error("account not opened");
        try{
            var b=await this._storage.getAccount(userId);
            if (!b) return false;
            if (!await this.importAccount(userId,b,password)) return false;

            this._dht=new DisDHT({
                secretKey: this.account.secretKey,
                storage:this._storage
            })
            await this._dht.startUp();
            return true;
        }
        catch(err){
            this._dht=null
            return false;
        }
    }

    async logout():Promise<void>{
        if (this.account!=null) throw new Error("account opened");
        this.saveAccount();
        this.account=null;
        this._password="";
        if(this._dht){
            await this._dht.shutdown();
            this._dht=null;
        }
    }

    async changePassword(oldPassword:string,newPassword:string):Promise<boolean>{
        if (this.account==null) throw new Error("account not opened");
        if (oldPassword!=this._password) return false;
        this._password=newPassword;
        await this.saveAccount();
        return true;
    }

    async post(markdownText:string,
            quotedPost:IMention|null=null,
            replyTo:IMention|null=null,
            quotedAccounts:Buffer[]|null=null,
            media:IMediaStream[]|null=null):Promise<string>{
        if (this.account==null) throw new Error("account not opened");


        var mediaNodes:IMediaNode[]|null=null;

        if (media) {
            mediaNodes=[];
            for (let m of media){
                mediaNodes.push(await this._putMedia(m));
            }
        }

        var post:ITimelinePost={
            version:VERSION,
            type:TLType.post,
            ts:Date.now(),
            markdownText:markdownText,
            quotedPost:quotedPost,
            replyTo:replyTo,
            quotedAccounts:quotedAccounts,
            media:mediaNodes
        }

        var r=await this._post(post,markdownText);
        return r;
    }

    async _putMedia(media:IMediaStream):Promise<IMediaNode>{
        if (!this._dht) throw new Error();
        var n=await this._dht.putStream(media.stream);
        return {
            node:n, 
            mime:media.mime
        };
    }

    _loadMedia(image:IMediaNode):IMediaStream{
        if (!this._dht) throw new Error();
        var s=this._dht.getStream(image.node);
        return {
            stream:s,
            mime:image.mime
        };
    }

    async updateAccount(accountUpdate:IAccountUpdate){
        if (this.account==null) throw new Error("account not opened");
        if (accountUpdate.bio) this.account.bio=accountUpdate.bio;
        if (accountUpdate.userId) this.account.userId=accountUpdate.userId;
        if (accountUpdate.headerStream) {
            this.account.headerPic=await this._putMedia(accountUpdate.headerStream);
        };
        if (accountUpdate.profileStream){
            this.account.profilePic=await this._putMedia(accountUpdate.profileStream);
        }
        await this.saveAccount();
    }

    async trust(account:Buffer,trust:Trust=Trust.trust){
        if (this.account==null) throw new Error("account not opened");

        await this._storage.setTrust(account,trust);

        var post:ITimelineTrust={
            version:VERSION,
            type:TLType.trust,
            ts:Date.now(),
            account:account,
            trust:trust
        }
        return this._post(post);
    }

    async like(mention:IMention,like:Like=Like.like):Promise<string>{
        if (this.account==null) throw new Error("account not opened");

        var post:ITimelineLike={
            version:VERSION,
            type:TLType.like,
            ts:Date.now(),
            post:mention,
            like:like
        }
        return await this._post(post);    
    }

    async timeline(account:Buffer,emitevent:(tlevent:ITimelineEvent)=>Promise<boolean>):Promise<void>{
        if (this.account==null) throw new Error("account not opened");

    }

    async owntimeline(account:Buffer,emitevent:(tlevent:ITimelineEvent)=>Promise<boolean>):Promise<void>{
        if (this.account==null) throw new Error("account not opened");
        
    }

    protected async _post(tlevent:ITimelineEvent,lastStatus:string|null=null):Promise<string>{
        if (this.account==null) throw new Error("account not opened");
        if (!this._dht) throw new Error();
        this.account.tlBtreeRoot=await this._dht.btreePut(tlevent,this.account.tlBtreeRoot,tlBTreeCompare,tlBTreeGetIndex);
        if (lastStatus) this.account.lastStatus=lastStatus;
        await this.saveAccount();
        return this._packUrl(this.account.id,tlevent.ts);
    }

    protected _packUrl(account:Buffer,ts:number){
        return DISSCHEMA+"://"+account.toString('hex')+'/'+ts
    }
    

}


function tlBTreeCompare(a:ITimelineEvent,b:ITimelineEvent):number{
    return a.ts-b.ts;
}

function tlBTreeGetIndex(a:ITimelineEvent):number{
    return a.ts;
}
