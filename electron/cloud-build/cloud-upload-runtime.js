'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const protocol = require('./protocol');
const childRoot = process.env.AILY_CHILD_PATH || path.resolve(__dirname, '..', '..', 'child');
const exactVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(value);
const fault = (code, message) => protocol.error(code, message);
function localNodeExecutable(){
  // The desktop already distributes a managed Node runtime. Do not depend on
  // Electron's optional RUN_AS_NODE fuse or a global PATH Node installation.
  return process.versions.electron ? regular(path.join(childRoot,'node',process.platform==='win32'?'node.exe':'bin/node')) : process.execPath;
}
function localNodeEnvironment(){const environment={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH'])delete environment[key];return environment;}
function regular(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) throw fault('UNSAFE_PATH', 'Local upload file must be a regular physical file.');
  return filename;
}
function checkedBoard(record) {
  const root = path.join(record.root, 'node_modules', ...record.manifest.boardModule.split('/'));
  const pkg = JSON.parse(fs.readFileSync(regular(path.join(root, 'package.json')), 'utf8'));
  const board = JSON.parse(fs.readFileSync(regular(path.join(root, 'board.json')), 'utf8'));
  if (pkg.version !== record.manifest.boardVersion || protocol.boardDigest(pkg, board) !== record.manifest.boardDigest) throw fault('BUILD_SOURCE_STALE', 'The installed board changed after cloud compilation.');
  return { pkg, board };
}
function runtimeVersionMatches(actual, declared) {
  if (actual === declared || actual.startsWith(`${declared}-`) || actual.startsWith(`${declared}_`)) return true;
  const normalize = value => { const match = value.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-|_|$)/u); return match && [match[1],match[2]||'0',match[3]||'0'].join('.'); };
  return normalize(actual) === normalize(declared);
}
function localDependencyPath(appDataPath, requirement) {
  if (requirement?.kind !== 'tool' || !/^[A-Za-z0-9_.-]{1,100}$/u.test(requirement.id || '')
      || requirement.name !== '@aily-project/tool-' + requirement.id || !exactVersion(requirement.version)) {
    throw fault('UPLOAD_UNSUPPORTED', 'Cloud upload requires an exact uploader tool package.');
  }
  const packageFile = path.join(appDataPath, 'node_modules', ...requirement.name.split('/'), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(regular(packageFile), 'utf8'));
  if (pkg.name !== requirement.name || pkg.version !== requirement.version) throw fault('UPLOADER_MISSING', `Install ${requirement.name}@${requirement.version} for local upload.`);
  const base = path.join(appDataPath, 'tools');
  const prefix = requirement.id + '@';
  const names = fs.readdirSync(base).filter(name => name.startsWith(prefix)
    && runtimeVersionMatches(name.slice(prefix.length), requirement.version));
  if (names.length !== 1) throw fault('UPLOADER_MISSING', `The exact local resource for ${requirement.name}@${requirement.version} is missing or ambiguous.`);
  const directory = path.join(base, names[0]);
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw fault('UNSAFE_PATH', 'Local upload dependencies must be physical package directories.');
  return { directory, runtimeVersion:names[0].slice(prefix.length) };
}
function verifyStagedUpload(record, staged) {
  for (const artifact of record.manifest.artifacts) {
    const bytes = fs.readFileSync(regular(path.join(staged.buildPath,...artifact.path.split('/'))));
    if (bytes.length !== artifact.sizeBytes || protocol.sha256(bytes) !== artifact.sha256) throw fault('ARTIFACT_INVALID','The fixed cloud upload copy changed.');
  }
}
function verifyRecipeFirmwarePaths(command, buildPath) {
  const normalized=String(command||'').replace(/\\/gu,'/'),root=buildPath.replace(/\\/gu,'/');
  const escaped=root.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  const pattern=new RegExp(`${escaped}/[^"\\r\\n]*?\\.(?:bin|hex|elf|eep|img|uf2|dfu|zip)(?=["\\s,:}]|$)`,'giu');
  for(const match of normalized.matchAll(pattern)) {
    const filename=path.resolve(match[0]);regular(filename);
    if(!fs.statSync(filename).size)throw fault('ARTIFACT_INVALID','The cloud upload recipe references empty firmware.');
  }
}
function boardUploadConfig(record, request, staged, appDataPath) {
  const checked=checkedBoard(record), board=staged.cloudRecipeBoardOverrides||checked.board, debuggerUpload=request.portType === 'debugger';
  let value=debuggerUpload ? board.linkUploadParam : board.uploadParam;
  const flags={};
  if (typeof value === 'object' && value) { Object.assign(flags,value.flags||{}); value=value.param||value.command||''; }
  if (typeof value !== 'string') value='';
  value=value.replace(/\[((?:--?\w+(?:=\S+)?)(?:,--?\w+(?:=\S+)?)*)\]\s*/gu,(_match,group) => {
    for(const item of group.split(',')) { const matched=item.trim().match(/--?(\w+)(?:=(\S+))?/u);if(matched)flags[matched[1]]=matched[2]===undefined?true:matched[2]; }
    return '';
  }).trim().replace(/\s+/gu,' ');
  if (debuggerUpload && !value) throw fault('UPLOAD_UNSUPPORTED','The board has no local debugger upload configuration.');
  if (!['serial','debugger'].includes(request.portType||'serial')) throw fault('UPLOAD_UNSUPPORTED','Cloud upload requires a serial port or debugger.');
  for (const key of ['serialPort','portText','probeSerial','probeVidPid','pnum']) {
    if (request[key] !== undefined && request[key] !== null && (typeof request[key] !== 'string' || request[key].length > 256 || /[\x00-\x1f]/u.test(request[key]))) throw fault('UPLOAD_INVALID','Invalid local device selection.');
  }
  if (request.pnum && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(request.pnum)) throw fault('UPLOAD_INVALID','Invalid selected chip identifier.');
  if (request.probeSerial && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(request.probeSerial)) throw fault('UPLOAD_INVALID','Invalid debug probe serial identifier.');
  if (request.probeVidPid && !/^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}$/u.test(request.probeVidPid)) throw fault('UPLOAD_INVALID','Invalid debug probe USB identity.');
  if (!debuggerUpload && !/^COM[1-9]\d{0,3}$/iu.test(request.serialPort||'')) throw fault('UPLOAD_INVALID','Select a physical Windows serial port.');
  return {currentProjectPath:record.root,boardModule:record.manifest.boardModule,appDataPath,...staged,
    serialPort:request.serialPort,portType:request.portType||'serial',portText:request.portText||'',probeSerial:request.probeSerial||'',probeVidPid:request.probeVidPid||'',pnum:request.pnum||null,
    uploadParam:value,use_1200bps_touch:!debuggerUpload && !!flags.use_1200bps_touch,
    wait_for_upload:!debuggerUpload && !!(flags.wait_for_upload_port||flags.wait_for_upload),restrictToolSearch:true};
}
async function runCloudUpload(record, request, {staged,workspace,appDataPath,signal,onOutput=()=>{},assertCurrent,markDelegated,launch=spawn}={}) {
  verifyStagedUpload(record,staged); await assertCurrent(); signal.throwIfAborted();
  const networkUpload=request.portType==='network-ota';
  const config=networkUpload ? networkUploadConfig(record,request,staged) : boardUploadConfig(record,request,staged,appDataPath), configPath=path.join(workspace,'upload-config.json');
  const metadata=JSON.parse(fs.readFileSync(staged.preprocessPath,'utf8'));
  if(!networkUpload && config.portType!=='debugger' && !config.uploadParam)verifyRecipeFirmwarePaths(metadata.upload?.command,staged.buildPath);
  fs.writeFileSync(configPath,JSON.stringify(config),{flag:'wx'});
  markDelegated?.();
  return new Promise((resolve,reject) => {
    const child=launch(localNodeExecutable(),[path.join(childRoot,networkUpload?'scripts/network-ota-upload.js':'scripts/upload.js'),configPath],{
      cwd:staged.buildPath,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:localNodeEnvironment() });
    let stopping;
    const stop=() => { stopping ||= (async()=> {
      if(!child.pid || child.exitCode !== null)return;
      if(process.platform==='win32') await new Promise((done,fail)=>{
        const killer=spawn(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
        killer.once('error',error=>fail(Object.assign(error,{cleanupConfirmed:false})));killer.once('close',code=>code===0||child.exitCode!==null?done():fail(Object.assign(fault('UPLOAD_STOP_FAILED','Upload process tree could not be stopped.'),{cleanupConfirmed:false})));
      });
      else {try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    })(); stopping.catch(()=>{}); };
    signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    for(const type of ['stdout','stderr'])child[type]?.on('data',data=>onOutput({type,data:data.toString()}));
    child.once('error',reject);child.once('close',async(code,exitSignal)=>{
      signal.removeEventListener('abort',stop);
      try{if(stopping)await stopping;onOutput({type:'close',code:code??1,signal:exitSignal||undefined});resolve({success:code===0&&!exitSignal&&!signal.aborted,code:code??1,signal:exitSignal});}catch(error){reject(error);}
    });
  });
}
function networkUploadConfig(record,request,staged){
  const target=request.networkTarget;
  if(!target||typeof target!=='object'||Array.isArray(target)||Object.keys(target).some(key=>!['id','name','host','port','username','password','uploadPath','ssl','timeoutMs'].includes(key)))throw fault('UPLOAD_INVALID','Invalid local network upload target.');
  if(typeof target.host!=='string'||!target.host.length||target.host.length>253||!/^[A-Za-z0-9._:\[\]-]+$/u.test(target.host)
      ||!Number.isInteger(target.port)||target.port<1||target.port>65535)throw fault('UPLOAD_INVALID','Invalid local network upload address.');
  for(const key of ['username','password','uploadPath'])if(typeof target[key]!=='string'||target[key].length>4096||/[\x00\r\n]/u.test(target[key]))throw fault('UPLOAD_INVALID','Invalid local network upload credentials or endpoint.');
  if(!target.uploadPath.startsWith('/')||typeof target.ssl!=='boolean'||!Number.isInteger(target.timeoutMs)||target.timeoutMs<1000||target.timeoutMs>600000)throw fault('UPLOAD_INVALID','Invalid local network upload options.');
  const primary=record.manifest.flashPlan.segments[0].path;
  if(!primary.endsWith('.bin'))throw fault('UPLOAD_UNSUPPORTED','Network upload requires the signed application BIN image.');
  return {firmwarePath:path.join(staged.buildPath,...primary.split('/')),host:target.host,port:target.port,username:target.username,password:target.password,uploadPath:target.uploadPath,ssl:target.ssl,timeoutMs:target.timeoutMs};
}
module.exports={checkedBoard,localDependencyPath,runtimeVersionMatches,verifyStagedUpload,verifyRecipeFirmwarePaths,boardUploadConfig,networkUploadConfig,runCloudUpload};
