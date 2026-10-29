'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

// Build preparation only. No runtime fallback, installation or renderer bridge.
const CHILD_NODE_DEPENDENCIES = Object.freeze([Object.freeze({ name: 'fs-native-extensions', version: '1.5.1' })]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`[child-node-dependencies] ${message}`); };
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)); };
const pin = async file => { const bytes = await fs.readFile(file); return { path: path.resolve(file), bytes: bytes.length, sha256: hash(bytes) }; };
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));

function lockDependency(packages, parent, name) {
  let cursor = parent;
  for (;;) {
    const candidate = (cursor ? cursor + '/' : '') + 'node_modules/' + name;
    if (packages[candidate]) return candidate;
    const index = cursor.lastIndexOf('/node_modules/');
    if (index >= 0) cursor = cursor.slice(0, index);
    else if (cursor) cursor = '';
    else fail(`Lockfile is missing ${name}; run npm ci in the Blockly source root.`);
  }
}

async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Expected a regular dependency file: ${file}`);
  return stat;
}

async function packageRoot(entry, name, nodeModulesRoot) {
  let cursor = path.dirname(entry);
  while (inside(nodeModulesRoot, cursor)) {
    try { if ((await json(path.join(cursor, 'package.json'))).name === name) return cursor; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  fail(`Resolved ${name} outside root node_modules; run npm ci in the Blockly source root.`);
}

/** Resolve the declared npm closure before SDK preparation can download or
 * copy anything. The selected tree is the normal root node_modules tree. */
async function planChildNodeDependencies({ workspaceRoot, platform = process.platform, arch = process.arch } = {}) {
  if (!path.isAbsolute(workspaceRoot || '')) fail('Expected an absolute Blockly source root.');
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) fail('Invalid target platform or architecture.');
  const manifestPath = path.join(workspaceRoot, 'package.json'), lockPath = path.join(workspaceRoot, 'package-lock.json');
  const manifest = await json(manifestPath), lock = await json(lockPath);
  if (!lock.packages) fail('A current npm lockfile is required; run npm ci in the Blockly source root.');
  let nodeModulesRoot;
  try { nodeModulesRoot = await fs.realpath(path.join(workspaceRoot, 'node_modules')); }
  catch (error) { if (error.code === 'ENOENT') fail('Root node_modules is unavailable; run npm ci in the Blockly source root.'); throw error; }
  const roots = CHILD_NODE_DEPENDENCIES.map(({ name, version }) => {
    if (manifest.dependencies?.[name] !== version || lock.packages['']?.dependencies?.[name] !== version)
      fail(`Declare exact ${name}@${version} in the source manifest and lockfile.`);
    return { name, version, parent: '', requester: createRequire(manifestPath) };
  });
  const packages = [], files = [], visited = new Set(), queue = [...roots];
  while (queue.length) {
    const { name, version, parent, requester } = queue.shift(), relativeRoot = lockDependency(lock.packages, parent, name);
    if (visited.has(relativeRoot)) continue;
    visited.add(relativeRoot);
    const locked = lock.packages[relativeRoot];
    let entry;
    try { entry = await fs.realpath(requester.resolve(name)); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND' || error.code === 'ENOENT') fail(`${name} is unavailable; run npm ci in the Blockly source root.`); throw error; }
    const sourceRoot = await packageRoot(entry, name, nodeModulesRoot), packageFile = path.join(sourceRoot, 'package.json');
    const data = await json(packageFile);
    if (!inside(nodeModulesRoot, sourceRoot) || data.version !== locked.version || (version && data.version !== version))
      fail(`Installed ${name} differs from the lockfile; run npm ci in the Blockly source root.`);
    if (!/^sha512-[A-Za-z0-9+/=]+$/.test(locked.integrity || '') || !Array.isArray(data.files))
      fail(`Missing integrity or published file declaration for ${name}.`);
    const nativeRelative = name === 'fs-native-extensions' ? `prebuilds/${platform}-${arch}/fs-native-extensions.node` : null;
    const selected = new Set(['package.json']);
    // Published runtime JS/JSON keeps package exports intact. C/C++ sources,
    // build tools, docs and other targets' prebuilds are not runtime payloads.
    const visit = async relative => {
      const absolute = path.join(sourceRoot, relative), stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) fail(`Linked published file refused: ${name}/${relative}`);
      if (stat.isDirectory()) { for (const child of (await fs.readdir(absolute)).sort()) await visit(relative ? relative + '/' + child : child); }
      else if (stat.isFile() && /\.(?:[cm]?js|json)$/.test(relative)) selected.add(relative);
    };
    for (const published of data.files) {
      if (typeof published !== 'string' || published.includes('..') || path.isAbsolute(published) || /[*?]/.test(published))
        fail(`Unsupported published file declaration for ${name}.`);
      if (published === 'prebuilds' || !/\.(?:[cm]?js|json)$/.test(published) && path.extname(published)) continue;
      try { await visit(published); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const licenses = (await fs.readdir(sourceRoot)).filter(name => /^(?:licen[sc]e|notice|copying)(?:\.|$)/i.test(name));
    if (!licenses.length || typeof data.license !== 'string') fail(`License material missing for ${name}.`);
    for (const license of licenses) selected.add(license);
    if (nativeRelative) { try { await regular(path.join(sourceRoot, nativeRelative)); } catch (error) { if (error.code === 'ENOENT') fail(`No ${platform}-${arch} native prebuild in installed ${name}.`); throw error; } selected.add(nativeRelative); }
    if (!selected.has(path.relative(sourceRoot, entry).split(path.sep).join('/'))) fail(`Published runtime entry is missing for ${name}.`);
    packages.push({ name, version: data.version, relativeRoot, license: data.license,
      declaredTarballIntegrity: locked.integrity, tarballIntegrityRecomputed: false,
      manifest: await pin(packageFile), runtimeEntry: path.relative(sourceRoot, entry).split(path.sep).join('/') });
    for (const relative of [...selected].sort()) {
      const source = path.join(sourceRoot, relative); await regular(source);
      files.push({ relative: relativeRoot + '/' + relative, source: await pin(source),
        role: relative === nativeRelative ? 'native-binding' : licenses.includes(relative) ? 'license' : relative === 'package.json' ? 'manifest' : 'runtime' });
    }
    for (const dependency of Object.keys(locked.dependencies || {}).sort()) queue.push({ name: dependency, parent: relativeRoot, requester: createRequire(packageFile) });
  }
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const plan = { schemaVersion: 1, kind: 'child-node-dependency-plan', workspaceRoot, platform, arch, nodeModulesRoot,
    manifest: await pin(manifestPath), lock: await pin(lockPath), packages, files };
  plan.inventorySha256 = hash(JSON.stringify(files.map(({ relative, source, role }) => ({ relative, bytes: source.bytes, sha256: source.sha256, role }))));
  return plan;
}

async function safeTarget(root, relative) {
  if (!relative.startsWith('node_modules/') || relative.split('/').some(part => !part || part === '..' || part === '.')) fail('Invalid child dependency destination.');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) fail('Child dependency path escaped the preparation directory.');
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try { const stat = await fs.lstat(cursor); if (stat.isSymbolicLink()) fail('Child dependency destination cannot traverse links.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

/** Copy only declared runtime members into an external child tree. Existing
 * identical bytes are reused; SDKs and other child modules are untouched. */
async function materializeChildNodeDependencies(plan, { destination } = {}) {
  if (plan?.kind !== 'child-node-dependency-plan' || !path.isAbsolute(destination || '')) fail('Invalid dependency preparation request.');
  const root = path.resolve(destination);
  if (key(root) === key(path.resolve(plan.workspaceRoot)) || inside(plan.nodeModulesRoot, root)) fail('Expected an external child preparation directory.');
  const inventory = hash(JSON.stringify(plan.files.map(({ relative, source, role }) => ({ relative, bytes: source.bytes, sha256: source.sha256, role }))));
  if (inventory !== plan.inventorySha256) fail('Source dependency inventory changed after planning.');
  for (const row of plan.files) if (!inside(plan.nodeModulesRoot, await fs.realpath(row.source.path))) fail('Dependency source escaped root node_modules.');
  for (const row of [plan.manifest, plan.lock, ...plan.files.map(file => file.source)]) {
    await regular(row.path); if (JSON.stringify(await pin(row.path)) !== JSON.stringify(row)) fail('Source dependency changed after planning.');
  }
  // Reject destination links before the first write, including the root itself.
  try { if ((await fs.lstat(root)).isSymbolicLink()) fail('Child preparation root cannot be a link.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const row of plan.files) await safeTarget(root, row.relative);
  const receiptPath = path.join(root, 'node-dependencies.receipt.json');
  try {
    const stat = await fs.lstat(receiptPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('Dependency receipt cannot be linked or non-regular.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(root, { recursive: true });
  // Revoke only this tool's old success receipt before any runtime bytes change.
  try { await fs.unlink(receiptPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let copiedFiles = 0, reusedFiles = 0;
  for (const row of plan.files) {
    const target = await safeTarget(root, row.relative);
    try { if (await fs.readFile(target).then(bytes => hash(bytes)) === row.source.sha256) { reusedFiles++; continue; } }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.part`;
    try {
      const bytes = await fs.readFile(row.source.path);
      if (bytes.length !== row.source.bytes || hash(bytes) !== row.source.sha256) fail('Source changed before dependency copy.');
      await fs.writeFile(temporary, bytes, { flag: 'wx' });
      await safeTarget(root, row.relative); await fs.rename(temporary, target); copiedFiles++;
    } finally { try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  const members = [];
  for (const row of plan.files) { const target = await pin(await safeTarget(root, row.relative)); if (target.sha256 !== row.source.sha256 || target.bytes !== row.source.bytes) fail('Prepared dependency byte verification failed.'); members.push({ relative: row.relative, bytes: target.bytes, sha256: target.sha256, role: row.role }); }
  const receipt = { schemaVersion: 1, kind: 'prepared-child-node-dependencies', platform: plan.platform, arch: plan.arch,
    packageInventory: plan.packages, inventorySha256: plan.inventorySha256, members, copiedFiles, reusedFiles,
    rootDependencyManifest: plan.manifest, rootDependencyLock: plan.lock, installationOrDownloadPerformed: false,
    SDKOrOtherChildPayloadCopiedByThisModule: false, NodePathOrAsarRequired: false };
  for (const row of [plan.manifest, plan.lock, ...plan.files.map(file => file.source)]) {
    if (JSON.stringify(await pin(row.path)) !== JSON.stringify(row)) fail('Source dependency changed during preparation.');
  }
  const temporary = `${receiptPath}.${randomUUID()}.part`;
  try { await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, receiptPath); }
  finally { try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  return receipt;
}

async function prepareChildNodeDependencies(options) {
  const plan = await planChildNodeDependencies(options);
  return materializeChildNodeDependencies(plan, options);
}

module.exports = { CHILD_NODE_DEPENDENCIES, planChildNodeDependencies, materializeChildNodeDependencies, prepareChildNodeDependencies };
