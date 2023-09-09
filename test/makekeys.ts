

import {keygen} from '../mysodium.js';
import fs from 'fs';

var r=[];

for(let i=0;i<1000;i++){
    let k=keygen();
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



