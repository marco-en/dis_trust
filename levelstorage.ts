import Level from 'level';
import {ISignedUserId,ISignedStorageEntry,Trust,IStorage, ISignedBuffer } from './IStorage'
import {encode,decode} from './encoder'
import Semaphore from './semaphore';

const BUFFER_ENCODING={ keyEncoding: 'buffer', valueEncoding: 'buffer'};

function ts2BigIntString(num:number){
    var r=Buffer.alloc(8);
    r.writeBigInt64BE(BigInt(99999999999999-num));
    return r;
}

export default class Storage implements IStorage{
    _level:any;
    _ts2sse:any;
    _ka2sse:any;
    _users:any;
    _accounts:any;
    _trust:any;
    _maxvaluesize:number;
    _author2ts:any;
    _buffers:any;

    private semaphore:Semaphore;

    constructor(location:string,maxvaluesize:number){
        this._maxvaluesize=maxvaluesize;

        this._level = new Level.Level(location);
        
        this._ka2sse    =this._level.sublevel('1',BUFFER_ENCODING);
        this._ts2sse    =this._level.sublevel('2',BUFFER_ENCODING);
        this._users     =this._level.sublevel('3',BUFFER_ENCODING);
        this._accounts  =this._level.sublevel('4',BUFFER_ENCODING);
        this._trust     =this._level.sublevel('5',BUFFER_ENCODING);
        this._author2ts =this._level.sublevel('6',BUFFER_ENCODING);
        this._buffers   =this._level.sublevel('7',BUFFER_ENCODING);

        this.semaphore = new Semaphore(1);
    }


    async close(){
        await this._level.close();


    }

    async deleteDatabase(){
        await this._level.clear();
    }

    async storeSignedEntry(sse:ISignedStorageEntry){
        var key=sse.entry.key;
        var author=sse.entry.author;
        await this.deleteAuthor(key,author);

        var skey=key.toString('hex');
        var sa=this._ka2sse.sublevel(skey,BUFFER_ENCODING);
        var st=this._ts2sse.sublevel(skey,BUFFER_ENCODING);

        var ts=Date.now();
        var tsbus=ts2BigIntString(ts);

        var v={
            s:sse,
            t:tsbus
        }
        try{
            await this.semaphore.dec();
            let b=encode(v,this._maxvaluesize);
            await sa.put(author,b);
            await st.put(tsbus,author);
        }catch(err){
            console.log("Error while writing entry");
            console.log(err);
            throw(err);
        }finally{
            this.semaphore.inc();
        }

    }

    async deleteAuthor(key: Buffer, author: Buffer){
        var skey=key.toString('hex');
        var sa=this._ka2sse.sublevel(skey,BUFFER_ENCODING);
        var st=this._ts2sse.sublevel(skey,BUFFER_ENCODING);

        try{
            var bufau=await sa.get(author);
            var v=decode(bufau);

            try{
                await this.semaphore.dec();
                await st.del(v.t);
                await sa.del(author);  
            }finally{
                this.semaphore.inc();
            }
    

        }catch(err){}
    }

    async retreiveAnyAuthor (key: Buffer,tsGt:number, maxNumRecords:number ) : Promise<ISignedStorageEntry[]>{
        var skey=key.toString('hex');
        var sa=this._ka2sse.sublevel(skey,BUFFER_ENCODING);
        var st=this._ts2sse.sublevel(skey,BUFFER_ENCODING);

        var tsbus=ts2BigIntString(tsGt);

        var option:any={
            limit:maxNumRecords,
            gt:tsbus
        };
        option={}; //for testing

        var r:ISignedStorageEntry[]=[];

        try{
            await this.semaphore.dec();
            for await(let author of st.values(option)){
                let v;
                try{
                    v=await sa.get(author);
                }catch(e){}
                if (v) {
                    let vd=decode(v);
                    r.push(vd.s);
                }
                else
                    console.log("retreiveAnyAuthor not found");
            }
        }finally{
            this.semaphore.inc();
        }
        return r;
    }

    async retreiveAuthor (key: Buffer, author: Buffer) : Promise<ISignedStorageEntry|null>{
        var skey=key.toString('hex');
        var sa=this._ka2sse.sublevel(skey,BUFFER_ENCODING);
        var b;
        try{   
            b=await sa.get(author);
        }catch(err){
            return null;
        }
        var r=decode(b);
        return r.s;
    }



    async storeBuffer(isb: ISignedBuffer):Promise<void>{
        await this._buffers.put(isb.infoHash,encode(isb,this._maxvaluesize));
    }

    async retreiveBuffer(infoHash: Buffer):Promise<ISignedBuffer | null>{
        try{
            var r=await this._buffers.get(infoHash);
            return decode(r);
        }catch(err){
            return null;
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
    

    async setTrust (object: Buffer, trust: Trust) {
        if (trust==Trust.neutral){
            try{
                await this._trust.del(object);
            }catch(err) {}
        }else{
            await this._trust.put(object,trust);
        }
    }

    async getTrust ( object: Buffer) {
        try{
            return await this._trust.get(object);
        }catch(err){
            return Trust.neutral
        }       
    }


    async isNewMark(author:Buffer,ts:number):Promise<boolean>{
        var tf=0;
        try{
            tf=await this._author2ts.get(author);
        }catch(err){}
        if (ts<=tf) 
            return false;
        await this._author2ts.put(author,ts);
        return true;
    }
}
