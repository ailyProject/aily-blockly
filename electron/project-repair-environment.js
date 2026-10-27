'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { createProjectRecoveryReceipts } = require('./project-recovery-receipts');

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fail = message => Object.assign(new Error(message), { code: 'PROJECT_REPAIR_ENVIRONMENT_INVALID' });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
function readJson(file, limit = 256 * 1024) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw fail('Repair evidence is not a bounded private regular file.');
  const data = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw Object.assign(fail('Repair evidence changed while reading.'), { code: 'PROJECT_REPAIR_EVIDENCE_CHANGED' });
  return JSON.parse(data.toString('utf8'));
}
function writeNew(file, record) { fs.writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
function writeRecord(file, record) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeNew(temp, record); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function codeIdentity(execPath, appPath) {
  // Fixed first-party protocol boundary, not a dependency/source-tree scan.
  const inputs = ['package.json', 'electron/main.js', 'electron/preload.js', 'renderer/index.html',
    'electron/project-repair-environment.js', 'electron/project-repair-lineage.js', 'electron/project-repair-normalization.js',
    'electron/project-recovery-receipts.js', 'electron/project-repair-handoff.js', 'electron/project-repair-primary.js',
    'electron/project-file-access.js', 'electron/project-lock.js', 'child/scripts/native-file-lock.js',
    'child/scripts/build-workspace-lease.js', 'child/scripts/system-boot-id.js'].sort();
  return hash(JSON.stringify([key(execPath), key(appPath), ...inputs.map(relative => {
    const file = path.join(appPath, relative);
    return [relative, fs.existsSync(file) ? hash(fs.readFileSync(file)) : null];
  })]));
}
function rendererOverride(value) {
  if (!value) return null;
  let url; try { url = new URL(value); } catch { throw fail('Development renderer must be an explicit loopback HTTP root.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('Development renderer must be an explicit loopback HTTP root.');
  return url.origin;
}
function verifyFork(parentAppData, sourceProject, requestId, expectedTargetHash, physicalOrigin, admission) {
  const store = createProjectRecoveryReceipts(parentAppData), receipt = store.status(sourceProject, requestId), result = receipt?.result;
  const delegated = admission?.version === 1 && admission.kind === 'authenticated-repair-child'
    && same(admission.receiptRoot, parentAppData) && same(admission.sourceEnvironment?.project, sourceProject)
    && admission.sourceEnvironment.version === 2 && Number.isSafeInteger(admission.sourceEnvironment.hostPid)
    && admission.sourceEnvironment.hostPid > 0 && Number.isSafeInteger(admission.sourceEnvironment.epoch)
    && admission.sourceEnvironment.epoch > 0 && same(admission.project, result?.project);
  if (receipt?.state !== 'completed' || result?.projectSaved !== true || result.activated === true
    || admission && !delegated || result.recoverySource?.complete !== true || !same(result.sourceProject, sourceProject)
    || (delegated ? !['saved-document', 'workspace'].includes(result.recoverySource.kind)
      : result.activationBlocked?.reason !== 'partial-canvas-unavailable' || result.recoverySource.kind !== 'saved-document'
        || result.recoverySource.partialCanvas !== 'unavailable')
    || !path.isAbsolute(result.project) || same(result.project, sourceProject)
    || expectedTargetHash !== false && store.abiHash(result.project) !== (expectedTargetHash || receipt.targetAbiHash)) throw fail('Independent repair requires the exact completed saved-primary fork.');
  const targetDirectory = fs.lstatSync(result.project), physicalTarget = key(fs.realpathSync(result.project));
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  };
  if (physicalOrigin && (physicalOrigin.version !== 1 || !path.isAbsolute(physicalOrigin.sourceProject || '')
    || !same(physicalOrigin.targetProject, physicalTarget))) throw fail('Repair target differs from its native physical origin.');
  let currentSource;
  try { currentSource = key(fs.realpathSync(sourceProject)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!physicalOrigin) throw Object.assign(fail('The saved target is preserved, but its older lineage has no verified physical source snapshot.'),
      { code: 'PROJECT_REPAIR_HISTORICAL_PROOF_UNAVAILABLE' });
  }
  const physicalSource = physicalOrigin?.sourceProject || currentSource;
  if (!targetDirectory.isDirectory() || targetDirectory.isSymbolicLink()
    || contains(physicalSource, physicalTarget) || contains(physicalTarget, physicalSource)
    || currentSource && (contains(currentSource, physicalTarget) || contains(physicalTarget, currentSource)))
    throw fail('Repair target must remain an independent physical directory.');
  if (!delegated || result.recoverySource.kind === 'saved-document' || result.recoveryArchive) {
    if (!same(path.dirname(result.recoveryArchive || ''), result.project)) throw fail('The recovery archive is not owned by its exact target.');
    const archive = readJson(result.recoveryArchive, 256 * 1024 * 1024);
    if (archive.version !== 1 || !same(archive.sourceProject, sourceProject)
      || result.recoverySource.kind === 'saved-document' && (typeof archive.files?.['project.abi'] !== 'string'
        || hash(archive.files['project.abi']) !== receipt.sourceAbiHash || receipt.targetAbiHash !== receipt.sourceAbiHash)
      || !delegated && archive.partialCanvas?.captured !== false) throw fail('Saved primary and source archive do not match the original fork.');
  }
  return { receipt, result, physicalOrigin: { version: 1, sourceProject: physicalSource, targetProject: physicalTarget } };
}
function publicEnvironment(record, state = record.state) {
  return { version: 1, state, project: record.project, sourceProject: record.sourceProject,
    parentHostPid: record.parentHostPid, ...(record.hostPid ? { hostPid: record.hostPid } : {}), requestId: record.requestId,
    environmentId: record.environmentId, originalViewPreserved: record.originalViewPreserved === true, hostCodeIdentity: record.hostCodeIdentity };
}
function exactIdentity(record, params) {
  return params && Object.keys(params).every(name => ['project', 'environmentId', 'requestId', 'parentHostPid'].includes(name))
    && same(params.project, record.project) && params.environmentId === record.environmentId
    && params.requestId === record.requestId && params.parentHostPid === record.parentHostPid;
}
function queryChild(record, discoveryRoot = path.join(os.homedir(), '.aily-blockly', 'cli-bridge'), operation = 'project_repair_identity') {
  return new Promise(resolve => {
    let descriptor;
    try { descriptor = readJson(path.join(discoveryRoot, `${record.hostPid}.json`)); }
    catch { resolve(null); return; }
    if (descriptor.pid !== record.hostPid || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535
      || typeof descriptor.token !== 'string') { resolve(null); return; }
    const body = JSON.stringify({ token: descriptor.token, action: 'blockly-live-operation', operation,
      params: { project: record.project, environmentId: record.environmentId, requestId: record.requestId, parentHostPid: record.parentHostPid,
        ...(record.lineageId ? { version: 2, lineageId: record.lineageId, epoch: record.epoch } : {}) } });
    const request = http.request({ host: '127.0.0.1', port: descriptor.port, path: '/command', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 1800 }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 65536) response.destroy(); });
      response.on('end', () => { try { const value = JSON.parse(text), env = value.result?.repairEnvironment ?? value.repairEnvironment;
        resolve(env && exactIdentity(record, { project: env.project, environmentId: env.environmentId, requestId: env.requestId, parentHostPid: env.parentHostPid })
          && env.hostPid === record.hostPid && env.hostCodeIdentity === record.hostCodeIdentity
          && (!record.lineageId || env.lineageId === record.lineageId && env.epoch === record.epoch)
          ? { ...env, ...(value.ownerStatus ? { ownerStatus: value.ownerStatus } : {}) } : null);
      } catch { resolve(null); } });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy()); request.on('error', () => resolve(null)); request.end(body);
  });
}
function seedPrivateData(record, parentAppData) {
  fs.mkdirSync(record.privateAppData, { recursive: true, mode: 0o700 });
  fs.mkdirSync(record.profile, { recursive: true, mode: 0o700 });
  const config = { compile: { backend: 'local' }, metricsEnabled: false, project_path: path.dirname(record.project) };
  const configFile = path.join(parentAppData, 'config.json');
  if (fs.existsSync(configFile)) {
    const parent = readJson(configFile, 1024 * 1024);
    for (const name of ['lang', 'theme', 'font', 'region', 'build_flavor', 'installed']) {
      if (typeof parent[name] === 'string' && /^[a-zA-Z0-9_.-]{0,96}$/.test(parent[name])) config[name] = parent[name];
    }
    const endpoints = ['api_server', 'web', 'ucenter_web', 'tool_web', 'npm_registry', 'npm_registry_linux', 'npm_registry_coder', 'resource', 'updater'];
    const regions = {};
    for (const [name, region] of Object.entries(parent.regions || {})) {
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name) || !region || typeof region !== 'object') continue;
      const clean = {};
      for (const endpoint of endpoints) {
        try { const url = new URL(region[endpoint]); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) clean[endpoint] = url.href; } catch { /* Ignore credentials or malformed endpoints. */ }
      }
      regions[name] = clean;
    }
    config.regions = regions;
  }
  writeNew(path.join(record.privateAppData, 'config.json'), config);
  // Platform package manifests are readiness facts, not linked mutable package
  // trees. SDK/compiler bodies stay in the parent's read-only resource roots.
  const manifest = readJson(path.join(record.project, 'package.json'));
  const installed = {};
  for (const name of Object.keys(manifest.boardDependencies || {})) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw fail('Invalid platform package name.');
    const from = path.join(parentAppData, 'node_modules', name, 'package.json');
    if (!fs.existsSync(from)) continue;
    const value = readJson(from), destination = path.join(record.privateAppData, 'node_modules', name, 'package.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true }); writeNew(destination, value); installed[name] = value.version;
  }
  writeNew(path.join(record.privateAppData, 'package.json'), { name: 'aily-repair-private-platform', private: true, dependencies: installed });
}
function childEnvironment(parent, record, filename) {
  // Deliberately no inherited Agent/session credentials or auth-file overrides.
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'home', 'homedrive', 'homepath',
    'userprofile', 'username', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'programdata',
    'systemdrive', 'lang', 'lc_all', 'display', 'wayland_display', 'xdg_runtime_dir',
    'aily_build_product', 'aily_build_flavor', 'aily_connector_project', 'aily_dev_renderer_url', 'aily_e2e']);
  const env = {};
  for (const [name, value] of Object.entries(parent)) if (allowed.has(name.toLowerCase()) && typeof value === 'string') env[name] = value;
  return { ...env, AILY_REPAIR_BOOTSTRAP: filename, AILY_APPDATA_PATH: record.privateAppData,
    AILY_BUILDER_PATH: path.join(path.dirname(record.privateAppData), 'builder-cache'),
    npm_config_cache: path.join(path.dirname(record.privateAppData), 'npm-cache') };
}

