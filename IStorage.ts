/*import { IMerkleNode } from './merkle.js';
import {IBtreeNode} from './DisDhtBtree.js';
*/


export interface ISignable{
    signature:Buffer|null
}

export interface IStorageEntryBase extends ISignable{
    author:Buffer, 
    timestamp:number,
    version:number
}

export interface IStorageEntry extends IStorageEntryBase{
    key:Buffer,
    value:Buffer,
}


export interface IUserId extends IStorageEntryBase{
    userId:string,
    userHash:Buffer,
}

export interface ISignedBuffer extends IStorageEntryBase{
    infoHash:Buffer,
    data:Buffer
}



export enum Trust{
    neutral=0,
    distrust=-1,
    trust=1
}


export interface IStorage{
    storeSignedEntry:(me:IStorageEntry)=>Promise<void>,
    retreiveAuthor:(key:Buffer,author:Buffer)=>Promise<IStorageEntry|null>,
    retreiveAnyAuthor:(key: Buffer,tsGt:number, maxNumRecords:number )=>Promise<IStorageEntry[]>,

    storeBuffer:(isb:ISignedBuffer)=>Promise<void>,
    retreiveBuffer:(infoHash:Buffer)=>Promise<ISignedBuffer|null>

    setUserId:(signeUserId:IUserId)=>Promise<boolean>,
    getUserId:(userHash:Buffer)=>Promise<IUserId|undefined>,

    getAccount:(userId:string)=>Promise<Buffer|undefined>,
    setAccount:(userId:string,encryptedBufferAccount:Buffer)=>Promise<void>,

    setTrust:(object:Buffer,trust:Trust)=>Promise<void>;
    getTrust:(object:Buffer)=>Promise<Trust>;

    isNewMark:(author:Buffer,ts:number)=>Promise<boolean>;
}