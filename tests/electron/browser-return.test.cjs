const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createBrowserReturn } = require('../../electron/browser-return');

test('macOS captures a per-flow native target and releases its activation observer', () => {
  const tracker = {}, target = {}, calls = [];
  const browser = createBrowserReturn({ platform: 'darwin', packaged: false, native: {
    beginBrowserTracking: () => tracker,
    captureBrowser(value) { assert.equal(value, tracker); return target; },
    restoreBrowser(value) { calls.push(value); return true; },
    endBrowserTracking(value) { assert.equal(value, tracker); calls.push('closed'); },
  } });
  assert.equal(browser.restore(null), false);
  assert.equal(browser.restore(browser.capture()), true); browser.close();
  assert.deepEqual(calls, [target, 'closed']);
});

test('Windows uses an unpacked script with hidden bounded subprocesses and validates handles', async () => {
  const calls = [], resources = path.resolve('fixture/Resources');
  const browser = createBrowserReturn({ platform: 'win32', packaged: true, resourcesPath: resources,
    run(program, args, options, done) {
      calls.push(args); assert.equal(program, 'powershell.exe');
      assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000);
      assert.equal(args[args.indexOf('-File') + 1], path.join(resources, 'app.asar.unpacked/electron/native/browser-return.ps1'));
      done(null, args.includes('capture') ? '{"handle":"12345","pid":123}' : 'true');
    },
  });
  const target = await browser.capture(); assert.equal(await browser.restore(target), true);
  assert.equal(browser.restore({ handle: '1; arbitrary command', pid: 123 }), false);
  assert.equal(browser.restore({ handle: '1', pid: -1 }), false);
  assert.equal(calls.length, 2);
});

test('unavailable Windows helpers and unsupported platforms leave focus unchanged', async () => {
  const windows = createBrowserReturn({ platform: 'win32', packaged: false, run(_p, _a, _o, done) { done(new Error('Unavailable')); } });
  assert.equal(await windows.capture(), null);
  const linux = createBrowserReturn({ platform: 'linux', packaged: false });
  assert.equal(linux.capture(), null); assert.equal(linux.restore({}), false); linux.close();
});
