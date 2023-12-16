import { EventEmitter } from "events";
import Debug from 'debug';
import {encode,decode} from './encoder.js'

import {symmetric_encrypt,symmetric_decrypt,sha,crypto_secretbox_NONCEBYTES,randombytes} from './mysodium.js';
import {DisDHT,IDHTMessage,NODESIZE} from './disdht.js';
import {crypto_box_seed_keypair} from './mysodium.js';

import {IStorage,Trust,ISignable } from './IStorage.js'
import { MAXMSGSIZE } from "./peer.js";

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
    userId:string,
    timestamp:number,

    ownTimelineBTree:Buffer|null; // ITimelineEvent.ts 2 ITimelineEvent
    ownQuotationsBTree:Buffer|null;// {IQuotationTimelineEvent.who,IQuotationTimelineEvent.ev.ts} 2 IQuotationTimelineEvent
    timelineBTree:Buffer|null; // IReceivedTimelineEvent.receiveTS 2 IReceivedTimelineEvent
    followersBTree:Buffer|null; // IReceivedTimelineEvent.ev.account 2 IReceivedTimelineEvent

    bio:string,
    profilePic?:IMediaNode,
    headerPic?:IMediaNode,
}

export interface IOwnAccount{
    account:IAccount,
    secretKey:Buffer,
}

export enum TLType{
    updateAccount,
    post,
    like,
    trust,
}

export interface ITimelineEventKey{
    ts:number,
    accountId:Buffer,
}

export interface ITimelineEvent extends ITimelineEventKey,ISignable{
    type:TLType,
}

export interface IReceivedTimelineEvent extends ISignable {
    receiveTS:number,
    ev:ITimelineEvent
}

export interface IQuotationTimelineEvent extends ISignable{
    who:Buffer,
    ev:ITimelineEvent    
}

export interface ITimelinePostEvent extends ITimelineEvent{
    markdownText:string,
    quotedPost:ITimelineEventKey|null,
    replyTo:ITimelineEventKey|null,
    media:IMediaNode[]|null
    quotedAccounts:Buffer[]|null,
}

export interface ITrustEvent extends ITimelineEvent{
    who:Buffer,
    trust:Trust
}

export interface IAccountUpdateEvent extends ITimelineEvent{
    userId?:string,
    bio?:string;
    profileStream?:IMediaStream,
    headerStream?:IMediaStream,  
}

export enum Like{
    neutral=0,
    dislike=-1,
    like=1
}

interface ITimelineLikeEvent extends ITimelineEvent{
    what:ITimelineEventKey,
    like:Like,
}



