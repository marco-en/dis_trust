/*import { IMerkleNode } from './merkle.js';
import {IBtreeNode} from './DisDhtBtree.js';
*/

export interface IStorageEntryBase{
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
    data:Buffer,
    signature:Buffer,
}

export interface ISignedUserId{
    entry:IUserId,
    signature:Buffer;
}

export interface ISignedStorageEntry{
    entry:IStorageEntry,
    signature:Buffer
}


export enum Trust{
    neutral=0,
    distrust=-1,
    trust=1
}


export interface IStorage{
    storeSignedEntry:(me:ISignedStorageEntry)=>Promise<void>,
    retreiveAuthor:(key:Buffer,author:Buffer)=>Promise<ISignedStorageEntry|null>,
    retreiveAnyAuthor:(key: Buffer,tsGt:number, maxNumRecords:number )=>Promise<ISignedStorageEntry[]>,

    storeBuffer:(isb:ISignedBuffer)=>Promise<void>,
    retreiveBuffer:(infoHash:Buffer)=>Promise<ISignedBuffer|null>

    setUserId:(signeUserId:ISignedUserId)=>Promise<boolean>,
    getUserId:(userHash:Buffer)=>Promise<ISignedUserId|undefined>,

    getAccount:(userId:string)=>Promise<Buffer|undefined>,
    setAccount:(userId:string,encryptedBufferAccount:Buffer)=>Promise<void>,

    setTrust:(object:Buffer,trust:Trust)=>Promise<void>;
    getTrust:(object:Buffer)=>Promise<Trust>;

    isNewMark:(author:Buffer,ts:number)=>Promise<boolean>;
}