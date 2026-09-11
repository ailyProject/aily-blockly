// 远端子应用目录与用户级 npm 安装管理。
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { exec, execFile, spawn } = require('child_process');
const { URL } = require('url');
const semver = require('semver');
const { killRegisteredProcessTree } = require('./process-tree');
const versions = require('./subapp-version-store');
const { acquireInstallLock: acquireUpdateLock } = require('./subapp-install-lock');
const { extractNpmTarballInBackground } = require('./subapp-package-worker-client');
const { resolveAilyNpmPrefix } = require('./appdata-path');

const INDEX_CACHE_FILE = 'subapp-index.json';
const INDEX_CACHE_META_FILE = 'subapp-index.meta.json';
const UPDATE_STATE_FILE = 'state.json';
const UPDATE_PACKAGE_FILE = 'package.tgz';
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
const BUNDLED_CODER_ID = 'aily-coder-editor';
const BUNDLED_CODER_PACKAGE = '@aily-project/subapp-aily-coder-editor';
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
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.AILY_APPDATA_PATH) return platformPath.resolve(env.AILY_APPDATA_PATH);
  if (platform === 'win32') return platformPath.join(home, 'AppData', 'Local', 'aily-project');
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'aily-project');
  return platformPath.join(home, '.config', 'aily-project');
}

function resolveSubappRoot(options = {}) {
  const platform = options.platform || process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (options.rootDir) return path.resolve(options.rootDir);
  return platformPath.join(resolveAilyNpmPrefix({
    env: options.env || process.env,
    platform,
    appDataPath: resolveAppDataPath(options.env, platform, options.home),
  }), 'app');
}

