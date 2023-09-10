

import { IStorage, IStorageValue, MessageEnvelope } from "../peer.js";

const PAGESIZE=2;





export default class mockupStorage implements IStorage{

    _db:Map<string,IStorageValue[]>=new Map();

    constructor(){

    }

    async storeMessageEnvelope(me:MessageEnvelope){
        var d:IStorageValue={
            version:me.v,
            author:me.a,
            key:me.p.key,
            value:me.p.value,
            timestamp:me.t,
            counter:me.t,
            signature:me.s
        };
        this._innerStore(d);        
    }

    async ownKeyStore(author:Buffer, key:Buffer, value:Buffer){
        var d:IStorageValue={
            author:author,
            key:key,
            value:value,
            timestamp:Date.now()
        };
        this._innerStore(d);
    }

    _innerStore(d:IStorageValue){
        var ks=d.key.toString('hex');
        var list=this._db.get(ks);
        if(!list){
            list=[];
            this._db.set(ks,list);
        }
        for(let i=0;i<list.length;i++){
            if (Buffer.compare(list[i].author,d.author)==0){
                list.splice(i,1);
                break;
            }
        }
        list.push(d);
        list.sort((a,b)=>{
            if (a.timestamp===undefined) return -1;
            if (b.timestamp===undefined) return 1;
            return (a.timestamp as number) - (b.timestamp as number);
        });        
    }

    async retreiveAnyAuthor (key: Buffer, page: number) : Promise<IStorageValue[]>{
        return this._retreive(key,null,page);
    }

    async retreiveAuthor (key: Buffer, author: Buffer) : Promise<IStorageValue|null>{
        var v=await this._retreive(key,author,0);
        return v?v[0]:null;
    }

    async _retreive(key: Buffer, author: Buffer | null, page: number):Promise<IStorageValue[]>{
        var ks=key.toString('hex');
        var list=this._db.get(ks);
        var r:IStorageValue[]=[];
        if (!list) return r;
        var i=0;
        var pc=page*PAGESIZE;
        for(var me of list){
            if (author && Buffer.compare(author,me.author))
                continue;
            if (i>=pc)
                r.push(me);
            if (r.length==PAGESIZE)
                break;
            i++;
        }
        return r;
    };
}