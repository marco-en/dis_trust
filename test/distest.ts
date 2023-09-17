import { DisDHT } from "../disdht.js";
import Storage from "./mockupStorage.js";
import fs from "node:fs/promises";
import * as sodium from '../mysodium.js';
import {encode,decode} from '../encoder.js';
import Debug from 'debug';

const MAXMSGSIZE=1024*1024;
console.log("Hello");
//Debug.enable("*");

async function fn(){

    let keys=JSON.parse(await fs.readFile("test/testkeys.json",{encoding:'utf-8'}));



    let sk=Buffer.from(keys[0].sk,'hex');
    let storage=new Storage(Debug("MockupStorage "+keys[0].pk.toString('hex').slice(0,6)));
    let dhtseed=new DisDHT({
        secretKey:sk,
        storage:storage,
        servers:[
            {port:54321}
        ]
    });
    await dhtseed.startUp();

    sk=Buffer.from(keys[1].sk,'hex');
    storage=new Storage(Debug("MockupStorage "+keys[1].pk.toString('hex').slice(0,6)));
    let dht=new DisDHT({
        secretKey:sk,
        storage:storage,
        seed:[
            {port:54321,host:'localhost'}
        ]
    });
    await dht.startUp();



    sk=Buffer.from(keys[2].sk,'hex');
    storage=new Storage(Debug("MockupStorage "+keys[2].pk.toString('hex').slice(0,6)));
    let dht2=new DisDHT({
        secretKey:sk,
        storage:storage,
        seed:[
            {port:54321,host:'localhost'}
        ]
    });
    await dht2.startUp();

    
    console.log("dht2 startUp DONE");


    var msg={
        detailkey:"ciao",
        payload:"Ok!!!"
    }

    var key=sodium.sha(Buffer.from(msg.detailkey))
    var value=encode(msg,MAXMSGSIZE);

    console.log(value);
    await dht.put(key,value);

    var res=await dht2.getAuthor(key,dht.id)
    console.log(res);

    var resseed=await dhtseed.getAuthor(key,dht.id);
    console.log(resseed);

    var resauth=await dht.getAuthor(key,dht.id);
    console.log(resauth);

    
    var msg2={
        detailkey:"ciao",
        payload:"hello"
    }

    var key2=sodium.sha(Buffer.from(msg2.detailkey))
    var value2=encode(msg2,MAXMSGSIZE);

    console.log(value2);
    await dht2.put(key2,value2);

    resauth=await dht.getAuthor(key,dht2.id);
    console.log(resauth); 

    resseed=await dhtseed.getAuthor(key,dht2.id);
    console.log(resseed);
    
    res=await dht2.getAuthor(key,dht2.id)
    console.log(res);

    console.log("get all authors")
    await dhtseed.get(key2,async entry=>{
        console.log(entry);
        return true;
    })
    console.log("DONE")


    var msg3={
        detailkey:"ciao",
        payload:"non so"
    }

    var key3=sodium.sha(Buffer.from(msg3.detailkey))
    var value3=encode(msg2,MAXMSGSIZE);

    await dhtseed.put(key3,value3);

    console.log("get all authors again")
    await dht.get(key3,async entry=>{
        console.log(entry);
        return true;
    })
    console.log("DONE")
}

fn();



