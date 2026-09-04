// 远端子应用目录与用户级 npm 安装管理。
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { exec, spawn } = require('child_process');
const { URL } = require('url');
const semver = require('semver');
const { killRegisteredProcessTree } = require('./process-tree');

const INDEX_CACHE_FILE = 'subapp-index.json';
const INDEX_CACHE_META_FILE = 'subapp-index.meta.json';
const UPDATE_STATE_FILE = 'state.json';
const UPDATE_PACKAGE_FILE = 'package.tgz';
const UPDATE_LOCK_FILE = 'activate.lock';
const UPDATE_JOURNAL_FILE = 'activation.json';
const UPDATE_ROLLBACK_PACKAGE = 'rollback-package';
const UPDATE_ROLLBACK_MANIFEST = 'rollback-package.json';
const UPDATE_ROLLBACK_LOCK_MANIFEST = 'rollback-package-lock.json';
const UPDATE_SCHEMA_VERSION = 1;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const TOOL_ID_ALIASES = Object.freeze({
  'ffs-manager': 'ffs-manager-child',
  'aily-simulator': 'simulator',
});
const STARTUP_TIMEOUTS = Object.freeze({
  'aily-chat': 30000,
  'ffs-manager-child': 10000,
});
const DEFAULT_TOOLBAR_IDS = new Set(['aily-chat']);
const mutationQueues = new Map();

function buildSubappIndexUrl(resourceUrl) {
  const normalizedResourceUrl = String(resourceUrl || '').trim().replace(/\/+$/, '');
  return normalizedResourceUrl ? `${normalizedResourceUrl}/subapp-index.json` : '';
}

function readDefaultIndexUrl() {
  try {
    const config = require('./config/config.json');
    const defaultRegion = config?.region || 'cn';
    return buildSubappIndexUrl(config?.regions?.[defaultRegion]?.resource);
  } catch (error) {
    console.warn('[subapp-manager] failed to read the default resource config:', error.message || error);
    return '';
  }
}

const DEFAULT_INDEX_URL = readDefaultIndexUrl();

function resolveAppDataPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AILY_APPDATA_PATH) return path.resolve(env.AILY_APPDATA_PATH);
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return platformPath.join(home, 'AppData', 'Local', 'aily-project');
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'aily-project');
  return platformPath.join(home, '.config', 'aily-project');
}

function resolveSubappRoot(options = {}) {
  if (options.rootDir) return path.resolve(options.rootDir);
  const platform = options.platform || process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  return platformPath.join(
    resolveAppDataPath(options.env, options.platform, options.home),
    'npm-global',
    'app',
  );
}

function resolveSubappUpdateRoot(options = {}) {
  if (options.updateRootDir) return path.resolve(options.updateRootDir);
  return path.join(
    resolveAppDataPath(options.env, options.platform, options.home),
    'temp',
    'subapp-updates',
  );
}

function updateVersionDirectory(updateRootDir, id, version) {
  return path.join(updateRootDir, validateId(id), validateVersion(version));
}

function updateStatePath(updateRootDir, id, version) {
  return path.join(updateVersionDirectory(updateRootDir, id, version), UPDATE_STATE_FILE);
}

function updatePackagePath(updateRootDir, id, version) {
  return path.join(updateVersionDirectory(updateRootDir, id, version), UPDATE_PACKAGE_FILE);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeLocale(value) {
  return String(value || 'en').trim().toLowerCase().replace(/-/g, '_');
}

function normalizeOnly(value, id) {
  if (value === undefined) return 'all';
  return requireText(value, `${id} only`).toLowerCase();
}

function resolveEnabledFlag(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'boolean') return value;
  }
  return true;
}

function validateId(value) {
  const id = requireText(value, 'subapp id');
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) {
    throw new Error(`Invalid subapp id: ${id}`);
  }
  return id;
}

function validatePackageName(value) {
  const packageName = requireText(value, 'subapp package');
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new Error(`Invalid subapp package: ${packageName}`);
  }
  return packageName;
}

function validateVersion(value) {
  const version = requireText(value, 'subapp version');
  if (!semver.valid(version)) {
    throw new Error(`Invalid subapp version: ${version}`);
  }
  return version;
}

function validateUpdatePolicy(value, id) {
  if (value === undefined) return null;
  if (!isObject(value)) throw new Error(`${id} update policy must be an object`);
  if (value.download !== 'background' || value.install !== 'next-launch') {
    throw new Error(`${id} update policy must use background download and next-launch install`);
  }
  return {
    download: 'background',
    install: 'next-launch',
  };
}

function validateDistribution(value, id) {
  if (value === undefined) return null;
  if (!isObject(value)) throw new Error(`${id} dist must be an object`);
  const tarball = requireText(value.tarball, `${id} dist.tarball`);
  if (!/^https?:\/\//i.test(tarball)) {
    throw new Error(`${id} dist.tarball must be an HTTP(S) URL`);
  }
  const integrity = requireText(value.integrity, `${id} dist.integrity`);
  if (!/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${id} dist.integrity must be a supported SRI digest`);
  }
  return { tarball, integrity };
}

function validateIndex(rawIndex) {
  if (!isObject(rawIndex)) {
    throw new Error('Subapp index must be a JSON object');
  }
  if (rawIndex.dev !== undefined && typeof rawIndex.dev !== 'boolean') {
    throw new Error('Subapp index dev flag must be a boolean');
  }

  const index = rawIndex.dev === true ? { dev: true } : {};
  for (const [indexId, rawEntry] of Object.entries(rawIndex)) {
    if (indexId === 'dev') continue;
    if (!isObject(rawEntry)) throw new Error(`Invalid subapp entry: ${indexId}`);
    const id = validateId(rawEntry.id || indexId);
    if (id !== indexId) throw new Error(`Subapp index key does not match id: ${indexId}`);
    const namespace = requireText(rawEntry.namespace, `${id} namespace`);
    const titleKey = requireText(rawEntry.titleKey, `${id} titleKey`);
    const app = isObject(rawEntry.app) ? rawEntry.app : {};
    const i18n = isObject(rawEntry.i18n) ? rawEntry.i18n : {};
    const locales = isObject(i18n.locales) ? i18n.locales : {};
    const defaultLocale = normalizeLocale(i18n.defaultLocale || 'en');
    const update = validateUpdatePolicy(rawEntry.update, id);
    const dist = validateDistribution(rawEntry.dist, id);

    index[id] = {
      ...rawEntry,
      id,
      only: normalizeOnly(rawEntry.only, id),
      titleKey,
      namespace,
      package: validatePackageName(rawEntry.package),
      version: validateVersion(rawEntry.version),
      app: {
        ...app,
        name: typeof app.name === 'string' && app.name.trim() ? app.name.trim() : titleKey,
        description: typeof app.description === 'string' && app.description.trim()
          ? app.description.trim()
          : `${namespace}.DESCRIPTION`,
        icon: typeof app.icon === 'string' && app.icon.trim()
          ? app.icon.trim()
          : 'fa-light fa-puzzle-piece',
        enabled: resolveEnabledFlag(
          app.enabled,
          app.enable,
          rawEntry.enabled,
          rawEntry.enable,
        ),
        extension: app.extension === true,
      },
      i18n: {
        ...i18n,
        defaultLocale,
        locales,
      },
      ...(update ? { update } : {}),
      ...(dist ? { dist } : {}),
      ...(isObject(rawEntry.compatibility) ? { compatibility: rawEntry.compatibility } : {}),
    };
  }
  return index;
}

function packagePathFor(rootDir, packageName) {
  const modulesRoot = path.join(rootDir, 'node_modules');
  const packagePath = path.resolve(modulesRoot, ...packageName.split('/'));
  const relative = path.relative(modulesRoot, packagePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe subapp package path: ${packageName}`);
  }
  return packagePath;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function parseIntegrity(value) {
  const match = String(value || '').trim().match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new Error('Package integrity must be a sha256, sha384, or sha512 SRI digest');
  return { algorithm: match[1], digest: match[2] };
}

function verifyFileIntegrity(filePath, integrity) {
  const expected = parseIntegrity(integrity);
  const actual = createHash(expected.algorithm).update(fs.readFileSync(filePath)).digest('base64');
  if (actual !== expected.digest) {
    throw new Error(`Subapp package integrity mismatch: expected ${integrity}`);
  }
  return true;
}

function isDistRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  return normalized === 'dist' || normalized.startsWith('dist/');
}

function resolveUiIndex(packagePath, packageJson) {
  const configured = typeof packageJson?.aily?.uiIndex === 'string'
    ? packageJson.aily.uiIndex.trim()
    : typeof packageJson?.ailyBlockly?.uiIndex === 'string'
      ? packageJson.ailyBlockly.uiIndex.trim()
      : '';
  // Host may only serve package-root UI. Never fall back to dist/<id>/ui.
  const candidates = [
    configured && !isDistRelativePath(configured) ? configured : '',
    path.join('ui', 'index.html'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(packagePath, candidate)))
    || candidates[0]
    || path.join('ui', 'index.html');
}

/**
 * Prefer the package-root portable layout. Source packages that still point
 * `main` into `dist/<id>/` are rewritten onto that nested root when it already
 * has a flattened portable package.json; otherwise dist entries are rejected.
 */
function resolveRunnablePackage(packagePath, catalogId, packageJson) {
  const nestedPortablePath = path.join(packagePath, 'dist', catalogId);
  const nestedPackageJsonPath = path.join(nestedPortablePath, 'package.json');
  if (fs.existsSync(nestedPackageJsonPath)) {
    try {
      const nestedPackageJson = readJson(nestedPackageJsonPath);
      const nestedMain = typeof nestedPackageJson.main === 'string' && nestedPackageJson.main.trim()
        ? nestedPackageJson.main.trim()
        : 'index.js';
      const nestedUiIndex = resolveUiIndex(nestedPortablePath, nestedPackageJson);
      if (
        !isDistRelativePath(nestedMain)
        && !isDistRelativePath(nestedUiIndex)
        && fs.existsSync(path.join(nestedPortablePath, nestedMain))
        && fs.existsSync(path.join(nestedPortablePath, nestedUiIndex))
      ) {
        return {
          packagePath: nestedPortablePath,
          packageJson: nestedPackageJson,
          mainEntry: nestedMain,
          uiIndex: nestedUiIndex,
        };
      }
    } catch {
      // Fall through to the declared package root.
    }
  }

  const mainEntry = typeof packageJson.main === 'string' && packageJson.main.trim()
    ? packageJson.main.trim()
    : 'index.js';
  const uiIndex = resolveUiIndex(packagePath, packageJson);
  return {
    packagePath,
    packageJson,
    mainEntry,
    uiIndex,
  };
}

