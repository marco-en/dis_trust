import { DisDHT } from "../disdht";
import Storage from "../levelstorage";
import fs from "node:fs/promises";
import * as sodium from '../mysodium';
import {encode,decode} from '../encoder';
import Debug from 'debug';
import {ISignedStorageEntry} from '../IStorage';
import { DisDhtBtree } from "../DisDhtBtree";
import Path from 'node:path';

const MAXMSGSIZE=1024*1024;
console.log("Hello");
//Debug.enable("*");

let keys:any=null;


function onMessage(name:string,dht:DisDHT,sse:ISignedStorageEntry){
    if (Buffer.compare(dht.id,sse.entry.key)) 
        console.log("%s.on message WRONG KEY",name);

    var content=decode(sse.entry.value);

    console.log("%s.on message: %s %o",name,sse.entry.author.toString("hex").slice(0,6),content)
}

async function initDHT(name:string,keynum:number,port:number=0,seed?:any):Promise<DisDHT> {
    if (!keys)
        keys=JSON.parse(await fs.readFile("test/testkeys.json",{encoding:'utf-8'}));

    console.log('starting up %s....',name);

    var dbPath=Path.resolve('testdata',name);
    var storage=new Storage(dbPath,MAXMSGSIZE);
    let sk=Buffer.from(keys[keynum].sk,'hex');

    await storage.deleteDatabase();

    var opt:any={
        secretKey:sk,
        storage:storage,
    }
    if (port) opt.servers = [ {port:port} ];
    if (seed) opt.seed = seed;

    let dht=new DisDHT(opt); 

    dht.on('message',(sse:ISignedStorageEntry)=>{
        onMessage(name,dht,sse);
    })
    await dht.startUp();
    console.log('started up %s',name);

    return dht;
}

async function fn(){
    let dhtseed=await initDHT('dhtseed',1,54320);
    let dht=await initDHT('dht',2,0,[{host:'localhost',port:54320}]);
    let dht2=await initDHT('dht2',3,0,[{host:'localhost',port:54320}]);

    var msg:any="ciao bel messaggio";

    await dht.sendMessage(dht2.id,msg);



    /*
    var res=await dht2.receiveMessageFromAuthor(dht.id);
    if (res==null) 
        console.log("FAILED");
    else if (JSON.stringify(msg)!=JSON.stringify(decode(res.value)))
        console.log("FAILED DIFFERENT"); 

    msg={
        detailkey:"ciao",
        payload:"bene"
    }

    await dht.sendMessage(dht.id,encode(msg,MAXMSGSIZE));

    res=await dht.receiveOwnMessage();
    if (res==null) 
        console.log("FAILED");
    else if (JSON.stringify(msg)!=JSON.stringify(decode(res.value)))
        console.log("FAILED DIFFERENT");


    var keepthem:any={};

    msg={
        payload:"hi from dht"
    }
    keepthem[dht.id.toString('hex')]=msg;
    await dht.sendMessage(dhtseed.id,encode(msg,MAXMSGSIZE));

    var msg2:any={
        payload:"hello seed from dht2"
    }
    keepthem[dht2.id.toString('hex')]=msg2;
    await dht2.sendMessage(dhtseed.id,encode(msg2,MAXMSGSIZE));

    var msgseed={
        payload:"hello from myself"
    }
    keepthem[dhtseed.id.toString('hex')]=msgseed;
    await dhtseed.sendMessage(dhtseed.id,encode(msgseed,MAXMSGSIZE));



    await testStream(dht,dht2);

    const userId="Marco"

    var sui=dht.createSignedUserName(userId);

    if(!await dht.setUser(sui)){
        console.log("failed to set userID");
    }

    var ub=await dht.getUser(userId);
    if (ub==null) 
        console.log("failed to get user");
    else if (Buffer.compare(ub,dht.id))
        console.log("got wrong user");

    var suis=dht2.createSignedUserName(userId);

    if(await dht2.setUser(suis)){
        console.log("could steal name");
    }

    await testBTree(dht,dht2);

    console.log("shutting down");
    await dhtseed.shutdown();
    await dht.shutdown();
    await dht2.shutdown();

    */
    
    console.log("DONE FINITO FATTO");
}

async function testStream(dht:DisDHT,dht2:DisDHT){

    var aBlock=Buffer.alloc(23456);
    for (let i=0;i<aBlock.length;i++) aBlock[i]=Math.random()*256;
    var arr=[];
    for (let i=0;i<60;i++) arr.push(aBlock);

    var blob=new Blob(arr);
    var streamHash=await dht.putStream(blob.stream());

    console.log("putStream DONE ",streamHash.toString('hex'));

    try{
        var stream=dht2.getStream(streamHash);
        if (!await comp(stream,blob.stream())){
            console.log("failed");
        }
    }catch(err){
        console.log(err);
    }
}


async function comp(a:ReadableStream,b:ReadableStream){
    var ra=a.getReader();
    var rb=b.getReader();
    var ma=await ra.read();
    var mb=await rb.read();
    var ia=0;
    var ib=0;
    while(!ma.done && !ma.done){
        if (ia==ma.value.length){
            ma=await ra.read();
            ia=0;
        }
        if (ib==mb.value.length){
            mb=await rb.read();
            ib=0;
        }
        if (ma.done && ma.done) return true;
        if (ma.done || ma.done) return false;
        if (ma.value[ia++]!=mb.value[ib++]) return false;
    }
    return true;
}


function compare(a:number,b:number){
    return a-b;
}

function getIndex(a:any){
    return a.k;
}

var m_w = 123456789;
var m_z = 987654321;
var mask = 0xffffffff;

// Takes any integer
function seed(i:number) {
    m_w = (123456789 + i) & mask;
    m_z = (987654321 - i) & mask;
}

// Returns number between 0 (inclusive) and 1.0 (exclusive),
// just like Math.random().
function random():number
{
    m_z = (36969 * (m_z & 65535) + (m_z >> 16)) & mask;
    m_w = (18000 * (m_w & 65535) + (m_w >> 16)) & mask;
    var result = ((m_z << 16) + (m_w & 65535)) >>> 0;
    result /= 4294967296;
    return result;
}

const BTREEITER=5000;
const BTREESEED=2343;

async function testBTree(dht:DisDHT,dht2:DisDHT){
    var rootHash:Buffer|null=null;
    seed(BTREESEED);
    var map=new Map<number,number>();

    for(let i=0;i<BTREEITER;i++){
        let r={k:random(),v:random()};
        map.set(r.k,r.v);
        rootHash=await dht.btreePut(r, rootHash, compare, getIndex);
    }

    seed(BTREESEED);

    var testres=true;

    for(var k of map.keys()){
        var v=map.get(k);
        var lastfound=0;

        const found:(data:any)=>Promise<boolean> =async (data:any)=>{
            testres &&=  (data.k != k) || data.v == v;
            testres &&= lastfound <= data.k;
            lastfound=data.k;
            return true;
        }

        await dht2.btreeGet(k,rootHash,compare,getIndex,found);
    }


    if (!testres)
        console.log("bTree FAILED");

}


try{
    fn();
}catch(err){
    console.log("failed badly");
    console.log(err);
}



