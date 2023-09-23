

import { IStorage, ISignedStorageEntry,ISignedStorageMerkleNode } from "../peer.js";
import Debug from 'debug';

const PAGESIZE=2;

export default class mockupStorage implements IStorage{

    _db:Map<string,Map<string,ISignedStorageEntry>>=new Map();
    _merkle:Map<string,ISignedStorageMerkleNode>=new Map();
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

    
}