function resolvePackageRelativePath(packagePath, relativePath, label) {
  const value = requireText(relativePath, label);
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be package-relative`);
  }
  const resolved = path.resolve(packagePath, value);
  const relative = path.relative(packagePath, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return { relative: value.replace(/\\/g, '/'), resolved };
}

function positiveInteger(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.floor(number));
}

function optionalBoundedInteger(value, label, min, max) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function readRuntimeResourceLifecycleConfig(declaredRuntime) {
  const declared = declaredRuntime?.resourceLifecycle;
  if (declared === undefined) return null;
  if (!isObject(declared)) {
    throw new Error('ailySubapp.runtime.resourceLifecycle must be an object');
  }
  if (!Array.isArray(declared.resources) || declared.resources.length === 0) {
    throw new Error('ailySubapp.runtime.resourceLifecycle.resources must be a non-empty array');
  }
  const resources = [...new Set(declared.resources.map((value, index) => {
    const resource = requireText(value, `ailySubapp.runtime.resourceLifecycle.resources[${index}]`);
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(resource)) {
      throw new Error(`Invalid Subapp Runtime resource kind: ${resource}`);
    }
    return resource;
  }))];
  const suspendMethod = requireText(
    declared.suspendMethod,
    'ailySubapp.runtime.resourceLifecycle.suspendMethod',
  );
  const resumeMethod = requireText(
    declared.resumeMethod,
    'ailySubapp.runtime.resourceLifecycle.resumeMethod',
  );
  const timeoutMs = optionalBoundedInteger(
    declared.timeoutMs,
    'ailySubapp.runtime.resourceLifecycle.timeoutMs',
    100,
    10 * 60 * 1000,
  );
  return {
    resources,
    suspendMethod,
    resumeMethod,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function readRuntimeProcessMessagePortConfig(declaredRuntime) {
  const declared = declaredRuntime?.processMessagePort;
  if (declared === undefined) return null;
  if (!isObject(declared)) {
    throw new Error('ailySubapp.runtime.processMessagePort must be an object');
  }
  if (declared.transport !== 'node-ipc-v1') {
    throw new Error('ailySubapp.runtime.processMessagePort.transport must be node-ipc-v1');
  }
  const maxMessageBytes = optionalBoundedInteger(
    declared.maxMessageBytes,
    'ailySubapp.runtime.processMessagePort.maxMessageBytes',
    1024,
    8 * 1024 * 1024,
  );
  return {
    transport: 'node-ipc-v1',
    ...(maxMessageBytes !== undefined ? { maxMessageBytes } : {}),
  };
}

function validateUiSurfaceName(value, label) {
  const name = requireText(value, label);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
  return name;
}

function readSubappUiConfig(packagePath, packageJson, uiIndex) {
  const declared = packageJson?.ailySubapp?.ui;
  if (declared === undefined) return null;
  if (!isObject(declared)) {
    throw new Error('ailySubapp.ui must be an object');
  }
  if (!isObject(declared.surfaces) || !Object.keys(declared.surfaces).length) {
    throw new Error('ailySubapp.ui.surfaces must be a non-empty object');
  }

  const surfaces = {
    default: {
      entry: String(uiIndex || path.join('ui', 'index.html')).replace(/\\/g, '/'),
    },
  };
  for (const [rawName, rawSurface] of Object.entries(declared.surfaces)) {
    const name = validateUiSurfaceName(rawName, 'UI surface name');
    if (!isObject(rawSurface)) {
      throw new Error(`UI surface ${name} must be an object`);
    }
    const entry = resolvePackageRelativePath(
      packagePath,
      typeof rawSurface.entry === 'string' && rawSurface.entry.trim()
        ? rawSurface.entry
        : uiIndex,
      `ailySubapp.ui.surfaces.${name}.entry`,
    );
    if (!fs.existsSync(entry.resolved)) {
      throw new Error(`Subapp UI surface entry not found: ${entry.relative}`);
    }

    const minWidth = optionalBoundedInteger(
      rawSurface.minWidth,
      `ailySubapp.ui.surfaces.${name}.minWidth`,
      160,
      4096,
    );
    const minHeight = optionalBoundedInteger(
      rawSurface.minHeight,
      `ailySubapp.ui.surfaces.${name}.minHeight`,
      120,
      4096,
    );
    const preferredHeight = optionalBoundedInteger(
      rawSurface.preferredHeight,
      `ailySubapp.ui.surfaces.${name}.preferredHeight`,
      120,
      8192,
    );
    if (minHeight !== undefined && preferredHeight !== undefined && preferredHeight < minHeight) {
      throw new Error(`UI surface ${name} preferredHeight must be greater than or equal to minHeight`);
    }
    if (rawSurface.interactive !== undefined && typeof rawSurface.interactive !== 'boolean') {
      throw new Error(`ailySubapp.ui.surfaces.${name}.interactive must be a boolean`);
    }

    surfaces[name] = {
      entry: entry.relative,
      ...(minWidth !== undefined ? { minWidth } : {}),
      ...(minHeight !== undefined ? { minHeight } : {}),
      ...(preferredHeight !== undefined ? { preferredHeight } : {}),
      ...(rawSurface.interactive !== undefined ? { interactive: rawSurface.interactive } : {}),
    };
  }
  return { surfaces };
}

function validateAgentToolPresentation(rawPresentation, toolName) {
  if (rawPresentation === undefined) return null;
  if (!isObject(rawPresentation)) {
    throw new Error(`Agent tool ${toolName} presentation must be an object`);
  }
  const mode = rawPresentation.mode;
  if (mode !== 'embedded' && mode !== 'window' && mode !== 'dock') {
    throw new Error(`Agent tool ${toolName} presentation.mode must be embedded, window, or dock`);
  }

  let surface;
  if (rawPresentation.surface !== undefined) {
    surface = validateUiSurfaceName(
      rawPresentation.surface,
      `agent tool ${toolName} presentation.surface`,
    );
  }

  const supportedAutoOpen = new Set(['never', 'first-active', 'always', 'on-error']);
  let autoOpen;
  if (rawPresentation.autoOpen !== undefined) {
    autoOpen = requireText(
      rawPresentation.autoOpen,
      `agent tool ${toolName} presentation.autoOpen`,
    );
    if (!supportedAutoOpen.has(autoOpen)) {
      throw new Error(
        `Agent tool ${toolName} presentation.autoOpen must be never, first-active, always, or on-error`,
      );
    }
  }

  let when;
  if (rawPresentation.when !== undefined) {
    if (!isObject(rawPresentation.when)) {
      throw new Error(`Agent tool ${toolName} presentation.when must be an object`);
    }
    const param = requireText(
      rawPresentation.when.param,
      `agent tool ${toolName} presentation.when.param`,
    );
    const values = rawPresentation.when.values;
    if (!Array.isArray(values) || !values.length || values.some(value =>
      typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'
    )) {
      throw new Error(
        `Agent tool ${toolName} presentation.when.values must contain JSON scalar values`,
      );
    }
    when = { param, values: [...values] };
  }

  return {
    mode,
    ...(surface ? { surface } : {}),
    ...(autoOpen ? { autoOpen } : {}),
    ...(when ? { when } : {}),
  };
}

function validateAgentLifecycle(rawLifecycle) {
  if (rawLifecycle === undefined) return null;
  if (!isObject(rawLifecycle)) {
    throw new Error('Subapp Agent lifecycle must be an object');
  }
  if (rawLifecycle.sessionRelease === undefined) return {};
  if (!isObject(rawLifecycle.sessionRelease)) {
    throw new Error('Subapp Agent lifecycle.sessionRelease must be an object');
  }
  const method = requireText(
    rawLifecycle.sessionRelease.method,
    'Subapp Agent lifecycle.sessionRelease.method',
  );
  const params = rawLifecycle.sessionRelease.params;
  if (params !== undefined && !isObject(params)) {
    throw new Error('Subapp Agent lifecycle.sessionRelease.params must be an object');
  }
  return {
    sessionRelease: {
      method,
      ...(params ? { params } : {}),
      timeoutMs: positiveInteger(rawLifecycle.sessionRelease.timeoutMs, 5000, 30000),
    },
  };
}

function validateAgentTool(rawTool, index) {
  if (!isObject(rawTool)) throw new Error(`Agent tool ${index + 1} must be an object`);
  const name = requireText(rawTool.name, `agent tool ${index + 1} name`);
  if (!/^[a-z][a-z0-9_]{0,99}$/.test(name)) {
    throw new Error(`Invalid agent tool name: ${name}`);
  }
  const rpc = isObject(rawTool.rpc) ? rawTool.rpc : {};
  const method = typeof rpc.method === 'string' && rpc.method.trim() ? rpc.method.trim() : '';
  const actionParam = typeof rpc.actionParam === 'string' && rpc.actionParam.trim()
    ? rpc.actionParam.trim()
    : '';
  const methods = isObject(rpc.methods)
    ? Object.fromEntries(Object.entries(rpc.methods)
      .filter(([action, mappedMethod]) => action && typeof mappedMethod === 'string' && mappedMethod.trim())
      .map(([action, mappedMethod]) => [action, mappedMethod.trim()]))
    : {};
  if (!method && (!actionParam || !Object.keys(methods).length)) {
    throw new Error(`Agent tool ${name} must declare rpc.method or rpc.actionParam + rpc.methods`);
  }
  if (!isObject(rawTool.inputSchema)) {
    throw new Error(`Agent tool ${name} inputSchema must be an object`);
  }
  const presentation = validateAgentToolPresentation(rawTool.presentation, name);
  return {
    name,
    description: typeof rawTool.description === 'string' ? rawTool.description.trim() : name,
    rpc: {
      ...(method ? { method } : {}),
      ...(actionParam ? { actionParam, methods } : {}),
    },
    ...(presentation ? { presentation } : {}),
    permission: rawTool.permission === 'change' ? 'change' : 'read',
    requiresSession: rawTool.requiresSession === true,
    supportsCancellation: rawTool.supportsCancellation === true,
    timeoutMs: positiveInteger(rawTool.timeoutMs, 15000, 10 * 60 * 1000),
    maxTimeoutMs: positiveInteger(rawTool.maxTimeoutMs, 60000, 10 * 60 * 1000),
    maxInputBytes: positiveInteger(rawTool.maxInputBytes, 1024 * 1024, 16 * 1024 * 1024),
    maxOutputBytes: positiveInteger(rawTool.maxOutputBytes, 48 * 1024, 1024 * 1024),
    inputSchema: rawTool.inputSchema,
  };
}

function readSubappAgentConfig(packagePath, packageJson) {
  const declared = packageJson?.ailySubapp?.agent;
  if (!isObject(declared)) return null;
  const toolsDeclaration = isObject(declared.tools) ? declared.tools : {};
  const manifest = resolvePackageRelativePath(
    packagePath,
    toolsDeclaration.manifest,
    'ailySubapp.agent.tools.manifest',
  );
  if (!fs.existsSync(manifest.resolved)) {
    throw new Error(`Subapp Agent manifest not found: ${manifest.relative}`);
  }
  const rawManifest = readJson(manifest.resolved);
  if (!isObject(rawManifest) || !Array.isArray(rawManifest.tools)) {
    throw new Error('Subapp Agent manifest must contain a tools array');
  }
  const tools = rawManifest.tools.map(validateAgentTool);
  const lifecycle = validateAgentLifecycle(rawManifest.lifecycle);
  const names = new Set();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate subapp Agent tool: ${tool.name}`);
    names.add(tool.name);
  }
  const skills = Array.isArray(declared.skills)
    ? declared.skills.map((skill, index) => resolvePackageRelativePath(
      packagePath,
      skill,
      `ailySubapp.agent.skills[${index}]`,
    ).relative)
    : [];
  const protocolVersion = positiveInteger(
    rawManifest.protocolVersion ?? declared.protocolVersion,
    1,
    100,
  );
  const transport = requireText(
    rawManifest.transport || toolsDeclaration.transport || declared.transport,
    'ailySubapp.agent transport',
  );
  if (protocolVersion !== 1) {
    throw new Error(`Unsupported ailySubapp.agent protocolVersion: ${protocolVersion}`);
  }
  if (transport !== 'aily-child-rpc') {
    throw new Error(`Unsupported ailySubapp.agent transport: ${transport}`);
  }
  return {
    protocolVersion,
    transport,
    skills,
    manifestPath: manifest.relative,
    ...(lifecycle && Object.keys(lifecycle).length ? { lifecycle } : {}),
    tools,
  };
}

