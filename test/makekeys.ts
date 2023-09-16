

import {keygen} from '../mysodium.js';
import fs from 'fs';

var r=[];

for(let i=0;i<100;i++){
    let k=keygen();
    let pk=k.pk;
    while(pk[31]!=0){ //
        k=keygen();
        pk=k.pk;
    }
    let h={
        pk:k.pk.toString('hex'),
        sk:k.sk.toString('hex'),
    }
    r.push(h);
}

fs.writeFile("testkeys.json", JSON.stringify(r), function(err:any) {
    if (err) {
        console.log(err);
    }
});



