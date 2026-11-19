'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

// The Adafruit SDK's Windows recipe names this uploader without declaring an
// npm tool dependency. Pin the official SDK-distributed executable rather
// than selecting an unrelated nrfutil/Python installation from PATH.
// Upstream source/attribution: Adafruit/Adafruit_nRF52_Arduino, SDK tag 1.7.0,
// tools/adafruit-nrfutil. The client downloads from the upstream repository;
// this source tree does not redistribute the executable.
const ADAFRUIT_NRFUTIL=Object.freeze({
  id:'adafruit-nrfutil',toolVersion:'0.5.3.post16',sdkTag:'1.7.0',directory:'adafruit-nrfutil-sdk@1.7.0',filename:'adafruit-nrfutil.exe',
  url:'https://raw.githubusercontent.com/adafruit/Adafruit_nRF52_Arduino/1.7.0/tools/adafruit-nrfutil/win32/adafruit-nrfutil.exe',
  sha256:'9637a4d099f4a99cbbdfb14142345776582dfbd11d4f357748055b75006ac8c6',sizeBytes:7776810,
});
function fail(message){return Object.assign(new Error(message),{code:'UPLOADER_MISSING'});}
function verifiedFile(filename,descriptor){
  if(!fs.existsSync(filename))return false;
  const stat=fs.lstatSync(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(filename)!==filename)throw fail('The cached builtin uploader is not a regular physical file.');
  return stat.size===descriptor.sizeBytes && crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')===descriptor.sha256;
}
async function ensurePinnedUploader(toolsRoot,descriptor,{fetch:fetcher=globalThis.fetch,signal}={}){
  toolsRoot=path.resolve(toolsRoot);fs.mkdirSync(toolsRoot,{recursive:true});
  if(fs.lstatSync(toolsRoot).isSymbolicLink()||fs.realpathSync(toolsRoot)!==toolsRoot)throw fail('The builtin uploader cache must be a physical tools directory.');
  const directory=path.join(toolsRoot,descriptor.directory);fs.mkdirSync(directory,{recursive:true});
  if(fs.lstatSync(directory).isSymbolicLink()||fs.realpathSync(directory)!==directory)throw fail('The builtin uploader cache directory is linked.');
  const target=path.join(directory,descriptor.filename);
  if(verifiedFile(target,descriptor))return target;
  if(typeof fetcher!=='function')throw fail('The builtin Windows uploader cannot be downloaded by this Node runtime.');
  const temporary=path.join(directory,`.uploader-${crypto.randomUUID()}.part`);let fd;
  try{
    signal?.throwIfAborted();
    const response=await fetcher(descriptor.url,{redirect:'error',signal});
    if(!response.ok||!response.body)throw fail(`The official ${descriptor.id} uploader download failed.`);
    const length=response.headers?.get?.('content-length');
    if(length!==null&&length!==undefined&&Number(length)!==descriptor.sizeBytes)throw fail('The builtin uploader download has an unexpected size.');
    fd=fs.openSync(temporary,'wx');let total=0;const digest=crypto.createHash('sha256');
    for await(const chunk of response.body){
      signal?.throwIfAborted();const bytes=Buffer.from(chunk);total+=bytes.length;
      if(total>descriptor.sizeBytes)throw fail('The builtin uploader download exceeds its pinned size.');
      digest.update(bytes);fs.writeSync(fd,bytes);
    }
    if(total!==descriptor.sizeBytes||digest.digest('hex')!==descriptor.sha256)throw fail('The builtin uploader failed its pinned SHA256 verification.');
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    if(fs.existsSync(target)){
      if(verifiedFile(target,descriptor))return target;
      fs.unlinkSync(target);
    }
    fs.renameSync(temporary,target);return target;
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temporary,{force:true});}
}
async function resolveBuiltinUploader(command,toolsRoot,{platform=process.platform,sdkIdentity,...options}={}){
  const bare=String(command||'').replace(/^"|"$/gu,'');
  if(platform!=='win32'||!['adafruit-nrfutil','adafruit-nrfutil.exe'].includes(bare))return null;
  // The reviewed aily SDK version differs from the upstream SDK tag above.
  if(sdkIdentity?.package!=='@aily-project/sdk-arm-ble'||sdkIdentity.version!=='0.4.0')throw fail('The cloud SDK has no reviewed pinned Adafruit uploader.');
  return ensurePinnedUploader(toolsRoot,ADAFRUIT_NRFUTIL,options);
}
module.exports={ADAFRUIT_NRFUTIL,ensurePinnedUploader,resolveBuiltinUploader};
