

import {encode,decode} from '../encoder.js';


function test(arg:any):void{
    var r=encode(arg,100000);
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
test({hi:null,bene:"ok",inside:[false,{prova:"anฆฌฎฎcora"},342.45,Buffer.alloc(534)],eฌr:true});
test({hi:null,"ci":Buffer.alloc(3423),bene:"djfherifjekljvneklneljrfeirjfnekjfnaldkfnl5468935769832xrnfiouhifjhskfemifhceiughlgf.sagslehjom4ch4ohocou4h",inside:[false,{prova:"anฆฌฎฎcora"},342.45,Buffer.alloc(534)],eฌr:true});