/** Prepare lineage only. The Agent must first verify the immutable fork and
 * associate its target; explicit resume may then start the child. This avoids
 * a first-load normalization racing the initial source/target verification. */
function createRepairEnvironmentController(options) {
  const { appDataPath, execPath, appPath, serve = false, env = process.env } = options;
  const observeChild = options.observeChild || queryChild;
  const ownPid = options.pid || process.pid, hostCodeIdentity = codeIdentity(execPath, appPath), inFlight = new Map();
  const root = path.join(appDataPath, 'agent-repair-environments');
  async function ensure(sourceProject, requestId, delegation) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw fail('Repair environment root is linked.');
    const filename = path.join(root, hash(key(sourceProject) + '\0' + requestId).slice(7) + '.json');
    if (fs.existsSync(filename)) {
      const record = readJson(filename);
      const { result } = verifyFork(record.parentAppData, sourceProject, requestId, false, record.physicalOrigin, record.admission);
      if (record.version !== 1 || !same(record.project, result.project) || !same(record.sourceProject, sourceProject)
        || record.requestId !== requestId || record.hostCodeIdentity !== hostCodeIdentity) throw fail('Repair launch identity conflicts with this completed fork.');
      const observed = Number.isInteger(record.hostPid) ? await observeChild(record) : null;
      return observed || publicEnvironment({ ...record, originalViewPreserved: options.sourceViewRetained?.(record) === true }, record.state === 'failed' ? 'failed' : 'starting');
    }
    const receiptRoot = delegation?.receiptRoot || appDataPath;
    const { result, receipt, physicalOrigin } = verifyFork(receiptRoot, sourceProject, requestId, false, undefined, delegation);
    if (createProjectRecoveryReceipts(receiptRoot).abiHash(result.project) !== receipt.targetAbiHash) throw fail('Initial repair launch requires the exact freshly saved fork primary.');
    const environmentId = randomUUID(), privateRoot = path.join(root, environmentId);
    fs.mkdirSync(privateRoot, { mode: 0o700 });
    const sourceRendererGeneration = options.sourceRendererGeneration?.();
    const record = { version: 1, state: 'starting', launchState: 'prepared', environmentId, requestId, sourceProject, project: result.project,
      parentHostPid: ownPid, hostPid: null, hostCodeIdentity, parentAppData: receiptRoot,
      ...(delegation ? { admission: delegation } : {}),
      originalViewPreserved: !delegation && (options.sourceViewRetained ? options.sourceViewRetained({ sourceProject, parentHostPid: ownPid, sourceRendererGeneration }) === true : true),
      sourceRendererGeneration, physicalOrigin,
      execPath, appPath, privateAppData: path.join(privateRoot, 'appdata'), profile: path.join(privateRoot, 'profile'),
      sharedResources: { sdk: env.AILY_SDK_PATH || path.join(appDataPath, 'sdk'), tools: env.AILY_TOOLS_PATH || path.join(appDataPath, 'tools'),
        compilers: env.AILY_COMPILERS_PATH || path.join(appDataPath, 'tools'), npmPrefix: env.AILY_NPM_PREFIX || path.join(appDataPath, 'npm-global') },
      rendererUrl: serve ? rendererOverride(env.AILY_DEV_RENDERER_URL) : null };
    try { writeNew(filename, record); }
    catch (error) { if (error.code === 'EEXIST') return ensure(sourceProject, requestId, delegation); throw error; }
    require('./project-repair-lineage').registerRepairLineage(record, filename);
    return publicEnvironment(record);
  }
  return { prepareDelegated({ sourceRecord, sourceEnvironment, sourceProject, project, requestId }) {
    if (!same(sourceRecord?.project, sourceProject) || !same(sourceEnvironment?.project, sourceProject)
      || sourceRecord.hostPid !== sourceEnvironment.hostPid || sourceRecord.environmentId !== sourceEnvironment.environmentId
      || sourceRecord.lineageId !== sourceEnvironment.lineageId || sourceRecord.epoch !== sourceEnvironment.epoch
      || sourceEnvironment.parentHostPid !== ownPid || sourceRecord.hostCodeIdentity !== hostCodeIdentity
      || !path.isAbsolute(sourceRecord.privateAppData || '')) throw fail('Delegated preparation requires an authenticated native source record.');
    return ensure(sourceProject, requestId, { version: 1, kind: 'authenticated-repair-child',
      receiptRoot: sourceRecord.privateAppData, sourceEnvironment, project });
  }, ensure(source, request) {
    const id = `${key(source)}\0${request}`;
    if (inFlight.has(id)) return inFlight.get(id);
    const promise = ensure(source, request).finally(() => inFlight.delete(id)); inFlight.set(id, promise); return promise;
  } };
}

