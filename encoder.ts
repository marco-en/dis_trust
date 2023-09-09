import {Buffer} from 'buffer';
import {WritableStreamBuffer} from 'stream-buffers';

enum ET{
    end=0,
    null,
    true,
    false,
    number,
    string,
    array,
    object,
    buffer0,
    buffer8,
    buffer16,
    buffer32,

}

const ETBufs:Buffer[]=[];

for(let i=ET.end;i<=ET.object;i++){
    ETBufs.push(Buffer.from([i]));
}

function _varLen(obj:any,sb:WritableStreamBuffer,type:number){
    var b:Number;
    var f:Buffer;
    if(obj.length==0){
        f=Buffer.alloc(1);
        f[0]=type;
    }
    else if(obj.length<256){
        f=Buffer.alloc(2);
        f[0]=type+1;
        f[1]=obj.length;
    }
    else if(obj.length<65536){
        f=Buffer.alloc(3);
        f[0]=type+2;
        f.writeUInt16LE(obj.length,1);
    }
    else if(obj.length<4294967296){
        f=Buffer.alloc(5);
        f[0]=type+3;
        f.writeUInt32LE(obj.length,1);
    }
    else{
         throw new Error("to big thing")
    }
    sb.write(f);
}

function _goBuffer(obj:Buffer, sb:WritableStreamBuffer,type:number){
    _varLen(obj,sb,type);
    sb.write(obj);
}

function _goString(str:string,sb:WritableStreamBuffer){
    sb.write(ETBufs[ET.string]);
    sb.write(Buffer.from(str));
    sb.write(ETBufs[ET.end]);
}

function _goArray(array:any[], sb:WritableStreamBuffer){
    sb.write(ETBufs[ET.array]);
    for (let i=0;i<array.length;i++)
        _go(array[i],sb);
    sb.write(ETBufs[ET.end]); 
}

function _goObject(obj:Object, sb:WritableStreamBuffer){
    sb.write(ETBufs[ET.object]);
    for (const [prop, value] of Object.entries(obj)) {
        sb.write(Buffer.from(prop));
        sb.write(ETBufs[ET.end]);
        _go(value,sb);
    }
    sb.write(ETBufs[ET.end]);
}

function _go(obj:any,sb:WritableStreamBuffer){
    var numbuf:Buffer|undefined;
    if (obj==null){
        sb.write(ETBufs[ET.null]);
        return;
    }
    switch(typeof(obj)){
        case "boolean":
            if (obj) sb.write(ETBufs[ET.true]);
            else sb.write(ETBufs[ET.false])
            return;
        case "number":
            sb.write(ETBufs[ET.number]);
            if (!numbuf) numbuf=Buffer.alloc(8);
            numbuf.writeDoubleLE(obj as number)
            sb.write(numbuf);
            return;
        case "string":
            _goString(obj as string,sb);
            return;
        case "object":
            if (obj instanceof Buffer)
                _goBuffer(obj,sb,ET.buffer0)
            else if(Array.isArray(obj))
                _goArray(obj,sb);
            else
                _goObject(obj,sb);
            return;
        default:
            throw new Error("Cannot serialize "+typeof(obj));
    }
}

export function encode(obj:any):Buffer{
    const sb=new WritableStreamBuffer();
    _go(obj,sb);
    const r=sb.getContents();
    if (!r) throw new Error("could not encode");
    return r
}

class BufferReader{
    buffer:Buffer;
    pos:number=0;
    constructor(buffer:Buffer){
        this.buffer=buffer
    }
    get():number|null{
        if (this.pos<this.buffer.length){
            return this.buffer[this.pos++];
        }
        else
            return null;
    }
    unget(){
        this.pos--;
    }
    getBuffer(len:number):Buffer|null{
        if (this.pos+len>this.buffer.length)
            return null;
        var r=this.buffer.subarray(this.pos,this.pos+len);
        this.pos+=len;
        return r;
    }
    getString():string{
        const start=this.pos;
        var end=start;
        while(this.buffer[end++]);
        var sb=this.buffer.subarray(start,end-1);
        this.pos=end;
        return sb.toString();
    }
}

function readlen(br:BufferReader,byteslen:number):number{
    var b=br.getBuffer(byteslen);
    if (b==null) throw new Error("invalid decode object len")
    return b.readUIntLE(0,byteslen);
}   

function readString(br:BufferReader):string{
    var r=br.getString();
    if (!r) throw new Error("cannot decode string");
    return r;
}

function readBuffer(br:BufferReader,byteslen:number):Buffer{
    const len=readlen(br,byteslen);
    var r=br.getBuffer(len);
    if (!r) throw new Error("cannot decode buffer");
    return r;
}

function readArray(br:BufferReader):any[]{
    var r:any[]=[];
    while(br.get()!=ET.end){
        br.unget();
        r.push(_dec(br));
    }
    return r;
}

function readObject(br:BufferReader):object{
    var r:any={};
    while(br.get()!=ET.end){
        br.unget();
        var prop=br.getString();
        var value=_dec(br);
        r[prop]=value;
    }
    return r;
}


function _dec(br:BufferReader):any{
    switch(br.get()){
        case null:
            return;
        case ET.true:
            return true;
        case ET.false:
            return false;
        case ET.number:
            let nb=br.getBuffer(8);
            if (!nb) throw new Error("invalid number in decoding");
            return nb.readDoubleLE();
        case ET.string:
            return readString(br);
        case ET.array:
            return readArray(br);   
        case ET.null:
            return null;
        case ET.object:
            return readObject(br);
        case ET.buffer0:
            return Buffer.alloc(0);
        case ET.buffer8:
            return readBuffer(br,1);
        case ET.buffer16:
            return readBuffer(br,2);
        case ET.buffer32:
            return readBuffer(br,4);
        case ET.end:
        default:
            throw new Error("invalid buffer");
    }
}

export function decode(buffer:Buffer):any{
    var br=new BufferReader(buffer);
    var r=_dec(br);
    if (br.get()==null)
        return r;
    else   
        throw new Error("decode buffer not ended properly");
}