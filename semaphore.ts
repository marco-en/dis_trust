
export default class Semaphore{
    _cnt:number;
    _resolveList:any[]=[];

    constructor(cnt:number){
        this._cnt=cnt;
    }

    inc():void{
        if (this._resolveList.length)
        {
            let r=this._resolveList.shift();
            r();
        }
        else
            this._cnt++;
    }

    dec():Promise<void>{
        return new Promise((resolve,reject)=>{
            if(this._cnt>0){
                this._cnt--;
                resolve();
            }else{
                this._resolveList.push(resolve);
            }
        })
    }

    dec_callback(callback:any):void{
        if(this._cnt>0){
            this._cnt--;
            callback();
        }else{
            this._resolveList.push(callback);
        }        
    }

    zero(){
        while(this._resolveList.length)
            this.inc();
        this._cnt=0;
    }
}

export class ParallelRunner{
    _sem:Semaphore;
    constructor(max:number){
        this._sem=new Semaphore(max);
    }
    run(callback:any):Promise<any>{
        return new Promise((resolve,reject)=>{
            this._sem.dec_callback(()=>{
                callback()
                .then((res:any)=>{resolve(res)})
                .catch((err:Error)=>{reject(err)})
                .finally(()=>{
                    this._sem.inc();
                })
            });
        })
    }
}