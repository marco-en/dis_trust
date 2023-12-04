

export interface IMerkleNode{
    //infoHash:Buffer;
    chunk?:Buffer;
    children?:Buffer[];
}

class MerkleNode{
    firstchild:Buffer|null;
    children:Buffer[]=[];
    constructor(firstchild:Buffer){
        this.firstchild=firstchild
    }
    push(child:Buffer){
        if (this.firstchild==null)
        {
            this.firstchild=child;
            return;
        }
        if (this.children.length==0) this.children.push(this.firstchild);
        this.children.push(child);
    }
    reset(){
        this.firstchild=null;
        this.children=[];
    }
    
}


const ZEROBUF=Buffer.alloc(0);

export class MerkleWriter{
    _hash:(msg:Buffer)=>Buffer;
    _hashSize:number;
    _nodeSize:number;
    _innerNodeMaxChildren:number;
    _emit:(node:IMerkleNode)=>Promise<Buffer>;
    _pendingChunk=ZEROBUF;
    _tree:MerkleNode[]=[];
    _lastEmitted:Buffer|undefined;

    constructor(emit:(node:IMerkleNode)=>Promise<Buffer>,hash:(msg:Buffer)=>Buffer,nodeSize:number){
        this._hash=hash;
        this._hashSize=hash(Buffer.alloc(1)).length;
        this._nodeSize=nodeSize;

        if (nodeSize*3<this._hashSize) throw new Error("nodeSize too small");
        this._innerNodeMaxChildren=Math.trunc(nodeSize/this._hashSize);
        this._emit=emit;
    }

    async update(chunk:Buffer){
        this._pendingChunk=Buffer.concat([this._pendingChunk,chunk]);
        while(this._pendingChunk.length>=this._nodeSize){
            await this._newLeaf(this._pendingChunk.subarray(0,this._nodeSize));
            this._pendingChunk=this._pendingChunk.subarray(this._nodeSize);
        }
    }

    async _newLeaf(chunk:Buffer){
        this._lastEmitted=await this._emit({chunk:chunk});
        await this._pushInTree(this._lastEmitted,0);
    }

    async _pushInTree(infoHash:Buffer,level:number){
        if(this._tree.length==level){
            this._tree.push(new MerkleNode(infoHash))
            return;
        }
        let n=this._tree[level];
        n.push(infoHash);
        if (n.children.length==this._innerNodeMaxChildren){
            await this._emitNode(n,level);
        };
    }

    async _flush(level:number){
        if(this._tree.length==level) return;
        let n=this._tree[level];
        if (n.children.length>0){
            await this._emitNode(n,level);
        }else if(n.firstchild){
            if(this._tree.length==level+1) return;
            await this._pushInTree(n.firstchild,level+1);
            n.reset();
        }
        await this._flush(level+1);
    }

    async _emitNode(n:MerkleNode,level:number){
        this._lastEmitted=await this._emit({children:n.children});
        await this._pushInTree(this._lastEmitted,level+1);
        n.reset();
    }

    async done():Promise<Buffer>{
        var node:Node|undefined;
        if (this._pendingChunk.length) {
            await this._newLeaf(this._pendingChunk);
            this._pendingChunk=ZEROBUF;
        }
        await this._flush(0);
        if (!this._lastEmitted) throw new Error("nothing to hash")
        return this._lastEmitted;
    }
}

export class MerkleReader{
    _read:(infoHash:Buffer)=>Promise<IMerkleNode|undefined>;
    _hash:(msg:Buffer)=>Buffer;
    _emitchunk:(chunk:Buffer)=>Promise<void>;
    constructor(read:(infoHash:Buffer)=>Promise<IMerkleNode|undefined>,hash:(msg:Buffer)=>Buffer,emitchunk:(chunk:Buffer)=>Promise<void>){
        this._read=read;
        this._hash=hash;
        this._emitchunk=emitchunk;
    }
    async check(infoHash:Buffer):Promise<boolean>{
        var n=await this._read(infoHash);
        if (!n) return false;
        if (n.chunk && n.children)
            return false;
        if (n.chunk){
            //let h=this._hash(n.chunk);
            //if (Buffer.compare(h,n.infoHash))
            //    return false;
            await this._emitchunk(n.chunk);
            return true;
        }
        else if(n.children){
            //let h=this._hash(Buffer.concat(n.children));
            //if (Buffer.compare(h,n.infoHash))
            //    return false;
            for(let b of n.children)
                if(!await this.check(b))
                    return false;
            return true;
        }else return false;
    }
}