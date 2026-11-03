'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const ts=require('typescript');
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
const protocol=require('../../../electron/cloud-build/protocol');
const {parsePartitionCsv,validatePartitions,parseFlashSize}=require('../../../src/app/services/shared/partitions/partition-layout.ts');
const writeJson=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2));};
function verifyPartitionBinary(file, csv, flashBytes) {
  const parsed = parsePartitionCsv(csv);
  assert.deepEqual(parsed.errors, []);
  const layout = validatePartitions(parsed.rows, flashBytes);
  assert.deepEqual(layout.errors, []);
  const rows = layout.partitions;
  const bytes = fs.readFileSync(file);
  let count = 0;
  while (count * 32 + 32 <= bytes.length && bytes.readUInt16LE(count * 32) === 0x50aa) count++;
  assert.equal(count, rows.length, 'Binary must contain exactly the CSV partition entries');
  rows.forEach((row, index) => {
    const offset = index * 32;
    assert.equal(bytes.readUInt16LE(offset), 0x50aa);
    assert.equal(bytes[offset + 2], row.typeId); assert.equal(bytes[offset + 3], row.subtypeId);
    assert.equal(bytes.readUInt32LE(offset + 4), row.offsetBytes); assert.equal(bytes.readUInt32LE(offset + 8), row.sizeBytes);
    assert.equal(bytes.subarray(offset + 12, offset + 28).toString().replace(/\0.*$/, ''), row.name);
    const flags = row.flags.split(':');
    assert.equal(bytes.readUInt32LE(offset + 28), (flags.includes('encrypted') ? 1 : 0) | (flags.includes('readonly') ? 2 : 0));
  });
}
async function startCloud(rt,project,seed,cloudRoot){
  const {output, until} = rt; const boardModule='@aily-project/board-esp32s3';
  const boardRoot=path.join(project,'node_modules',boardModule), boardPkg=JSON.parse(fs.readFileSync(path.join(boardRoot,'package.json'))),board=JSON.parse(fs.readFileSync(path.join(boardRoot,'board.json')));
  const snapshotProfile={runner:'aily-builder',boardModule,boardVersion:boardPkg.version,boardDigest:protocol.boardDigest(boardPkg,board)};
  const sdk = path.join(seed, 'sdk', 'esp32_' + boardPkg.boardDependencies['@aily-project/sdk-esp32']);
  const { startGateway } = require(path.join(cloudRoot, 'builder-gateway/src'));
  const { startCompilerNode } = require(path.join(cloudRoot, 'builder-server'));
  const gateway = await startGateway({ host: '127.0.0.1', port: 0, dataDir: path.join(output, 'gateway'),
    boardCatalog: { schemaVersion: 1, boards: [{ boardModule, boardVersion: boardPkg.version, name: 'ESP32-S3' }] } });
  const builderEntryPath = process.env.PARTITION_CLOUD_BUILDER || path.join(cloudRoot, 'builder-server/compiler/runtime/aily-builder.js');
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(builderEntryPath), 'package.json'))).version;
  const profile = { id: 'partition-acceptance', ...snapshotProfile, boardPackagePath: boardRoot, fqbn: board.type,
    builderVersion: version, builderEntryPath, sdkPath: sdk, toolsPath: path.join(seed, 'tools'), boardsTxtPath: path.join(sdk, 'boards.txt'),
    supportedPlatforms: [process.platform], platform: process.platform, arch: process.arch, jobs: 2, compileOnly: true,
    artifactSegments: [{ path: '{sketch}.bin', role: 'firmware' }, { path: '{sketch}.partitions.bin', role: 'auxiliary' }],
    toolVersions: { 'esp-x32': '14.2.0', 'esp32s3-libs': '3.3.10', esptool_py: '5.3.0' },
    resources: { ramBytes: 512 * 1024 * 1024, diskBytes: 256 * 1024 * 1024 }, probeTimeoutMs: 240000 };
  const worker = await startCompilerNode({ workerId: 'partition-acceptance', executionProfile: 'development',
    gatewayUrl: gateway.url.replace(/^http/, 'ws') + '/api/internal/build/nodes/connect', workRoot: path.join(output, 'worker'),
    maxSlots: 1, jobsPerTask: 2, autoCapacity: { enabled: false }, profiles: [profile], minFreeDiskBytes: 256 * 1024 * 1024 });
  for (const event of ['progress', 'log', 'task-error', 'diagnostic', 'committed']) worker.on(event, value => fs.appendFileSync(path.join(output, 'worker.jsonl'), JSON.stringify({ event, value }) + '\n'));
  await until(() => gateway.nodes.size, 'worker registration');
  const serverKey = gateway.operations.statisticsServer([...gateway.nodes.values()][0].workerId).key;
  const enabled = await fetch(gateway.url + '/api/admin/servers/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverKey, boardKeys: [boardModule + '@' + boardPkg.version] }) }); assert(enabled.ok);
  const target = await until(async () => (await fetch(gateway.url + '/api/v1/build/targets').then(r => r.json())).profiles?.[0], 'real compiler probe');
  const caps = await fetch(gateway.url + '/api/v1/build/capabilities').then(r => r.json());

  await rt.application.evaluate((_,config)=>{process.env.AILY_CLOUD_BUILD_GATEWAY_URL=config.url;process.env.AILY_CLOUD_BUILD_PUBLIC_KEY=config.key;},{url:gateway.url,key:caps.publicKey});
  return {gateway,worker,caps,close:async()=>{await worker.close();await gateway.close();}};
}

