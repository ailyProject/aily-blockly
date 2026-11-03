'use strict';
// Canonical contract; the Gateway and desktop copies are synchronized verbatim.
const PLAN = 'cloud-upload-v1';
const PROTOCOL = 'cloud-recipe';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const exact = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const fail = message => { throw Object.assign(new Error(message), {code:'CLOUD_RECIPE_INVALID'}); };
function keys(value, allowed, label) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Invalid '+label+' fields.');
}
function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value !== value.normalize('NFC') || /[\\\x00-\x1f<>:"|?*]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('Invalid recipe resource path.');
  return value;
}
function isCompilerTool(id) {
  return /(?:^|[-_])(?:gcc|clang|toolchain)(?:[-_]|$)|^(?:esp-x32|esp-rv32|ctags|pqt-pioasm)$/iu.test(id);
}
function needsPqtOpenocd(recipe) {
  return recipe?.sdkIdentity?.package==='@aily-project/sdk-rp2040' && recipe.sdkIdentity.version==='5.1.0'
    && recipe.hostPlatform==='win32' && recipe.hostArch==='x64'
    && recipe.fqbn.split(':').slice(3).join(':').split(',').includes('uploadmethod=picoprobe_cmsis_dap');
}
function validateCloudRecipePlan(plan, artifacts, identity={}) {
  keys(plan,['schemaVersion','profileId','digest','profileDigest','protocol','uploaderId','targetChip','segments','options','lifecycle','recipe'],'cloud recipe plan');
  if (plan.schemaVersion !== 1 || plan.protocol !== PROTOCOL || plan.uploaderId !== 'windows-sdk' || !/^[A-Za-z0-9_-]{1,128}$/u.test(plan.targetChip||'')) fail('Unsupported cloud upload recipe.');
  if (identity.profileDigest && (plan.profileDigest !== identity.profileDigest || (plan.digest !== undefined && plan.digest !== identity.profileDigest))) fail('Cloud recipe profile mismatch.');
  keys(plan.options,[],'recipe options'); keys(plan.lifecycle,['reset','verify'],'recipe lifecycle');
  if (plan.lifecycle.reset !== PROTOCOL || plan.lifecycle.verify !== true) fail('Invalid recipe lifecycle.');
  if (!Array.isArray(artifacts) || !artifacts.length || artifacts.length > 128 || !Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length > artifacts.length) fail('Invalid recipe inventory.');
  const refs=new Set(), assetRefs=new Set(), allPaths=new Set();
  for (const file of artifacts) { relative(file.path); if (allPaths.has(file.path.toLowerCase()) || !hash(file.sha256) || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes<0) fail('Invalid recipe artifact.'); allPaths.add(file.path.toLowerCase()); }
  const bind = (value,kind) => {
    const file=artifacts.find(item => item.artifactId===value.artifactId && item.path===value.path);
    if (!file || !hash(value.sha256) || file.sha256!==value.sha256 || refs.has(file.artifactId) || (kind==='resource' ? file.role!=='upload-resource' : file.role==='upload-resource' || file.sizeBytes===0)) fail('Recipe artifact reference mismatch.');
    refs.add(file.artifactId); return file;
  };
  for (const segment of plan.segments) {
    keys(segment,['artifactId','path','sha256'],'recipe firmware'); relative(segment.path);
    if (!/\.(?:hex|bin|elf|eep|img|uf2|dfu|zip)$/iu.test(segment.path)) fail('Invalid recipe firmware type.'); bind(segment,'firmware');
  }
  const recipe=plan.recipe; keys(recipe,['schemaVersion','hostPlatform','hostArch','fqbn','upload','boardOverrides','tools','sdkAssets','sdkIdentity'],'resolved recipe');
  if (recipe.schemaVersion!==1 || recipe.hostPlatform!=='win32' || recipe.hostArch!=='x64' || !/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+(?::[A-Za-z0-9_.=,-]+)?$/u.test(recipe.fqbn||'') || recipe.fqbn.split(':')[2]!==plan.targetChip) fail('Invalid recipe target host or board.');
  if (identity.fqbn && recipe.fqbn.split(':').slice(0,3).join(':')!==identity.fqbn) fail('Cloud recipe board mismatch.');
  keys(recipe.sdkIdentity,['package','version','sourceFiles'],'recipe SDK identity');
  if (!/^@aily-project\/sdk-[A-Za-z0-9_.-]+$/u.test(recipe.sdkIdentity.package||'') || !exact(recipe.sdkIdentity.version) || !Array.isArray(recipe.sdkIdentity.sourceFiles) || !recipe.sdkIdentity.sourceFiles.length || recipe.sdkIdentity.sourceFiles.length>4) fail('Invalid recipe SDK provenance.');
  const sourceNames=new Set(); for (const file of recipe.sdkIdentity.sourceFiles) { keys(file,['path','sha256'],'SDK source identity'); if (!/^(?:boards|platform)(?:\.local)?\.txt$/u.test(file.path||'') || !hash(file.sha256) || sourceNames.has(file.path)) fail('Invalid recipe SDK source identity.'); sourceNames.add(file.path); }
  if (!sourceNames.has('boards.txt') || !sourceNames.has('platform.txt')) fail('Recipe SDK source identity is incomplete.');
  if (!Array.isArray(recipe.tools) || recipe.tools.length>32) fail('Invalid recipe tool inventory.');
  const toolIds=new Set(); for (const tool of recipe.tools) {
    keys(tool,['id','package','version'],'recipe tool');
    if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(tool.id||'') || tool.package!=='@aily-project/tool-'+tool.id || !exact(tool.version) || toolIds.has(tool.id) || isCompilerTool(tool.id)) fail('Cloud upload may request only exact uploader tool packages.'); toolIds.add(tool.id);
  }
  if (!Array.isArray(recipe.sdkAssets) || recipe.sdkAssets.length>120) fail('Invalid recipe upload resources.');
  for (const asset of recipe.sdkAssets) {
    keys(asset,['artifactId','path','sha256','sdkPath','kind'],'SDK upload resource'); relative(asset.path); relative(asset.sdkPath);
    if (!['script','static','executable'].includes(asset.kind) || asset.path!=='upload-resources/'+asset.sdkPath || /^(?:cores|libraries)\//u.test(asset.sdkPath) || assetRefs.has(asset.sdkPath.toLowerCase())) fail('Invalid upload resource mapping.');
    bind(asset,'resource'); assetRefs.add(asset.sdkPath.toLowerCase());
  }
  if (refs.size!==artifacts.length) fail('Recipe must account for every signed artifact.');
  const text = (value, sdkAvrdude=false) => {
    if (typeof value!=='string' || value.length>65536 || /[\x00\r\n]/u.test(value) || /(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\|\/(?:Volumes|Users|home|srv|tmp|private)\/)/u.test(value)) fail('Recipe contains an invalid or compiler-host path.');
    for (const match of value.matchAll(/(^|[\s"'=])(\/[^\s"'<>|;]*)/gu)) {
      if (match.index===0 || !/^\/(?:[bcdksqu]|[vef]:(?:on|off))$/iu.test(match[2])) fail('Recipe contains an absolute POSIX path.');
    }
    const avrdudeCommand=sdkAvrdude && toolIds.has('avrdude') && /^"__AILY_TOOL_avrdude__[\\/](?:bin[\\/])?avrdude(?:\.exe)?"(?:\s|$)/iu.test(value);
    const avrdudeImages=new Set();
    if (sdkAvrdude) for (const operand of value.matchAll(/(?:^|\s)("?)-U(flash|eeprom):w:/gu)) {
      // Accept both Arduino quote styles without treating the format selector
      // as part of the filename. Bare drive/UNC paths also fail this grammar.
      const start=operand.index+operand[0].length,tail=value.slice(start);
      const filenameQuoted=!operand[1] && tail.startsWith('"');
      const image=operand[1] ? tail.match(/^(__AILY_BUILD__[\\/][^"]+):i"(?=\s|$)/u)
        : filenameQuoted ? tail.match(/^"(__AILY_BUILD__[\\/][^"]+)":i(?=\s|$)/u)
        : tail.match(/^(__AILY_BUILD__[\\/][^\s"]+):i(?=\s|$)/u);
      if (!avrdudeCommand || !image) fail('Invalid avrdude firmware write operand.');
      const file=relative(image[1].slice('__AILY_BUILD__'.length+1).replace(/\\/gu,'/'));
      if (!(operand[2]==='eeprom' ? /\.(?:hex|eep)$/u.test(file) : file.endsWith('.hex')) || !plan.segments.some(segment=>segment.path===file)) fail('Avrdude write must reference signed BUILD firmware.');
      avrdudeImages.add(start+(filenameQuoted?1:0));
    }
    for (const match of value.matchAll(/(__AILY_[A-Za-z0-9_.-]+?__)([^"'\s;|<>]*)/gu)) {
      const [,token,suffix]=match;
      if (suffix) {
        let pathSuffix=suffix;
        // AVR's complete -U operand ends in an input-format selector, not a
        // Windows stream/path suffix. Permit only Intel HEX writes of signed
        // BUILD firmware through the declared, selected avrdude executable.
        if (token==='__AILY_BUILD__' && avrdudeImages.has(match.index) && suffix.endsWith(':i')) pathSuffix=suffix.slice(0,-2);
        if (!/^[\\/]/u.test(pathSuffix)) fail('Recipe path token has an invalid suffix.');
        let depth=0; for (const part of pathSuffix.replace(/\\/gu,'/').split('/').slice(1)) {
          if (!part || part==='.') continue;
          if (part==='..') { if (--depth<0) fail('Recipe path escapes its approved local root.'); }
          else { if (part.includes(':')) fail('Recipe token contains a second absolute path.'); depth++; }
        }
      }
      if (['__AILY_BUILD__','__AILY_SDK__','__AILY_SKETCH__'].includes(token)) continue;
      const id=token.match(/^__AILY_TOOL_(.+)__$/u)?.[1]; if (!id || (!toolIds.has(id) && !(id==='pqt-openocd' && needsPqtOpenocd(recipe)))) fail('Recipe references an undeclared uploader tool.');
    }
  };
  if (recipe.upload!==null) { keys(recipe.upload,['command','toolName','use1200bpsTouch','waitForUploadPort'],'SDK upload metadata'); text(recipe.upload.command,recipe.upload.toolName==='avrdude'); if (!recipe.upload.command || typeof recipe.upload.toolName!=='string' || typeof recipe.upload.use1200bpsTouch!=='boolean' || typeof recipe.upload.waitForUploadPort!=='boolean') fail('Invalid resolved SDK upload metadata.'); }
  keys(recipe.boardOverrides,['uploadParam','linkUploadParam'],'board upload overrides');
  for (const value of Object.values(recipe.boardOverrides)) {
    if (value===null || value===undefined) continue;
    if (typeof value==='string') text(value);
    else { keys(value,['param','command','flags'],'board upload override'); if (value.param!==undefined) text(value.param); if (value.command!==undefined) text(value.command); if (value.flags!==undefined && (!plain(value.flags) || Object.keys(value.flags).some(key=>!['use_1200bps_touch','wait_for_upload_port','wait_for_upload'].includes(key)) || Object.values(value.flags).some(flag=>typeof flag!=='boolean'))) fail('Invalid board upload flags.'); }
  }
  return plan;
}
module.exports={PLAN,PROTOCOL,validateCloudRecipePlan,isCompilerTool,needsPqtOpenocd};
