const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { getProductAuthConfig } = require('../../electron/build-product');

const mainPath = path.resolve(__dirname, '../../electron/main.js');
const main = fs.readFileSync(mainPath, 'utf8');
const declarations = main.slice(main.indexOf('// Hub desktop handoffs'), main.indexOf('// A protocol-launched process'));

function harness(product = 'blockly') {
  const context = { require, process, Buffer, path, os, fs, URL, setTimeout, clearTimeout,
    getBuildProduct: () => product, getProductAuthConfig, BrowserWindow: { fromWebContents: sender => sender.window } };
  vm.runInNewContext(`${declarations}\nthis.api = { beginHubDesktopRequest, forwardHubDesktopAuthorization, parseHubDesktopProtocol, requests: hubDesktopRequests };`, context);
  const sender = new EventEmitter(), sent = [];
  sender.mainFrame = { send: (channel, data) => sent.push({ channel, data }) };
  sender.window = {};
  sender.isDestroyed = () => false;
  return { ...context.api, sender, sent, event: { sender, senderFrame: sender.mainFrame } };
}

function callback(request, protocol = 'abis') {
  const url = new URL(`${protocol}://auth/hub`);
  for (const [key, value] of Object.entries({ request, state: 's'.repeat(43), code_challenge: 'c'.repeat(43),
    redirect_uri: 'https://hub.example/auth/callback', sourceApiUrl: 'https://api.example', returnUrl: '/projects?app=ailyblockly' })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

test('only a locally begun request reaches its initiating frame, once, across real processes', async () => {
  const h = harness(), request = randomBytes(32).toString('base64url');
  assert.equal(await h.beginHubDesktopRequest(h.event, request), true);
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
    const {getProductAuthConfig}=require(${JSON.stringify(path.resolve(__dirname, '../../electron/build-product'))});
    const source=fs.readFileSync(${JSON.stringify(mainPath)},'utf8');
    const code=source.slice(source.indexOf('// Hub desktop handoffs'),source.indexOf('// A protocol-launched process'));
    const context={require,process,Buffer,path,os,fs,URL,setTimeout,clearTimeout,getBuildProduct:()=> 'blockly',getProductAuthConfig};
    vm.runInNewContext(code+';this.forward=forwardHubDesktopAuthorization;',context);
    let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>context.forward(input).then(()=>process.exit(0),()=>process.exit(1)));
  `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end(callback(request));
  assert.equal(await exited, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].channel, 'hub-desktop-authorize');
  assert.equal(h.sent[0].data.request, request);
  assert.equal(h.requests.size, 0);
  await assert.rejects(h.forwardHubDesktopAuthorization(callback(request)), /unavailable/);
  await assert.rejects(h.forwardHubDesktopAuthorization(callback(randomBytes(32).toString('base64url'))), /unavailable/);
  assert.equal(h.sent.length, 1);
});

test('invalid callbacks, other products and other frames never register or consume a request', async () => {
  const h = harness(), request = randomBytes(32).toString('base64url');
  assert.equal(await h.beginHubDesktopRequest({ ...h.event, senderFrame: {} }, request), false);
  assert.equal(await h.beginHubDesktopRequest(h.event, '../other'), false);
  assert.equal(await h.beginHubDesktopRequest(h.event, request), true);
  try {
    assert.equal(await h.beginHubDesktopRequest(h.event, randomBytes(32).toString('base64url')), false);
    for (const bad of [callback(request, 'acis'), callback(request) + '&request=other', callback(request) + '#fragment', callback(request).replace('auth/hub', 'auth/callback')]) {
      await assert.rejects(h.forwardHubDesktopAuthorization(bad));
    }
    assert.equal(h.requests.size, 1);
    assert.equal(h.sent.length, 0);
  } finally { h.sender.emit('destroyed'); }
  assert.equal(h.requests.size, 0);
});

test('owner navigation and expiry invalidate pending requests without forwarding to a new document', async () => {
  for (const reason of ['navigation', 'expiry']) {
    const h = harness('coder'), request = randomBytes(32).toString('base64url');
    assert.equal(await h.beginHubDesktopRequest(h.event, request), true);
    if (reason === 'navigation') h.sender.emit('did-start-navigation', {}, 'http://localhost', false, true);
    else h.requests.get(request).expiresAt = 0;
    await assert.rejects(h.forwardHubDesktopAuthorization(callback(request, 'acis')));
    assert.equal(h.sent.length, 0);
    h.sender.emit('destroyed');
  }
});

test('Hub protocol logs redact credentials while the existing OAuth route stays separate', () => {
  const code = main.slice(main.indexOf('function protocolLogValue('), main.indexOf('const cloudProjectOpenQueue'));
  const context = {};
  vm.runInNewContext(`${code};this.redact=protocolLogValue;`, context);
  assert.equal(context.redact(callback('x'.repeat(43))), '[Hub desktop handoff]');
  assert.equal(context.redact('abis://auth/callback?old=unchanged'), 'abis://auth/callback?old=unchanged');
  assert.ok(main.indexOf("if (fullPath === '/auth/hub')") < main.indexOf("if (fullPath === '/auth/callback')"));
});

test('Unix socket names fit the macOS limit with its long per-user temporary directory', () => {
  const directory = '/var/folders/xy/abcdefghijklmnopqrstuvwxyz0123456789/T';
  const request = randomBytes(32).toString('base64url');
  const context = { require, process: { platform: 'darwin' }, path: path.posix, os: { tmpdir: () => directory } };
  context.getBuildProduct = () => 'blockly';
  vm.runInNewContext(`${declarations};this.pipe=hubDesktopPipe;`, context);
  assert.ok(Buffer.byteLength(path.posix.join(directory, `aily-hub-blockly-${request}.sock`)) > 103);
  assert.ok(Buffer.byteLength(context.pipe(request)) <= 103);
  assert.match(path.posix.basename(context.pipe(request)), /^ah-[0-9a-f]{32}$/);
});