function resolveSubappUpdateRoot(options = {}) {
  const platform = options.platform || process.platform;
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (options.updateRootDir) return path.resolve(options.updateRootDir);
  return platformPath.join(
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
  if (semver.valid(version) !== version) {
    throw new Error(`Invalid subapp version: ${version}`);
  }
  return version;
}

function validateUpdatePolicy(value, id) {
  if (value === undefined) return { download: 'background', install: 'next-launch' };
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

function resolveInstalledPackagePath(rootDir, entry) {
  const legacyPath = packagePathFor(rootDir, entry.package);
  // An interrupted uninstall suppresses every package source until cleanup is retried.
  try {
    if (versions.isUninstalling(rootDir, entry)) {
      return { packagePath: legacyPath, disabled: true, uninstalling: true };
    }
  } catch (error) {
    return {
      packagePath: legacyPath,
      disabled: true,
      uninstalling: true,
      selectionError: error.message,
    };
  }
  // A managed dev link always wins over a selected release.
  if (fs.lstatSync(legacyPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return { packagePath: legacyPath, development: true, source: 'development' };
  }
  let selectionError;
  let selection = null;
  try {
    selection = versions.readSelection(rootDir, entry, prepared => {
      const manifest = readJson(path.join(prepared.packagePath, 'package.json'));
      const runnable = resolveRunnablePackage(prepared.packagePath, entry.id, manifest);
      if (isDistRelativePath(runnable.mainEntry) || isDistRelativePath(runnable.uiIndex)
        || !fs.existsSync(path.join(runnable.packagePath, runnable.mainEntry))
        || !fs.existsSync(path.join(runnable.packagePath, runnable.uiIndex))) {
        throw new Error(`Selected subapp runtime is incomplete: ${entry.id}`);
      }
    });
  } catch (error) {
    selectionError = error.message;
  }
  if (selection?.selectionMode === 'pinned') return selection;

  // Old npm installs remain valid. In auto mode, a newer B wins so an old host cannot
  // silently downgrade a version selected by a newer host.
  if (fs.existsSync(path.join(legacyPath, 'package.json'))) {
    try {
      const legacy = readJson(path.join(legacyPath, 'package.json'));
      const legacyVersion = legacy.name === entry.package && semver.valid(legacy.version) ? legacy.version : null;
      if (!selection || (legacyVersion && semver.gt(legacyVersion, selection.version))) {
        return { packagePath: legacyPath, source: 'legacy-npm', selectionError };
      }
    } catch (error) {
      selectionError ||= error.message;
    }
  }
  if (selection) return selection;
  return { packagePath: legacyPath, source: 'legacy-npm', selectionError };
}

function readInstalledState(rootDir, entry) {
  const selected = resolveInstalledPackagePath(rootDir, entry);
  const packagePath = selected.packagePath;
  const packageJsonPath = path.join(packagePath, 'package.json');
  if (selected.disabled || !fs.existsSync(packageJsonPath)) {
    return {
      installed: false,
      installedVersion: null,
      packagePath,
      config: null,
      ...(selected.uninstalling ? { uninstalling: true } : {}),
    };
  }

  try {
    const development = selected.development === true;
    const packageJson = readJson(packageJsonPath);
    if (!development && packageJson.name !== entry.package) {
      throw new Error('Installed subapp package name does not match the catalog');
    }
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
        env: {
          AILY_SUBAPP_INSTALL_ROOT: rootDir,
          AILY_SUBAPP_PACKAGE_PATH: runnablePackagePath,
          AILY_SUBAPP_VERSION: installedVersion || '',
          AILY_SUBAPP_SOURCE: selected.source || (development ? 'development' : 'legacy-npm'),
        },
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
      ...(selected.selectionError ? { selectionWarning: selected.selectionError } : {}),
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
          rootDir,
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
          uninstalling: installedState.uninstalling === true,
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

function readBundledCoderFallback(options = {}) {
  const env = options.env || process.env;
  if ((options.buildProduct || env.AILY_BUILD_PRODUCT) !== 'coder') return null;
  const childPath = options.childPath || env.AILY_CHILD_PATH;
  if (!childPath) return null;
  const manifestPath = path.join(childPath, `${BUNDLED_CODER_ID}.json`);
  const tarballPath = path.join(childPath, `${BUNDLED_CODER_ID}.tgz`);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(tarballPath)) return null;
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== 1 || manifest.entry?.package !== BUNDLED_CODER_PACKAGE) {
    throw new Error('Invalid bundled Aily Coder Editor manifest');
  }
  const entry = validateIndex({ [BUNDLED_CODER_ID]: manifest.entry })[BUNDLED_CODER_ID];
  parseIntegrity(manifest.integrity);
  return { entry, tarballPath, integrity: manifest.integrity };
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
  const searchPath = Object.entries(options.env || {}).find(([key]) => key.toLowerCase() === 'path')?.[1]
    ?? Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const commands = command !== 'npm.cmd' ? [command] : String(searchPath).split(';')
    .filter(Boolean).map(directory => path.join(directory.replace(/^"|"$/g, ''), 'npm.cmd'));
  for (const npmCommand of commands) {
    const directory = path.dirname(npmCommand);
    const cli = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(cli)) continue;
    const node = path.join(directory, 'node.exe');
    return {
      command: fs.existsSync(node) ? node : process.execPath,
      args: [cli, ...args],
      shell: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  // Compatibility for unusual legacy npm.cmd layouts. Never send expansion characters to cmd.
  if ([command, ...args].some(value => /["%\r\n]/.test(String(value)))) {
    throw new Error('Cannot safely run this npm path through cmd.exe; install the bundled npm CLI');
  }
  return {
    command: quoteWindowsShellPath(command),
    args: args.map(quoteWindowsShellPath),
    shell: true,
  };
}

function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const { command, args: spawnArgs, shell, env: spawnEnv } = prepareNpmSpawn(args, options);
    const env = { ...process.env };
    for (const [key, value] of Object.entries({ ...(options.env || {}), ...spawnEnv })) {
      if ((options.platform || process.platform) === 'win32') {
        for (const existing of Object.keys(env)) {
          if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
        }
      }
      env[key] = value;
    }
    const child = spawn(command, spawnArgs, {
      env,
      cwd: options.cwd,
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
  return paths;
}

function readSubappUpdateStatus(updateRootDir, entry, installedState, operation = null, rootDir = null) {
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
      ...(operation.phase ? { phase: operation.phase } : {}),
      ...(operation.error ? { error: operation.error } : {}),
    };
  }

  if (rootDir) {
    try {
      const prepared = readPreparedVersion(rootDir, entry);
      if (prepared) return { state: 'ready', targetVersion, ready: true, downloadedAt: prepared.installedAt };
    } catch (error) {
      return { state: 'failed', targetVersion, ready: false, error: error.message };
    }
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

// Extraction and dependency resolution happen in a private generation. Activation never runs npm.
function validatePreparedPackage(packagePath, entry) {
  const manifest = readJson(path.join(packagePath, 'package.json'));
  if (manifest.name !== entry.package || manifest.version !== entry.version) {
    throw new Error(`Prepared subapp package identity does not match: ${entry.id}@${entry.version}`);
  }
  const runnable = resolveRunnablePackage(packagePath, entry.id, manifest);
  if (isDistRelativePath(runnable.mainEntry) || isDistRelativePath(runnable.uiIndex)
    || !fs.existsSync(path.join(runnable.packagePath, runnable.mainEntry))
    || !fs.existsSync(path.join(runnable.packagePath, runnable.uiIndex))) {
    throw new Error(`Prepared subapp runtime is incomplete: ${entry.id}@${entry.version}`);
  }
  return { manifest, runnable };
}

function portablePackageStatus(packagePath, manifest, options = {}) {
  const declaration = isObject(manifest.ailyPortable) ? manifest.ailyPortable : null;
  const scripts = isObject(manifest.scripts) ? manifest.scripts : {};
  if (['preinstall', 'install', 'postinstall'].some(name => typeof scripts[name] === 'string' && scripts[name].trim())) {
    return { portable: false, reason: 'package has install lifecycle scripts' };
  }
  const dependencies = {
    ...(isObject(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isObject(manifest.optionalDependencies) ? manifest.optionalDependencies : {}),
    ...(isObject(manifest.peerDependencies) ? manifest.peerDependencies : {}),
  };
  const bundled = new Set([
    ...(Array.isArray(manifest.bundledDependencies) ? manifest.bundledDependencies : []),
    ...(Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : []),
  ]);
  // Aily Coder Editor 0.1.6/0.1.7 were already published as complete runtime
  // bundles before the portable marker became mandatory. Keep this narrowly
  // scoped compatibility path so those immutable packages are not sent through
  // npm after extraction. Generic unmarked packages still use legacy npm.
  if (!declaration || declaration.version !== 1) {
    const isSelfContainedCoder = manifest.name === BUNDLED_CODER_PACKAGE
      && manifest.ailySubapp?.id === BUNDLED_CODER_ID
      && ['0.1.6', '0.1.7'].includes(manifest.version)
      && ['darwin', 'win32', 'linux'].includes(options.platform || process.platform)
      && ['arm64', 'x64'].includes(options.arch || process.arch)
      && Object.keys(dependencies).length === 0
      && fs.existsSync(path.join(packagePath, 'runtime', 'index.js'));
    return isSelfContainedCoder
      ? { portable: true, compatibility: 'aily-coder-editor-pre-portable-marker' }
      : { portable: false, reason: 'missing ailyPortable v1' };
  }
  const platform = options.platform || process.platform;
  const architecture = options.arch || process.arch;
  if (Array.isArray(declaration.platforms) && !declaration.platforms.includes(platform)) {
    throw new Error(`Subapp package does not support ${platform}`);
  }
  if (Array.isArray(declaration.architectures) && !declaration.architectures.includes(architecture)) {
    throw new Error(`Subapp package does not support ${architecture}`);
  }
  for (const dependency of Object.keys(dependencies)) {
    if (!bundled.has(dependency)
      || !fs.existsSync(path.join(packagePath, 'node_modules', ...dependency.split('/'), 'package.json'))) {
      return { portable: false, reason: `dependency is not bundled: ${dependency}` };
    }
  }
  return { portable: true };
}

function readPreparedVersion(rootDir, entry) {
  const prepared = versions.readPrepared(rootDir, entry);
  if (!prepared) return null;
  validatePreparedPackage(prepared.packagePath, entry);
  return prepared;
}

async function prepareVersionPackage(rootDir, entry, npmRunner, options = {}) {
  const lockRoot = path.join(rootDir, 'store', '.locks', versions.storeKeyForPackage(entry.package));
  const release = await waitForUpdateLock(lockRoot);
  let candidate;
  let published = false;
  try {
    if (versions.isUninstalling(rootDir, entry)) {
      throw new Error(`Subapp uninstall is still being completed: ${entry.id}`);
    }
    if (!options.reinstall) {
      try {
        const existing = readPreparedVersion(rootDir, entry);
        if (existing) return existing;
      } catch {
        // Repair into a new generation; never overwrite files a running process may hold.
      }
    }
    candidate = versions.createCandidate(rootDir, entry);
    const tracker = options.progressTracker;
    const tarball = candidate.tarball;
    const bundle = options.bundledCoderFallback;
    const distribution = bundle ? null : (options.distribution || await resolvePackageDistribution(entry, npmRunner, options));
    const source = bundle?.tarballPath || options.tarballPath;
    if (source) {
      await fs.promises.copyFile(source, tarball);
    } else {
      await (options.downloadFile || downloadFileWithProgress)(
        distribution.tarball, tarball, percent => tracker?.setDownload(percent), options,
      );
    }
    tracker?.setDownload(100);
    await extractNpmTarballInBackground(tarball, candidate.source, {
      integrity: bundle?.integrity || distribution.integrity,
      onProgress: percent => tracker?.setExtract(percent),
    });
    let { manifest } = validatePreparedPackage(candidate.source, entry);
    let portability = portablePackageStatus(candidate.source, manifest, options);
    if (bundle && !portability.portable) {
      // The application-owned offline fallback is validated as a self-contained artifact below.
      portability = { portable: true, bundledFallback: true };
    }
    if (!portability.portable) {
      // Compatibility path for older npm packages: install dependencies and run lifecycle scripts
      // inside A/source. The shared legacy app project and B are never reified.
      const npmSource = fs.realpathSync(candidate.source);
      await npmRunner([
        'install', '--prefix', npmSource, '--omit=dev', '--no-audit', '--no-fund',
        '--foreground-scripts', '--cache', path.join(rootDir, 'store', versions.storeKeyForPackage(entry.package), 'download-cache', 'npm-cache'),
        '--prefer-offline',
      ], withProgressOutput({ ...options, cwd: npmSource }, tracker));
      ({ manifest } = validatePreparedPackage(candidate.source, entry));
    }
    if (bundle) {
      if (manifest.ailySubapp?.id !== entry.id
        || !fs.existsSync(path.join(candidate.source, 'runtime', 'index.js'))
        || Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).length) {
        throw new Error('Bundled Aily Coder Editor is not a complete self-contained package');
      }
    }
    if (versions.isUninstalling(rootDir, entry)) {
      throw new Error(`Subapp was uninstalled while preparing: ${entry.id}`);
    }
    const prepared = versions.publishCandidate(rootDir, entry, candidate, {
      distribution,
      integrity: bundle?.integrity || distribution?.integrity,
      installMode: portability.portable ? 'portable' : 'legacy-npm',
      replace: options.reinstall === true,
    });
    published = true;
    tracker?.setExtract(100);
    return prepared;
  } finally {
    // Published generations are immutable, including when progress delivery throws.
    try {
      if (candidate && !published) fs.rmSync(candidate.project, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}

async function stageSubappUpdate(rootDir, updateRootDir, entry, npmRunner, options = {}) {
  const installedState = readInstalledState(rootDir, entry);
  if (installedState.development) throw new Error(`Development-linked subapp cannot be updated: ${entry.id}`);
  if (!installedState.installed || !hasUpdate(installedState.installedVersion, entry.version)) {
    throw new Error(`Subapp update is not available: ${entry.id}`);
  }
  const tracker = options.progressTracker;
  tracker?.start();
  try {
    const existing = readUpdateRecord(updateRootDir, entry);
    let stagedOptions = options;
    // Accept tarballs downloaded by old hosts, without depending on the old shared npm cache.
    if (existing) {
      try {
        const paths = verifyStagedAssets(updateRootDir, existing);
        stagedOptions = { ...options, tarballPath: paths.package, distribution: existing.distribution };
      } catch { /* Re-download an incomplete legacy cache. */ }
    }
    const prepared = await prepareVersionPackage(rootDir, entry, npmRunner, stagedOptions);
    const record = {
      schemaVersion: UPDATE_SCHEMA_VERSION, id: entry.id, packageName: entry.package,
      version: entry.version, state: 'ready', phase: 'download', stagedAt: prepared.installedAt,
      entry, distribution: prepared.distribution, versionStore: true,
    };
    writeJsonAtomic(updateStatePath(updateRootDir, entry.id, entry.version), record);
    tracker?.complete();
    return record;
  } catch (error) {
    writeJsonAtomic(updateStatePath(updateRootDir, entry.id, entry.version), {
      schemaVersion: UPDATE_SCHEMA_VERSION, id: entry.id, packageName: entry.package,
      version: entry.version, state: 'failed', phase: 'download', entry,
      failedAt: new Date().toISOString(), error: error.message || String(error),
    });
    throw error;
  }
}

async function waitForUpdateLock(directory) {
  const deadline = Date.now() + 120000;
  let release;
  while (!(release = acquireUpdateLock(directory))) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for subapp installation');
    await sleep(100);
  }
  return release;
}

function packageInstallFromTarballArgs(rootDir, tarballPath) {
  return [
    'install', '--prefix', rootDir, '--save-exact', '--omit=dev', '--no-audit', '--no-fund',
    '--foreground-scripts', tarballPath,
  ];
}

function withProgressOutput(options = {}, tracker) {
  return {
    ...options,
    onOutput: createProgressOutputHandler(tracker, options.onOutput),
  };
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

// Inventory failures defer destructive cleanup. They must never be interpreted as idle.
function hasProcessesUsingPackagePath(packagePath, platform = process.platform) {
  const needle = path.resolve(packagePath);
  const windows = platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress']
    : ['-ww', '-axo', 'pid=,command='];
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(true);
      try {
        const rows = windows
          ? [JSON.parse(stdout || '[]')].flat().map(row => ({ pid: row.ProcessId, command: row.CommandLine || '' }))
          : stdout.trim().split('\n').map(line => {
            const match = line.trim().match(/^(\d+)\s+(.*)$/);
            return { pid: Number(match?.[1]), command: match?.[2] || '' };
          });
        resolve(rows.some(row => Number(row.pid) !== process.pid
          && (windows ? row.command.toLowerCase().includes(needle.toLowerCase()) : row.command.includes(needle))));
      } catch {
        resolve(true);
      }
    });
  });
}

function listProcessesUsingPath(packagePath, options = {}) {
  const platform = options.platform || process.platform;
  if (!packagePath) return Promise.resolve([]);

  if (platform !== 'win32') {
    const execFileImpl = options.execFileImpl || execFile;
    const needle = path.resolve(packagePath);
    return new Promise((resolve) => {
      execFileImpl(
        'ps',
        ['-ww', '-axo', 'pid=,command='],
        { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            console.warn('[subapp-manager] listProcessesUsingPath failed:', error.message || error);
            resolve([]);
            return;
          }
          const selfPid = process.pid;
          resolve(String(stdout || '').trim().split('\n').flatMap((line) => {
            const match = line.trim().match(/^(\d+)\s+(.*)$/);
            const pid = Number(match?.[1]);
            const commandLine = match?.[2] || '';
            if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid || !commandLine.includes(needle)) {
              return [];
            }
            const executable = commandLine.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)?.slice(1).find(Boolean) || '';
            return [{
              pid,
              name: path.basename(executable) || 'unknown',
              commandLine,
              source: 'command-line',
            }];
          }));
        },
      );
    });
  }

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

async function ensureVersionReplacementIsIdle(rootDir, entry, options = {}) {
  const target = path.join(
    rootDir,
    'store',
    versions.storeKeyForPackage(entry.package),
    entry.version,
  );
  if (!fs.existsSync(target)) return;

  const holders = await collectBusyHolders(target, entry, options);
  if (holders.length) {
    if (options.forceClose !== true) throw formatBusyNeedsForceError(target, holders);
    await forceCloseBusyHolders(target, entry, holders, options);
    const sleepImpl = options.sleep || sleep;
    await sleepImpl(Number.isFinite(options.forceCloseSettleMs) ? options.forceCloseSettleMs : 500);
  }

  const isBusy = options.hasProcessesUsingPath || hasProcessesUsingPackagePath;
  const sleepImpl = options.sleep || sleep;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!await isBusy(target, options.platform || process.platform)) return;
    if (attempt < 3) await sleepImpl(100 * (attempt + 1));
  }
  throw formatBusyNeedsForceError(target, holders);
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
  if (!targetPath || !fs.lstatSync(targetPath, { throwIfNoEntry: false })) return;
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

function removePackageFromRootManifests(rootDir, packageName) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(rootDir, name);
    if (!fs.existsSync(file)) continue;
    const manifest = readJson(file);
    let changed = false;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (isObject(manifest[field]) && Object.prototype.hasOwnProperty.call(manifest[field], packageName)) {
        delete manifest[field][packageName];
        changed = true;
      }
    }
    if (name === 'package-lock.json') {
      if (isObject(manifest.packages?.[''])) {
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          if (isObject(manifest.packages[''][field])
            && Object.prototype.hasOwnProperty.call(manifest.packages[''][field], packageName)) {
            delete manifest.packages[''][field][packageName];
            changed = true;
          }
        }
      }
      const packageKey = `node_modules/${packageName}`;
      if (isObject(manifest.packages) && Object.prototype.hasOwnProperty.call(manifest.packages, packageKey)) {
        delete manifest.packages[packageKey];
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(file, manifest);
  }
}

function assertSubappUninstallComplete(rootDir, entry, paths) {
  const residuals = paths
    .filter(target => fs.lstatSync(target, { throwIfNoEntry: false }))
    .map(target => path.resolve(target));
  const packageKey = `node_modules/${entry.package}`;
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(rootDir, name);
    if (!fs.existsSync(file)) continue;
    const manifest = readJson(file);
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies']
      .some(field => isObject(manifest[field])
        && Object.prototype.hasOwnProperty.call(manifest[field], entry.package));
    const rootDeclared = ['dependencies', 'devDependencies', 'optionalDependencies']
      .some(field => isObject(manifest.packages?.['']?.[field])
        && Object.prototype.hasOwnProperty.call(manifest.packages[''][field], entry.package));
    const packageLocked = isObject(manifest.packages)
      && Object.prototype.hasOwnProperty.call(manifest.packages, packageKey);
    if (declared || rootDeclared || packageLocked) residuals.push(path.resolve(file));
  }
  if (!residuals.length) return;

  const error = new Error(
    `Subapp uninstall is incomplete; all installed versions and legacy compatibility files must be removed: ${entry.id}\n`
      + residuals.join('\n'),
  );
  error.code = 'SUBAPP_UNINSTALL_INCOMPLETE';
  error.residualPaths = residuals;
  throw error;
}

