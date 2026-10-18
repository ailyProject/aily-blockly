'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const protocol = require('./protocol');
const childRoot = process.env.AILY_CHILD_PATH || path.resolve(__dirname, '..', '..', 'child');
const project = require(path.join(childRoot, 'scripts/aily-code-project'));
const { sourceManifest } = require(path.join(childRoot, 'scripts/build-source-capture'));

// 捕获编译所需源码、库和语义配置；隐藏文件、依赖目录和本地中间产物不进入上传快照。
const GENERATED = /^(?:build-config|upload-config|preprocess|target-compile|library-cache)\.json$|^compile-(?:request|preprocess)-.+\.json$/u;
const fault = (message, code = 'BUILD_SOURCE_STALE') => protocol.error(code, message);
const preciseState = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
function matchesPathState(pathState, fileState) {
  // Electron 的 Windows 路径 stat 可能返回零卷号，fstat 则有真实卷号；
  // 此兼容只放宽路径侧的零卷号，文件身份和描述符前后的一致性仍必须验证。
  return (pathState.dev === fileState.dev || (process.platform === 'win32' && pathState.dev === 0n))
    && pathState.ino === fileState.ino && pathState.size === fileState.size
    && pathState.mtimeNs === fileState.mtimeNs && pathState.ctimeNs === fileState.ctimeNs;
}
function checkedPhysicalRead(filename, before, verifyPath = true) {
  if (!before.isFile() || before.isSymbolicLink() || before.size > protocol.MAX_BYTES) throw fault('Unsafe build input.', 'UNSAFE_PATH');
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !matchesPathState(before, opened)) throw fault('Build source changed before its file was opened.');
    const bytes = Buffer.allocUnsafe(Number(before.size)); let offset = 0;
    // 按已验证的大小读取并处理分段返回，避免额外大小探测，也不暴露未写入的缓冲区尾部。
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw fault('Build source ended before its checked size.');
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = verifyPath ? fs.lstatSync(filename, { bigint: true }) : after;
    if (!current.isFile() || current.isSymbolicLink() || preciseState(opened) !== preciseState(after)
        || !matchesPathState(current, after) || before.size !== BigInt(bytes.length)) throw fault('Build source changed while capturing.');
    return bytes;
  } catch (error) {
    if (error.code === 'ELOOP') throw fault('Source tree contains an implicit link.', 'UNSAFE_PATH');
    if (error.code === 'ENOENT') throw fault('Build source changed while capturing.');
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function readPhysical(filename) { return checkedPhysicalRead(filename, fs.lstatSync(filename, { bigint: true })); }
function macros(value) {
  return (Array.isArray(value) ? value.flat(Infinity) : []).filter(item => !(item && typeof item === 'object' && item.value === null)).map(item => {
    if (typeof item === 'object' && item && typeof item.name === 'string') {
      const full = String(item.value ?? '1');
      return { name: item.name, value: full.startsWith(`${item.name}=`) ? full.slice(item.name.length + 1) : full };
    }
    const text = String(item), index = text.indexOf('=');
    return { name: index === -1 ? text : text.slice(0, index), value: index === -1 ? '1' : text.slice(index + 1) };
  });
}
function collectCloudLibraries(manifest, root, coder, read = readPhysical) {
  const owned = candidate => { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  const relevant = name => /^@aily-project(?:-coder|-linux)?\/(?:lib|board|coder)-[A-Za-z0-9_.-]+$/u.test(name);
  const locate = (parent, name) => {
    let cursor = parent;
    while (owned(cursor)) {
      const candidate = path.join(cursor, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (cursor === root) break;
      cursor = path.dirname(cursor);
    }
    return undefined;
  };
  const pending = Object.keys(manifest.dependencies || {}).filter(relevant).map(name => ({ name, parent: root }));
  const visited = new Set(), libraries = [];
  for (let index = 0; index < pending.length; index++) {
    const { name, parent } = pending[index], selected = locate(parent, name);
    if (!selected) throw fault(`Native package is missing: ${name}`, 'LIBRARY_SOURCE_UNAVAILABLE');
    const actual = fs.realpathSync(selected);
    if (coder && !owned(actual)) throw fault('Coder library package escapes the project.', 'UNSAFE_PATH');
    if (visited.has(actual)) continue;
    visited.add(actual);
    if (visited.size > 512) throw fault('Library dependency inventory exceeds its limit.', 'INPUT_TOO_LARGE');
    const pkg = JSON.parse(read(path.join(actual, 'package.json')));
    for (const dependency of Object.keys(pkg.dependencies || {}).filter(relevant)) pending.push({ name: dependency, parent: selected });
    if (/\/lib-/u.test(name) && !/\/lib-core(?:$|-)/u.test(name)) libraries.push({ packageName: name, packagePath: actual });
  }
  return libraries;
}
function captureSnapshot(config, profile, { identityOnly = false, onEncode } = {}) {
  // 单次捕获内相同物理文件只读取、哈希一次；保留各逻辑路径，维持相对 include 与 __FILE__ 语义。
  // 缓存不跨捕获保存，后续源码修改必须重新参与内容身份计算。
  const physical = new Map(), observed = new Map(), encoded = new WeakMap();
  const read = filename => {
    // NTFS 文件 ID 可能超过安全整数，使用 BigInt 防止不同文件被错误合并。
    const before = fs.lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > protocol.MAX_BYTES) throw fault('Unsafe build input.', 'UNSAFE_PATH');
    const signature = preciseState(before), key = before.dev && before.ino ? `${before.dev}:${before.ino}` : path.resolve(filename);
    const existing = physical.get(key);
    if (existing && existing.signature !== signature) throw fault('Build source changed while capturing.');
    observed.set(filename, signature);
    if (existing) return existing.bytes;
    // 读取前后绑定同一文件描述符，捕获结束再统一复核路径；独立读取仍即时复核路径。
    const bytes = checkedPhysicalRead(filename, before, false);
    physical.set(key, { signature, bytes });
    return bytes;
  };
  const observeDirectory = directory => {
    const info = fs.lstatSync(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw fault('Source tree contains an implicit link.', 'UNSAFE_PATH');
    const signature = preciseState(info), previous = observed.get(directory);
    if (previous !== undefined && previous !== signature) throw fault('Build source changed while capturing.');
    observed.set(directory, signature);
  };
  const root = fs.realpathSync(config.currentProjectPath);
  if (fs.lstatSync(root).isSymbolicLink() || typeof config.code !== 'string') throw fault('Invalid project source.');
  const packageBytes = read(path.join(root, 'package.json'));
  const manifest = JSON.parse(packageBytes.toString('utf8'));
  const boardRoot = fs.realpathSync(path.join(root, 'node_modules', config.boardModule));
  const boardPackage = JSON.parse(read(path.join(boardRoot, 'package.json')));
  const board = JSON.parse(read(path.join(boardRoot, 'board.json')));
  const boardIdentity = protocol.boardDigest(boardPackage, board);
  if (profile.boardModule !== config.boardModule || profile.boardVersion !== boardPackage.version || profile.boardDigest !== boardIdentity
      || profile.runner !== 'aily-builder') throw fault('The cloud target does not match this installed board package.', 'TARGET_UNSUPPORTED');
  const coder = project.isAilyCodeProjectRoot(root);
  const sourceRoot = coder && manifest.arduinoSketch !== true ? path.join(root, 'sketch') : coder ? root : path.join(root, 'src');
  const files = new Map(), libraries = [];
  let total = 0;
  const add = (relative, bytes) => {
    protocol.validateRelativePath(relative);
    let identity = encoded.get(bytes);
    if (!identity) {
      identity = { sizeBytes: bytes.length, sha256: protocol.sha256(bytes) };
      encoded.set(bytes, identity);
    }
    const item = { path: relative, ...identity };
    if (!identityOnly) {
      const encode = () => {
        if (!Object.hasOwn(identity, 'dataBase64')) {
          const started = performance.now(); identity.dataBase64 = bytes.toString('base64');
          const durationMs = performance.now() - started;
          onEncode?.({ durationMs, sizeBytes: bytes.length });
        }
        return identity.dataBase64;
      };
      // 先提交内容清单，仅为网关缺失的文件延迟生成 Base64；旧协议序列化时仍可完整编码。
      Object.defineProperty(item, 'dataBase64', { enumerable: true, get: encode });
    }
    const previous = files.get(relative);
    if (previous) total -= previous.sizeBytes;
    total += bytes.length;
    files.set(relative, item);
    if (total > protocol.MAX_BYTES || files.size > protocol.MAX_FILES) throw fault('Project exceeds the cloud build input budget.', 'INPUT_TOO_LARGE');
  };
  const walk = (directory, destination, skipRootFiles = new Set(), depth = 0) => {
    if (depth > 32) throw fault('Source tree exceeds its depth limit.', 'UNSAFE_PATH');
    observeDirectory(directory);
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (item.name === 'node_modules' || item.name.startsWith('.') || GENERATED.test(item.name) || (depth === 0 && skipRootFiles.has(item.name))) continue;
      const absolute = path.join(directory, item.name), relative = `${destination}/${item.name}`;
      if (item.isSymbolicLink()) throw fault('Source tree contains an implicit link.', 'UNSAFE_PATH');
      if (item.isDirectory()) walk(absolute, relative, new Set(), depth + 1);
      else if (item.isFile()) add(relative, read(absolute));
      else throw fault('Unsupported source entry.', 'UNSAFE_PATH');
    }
  };
  let entry;
  if (coder) {
    const nativeEntry = project.resolveCompileSourcePath(root);
    if (read(nativeEntry).toString('utf8') !== config.code) throw fault('Coder entry differs from the saved build request.');
    walk(sourceRoot, 'sketch', new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']));
    entry = `sketch/${path.relative(sourceRoot, nativeEntry).split(path.sep).join('/')}`;
  } else {
    if (fs.existsSync(sourceRoot)) walk(sourceRoot, 'sketch');
    entry = 'sketch/sketch.ino';
    add(entry, Buffer.from(config.code, 'utf8'));
  }
  // 只上传影响编译语义的项目配置，排除账户、设备设置及派生的编译元数据。
  const fields = ['type', 'entry', 'framework', 'devmode', 'arduinoSketch', 'dependencies', 'boardDependencies', 'projectConfig', 'macros', 'MACROS'];
  const buildManifest = Object.fromEntries(fields.filter(key => manifest[key] !== undefined).map(key => [key, manifest[key]]));
  add('aily-input/project.json', Buffer.from(protocol.canonicalJson(buildManifest)));
  const addLibrary = (name, source, destination) => {
    if (fs.lstatSync(source).isSymbolicLink()) throw fault('Library source directory is implicitly linked.', 'UNSAFE_PATH');
    const real = fs.realpathSync(source);
    walk(real, destination);
    if ([...files.keys()].some(filename => filename.startsWith(`${destination}/`))) libraries.push({ name, root: destination });
  };
  let index = 0;
  for (const item of collectCloudLibraries(manifest, root, coder, read)) {
    const libRoot = fs.realpathSync(item.packagePath);
    if (!fs.existsSync(path.join(libRoot, 'src'))) {
      if (fs.existsSync(path.join(libRoot, 'src.7z'))) throw fault(`Library source ${item.packageName} must be prepared before cloud capture.`, 'LIBRARY_SOURCE_UNAVAILABLE');
      continue;
    }
    // 保留 Arduino 标准库结构：根目录的 library.properties 和递归 src/。
    const destination = `libraries/npm-${index++}`;
    const countBefore = libraries.length;
    addLibrary(item.packageName, path.join(libRoot, 'src'), `${destination}/src`);
    const properties = path.join(libRoot, 'library.properties');
    if (fs.existsSync(properties)) add(`${destination}/library.properties`, read(properties));
    if (libraries.length > countBefore) libraries[libraries.length - 1].root = destination;
  }
  for (const folder of [path.join(root, 'components'), ...(coder ? [path.join(sourceRoot, 'libraries')] : [])]) {
    if (!fs.existsSync(folder)) continue;
    if (fs.lstatSync(folder).isSymbolicLink()) throw fault('Local library collection is linked.', 'UNSAFE_PATH');
    observeDirectory(folder);
    for (const item of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.isSymbolicLink()) throw fault('Local library must be a physical source directory.', 'UNSAFE_PATH');
      if (item.isDirectory()) addLibrary(item.name, path.join(folder, item.name), `libraries/local-${index++}`);
    }
  }
  const partitionOptions = manifest.projectConfig || {};
  if (partitionOptions.PartitionScheme === 'custom') {
    const candidates = [path.join(path.dirname(coder ? project.resolveCompileSourcePath(root) : path.join(root, 'src/sketch.ino')), 'partitions.csv'),
      path.join(root, 'partitions.csv'), config.partitionFilePath].filter(Boolean);
    const selected = candidates.find(filename => fs.existsSync(filename));
    const relative = selected && path.relative(root, path.resolve(selected));
    // Windows 跨盘符的 relative() 会返回绝对路径，也必须拒绝，不能只判断 ../。
    if (!selected || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fault('Custom partition source is unavailable.', 'INVALID_INPUT');
    add(`${path.posix.dirname(entry)}/partitions.csv`, read(selected));
  }
  const options = {};
  for (const key of Object.keys(profile.metadata?.boardOptions || {})) {
    const selected = manifest.projectConfig?.[key] ?? profile.metadata.defaults?.[key];
    if (selected !== undefined) options[key] = String(selected);
  }
  const snapshot = { schemaVersion: 1, kind: 'aily-cloud-build-input', mode: coder ? 'coder' : 'blockly',
    boardModule: config.boardModule, boardVersion: boardPackage.version, boardDigest: boardIdentity,
    entry, boardOptions: options, macros: macros(manifest.macros || manifest.MACROS || manifest.projectConfig?.macros || config.projectMacros || []),
    libraries, files: [...files.values()] };
  snapshot.inputDigest = protocol.snapshotDigest(snapshot);
  // 文件已由受检查的读取或自有缓冲区生成；这里只校验清单，避免二次解码、哈希全部源码。
  protocol.validateSnapshot(snapshot);
  for (const [filename, signature] of observed) {
    if (preciseState(fs.lstatSync(filename, { bigint: true })) !== signature) throw fault('Build source changed while capturing.');
  }
  const finalPackageBytes = readPhysical(path.join(root, 'package.json'));
  if (sourceManifest(finalPackageBytes) !== sourceManifest(packageBytes)) throw fault('Project configuration changed while capturing.');
  return snapshot;
}
const captureIdentity = (config, profile) => captureSnapshot(config, profile, { identityOnly: true });
module.exports = { captureSnapshot, captureIdentity };
