import { IMerkleNode } from './merkle.js';

export interface IStorageEntryBase{
    author:Buffer, 
    timestamp:number,
}

export interface IStorageEntry extends IStorageEntryBase{
    key:Buffer,
    value:Buffer,
    version:number,
}

export interface IUserId extends IStorageEntryBase{
    userId:string,
    userHash:Buffer,
}

export interface ISignedUserId{
    entry:IUserId,
    signature:Buffer;
}

export interface ISignedStorageEntry{
    entry:IStorageEntry,
    signature:Buffer
}

export interface IStorageMerkleNode extends IStorageEntryBase{
    node:IMerkleNode,
    version:number,
}

export interface ISignedStorageMerkleNode{
    entry:IStorageMerkleNode,
    signature:Buffer,
}


export enum TrustLevel{
    neutral=0,
    trusted,
    distrusted
}

export interface ISetTrust extends IStorageEntryBase{
    who:Buffer,
    level:TrustLevel, 
}

export interface ISignedSetTrust{
    entry:ISetTrust,
    signature:Buffer,   
}

export interface IStorage{
    storeSignedEntry:(me:ISignedStorageEntry)=>Promise<void>,
    retreiveAuthor:(key:Buffer,author:Buffer)=>Promise<ISignedStorageEntry|null>,
    retreiveAnyAuthor:(key:Buffer,page:number)=>Promise<ISignedStorageEntry[]>,

    storeMerkleNode:(snm:ISignedStorageMerkleNode)=>Promise<void>,
    getMerkleNode:(infoHash:Buffer)=>Promise<ISignedStorageMerkleNode|undefined>,

    setUserId:(signeUserId:ISignedUserId)=>Promise<boolean>,
    getUserId:(userHash:Buffer)=>Promise<ISignedUserId|undefined>,

    getAccount:(userId:string)=>Promise<Buffer|undefined>,
    setAccount:(userId:string,encryptedBufferAccount:Buffer)=>Promise<void>,


    setTrustRelationship:(st:ISignedSetTrust)=>Promise<void>;
    getTrustRelationship:(author:Buffer,who:Buffer)=>Promise<ISignedSetTrust|null>;
}