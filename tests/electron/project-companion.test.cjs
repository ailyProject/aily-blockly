const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {openCompanionProject, companionLaunch, registerProjectCompanionIpc} = require('../../electron/project-companion');

test('companion downloads open the current region homepage and reject non-web URLs', async () => {
  const handlers = new Map();
  const opened = [];
  registerProjectCompanionIpc({ handle: (channel, handler) => handlers.set(channel, handler) },
    { openExternal: async url => opened.push(url) });
  const download = handlers.get('project-companion-download');
  for (const webUrl of ['https://yiyu.pro', 'https://aily.pro']) {
    assert.deepEqual(await download(null, { webUrl }), { ok: true });
  }
  await assert.rejects(download(null, { webUrl: 'file:///tmp/download' }), /Invalid application download URL/);
  assert.deepEqual(opened, ['https://yiyu.pro/', 'https://aily.pro/']);
});

test('development conversion launches the current host source as Coder instead of a stale installed app', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(),'aily-companion-'));
  t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
  fs.writeFileSync(path.join(project,'package.json'),'{"type":"coder"}');
  let launched;
  const result = await openCompanionProject('coder',project,{
    development:{executable:'/current/Electron',entry:'/current/host/electron/main.js'},
    env:{AILY_BUILD_PRODUCT:'blockly',AILY_APP_VERSION:'old',ELECTRON_RUN_AS_NODE:'1',NODE_OPTIONS:'--inspect'},
    find:()=>{throw new Error('Must not discover an installed release from development');},
    spawn:(command,args,options)=>{
      launched={command,args,options}; const child=new EventEmitter(); child.unref=()=>{};
      process.nextTick(()=>child.emit('spawn')); return child;
    },
  });
  assert.equal(result.ok,true);
  assert.equal(launched.command,'/current/Electron');
  assert.deepEqual(launched.args,['/current/host/electron/main.js','--serve',`--open-project=${project}`]);
  assert.equal(launched.options.env.AILY_BUILD_PRODUCT,'coder');
  assert.equal(launched.options.env.ELECTRON_RUN_AS_NODE,undefined);
  assert.equal(launched.options.env.NODE_OPTIONS,undefined);
  assert.equal(launched.options.shell,false);
});

test('packaged companions retain installed-app discovery and isolate build identity', () => {
  const launch=companionLaunch('/Applications/aily coder.app','/projects/a space','darwin',{AILY_BUILD_PRODUCT:'blockly',AILY_RENDERER_URL:'dev'},'coder');
  assert.equal(launch.command,'/usr/bin/open');
  assert.equal(launch.args[2],'/Applications/aily coder.app');
  assert.ok(launch.args.includes('--open-project=/projects/a space'));
  assert.equal(launch.options.env.AILY_BUILD_PRODUCT,undefined);
  assert.equal(launch.options.env.AILY_RENDERER_URL,undefined);
});