function readInstalledState(rootDir, entry) {
  const packagePath = packagePathFor(rootDir, entry.package);
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return { installed: false, installedVersion: null, packagePath, config: null };
  }

  try {
    const development = fs.lstatSync(packagePath).isSymbolicLink();
    const packageJson = readJson(packageJsonPath);
    const installedVersion = typeof packageJson.version === 'string' ? packageJson.version : null;
    const runnable = resolveRunnablePackage(packagePath, entry.id, packageJson);
    const runnablePackagePath = runnable.packagePath;
    const runnablePackageJson = runnable.packageJson;
    const packageApp = isObject(runnablePackageJson?.ailySubapp?.app)
      ? runnablePackageJson.ailySubapp.app
      : {};
    const mainEntry = runnable.mainEntry;
    const uiIndex = runnable.uiIndex;
    const rejectsDistLayout = isDistRelativePath(mainEntry) || isDistRelativePath(uiIndex);
    const complete = !rejectsDistLayout
      && fs.existsSync(path.join(runnablePackagePath, mainEntry))
      && fs.existsSync(path.join(runnablePackagePath, uiIndex));
    const toolId = TOOL_ID_ALIASES[entry.id] || entry.id;
    const ui = complete ? readSubappUiConfig(runnablePackagePath, runnablePackageJson, uiIndex) : null;
    const declaredRuntime = isObject(runnablePackageJson?.ailySubapp?.runtime)
      ? runnablePackageJson.ailySubapp.runtime
      : {};
    const apiServer = declaredRuntime.apiServer === 'required'
      ? 'required'
      : declaredRuntime.apiServer === 'optional'
        ? 'optional'
        : null;
    const startupTimeoutMs = positiveInteger(
      declaredRuntime.startupTimeoutMs,
      STARTUP_TIMEOUTS[toolId] || 0,
      2 * 60 * 1000,
    );
    const resourceLifecycle = readRuntimeResourceLifecycleConfig(declaredRuntime);
    const processMessagePort = readRuntimeProcessMessagePortConfig(declaredRuntime);
    const runtime = {
      ...(apiServer ? { apiServer } : {}),
      ...(processMessagePort ? { processMessagePort } : {}),
      ...(resourceLifecycle ? { resourceLifecycle } : {}),
    };
    let agent = null;
    let agentError = '';
    try {
      agent = complete ? readSubappAgentConfig(runnablePackagePath, runnablePackageJson) : null;
    } catch (error) {
      agentError = error.message;
    }

    return {
      installed: complete,
      installedVersion,
      development,
      packagePath: runnablePackagePath,
      config: complete ? {
        id: toolId,
        catalogId: entry.id,
        titleKey: entry.titleKey,
        namespace: entry.namespace,
        version: installedVersion || '',
        packageName: entry.package,
        packagePath: runnablePackagePath,
        entry: mainEntry,
        uiIndex,
        routePath: `/child-tool/${toolId}`,
        ...(startupTimeoutMs ? { startupTimeoutMs } : {}),
        ...(Object.keys(runtime).length ? { runtime } : {}),
        ...(ui ? { ui } : {}),
        ...(agent ? { agent } : {}),
        app: {
          ...entry.app,
          id: toolId,
          extension: entry.app.extension === true || packageApp.extension === true,
          ...(DEFAULT_TOOLBAR_IDS.has(toolId) ? { defaultToolbar: true } : {}),
          ...(toolId === 'aily-chat' ? { more: 'v2' } : {}),
        },
      } : null,
      ...(rejectsDistLayout
        ? { installError: `Subapp entry must be package-root (got ${mainEntry}); dist/ layouts are not runnable` }
        : agentError
          ? { installError: agentError }
          : {}),
    };
  } catch (error) {
    return {
      installed: false,
      installedVersion: null,
      packagePath,
      config: null,
      installError: error.message,
    };
  }
}

function resolveLocalizedCopy(entry, locale) {
  const normalized = normalizeLocale(locale);
  const language = normalized.split('_')[0];
  const locales = entry.i18n.locales;
  const translation = locales[normalized]
    || locales[language]
    || locales[entry.i18n.defaultLocale]
    || locales.en
    || {};
  return {
    name: typeof translation.TITLE === 'string' ? translation.TITLE : entry.app.name,
    description: typeof translation.DESCRIPTION === 'string'
      ? translation.DESCRIPTION
      : entry.app.description,
  };
}

function hasUpdate(installedVersion, availableVersion) {
  if (!installedVersion) return false;
  if (semver.valid(installedVersion) && semver.valid(availableVersion)) {
    return semver.gt(availableVersion, installedVersion);
  }
  return installedVersion !== availableVersion;
}

function createCatalogState(rootDir, index, locale, meta = {}) {
  return {
    indexUrl: meta.indexUrl || DEFAULT_INDEX_URL,
    source: meta.source || 'network',
    fetchedAt: meta.fetchedAt || new Date().toISOString(),
    warning: meta.warning || null,
    installRoot: rootDir,
    apps: Object.entries(index)
      .filter(([id]) => id !== 'dev')
      .map(([, entry]) => entry)
      .filter((entry) => entry.app.enabled !== false)
      .map((entry) => {
        const installedState = readInstalledState(rootDir, entry);
        const updateAvailable = installedState.installed
          && hasUpdate(installedState.installedVersion, entry.version);
        const updateStatus = readSubappUpdateStatus(
          meta.updateRootDir || resolveSubappUpdateRoot(),
          entry,
          installedState,
          meta.updateOperations?.get(`${entry.id}@${entry.version}`) || null,
        );
        const copy = resolveLocalizedCopy(entry, locale);
        const toolId = TOOL_ID_ALIASES[entry.id] || entry.id;
        const localizedConfig = installedState.config
          ? {
              ...installedState.config,
              app: {
                ...installedState.config.app,
                name: copy.name,
                description: copy.description,
              },
            }
          : null;
        return {
          app: {
            ...entry.app,
            name: copy.name,
            description: copy.description,
          },
          id: entry.id,
          toolId,
          only: entry.only,
          packageName: entry.package,
          availableVersion: entry.version,
          installedVersion: installedState.installedVersion,
          installed: installedState.installed,
          updateAvailable,
          updateStatus,
          ...(entry.update ? { updatePolicy: entry.update } : {}),
          installPath: installedState.packagePath,
          titleKey: entry.titleKey,
          namespace: entry.namespace,
          name: copy.name,
          description: copy.description,
          icon: entry.app.icon,
          ai: entry.app.ai === true,
          enabled: true,
          extension: localizedConfig?.app?.extension === true || entry.app.extension === true,
          config: localizedConfig,
          ...(installedState.installError ? { installError: installedState.installError } : {}),
        };
      }),
  };
}

function ensureInstallProject(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({
      name: 'aily-installed-subapps',
      private: true,
      version: '1.0.0',
      description: 'Aily Blockly user-installed child applications',
      dependencies: {},
    }, null, 2)}\n`);
  }
}

function npmExecutable(env = process.env, platform = process.platform) {
  const childPath = env.AILY_CHILD_PATH || '';
  const bundled = platform === 'win32'
    ? path.join(childPath, 'node', 'npm.cmd')
    : path.join(childPath, 'node', 'bin', 'npm');
  return childPath && fs.existsSync(bundled) ? bundled : (platform === 'win32' ? 'npm.cmd' : 'npm');
}

// Windows + shell:true 时，带空格路径（如 D:\Program Files\...）必须加引号，
// 否则 cmd 会在空格处截断，表现为 'D:\Program' 不是内部或外部命令。
function quoteWindowsShellPath(filePath) {
  return `"${String(filePath).replace(/"/g, '""')}"`;
}

function prepareNpmSpawn(args, options = {}) {
  const platform = options.platform || process.platform;
  const command = npmExecutable(options.env, platform);
  if (platform !== 'win32') {
    return { command, args, shell: false };
  }
  return {
    command: quoteWindowsShellPath(command),
    args: args.map((arg) => {
      const value = String(arg);
      if (value.includes(' ') && !value.startsWith('"') && !value.startsWith("'")) {
        return quoteWindowsShellPath(value);
      }
      return value;
    }),
    shell: true,
  };
}

function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { command, args: spawnArgs, shell } = prepareNpmSpawn(args, options);
    const child = spawn(command, spawnArgs, {
      env: { ...process.env, ...(options.env || {}) },
      shell,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const handleChunk = (chunk, stream) => {
      const text = String(chunk);
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (typeof options.onOutput === 'function') {
        options.onOutput(text, stream);
      }
    };
    child.stdout?.on('data', (chunk) => handleChunk(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => handleChunk(chunk, 'stderr'));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `npm exited with ${code}`));
      }
    });
  });
}

