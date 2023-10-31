import {Level} from 'level';
import {ISignedUserId,ISignedStorageEntry,ISignedStorageMerkleNode,TrustLevel,IStorage,ISignedSetTrust,ISignedStorageBtreeNode } from './IStorage.js'
import {encode,decode} from './encoder.js'

const PAGESIZE=2;

const BUFFER_ENCODING={ keyEncoding: 'buffer', valueEncoding: 'buffer'};

export default class Storage implements IStorage{
    _level:any;
    _sse: any;
    _merkle:any;
    _users:any;
    _accounts:any;
    _trust:any;
    _btnodes:any
    _maxvaluesize:number;

    constructor(location:string,maxvaluesize:number){
        this._maxvaluesize=maxvaluesize;
        this._level=new Level(location);
        this._sse     =this._level.sublevel('e',BUFFER_ENCODING);
        this._merkle  =this._level.sublevel('m',BUFFER_ENCODING);
        this._users   =this._level.sublevel('u',BUFFER_ENCODING);
        this._accounts=this._level.sublevel('a',BUFFER_ENCODING);
        this._trust   =this._level.sublevel('t',BUFFER_ENCODING);
        this._btnodes =this._level.sublevel('n',BUFFER_ENCODING);
    }

    async storeSignedEntry(sse:ISignedStorageEntry){
        var skey=sse.entry.key.toString('hex');
        var keysub=this._sse.sublevel(skey,BUFFER_ENCODING);
        var sauthor=sse.entry.author;
        await keysub.put(sauthor,encode(sse,this._maxvaluesize));
    }

    async retreiveAuthor (key: Buffer, author: Buffer) : Promise<ISignedStorageEntry|null>{
        var skey=key.toString('hex');
        var keysub=this._sse.sublevel(skey,BUFFER_ENCODING);
        try{
            var b=await keysub.get(author);
            return decode(b) as ISignedStorageEntry;
        }catch(err){
            return null;
        }
    }

    async retreiveAnyAuthor (key: Buffer, page: number) : Promise<ISignedStorageEntry[]>{
        var skey=key.toString('hex');
        var keysub=this._sse.sublevel(skey,BUFFER_ENCODING);
        var r:ISignedStorageEntry[]=[];
        var cnt=0;
        for await (const v of keysub.values()){
            if (cnt<page*PAGESIZE) continue;
            r.push(decode(v));
            if (r.length==PAGESIZE) break;
        }
        return r;
    }

    async storeMerkleNode(snm:ISignedStorageMerkleNode){
        await this._merkle.put(snm.entry.node.infoHash,encode(snm,this._maxvaluesize));
    }

    async getMerkleNode(infoHash:Buffer):Promise<ISignedStorageMerkleNode|undefined>{
        try{
            var r=await this._merkle.get(infoHash);
            return decode(r);
        }catch(err){
            return;
        }
    }

    async setUserId (signedUserId:ISignedUserId):Promise<boolean>{
        var pv:ISignedUserId|undefined;
        try{
            pv=decode(await this._users.get(signedUserId.entry.userHash));
        }catch(err){
        }
        if (pv){
            if (signedUserId.entry.userId!=pv.entry.userId){
                return false; // same has, different user ID. theorically almost impossible
            }
            if (Buffer.compare(signedUserId.entry.author,pv.entry.author)==0){
                return true; // same author
            }
            //different author. 
            if (signedUserId.entry.timestamp>pv.entry.timestamp)
                return false; // different author but it is newer
        }
        await this._users.put(signedUserId.entry.userHash,encode(signedUserId,this._maxvaluesize));
        return true; // set first time        
    }

    async getUserId(userHash:Buffer):Promise<ISignedUserId|undefined>{
        try{
            var r=await this._users.get(userHash);
            return decode(r);
        }catch(err){
            return;
        }
    }

    async getAccount(userId:string):Promise<Buffer|undefined>{
        try{
            return await this._accounts.get(userId);
        }catch(err){
            return;
        }
    }

    async setAccount(userId:string,encryptedBufferAccount:Buffer){
        await this._accounts.put(userId,encryptedBufferAccount);
    }  
    
    async setTrustRelationship(st:ISignedSetTrust){
        var x=Buffer.concat([st.entry.author,st.entry.who]);
        await this._trust.set(x,encode(st,this._maxvaluesize));
    }

    async getTrustRelationship(author:Buffer,who:Buffer):Promise<ISignedSetTrust|null>{
        var x=Buffer.concat([author,who]);
        try{
            var b=await this._trust.get(x);
            return decode(b);
        }catch(err){
            return null;
        }
    }

    async storeBTreeNode(sbtn:ISignedStorageBtreeNode):Promise<void>{
        await this._btnodes.put(sbtn.entry.node.hash,encode(sbtn,this._maxvaluesize));
    }

    async getBTreeNode(infoHash:Buffer):Promise<ISignedStorageBtreeNode|undefined>{
        try{
            var b=await this._btnodes.get(infoHash);
            var r=decode(b);
            return r;
        }catch(err){
            return;
        }
    }

}
