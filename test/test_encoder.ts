

import {encode,decode} from '../encoder.js';


function test(arg:any):void{
    var r=encode(arg);
    if (r==null) throw new Error("could not");
    var back=decode(r);
    var sarg=JSON.stringify(arg);
    var barg=JSON.stringify(back);
    if (sarg!=barg)
        throw(new Error("not the same!"));
}

test(true);
test(null);
test(false);
test(54);
test("hello!");
test([]);
test([4,null,true,"cejnei"]);
test(Buffer.from("hello!"));
test({});
test({hi:null,bene:"ok"});
test({hi:null,bene:"ok",inside:[false,{prova:"ancora"}]});