function readRepairBootstrap(filename, { execPath, appPath, pid = process.pid }) {
  if (!filename) return null;
  const record = readJson(filename);
  if (record.version !== 1 || !/^[a-f0-9-]{36}$/.test(record.environmentId || '') || !same(record.execPath, execPath)
    || !same(record.appPath, appPath) || record.hostCodeIdentity !== codeIdentity(execPath, appPath)
    || !same(record.privateAppData, path.join(path.dirname(filename), record.environmentId, 'appdata'))
    || !same(record.profile, path.join(path.dirname(filename), record.environmentId, 'profile'))
    || !Number.isInteger(record.parentHostPid) || record.parentHostPid === pid) throw fail('Repair bootstrap does not belong to this exact application.');
  const { receipt, result } = verifyFork(record.parentAppData, record.sourceProject, record.requestId, record.targetAbiHash, record.physicalOrigin, record.admission);
  if (!same(record.project, result.project)) throw fail('Repair target does not match the completed fork.');
  // The parent records the real spawn PID independently before the child can
  // claim a renderer. A replayed bootstrap cannot create a second owner.
  const spawnRecord = readJson(path.join(path.dirname(filename), record.environmentId, 'spawn.json'));
  if (spawnRecord.pid !== pid || spawnRecord.environmentId !== record.environmentId) throw fail('Repair bootstrap belongs to another process.');
  record.hostPid = pid;
  return {
    record,
    admission() {
      verifyFork(record.parentAppData, record.sourceProject, record.requestId, record.targetAbiHash, record.physicalOrigin, record.admission);
      const proof = result.recoverySource.kind === 'workspace'
        ? require('./project-repair-primary').createNativeRepairPrimary(record, receipt, result) : null;
      return { ...result, activated: false, ...(proof ? { recoveryArchive: proof.archive, nativePrimaryProof: proof } : {}),
        targetAbiHash: record.targetAbiHash || receipt.targetAbiHash };
    },
    identity(params) {
      const continuation = require('./project-repair-lineage').readChildLineageIdentity(record, params, pid);
      if (continuation) return continuation;
      if (!exactIdentity(record, params)) return { ok: false, code: 'PROJECT_REPAIR_IDENTITY_MISMATCH', message: 'Repair identity must name this exact target and environment.' };
      const current = readJson(filename);
      return { ok: true, operation: 'project_repair_identity', repairEnvironment: publicEnvironment({ ...record, state: current.state }) };
    },
    complete(loadStatus, normalizationTransitions = []) {
      if (!same(loadStatus?.project, record.project)) throw fail('Repair renderer opened a different target.');
      const store = createProjectRecoveryReceipts(record.parentAppData);
      record.initialNormalization = require('./project-repair-normalization').verifyRepairNormalization(record.project,
        record.targetAbiHash || receipt.targetAbiHash, store.abiHash(record.project), normalizationTransitions);
      const state = loadStatus.ready === true ? 'ready' : loadStatus.error ? 'load-failed' : 'failed';
      record.state = state; writeRecord(filename, record); return publicEnvironment(record);
    },
    failed() { record.state = 'failed'; writeRecord(filename, record); },
  };
}
async function shutdownRepairEnvironment(bootstrap, params, ports) {
  const identity = bootstrap?.identity(params);
  if (identity?.ok !== true) return { ok: false, code: 'PROJECT_REPAIR_IDENTITY_MISMATCH', message: 'Only the exact authenticated repair environment can be closed.' };
  if (ports.currentProject()) return { ok: false, code: 'PROJECT_REPAIR_VIEW_ACTIVE', message: 'Close the repair project through the normal project-close tool before closing its host.' };
  const admitted = await ports.admit(bootstrap.record.project);
  if (admitted?.ok !== true || ports.currentProject()) return { ok: false, code: 'PROJECT_REPAIR_VIEW_BUSY', message: 'A live view or writer remains; the repair host was not closed.' };
  ports.close();
  return { ok: true, operation: 'project_repair_shutdown', repairEnvironment: identity.repairEnvironment };
}
module.exports = { createRepairEnvironmentController, readRepairBootstrap, codeIdentity, rendererOverride, verifyFork, queryChild, childEnvironment, shutdownRepairEnvironment,
  readJson, writeNew, writeRecord, seedPrivateData };
