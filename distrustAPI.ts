import { EventEmitter } from "k-bucket";

import {encode,decode} from './encoder.js'

import {symmetric_encrypt,symmetric_decrypt,sha,crypto_secretbox_NONCEBYTES,randombytes} from './mysodium.js';
import {DisDHT,NODESIZE} from './disdht.js';
import {crypto_box_seed_keypair} from './mysodium.js';

import {IStorage } from './IStorage.js'


import mime from "mime";


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
    timelineHead?:Buffer,
    bio?:string;
    profilePic?:IMediaNode,
    headerPic?:IMediaNode,
}

export interface IAccountUpdate{
    userId?:string,
    bio?:string;
    profileStream?:IMediaStream,
    headerStream?:IMediaStream,  
}

export interface IAudience{

}

export enum TLType{
    updateAccount,
    post,
    encryptedPost,
    like,
    dislike,
    trust,
    distrust,
    undo,
}

export interface ITimelineEvent{
    type:TLType,
    account:IAccount

}


export default class DistrustAPI extends EventEmitter{
    _storage:IStorage;
    account:IAccount|null=null;
    _password:string="";
    _dht:DisDHT|null=null;

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
            quotedPost:Buffer|null=null,
            quotedAccounts:Buffer[]|null=null,
            media:IMediaStream[]|null=null,
            audience:IAudience|null=null):Promise<Buffer>{
        if (this.account==null) throw new Error("account not opened");
        throw new Error("TODO");  
    }

    async _putMedia(media:IMediaStream):Promise<IMediaNode>{
        if (!this._dht) throw new Error();
        var n=await this._dht.putStream(media.stream);
        return {
            node:n, 
            mime:media.mime
        };
    }

    _loadImage(image:IMediaNode):IMediaStream{
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

    async trust(account:Buffer){
        if (this.account==null) throw new Error("account not opened");

    }

    async distrust(account:Buffer){
        if (this.account==null) throw new Error("account not opened");

    }

    async like(account:Buffer){
        if (this.account==null) throw new Error("account not opened");

    }

    async dislike(account:Buffer){
        if (this.account==null) throw new Error("account not opened");

    }

    async timeline(account:Buffer,emitevent:(tlevent:ITimelineEvent)=>Promise<boolean>):Promise<void>{
        if (this.account==null) throw new Error("account not opened");

    }

    async owntimeline(account:Buffer,emitevent:(tlevent:ITimelineEvent)=>Promise<boolean>):Promise<void>{
        if (this.account==null) throw new Error("account not opened");
        
    }

}