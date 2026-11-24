'use strict';
// Verify the signed cloud recipe before binding resources or selecting a local uploader.
const fs=require('node:fs'),path=require('node:path');
const protocol=require('./protocol');
const local=require('./cloud-upload-runtime');
const {validateCloudRecipePlan,needsPqtOpenocd}=require('./cloud-recipe-contract');
const {selectMacCloudUpload,nativeSerialExecutable}=require('./cloud-native-upload');
const childRoot=process.env.AILY_CHILD_PATH||path.resolve(__dirname,'../../child');
const {ensurePqtOpenocd}=require(path.join(childRoot,'scripts/pqt-openocd'));
function checkedRecipe(record){
  protocol.verifyManifest(record.manifest,record.signature,record.publicKey);
  const plan=validateCloudRecipePlan(record.manifest.flashPlan,record.manifest.artifacts,{profileDigest:record.manifest.profileDigest,fqbn:record.profile.fqbn});
  if(record.manifest.action!=='compile'||record.manifest.fixture||record.manifest.runner!=='aily-builder')throw protocol.error('UPLOAD_UNSUPPORTED','This is not a native cloud compilation result.');
  const {pkg}=local.checkedBoard(record),recipe=plan.recipe;
  if(pkg.boardDependencies?.[recipe.sdkIdentity.package]!==recipe.sdkIdentity.version
    ||recipe.tools.some(tool=>pkg.boardDependencies?.[tool.package]!==tool.version))throw protocol.error('BUILD_SOURCE_STALE','The cloud upload recipe dependencies differ from the signed board package.');
  return recipe;
}
function cloudUploadRoute(record, {portType='serial', platform=process.platform, arch=process.arch}={}){
  const recipe=checkedRecipe(record);
  if(platform===recipe.hostPlatform && arch===recipe.hostArch){
    return {recipe,requirements:recipe.tools.map(tool=>({kind:'tool',name:tool.package,version:tool.version,id:tool.id}))};
  }
  const nativeUpload=platform==='darwin' && ['arm64','x64'].includes(arch)
    ? selectMacCloudUpload(record.manifest,recipe,portType) : null;
  if(!nativeUpload)throw protocol.error('UPLOAD_UNSUPPORTED','The returned upload recipe targets a different desktop platform and has no compatible local upload route.');
  return {recipe,nativeUpload,requirements:nativeUpload.serial?[nativeUpload.serial.requirement]:[]};
}
function cloudUploadRequirements(record, options){
  const {requirements,nativeUpload}=cloudUploadRoute(record,options);
  return{protocol:'cloud-recipe',requirements,...(nativeUpload?.serial?{nativeSerial:true}:{})};
}
function bindRecipe(value,bindings){
  if(typeof value==='string'){
    let result=value;for(const [token,directory]of Object.entries(bindings))result=result.split(token).join(directory.replace(/\\/gu,'/'));
    if(/__AILY_[A-Za-z0-9_.-]+__/u.test(result))throw protocol.error('UPLOAD_UNSUPPORTED','An upload recipe path has no verified local binding.');
    return result;
  }
  if(Array.isArray(value))return value.map(item=>bindRecipe(item,bindings));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,bindRecipe(item,bindings)]));
  return value;
}
function regular(filename){const stat=fs.lstatSync(filename);if(!stat.isFile()||stat.isSymbolicLink()||fs.realpathSync(filename)!==filename)throw protocol.error('UNSAFE_PATH','The signed upload resource must be a physical file.');return filename;}
async function stageCloudRecipeUpload(record,{workspace,appDataPath,sourceIdentity,signal,portType,platform,arch,prepareOptionalOpenocd=ensurePqtOpenocd}={}){
  const {recipe,nativeUpload,requirements}=cloudUploadRoute(record,{portType,platform,arch});signal?.throwIfAborted();
  const buildPath=path.join(workspace,'build'),toolsPath=path.join(workspace,'tools'),sdkPath=path.join(buildPath,'upload-resources');
  fs.mkdirSync(buildPath);
  let bindings;
  if(nativeUpload){
    if(nativeUpload.serial){
      const {requirement}=nativeUpload.serial;
      nativeSerialExecutable(local.localDependencyPath(appDataPath,requirement).directory,requirement.id);
    }
  }else{
    fs.mkdirSync(toolsPath);fs.mkdirSync(sdkPath);
    bindings={__AILY_BUILD__:buildPath,__AILY_SDK__:sdkPath,__AILY_SKETCH__:path.dirname(path.join(record.root,...sourceIdentity.entry.split('/')))};
    for(const requirement of requirements){
      const resource=local.localDependencyPath(appDataPath,requirement);
      bindings[`__AILY_TOOL_${requirement.id}__`]=resource.directory;
      fs.symlinkSync(resource.directory,path.join(toolsPath,`${requirement.id}@${resource.runtimeVersion}`),'junction');
    }
    if(needsPqtOpenocd(recipe)){
      const resource=await prepareOptionalOpenocd({sdkIdentity:recipe.sdkIdentity,boardOptions:{uploadmethod:'picoprobe_cmsis_dap'},toolsRoot:path.join(appDataPath,'tools'),signal});
      if(!resource)throw protocol.error('UPLOADER_MISSING','The selected cloud upload recipe requires its pinned OpenOCD tool.');
      bindings['__AILY_TOOL_pqt-openocd__']=resource.directory;
      fs.symlinkSync(resource.directory,path.join(toolsPath,`pqt-openocd@${resource.runtimeVersion}`),'junction');
    }
  }
  for(const artifact of record.manifest.artifacts){
    signal?.throwIfAborted();const bytes=fs.readFileSync(regular(path.join(record.directory,...artifact.path.split('/'))));
    if(bytes.length!==artifact.sizeBytes||protocol.sha256(bytes)!==artifact.sha256)throw protocol.error('ARTIFACT_INVALID','A signed cloud upload file changed.');
    const filename=path.join(buildPath,...artifact.path.split('/'));fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,bytes,{flag:'wx'});
  }
  const staged={buildPath,uploadArtifactInventory:{primary:record.manifest.flashPlan.segments[0].path,
    files:record.manifest.flashPlan.segments.map(segment=>segment.path)}};
  if(nativeUpload)return{...staged,nativeUpload};
  const preprocessPath=path.join(workspace,'preprocess.json'),upload=bindRecipe(recipe.upload,bindings);
  fs.writeFileSync(preprocessPath,JSON.stringify({upload}),{flag:'wx'});
  return{...staged,preprocessPath,sdkDirectory:sdkPath,toolsPath,cloudRecipeSdkIdentity:{package:recipe.sdkIdentity.package,version:recipe.sdkIdentity.version},cloudRecipeBoardOverrides:bindRecipe(recipe.boardOverrides,bindings)};
}
module.exports={checkedRecipe,cloudUploadRequirements,bindRecipe,stageCloudRecipeUpload};
