'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../../electron/window'), 'utf8');
const start = source.indexOf('    const requestChildAppHostCommand =');
const end = source.indexOf('\n    const loadSubWindowBasePage', start);
function fixture() {
  const win = new EventEmitter(), ipcMain = new EventEmitter(), sent = [];
  win.isDestroyed = () => false;
  win.webContents = { send: (_channel, payload) => sent.push(payload) };
  const context = { openWindows: new Map([['/child-tool/ffs-manager-child', win]]), normalizeSubWindowUrl: path => path,
    ipcMain, setTimeout, clearTimeout };
  vm.runInNewContext(source.slice(start,end)+'\nthis.request=requestChildAppHostCommand;', context);
  return { win, ipcMain, sent, request: action => context.request('/child-tool/ffs-manager-child', { action }, 20) };
}
for (const action of ['close','closeAll']) test(`${action} succeeds when the window closes before the renderer reply`, async () => {
  const f = fixture(), result = f.request(action); f.win.emit('closed');
  assert.equal((await result).ok,true); assert.equal(f.ipcMain.listenerCount('child-app-host-command-response'),0);
});
test('an explicit cancellation does not close the window and removes all temporary listeners', async () => {
  const f = fixture(), result = f.request('closeAll');
  f.ipcMain.emit('child-app-host-command-response', { sender: {} }, { requestId:f.sent[0].requestId,result:{ok:true} });
  assert.equal(f.ipcMain.listenerCount('child-app-host-command-response'),1);
  f.ipcMain.emit('child-app-host-command-response', { sender:f.win.webContents }, { requestId:f.sent[0].requestId,result:{ok:false} });
  assert.equal((await result).ok,false); assert.equal(f.win.listenerCount('closed'),0);
});
test('a missing response fails safely and removes window and IPC listeners', async () => {
  const f=fixture(); assert.equal((await f.request('closeAll')).ok,false);
  assert.equal(f.win.listenerCount('closed'),0); assert.equal(f.ipcMain.listenerCount('child-app-host-command-response'),0);
});
