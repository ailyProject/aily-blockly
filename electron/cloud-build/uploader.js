'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const protocol = require('./protocol');
// 云端仅提供签名固件和受限烧录计划；串口访问与烧录命令始终在用户电脑执行。

function regularFile(root, relative) {
  protocol.validateRelativePath(relative);
  const filename = path.join(root, ...relative.split('/'));
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename) {
    throw protocol.error('UNSAFE_PATH', 'Uploader file must be a regular file inside its approved directory.');
  }
  return filename;
}
function validatePort(port, platform = process.platform) {
  if (typeof port !== 'string' || (platform === 'win32' ? !/^COM[1-9]\d{0,3}$/iu.test(port)
    : !/^\/dev\/(?:tty|cu\.)[A-Za-z0-9._-]{1,100}$/u.test(port))) {
    throw protocol.error('UPLOAD_INVALID', 'Select a physical serial port before uploading.');
  }
  return port;
}
function resolveTool(runtimeRoot, id, version, platform = process.platform) {
  if (!['avrdude', 'esptool_py'].includes(id) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,100}$/u.test(version || '')) {
    throw protocol.error('UPLOAD_UNSUPPORTED', 'Cloud result requires an unsupported local uploader.');
  }
  const root = path.resolve(runtimeRoot, `${id}@${version}`);
  if (!fs.existsSync(root)) throw protocol.error('UPLOADER_MISSING', `Install the lightweight ${id} uploader before flashing.`);
  if (fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) throw protocol.error('UNSAFE_PATH', 'Uploader directory is linked.');
  const candidates = id === 'avrdude' ? (platform === 'win32' ? ['bin/avrdude.exe', 'avrdude.exe'] : ['bin/avrdude', 'avrdude'])
    : (platform === 'win32' ? ['esptool.exe', 'bin/esptool.exe', 'esptool/esptool.exe'] : ['esptool', 'bin/esptool', 'esptool/esptool']);
  const relative = candidates.find(item => fs.existsSync(path.join(root, item)));
  if (!relative) throw protocol.error('UPLOADER_MISSING', `The installed ${id} package has no native uploader executable.`);
  return { command: regularFile(root, relative), root, ...(id === 'avrdude' ? { configPath: regularFile(root, 'etc/avrdude.conf') } : {}) };
}
function buildUploadCommand(record, request, runtimeRoot, artifactRoot = record.directory, platform = process.platform) {
  const manifest = record.manifest, plan = manifest.flashPlan;
  // 验证签名后仍逐项限制工具、芯片、参数和固件摘要，不执行云端返回的任意命令。
  protocol.verifyManifest(manifest, record.signature, record.publicKey);
  if (manifest.action !== 'compile' || manifest.fixture || manifest.runner !== 'aily-builder' || !plan || plan.fixture
      || plan.schemaVersion !== 1 || plan.profileDigest !== manifest.profileDigest
      || Object.keys(plan).some(key => !['schemaVersion', 'profileId', 'digest', 'profileDigest', 'protocol', 'uploaderId', 'targetChip', 'segments', 'options', 'lifecycle', 'fixture', 'jobId', 'inputDigest', 'boardDigest', 'boardModule', 'boardVersion'].includes(key))
      || !Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length > 16) {
    throw protocol.error('UPLOAD_UNSUPPORTED', 'Only verified compilation results with an approved flash plan can be uploaded.');
  }
  const port = validatePort(request.serialPort, platform);
  const options = plan.options || {}, lifecycle = plan.lifecycle || {};
  if (Object.keys(lifecycle).some(key => !['reset', 'verify'].includes(key)) || ![undefined, 'none', 'serial-dtr'].includes(lifecycle.reset)
      || lifecycle.verify === false) throw protocol.error('UPLOAD_UNSUPPORTED', 'This board requires an unsupported upload lifecycle.');
  const segments = plan.segments.map(segment => {
    if (Object.keys(segment).some(key => !['artifactId', 'path', 'offset', 'sha256'].includes(key))) throw protocol.error('UPLOAD_INVALID', 'Flash segment contains unapproved fields.');
    const artifact = manifest.artifacts.find(item => item.artifactId === segment.artifactId && item.path === segment.path && item.sha256 === segment.sha256);
    if (!artifact) throw protocol.error('ARTIFACT_INVALID', 'Flash plan does not reference a verified artifact.');
    const filename = regularFile(artifactRoot, artifact.path), bytes = fs.readFileSync(filename);
    if (bytes.length !== artifact.sizeBytes || protocol.sha256(bytes) !== artifact.sha256) throw protocol.error('ARTIFACT_INVALID', 'Firmware changed after cloud compilation.');
    return { ...segment, filename };
  });
  const baud = options.baudRate || 115200;
  if (!Number.isInteger(baud) || baud < 1200 || baud > 2000000 || !/^[a-zA-Z0-9_-]{1,64}$/u.test(plan.targetChip || '')) throw protocol.error('UPLOAD_INVALID', 'Flash plan has invalid chip or baud rate.');
  if (plan.protocol === 'avrdude' && plan.uploaderId === 'avrdude') {
    if (segments.length !== 1 || !segments[0].path.endsWith('.hex') || !/^[a-zA-Z0-9_-]{1,64}$/u.test(options.programmer || '')
        || Object.keys(options).some(key => !['programmer', 'baudRate'].includes(key))) throw protocol.error('UPLOAD_UNSUPPORTED', 'Unsupported AVR flash options.');
    const tool = resolveTool(runtimeRoot, 'avrdude', manifest.toolVersions?.avrdude, platform);
    return { command: tool.command, args: ['-C', tool.configPath, '-p', plan.targetChip, '-c', options.programmer, '-P', port,
      '-b', String(baud), '-D', '-U', `flash:w:${segments[0].filename}:i`], lifecycle, port };
  }
  if (plan.protocol === 'esptool' && plan.uploaderId === 'esptool') {
    if (Object.keys(options).some(key => !['baudRate', 'flashMode', 'flashFreq', 'flashSize', 'before', 'after'].includes(key))) throw protocol.error('UPLOAD_UNSUPPORTED', 'Unsupported ESP flash options.');
    const tool = resolveTool(runtimeRoot, 'esptool_py', manifest.toolVersions?.esptool_py, platform);
    const before = options.before || 'default-reset', after = options.after || 'hard-reset';
    if (!['default-reset', 'no-reset', 'usb-reset'].includes(before) || !['hard-reset', 'soft-reset', 'no-reset'].includes(after)) throw protocol.error('UPLOAD_INVALID', 'Invalid ESP reset policy.');
    const args = ['--chip', plan.targetChip, '--port', port, '--baud', String(baud), '--before', before, '--after', after, 'write-flash'];
    for (const [key, flag, values] of [['flashMode', '--flash-mode', ['keep', 'qio', 'qout', 'dio', 'dout']],
      ['flashFreq', '--flash-freq', ['keep', '20m', '26m', '40m', '80m']], ['flashSize', '--flash-size', ['keep', 'detect', '1MB', '2MB', '4MB', '8MB', '16MB', '32MB']]]) {
      if (options[key] !== undefined) { if (!values.includes(options[key])) throw protocol.error('UPLOAD_INVALID', 'Invalid ESP flash setting.'); args.push(flag, options[key]); }
    }
    for (const segment of segments) {
      if (!Number.isSafeInteger(segment.offset) || segment.offset < 0 || segment.offset > 0xffffffff || !segment.path.endsWith('.bin')) throw protocol.error('UPLOAD_INVALID', 'Invalid ESP flash segment.');
      args.push(`0x${segment.offset.toString(16)}`, segment.filename);
    }
    return { command: tool.command, args, lifecycle, port };
  }
  throw protocol.error('UPLOAD_UNSUPPORTED', 'This cloud target has no supported local serial uploader.');
}
async function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') await new Promise((resolve, reject) => {
    const killer = spawn(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.once('error', reject); killer.once('close', code => code === 0 || child.exitCode !== null ? resolve() : reject(protocol.error('UPLOAD_STOP_FAILED', 'Uploader process tree could not be stopped.')));
  });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
