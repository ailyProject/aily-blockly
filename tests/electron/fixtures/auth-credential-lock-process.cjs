'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const [, , root, mode] = process.argv;
process.env.AILY_APPDATA_PATH = root;
const load = Module._load;
Module._load = function (name, ...rest) {
  if (name === 'electron') return { app: { getPath: () => root, getVersion: () => 'native-test' } };
  return load.call(this, name, ...rest);
};
const { withAuthCredentialsLock } = require('../../../electron/auth-credentials-lock');
Module._load = load;

if (mode === 'observer') {
  const marker = path.join(root, '.lock', 'auth-credentials', 'writer.lock');
  const witness = path.join(root, 'observed');
  const resume = path.join(root, 'resume');
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (filename, ...rest) {
    const bytes = originalRead.call(this, filename, ...rest);
    if (filename === marker && !fs.existsSync(witness)) {
      fs.writeFileSync(witness, '');
      const deadline = Date.now() + 4000;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(resume)) {
        if (Date.now() > deadline) throw new Error('Observer fixture did not resume');
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    return bytes;
  };
}

process.send('attempted');
void withAuthCredentialsLock(async () => {
  process.send('entered');
  await new Promise(resolve => process.once('message', resolve));
}).then(() => process.disconnect(), error => {
  console.error(error.code || 'FIXTURE_FAILED');
  process.exitCode = 1;
  process.disconnect();
});
