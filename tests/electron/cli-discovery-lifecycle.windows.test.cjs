'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { fork } = require('node:child_process');
const { runtime } = require('../../electron/owned-process');
const windows = { skip: process.platform !== 'win32', timeout: 15000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { const end = Date.now() + 5000;while (!fn()) { if (Date.now() > end) throw Error('Discovery cleanup timed out');await delay(5); } }
test('forced main exit removes only its own discovery file while another instance remains live', windows, async t => {
  assert(runtime());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-cli-watch-')), script = path.join(root, 'host.cjs');
  const modulePath = path.resolve(__dirname, '../../electron/cli-bridge');
  fs.writeFileSync(script, `const fs=require('fs'),os=require('os'),path=require('path');const {startCliBridge}=require(${JSON.stringify(modulePath)});const b=startCliBridge({handleCommand:()=>({ok:true}),getStatus:()=>({pid:process.pid}),logger:{log(){},warn(){},error(){}}});const timer=setInterval(()=>{if(b.getPort()){clearInterval(timer);process.send({pid:process.pid,port:b.getPort(),file:path.join(os.homedir(),'.aily-blockly/cli-bridge',process.pid+'.json')})}},5);process.on('message',()=>{b.close();process.exit(0)});`);
  const children=[];
  t.after(async () => { for (const child of children) { if (child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL'); }await delay(100);fs.rmSync(root,{recursive:true,force:true}); });
  async function start() {
    const child=fork(script,[],{execArgv:[],env:{...process.env,USERPROFILE:root,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc']});children.push(child);child.stderr.resume();
    const info=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});return{child,...info};
  }
  const a=await start(),b=await start();assert(fs.existsSync(a.file));assert(fs.existsSync(b.file));
  const exited=new Promise(resolve=>a.child.once('exit',resolve));a.child.kill('SIGKILL');await exited;await waitFor(()=>!fs.existsSync(a.file));assert(fs.existsSync(b.file));
  const ping=await new Promise((resolve,reject)=>http.get('http://127.0.0.1:'+b.port+'/ping',res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(JSON.parse(body)));}).on('error',reject));assert.equal(ping.pid,b.pid);
  const closed=new Promise(resolve=>b.child.once('exit',resolve));b.child.send({close:true});assert.equal(await closed,0);await waitFor(()=>!fs.existsSync(b.file));
});