function clampProgress(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseDependencyProgressLog(text) {
  const line = String(text || '').trim();
  if (!line) return null;
  if (/^(下载完成|Download complete)[:：]?/i.test(line)) {
    return { phase: 'download', percent: 100 };
  }
  const match = line.match(/^(下载进度|Download progress|解压进度|Extract progress)[:：]?\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const percent = Math.max(0, Math.min(100, Number(match[2])));
  const isDownload = /^(下载进度|Download progress)/i.test(match[1]);
  return {
    phase: isDownload ? 'download' : 'extract',
    percent,
  };
}

function createMutationProgressTracker({ id, action, onProgress } = {}) {
  let downloadProgress = 0;
  let extractProgress = 0;
  let lastProgress = 0;

  function emit(phase) {
    const singleDependencyProgress = downloadProgress * 0.5 + extractProgress * 0.5;
    const overall = clampProgress(singleDependencyProgress);
    lastProgress = Math.max(lastProgress, overall, phase === 'start' ? 1 : 0);
    if (phase === 'complete') lastProgress = 100;
    if (typeof onProgress === 'function') {
      onProgress({
        id,
        action,
        phase,
        percent: lastProgress,
        downloadProgress,
        extractProgress,
      });
    }
    return lastProgress;
  }

  return {
    start() {
      downloadProgress = 0;
      extractProgress = 0;
      lastProgress = 0;
      return emit('start');
    },
    setDownload(percent) {
      downloadProgress = Math.max(downloadProgress, clampProgress(percent));
      return emit('download');
    },
    setExtract(percent) {
      if (clampProgress(percent) > 0) {
        downloadProgress = Math.max(downloadProgress, 100);
      }
      extractProgress = Math.max(extractProgress, clampProgress(percent));
      return emit('extract');
    },
    handleLog(line) {
      const parsed = parseDependencyProgressLog(line);
      if (!parsed) return lastProgress;
      return parsed.phase === 'download'
        ? this.setDownload(parsed.percent)
        : this.setExtract(parsed.percent);
    },
    complete() {
      downloadProgress = 100;
      extractProgress = 100;
      return emit('complete');
    },
    get percent() {
      return lastProgress;
    },
  };
}

function createProgressOutputHandler(tracker, previousHandler) {
  let pending = '';
  return (chunk, stream) => {
    if (typeof previousHandler === 'function') {
      previousHandler(chunk, stream);
    }
    if (!tracker) return;
    pending += String(chunk || '');
    const parts = pending.split(/\r\n|\n|\r/g);
    pending = parts.pop() || '';
    for (const line of parts) {
      tracker.handleLog(line);
    }
  };
}

function resolvePackageTarballUrl(entry, npmRunner, options = {}) {
  if (typeof options.resolveTarballUrl === 'function') {
    return Promise.resolve(options.resolveTarballUrl(entry)).then((url) => {
      const value = String(url || '').trim();
      if (!/^https?:\/\//i.test(value)) {
        throw new Error(`Unable to resolve tarball URL for ${entry.package}@${entry.version}`);
      }
      return value;
    });
  }

  return Promise.resolve(npmRunner(
    ['view', `${entry.package}@${entry.version}`, 'dist.tarball'],
    options,
  )).then((result) => {
    const value = String(result?.stdout || '').trim().replace(/^"|"$/g, '');
    if (!/^https?:\/\//i.test(value)) {
      throw new Error(`Unable to resolve tarball URL for ${entry.package}@${entry.version}`);
    }
    return value;
  });
}

async function resolvePackageDistribution(entry, npmRunner, options = {}) {
  if (entry.dist) return entry.dist;
  if (typeof options.resolveDistribution === 'function') {
    return validateDistribution(await options.resolveDistribution(entry), entry.id);
  }

  const result = await npmRunner(
    ['view', `${entry.package}@${entry.version}`, 'dist', '--json'],
    options,
  );
  let dist;
  try {
    dist = JSON.parse(String(result?.stdout || '').trim());
  } catch (error) {
    throw new Error(`Unable to read package distribution for ${entry.package}@${entry.version}`);
  }
  return validateDistribution(dist, entry.id);
}

function downloadFileWithProgress(fileUrl, destination, onProgress, options = {}) {
  const fetchImpl = options.downloadFetch || ((url, requestOptions) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'http:' ? http : https;
    return transport.get(url, requestOptions);
  });
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(destination);
    };

    const request = (currentUrl, redirectsLeft) => {
      let requestRef;
      try {
        requestRef = fetchImpl(currentUrl, {
          headers: { Accept: '*/*' },
        });
      } catch (error) {
        fail(error);
        return;
      }

      requestRef.on('error', fail);
      requestRef.on('response', (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirectsLeft <= 0) {
            fail(new Error(`Too many redirects while downloading ${fileUrl}`));
            return;
          }
          const nextUrl = new URL(response.headers.location, currentUrl).toString();
          request(nextUrl, redirectsLeft - 1);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          fail(new Error(`Download failed: HTTP ${status}`));
          return;
        }

        const total = Number(response.headers['content-length']) || 0;
        let downloaded = 0;
        let lastPercent = -1;
        const file = fs.createWriteStream(destination);
        file.on('error', fail);
        response.on('error', fail);
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (!total || typeof onProgress !== 'function') return;
          const percent = clampProgress((downloaded / total) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress(percent);
          }
        });
        response.pipe(file);
        file.on('finish', () => {
          file.close((error) => {
            if (error) {
              fail(error);
              return;
            }
            if (typeof onProgress === 'function') onProgress(100);
            succeed();
          });
        });
      });
    };

    request(fileUrl, maxRedirects);
  });
}

async function fetchRemoteIndex(indexUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API is not available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(indexUrl, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Subapp index request failed: HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_INDEX_BYTES) {
      throw new Error('Subapp index is too large');
    }
    return validateIndex(JSON.parse(text));
  } finally {
    clearTimeout(timer);
  }
}

function writeIndexCache(rootDir, index, indexUrl) {
  ensureInstallProject(rootDir);
  const cachePath = path.join(rootDir, INDEX_CACHE_FILE);
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(tempPath, cachePath);

  const metaPath = path.join(rootDir, INDEX_CACHE_META_FILE);
  const metaTempPath = `${metaPath}.${process.pid}.tmp`;
  fs.writeFileSync(metaTempPath, `${JSON.stringify({ indexUrl }, null, 2)}\n`);
  fs.renameSync(metaTempPath, metaPath);
}

function readIndexCache(rootDir, indexUrl) {
  const cachePath = path.join(rootDir, INDEX_CACHE_FILE);
  const metaPath = path.join(rootDir, INDEX_CACHE_META_FILE);
  if (fs.existsSync(metaPath)) {
    const meta = readJson(metaPath);
    if (meta?.indexUrl && meta.indexUrl !== indexUrl) {
      return null;
    }
  }
  return fs.existsSync(cachePath) ? validateIndex(readJson(cachePath)) : null;
}

function readDevelopmentIndexCache(rootDir) {
  const cachePath = path.join(rootDir, INDEX_CACHE_FILE);
  if (!fs.existsSync(cachePath)) return null;
  const rawIndex = readJson(cachePath);
  return rawIndex?.dev === true ? validateIndex(rawIndex) : null;
}

function mergeDevelopmentLinkedEntries(rootDir, remoteIndex, developmentIndex) {
  const merged = { ...remoteIndex };
  delete merged.dev;

  for (const [id, entry] of Object.entries(developmentIndex || {})) {
    if (id === 'dev') continue;
    try {
      if (fs.lstatSync(packagePathFor(rootDir, entry.package)).isSymbolicLink()) {
        merged[id] = entry;
      }
    } catch {
      // Ignore stale development catalog entries whose package link no longer exists.
    }
  }

  return merged;
}

function stagedManifestPaths(updateRootDir, id, version) {
  const directory = updateVersionDirectory(updateRootDir, id, version);
  return {
    directory,
    package: path.join(directory, UPDATE_PACKAGE_FILE),
    state: path.join(directory, UPDATE_STATE_FILE),
    journal: path.join(directory, UPDATE_JOURNAL_FILE),
    rollbackPackage: path.join(directory, UPDATE_ROLLBACK_PACKAGE),
    rollbackPackageJson: path.join(directory, UPDATE_ROLLBACK_MANIFEST),
    rollbackPackageLock: path.join(directory, UPDATE_ROLLBACK_LOCK_MANIFEST),
  };
}

function readUpdateRecord(updateRootDir, entry) {
  const statePath = updateStatePath(updateRootDir, entry.id, entry.version);
  if (!fs.existsSync(statePath)) return null;
  try {
    const record = readJson(statePath);
    if (
      record?.schemaVersion !== UPDATE_SCHEMA_VERSION
      || record?.id !== entry.id
      || record?.packageName !== entry.package
      || record?.version !== entry.version
      || !['ready', 'failed'].includes(record?.state)
    ) {
      throw new Error('Staged update metadata does not match the catalog entry');
    }
    return record;
  } catch (error) {
    return {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      id: entry.id,
      packageName: entry.package,
      version: entry.version,
      state: 'failed',
      phase: 'download',
      error: error.message || String(error),
    };
  }
}

function verifyStagedAssets(updateRootDir, record) {
  const paths = stagedManifestPaths(updateRootDir, record.id, record.version);
  if (!record.distribution) {
    throw new Error('Staged update metadata is incomplete');
  }
  const distribution = validateDistribution(record.distribution, record.id);
  if (!fs.existsSync(paths.package)) throw new Error('Staged update package is missing');
  verifyFileIntegrity(paths.package, distribution.integrity);
  return paths;
}

function readSubappUpdateStatus(updateRootDir, entry, installedState, operation = null) {
  const targetVersion = entry.version;
  if (!installedState.installed || !hasUpdate(installedState.installedVersion, targetVersion)) {
    return { state: 'current', targetVersion };
  }
  if (!entry.update || installedState.development) {
    return { state: 'available', targetVersion };
  }
  if (operation && operation.version === targetVersion) {
    return {
      state: operation.state,
      targetVersion,
      progress: clampProgress(operation.progress),
      ...(operation.error ? { error: operation.error } : {}),
    };
  }

  const record = readUpdateRecord(updateRootDir, entry);
  if (!record) return { state: 'available', targetVersion };
  if (record.state === 'failed' && record.phase !== 'install') {
    return {
      state: 'failed',
      targetVersion,
      ready: false,
      error: record.error || 'Subapp update download failed',
    };
  }
  try {
    verifyStagedAssets(updateRootDir, record);
    if (record.state === 'failed') {
      return {
        state: 'failed',
        targetVersion,
        ready: record.phase === 'install',
        error: record.error || 'Subapp update failed',
      };
    }
    return {
      state: 'ready',
      targetVersion,
      ready: true,
      downloadedAt: record.stagedAt,
    };
  } catch (error) {
    return {
      state: 'failed',
      targetVersion,
      ready: false,
      error: error.message || String(error),
    };
  }
}

