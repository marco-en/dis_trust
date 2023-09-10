import { DisDHT } from "../disdht.js";
import Storage from "./mockupStorage.js";
import fs from "node:fs/promises";
import * as sodium from '../mysodium.js';
import {encode,decode} from '../encoder.js';

const MAXMSGSIZE=1024*1024;
console.log("Hello");

async function fn(){

    let keys=JSON.parse(await fs.readFile("test/testkeys.json",{encoding:'utf-8'}));


    let sk=Buffer.from(keys[0].sk,'hex');
    let storage=new Storage();
    let dhtseed=new DisDHT({
        secretKey:sk,
        storage:storage,
        servers:[
            {port:54321}
        ]
    });
    await dhtseed.startUp();

    sk=Buffer.from(keys[1].sk,'hex');
    storage=new Storage();
    let dht=new DisDHT({
        secretKey:sk,
        storage:storage,
        seed:[
            {port:54321,host:'localhost'}
        ]
    });
    await dht.startUp();


    var msg={
        detailkey:"ciao",
        payload:"Ok!!!"
    }

    var key=sodium.sha(Buffer.from(msg.detailkey))
    var value=encode(msg,MAXMSGSIZE);

    //dht.put(key,value);

    sk=Buffer.from(keys[2].sk,'hex');
    storage=new Storage();
    let dht2=new DisDHT({
        secretKey:sk,
        storage:storage,
        seed:[
            {port:54321,host:'localhost'}
        ]
    });
    await dht2.startUp();

    //var res=await dht2.getAuthor(key,dht.id)

}

fn();



