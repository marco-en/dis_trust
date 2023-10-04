import {ISignedUserId,ISignedStorageEntry,ISignedStorageMerkleNode,TrustLevel,IStorage, IStorageEntry, ISetTrust,ISignedSetTrust } from '../IStorage.js'


import Debug from 'debug';

const PAGESIZE=2;

export default class mockupStorage implements IStorage{

    _db:Map<string,Map<string,ISignedStorageEntry>>=new Map();
    _merkle:Map<string,ISignedStorageMerkleNode>=new Map();
    _users:Map<string,ISignedUserId>=new Map();
    _trustLevelDb:Map<string,ISignedSetTrust>=new Map();
    _accounts:Map<string,Buffer>=new Map();


    _debug:Debug.Debugger;

    constructor(debug?:Debug.Debugger){
        this._debug=debug || Debug("mockupStorage");
    }

    async storeSignedEntry(sse:ISignedStorageEntry){
        this._debug(" mockupStorage.storeSignedEntry")
        var skey=sse.entry.key.toString('hex');
        var sauthor=sse.entry.author.toString('hex');
        var m=this._db.get(skey);
        if (!m) {
            m=new Map();
            this._db.set(skey,m);
        }
        m.set(sauthor,sse);
    }


    async retreiveAnyAuthor (key: Buffer, page: number) : Promise<ISignedStorageEntry[]>{
        this._debug(" mockupStorage.retreiveAnyAuthor")
        if (page<0) throw new Error("negative page");
        var skey=key.toString('hex');
        var m=this._db.get(skey);
        if(!m) return [];
        var s=page*PAGESIZE;
        var i=0;
        var r=[];
        for(let e of m.values()){
            if (s<=i){
                r.push(e);
                if (r.length==PAGESIZE)
                    break;
            }
            i++;
        }
        return r;
    }

    async retreiveAuthor (key: Buffer, author: Buffer) : Promise<ISignedStorageEntry|null>{
        this._debug(" mockupStorage.retreiveAuthor")
        var skey=key.toString('hex');
        var m=this._db.get(skey);
        if(!m) return null;
        var sauthor=author.toString('hex');
        var r=m.get(sauthor);
        return r?r:null;
    }


    async storeMerkleNode(snm:ISignedStorageMerkleNode){
        if (!snm) 
            throw new Error("invalid parameter");
        this._merkle.set(snm.entry.node.infoHash.toString('hex'),snm);
    }

    async getMerkleNode(infoHash:Buffer):Promise<ISignedStorageMerkleNode|undefined>{
        return this._merkle.get(infoHash.toString('hex'));
    }

   
    async setUserId (signeUserId:ISignedUserId):Promise<boolean>{
        var sh=signeUserId.entry.userHash.toString('hex');
        var pv=this._users.get(sh);
        if (pv){
            if (Buffer.compare(signeUserId.signature,pv.signature))
                return false; // try to change
            else
                return true; // same as before
        }
        this._users.set(sh,signeUserId);
        return true; // set first time
    }
    
    async getUserId(userHash:Buffer){
        var sh=userHash.toString('hex');
        return this._users.get(sh);
    }

    async setTrustRelationship(st:ISignedSetTrust){
        var sa=st.entry.author.toString('hex')+'-'+st.entry.who.toString('hex');
        this._trustLevelDb.set(sa,st);
    }

    async getTrustRelationship(author:Buffer,who:Buffer):Promise<ISignedSetTrust|null>{
        var sa=author.toString('hex')+'-'+who.toString('hex');
        var r=this._trustLevelDb.get(sa);
        if (!r) return null;
        return r;
    }  

    async getAccount(userId:string):Promise<Buffer|undefined>{
        return this._accounts.get(userId);
    }

    async setAccount(userId:string,encryptedBufferAccount:Buffer){
        this._accounts.set(userId,encryptedBufferAccount);
    }
}