const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { importProjectDirectory } = require('./project-file-copy');
const { MAX_PROJECT_FILE_BYTES } = require('./project-file-access');

const runFile = promisify(execFile);
const MAX_ARCHIVE_SIZE = 100 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 500 * 1024 * 1024;
const MAX_ENTRIES = 10000;

function safeArchivePath(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f\\:]/.test(value)
    || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..'
      || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('工程归档包含不安全的路径。');
  }
  return value;
}

function parseArchiveListing(output) {
  const entries = [];
  const paths = new Set();
  let total = 0;
  for (const block of output.trim().split(/\r?\n\r?\n/)) {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' = ');
      if (separator < 1 || Object.hasOwn(fields, line.slice(0, separator))) throw new Error('工程归档目录无法安全解析。');
      fields[line.slice(0, separator)] = line.slice(separator + 3);
    }
    // 7-Zip reports native Windows separators even for portable archive paths.
    const name = safeArchivePath(fields.Path?.replace(/\\/g, '/'));
    const key = name.toLowerCase();
    if (paths.has(key) || fields.Encrypted === '+' || Object.hasOwn(fields, 'Symbolic Link') || Object.hasOwn(fields, 'Hard Link')
      || /(?:^|\s)[lcbps][rwx-]{9}/.test(fields.Attributes || '')) throw new Error('工程归档包含链接、特殊文件、重复路径或加密内容。');
    paths.add(key);
    const directory = fields.Folder === '+' || /^D/.test(fields.Attributes || '') || /(?:^|\s)d[rwx-]{9}/.test(fields.Attributes || '');
    const size = Number(fields.Size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('工程归档大小无效。');
    total += size;
    entries.push({ name, size, directory });
    if (total > MAX_EXPANDED_SIZE || entries.length > MAX_ENTRIES) throw new Error('工程解压后超过资源限制。');
  }
  // A file cannot also be an ancestor directory, including case aliases on Windows.
  const files = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().split('/');
    while (parts.length > 1) {
      parts.pop();
      if (files.has(parts.join('/'))) throw new Error('工程归档路径冲突。');
    }
  }
  return entries;
}

async function extractArchive(archivePath, destination, sevenZipPath) {
  const { stdout } = await runFile(sevenZipPath, ['l', '-slt', '-ba', '-sccUTF-8', '-t7z', '--', archivePath], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  const entries = parseArchiveListing(stdout);
  const deadline = Date.now() + 120000;
  for (const entry of entries) {
    const target = path.join(destination, ...entry.name.split('/'));
    if (entry.directory) { fs.mkdirSync(target, { recursive: true }); continue; }
    if (Date.now() >= deadline) throw new Error('工程解压超时。');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Only this process writes paths. 7-Zip emits bytes and cannot create archive links.
    const child = spawn(sevenZipPath, ['x', '-so', '-spd', '-y', '-t7z', '--', archivePath, entry.name], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('工程归档已损坏，无法解压。')));
    });
    // Observe early child failures while the bounded stream is draining.
    completion.catch(() => {});
    const timer = setTimeout(() => child.kill(), Math.max(1, deadline - Date.now()));
    let bytes = 0;
    try {
      await pipeline(child.stdout, new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > entry.size ? new Error('工程解压大小与归档声明不一致。') : null, chunk);
      } }), fs.createWriteStream(target, { flags: 'wx' }));
      await completion;
      if (bytes !== entry.size) throw new Error('工程归档文件不完整。');
    } finally { clearTimeout(timer); child.kill(); await completion.catch(() => {}); }
  }
}

function validateProject(directory, product) {
  let root = directory;
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) root = path.join(root, entries[0].name);
  }
  const manifestPath = path.join(root, 'package.json');
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()
    || fs.statSync(manifestPath).size > 1024 * 1024) throw new Error('工程缺少有效的 package.json。');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('工程清单无效。');
  if (product === 'coder') {
    if (manifest.type !== 'coder') throw new Error('工程类型与编辑器不一致。');
    const entry = safeArchivePath(manifest.entry);
    const source = path.join(root, 'sketch', ...entry.split('/'));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error('Coder 工程缺少 sketch 入口源码。');
  } else {
    if (manifest.type === 'coder' || !fs.existsSync(path.join(root, 'project.abi'))
      || !fs.statSync(path.join(root, 'project.abi')).isFile()
      || fs.statSync(path.join(root, 'project.abi')).size > MAX_PROJECT_FILE_BYTES) throw new Error('Blockly 工程缺少有效的 project.abi 或文件过大。');
    JSON.parse(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'));
  }
  delete manifest.cloudId;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return root;
}

async function importProjectPackage({ archivePath, destination, product, sevenZipPath, tempRoot = os.tmpdir() }) {
  if (!path.isAbsolute(archivePath) || !path.isAbsolute(destination) || !['blockly', 'coder'].includes(product)) {
    throw new Error('工程包导入参数无效。');
  }
  const archive = fs.statSync(archivePath);
  if (!archive.isFile() || archive.size < 6 || archive.size > MAX_ARCHIVE_SIZE) throw new Error('工程归档大小无效。');
  const header = Buffer.alloc(6);
  const descriptor = fs.openSync(archivePath, 'r');
  try { fs.readSync(descriptor, header, 0, 6, 0); } finally { fs.closeSync(descriptor); }
  if (!header.equals(Buffer.from('377abcaf271c', 'hex'))) throw new Error('导入内容不是 7z 工程。');
  const working = fs.mkdtempSync(path.join(tempRoot, 'aily-project-import-'));
  try {
    await extractArchive(archivePath, working, sevenZipPath);
    const source = validateProject(working, product);
    return importProjectDirectory(source, destination);
  } finally {
    // working is created by mkdtemp above, never derived from archive input.
    fs.rmSync(working, { recursive: true, force: true });
  }
}

module.exports = { importProjectPackage };
