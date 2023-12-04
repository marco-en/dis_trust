

export interface IBtreeNode{
    leaf?:any[];
    children?:Buffer[];
    keys?:any[];
}

interface ISplitResult{
    lowerNode:Buffer;
    splitkey:any;
    higherNode:Buffer;
}


export class DisDhtBtree{

    protected _rootHash:Buffer|null;
    protected _readNode:(infoHash:Buffer)=>Promise<IBtreeNode|null>;
    protected _saveNode:(node:IBtreeNode)=>Promise<Buffer>;
    protected _compare:(a:any,b:any)=>number;
    protected _getIndex:(a:any)=>any;
    protected _mustSplit:(n:any)=>boolean;

    constructor(rootHash:Buffer|null,
            readNode:(infoHash:Buffer)=>Promise<IBtreeNode|null>, 
            saveNode:(node:IBtreeNode)=>Promise<Buffer>,
            compare:(a:any,b:any)=>number,
            getIndex:(a:any)=>any,
            mustSplit:(n:any)=>boolean){
        this._rootHash=rootHash;
        this._readNode=readNode;
        this._saveNode=saveNode;
        this._compare=compare;
        this._getIndex=getIndex
        this._mustSplit=mustSplit
    }

    protected _makeLeaf(content:any[]):IBtreeNode|null{
        var r={
            leaf:content
        }
        if (this._mustSplit(r))
            return r;
        else
            return null;
    }

    protected _makeInnerNode(children:Buffer[],keys:any[]):IBtreeNode|null{
        if (children.length!=keys.length+1) throw new Error();
        return {
            children:children,
            keys:keys
        }
    }

    checkNode(node:IBtreeNode):boolean{
        return true
    }

    async put(toBeInserted:any):Promise<Buffer>{
        if (this._rootHash==null){
            //new tree. Root is a new leaf
            let root=this._makeLeaf([toBeInserted]);
            if (root==null) throw new Error("could not encode root");
            this._rootHash=await this._saveNode(root);
        }else{
            //existing tree
            var r=await this._put(this._rootHash,toBeInserted);
            if (r instanceof Buffer){   //no root split
                this._rootHash=r;
            } else {                    //root split. Root will be a inner tree.
                let splitRoot = this._makeInnerNode([r.lowerNode,r.higherNode],[r.splitkey]);
                if (splitRoot==null) throw new Error();
                this._rootHash=await this._saveNode(splitRoot);
            }
        }
        return this._rootHash;
    }

    protected async _put(infoHash:Buffer, toBeInserted:any):Promise<ISplitResult|Buffer>{
        var node = await this._readNode(infoHash);
        if (node==null) 
            throw new Error("could not retreive node");
        if (!this.checkNode(node)) 
            throw new Error("retreived invalid node");
        if (node.leaf) 
            return await this._putLeaf(node,toBeInserted);
        else 
            return await this._putInnerNode(node,toBeInserted);
    }

    protected async _putLeaf(node:IBtreeNode,toBeInserted:any):Promise<ISplitResult|Buffer>{
        if (!node.leaf) throw new Error();

        var newLeaf=[...node.leaf];
        newLeaf.push(toBeInserted);

        const compare=(a:any,b:any)=>{
            return this._compare(this._getIndex(a),this._getIndex(b));
        }

        newLeaf.sort(compare);

        let r=this._makeLeaf(newLeaf);

        if (r) { // no split
            return await this._saveNode(r);
        }

        // split in half

        let half=Math.floor(newLeaf.length/2);

        let lowerNode=this._makeLeaf(newLeaf.slice(0,half));
        let higherNode=this._makeLeaf(newLeaf.slice(half));
        let splitkey=this._getIndex(newLeaf[half-1]);

        if(lowerNode==null || higherNode==null){
            throw new Error("could not split the leaf")
        }

        var lowHash=await this._saveNode(lowerNode);
        var highHash=await this._saveNode(higherNode);

        return {
            splitkey:splitkey,
            lowerNode:lowHash,
            higherNode:highHash
        }
    }

    protected async _putInnerNode(node:IBtreeNode,toBeInserted:any):Promise<ISplitResult|Buffer>{
        if (!node.keys || !node.children) throw new Error();

        var indexToBeInserted=this._getIndex(toBeInserted)

        var i=0;
        const recur:()=>Promise<ISplitResult|Buffer>=async ()=>{
            if (!node.keys || !node.children) throw new Error();
            for(;i<node.keys.length;i++){
                let c=this._compare(node.keys[i],indexToBeInserted);
                if (c>=0)
                    return await this._put(node.children[i],toBeInserted);
            }
            return await this._put(node.children[node.keys.length],toBeInserted);
        }

        var subinner=await recur();

        


        if (subinner instanceof Buffer){
            let nc=[...node.children];
            nc[i]=subinner;
            let inner=this._makeInnerNode(nc,node.keys);
            if (inner==null) throw new Error();
            let h=await this._saveNode(inner);
            return h;
        }else{
            let splitPos=Math.floor(node.keys.length/2);
            let splitkey=node.keys[splitPos]
            let lowerNode=this._makeInnerNode(node.children.splice(0,splitPos),node.keys.splice(0,splitPos-1));
            if (!lowerNode) throw new Error();
            let higherNode=this._makeInnerNode(node.children.splice(splitPos),node.keys.splice(splitPos+1)); 
            if (!higherNode) throw new Error();
            let lh=await this._saveNode(lowerNode);
            let hh=await this._saveNode(higherNode);
            return {
                splitkey:splitkey,
                lowerNode:lh,
                higherNode:hh,
            }
        } 
    }

    async get(key:any, found:(data:any)=>Promise<boolean> ):Promise<void>{
        if (!this._rootHash) return;
        await this._get(this._rootHash,key,found);
    }

    protected async _get(infoHash:Buffer, key:any, found:(data:any)=>Promise<boolean> ):Promise<boolean>{
        var node =await this._readNode(infoHash);
        if (node==null) throw new Error("cannot retreive node");
        if (!this.checkNode(node)) throw new Error("retreived invalid node");
        if (node.children) 
            return await this._getInner(node,key,found);
        else 
            return await this._getLeaf(node,key,found);
    }

    protected async _getLeaf(node:IBtreeNode, key:any, found:(data:any)=>Promise<boolean> ):Promise<boolean>{
        if (!node.leaf) throw new Error();
        for (let i=0;i<node.leaf.length;i++){
            let ix=this._getIndex(node.leaf[i]);
            let c=this._compare(ix,key);
            if (c>=0)
            {
                if (!await found(node.leaf[i]))
                    return false;
            }
        }
        return true
    }

    protected async _getInner(node:IBtreeNode, key:any, found:(data:any)=>Promise<boolean> ):Promise<boolean>{
        if (!node.keys || !node.children) throw new Error();
        let i=0
        for(;i<node.keys.length;i++){
            let c=this._compare(node.keys[i],key);
            if (c<0){

            } else if (c==0){
                if (!await this._get(node.children[i],key,found)){
                    return false;
                }
            } else 
                return await this._get(node.children[i],key,found);
        }
        return await this._get(node.children[i],key,found);;
    }
}


