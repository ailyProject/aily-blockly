const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

function prepareWindowChrome() {
  if (process.platform !== 'darwin') return;
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'electron/native/window-chrome.mm');
  const output = path.join(root, 'electron/native/window-chrome.node');
  const stamp = output + '.stamp';
  const signature = crypto.createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(__filename)).digest('hex');
  if (fs.existsSync(output) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === signature) return;
  const electronVersion = fs.readFileSync(path.join(root, 'node_modules/electron/dist/version'), 'utf8').trim();
  const candidates = [path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../include/node'),
    path.join(os.homedir(), '.electron-gyp', electronVersion, 'include/node'),
    path.join(os.homedir(), 'Library/Caches/node-gyp', process.versions.node, 'include/node')];
  const headers = candidates.find(directory => fs.existsSync(path.join(directory, 'node_api.h')));
  if (!headers) throw new Error('Node-API headers are required to build the macOS window controls.');
  const temporaryDirectory = path.join(root, '.tmp');
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const temporary = path.join(temporaryDirectory, `window-chrome-${process.pid}.node`);
  try {
    execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
      '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0', '-DNAPI_VERSION=8',
      '-I', headers, '-framework', 'AppKit', '-framework', 'CoreGraphics', source, '-o', temporary], { stdio: 'inherit' });
    fs.renameSync(temporary, output);
    fs.writeFileSync(stamp, signature);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

module.exports = context => {
  if (!context || context.electronPlatformName === 'darwin') prepareWindowChrome();
};
module.exports.prepareWindowChrome = prepareWindowChrome;
if (require.main === module) prepareWindowChrome();
