

import {ParallelRunner} from '../semaphore.js';


function go(n:number):Promise<number>{
    console.log("go ",n);
    return new Promise((resolve,reject)=>{
        setTimeout(()=>{
            console.log("gone ",n);
            resolve(n*2)
        },1000)
    });
}

async function t(){

    var pr=new ParallelRunner(10);

    for (let i=0;i<300;i++){
        pr.run(()=>{
            return go(i);
        });
    }

}

t();