export default class DistrustAPI extends EventEmitter{
    protected _storage:IStorage;
    protected _account:IAccount|null=null;
    protected _ownAccount:IOwnAccount|null=null;
    protected _password:string="";
    protected _dht:DisDHT|null=null;
    protected _debug=Debug("DistrustAPI");

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
        if (this._account!=null) throw new Error("account opened");
        var {pk,sk}=crypto_box_seed_keypair();
        this._account={
            id:pk,
            userId:userId,
            timestamp:Date.now(),

            ownTimelineBTree:null,
            ownQuotationsBTree:null,
            timelineBTree:null,
            followersBTree:null,
            
            bio:"",
            signature:null
        }
        this._ownAccount={
            account:this._account,
            secretKey:sk
        }
        this._password=password;
        await this.saveAccount();
    }


    /**
     * encrypt an account in a buffer based on the password
     * @returns encryted buffer
     */

    exportAccount():Buffer{
        if (!this._account || !this._ownAccount || !this._dht) throw new Error("account not opened");
        this._account.timestamp=Date.now();
        this._dht.sign(this._account);
        var ownAccountBuffer=encode(this._ownAccount,NODESIZE);
        var nonce=sha(Buffer.from(this._account.userId)).subarray(0,crypto_secretbox_NONCEBYTES);
        var r=symmetric_encrypt(ownAccountBuffer,this._password,nonce);
        return r;
    }


    /**
     * import an account from a buffer
     * @param userId 
     * @param encryptedAccountBuffer 
     * @param password 
     * @returns 
     */

    public async importAccount(userId:string,encryptedAccountBuffer:Buffer,password:string):Promise<boolean>{
        try{
            var nonce=sha(Buffer.from(userId)).subarray(0,crypto_secretbox_NONCEBYTES);
            var accountBuffer=symmetric_decrypt(encryptedAccountBuffer,password,nonce);
            if (accountBuffer==null) return false;
            this._ownAccount=decode(accountBuffer);
            if (!this._ownAccount) throw new Error();
            this._account=this._ownAccount.account;
            if (!this._account) throw new Error("cannot decode account");
            if (this._account.userId!=userId) throw new Error("mismatching userId");

            await this._initDHT();

            return this._dht?this._dht.verify(this._account,this._account.id):false;
        }catch(err){
            this._debug("cannto import importAccount %s",err)
            this._ownAccount=null;
            this._account=null;
            this._password="";
            return false;
        }
    }


    async saveAccount(){
        if (!this._account || !this._ownAccount || !this._password || !this._dht) throw new Error("account not opened");
        var ownAccountBuffer=this.exportAccount();
        await this._storage.setOwnAccount(this._account.userId,ownAccountBuffer);
        var accountBuffer=encode(this._account,MAXMSGSIZE);
        await this._dht.sendMessage(this._account.id,accountBuffer);
    }

    get id():Buffer {
        if (!this._account) throw Error();
        return this._account.id;
    }


    /**
     * login using account in local storage
     * @param userId 
     * @param password 
     * @returns 
     */

    async login(userId:string,password:string):Promise<boolean>{
        if (this._account || this._ownAccount) throw new Error("account already opened");
        try{
            var b=await this._storage.getOwnAccount(userId);
            if (!b) return false;
            if (!await this.importAccount(userId,b,password)) return false;
            if(this._ownAccount==null || this._account==null) throw new Error();

            await this._initDHT();
            return true;
        }
        catch(err){
            this._debug("error while login")
            this._dht=null
            this._account=null
            this._ownAccount=null;
            return false;
        }
    }

    protected async _initDHT(){
        this._dht=new DisDHT({
            secretKey: (this._ownAccount as IOwnAccount).secretKey,
            storage:this._storage
        })
        this._dht.on("message",(msg:IDHTMessage)=>{
            this.onMessage(msg);
        });
        if (Buffer.compare(this.id,this.id)) 
            throw new Error("Cannot open init DHT for mismatching ID");
        await this._dht.startUp();    
    }

    /**
     * save account in the local storage and logout 
     */

    async logout():Promise<void>{
        if (this._account && this._ownAccount) 
            await this.saveAccount();
        this._account=null;
        this._ownAccount=null;
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
        if (this._account==null) throw new Error("account not opened");
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
            quotedPost:ITimelineEventKey|null=null,
            replyTo:ITimelineEventKey|null=null,
            quotedAccounts:Buffer[]|null=null,
            media:IMediaStream[]|null=null):Promise<void>{
        if (this._account==null) throw new Error("account not opened");

        var mediaNodes:IMediaNode[]|null=null;

        if (media && media.length) {
            mediaNodes=[];
            for (let m of media){
                mediaNodes.push(await this._putMedia(m));
            }
        }

        var post:ITimelinePostEvent={
            accountId:this.id,
            type:TLType.post,
            ts:Date.now(),
            markdownText:markdownText,
            quotedPost:quotedPost,
            media:mediaNodes,
            replyTo:replyTo,
            quotedAccounts:quotedAccounts,
            signature:null
        }

        var quoted=[];
        if (quotedPost) quoted.push(quotedPost.accountId);
        if (replyTo) quoted.push(replyTo.accountId);
        if (quotedAccounts) quoted=quoted.concat(quotedAccounts);

        await this._post(post,quoted);
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

    async updateAccount(accountUpdate:IAccountUpdateEvent){
        if (this._account==null) throw new Error("account not opened");
        if (accountUpdate.bio) this._account.bio=accountUpdate.bio;
        if (accountUpdate.userId) this._account.userId=accountUpdate.userId;
        if (accountUpdate.headerStream) {
            this._account.headerPic=await this._putMedia(accountUpdate.headerStream);
        };
        if (accountUpdate.profileStream){
            this._account.profilePic=await this._putMedia(accountUpdate.profileStream);
        }

        var u:IAccountUpdateEvent={
            accountId:this.id,
            type:TLType.updateAccount,
            ts:Date.now(),
            signature:null       
        }
        await this._post(u,[]);
    }

    async trust(who:Buffer,trust:Trust=Trust.follow){
        if (!this._account || !this._dht) throw new Error("account not opened");

        await this._storage.setTrust(who,trust);

        var te:ITrustEvent={
            accountId:this.id,
            who:who,
            type:TLType.trust,
            ts:Date.now(),
            trust:trust,
            signature:null
        }

        await this._post(te,[who]);
    }

    async like(what:ITimelineEventKey,like:Like.like){
        if (this._account==null || !this._dht) throw new Error("account not opened");

        var likeEvent:ITimelineLikeEvent={
            accountId:this.id,
            what:what,
            type:TLType.like,
            ts:Date.now(),
            like:like,
            signature:null
        }

        await this._post(likeEvent,[what.accountId]);    
    }


    protected async _post(tlevent:ITimelineEvent,quotedAccounts:Buffer[]):Promise<void>{
        if (!this._account || !this._dht) throw new Error("account not opened");
        this._dht.sign(tlevent);
        this._account.ownTimelineBTree = await this._dht.btreePut(tlevent,this._account.ownTimelineBTree,tlBTreeCompare,tlBTreeGetIndex);
        deduplicateAccounts(quotedAccounts);
        for(let quoted of quotedAccounts){
            let qte:IQuotationTimelineEvent={
                who:quoted,
                ev:tlevent,
                signature:null
            }
            this._dht.sign(qte);
            this._account.ownQuotationsBTree = await this._dht.btreePut(qte,this._account.ownQuotationsBTree,quotetlBTreeCompare,quotetlBTreeGetIndex)
        }
        await this.saveAccount();
        await this.messageToEveryone(quotedAccounts);
    }

    protected _packUrl(account:Buffer,ts:number){
        return DISSCHEMA+"://"+account.toString('hex')+'/'+ts
    }

    //inform who trusts me and who i mentioned
    protected async messageToEveryone(quotedAccounts:Buffer[]){
        if (!this._account || !this._dht) throw new Error("account not opened");

        let accountBuffer=encode(this._account,MAXMSGSIZE);

        for (var quoted of quotedAccounts){
            await this._dht.sendMessage(quoted,accountBuffer);
        }


        if (this._account.followersBTree){
            await this._dht.cascadeToFollowers(this._account.followersBTree,accountBuffer,followercCompare,followerGetIndex);
        }

    }

    protected async addFollower(fe:ITrustEvent){
        if (!this._dht || ! this._account) throw new Error();
        if (Buffer.compare(fe.who,this.id)) return;
        if (fe.trust!=Trust.follow) return;
        this._account.followersBTree=await this._dht.btreePut(fe,this._account.followersBTree,followercCompare,followerGetIndex)
        this.saveAccount();
    }
    

    protected async onMessage(msg:IDHTMessage){
        if (!this._dht || !this._account) 
            return;
        var acc:IAccount=decode(msg.content);
        if (!this._dht.verify(acc,acc.id))
            return;   
        if (Buffer.compare(acc.id,this.id)==0){
            await this.ownAccountReceived(acc);
        }
        else{
            await this.otherAccountReceived(acc)
        }
    }

    protected async ownAccountReceived(acc:IAccount){
        if (!this._dht || !this._account) 
            return;
        if (acc.timestamp<=this._account.timestamp)
            return;
        this._account=acc;
        await this.saveAccount();
    }

    protected async otherAccountReceived(acc:IAccount){
        if (!this._dht || !this._account) 
            return;
        if (await this.doIFollow(acc.id)){
            await this.readTimeline(acc);
        }else{
            await this.readQuotes(acc);           
        }
    }

    protected async doIFollow(accountId:Buffer):Promise<boolean>{
        return true; //TODO
    }

    protected async readTimeline(acc:IAccount){
        //TODO
    }

    protected async readQuotes(acc:IAccount){
        //TODO
    }


}

function followercCompare(a:ITrustEvent,b:ITrustEvent):number{
    return Buffer.compare(a.accountId,b.accountId);
}

function followerGetIndex(a:ITrustEvent):any{
    return a.accountId;
}

function tlBTreeCompare(a:ITimelineEvent,b:ITimelineEvent):number{
    return a.ts-b.ts;
}

function tlBTreeGetIndex(a:ITimelineEvent):number{
    return a.ts;
}

function quotetlBTreeCompare(a:IQuotationTimelineEvent,b:IQuotationTimelineEvent):number{
    let r=Buffer.compare(a.who,b.who);
    if(r) return r;
    return a.ev.ts-b.ev.ts;
}

function quotetlBTreeGetIndex(a:IQuotationTimelineEvent):any{
    return {
        who:a.who,
        ev:{
            ts:a.ev.ts
        }
    }
}

function deduplicateAccounts(accs:Buffer []){
    for (let i=0;i<accs.length-1;i++){
        for(let j=0;i<accs.length;){
            if (Buffer.compare(accs[i],accs[j])==0)
                accs.splice(j,1);
            else 
                j++;
        }
    }
}