async function pulseDtr(port, signal) {
  if (signal.aborted) throw protocol.error('CANCELLED', 'Upload cancelled.');
  const { SerialPort } = require('serialport');
  const device = new SerialPort({ path: port, baudRate: 115200, autoOpen: false });
  const call = (method, value) => new Promise((resolve, reject) => device[method](...(value === undefined ? [] : [value]), error => error ? reject(error) : resolve()));
  try {
    await call('open'); await call('set', { dtr: false, rts: false });
    await new Promise(resolve => setTimeout(resolve, 100));
    if (signal.aborted) throw protocol.error('CANCELLED', 'Upload cancelled.');
    await call('set', { dtr: true, rts: true });
  } finally { if (device.isOpen) await call('close'); }
}
async function uploadCloudArtifact(record, request, { runtimeRoot, signal, onProgress = () => {}, runProcess, resetPort = pulseDtr, assertCurrent } = {}) {
  if (!signal) signal = new AbortController().signal;
  const send = event => { if (!signal.aborted) onProgress({ requestId: request.requestId, stage: 'uploading', ...event }); };
  // 先复制并再次校验固件，再烧录固定副本，防止项目编辑或产物替换影响正在烧录的字节。
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-cloud-flash-'));
  try {
    buildUploadCommand(record, request, runtimeRoot);
    for (const segment of record.manifest.flashPlan.segments) {
      const source = regularFile(record.directory, segment.path), target = path.join(staging, ...segment.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
    const command = buildUploadCommand(record, request, runtimeRoot, staging);
    await assertCurrent?.();
    if (signal.aborted) throw protocol.error('CANCELLED', 'Upload cancelled.');
    if (command.lifecycle.reset === 'serial-dtr') await resetPort(command.port, signal);
    await assertCurrent?.();
    if (signal.aborted) throw protocol.error('CANCELLED', 'Upload cancelled.');
    send({ progress: 0 });
    if (runProcess) await runProcess(command.command, command.args, signal, send);
    else {
      const child = spawn(command.command, command.args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', cwd: staging, stdio: ['ignore', 'pipe', 'pipe'] });
      let stopping; const abort = () => { stopping ||= stopProcess(child); stopping.catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      for (const stream of [child.stdout, child.stderr]) {
        const lines = readline.createInterface({ input: stream });
        lines.on('line', log => { const match = log.match(/(\d+(?:\.\d+)?)\s*%/u); send({ log: log.slice(0, 8192), ...(match ? { progress: Math.min(99, Number(match[1])) } : {}) }); });
      }
      try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        if (stopping) await stopping;
        if (signal.aborted) throw protocol.error('CANCELLED', 'Upload cancelled.');
        if (code !== 0) throw protocol.error('UPLOAD_FAILED', `Uploader exited with code ${code}.`);
      } finally { signal.removeEventListener('abort', abort); }
    }
    if (signal.aborted) throw protocol.error('CANCELLED', 'Upload cancelled.');
    send({ progress: 100 }); return { success: true, state: 'done', text: 'Upload complete.' };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
module.exports = { uploadCloudArtifact };
