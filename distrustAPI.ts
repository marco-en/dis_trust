import { EventEmitter } from "events";

import {encode,decode} from './encoder.js'

import {symmetric_encrypt,symmetric_decrypt,sha,crypto_secretbox_NONCEBYTES,randombytes} from './mysodium.js';
import {DisDHT,IDHTMessage,NODESIZE} from './disdht.js';
import {crypto_box_seed_keypair} from './mysodium.js';

import {DisDhtBtree} from './DisDhtBtree.js'
import {IStorage,Trust,ISignable } from './IStorage.js'
import { MAXMSGSIZE } from "./peer.js";

const VERSION=1;
const DISSCHEMA="dtp";
const LASTEVENTMAXSIZE=10;

export interface IMediaStream{
    mime:string,
    stream:ReadableStream,
}

export interface IMediaNode{
    mime:string,
    node:Buffer,    
}

export interface IAccount extends ISignable{
    id:Buffer,
    timestamp:number,
    secretKey:Buffer,
    userId:string,

    tlBtreeRoot:Buffer|null,

    relyOnAuthorsBtreeRoot:Buffer|null,
    trustedAuthorsBtreeRoot:Buffer|null,
    likesBtreeRoot:Buffer|null,

    bio:string;
    profilePic?:IMediaNode,
    headerPic?:IMediaNode,
    lastEvents:ITimelineEvent[];

    signature:Buffer|null;
}


interface IAccountTrustElement{
    id:Buffer,
    trust:Trust
}

function trustedBTcompare(a:IAccountTrustElement,b:IAccountTrustElement){
    return Buffer.compare(a.id,b.id);
}

