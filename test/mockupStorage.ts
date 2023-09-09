

import { IStorage, MessageEnvelope } from "../peer.js";

const PAGESIZE=2;


export default class mockupStorage implements IStorage{

    _db:Map<string,MessageEnvelope[]>=new Map();

    constructor(){

    }

    async storeMessageEnvelope(me:MessageEnvelope){
        var d={
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

    async othersKeyStore(version:number, author:Buffer, key:Buffer, value:Buffer, timestamp:number,  counter:number, signature?:Buffer){
        var d={
            version,
            author,
            key,
            value,
            timestamp,
            counter,
            signature
        };
        this._innerStore(d);
    }

    async ownKeyStore(author:Buffer, key:Buffer, value:Buffer){
        var d={
            author,
            key,
            value,
            timestamp:Date.now()
        };
        this._innerStore(d);
    }

    _innerStore(d:any){
        var ks=d.key.toString('hex');
        var list=this._db.get(ks);
        if(!list){
            list=[];
            this._db.set(ks,list);
        }
        for(let i=0;i<list.length;i++){
            if (Buffer.compare(list[i].a,d.author)==0){
                list.splice(i,1);
                break;
            }
        }
        list.push(d);
        list.sort((a,b)=>{
            return b.t,a.t
        });        
    }

    async retreive(key: Buffer, author: Buffer | null, page: number){
        var ks=key.toString('hex');
        var list=this._db.get(ks);
        var r:MessageEnvelope[]=[];
        if (!list) return r;
        var i=0;
        var pc=page*PAGESIZE;
        for(var me of list){
            if (author && Buffer.compare(author,me.a))
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