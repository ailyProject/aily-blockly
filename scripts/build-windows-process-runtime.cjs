'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const nativeSource = path.join(root, 'electron/native/windows-process');
const outputRoot = path.join(root, '.aily/windows-process-runtime');
const names = ['aily-job.node', 'aily-job-launcher.exe'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fingerprint = () => hash(Buffer.concat(['job.cc', 'launcher.cc'].map(name => fs.readFileSync(path.join(nativeSource, name)))));
const recipe = () => hash(fs.readFileSync(__filename));
function assertArch(arch) {
  if (arch !== 'x64') throw new Error(`Windows process runtime currently supports x64; no native build exists for ${arch}`);
}
function verifyPe(file, arch) {
  assertArch(arch);
  const bytes = fs.readFileSync(file);
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Invalid Windows executable: ${file}`);
  const offset = bytes.readUInt32LE(60);
  if (offset > bytes.length - 26 || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b)
    throw new Error(`Windows process runtime architecture is not ${arch}: ${file}`);
  const dll = (bytes.readUInt16LE(offset + 22) & 0x2000) !== 0;
  if (dll !== file.endsWith('.node')) throw new Error(`Wrong Windows runtime binary type: ${file}`);
}
function verify(arch = 'x64', { directory = path.join(outputRoot, arch) } = {}) {
  assertArch(arch);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
  if (manifest.version !== 2 || manifest.platform !== 'win32' || manifest.arch !== arch || manifest.napi !== 8
      || manifest.source !== fingerprint() || manifest.recipe !== recipe())
    throw new Error('Windows process runtime must be rebuilt for current sources and build recipe');
  for (const name of names) {
    const file = path.join(directory, name);
    if (hash(fs.readFileSync(file)) !== manifest.files?.[name]) throw new Error(`Invalid Windows process runtime checksum: ${name}`);
    verifyPe(file, arch);
  }
  return directory;
}
function nodeHeaders() {
  if (process.env.NODE_INCLUDE_DIR) {
    const directory = path.resolve(process.env.NODE_INCLUDE_DIR);
    if (!fs.existsSync(path.join(directory, 'node_api.h'))) throw new Error('NODE_INCLUDE_DIR has no node_api.h');
    return { directory, version: 'explicit-node-api-headers' };
  }
  // node-gyp downloads and checks the official header archive. N-API 8 avoids
  // depending on Electron's version-specific V8 ABI or linking node.lib.
  const version = process.versions.node, cache = path.join(root, '.aily/windows-process-headers');
  const directory = path.join(cache, version, 'include/node');
  execFileSync(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'install', '--ensure',
    `--target=${version}`, `--devdir=${cache}`], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(directory, 'node_api.h'))) throw new Error('Node-API header installation did not complete');
  return { directory, version };
}
function onPath(name, environment) {
  const variable = Object.keys(environment).find(key => key.toLowerCase() === 'path');
  for (const directory of String(environment[variable] || '').split(';')) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`MSVC ${name} is missing. Install Visual Studio Build Tools with Desktop development with C++.`);
}
function msvcEnvironment() {
  if (process.env.VCINSTALLDIR && process.env.VSCMD_ARG_TGT_ARCH === 'x64') return { ...process.env };
  const installer = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  if (!fs.existsSync(installer)) throw new Error('Visual Studio Build Tools is required to compile the Windows process runtime');
  const installation = execFileSync(installer, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', '-utf8'], { encoding: 'utf8' }).trim();
  const setup = path.join(installation, 'VC/Auxiliary/Build/vcvarsall.bat');
  if (!installation || !fs.existsSync(setup)) throw new Error('MSVC x64 toolchain was not found');
  // Only the trusted VS setup path enters cmd.exe; source paths and compiler
  // arguments are subsequently passed directly with execFileSync.
  const variables = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
    `"chcp 65001 >nul && call "${setup}" x64 >nul && set"`],
  { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const environment = {};
  for (const line of variables.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return environment;
}
function compile(directory, headers) {
  const override = process.env.WINDOWS_CXX;
  if (process.platform === 'win32' && (!override || /(?:^|[\\/])cl(?:\.exe)?$/i.test(override))) {
    const env = msvcEnvironment(), compiler = override || onPath('cl.exe', env);
    const common = ['/nologo', '/TP', '/std:c++17', '/O2', '/EHsc', '/MT', '/GS', '/guard:cf', '/DUNICODE', '/D_UNICODE', `/I${headers}`];
    for (const [source, output, dll] of [['job.cc', names[0], true], ['launcher.cc', names[1], false]]) {
      execFileSync(compiler, [...common, ...(dll ? ['/LD'] : []), `/Fo${path.join(directory, source + '.obj')}`,
        path.join(nativeSource, source), '/link', '/Brepro', '/DYNAMICBASE', '/NXCOMPAT', '/HIGHENTROPYVA', '/GUARD:CF',
        `/OUT:${path.join(directory, output)}`, ...(dll ? [`/IMPLIB:${path.join(directory, 'job.lib')}`] : [])],
      { cwd: directory, env, stdio: 'inherit', windowsHide: true });
    }
    return { kind: 'msvc', compiler: path.basename(compiler) };
  }
  const compiler = override || 'x86_64-w64-mingw32-g++';
  const common = ['-std=c++17', '-O2', '-s', '-static', '-static-libgcc', '-static-libstdc++', '-Wl,--no-insert-timestamp'];
  execFileSync(compiler, [...common, '-shared', '-I' + headers, path.join(nativeSource, 'job.cc'), '-o', path.join(directory, names[0])], { stdio: 'inherit' });
  execFileSync(compiler, [...common, '-municode', path.join(nativeSource, 'launcher.cc'), '-o', path.join(directory, names[1])], { stdio: 'inherit' });
  return { kind: 'mingw', compiler: path.basename(compiler), version: execFileSync(compiler, ['-dumpfullversion'], { encoding: 'utf8' }).trim() };
}
function build(arch = 'x64', { destinationRoot = outputRoot } = {}) {
  assertArch(arch);
  const source = fingerprint(), buildRecipe = recipe(), headers = nodeHeaders();
  fs.mkdirSync(destinationRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(destinationRoot, '.compile-'));
  const directory = path.join(destinationRoot, arch), previous = `${directory}.previous-${crypto.randomUUID()}`;
  let movedPrevious = false;
  try {
    const toolchain = compile(temporary, headers.directory);
    for (const name of names) verifyPe(path.join(temporary, name), arch);
    if (source !== fingerprint() || buildRecipe !== recipe()) throw new Error('Windows process sources changed during compilation');
    const manifest = { version: 2, platform: 'win32', arch, napi: 8, source, recipe: buildRecipe,
      toolchain: { ...toolchain, headers: headers.version }, files: Object.fromEntries(names.map(name => [name, hash(fs.readFileSync(path.join(temporary, name)))])) };
    for (const name of fs.readdirSync(temporary)) if (!names.includes(name)) fs.unlinkSync(path.join(temporary, name));
    fs.writeFileSync(path.join(temporary, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
    verify(arch, { directory: temporary });
    if (fs.existsSync(directory)) { fs.renameSync(directory, previous); movedPrevious = true; }
    try { fs.renameSync(temporary, directory); }
    catch (error) { if (movedPrevious) fs.renameSync(previous, directory); throw error; }
    if (movedPrevious) fs.rmSync(previous, { recursive: true, force: true });
    console.info('[windows-process] compiled and verified', { arch, directory, toolchain: toolchain.kind });
    return directory;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
const leases = new Map();
async function prepareForPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { Arch } = require('electron-builder'), arch = Arch[context.arch];assertArch(arch);
  const destinationRoot = path.join(context.packager.projectDir, '.aily/windows-process-runtime');
  const guardDirectory = path.join(destinationRoot, '.guards');fs.mkdirSync(guardDirectory, { recursive: true });
  const { tryAcquireFileLock } = require('../child/scripts/native-file-lock');
  const deadline = Date.now() + 120000;let lease;
  while (!(lease = tryAcquireFileLock(path.join(guardDirectory, `${arch}.guard`)))) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Windows native packaging ownership');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const key = path.resolve(context.appOutDir);
  if (leases.has(key)) { lease.close();throw new Error('Duplicate Windows native packaging transaction'); }
  try { build(arch, { destinationRoot }); leases.set(key, lease); }
  catch (error) { lease.close();throw error; }
}
function releasePackLease(context) {
  const key = path.resolve(context.appOutDir), lease = leases.get(key);
  if (lease) { leases.delete(key);lease.close(); }
}
function verifyPackaged(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { Arch } = require('electron-builder'), arch = Arch[context.arch];
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const prefix = `electron/native/windows-process/${arch}`;
  verify(arch, { directory: path.join(resources, 'app.asar.unpacked', prefix) });
  const { statFile } = require('@electron/asar');
  for (const name of [...names, 'runtime.json']) {
    if (statFile(path.join(resources, 'app.asar'), path.join(prefix, name)).unpacked !== true)
      throw new Error(`Windows native runtime must be outside ASAR: ${name}`);
  }
}
function smokePackaged(context) {
  if (context.electronPlatformName !== 'win32' || process.platform !== 'win32') return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const executable = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const probe = `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const owned = require(path.join(process.argv[1], 'app.asar/electron/owned-process.js'));
    assert(owned.runtime(), 'Packaged Windows native module did not load');
    const code = "const cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,stdio:'ignore'});console.log('ready:'+c.pid);setInterval(()=>{},1000)";
    const child = owned.spawn(process.execPath, ['-e', code], { windowsHide: true, env: process.env });
    child.stderr.pipe(process.stderr);
    const deadline = setTimeout(() => { console.error('Packaged Job smoke timed out');process.exit(1); }, 12000);
    let output = '', stopping = false;
    child.on('error', error => { console.error(error);process.exitCode = 1; });
    child.stdout.on('data', async bytes => {
      output += bytes;
      if (stopping || !/ready:\\d+/.test(output)) return;
      stopping = true;
      try {
        assert.equal(await owned.stopOwnedProcess(child), true);
        assert.equal(owned.getOwnedProcessInfo(child).active, 0);
        console.log('PACKAGED_WINDOWS_JOB_OK');clearTimeout(deadline);
      } catch (error) { console.error(error);process.exit(1); }
    });
  `;
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete environment.AILY_CHILD_PATH;delete environment.NODE_PATH;
  const output = execFileSync(executable, ['-e', probe, resources], {
    env: environment, cwd: context.appOutDir, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  if (!output.includes('PACKAGED_WINDOWS_JOB_OK')) throw new Error('Packaged Windows native smoke did not acknowledge cleanup');
  console.info('[windows-process] packaged Electron load, launcher and Job cleanup verified');
}
if (require.main === module) {
  const args = process.argv.slice(2), arch = args.find(arg => arg !== '--verify') || 'x64';
  console.log(args.includes('--verify') ? verify(arch) : build(arch));
}
module.exports = { verify, verifyPe, build, prepareForPack, verifyPackaged, smokePackaged, releasePackLease, outputRoot };
