const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { copyProjectDirectory } = require('../../../electron/project-file-copy');

const root = process.argv[2];
const source = path.join(root, 'project_oct16a');
const unfiltered = path.join(root, 'unfiltered');
const filtered = path.join(root, 'project_oct16a_new');
const library = 'local-libraries/@aily-project/lib-bemfa/Bemfa.h';
const overlay = path.join(source, '.workspace-history/overlays/842f300d-a41e-4ee3-8bf9-057942c068df/view/local-libraries/@aily-project/lib-bemfa');
const warm = '.workspace-history/views/warm/view/node_modules/@aily-project/lib-bemfa';
for (const directory of [path.dirname(path.join(source, library)), overlay, path.dirname(path.join(source, warm)),
  path.join(source, '.aily/abs-sync'), unfiltered, filtered]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(source, 'project.abi'), '{"blocks":{}}');
fs.writeFileSync(path.join(source, library), 'persistent library');
fs.writeFileSync(path.join(overlay, 'Bemfa.h'), 'history overlay');
fs.writeFileSync(path.join(source, '.aily/abs-sync/committed.json'), 'retained baseline');
fs.symlinkSync(overlay, path.join(source, warm), process.platform === 'win32' ? 'junction' : 'dir');

// cpSync captures symlinkSync on its first call, so this fixture runs in a fresh Electron process.
const originalSymlink = fs.symlinkSync;
const attempts = [];
fs.symlinkSync = (target, destination) => {
  attempts.push({ target, destination });
  throw Object.assign(new Error(`EPERM: operation not permitted, symlink '${target}' -> '${destination}'`), { code: 'EPERM' });
};
try {
  assert.throws(() => copyProjectDirectory(source, unfiltered, false), { code: 'EPERM' });
  assert.equal(attempts.length, 1);
  assert.equal(fs.realpathSync(attempts[0].target), fs.realpathSync(overlay));
  assert.equal(attempts[0].destination, path.join(unfiltered, warm));
  attempts.length = 0;
  copyProjectDirectory(source, filtered);
  assert.equal(attempts.length, 0);
  assert.equal(fs.existsSync(path.join(filtered, '.workspace-history')), false);
  assert.equal(fs.readFileSync(path.join(filtered, 'project.abi'), 'utf8'), '{"blocks":{}}');
  assert.equal(fs.readFileSync(path.join(filtered, library), 'utf8'), 'persistent library');
  assert.equal(fs.readFileSync(path.join(filtered, '.aily/abs-sync/committed.json'), 'utf8'), 'retained baseline');
  assert.ok(fs.lstatSync(path.join(source, warm)).isSymbolicLink());
  process.stdout.write(`Electron ${process.versions.electron}, Node ${process.versions.node}: unfiltered=EPERM, filtered symlink attempts=0\n`);
} finally {
  fs.symlinkSync = originalSymlink;
}