function declaredBinNames(packagePath, packageName) {
  try {
    const manifest = readJson(path.join(packagePath, 'package.json'));
    if (typeof manifest.bin === 'string') return [packageName.split('/').pop()];
    return isObject(manifest.bin) ? Object.keys(manifest.bin) : [];
  } catch {
    return [];
  }
}

function removeOwnedBinLinks(rootDir, packagePath, packageName, binNames) {
  const binRoot = path.join(rootDir, 'node_modules', '.bin');
  const packageNeedles = [
    path.resolve(packagePath).toLowerCase(),
    `node_modules/${packageName}`.toLowerCase(),
    `node_modules\\${packageName.replaceAll('/', '\\')}`.toLowerCase(),
  ];
  for (const binName of binNames) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(binName)) continue;
    for (const suffix of ['', '.cmd', '.ps1']) {
      const link = path.join(binRoot, `${binName}${suffix}`);
      const stat = fs.lstatSync(link, { throwIfNoEntry: false });
      if (!stat) continue;
      let owned = false;
      try {
        const evidence = stat.isSymbolicLink()
          ? path.resolve(path.dirname(link), fs.readlinkSync(link)).toLowerCase()
          : stat.isFile() && stat.size <= 128 * 1024
            ? fs.readFileSync(link, 'utf8').toLowerCase()
            : '';
        owned = packageNeedles.some(needle => evidence.includes(needle));
      } catch { /* Preserve ambiguous shims owned by another package. */ }
      if (owned) fs.rmSync(link, { force: true });
    }
  }
}

