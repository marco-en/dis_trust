import sodium from 'sodium-native';

export const verify=sodium.crypto_sign_verify_detached;

export function crypto_box_seed_keypair(){
  var pk=Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  var sk=Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(pk, sk);
  return {pk,sk};
}

export function crypto_box_encrypt(m:Buffer,pk:Buffer){
  var c=Buffer.alloc(m.length+sodium.crypto_box_SEALBYTES);
  sodium.crypto_box_seal(c, m, pk);
  return c;
}

export function crypto_box_decrypt(c:Buffer, pk:Buffer, sk:Buffer):Buffer|null{
  var m=Buffer.alloc(c.length-sodium.crypto_box_SEALBYTES);
  var b=sodium.crypto_box_seal_open(m, c, pk, sk) as any;
  if (b) return m;
  else return null;
}

export function sign (msg: Buffer, sk:Buffer) {
  const sig = Buffer.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, msg, sk)
  return sig
};

export function keygen (sk?:Buffer) {
  const pk = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  if (sk == null) {
    sk = sodium.sodium_malloc(sodium.crypto_sign_SECRETKEYBYTES)
    sodium.crypto_sign_keypair(pk, sk)
  } else {
    sodium.crypto_sign_ed25519_sk_to_pk(pk, sk)
  }

  return { pk, sk }
};

export function salt () {
  const s = Buffer.alloc(64)
  sodium.randombytes_buf(s)
  return s
}

export function sha(input:Buffer){
  var output=Buffer.alloc(sodium.crypto_hash_sha256_BYTES);
  sodium.crypto_hash_sha256(output,input);
  return output;
}

export function shaStream():sodium.CryptoHashSha256Wrap{
  return sodium.crypto_hash_sha256_instance();
}

export const NONCEBYTES=sodium.crypto_secretbox_NONCEBYTES;

export function symmetric_encrypt(clear:Buffer,password:string,nonce:Buffer):Buffer{
  var key=sha(Buffer.from(password));
  var r=Buffer.alloc(clear.length+sodium.crypto_secretbox_MACBYTES);
  sodium.crypto_secretbox_easy(r, clear, nonce, key);
  return r;
}

export function symmetric_decrypt(encrypted:Buffer,password:string,nonce:Buffer):Buffer|null{
  var key=sha(Buffer.from(password));  
  var r=Buffer.alloc(encrypted.length-sodium.crypto_secretbox_MACBYTES);  
  if(!sodium.crypto_secretbox_open_easy(r,encrypted,nonce,key)) return null;
  return r;
}

export function randombytes(num:number){
  var r=Buffer.alloc(num);
  sodium.randombytes_buf(r);
  return r;
}

export const crypto_hash_sha256_BYTES=sodium.crypto_hash_sha256_BYTES;
export const crypto_secretbox_NONCEBYTES=sodium.crypto_secretbox_NONCEBYTES;