async function stageSubappUpdate(rootDir, updateRootDir, entry, npmRunner, options = {}) {
  if (!entry.update) throw new Error(`Subapp does not support background updates: ${entry.id}`);
  const installedState = readInstalledState(rootDir, entry);
  if (installedState.development) throw new Error(`Development-linked subapp cannot be updated: ${entry.id}`);
  if (!installedState.installed || !hasUpdate(installedState.installedVersion, entry.version)) {
    throw new Error(`Subapp update is not available: ${entry.id}`);
  }

  const existing = readUpdateRecord(updateRootDir, entry);
  if (existing) {
    try {
      const existingPaths = verifyStagedAssets(updateRootDir, existing);
      await prepareUpdateNpmCache(updateRootDir, existingPaths, entry, npmRunner, options);
      const readyRecord = {
        ...existing,
        state: 'ready',
        phase: 'download',
        error: undefined,
      };
      writeJsonAtomic(updateStatePath(updateRootDir, entry.id, entry.version), readyRecord);
      return readyRecord;
    } catch {
      // Replace an incomplete or corrupt staged update with a fresh download.
    }
  }

  const paths = stagedManifestPaths(updateRootDir, entry.id, entry.version);
  fs.rmSync(paths.directory, { recursive: true, force: true });
  fs.mkdirSync(paths.directory, { recursive: true });
  const temporaryPackage = `${paths.package}.${process.pid}.${randomUUID()}.tmp`;
  const tracker = options.progressTracker;
  tracker?.start();
  let distribution = null;
  try {
    distribution = await resolvePackageDistribution(entry, npmRunner, options);
    const download = options.downloadFile || downloadFileWithProgress;
    await download(
      distribution.tarball,
      temporaryPackage,
      (percent) => tracker?.setDownload(percent),
      options,
    );
    verifyFileIntegrity(temporaryPackage, distribution.integrity);
    fs.renameSync(temporaryPackage, paths.package);
    tracker?.setDownload(100);

    await prepareUpdateNpmCache(updateRootDir, paths, entry, npmRunner, options);
    const record = {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      id: entry.id,
      packageName: entry.package,
      version: entry.version,
      state: 'ready',
      phase: 'download',
      stagedAt: new Date().toISOString(),
      entry,
      distribution,
    };
    writeJsonAtomic(paths.state, record);
    tracker?.complete();
    return record;
  } catch (error) {
    if (fs.existsSync(temporaryPackage)) fs.rmSync(temporaryPackage, { force: true });
    writeJsonAtomic(paths.state, {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      id: entry.id,
      packageName: entry.package,
      version: entry.version,
      state: 'failed',
      phase: 'download',
      failedAt: new Date().toISOString(),
      error: error.message || String(error),
      entry,
      ...(distribution ? { distribution } : {}),
    });
    throw error;
  }
}

