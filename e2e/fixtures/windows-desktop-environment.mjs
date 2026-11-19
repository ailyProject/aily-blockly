import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sha=value=>createHash('sha256').update(value).digest('hex')
const injected=new Set(['PATH','PSMODULEPATH','PSHOME','NODE_PATH','NODE_OPTIONS','ELECTRON_RUN_AS_NODE',
  'AILY_APPDATA_PATH','AILY_MAIN_APPDATA_PATH','AILY_API_SERVER','AILY_AUTH_FILE','AILY_REPAIR_BOOTSTRAP',
  'AILY_REPAIR_READONLY_NPM_PREFIX','AILY_LIBRARY_HOST_PID','PI_CODING_AGENT_DIR','AILY_CHILD_PATH',
  'AILY_PORTABLE_ROOT','AILY_DEV_RENDERER_URL'])
const blocked=key=>injected.has(key.toUpperCase())||/^CODEX_/i.test(key)||/^OPENAI_CODEX_/i.test(key)
const codexBundled=value=>/OpenAI\.CodexPrimaryRuntime|[\\/]\.codex[\\/]|[\\/]Codex(?:Primary)?Runtime[\\/]/i.test(value)

/** Build a child-only Windows GUI environment from normal registry PATH. No
 * registry/global/process.env value is written; Aily may add its own tools. */
