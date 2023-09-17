import * as Merkle from "../merkle.js";
import * as sodium from "../mysodium.js";


const nodeSize=32*3;


async function giveatry(len:number){
    var buf=Buffer.alloc(len);
    for(let i=0;i<len;i++) buf[i]=Math.trunc(Math.random()*256);

    var nodes:Map<string,Merkle.IMerkleNode>=new Map();

    const emit=async (node:Merkle.IMerkleNode)=>{
        nodes.set(node.infoHash.toString('hex'),node);
    };

    var mw=new Merkle.MerkleWriter(emit,sodium.sha,nodeSize);
    await mw.update(buf);
    var root=await mw.done();

    let chunks:Buffer[]=[];

    const read=async (infoHash:Buffer)=>{
        return nodes.get(infoHash.toString('hex'));
    };

    const emitchunk=async (chunk:Buffer)=>{
        chunks.push(chunk);
    }

    var mr=new Merkle.MerkleReader(read,sodium.sha,emitchunk);

    let bres=await mr.check(root);
    if(bres==false){
        console.log("failed on check");
        return false;
    }

    var res=Buffer.concat(chunks);

    if(Buffer.compare(res,buf)){
        console.log("failed on outcome");
        return false;
    }
    else{
        return true;
    }



}

async function run():Promise<number>{
    let cnt=1;
    while(await giveatry(cnt)){
        console.log("passed ",cnt);
        cnt=Math.trunc(Math.random()*16*1024*1024)
    };
    return cnt;
}

run().then(r=>{
})
.catch(err=>{
    console.log("exception  ",err);  
})