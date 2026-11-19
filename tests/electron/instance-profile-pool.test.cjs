'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
test('concurrent launches retain unique profiles and recover a crashed owner without trusting a recycled PID', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-profile-pool-'));
  const legacy = path.join(root, 'instances/instance-0');fs.mkdirSync(legacy, { recursive: true });fs.writeFileSync(path.join(legacy, 'instance.lock'), JSON.stringify({ pid: process.pid }));
  const entry = path.resolve(__dirname, '../../electron/instance-profile-pool.js'), children = [];
  t.after(async () => {
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? null
      : new Promise(resolve => { child.once('exit', resolve);child.kill('SIGKILL'); })));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function launch() {
    const code = `const {claimInstanceProfile}=require(${JSON.stringify(entry)});const p=claimInstanceProfile(${JSON.stringify(root)});console.log(JSON.stringify({path:p.path,pid:process.pid}));process.stdin.resume();process.stdin.on('data',()=>process.exit(0));`;
    const child = spawn(process.execPath, ['-e', code], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe','pipe','pipe'] });children.push(child);let text='',error='';child.stderr.on('data',data=>error+=data);
    const value=await new Promise((resolve,reject)=>{child.stdout.on('data',data=>{text+=data;const line=text.split('\n').find(line=>line.startsWith('{'));if(line)resolve(JSON.parse(line));});child.once('error',reject);child.once('exit',code=>reject(Error('Profile child exited '+code+': '+error)));});return{child,...value};
  }
  const owners = await Promise.all(Array.from({ length: 8 }, launch));
  assert.equal(new Set(owners.map(owner=>owner.path)).size, 8);assert(!owners.some(owner=>owner.path===legacy));
  const victim=owners[0],dead=new Promise(resolve=>victim.child.once('exit',resolve));victim.child.kill('SIGKILL');await dead;
  // The old owner is dead but its numeric PID may belong to a live process.
  const metadata=path.join(victim.path,'instance.lock'),record=JSON.parse(fs.readFileSync(metadata));record.pid=process.pid;fs.writeFileSync(metadata,JSON.stringify(record));
  const replacement=await launch();assert.equal(replacement.path,victim.path);
  for(const owner of owners.slice(1))assert.equal(JSON.parse(fs.readFileSync(path.join(owner.path,'instance.lock'))).pid,owner.pid);
});