export async function normalDesktopEnvironment({inherited=process.env,sdkShellModule,sdkPackageFile,nodeExecutable=process.execPath}={}) {
  assert.equal(process.platform,'win32','The normal Windows desktop fixture is only supported on Windows')
  assert.ok(path.isAbsolute(sdkShellModule??'')&&path.isAbsolute(sdkPackageFile??'')&&path.isAbsolute(nodeExecutable),'Pass the actual installed/current SDK resolver and Node executable explicitly')
  const env={...inherited}, removed=[]
  for(const key of Object.keys(env))if(blocked(key)){removed.push(key);delete env[key]}
  const systemRoot=Object.entries(inherited).find(([key])=>key.toUpperCase()==='SYSTEMROOT')?.[1]??'C:\\Windows'
  const registryShell=path.join(systemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
  await fs.access(registryShell)
  const registryScript=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$machine=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
$user=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
function Read-EnvironmentKey($key) {
  $values=@{}
  foreach($name in $key.GetValueNames()) {
    $value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if($value -is [string]) {$values[$name]=$value}
  }
  return $values
}
@{machine=Read-EnvironmentKey $machine;user=Read-EnvironmentKey $user} | ConvertTo-Json -Depth 4 -Compress
`
  let registryText,registry
  try { registryText=execFileSync(registryShell,['-NoLogo','-NoProfile','-NonInteractive','-Command',registryScript],
    {env,encoding:'utf8',windowsHide:true,timeout:15000}) }
  catch { throw Error('Readonly normal Windows registry environment query failed; raw environment output omitted.') }
  try { registry=JSON.parse(registryText.replace(/^\uFEFF/,'')) }
  catch { throw Error('Readonly normal Windows registry query returned invalid JSON; raw environment output omitted.') }
  const context=new Map(Object.entries(inherited).filter(([key])=>key.toUpperCase()!=='PATH').map(([key,value])=>[key.toUpperCase(),value]))
  for(const values of [registry.machine,registry.user])for(const [key,value]of Object.entries(values))if(key.toUpperCase()!=='PATH')context.set(key.toUpperCase(),value)
  const expand=value=>{
    let result=value
    for(let count=0;count<12;count++){
      const next=result.replace(/%([^%]+)%/g,(match,name)=>context.get(name.toUpperCase())??match)
      if(next===result)return result
      result=next
    }
    throw Error('Recursive registry environment expansion')
  }
  const rawPath=values=>Object.entries(values).find(([key])=>key.toUpperCase()==='PATH')?.[1]??''
  const machineRaw=rawPath(registry.machine),userRaw=rawPath(registry.user)
  assert.ok(machineRaw&&userRaw,'Read both normal Machine and User registry PATH sources')
  const machineExpanded=expand(machineRaw)
  context.set('PATH',machineExpanded)
  const userExpanded=expand(userRaw)
  const entries=[],seen=new Set()
  for(const entry of [machineExpanded,userExpanded].flatMap(value=>value.split(';'))){
    const value=entry.trim().replace(/^"|"$/g,'')
    if(!value)continue
    assert.ok(!/%[^%]+%/.test(value),'Unresolved normal registry PATH variable: '+value)
    const key=path.resolve(value).toLowerCase()
    if(!seen.has(key)){seen.add(key);entries.push(value)}
  }
  env.Path=entries.join(';')
  context.set('PATH',env.Path)
  // Restore normal registered SDK/tool variables as well as PATH. Volatile
  // tool-injected PowerShell/Node variables remain absent in this child.
  for(const values of [registry.machine,registry.user])for(const [key,value]of Object.entries(values))if(!blocked(key)){
    for(const old of Object.keys(env))if(old.toUpperCase()===key.toUpperCase())delete env[old]
    env[key]=expand(value)
  }
  const sdkFile=await fs.realpath(sdkShellModule),packageFile=await fs.realpath(sdkPackageFile)
  const sdkPackage=JSON.parse(await fs.readFile(packageFile,'utf8'))
  const moduleRelative=path.relative(path.dirname(packageFile),sdkFile)
  assert.ok(moduleRelative&&!moduleRelative.startsWith('..')&&!path.isAbsolute(moduleRelative),'The shell resolver must belong to the reported SDK package')
  assert.equal(sdkPackage.name,'@earendil-works/pi-coding-agent')
  const probe=`import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
const {getPowerShellConfig}=await import(${JSON.stringify(pathToFileURL(sdkFile).href)});
const config=getPowerShellConfig();
assert.ok(!/OpenAI\\.CodexPrimaryRuntime|[\\\\/]\\.codex[\\\\/]|[\\\\/]Codex(?:Primary)?Runtime[\\\\/]/i.test(config.shell),'Normal desktop must not select Codex bundled PowerShell');
const command="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);Get-Command Get-FileHash -ErrorAction Stop | Select-Object Name,Source,CommandType | ConvertTo-Json -Compress";
const found=JSON.parse(execFileSync(config.shell,[...config.args,command],{env:process.env,encoding:'utf8',windowsHide:true,timeout:15000}).replace(/^\\uFEFF/,''));
assert.equal(found.Name,'Get-FileHash');process.stdout.write(JSON.stringify({shell:config.shell,args:config.args,getFileHash:found,node:process.execPath,psModulePathInherited:Object.keys(process.env).some(k=>k.toUpperCase()==='PSMODULEPATH')}));`
  let selected
  try { selected=JSON.parse(execFileSync(nodeExecutable,['--input-type=module','-e',probe],{env,encoding:'utf8',windowsHide:true,timeout:30000})) }
  catch { throw Error('Readonly SDK PowerShell resolver/Get-Command probe failed; raw process output omitted.') }
  assert.ok(!codexBundled(selected.shell));assert.equal(selected.psModulePathInherited,false)
  return {env,report:{scope:'Electron-child-only',pathSources:{machine:'HKLM/SYSTEM/CurrentControlSet/Control/Session Manager/Environment/Path',
    user:'HKCU/Environment/Path',machineRawSha256:sha(machineRaw),userRawSha256:sha(userRaw),entryCount:entries.length,pathSha256:sha(env.Path)},removedInheritedKeys:removed.sort(),
    sdk:{name:sdkPackage.name,version:sdkPackage.version,module:sdkFile,sha256:sha(await fs.readFile(sdkFile))},selected,
    registryChanged:false,globalEnvironmentChanged:false,dependenciesInstalled:false}}
}
