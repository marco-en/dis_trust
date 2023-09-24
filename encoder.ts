import {Buffer} from 'buffer';
import Debug from 'debug';

const debug=Debug("encoder")

const TESTING=false;

enum ET{
    end=0,
    null,
    true,
    false,
    undefined,
    number,
    string,
    array,
    object,
    buffer0,
    buffer8,
    buffer16,
    buffer32,

}


class BufferWriter{
    _buffer:Buffer;
    _maxSize:number;
    _end=0;
    constructor(maxSize:number=1024*1024,initAlloc:number=512){
        this._buffer=Buffer.alloc(initAlloc);
        this._maxSize=maxSize;
    }

    _alloc(size:number):void{
        if(this._end+size<this._buffer.length) return;
        var ns=Math.min(this._buffer.length*2+size,this._maxSize);
        if(this._end+size>=ns) 
            throw new Error("buffer bigger than bigger size");
        var nb=Buffer.alloc(ns);
        this._buffer.copy(nb);
        this._buffer=nb;
    }

    writeByte(c:number):void{
        this._alloc(1);
        this._buffer[this._end++]=c;
    }

    write(b:Buffer): void {
        this._alloc(b.length);
        b.copy(this._buffer,this._end);
        this._end+=b.length;
    }

    getContent():Buffer{
        return this._buffer.subarray(0,this._end);
    }
}

function _varLen(obj:any,sb:BufferWriter,type:number){
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

function _goBuffer(obj:Buffer, sb:BufferWriter,type:number){
    _varLen(obj,sb,type);
    sb.write(obj);
}

function _goString(str:string,sb:BufferWriter){
    sb.writeByte(ET.string);
    var bf=Buffer.from(str);
    if (TESTING){
        for(let b of bf)
            if (!b)
                throw new Error("what?");
    }

    sb.write(bf);
    sb.writeByte(ET.end);
}

function _goArray(array:any[], sb:BufferWriter){
    sb.writeByte(ET.array);
    for (let i=0;i<array.length;i++)
        _go(array[i],sb);
    sb.writeByte(ET.end); 
}

function _goObject(obj:Object, sb:BufferWriter){
    sb.writeByte(ET.object);
    for (const [prop, value] of Object.entries(obj)) {
        sb.write(Buffer.from(prop));
        sb.writeByte(ET.end);
        _go(value,sb);
    }
    sb.writeByte(ET.end);
}

function _go(obj:any,sb:BufferWriter){
    var numbuf:Buffer|undefined;

    switch(typeof(obj)){
        case "boolean":
            if (obj) sb.writeByte(ET.true);
            else sb.writeByte(ET.false)
            return;
        case "number":
            sb.writeByte(ET.number);
            if (!numbuf) numbuf=Buffer.alloc(8);
            numbuf.writeDoubleLE(obj as number)
            sb.write(numbuf);
            return;
        case "string":
            _goString(obj as string,sb);
            return;
        case "undefined":
            sb.writeByte(ET.undefined);
            return;
        case "object":
            if (obj==null)
                sb.writeByte(ET.null);
            else if (obj instanceof Buffer)
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

export function encode(obj:any,maxSize:number):Buffer{
    const sb=new BufferWriter(maxSize);
    _go(obj,sb);
    const r=sb.getContent();
    if (!r) throw new Error("could not encode");

    if (TESTING){
        let dec;
        try{
            dec=decode(r);
        }catch(err){
            debug("decode fatal")
            throw(err);
        }
        if (JSON.stringify(obj)!=JSON.stringify(dec)){
            debug("encoder fatal")
            throw new Error("encode fatal");
        }
    }

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


function readBuffer(br:BufferReader,byteslen:number):Buffer{
    var b=br.getBuffer(byteslen);
    if (b==null) throw new Error("invalid decode object len")
    const len= b.readUIntLE(0,byteslen);
    var r=br.getBuffer(len);
    if (!r) throw new Error("cannot decode buffer");
    return r;
}

function readString(br:BufferReader):string{
    var r=br.getString();
    if (!r) throw new Error("cannot decode string");
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
        case ET.undefined:
            return undefined;
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