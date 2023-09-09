declare module 'bittorrent-dht-sodium'{
    function keygen (sk:any):any;
    function sign(msg:any, sk:any):any;
    function verify(sig:any, msg:any, pk:any):any;
    function salt():any;
    export {keygen,sign,verify,salt};
};