async function uninstallSubappVersions(rootDir, updateRootDir, entry, options = {}) {
  const legacyPath = packagePathFor(rootDir, entry.package);
  const storeKey = versions.storeKeyForPackage(entry.package);
  const storeRoot = path.join(rootDir, 'store');
  const versionStoreRoot = path.join(storeRoot, storeKey);
  const binNames = declaredBinNames(legacyPath, entry.package);

  const preparationLocks = [];
  const lockDirectory = path.join(storeRoot, '.locks');
  try {
    preparationLocks.push(await waitForUpdateLock(path.join(lockDirectory, storeKey)));
    if (typeof options.forceStopChildToolByCatalogId === 'function') {
      const stopped = await options.forceStopChildToolByCatalogId(entry.id);
      if (stopped?.success === false && stopped.reason !== 'not-found') {
        throw new Error(`Unable to stop the running subapp before uninstalling: ${entry.id}`);
      }
    }

    const targets = [legacyPath, versionStoreRoot];
    for (const target of targets) {
      const holders = await collectBusyHolders(target, entry, options);
      if (holders.length) {
        if (options.forceClose !== true) throw formatBusyNeedsForceError(target, holders);
        await forceCloseBusyHolders(target, entry, holders, options);
      }
      if ((options.platform || process.platform) !== 'win32'
        && await (options.hasProcessesUsingPath || hasProcessesUsingPackagePath)(target, options.platform || process.platform)) {
        throw formatBusyNeedsForceError(target, holders);
      }
    }

    // The marker is written only when destructive cleanup is about to start. A busy
    // preflight must leave the existing installation visible and retryable.
    versions.beginUninstall(rootDir, entry);
    removeOwnedBinLinks(rootDir, legacyPath, entry.package, binNames);
    for (const target of targets) await rmWithBusyRetry(target, options);

    const updateCachePath = path.join(updateRootDir, validateId(entry.id));
    await rmWithBusyRetry(updateCachePath, options);
    removePackageFromRootManifests(rootDir, entry.package);
    assertSubappUninstallComplete(rootDir, entry, [...targets, updateCachePath]);
    versions.finishUninstall(rootDir, entry);
  } finally {
    for (const release of preparationLocks.reverse()) release();
  }
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

async function activateStagedSubappUpdate(rootDir, updateRootDir, entry, npmRunner, options = {}) {
  let prepared = readPreparedVersion(rootDir, entry);
  if (!prepared) {
    const record = readUpdateRecord(updateRootDir, entry);
    if (!record) throw new Error(`Downloaded update is not available: ${entry.id}`);
    const paths = verifyStagedAssets(updateRootDir, record);
    prepared = await prepareVersionPackage(rootDir, entry, npmRunner, {
      ...options, tarballPath: paths.package, distribution: record.distribution,
    });
  }
  const release = options.lockHeld ? () => {} : await waitForUpdateLock(path.join(rootDir, 'store', '.locks'));
  try {
    const installed = readInstalledState(rootDir, entry);
    if (installed.development) throw new Error(`Development-linked subapp cannot be updated: ${entry.id}`);
    if (installed.installed && semver.valid(installed.installedVersion)
      && semver.gt(installed.installedVersion, entry.version)) {
      return { id: entry.id, version: installed.installedVersion, status: 'current' };
    }
    versions.activate(rootDir, entry, prepared);
    options.progressTracker?.complete();
    return { id: entry.id, version: entry.version, status: 'installed' };
  } finally {
    release();
  }
}

function createSubappManager(options = {}) {
  const rootDir = resolveSubappRoot(options);
  const updateRootDir = resolveSubappUpdateRoot(options);
  const updateOperations = new Map();
  const backgroundAttempts = new Set();
  const backgroundDownloads = new Map();
  const pendingUninstallCounts = new Map();
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
    const bundle = readBundledCoderFallback(options);
    if (!bundle) return loadConfiguredIndex(strategy);
    let loaded;
    try {
      // 首次启动不必等待网络，正常刷新仍会获取远端目录及更新信息。
      loaded = await loadConfiguredIndex(strategy === 'cache-first' ? 'cache-only' : strategy);
    } catch (error) {
      if (!['cache-first', 'cache-only', 'network-first'].includes(strategy)) throw error;
      loaded = {
        index: {},
        meta: {
          indexUrl: resolveIndexUrl(), source: 'cache', fetchedAt: new Date().toISOString(),
          warning: strategy === 'network-first' ? error.message : null,
        },
      };
    }
    return {
      ...loaded,
      index: { [BUNDLED_CODER_ID]: bundle.entry, ...loaded.index },
    };
  }

  async function loadConfiguredIndex(strategy = 'network-first') {
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
    const state = createCatalogState(rootDir, index, payload.locale || 'en', {
      ...meta,
      updateRootDir,
      updateOperations,
    });
    for (const item of state.apps) {
      const runningConfig = options.getRunningSubappConfig?.(item.id);
      if (runningConfig) item.config = runningConfig;
    }
    return state;
  }

  function updateKey(entry) {
    return `${entry.id}@${entry.version}`;
  }

  function assertNotUninstalling(id, entry = null) {
    if ((pendingUninstallCounts.get(id) || 0) <= 0
      && (!entry || !versions.isUninstalling(rootDir, entry))) {
      return;
    }
    const error = new Error(`Subapp uninstall is in progress: ${id}`);
    error.code = 'SUBAPP_UNINSTALLING';
    throw error;
  }

  function progressHandler(entry, state, externalHandler) {
    return (progress) => {
      const percent = progress.action === 'download-update'
        ? clampProgress(progress.phase === 'extract'
          ? progress.extractProgress
          : progress.downloadProgress)
        : clampProgress(progress.percent);
      updateOperations.set(updateKey(entry), {
        version: entry.version,
        state,
        progress: percent,
        phase: progress.phase,
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
      const status = readSubappUpdateStatus(updateRootDir, entry, installedState, null, rootDir);
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

  async function prepareLaunch(payload = {}) {
    const { index } = await loadIndex('cache-first');
    const entry = index[validateId(payload.id)];
    if (!entry) throw new Error('Subapp is not present in the catalog');
    // Only serialize the tiny selection/start handshake, never npm extraction.
    const release = await waitForUpdateLock(path.join(rootDir, 'store', '.locks'));
    try {
      let installed = readInstalledState(rootDir, entry);
      const runningConfig = options.getRunningSubappConfig?.(entry.id) || null;
      if (!runningConfig && payload.deferPreparedUpdate !== true
        && index.dev !== true && !installed.development && installed.installed
        && hasUpdate(installed.installedVersion, entry.version)) {
        try {
          const prepared = readPreparedVersion(rootDir, entry);
          if (prepared) {
            versions.activate(rootDir, entry, prepared);
            installed = readInstalledState(rootDir, entry);
          }
        } catch (error) {
          // A failed background update must never prevent launching the last working version.
          console.warn('[subapp-manager] prepared version deferred:', error.message);
        }
      }
      if (!installed.installed) throw new Error(`Subapp is not installed: ${entry.id}`);
      return { config: installed.config, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async function mutate(action, payload = {}) {
    const requestedId = validateId(payload.id);
    if (action !== 'uninstall') assertNotUninstalling(requestedId);
    const tracksUninstall = action === 'uninstall';
    if (tracksUninstall) {
      pendingUninstallCounts.set(requestedId, (pendingUninstallCounts.get(requestedId) || 0) + 1);
    }
    try {
      return await enqueueMutation(async () => {
      const { index } = await loadIndex('cache-first');
      const id = requestedId;
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
        if (action === 'uninstall') {
          const downloads = [...backgroundDownloads.entries()]
            .filter(([key]) => key.startsWith(`${entry.id}@`))
            .map(([, operation]) => operation.catch(() => null));
          await Promise.all(downloads);
        }
        const installed = readInstalledState(rootDir, entry);
        if (installed.development || index.dev === true) throw new Error('Development subapps cannot be changed');
        if ((action === 'update' || action === 'install-update')
          && installed.installed && !hasUpdate(installed.installedVersion, entry.version)) {
          return list({ locale: payload.locale || 'en' });
        }
        progressTracker.start();
        if (action !== 'uninstall' && versions.isUninstalling(rootDir, entry)) {
          const error = new Error(`Subapp uninstall must be completed before installation: ${entry.id}`);
          error.code = 'SUBAPP_UNINSTALLING';
          throw error;
        }
        let targetEntry = entry;
        let prepared;
        if (action !== 'uninstall') {
          // Await a concurrent background download so a click never installs the same version twice.
          const downloading = backgroundDownloads.get(updateKey(entry));
          if (downloading) await downloading;
          if (action === 'install-update') {
            prepared = readPreparedVersion(rootDir, entry);
            if (!prepared) {
              const record = readUpdateRecord(updateRootDir, entry);
              if (!record) throw new Error(`Downloaded update is not available: ${entry.id}`);
              const staged = verifyStagedAssets(updateRootDir, record);
              prepared = await prepareVersionPackage(rootDir, entry, options.runNpm || runNpm, {
                ...mutationOptions, tarballPath: staged.package, distribution: record.distribution,
              });
            }
          } else {
            const bundle = action === 'install' && !installed.installed && id === BUNDLED_CODER_ID
              ? readBundledCoderFallback(options) : null;
            targetEntry = bundle?.entry || entry;
            if (action === 'reinstall' && typeof options.forceStopChildToolByCatalogId === 'function') {
              const stopResult = await options.forceStopChildToolByCatalogId(entry.id);
              if (stopResult?.success === false && stopResult.reason !== 'not-found') {
                throw new Error(`Unable to stop the running subapp before reinstalling: ${entry.id}`);
              }
            }
            if (action === 'reinstall') {
              await ensureVersionReplacementIsIdle(rootDir, targetEntry, mutationOptions);
            }
            prepared = await prepareVersionPackage(rootDir, targetEntry, options.runNpm || runNpm, {
              ...mutationOptions, reinstall: action === 'reinstall', bundledCoderFallback: bundle,
            });
          }
        }
        releaseLock = await waitForUpdateLock(path.join(rootDir, 'store', '.locks'));
        // A dev link may have been added while downloading; do not supersede it.
        const current = readInstalledState(rootDir, entry);
        if (current.development || readDevelopmentIndexCache(rootDir)) {
          throw new Error('Development subapps cannot be changed');
        }
        if (action === 'uninstall') {
          await uninstallSubappVersions(rootDir, updateRootDir, entry, mutationOptions);
        } else if (!current.installed || !semver.valid(current.installedVersion)
          || semver.gte(targetEntry.version, current.installedVersion)) {
          versions.activate(rootDir, targetEntry, prepared);
        }
        progressTracker.complete();
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
    } finally {
      if (tracksUninstall) {
        const remaining = (pendingUninstallCounts.get(requestedId) || 1) - 1;
        if (remaining > 0) pendingUninstallCounts.set(requestedId, remaining);
        else pendingUninstallCounts.delete(requestedId);
      }
    }
  }

  async function downloadUpdate(payload = {}) {
    const { index } = await loadIndex('cache-first');
    if (index.dev === true) throw new Error('Development subapps cannot be updated');
    const id = validateId(payload.id);
    const entry = index[id];
    if (!entry) throw new Error(`Subapp is not present in the remote index: ${id}`);
    assertNotUninstalling(id, entry);
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
    reinstall: (payload) => mutate('reinstall', payload),
    update: (payload) => mutate('update', payload),
    downloadUpdate,
    prepareLaunch,
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
    getRunningSubappConfig,
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
    getRunningSubappConfig,
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

  const launches = new Map();
  ipcMain.handle('subapp-manager-prepare-launch', async (event, payload = {}) => {
    const prepared = await defaultManager.prepareLaunch(payload);
    if (event.sender.isDestroyed()) {
      prepared.release();
      throw new Error('Launch owner closed');
    }
    const token = randomUUID();
    const release = () => {
      if (!launches.has(token)) return;
      launches.delete(token);
      event.sender.removeListener('destroyed', release);
      event.sender.removeListener('render-process-gone', release);
      event.sender.removeListener('did-start-navigation', onNavigation);
      prepared.release();
    };
    const onNavigation = (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) release();
    };
    launches.set(token, { owner: event.sender.id, release });
    event.sender.once('destroyed', release);
    event.sender.once('render-process-gone', release);
    event.sender.on('did-start-navigation', onNavigation);
    return { config: prepared.config, token };
  });
  ipcMain.handle('subapp-manager-finish-launch', (event, token) => {
    const launch = launches.get(token);
    if (launch?.owner === event.sender.id) launch.release();
  });

  ipcMain.handle('subapp-manager-list', (_event, payload = {}) => defaultManager.list(payload));
  ipcMain.handle('subapp-manager-install', handleMutation('install'));
  ipcMain.handle('subapp-manager-reinstall', handleMutation('reinstall'));
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
  resolveInstalledPackagePath,
  readInstalledState,
  resolveSubappRoot,
  resolveSubappUpdateRoot,
  resolveUiIndex,
  rmWithBusyRetry,
  stageSubappUpdate,
  validateIndex,
  verifyFileIntegrity,
};