function trustedBTgetIndex(a:IAccountTrustElement){
    return a.id;
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
    trust,
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

export enum LikeLevel{
    neutral=0,
    dislike=-1,
    like=1
}

interface Like{
    post:IMention,
    like:LikeLevel,
}


export interface ITimelineLike extends ITimelineEvent{
    like:Like,
}

export interface ITimelineTrust extends ITimelineEvent{
    trust:IAccountTrustElement
}

export interface IAccountUpdateEvent extends ITimelineEvent{
    update:IAccountUpdate;
}

function compareMention(a:IMention,b:IMention):number{
    var r=Buffer.compare(a.account,b.account);
    if (r) return r;
    return a.ts-b.ts;
}

function compareTL(a:ITimelineEvent,b:ITimelineEvent){
    return a.ts-b.ts;
}

function getIndexTL(e:ITimelineEvent){
    return e.ts;
}
function compareLike(a:Like,b:Like):number{
    return compareMention(a.post,b.post);
}

function getIndexLike(e:Like){
    return e.post;
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

    /**
     * 
     * @param userId creates a new account
     * @param password 
     */

    async createAccount(userId:string,password:string){
        if (this.account!=null) throw new Error("account opened");
        var {pk,sk}=crypto_box_seed_keypair();
        this.account={
            id:pk,
            secretKey:sk,
            userId:userId,
            timestamp:Date.now(),
            tlBtreeRoot:null,
            relyOnAuthorsBtreeRoot:null,
            trustedAuthorsBtreeRoot:null,
            likesBtreeRoot:null,
            lastEvents:[],
            bio:"",
            signature:null
        }
        this._password=password;
        await this.saveAccount();
    }

    /**
     * encrypt an account in a buffer based on the password
     * @returns encryted buffer
     */

    async exportAccount():Promise<Buffer>{
        if (this.account==null) throw new Error("account not opened");
        this.account.timestamp=Date.now();
        var accountBuffer=encode(this.account,NODESIZE);
        var nonce=sha(Buffer.from(this.account.userId)).subarray(0,crypto_secretbox_NONCEBYTES);
        var encryptedBuffer=symmetric_encrypt(accountBuffer,this._password,nonce);
        return encode(encryptedBuffer,NODESIZE);
    }

    /**
     * save the account in the storage
     */

    async saveAccount(){
        if (this.account==null || !this._dht) throw new Error("account not opened");
        this._dht.sign(this.account);
        await this._storage.setAccount(this.account.userId,await this.exportAccount());
    }

    /**
     * import an account from a buffer
     * @param userId 
     * @param encryptedAccountBuffer 
     * @param password 
     * @returns 
     */


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

    /**
     * login using account in local storage
     * @param userId 
     * @param password 
     * @returns 
     */

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
            this._dht.on("message",(msg:IDHTMessage)=>{
                this.onMessage(msg);
            });
            await this._dht.startUp();
            return true;
        }
        catch(err){
            this._dht=null
            return false;
        }
    }

    /**
     * save account in the local storage and logout 
     */

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

    /**
     * change password
     * @param oldPassword 
     * @param newPassword 
     * @returns successfull password change
     */

    async changePassword(oldPassword:string,newPassword:string):Promise<boolean>{
        if (this.account==null) throw new Error("account not opened");
        if (oldPassword!=this._password) return false;
        this._password=newPassword;
        await this.saveAccount();
        return true;
    }

    /**
     * new post in the timeline
     * @param markdownText text of the post
     * @param quotedPost quoted post, if any
     * @param replyTo reply to, if any
     * @param quotedAccounts quoted accounts, if any
     * @param media medias, if any
     * @returns 
     */

    async post(markdownText:string,
            quotedPost:IMention|null=null,
            replyTo:IMention|null=null,
            quotedAccounts:Buffer[]|null=null,
            media:IMediaStream[]|null=null):Promise<string>{
        if (this.account==null) throw new Error("account not opened");


        var mediaNodes:IMediaNode[]|null=null;

        if (media && media.length) {
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
            quotedPost:quotedPost?quotedPost:null,
            replyTo:replyTo?replyTo:null,
            quotedAccounts:(quotedAccounts&&quotedAccounts.length)?quotedAccounts:null,
            media:mediaNodes
        }

        var r=await this._post(post);
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

        var u:IAccountUpdateEvent={
            version:VERSION,
            type:TLType.post,
            ts:Date.now(),
            update:accountUpdate         
        }
        this._post(u);

    }

    async trust(account:Buffer,trust:Trust=Trust.trust){
        if (this.account==null || !this._dht) throw new Error("account not opened");

        await this._storage.setTrust(account,trust);

        var te:IAccountTrustElement={
            id:account,
            trust:trust
        }

        this.account.trustedAuthorsBtreeRoot=
            await this._dht.btreePut(te,this.account.trustedAuthorsBtreeRoot,trustedBTcompare,trustedBTgetIndex)

        var post:ITimelineTrust={
            version:VERSION,
            type:TLType.trust,
            ts:Date.now(),
            trust:te
        }
        return this._post(post);
    }

    async like(mention:IMention,likeLevel:LikeLevel=LikeLevel.like):Promise<string>{
        if (this.account==null || !this._dht) throw new Error("account not opened");

        var like:Like={
            post:mention,
            like:likeLevel
        }

        this.account.likesBtreeRoot=await this._dht.btreePut(like,this.account.likesBtreeRoot,compareLike,getIndexLike);

        var post:ITimelineLike={
            version:VERSION,
            type:TLType.like,
            ts:Date.now(),
            like:like
        }

        return await this._post(post);    
    }

    async owntimeline(emitevent:(tlevent:ITimelineEvent)=>Promise<boolean>):Promise<void>{
        if (this.account==null) throw new Error("account not opened");
        return await this.timeline(this.account.id,emitevent);
    }

    async timeline(account:Buffer,emitevent:(tlevent:ITimelineEvent)=>Promise<boolean>):Promise<void>{
        if (this.account==null || !this._dht) throw new Error("account not opened");
        var key=Date.now();
        await this._dht.btreeGet(key, this.account.tlBtreeRoot,compareTL,getIndexTL,emitevent)
    }

    protected async _post(tlevent:ITimelineEvent):Promise<string>{
        if (this.account==null) throw new Error("account not opened");
        if (!this._dht) throw new Error();
        this.account.tlBtreeRoot=await this._dht.btreePut(tlevent,this.account.tlBtreeRoot,tlBTreeCompare,tlBTreeGetIndex);
        this.account.lastEvents.unshift(tlevent);
        if (this.account.lastEvents.length>LASTEVENTMAXSIZE) this.account.lastEvents.pop();
        await this.saveAccount();
        await this.messageToEveryone();
        return this._packUrl(this.account.id,tlevent.ts);
    }

    protected _packUrl(account:Buffer,ts:number){
        return DISSCHEMA+"://"+account.toString('hex')+'/'+ts
    }

    private getMentioned():Buffer[]{
        if(!this.account) throw new Error();
        var smentioned=new Map<string,Buffer>();

        const addAccount=(account:Buffer|null)=>{
            if (!account) return;
            smentioned.set(account.toString('hex'),account);
        }

        const addAccounts=(accounts:Buffer[]|null)=>{
            if (!accounts) return;
            for(let account of accounts) addAccount(account);
        }  
        
        const addMention=(mention:IMention|null)=>{
            if (!mention) return;
            addAccount(mention.account);
        }

        const processPost=(ev:ITimelinePost)=>{
            addAccounts(ev.quotedAccounts);
            addMention(ev.quotedPost);
            addMention(ev.replyTo);
        }

        const processTrust=(ev:ITimelineTrust)=>{
            if (ev.trust.trust==Trust.distrust) return;
            addAccount(ev.trust.id)
        }

        for (var ev of this.account.lastEvents){
            switch(ev.type){
                case TLType.post:
                    processPost(ev as ITimelinePost)
                    break;
                case TLType.like:
                    addMention((ev as ITimelineLike).like.post);
                    break;
                case TLType.trust:
                    processTrust(ev as ITimelineTrust);
                    break;
            }
        }
        return Array.from(smentioned.values());
    }

    //inform who trusts me and who i mentioned
    protected async messageToEveryone(){
        if (!this.account) throw new Error();
        var accountBuffer=encode(this.account,MAXMSGSIZE);
        var mentions:Buffer[]=this.getMentioned();
        for (var mentioned of mentions){
            await this.messageOne(mentioned,accountBuffer);
        }
        if(this.account.relyOnAuthorsBtreeRoot)
            await this.multicast(this.account.relyOnAuthorsBtreeRoot,accountBuffer);
    }

    protected async messageOne(target:Buffer,msg:Buffer){
        if (!this._dht) throw new Error();
        await this._dht.sendMessage(target,msg);
    }

    protected async multicast(relayNode:Buffer,msg:Buffer){
        if (!this._dht) throw new Error();
        //await this._dht.multicast(relayNode,msg);

    }
    
    protected async onMessage(msg:IDHTMessage){

    }

}


function tlBTreeCompare(a:ITimelineEvent,b:ITimelineEvent):number{
    return a.ts-b.ts;
}

function tlBTreeGetIndex(a:ITimelineEvent):number{
    return a.ts;
}
