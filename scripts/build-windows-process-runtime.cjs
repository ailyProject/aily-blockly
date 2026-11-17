'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'electron/native/windows-process');
const fingerprint = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'job.cc'))).update(fs.readFileSync(path.join(source, 'launcher.cc'))).digest('hex');
function verify(arch = 'x64') {
  const dir = path.join(source, arch), manifest = JSON.parse(fs.readFileSync(path.join(dir, 'runtime.json')));
  if (manifest.source !== fingerprint() || manifest.arch !== arch) throw new Error('Windows process runtime must be rebuilt for current sources');
  for (const name of ['aily-job.node', 'aily-job-launcher.exe']) {
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex') !== manifest.files[name]) throw new Error('Invalid Windows process runtime: ' + name);
  }
  return dir;
}
function build(arch = 'x64') {
  if (arch !== 'x64') throw new Error('Build the Windows process runtime with a matching target toolchain: ' + arch);
  const includes = process.env.NODE_INCLUDE_DIR || path.join(os.homedir(), 'Library/Caches/node-gyp/22.21.0/include/node');
  if (!fs.existsSync(path.join(includes, 'node_api.h'))) throw new Error('Set NODE_INCLUDE_DIR to the Node-API headers directory');
  const compiler = process.env.WINDOWS_CXX || (process.platform === 'win32' ? 'g++' : 'x86_64-w64-mingw32-g++');
  const dir = path.join(source, arch);fs.mkdirSync(dir, { recursive: true });
  const common = ['-std=c++17', '-O2', '-s', '-static', '-static-libgcc', '-static-libstdc++'];
  execFileSync(compiler, [...common, '-shared', '-I' + includes, path.join(source, 'job.cc'), '-o', path.join(dir, 'aily-job.node')], { stdio: 'inherit' });
  execFileSync(compiler, [...common, '-municode', path.join(source, 'launcher.cc'), '-o', path.join(dir, 'aily-job-launcher.exe')], { stdio: 'inherit' });
  const files = Object.fromEntries(['aily-job.node', 'aily-job-launcher.exe'].map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex')]));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ arch, source: fingerprint(), files }, null, 2) + '\n');
  return verify(arch);
}
if (require.main === module) console.log(process.argv.includes('--verify') ? verify(process.argv[2] === '--verify' ? process.argv[3] || 'x64' : process.argv[2]) : build(process.argv[2] || 'x64'));
module.exports = { verify, build };
