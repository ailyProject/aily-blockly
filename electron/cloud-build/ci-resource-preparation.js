'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { killRegisteredProcessTree } = require('../process-tree');
const protocol = require('./protocol');
const contract = require('./ci-resource-contract');
const { localDependencyPath } = require('./cloud-upload-runtime');
const childRoot = process.env.AILY_CHILD_PATH || path.resolve(__dirname, '..', '..', 'child');
const project = require(path.join(childRoot, 'scripts/aily-code-project'));
const fault = (code, message) => protocol.error(code, message);
const sha = bytes => protocol.sha256(bytes);
const requiresPreparedCapability = boardPackage => contract.SDK_VERSIONS.includes(boardPackage?.boardDependencies?.[contract.SDK_PACKAGE]);
const relocatedPath = filename => filename.startsWith('sketch/') ? 'sketch/.temp/sketch/' + filename.slice('sketch/'.length) : filename;
const inside = (root, filename) => { const relative = path.relative(root, filename); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function readPhysical(filename, limit = protocol.MAX_BYTES) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || fs.realpathSync(filename) !== path.resolve(filename)) throw fault('UNSAFE_PATH', 'CI input must be a bounded physical file.');
  const bytes = fs.readFileSync(filename), after = fs.lstatSync(filename);
  if (stat.ino !== after.ino || stat.size !== bytes.length || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw fault('BUILD_SOURCE_STALE', 'CI input changed while reading.');
  return bytes;
}
function inspect(config, { linkedNumberPlayback = false } = {}) {
  const root = fs.realpathSync(config.currentProjectPath);
  if (!/^@aily-project\/board-[A-Za-z0-9_.-]+$/u.test(config.boardModule || '')) throw fault('INVALID_INPUT', 'Invalid CI board package.');
  const boardRoot = path.join(root, 'node_modules', ...config.boardModule.split('/'));
  const pkg = JSON.parse(readPhysical(path.join(boardRoot, 'package.json'), 1024 * 1024));
  const sdk = pkg.boardDependencies?.[contract.SDK_PACKAGE];
  const intent = contract.detectIntent(config.code, { linkedNumberPlayback });
  if (!sdk || !intent.required) return null;
  if (!contract.SDK_VERSIONS.includes(sdk) || pkg.boardDependencies?.[contract.TOOL_PACKAGE] !== contract.TOOL_VERSION) throw fault('CI_RESOURCE_UNSUPPORTED', 'This CI resource generator requires a supported exact SDK and citool version.');
  const board = JSON.parse(readPhysical(path.join(boardRoot, 'board.json'), 4 * 1024 * 1024));
  return { root, pkg, sdk, intent, boardDigest: protocol.boardDigest(pkg, board) };
}
function requirements(config, appDataPath, options) {
  if (!inspect(config, options)) return [];
  const requirement = { kind: 'tool', name: contract.TOOL_PACKAGE, id: 'citool-cli', version: contract.TOOL_VERSION };
  let installed = false;
  try { localDependencyPath(appDataPath, requirement); installed = true; } catch { /* Normal renderer tool installer repairs the exact wrapper. */ }
  return [{ ...requirement, installed }];
}
function selectedProperties(snapshot, profile) {
  const properties = { ...profile.metadata?.rawBoardProperties };
  for (const [menu, definition] of Object.entries(profile.metadata?.boardOptions || {})) Object.assign(properties,
    definition.values?.[snapshot.boardOptions?.[menu] ?? profile.metadata.defaults?.[menu]]?.properties || {});
  return properties;
}
function mp3Inputs(config, snapshot, { assetRootRelative = path.posix.dirname(snapshot.entry) } = {}) {
  // citool's file-comment grammar is deliberately not used to parse ASR/TTS
  // requests. Here it only bounds the input files the real tool may read.
  const refs = contract.mp3References(config.code);
  const root = fs.realpathSync(config.currentProjectPath);
  const assetRoot = snapshot.mode === 'coder' ? path.dirname(project.resolveCompileSourcePath(root)) : root;
  return [...new Set(refs)].map(ref => {
    const normalized = ref.replace(/\\/gu, '/');
    if (!normalized || normalized.startsWith('/') || /[:\x00-\x1f]/u.test(normalized) || !/\.mp3$/iu.test(normalized)) throw fault('CI_ASSET_INPUT_UNSUPPORTED', 'CI MP3 inputs must be physical project-relative files.');
    const filename = path.resolve(assetRoot, ...normalized.split('/'));
    const relative = path.relative(root, filename);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fault('UNSAFE_PATH', 'CI MP3 input leaves the project.');
    const bytes = readPhysical(filename);
    const stagedPath = path.posix.normalize(assetRootRelative + '/' + normalized);
    if (stagedPath === '..' || stagedPath.startsWith('../') || path.posix.isAbsolute(stagedPath)) throw fault('UNSAFE_PATH', 'CI MP3 input leaves the owned preparation workspace.');
    const sha256 = sha(bytes);
    return { filename, path: stagedPath, stagedPath, relativeRef: normalized, assetRootRelative, bytes, sha256, sizeBytes: bytes.length };
  });
}
function verifyAssetInputs(prepared) {
  for (const item of prepared.assetInputs || []) {
    const bytes = readPhysical(item.filename);
    if (bytes.length !== item.sizeBytes || sha(bytes) !== item.sha256) throw fault('BUILD_SOURCE_STALE', 'CI MP3 source changed after resource generation.');
  }
}
function overlaySnapshot(snapshot, prepared, { identityOnly = false, limits } = {}) {
  if (!prepared) return snapshot;
  if (snapshot.inputDigest !== prepared.rawInputDigest) throw fault('BUILD_SOURCE_STALE', 'CI source inputs changed after resource generation.');
  verifyAssetInputs(prepared);
  const files = new Map(snapshot.files.map(file => {
    const item = prepared.relocateBlockly ? { ...file, path: relocatedPath(file.path) } : file;
    return [item.path, item];
  }));
  for (const asset of prepared.assetInputs || []) {
    const previous = files.get(asset.path);
    if (previous && previous.sha256 !== asset.sha256) throw fault('CI_ASSET_INPUT_UNSUPPORTED', 'CI MP3 input conflicts with a distinct source file.');
  }
  for (const item of prepared.files) files.set(item.path, { path: item.path, sizeBytes: item.bytes.length, sha256: sha(item.bytes),
    ...(!identityOnly ? { dataBase64: item.bytes.toString('base64') } : {}) });
  const result = { ...snapshot, ...(prepared.relocateBlockly ? { entry: relocatedPath(snapshot.entry) } : {}), files: [...files.values()] };
  result.inputDigest = protocol.snapshotDigest(result);
  protocol.validateSnapshot(result, limits);
  return result;
}
function validateProvenance(value, source, intent, output) {
  if (value?.schema_version !== 1 || value.service_url !== contract.SERVICE_URL || !/^[a-f0-9]{64}$/u.test(value.cache_key || '')
      || typeof value.source !== 'string' || path.normalize(value.source) !== path.normalize(source)
      || !!value.asr_request !== intent.asr || !!value.tts_request !== intent.tts) throw fault('CI_RESOURCE_PREPARATION_FAILED', 'citool did not confirm generation for the current source; sign in and retry.');
  const requests = { asr: value.asr_request || null, tts: value.tts_request || null };
  if (requests.asr && (typeof requests.asr.chip_type !== 'string' || !Array.isArray(requests.asr.commands) || !requests.asr.commands.length)
      || requests.tts && (!Array.isArray(requests.tts.voice) || !requests.tts.voice.length)) throw fault('CI_RESOURCE_PREPARATION_FAILED', 'citool returned incomplete resource requests.');
  const files = contract.expectedFiles(intent).map(name => {
    const bytes = readPhysical(path.join(output, name));
    if (!bytes.length || value.files?.[name]?.size !== bytes.length || value.files[name].sha256 !== sha(bytes)) throw fault('CI_RESOURCE_PREPARATION_FAILED', 'citool generated resource bytes do not match their provenance.');
    return { name, bytes };
  });
  return { requests, files };
}
async function runTool(executable, args, options, { signal, launch = spawn, onOutput = () => {}, stopTree = killRegisteredProcessTree } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = launch(executable, args, options);
    let error, diagnostic = '', closed = false, result, stopping, stopTimer, finished = false;
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', bytes => {
      const text = bytes.toString(); diagnostic = (diagnostic + text).slice(-65536);
      onOutput(text, stream);
    });
    const cleanupFault = () => Object.assign(fault('CI_RESOURCE_STOP_FAILED', 'The owned CI resource process tree could not be confirmed stopped.'), { cleanupConfirmed: false });
    const finish = async () => {
      if (finished || !closed) return;
      try {
        if (stopping && !await stopping) throw cleanupFault();
        if (finished) return;
        finished = true; clearTimeout(stopTimer); signal?.removeEventListener('abort', stop);
        if (error) reject(error);
        else if (signal?.aborted) reject(signal.reason || fault('CANCELLED', 'CI resource generation cancelled.'));
        else if (result.code !== 0 || result.terminationSignal) reject(fault('CI_RESOURCE_PREPARATION_FAILED', diagnostic.trim() || 'CI resource generation failed.'));
        else resolve();
      } catch (cause) { finished = true; clearTimeout(stopTimer); signal?.removeEventListener('abort', stop); reject(cause); }
    };
    // Reuse the desktop's owned PID tree termination. A failed tree cleanup or
    // missing close acknowledgement preserves the workspace for recovery.
    const stop = () => {
      if (stopping || closed) return;
      stopping = Number.isSafeInteger(child.pid) && child.pid > 1 && child.pid !== process.pid
        ? Promise.resolve(stopTree(child.pid, 'cloud-ci-resources')).catch(() => false) : Promise.resolve(false);
      stopTimer = setTimeout(() => {
        if (!finished) { finished = true; signal?.removeEventListener('abort', stop); reject(cleanupFault()); }
      }, 15000);
      stopping.then(ok => {
        if (!ok && !finished) { finished = true; clearTimeout(stopTimer); signal?.removeEventListener('abort', stop); reject(cleanupFault()); }
        else void finish();
      });
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.once('error', value => { error = value; });
    child.once('close', (code, terminationSignal) => {
      closed = true; result = { code, terminationSignal }; void finish();
    });
  });
}
async function prepare(config, snapshot, profile, { appDataPath, signal, assertCurrent, launch, onOutput, limits, stopTree, linkedNumberPlayback = false } = {}) {
  const checked = inspect(config, { linkedNumberPlayback });
  if (!checked) return null;
  protocol.validateSnapshot(snapshot, limits);
  if (profile.capabilities?.ciPreparedResourcesV1 !== true) throw fault('CI_RESOURCE_UNSUPPORTED', 'No cloud node supports verified CI resource inputs for this target.');
  if (snapshot.boardDigest !== checked.boardDigest || snapshot.boardVersion !== checked.pkg.version || snapshot.boardModule !== config.boardModule) throw fault('BUILD_SOURCE_STALE', 'CI board package changed before preparation.');
  const requirement = { kind: 'tool', name: contract.TOOL_PACKAGE, id: 'citool-cli', version: contract.TOOL_VERSION };
  const runtime = localDependencyPath(appDataPath, requirement);
  const executable = path.join(runtime.directory, process.platform === 'win32' ? 'citool-cli.exe' : 'citool-cli'); readPhysical(executable);
  const properties = selectedProperties(snapshot, profile), chip = properties['build.chip'];
  if (typeof chip !== 'string' || !/^ci\d+$/iu.test(chip)) throw fault('CI_RESOURCE_UNSUPPORTED', 'The CI profile has no exact SDK chip property.');
  const algorithm = snapshot.boardOptions?.Algorithm ?? profile.metadata?.defaults?.Algorithm ?? '';
  const relocateBlockly = snapshot.mode === 'blockly', entry = relocateBlockly ? relocatedPath(snapshot.entry) : snapshot.entry;
  const assetRootRelative = relocateBlockly ? 'sketch' : path.posix.dirname(entry);
  const root = contract.resourceRoot(entry, algorithm);
  const assetInputs = checked.intent.tts ? mp3Inputs(config, snapshot, { assetRootRelative }) : [];
  const tempRoot = fs.realpathSync(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(tempRoot, 'aily-ci-prepare-'));
  const workspaceIdentity = fs.lstatSync(workspace, { bigint: true });
  let cleanupConfirmed = true, originalError;
  try {
    const stagedSource = path.join(workspace, ...entry.split('/'));
    for (const file of snapshot.files.filter(item => item.path.startsWith('sketch/'))) {
      const bytes = Buffer.from(file.dataBase64, 'base64');
      if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256) throw fault('INPUT_HASH_MISMATCH', 'CI preparation input differs from its snapshot.');
      const target = path.join(workspace, ...(relocateBlockly ? relocatedPath(file.path) : file.path).split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    for (const asset of assetInputs) {
      let directory = path.resolve(workspace, ...asset.assetRootRelative.split('/'));
      for (const segment of asset.relativeRef.split('/').slice(0, -1)) {
        directory = path.resolve(directory, segment);
        if (!inside(workspace, directory)) throw fault('UNSAFE_PATH', 'CI MP3 directory leaves the owned workspace.');
        fs.mkdirSync(directory, { recursive: true });
      }
      const target = path.resolve(workspace, ...asset.stagedPath.split('/'));
      if (!inside(workspace, target)) throw fault('UNSAFE_PATH', 'CI MP3 input leaves the owned workspace.');
      if (fs.existsSync(target) && sha(readPhysical(target)) !== asset.sha256) throw fault('CI_ASSET_INPUT_UNSUPPORTED', 'CI MP3 input conflicts with a distinct source file.');
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, asset.bytes, { mode: 0o600 });
    }
    const sourceBytes = readPhysical(stagedSource);
    if (sourceBytes.toString('utf8') !== config.code) throw fault('BUILD_SOURCE_STALE', 'CI preparation source differs from the active request.');
    const output = path.join(workspace, 'generated'); fs.mkdirSync(output, { mode: 0o700 });
    await assertCurrent(); signal?.throwIfAborted();
    const environment = { ...process.env, AILY_APPDATA_PATH: appDataPath, CITOOL_CLI_CACHE_DIR: path.join(appDataPath, 'cache', 'citool-cli') };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete environment[key];
    await runTool(executable, ['generate', '--source', stagedSource, '--asset-root', path.join(workspace, ...assetRootRelative.split('/')), '--chip', chip,
      '--service-url', contract.SERVICE_URL, '--output', output], { cwd: workspace, env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }, { signal, launch, onOutput, stopTree });
    await assertCurrent(); signal?.throwIfAborted(); verifyAssetInputs({ assetInputs });
    if (sha(readPhysical(stagedSource)) !== sha(sourceBytes)) throw fault('CI_RESOURCE_PREPARATION_FAILED', 'CI generation changed its source input.');
    for (const asset of assetInputs) if (sha(readPhysical(path.join(workspace, ...asset.stagedPath.split('/')))) !== asset.sha256) throw fault('CI_RESOURCE_PREPARATION_FAILED', 'CI generation changed an MP3 input.');
    let provenance;
    try { provenance = JSON.parse(readPhysical(path.join(output, 'citool-service.json'), 1024 * 1024)); }
    catch (cause) { throw Object.assign(fault('CI_RESOURCE_PREPARATION_FAILED', 'CI resource generation was not confirmed; sign in and retry.'), { cause }); }
    const generated = validateProvenance(provenance, stagedSource, checked.intent, output);
    const manifest = { schemaVersion: 1, kind: contract.KIND, boardModule: snapshot.boardModule, boardVersion: snapshot.boardVersion, boardDigest: snapshot.boardDigest,
      sdk: { package: contract.SDK_PACKAGE, version: checked.sdk }, tool: { package: contract.TOOL_PACKAGE, version: contract.TOOL_VERSION },
      entry, sourceSha256: sha(sourceBytes), algorithm, resourceRoot: root,
      serviceUrl: provenance.service_url, cacheKey: provenance.cache_key, requests: generated.requests,
      files: generated.files.map(item => ({ name: item.name, path: root + '/' + item.name, sizeBytes: item.bytes.length, sha256: sha(item.bytes) })) };
    const files = [...assetInputs.map(item => ({ path: item.path, bytes: item.bytes })),
      ...generated.files.map(item => ({ path: root + '/' + item.name, bytes: item.bytes })),
      { path: contract.MANIFEST_PATH, bytes: Buffer.from(protocol.canonicalJson(manifest)) }];
    return { rawInputDigest: snapshot.inputDigest, relocateBlockly, assetInputs, manifest, files };
  } catch (error) {
    originalError = error;
    if (error.cleanupConfirmed === false) { cleanupConfirmed = false; error.workspace = workspace; }
    throw error;
  } finally {
    // All operations and the native child's close have settled before removal.
    if (cleanupConfirmed) {
      try {
        const absolute = path.resolve(workspace), current = fs.lstatSync(absolute, { bigint: true });
        if (path.dirname(absolute) !== tempRoot || !path.basename(absolute).startsWith('aily-ci-prepare-')
            || !current.isDirectory() || current.isSymbolicLink() || fs.realpathSync(absolute) !== absolute
            || current.dev !== workspaceIdentity.dev || current.ino !== workspaceIdentity.ino) throw new Error('CI workspace identity changed.');
        fs.rmSync(absolute, { recursive: true, force: true });
      } catch (cause) {
        throw Object.assign(fault('CI_RESOURCE_STOP_FAILED', 'The owned CI resource workspace could not be safely removed.'),
          { cleanupConfirmed: false, workspace, cause: originalError || cause });
      }
    }
  }
}
module.exports = { requiresPreparedCapability, inspect, requirements, selectedProperties, mp3Inputs, verifyAssetInputs, overlaySnapshot, validateProvenance, runTool, prepare };
