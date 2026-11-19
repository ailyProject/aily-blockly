import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {start} from './fixtures/partition-projects-runtime.mjs';
const require=createRequire(import.meta.url), build=require('./fixtures/partition-projects-build.cjs');
const clone=(source,dest)=>fs.cpSync(source,dest,{recursive:true,dereference:true,filter:f=>!['.build','.temp','.aily','.log','.workspace-history'].includes(path.relative(source,f).split(path.sep)[0])});
const hashSource=project=>{
 const files=[];
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name),rel=path.relative(project,file);if(entry.isDirectory()){if(!['node_modules','.build','.temp','.aily','.log','.workspace-history','.git'].includes(entry.name))walk(file);}else if(entry.name!=='partitions.csv'&&(/\.(abs|abi|ino|cpp|h|c)$/.test(entry.name))) files.push([rel,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);}}
 walk(project);return files.sort((a,b)=>a[0].localeCompare(b[0]));
};
let rt,agent,activeSession;
try{
 rt=await start();await build.attach(rt);
 console.log('READY',rt.output);
 rt.report.cases=[];
 const record=()=>rt.write(path.join(rt.output,'report.json'),rt.report);
 const saveFailure=(name,error)=>{rt.report.cases.push({name,error:String(error.stack||error)});record();};
 rt.cloud=await build.startCloud(rt,rt.testProject,process.env.AILY_E2E_TOOLCHAIN_SEED,process.env.PARTITION_CLOUD_ROOT);
 const seeds=[
  {name:'batching',project:rt.testProject,prompt:'在当前双料称重配料台项目副本中调整自定义分区，保持现有积木和业务代码不变。按 4MB Flash，保留 NVS 配方与校准数据分区，预留 OTA 双程序槽，不需要文件系统；请结合实际固件大小选择合适的分区。用内嵌 Dock 分区工具操作并保存，随后真实编译验证。没有连接硬件，不上传。最后说明各程序槽容量、NVS 容量和实际编译结果。'},
  {name:'parking',project:path.join(rt.output,'parking'),source:process.env.PARTITION_PARKING_SEED,prompt:'在当前双向停车场项目副本中调整自定义分区，保持现有积木和业务代码不变。按 4MB Flash，需要保留 NVS 存储占用和事件；不需要 OTA 更新，只用有线上传，并预留 512 KiB 文件空间供后续网页资源使用，其余空间尽量分给程序。请使用内嵌 Dock 分区工具配置和保存，再真实编译验证。没有连接硬件，不上传。最后说明实际分区容量及编译结果。'}
 ];
 const selected=seeds.filter(c=>!process.env.PARTITION_AI_CASES||process.env.PARTITION_AI_CASES.split(',').includes(c.name));
 assert(selected.length>0,'No AI cases selected');
 for(const c of selected){
  try{
   if(c.source)clone(c.source,c.project);
   // Real native setting API prepares the missing-CSV baseline; model edits are
   // submitted only through the Chat composer below.
   await rt.main.evaluate(async()=>{const cfg=window.ng.getComponent(document.querySelector('app-header')).configService;if(cfg.getCompileBackend()!=='local'){cfg.data.compile.backend='local';await cfg.saveCompileSettings();}});
   await rt.open(c.project);
   const config=await rt.command('get_board_config',{});rt.write(path.join(rt.output,c.name+'-board.json'),config);assert.equal(config.ok,true,JSON.stringify(config));assert(config.config_items.some(x=>x.config_key==='FlashSize'&&x.options.some(o=>o.value==='4M')));
   assert.equal((await rt.command('set_board_config',{config_key:'FlashSize',config_value:'4M'})).ok,true);
   assert.equal((await rt.command('set_board_config',{config_key:'PartitionScheme',config_value:'custom'})).ok,true);
   const baselineMissing=!fs.existsSync(path.join(c.project,'src/partitions.csv'));
   const baseline=await build.compile(rt,c.project,c.name+'-missing-local',false);
   console.log('BASELINE',c.name,baseline.milliseconds);
   const before=hashSource(c.project),beforeCsv=fs.readFileSync(path.join(c.project,'src/partitions.csv'),'utf8');
   // Opening another project can replace the Chat child and its Agent socket.
   // Reacquire both from the current host before creating the next real session.
   agent?.close();
   await rt.command('child_app_open',{toolId:'aily-chat',mode:'embedded'});
   const chat=await rt.until(()=>rt.main.frames().find(f=>f.parentFrame()&&f.url().includes('token=')),'Current Chat frame');
   const url=new URL(chat.url()),ws=new URL('/ws',url);ws.protocol='ws:';ws.search=url.search;
   agent=await rt.connectAgent(require('ws'),ws.href);
   const workspace=(await agent.call({type:'workspace.resolve',cwd:c.project})).cwd;
   const session=(await agent.call({type:'session.create',options:{cwd:workspace,developmentMode:'blockly',permissionMode:'full'}})).snapshot;activeSession=session.sessionId;
   // exposedTools is the progressively loaded subset; installed capability preflight runs before launch.
   const title=c.name+' 分区真实复测';await agent.call({type:'setName',sessionId:session.sessionId,name:title});
   await chat.goto(chat.url());await chat.getByText(title,{exact:true}).filter({visible:true}).first().click();
   rt.write(path.join(rt.output,c.name+'-prompt.json'),{sessionId:session.sessionId,project:c.project,prompt:c.prompt,at:new Date().toISOString(),baselineMissing});
   await chat.locator('.aily-chat-composer-input[role="textbox"]').fill(c.prompt);await chat.locator('.aily-chat-composer-input[role="textbox"]').press('Enter');
   console.log('AI_SUBMITTED',c.name,session.sessionId);
   const began=Date.now();let sawWorking=false,snapshot,observedDock=false,lastCount=-1;
   while(Date.now()-began<20*60*1000){
    snapshot=await agent.call({type:'session.snapshot',sessionId:session.sessionId});
    rt.write(path.join(rt.output,c.name+'-session.json'),snapshot);
    if(snapshot.isStreaming||!snapshot.isIdle)sawWorking=true;
    const toolResults=snapshot.messages.filter(m=>m.role==='toolResult');
    if(toolResults.length!==lastCount){lastCount=toolResults.length;console.log('AI_PROGRESS',c.name,lastCount,toolResults.at(-1)?.toolName);}
    const detached=rt.application.windows().filter(p=>p.url().includes('child-tool/ffs-manager-child'));assert.equal(detached.length,0,'AI unexpectedly opened detached partition window');
    if(await rt.main.locator('.subapp-dock').isVisible().catch(()=>false)){observedDock=true;await rt.main.screenshot({path:path.join(rt.output,c.name+'-dock.png')});}
    if(sawWorking&&snapshot.isIdle&&!snapshot.isStreaming)break;
    await delay(10000);
   }
   assert(snapshot?.isIdle&&!snapshot.isStreaming,'AI timed out');activeSession=null;
   const tools=snapshot.messages.filter(m=>m.role==='toolResult').map(m=>m.toolName);
   assert(tools.includes('partition_save'),'Model did not save via partition tool');assert(tools.lastIndexOf('project_build')>tools.lastIndexOf('partition_save'),'Model did not compile after saving partitions');assert(observedDock,'Dock was never observed');
   assert.deepEqual(hashSource(c.project),before,'Model changed business code');
   assert.notEqual(fs.readFileSync(path.join(c.project,'src/partitions.csv'),'utf8'),beforeCsv,'Partition edit was a no-op');
   const modelBuild=JSON.parse(fs.readFileSync(path.join(c.project,'package.json'))).buildInfo;assert(Date.parse(modelBuild.lastBuildTime)>=began&&modelBuild.lastBuildStatus==='success','Model build not confirmed');
   const local=await build.compile(rt,c.project,c.name+'-ai-local',false);
   const cloud=await build.compile(rt,c.project,c.name+'-ai-cloud',true);
   rt.report.cases.push({name:c.name,project:c.project,sessionId:session.sessionId,baselineMissing,observedDock,detachedWindows:0,unchangedBusinessCode:true,modelBuild,local,cloud,success:true});record();console.log('AI_CASE_PASSED',c.name);
  }catch(e){saveFailure(c.name,e);console.log('CASE_FAILED',c.name,e.message);if(activeSession){await agent.call({type:'abort',sessionId:activeSession,source:'user',reason:'Acceptance failure',waitForSettle:false}).catch(()=>{});activeSession=null;} }
 }
 if(process.env.PARTITION_LVGL_SEED){
  const project=path.join(rt.output,'lvgl');clone(process.env.PARTITION_LVGL_SEED,project);await rt.open(project);
  try{const result=await build.compile(rt,project,'lvgl-cloud-fixed',true);rt.report.cases.push({name:'lvgl-cloud-fixed',success:true,...result});console.log('LVGL_FIXED_PASSED',result.milliseconds);}
  catch(e){saveFailure('lvgl-cloud-fixed',e);console.log('CASE_FAILED','lvgl-cloud-fixed',e.message);}
 }
 rt.report.success=rt.report.cases.length===selected.length+(process.env.PARTITION_LVGL_SEED?1:0)&&rt.report.cases.every(c=>c.success);record();
}catch(e){console.error('RUN_FAILED',e.stack);if(rt){rt.report.error=e.stack;rt.write(path.join(rt.output,'report.json'),rt.report);}process.exitCode=1;}
finally{
 if(agent&&activeSession)await agent.call({type:'abort',sessionId:activeSession,source:'user',reason:'Acceptance cleanup',waitForSettle:false}).catch(()=>{});
 agent?.close();await rt?.cloud?.close();await rt?.cleanup();console.log('EVIDENCE',rt?.output);
}