async function compile(rt,project,name,cloud){
  const events=[],started=Date.now();
  rt.events=events;
  await rt.main.evaluate(async cloud=>{const c=window.ng.getComponent(document.querySelector('app-header')).configService;c.data.compile.backend=cloud?'cloud':'local';await c.saveCompileSettings();},cloud);
  const effective=await rt.main.evaluate(()=>window.ng.getComponent(document.querySelector('app-header')).configService.getCompileBackend());assert.equal(effective,cloud?'cloud':'local');
  await rt.main.locator('app-header app-act-btn[data-action="compile"]').click();
  const pkg=await rt.until(()=>{
    const p=JSON.parse(fs.readFileSync(path.join(project,'package.json')));
    if(Date.parse(p.buildInfo?.lastBuildTime||'')>=started)return p;
    const failed=events.find(e=>e.stage==='failed');if(failed)throw Error(JSON.stringify(failed));
  },name,600000);
  assert.equal(pkg.buildInfo.lastBuildStatus,'success',JSON.stringify(pkg.buildInfo));
  const csv=fs.readFileSync(path.join(project,'src/partitions.csv'),'utf8');
  const result={name,project,backend:effective,startedAt:new Date(started).toISOString(),completedAt:new Date().toISOString(),milliseconds:Date.now()-started,csvSha256:protocol.sha256(Buffer.from(csv)),flash:pkg.projectConfig.FlashSize};
  let bin;
  if(cloud){
    const complete=events.find(e=>e.stage==='complete');assert(complete,'Actual cloud completion required');
    const dir=await rt.main.evaluate(project=>window.cloudBuild.artifactPath({projectPath:project}),project);
    const receipt=JSON.parse(fs.readFileSync(path.join(dir,'aily-cloud-result.json')));
    protocol.verifyManifest(receipt.manifest,receipt.signature,rt.cloud.caps.publicKey);
    for(const file of receipt.manifest.artifacts){const bytes=fs.readFileSync(path.join(dir,file.path));assert.equal(bytes.length,file.sizeBytes);assert.equal(protocol.sha256(bytes),file.sha256);}
    Object.assign(result,{reused:!!complete.reused,jobId:receipt.manifest.jobId,inputDigest:receipt.manifest.inputDigest,artifacts:receipt.manifest.artifacts});
    writeJson(path.join(rt.output,name+'-receipt.json'),receipt);bin=path.join(dir,'sketch.partitions.bin');
  }else{
    assert.equal(fs.readFileSync(path.join(project,'.temp/sketch/partitions.csv'),'utf8'),csv);
    bin=path.join(project,'.build/sketch.partitions.bin');result.firmwareBytes=fs.statSync(path.join(project,'.build/sketch.bin')).size;
  }
  verifyPartitionBinary(bin,csv,parseFlashSize(pkg.projectConfig.FlashSize));
  fs.copyFileSync(bin,path.join(rt.output,name+'.partitions.bin'));fs.writeFileSync(path.join(rt.output,name+'.csv'),csv);
  rt.report.checks.push(result);writeJson(path.join(rt.output,'report.json'),rt.report);
  return result;
}
async function attach(rt){await rt.main.exposeFunction('__partitionProjectEvent',e=>{rt.events?.push(e);fs.appendFileSync(path.join(rt.output,'cloud-events.jsonl'),JSON.stringify(e)+'\n');});await rt.main.evaluate(()=>window.cloudBuild.onProgress(e=>window.__partitionProjectEvent(e)));}
module.exports={startCloud,compile,attach,verifyPartitionBinary};