async function prepareUpdateNpmCache(updateRootDir, paths, entry, npmRunner, options = {}) {
  const cacheRoot = path.join(updateRootDir, 'npm-cache');
  const probeRoot = path.join(paths.directory, '.offline-probe');
  fs.mkdirSync(cacheRoot, { recursive: true });
  await npmRunner(['cache', 'add', paths.package, '--cache', cacheRoot], options);
  await npmRunner(['cache', 'add', `${entry.package}@${entry.version}`, '--cache', cacheRoot], options);

  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });
  writeJsonAtomic(path.join(probeRoot, 'package.json'), {
    name: 'aily-subapp-update-offline-probe',
    private: true,
    version: '1.0.0',
  });
  try {
    await npmRunner([
      'install', '--prefix', probeRoot, '--save-exact', '--package-lock-only', '--offline',
      '--cache', cacheRoot, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      `${entry.package}@${entry.version}`,
    ], options);
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireUpdateLock(updateRootDir) {
  fs.mkdirSync(updateRootDir, { recursive: true });
  const lockPath = path.join(updateRootDir, UPDATE_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
      fs.closeSync(descriptor);
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = readJson(lockPath);
      } catch {
        // A malformed lock is stale.
      }
      if (isProcessAlive(Number(owner?.pid))) return null;
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

function snapshotFile(filePath) {
  return fs.existsSync(filePath)
    ? { exists: true, contents: fs.readFileSync(filePath) }
    : { exists: false, contents: null };
}

function restoreFile(filePath, snapshot) {
  if (snapshot.exists) {
    fs.writeFileSync(filePath, snapshot.contents);
  } else if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function packageInstallArgs(rootDir, entry) {
  return [
    'install', '--prefix', rootDir, '--save-exact', '--omit=dev', '--no-audit', '--no-fund',
    '--foreground-scripts', `${entry.package}@${entry.version}`,
  ];
}

function packageInstallFromTarballArgs(rootDir, tarballPath) {
  return [
    'install', '--prefix', rootDir, '--save-exact', '--omit=dev', '--no-audit', '--no-fund',
    '--foreground-scripts', tarballPath,
  ];
}

function packageActivateFromCacheArgs(rootDir, entry, cacheRoot) {
  return [
    'install', '--prefix', rootDir, '--save-exact', '--offline', '--cache', cacheRoot,
    '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
    `${entry.package}@${entry.version}`,
  ];
}

function withProgressOutput(options = {}, tracker) {
  return {
    ...options,
    onOutput: createProgressOutputHandler(tracker, options.onOutput),
  };
}

async function installPackage(rootDir, entry, npmRunner, options = {}) {
  const tracker = options.progressTracker;
  const npmOptions = withProgressOutput(options, tracker);
  const retryOptions = {
    retries: options.npmBusyRetries,
    baseDelayMs: options.npmBusyRetryDelayMs,
    sleep: options.sleep,
    packagePath: packagePathFor(rootDir, entry.package),
  };

  if (options.disableTarballProgress === true) {
    await runNpmWithBusyRetry(npmRunner, packageInstallArgs(rootDir, entry), npmOptions, retryOptions);
    tracker?.setDownload(100);
    tracker?.setExtract(100);
    return;
  }

  let stagingRoot = null;
  try {
    stagingRoot = fs.mkdtempSync(path.join(rootDir, '.subapp-download-'));
    const tarballPath = path.join(stagingRoot, 'package.tgz');
    const tarballUrl = await resolvePackageTarballUrl(entry, npmRunner, npmOptions);
    const download = options.downloadFile || downloadFileWithProgress;
    await download(
      tarballUrl,
      tarballPath,
      (percent) => tracker?.setDownload(percent),
      npmOptions,
    );
    tracker?.setDownload(100);
    await runNpmWithBusyRetry(
      npmRunner,
      packageInstallFromTarballArgs(rootDir, tarballPath),
      npmOptions,
      retryOptions,
    );
    tracker?.setExtract(100);
  } catch (error) {
    console.warn(
      '[subapp-manager] progress-aware install failed, falling back to npm install:',
      error.message || error,
    );
    await runNpmWithBusyRetry(
      npmRunner,
      packageInstallArgs(rootDir, entry),
      npmOptions,
      retryOptions,
    );
    tracker?.setDownload(100);
    tracker?.setExtract(100);
  } finally {
    if (stagingRoot && fs.existsSync(stagingRoot)) {
      try {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('[subapp-manager] failed to cleanup download staging:', cleanupError.message || cleanupError);
      }
    }
  }
}

function sleep(ms, sleepImpl = globalThis.setTimeout) {
  return new Promise((resolve) => sleepImpl(resolve, ms));
}

function isBusyRenameError(error) {
  if (!error) return false;
  if (error.code === 'EBUSY' || error.errno === -4082) return true;
  const text = error.message || String(error);
  if (/\bEBUSY\b/i.test(text)) return true;
  // Windows 锁定文件时常表现为 EPERM + rename/rmdir/unlink
  if ((error.code === 'EPERM' || /\bEPERM\b/i.test(text))
    && /\b(rename|rmdir|unlink|rm)\b/i.test(text)) {
    return true;
  }
  return false;
}

function formatBusyRenameError(packagePath, cause) {
  const detail = packagePath ? `\n被占用目录: ${packagePath}` : '';
  const error = new Error(
    `子应用目录正在被占用，无法卸载/更新。请确认已关闭该子应用后重试。${detail}`,
  );
  error.code = 'EBUSY';
  error.cause = cause;
  return error;
}

function formatBusyCancelledError(packagePath) {
  const detail = packagePath ? `\n被占用目录: ${packagePath}` : '';
  const error = new Error(
    `子应用目录正在被占用，已取消强制关闭。${detail}`,
  );
  error.code = 'EBUSY_CANCELLED';
  return error;
}

function formatBusyNeedsForceError(packagePath, holders = [], cause) {
  const detail = packagePath ? `\n被占用目录: ${packagePath}` : '';
  const error = new Error(
    `子应用目录正在被占用，需要强制关闭相关进程后重试。${detail}`,
  );
  error.code = 'EBUSY';
  error.requiresForceClose = true;
  error.packagePath = packagePath || '';
  error.holders = Array.isArray(holders) ? holders : [];
  error.cause = cause;
  return error;
}

function getDefaultBusyDialogStrings() {
  return {
    BUSY_TITLE: 'Subapp directory is in use',
    BUSY_MESSAGE: 'Related processes are locking the install directory. Force close them to continue uninstall/update?',
    BUSY_UNKNOWN_HOLDERS: 'No specific process was identified; related child-tool processes will still be stopped.',
    FORCE_CLOSE_CONTINUE: 'Force close and continue',
    CANCEL: 'Cancel',
  };
}

function getSubappBusyDialogStrings(options = {}) {
  const defaults = getDefaultBusyDialogStrings();
  if (typeof options.getBusyDialogStrings === 'function') {
    try {
      return { ...defaults, ...options.getBusyDialogStrings() };
    } catch (error) {
      console.warn('[subapp-manager] getBusyDialogStrings failed:', error.message || error);
    }
  }
  return defaults;
}

function listProcessesUsingPath(packagePath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || !packagePath) return Promise.resolve([]);

  const execImpl = options.execImpl || exec;
  const needle = path.resolve(packagePath).toLowerCase().replace(/'/g, "''");
  const script = [
    `$needle = '${needle}'`,
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $cmd = $_.CommandLine',
    '  if ($cmd -and $cmd.ToLower().Contains($needle)) {',
    '    [PSCustomObject]@{ pid = $_.ProcessId; name = $_.Name; commandLine = $cmd }',
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('; ');

  return new Promise((resolve) => {
    execImpl(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command ${JSON.stringify(script)}`,
      { windowsHide: true, timeout: 15000 },
      (error, stdout) => {
        if (error) {
          console.warn('[subapp-manager] listProcessesUsingPath failed:', error.message || error);
          resolve([]);
          return;
        }
        const text = String(stdout || '').trim();
        if (!text) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(text);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          const selfPid = process.pid;
          resolve(rows
            .map((row) => ({
              pid: Number.parseInt(row?.pid, 10),
              name: String(row?.name || '').trim() || 'unknown',
              commandLine: String(row?.commandLine || ''),
              source: 'command-line',
            }))
            .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.pid !== selfPid));
        } catch (parseError) {
          console.warn('[subapp-manager] listProcessesUsingPath parse failed:', parseError.message || parseError);
          resolve([]);
        }
      },
    );
  });
}

async function collectBusyHolders(packagePath, entry, options = {}) {
  const holders = [];
  const seen = new Set();
  const pushHolder = (holder) => {
    if (!holder) return;
    const key = Number.isInteger(holder.pid) && holder.pid > 0
      ? `pid:${holder.pid}`
      : `name:${holder.name || ''}:${holder.toolId || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    holders.push(holder);
  };

  if (typeof options.listChildToolHolders === 'function' && entry?.id) {
    try {
      const sessionHolders = await options.listChildToolHolders(entry.id);
      for (const holder of Array.isArray(sessionHolders) ? sessionHolders : []) {
        pushHolder(holder);
      }
    } catch (error) {
      console.warn('[subapp-manager] listChildToolHolders failed:', error.message || error);
    }
  }

  const processHolders = typeof options.listBusyHolders === 'function'
    ? await options.listBusyHolders(packagePath)
    : await listProcessesUsingPath(packagePath, options);
  for (const holder of Array.isArray(processHolders) ? processHolders : []) {
    pushHolder(holder);
  }
  return holders;
}

async function createDefaultPromptBusyForceClose(context = {}) {
  const {
    packagePath,
    holders = [],
    getMainWindow = () => null,
    strings = getDefaultBusyDialogStrings(),
    dialogImpl,
  } = context;
  let dialog = dialogImpl;
  if (!dialog) {
    try {
      ({ dialog } = require('electron'));
    } catch (_) {
      return false;
    }
  }
  const holderLines = holders.length
    ? holders.map((holder) => {
      const pidText = Number.isInteger(holder.pid) ? `PID ${holder.pid}` : 'PID ?';
      return `${pidText}: ${holder.name || holder.toolId || 'unknown'}`;
    }).join('\n')
    : strings.BUSY_UNKNOWN_HOLDERS;
  const parentWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
  const { response } = await dialog.showMessageBox(parentWindow || undefined, {
    type: 'warning',
    title: strings.BUSY_TITLE,
    message: strings.BUSY_TITLE,
    detail: `${strings.BUSY_MESSAGE}\n\n${holderLines}\n\n${packagePath || ''}`.trim(),
    buttons: [strings.CANCEL, strings.FORCE_CLOSE_CONTINUE],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

async function forceCloseBusyHolders(packagePath, entry, holders, options = {}) {
  if (typeof options.forceStopChildToolByCatalogId === 'function' && entry?.id) {
    try {
      await options.forceStopChildToolByCatalogId(entry.id);
    } catch (error) {
      console.warn('[subapp-manager] forceStopChildToolByCatalogId failed:', error.message || error);
    }
  }

  const killProcessTree = options.killProcessTree || killRegisteredProcessTree;
  const pids = Array.from(new Set(
    (Array.isArray(holders) ? holders : [])
      .map((holder) => holder?.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
  ));
  for (const pid of pids) {
    try {
      await killProcessTree(pid, `subapp-busy:${entry?.id || path.basename(packagePath || '')}`);
    } catch (error) {
      console.warn('[subapp-manager] killProcessTree failed:', error.message || error);
    }
  }
}

async function resolveBusyConflictAndRetry(operation, context = {}) {
  const {
    packagePath,
    entry,
    options = {},
    platform = options.platform || process.platform,
  } = context;
  if (platform !== 'win32') {
    throw context.error || formatBusyRenameError(packagePath);
  }
  if (options.busyForceAttempted) {
    throw context.error || formatBusyRenameError(packagePath);
  }

  const holders = await collectBusyHolders(packagePath, entry, options);

  // forceClose=true：由渲染层弹窗确认后传入，主进程直接强杀并重试（不再弹 Electron 原生框）。
  // 未带 forceClose 时抛给渲染层，用软件内 UI 提示。
  const shouldForceClose = options.forceClose === true;
  if (!shouldForceClose) {
    if (typeof options.promptBusyForceClose === 'function') {
      const proceed = await options.promptBusyForceClose({
        packagePath,
        holders,
        action: context.action,
        entry,
      });
      if (!proceed) {
        throw formatBusyCancelledError(packagePath);
      }
    } else {
      throw formatBusyNeedsForceError(packagePath, holders, context.error);
    }
  }

  await forceCloseBusyHolders(packagePath, entry, holders, options);
  const sleepImpl = options.sleep || sleep;
  await sleepImpl(Number.isFinite(options.forceCloseSettleMs) ? options.forceCloseSettleMs : 500);
  return operation({ ...options, busyForceAttempted: true, forceClose: true });
}

async function renameWithBusyRetry(src, dest, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 4;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 500;
  const sleepImpl = options.sleep || sleep;
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (error) {
      lastError = error;
      if (attempt <= retries && isBusyRenameError(error)) {
        await sleepImpl(baseDelayMs * attempt);
        continue;
      }
      throw isBusyRenameError(error) ? formatBusyRenameError(src, error) : error;
    }
  }
  throw formatBusyRenameError(src, lastError);
}

async function rmWithBusyRetry(targetPath, options = {}) {
  if (!targetPath || !fs.existsSync(targetPath)) return;
  const retries = Number.isInteger(options.retries) ? options.retries : 4;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 500;
  const sleepImpl = options.sleep || sleep;
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt <= retries && isBusyRenameError(error)) {
        await sleepImpl(baseDelayMs * attempt);
        continue;
      }
      throw isBusyRenameError(error) ? formatBusyRenameError(targetPath, error) : error;
    }
  }
  throw formatBusyRenameError(targetPath, lastError);
}

async function renamePackagePathWithForceClose(src, dest, entry, options = {}) {
  let nextOptions = options;
  const platform = options.platform || process.platform;
  // 用户已在 UI 确认强制关闭时，先释放占用再 rename，减少首轮 EBUSY。
  if (
    platform === 'win32'
    && options.forceClose === true
    && options.busyForceAttempted !== true
  ) {
    const holders = await collectBusyHolders(src, entry, options);
    await forceCloseBusyHolders(src, entry, holders, options);
    const sleepImpl = options.sleep || sleep;
    await sleepImpl(Number.isFinite(options.forceCloseSettleMs) ? options.forceCloseSettleMs : 500);
    nextOptions = { ...options, busyForceAttempted: true };
  }

  try {
    await renameWithBusyRetry(src, dest, {
      retries: nextOptions.renameRetries,
      baseDelayMs: nextOptions.renameRetryDelayMs,
      sleep: nextOptions.sleep,
    });
  } catch (error) {
    if (!isBusyRenameError(error)) throw error;
    await resolveBusyConflictAndRetry(
      async (retryOptions) => renameWithBusyRetry(src, dest, {
        retries: retryOptions.renameRetries,
        baseDelayMs: retryOptions.renameRetryDelayMs,
        sleep: retryOptions.sleep,
      }),
      {
        packagePath: src,
        entry,
        options: nextOptions,
        action: nextOptions.mutationAction,
        error,
      },
    );
  }
}

async function runNpmWithBusyRetry(npmRunner, args, options = {}, retryOptions = {}) {
  const retries = Number.isInteger(retryOptions.retries) ? retryOptions.retries : 3;
  const baseDelayMs = Number.isFinite(retryOptions.baseDelayMs) ? retryOptions.baseDelayMs : 1000;
  const sleepImpl = retryOptions.sleep || options.sleep || sleep;
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await npmRunner(args, options);
    } catch (error) {
      lastError = error;
      if (attempt <= retries && isBusyRenameError(error)) {
        console.warn(`[subapp-manager] npm ${args[0]} hit EBUSY, retry ${attempt}/${retries}`);
        await sleepImpl(baseDelayMs * attempt);
        continue;
      }
      throw isBusyRenameError(error)
        ? formatBusyRenameError(retryOptions.packagePath, error)
        : error;
    }
  }
  throw formatBusyRenameError(retryOptions.packagePath, lastError);
}

async function uninstallInstalledPackage(rootDir, entry, npmRunner, options = {}) {
  const packagePath = packagePathFor(rootDir, entry.package);
  const tracker = options.progressTracker;
  let stagingRoot = null;
  tracker?.start();

  try {
    // Windows 上 npm uninstall 会 rename 包目录；若 Runtime/杀毒仍占着文件会 EBUSY。
    // 先自行挪走目录（带重试），再让 npm 只更新 package.json / lock。
    if (fs.existsSync(packagePath)) {
      tracker?.setDownload(40);
      stagingRoot = fs.mkdtempSync(path.join(rootDir, '.subapp-uninstall-'));
      await renamePackagePathWithForceClose(
        packagePath,
        path.join(stagingRoot, 'package'),
        entry,
        { ...options, mutationAction: 'uninstall' },
      );
      tracker?.setDownload(70);
    } else {
      tracker?.setDownload(70);
    }

    await runNpmWithBusyRetry(
      npmRunner,
      ['uninstall', '--prefix', rootDir, '--no-audit', '--no-fund', entry.package],
      withProgressOutput(options, tracker),
      {
        retries: options.npmBusyRetries,
        baseDelayMs: options.npmBusyRetryDelayMs,
        sleep: options.sleep,
        packagePath,
      },
    );
    tracker?.setExtract(100);
    tracker?.complete();
  } finally {
    if (stagingRoot && fs.existsSync(stagingRoot)) {
      try {
        await rmWithBusyRetry(stagingRoot, {
          retries: options.renameRetries,
          baseDelayMs: options.renameRetryDelayMs,
          sleep: options.sleep,
        });
      } catch (error) {
        console.warn('[subapp-manager] failed to cleanup uninstall staging:', error.message || error);
      }
    }
  }
}

async function replaceInstalledPackage(rootDir, entry, npmRunner, options = {}) {
  const packagePath = packagePathFor(rootDir, entry.package);
  const backupRoot = fs.mkdtempSync(path.join(rootDir, '.subapp-update-'));
  const backupPath = path.join(backupRoot, 'package');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const packageJsonSnapshot = snapshotFile(packageJsonPath);
  const packageLockSnapshot = snapshotFile(packageLockPath);
  const tracker = options.progressTracker;
  let backedUp = false;
  tracker?.start();

  try {
    if (fs.existsSync(packagePath)) {
      await renamePackagePathWithForceClose(packagePath, backupPath, entry, {
        ...options,
        mutationAction: 'update',
      });
      backedUp = true;
    }

    await installPackage(rootDir, entry, npmRunner, options);
    const installedState = readInstalledState(rootDir, entry);
    if (!installedState.installed || installedState.installedVersion !== entry.version) {
      throw new Error(
        `Subapp update verification failed: expected ${entry.version}, got ${installedState.installedVersion || 'missing'}`,
      );
    }

    await rmWithBusyRetry(backupRoot, {
      retries: options.renameRetries,
      baseDelayMs: options.renameRetryDelayMs,
      sleep: options.sleep,
    });
    tracker?.complete();
  } catch (error) {
    if (fs.existsSync(packagePath)) {
      try {
        await rmWithBusyRetry(packagePath, {
          retries: options.renameRetries,
          baseDelayMs: options.renameRetryDelayMs,
          sleep: options.sleep,
        });
      } catch (cleanupError) {
        console.warn('[subapp-manager] failed to cleanup package during rollback:', cleanupError.message || cleanupError);
      }
    }
    if (backedUp && fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(packagePath), { recursive: true });
      await renameWithBusyRetry(backupPath, packagePath, {
        retries: options.renameRetries,
        baseDelayMs: options.renameRetryDelayMs,
        sleep: options.sleep,
      });
    }
    restoreFile(packageJsonPath, packageJsonSnapshot);
    restoreFile(packageLockPath, packageLockSnapshot);
    try {
      await rmWithBusyRetry(backupRoot, {
        retries: options.renameRetries,
        baseDelayMs: options.renameRetryDelayMs,
        sleep: options.sleep,
      });
    } catch (cleanupError) {
      console.warn('[subapp-manager] failed to cleanup update backup:', cleanupError.message || cleanupError);
    }
    throw error;
  }
}

function restoreRollbackFile(livePath, rollbackPath, existed) {
  if (existed && fs.existsSync(rollbackPath)) {
    fs.copyFileSync(rollbackPath, livePath);
  } else if (!existed && fs.existsSync(livePath)) {
    fs.rmSync(livePath, { force: true });
  }
}

async function recoverInterruptedActivation(rootDir, updateRootDir, record, options = {}) {
  const paths = stagedManifestPaths(updateRootDir, record.id, record.version);
  if (!fs.existsSync(paths.journal)) return false;
  const journal = readJson(paths.journal);
  const packagePath = packagePathFor(rootDir, record.packageName);
  if (fs.existsSync(paths.rollbackPackage)) {
    if (fs.existsSync(packagePath)) {
      await rmWithBusyRetry(packagePath, {
        retries: options.renameRetries,
        baseDelayMs: options.renameRetryDelayMs,
        sleep: options.sleep,
      });
    }
    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    await renameWithBusyRetry(paths.rollbackPackage, packagePath, {
      retries: options.renameRetries,
      baseDelayMs: options.renameRetryDelayMs,
      sleep: options.sleep,
    });
  }
  restoreRollbackFile(
    path.join(rootDir, 'package.json'),
    paths.rollbackPackageJson,
    journal.packageJsonExisted === true,
  );
  restoreRollbackFile(
    path.join(rootDir, 'package-lock.json'),
    paths.rollbackPackageLock,
    journal.packageLockExisted === true,
  );
  fs.rmSync(paths.journal, { force: true });
  fs.rmSync(paths.rollbackPackageJson, { force: true });
  fs.rmSync(paths.rollbackPackageLock, { force: true });
  writeJsonAtomic(paths.state, {
    ...record,
    state: 'failed',
    phase: 'install',
    failedAt: new Date().toISOString(),
    error: 'A previously interrupted update was rolled back safely',
  });
  return true;
}

function assertCanonicalDependency(rootDir, entry, distribution) {
  const packageJson = readJson(path.join(rootDir, 'package.json'));
  const packageLock = readJson(path.join(rootDir, 'package-lock.json'));
  const lockKey = `node_modules/${entry.package}`;
  if (packageJson.dependencies?.[entry.package] !== entry.version) {
    throw new Error(`Installed dependency is not pinned to ${entry.package}@${entry.version}`);
  }
  if (packageLock.packages?.['']?.dependencies?.[entry.package] !== entry.version) {
    throw new Error(`Package lock root is not pinned to ${entry.package}@${entry.version}`);
  }
  const locked = packageLock.packages?.[lockKey];
  if (
    locked?.version !== entry.version
    || locked?.resolved !== distribution.tarball
    || locked?.integrity !== distribution.integrity
  ) {
    throw new Error(`Package lock metadata is invalid for ${entry.package}@${entry.version}`);
  }
}

async function activateStagedSubappUpdate(rootDir, updateRootDir, entry, npmRunner, options = {}) {
  const record = readUpdateRecord(updateRootDir, entry);
  if (!record) throw new Error(`Downloaded update is not available: ${entry.id}`);
  const paths = verifyStagedAssets(updateRootDir, record);
  if (record.state === 'failed' && record.phase !== 'install') {
    throw new Error(record.error || `Downloaded update is not ready: ${entry.id}`);
  }

  const canActivate = typeof options.canActivateUpdate === 'function'
    ? await options.canActivateUpdate(entry)
    : true;
  if (canActivate === false || canActivate?.ok === false) {
    const error = new Error(canActivate?.reason || 'Another application window is using subapps');
    error.code = 'UPDATE_DEFERRED';
    throw error;
  }

  const releaseLock = acquireUpdateLock(updateRootDir);
  if (!releaseLock) {
    const error = new Error('Another process is installing a subapp update');
    error.code = 'UPDATE_DEFERRED';
    throw error;
  }

  const packagePath = packagePathFor(rootDir, entry.package);
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const tracker = options.progressTracker;
  let backedUp = false;
  let journalWritten = false;
  tracker?.start();

  try {
    if (await recoverInterruptedActivation(rootDir, updateRootDir, record, options)) {
      const error = new Error('Interrupted subapp update was rolled back; retry installation');
      error.code = 'UPDATE_RECOVERED';
      throw error;
    }

    const cacheRoot = path.join(updateRootDir, 'npm-cache');
    await npmRunner(['cache', 'add', paths.package, '--cache', cacheRoot], options);

    const packageJsonSnapshot = snapshotFile(packageJsonPath);
    const packageLockSnapshot = snapshotFile(packageLockPath);
    if (packageJsonSnapshot.exists) fs.writeFileSync(paths.rollbackPackageJson, packageJsonSnapshot.contents);
    if (packageLockSnapshot.exists) fs.writeFileSync(paths.rollbackPackageLock, packageLockSnapshot.contents);
    writeJsonAtomic(paths.journal, {
      schemaVersion: UPDATE_SCHEMA_VERSION,
      id: entry.id,
      version: entry.version,
      startedAt: new Date().toISOString(),
      packageJsonExisted: packageJsonSnapshot.exists,
      packageLockExisted: packageLockSnapshot.exists,
    });
    journalWritten = true;

    if (fs.existsSync(packagePath)) {
      await renamePackagePathWithForceClose(packagePath, paths.rollbackPackage, entry, {
        ...options,
        mutationAction: 'install-update',
      });
      backedUp = true;
    }

    tracker?.setDownload(100);
    await runNpmWithBusyRetry(
      npmRunner,
      packageActivateFromCacheArgs(rootDir, entry, cacheRoot),
      withProgressOutput(options, tracker),
      {
        retries: options.npmBusyRetries,
        baseDelayMs: options.npmBusyRetryDelayMs,
        sleep: options.sleep,
        packagePath,
      },
    );
    const installedState = readInstalledState(rootDir, entry);
    if (!installedState.installed || installedState.installedVersion !== entry.version) {
      throw new Error(
        `Subapp update verification failed: expected ${entry.version}, got ${installedState.installedVersion || 'missing'}`,
      );
    }

    assertCanonicalDependency(rootDir, entry, record.distribution);
    tracker?.setExtract(100);

    if (backedUp && fs.existsSync(paths.rollbackPackage)) {
      await rmWithBusyRetry(paths.rollbackPackage, {
        retries: options.renameRetries,
        baseDelayMs: options.renameRetryDelayMs,
        sleep: options.sleep,
      });
    }
    fs.rmSync(paths.journal, { force: true });
    fs.rmSync(paths.rollbackPackageJson, { force: true });
    fs.rmSync(paths.rollbackPackageLock, { force: true });
    journalWritten = false;
    tracker?.complete();
    fs.rmSync(paths.directory, { recursive: true, force: true });
    return { id: entry.id, version: entry.version, status: 'installed' };
  } catch (error) {
    if (journalWritten) {
      try {
        await recoverInterruptedActivation(rootDir, updateRootDir, record, options);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    if (fs.existsSync(paths.state)) {
      writeJsonAtomic(paths.state, {
        ...record,
        state: 'failed',
        phase: 'install',
        failedAt: new Date().toISOString(),
        error: error.message || String(error),
      });
    }
    throw error;
  } finally {
    releaseLock();
  }
}

function createSubappManager(options = {}) {
  const rootDir = resolveSubappRoot(options);
  const updateRootDir = resolveSubappUpdateRoot(options);
  const updateOperations = new Map();
  const backgroundAttempts = new Set();
  const backgroundDownloads = new Map();
  let currentIndex = null;
  let currentMeta = null;
  let currentIndexUrl = null;
  let indexUrlGeneration = 0;

  function resolveIndexUrl() {
    const configuredIndexUrl = typeof options.getIndexUrl === 'function'
      ? options.getIndexUrl()
      : options.indexUrl || process.env.AILY_SUBAPP_INDEX_URL || DEFAULT_INDEX_URL;
    return requireText(configuredIndexUrl, 'subapp index URL');
  }

  async function loadIndex(strategy = 'network-first') {
    if (strategy !== 'network-first' && strategy !== 'cache-first' && strategy !== 'cache-only') {
      throw new Error(`Unsupported subapp catalog load strategy: ${strategy}`);
    }

    const indexUrl = resolveIndexUrl();
    if (currentIndexUrl !== indexUrl) {
      currentIndex = null;
      currentMeta = null;
      currentIndexUrl = indexUrl;
      indexUrlGeneration += 1;
    }
    const loadGeneration = indexUrlGeneration;

    if (currentIndex && strategy !== 'network-first') {
      return { index: currentIndex, meta: currentMeta };
    }

    let cacheError = null;
    let localIndex = null;
    try {
      localIndex = readDevelopmentIndexCache(rootDir);
    } catch (error) {
      cacheError = error;
    }

    if (localIndex?.dev === true && strategy !== 'network-first') {
      currentIndex = localIndex;
      currentMeta = {
        indexUrl,
        source: 'cache',
        fetchedAt: new Date().toISOString(),
        warning: null,
      };
      return { index: localIndex, meta: currentMeta };
    }

    if (strategy !== 'network-first') {
      try {
        const cached = readIndexCache(rootDir, indexUrl);
        if (cached) {
          currentIndex = cached;
          currentMeta = {
            indexUrl,
            source: 'cache',
            fetchedAt: new Date().toISOString(),
            warning: null,
          };
          return { index: cached, meta: currentMeta };
        }
      } catch (error) {
        cacheError = error;
      }
      if (strategy === 'cache-only') {
        throw cacheError || new Error('Subapp index cache is unavailable');
      }
    }

    try {
      const remoteIndex = await fetchRemoteIndex(indexUrl, options.fetchImpl);
      if (
        loadGeneration !== indexUrlGeneration
        || currentIndexUrl !== indexUrl
        || resolveIndexUrl() !== indexUrl
      ) {
        return loadIndex(strategy);
      }

      const index = localIndex?.dev === true
        ? mergeDevelopmentLinkedEntries(rootDir, remoteIndex, localIndex)
        : remoteIndex;
      if (localIndex?.dev !== true) {
        writeIndexCache(rootDir, index, indexUrl);
      }
      currentIndex = index;
      currentMeta = { indexUrl, source: 'network', fetchedAt: new Date().toISOString(), warning: null };
      return { index, meta: currentMeta };
    } catch (error) {
      if (
        loadGeneration !== indexUrlGeneration
        || currentIndexUrl !== indexUrl
        || resolveIndexUrl() !== indexUrl
      ) {
        return loadIndex(strategy);
      }

      if (localIndex?.dev === true) {
        currentIndex = localIndex;
        currentMeta = {
          indexUrl,
          source: 'cache',
          fetchedAt: new Date().toISOString(),
          warning: error.message,
        };
        return { index: localIndex, meta: currentMeta };
      }

      let cached = null;
      try {
        cached = readIndexCache(rootDir, indexUrl);
      } catch (readError) {
        cacheError = readError;
      }
      if (!cached) throw error;
      currentIndex = cached;
      currentMeta = {
        indexUrl,
        source: 'cache',
        fetchedAt: new Date().toISOString(),
        warning: error.message,
      };
      return { index: cached, meta: currentMeta };
    }
  }

  async function list(payload = {}) {
    const strategy = typeof payload.strategy === 'string'
      ? payload.strategy
      : payload.refresh === true
        ? 'network-first'
        : 'cache-first';
    const { index, meta } = await loadIndex(strategy);
    scheduleBackgroundUpdates(index, meta);
    return createCatalogState(rootDir, index, payload.locale || 'en', {
      ...meta,
      updateRootDir,
      updateOperations,
    });
  }

  function updateKey(entry) {
    return `${entry.id}@${entry.version}`;
  }

  function progressHandler(entry, state, externalHandler) {
    return (progress) => {
      const percent = progress.action === 'download-update'
        ? clampProgress(progress.downloadProgress)
        : clampProgress(progress.percent);
      updateOperations.set(updateKey(entry), {
        version: entry.version,
        state,
        progress: percent,
        ...(progress.error ? { error: progress.error } : {}),
      });
      if (typeof externalHandler === 'function') {
        externalHandler({ ...progress, percent });
      }
    };
  }

  function notifyChanged(action, id) {
    if (typeof options.onChanged === 'function') options.onChanged({ action, id });
  }

  async function downloadUpdateEntry(entry, payload = {}) {
    const key = updateKey(entry);
    const existingDownload = backgroundDownloads.get(key);
    if (existingDownload) return existingDownload;

    const onProgress = typeof payload.onProgress === 'function'
      ? payload.onProgress
      : options.onProgress;
    const tracker = createMutationProgressTracker({
      id: entry.id,
      action: 'download-update',
      onProgress: progressHandler(entry, 'downloading', onProgress),
    });
    const operation = stageSubappUpdate(
      rootDir,
      updateRootDir,
      entry,
      options.runNpm || runNpm,
      { ...options, progressTracker: tracker },
    ).then((record) => {
      updateOperations.delete(key);
      notifyChanged('download-update', entry.id);
      return record;
    }).catch((error) => {
      updateOperations.set(key, {
        version: entry.version,
        state: 'failed',
        progress: tracker.percent,
        error: error.message || String(error),
      });
      if (typeof onProgress === 'function') {
        onProgress({
          id: entry.id,
          action: 'download-update',
          phase: 'error',
          percent: tracker.percent,
          error: error.message || String(error),
        });
      }
      notifyChanged('download-update', entry.id);
      throw error;
    }).finally(() => {
      backgroundDownloads.delete(key);
    });
    backgroundDownloads.set(key, operation);
    return operation;
  }

  function scheduleBackgroundUpdates(index, meta) {
    if (meta.source !== 'network' || index.dev === true) return;
    for (const [id, entry] of Object.entries(index)) {
      if (id === 'dev' || !entry.update || entry.app.enabled === false) continue;
      const installedState = readInstalledState(rootDir, entry);
      if (
        !installedState.installed
        || installedState.development
        || !hasUpdate(installedState.installedVersion, entry.version)
      ) {
        continue;
      }
      const key = updateKey(entry);
      const status = readSubappUpdateStatus(updateRootDir, entry, installedState);
      const canDownload = status.state === 'available'
        || (status.state === 'failed' && status.ready !== true);
      if (!canDownload || backgroundAttempts.has(key)) continue;
      backgroundAttempts.add(key);
      void downloadUpdateEntry(entry).catch((error) => {
        console.warn('[subapp-manager] background update download failed:', error.message || error);
      });
    }
  }

  function enqueueMutation(operation) {
    const previous = mutationQueues.get(rootDir) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const queued = next.then(() => undefined, () => undefined).finally(() => {
      if (mutationQueues.get(rootDir) === queued) mutationQueues.delete(rootDir);
    });
    mutationQueues.set(rootDir, queued);
    return next;
  }

  async function mutate(action, payload = {}) {
    return enqueueMutation(async () => {
      const { index } = await loadIndex('cache-first');
      const id = validateId(payload.id);
      const entry = index[id];
      if (!entry) throw new Error(`Subapp is not present in the remote index: ${id}`);
      if (entry.app.enabled === false && action !== 'uninstall') {
        throw new Error(`Subapp is disabled in the remote index: ${id}`);
      }
      ensureInstallProject(rootDir);

      const onProgress = typeof payload.onProgress === 'function'
        ? payload.onProgress
        : options.onProgress;
      const progressTracker = createMutationProgressTracker({
        id,
        action,
        onProgress: progressHandler(
          entry,
          action === 'install-update' ? 'installing' : action,
          onProgress,
        ),
      });
      const mutationOptions = {
        ...options,
        progressTracker,
        forceClose: payload.forceClose === true || options.forceClose === true,
      };

      let releaseLock = null;
      try {
        if (action === 'install-update') {
          await activateStagedSubappUpdate(
            rootDir,
            updateRootDir,
            entry,
            options.runNpm || runNpm,
            mutationOptions,
          );
        } else {
          releaseLock = acquireUpdateLock(updateRootDir);
          if (!releaseLock) {
            const lockError = new Error('Another process is changing installed subapps');
            lockError.code = 'UPDATE_DEFERRED';
            throw lockError;
          }
          if (action === 'uninstall') {
            await uninstallInstalledPackage(rootDir, entry, options.runNpm || runNpm, mutationOptions);
          } else if (action === 'update') {
            if (entry.update) {
              throw new Error(`Use installUpdate for staged subapp updates: ${entry.id}`);
            }
            await replaceInstalledPackage(rootDir, entry, options.runNpm || runNpm, mutationOptions);
          } else {
            progressTracker.start();
            await installPackage(rootDir, entry, options.runNpm || runNpm, mutationOptions);
            progressTracker.complete();
          }
        }
      } catch (error) {
        if (typeof onProgress === 'function') {
          onProgress({
            id,
            action,
            phase: 'error',
            percent: progressTracker.percent,
            downloadProgress: 0,
            extractProgress: 0,
            error: error.message || String(error),
          });
        }
        throw error;
      } finally {
        releaseLock?.();
        updateOperations.delete(updateKey(entry));
      }
      return list({ locale: payload.locale || 'en' });
    });
  }

  async function downloadUpdate(payload = {}) {
    const { index } = await loadIndex('cache-first');
    if (index.dev === true) throw new Error('Development subapps cannot be updated');
    const id = validateId(payload.id);
    const entry = index[id];
    if (!entry) throw new Error(`Subapp is not present in the remote index: ${id}`);
    ensureInstallProject(rootDir);
    await downloadUpdateEntry(entry, payload);
    return list({ locale: payload.locale || 'en' });
  }

  return {
    rootDir,
    get indexUrl() {
      return resolveIndexUrl();
    },
    list,
    install: (payload) => mutate('install', payload),
    update: (payload) => mutate('update', payload),
    downloadUpdate,
    installUpdate: (payload) => mutate('install-update', payload),
    uninstall: (payload) => mutate('uninstall', payload),
  };
}

let handlersRegistered = false;
let defaultManager = null;

function readSubappBusyDialogStringsFromI18n(getLocale = () => 'en') {
  const defaults = getDefaultBusyDialogStrings();
  try {
    const { app } = require('electron');
    const loc = String(typeof getLocale === 'function' ? getLocale() : getLocale || app.getLocale() || '')
      .toLowerCase();
    const pack = loc.startsWith('zh') ? (loc.includes('hk') || loc.includes('tw') ? 'zh_hk' : 'zh_cn') : 'en';
    const file = path.join(pack, `${pack}.json`);
    const packagedPath = path.join(__dirname, '..', 'renderer', 'i18n', file);
    const devPath = path.join(__dirname, '..', 'public', 'i18n', file);
    const fp = fs.existsSync(packagedPath) ? packagedPath : devPath;
    if (!fs.existsSync(fp)) return defaults;
    const json = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const section = json.SUBAPP || {};
    return {
      BUSY_TITLE: section.BUSY_TITLE || defaults.BUSY_TITLE,
      BUSY_MESSAGE: section.BUSY_MESSAGE || defaults.BUSY_MESSAGE,
      BUSY_UNKNOWN_HOLDERS: section.BUSY_UNKNOWN_HOLDERS || defaults.BUSY_UNKNOWN_HOLDERS,
      FORCE_CLOSE_CONTINUE: section.FORCE_CLOSE_CONTINUE || defaults.FORCE_CLOSE_CONTINUE,
      CANCEL: section.CANCEL || defaults.CANCEL,
    };
  } catch (error) {
    console.warn('[subapp-manager] readSubappBusyDialogStringsFromI18n failed:', error.message || error);
    return defaults;
  }
}

function registerSubappManagerHandlers(getMainWindow = () => null, handlerOptions = {}) {
  if (handlersRegistered) return;
  const { ipcMain } = require('electron');
  const {
    forceStopChildToolByCatalogId,
    listChildToolHoldersForCatalogId,
    getIndexUrl,
    canActivateUpdate,
  } = handlerOptions;

  const sendProgress = (progress) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('subapp-manager-progress', progress);
    }
  };

  const sendChanged = (payload) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('subapp-manager-changed', payload);
    }
  };

  defaultManager = createSubappManager({
    onProgress: sendProgress,
    onChanged: sendChanged,
    platform: process.platform,
    getMainWindow,
    getIndexUrl,
    canActivateUpdate,
    getBusyDialogStrings: () => readSubappBusyDialogStringsFromI18n(),
    forceStopChildToolByCatalogId,
    listChildToolHolders: listChildToolHoldersForCatalogId,
    killProcessTree: killRegisteredProcessTree,
  });

  const handleMutation = (action) => async (_event, payload = {}) => {
    const result = await defaultManager[action](payload);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('subapp-manager-changed', { action, id: payload.id });
    }
    return result;
  };

  ipcMain.handle('subapp-manager-list', (_event, payload = {}) => defaultManager.list(payload));
  ipcMain.handle('subapp-manager-install', handleMutation('install'));
  ipcMain.handle('subapp-manager-update', handleMutation('update'));
  ipcMain.handle('subapp-manager-download-update', handleMutation('downloadUpdate'));
  ipcMain.handle('subapp-manager-install-update', handleMutation('installUpdate'));
  ipcMain.handle('subapp-manager-uninstall', handleMutation('uninstall'));
  handlersRegistered = true;
}

module.exports = {
  DEFAULT_INDEX_URL,
  TOOL_ID_ALIASES,
  buildSubappIndexUrl,
  activateStagedSubappUpdate,
  clampProgress,
  collectBusyHolders,
  createCatalogState,
  createMutationProgressTracker,
  createSubappManager,
  downloadFileWithProgress,
  forceCloseBusyHolders,
  formatBusyCancelledError,
  formatBusyNeedsForceError,
  isBusyRenameError,
  isDistRelativePath,
  listProcessesUsingPath,
  packagePathFor,
  parseDependencyProgressLog,
  prepareNpmSpawn,
  quoteWindowsShellPath,
  registerSubappManagerHandlers,
  renamePackagePathWithForceClose,
  renameWithBusyRetry,
  resolveBusyConflictAndRetry,
  resolveRunnablePackage,
  resolveSubappRoot,
  resolveSubappUpdateRoot,
  resolveUiIndex,
  rmWithBusyRetry,
  stageSubappUpdate,
  validateIndex,
  verifyFileIntegrity,
};
