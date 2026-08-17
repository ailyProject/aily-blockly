// 远端子应用目录与用户级 npm 安装管理。
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const semver = require('semver');
const {
  SubappReleaseTrustError,
  normalizeSubappReleaseTrustPolicies,
  requiresTrustedSubappDistribution,
  validateSubappDistribution,
  verifyDownloadedSubappDistribution,
} = require('./subapp-release-trust');

const DEFAULT_INDEX_URL = 'https://rs1.aily.pro/subapp-index.json';
const INDEX_CACHE_FILE = 'subapp-index.json';
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const TOOL_ID_ALIASES = Object.freeze({
  'aily-chat': 'aily-chat-react',
  'ffs-manager': 'ffs-manager-child',
  'aily-simulator': 'simulator',
});
const STARTUP_TIMEOUTS = Object.freeze({
  'aily-chat-react': 30000,
  'ffs-manager-child': 10000,
});
const DEFAULT_TOOLBAR_IDS = new Set(['aily-chat-react']);
const mutationQueues = new Map();
const SUBAPP_HEALTH_OUTPUT_LIMIT = 64 * 1024;
const SUBAPP_HEALTH_STARTUP_TIMEOUT_MS = 30000;
const SUBAPP_HEALTH_SHUTDOWN_TIMEOUT_MS = 15000;

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

    index[id] = {
      ...rawEntry,
      id,
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
      },
      i18n: {
        ...i18n,
        defaultLocale,
        locales,
      },
      ...(isObject(rawEntry.compatibility) ? { compatibility: rawEntry.compatibility } : {}),
      ...(rawEntry.distribution !== undefined
        ? { distribution: validateSubappDistribution(rawEntry.distribution) }
        : {}),
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

function resolveUiIndex(packagePath, catalogId, packageJson) {
  const configured = typeof packageJson?.aily?.uiIndex === 'string'
    ? packageJson.aily.uiIndex.trim()
    : typeof packageJson?.ailyBlockly?.uiIndex === 'string'
      ? packageJson.ailyBlockly.uiIndex.trim()
      : '';
  const candidates = [
    configured,
    path.join('ui', 'index.html'),
    path.join('dist', catalogId, 'ui', 'index.html'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(path.join(packagePath, candidate)))
    || candidates[0]
    || path.join('ui', 'index.html');
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
    const packageJson = readJson(packageJsonPath);
    const installedVersion = typeof packageJson.version === 'string' ? packageJson.version : null;
    const mainEntry = typeof packageJson.main === 'string' && packageJson.main.trim()
      ? packageJson.main.trim()
      : 'index.js';
    const uiIndex = resolveUiIndex(packagePath, entry.id, packageJson);
    const complete = fs.existsSync(path.join(packagePath, mainEntry))
      && fs.existsSync(path.join(packagePath, uiIndex));
    const toolId = TOOL_ID_ALIASES[entry.id] || entry.id;
    const ui = readSubappUiConfig(packagePath, packageJson, uiIndex);
    const declaredRuntime = isObject(packageJson?.ailySubapp?.runtime)
      ? packageJson.ailySubapp.runtime
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
      agent = readSubappAgentConfig(packagePath, packageJson);
    } catch (error) {
      agentError = error.message;
    }

    return {
      installed: complete,
      installedVersion,
      packagePath,
      config: complete ? {
        id: toolId,
        catalogId: entry.id,
        titleKey: entry.titleKey,
        namespace: entry.namespace,
        version: installedVersion || '',
        packageName: entry.package,
        packagePath,
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
          ...(DEFAULT_TOOLBAR_IDS.has(toolId) ? { defaultToolbar: true } : {}),
          ...(toolId === 'aily-chat-react' ? { more: 'v2' } : {}),
        },
      } : null,
      ...(agentError ? { installError: agentError } : {}),
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
          packageName: entry.package,
          availableVersion: entry.version,
          installedVersion: installedState.installedVersion,
          installed: installedState.installed,
          updateAvailable: installedState.installed
            && hasUpdate(installedState.installedVersion, entry.version),
          installPath: installedState.packagePath,
          titleKey: entry.titleKey,
          namespace: entry.namespace,
          name: copy.name,
          description: copy.description,
          icon: entry.app.icon,
          ai: entry.app.ai === true,
          enabled: true,
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

function writeIndexCache(rootDir, index) {
  ensureInstallProject(rootDir);
  const cachePath = path.join(rootDir, INDEX_CACHE_FILE);
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(tempPath, cachePath);
}

function readIndexCache(rootDir) {
  const cachePath = path.join(rootDir, INDEX_CACHE_FILE);
  return fs.existsSync(cachePath) ? validateIndex(readJson(cachePath)) : null;
}

function readDevelopmentIndexCache(rootDir) {
  const cachePath = path.join(rootDir, INDEX_CACHE_FILE);
  if (!fs.existsSync(cachePath)) return null;
  const rawIndex = readJson(cachePath);
  return rawIndex?.dev === true ? validateIndex(rawIndex) : null;
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

  if (options.preparedTrustedTarball) {
    await runNpmWithBusyRetry(
      npmRunner,
      packageInstallFromTarballArgs(
        rootDir,
        options.preparedTrustedTarball.tarballPath,
      ),
      npmOptions,
      retryOptions,
    );
    tracker?.setExtract(100);
    return;
  }

  const trustedTarball = await prepareTrustedPackageTarball(
    rootDir,
    entry,
    npmOptions,
  );
  if (trustedTarball) {
    try {
      await runNpmWithBusyRetry(
        npmRunner,
        packageInstallFromTarballArgs(rootDir, trustedTarball.tarballPath),
        npmOptions,
        retryOptions,
      );
      tracker?.setExtract(100);
      return;
    } finally {
      cleanupPreparedTarball(trustedTarball);
    }
  }

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
    if (error?.code === 'SUBAPP_RELEASE_TRUST_FAILED') {
      throw error;
    }
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
  return /\bEBUSY\b/i.test(text) && /\brename\b/i.test(text);
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
      await renameWithBusyRetry(
        packagePath,
        path.join(stagingRoot, 'package'),
        {
          retries: options.renameRetries,
          baseDelayMs: options.renameRetryDelayMs,
          sleep: options.sleep,
        },
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
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      } catch (error) {
        console.warn('[subapp-manager] failed to cleanup uninstall staging:', error.message || error);
      }
    }
  }
}

async function replaceInstalledPackage(rootDir, entry, npmRunner, options = {}) {
  const packagePath = packagePathFor(rootDir, entry.package);
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const packageJsonSnapshot = snapshotFile(packageJsonPath);
  const packageLockSnapshot = snapshotFile(packageLockPath);
  const tracker = options.progressTracker;
  let backedUp = false;
  tracker?.start();
  const preparedTrustedTarball = await prepareTrustedPackageTarball(
    rootDir,
    entry,
    withProgressOutput(options, tracker),
  );
  const backupRoot = fs.mkdtempSync(path.join(rootDir, '.subapp-update-'));
  const backupPath = path.join(backupRoot, 'package');

  try {
    if (fs.existsSync(packagePath)) {
      await renameWithBusyRetry(packagePath, backupPath, {
        retries: options.renameRetries,
        baseDelayMs: options.renameRetryDelayMs,
        sleep: options.sleep,
      });
      backedUp = true;
    }

    await installPackage(rootDir, entry, npmRunner, {
      ...options,
      preparedTrustedTarball,
    });
    const installedState = readInstalledState(rootDir, entry);
    if (!installedState.installed || installedState.installedVersion !== entry.version) {
      throw new Error(
        `Subapp update verification failed: expected ${entry.version}, got ${installedState.installedVersion || 'missing'}`,
      );
    }
    if (typeof options.verifyInstalledPackage === 'function') {
      await options.verifyInstalledPackage({
        phase: 'candidate',
        rootDir,
        entry,
        packagePath,
        installedState,
      });
    }

    fs.rmSync(backupRoot, { recursive: true, force: true });
    tracker?.complete();
  } catch (error) {
    if (fs.existsSync(packagePath)) {
      fs.rmSync(packagePath, { recursive: true, force: true });
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
    fs.rmSync(backupRoot, { recursive: true, force: true });
    if (backedUp && typeof options.verifyInstalledPackage === 'function') {
      try {
        const restoredState = readInstalledState(rootDir, {
          ...entry,
          version: JSON.parse(fs.readFileSync(
            path.join(packagePath, 'package.json'),
            'utf8',
          )).version,
        });
        await options.verifyInstalledPackage({
          phase: 'restored',
          rootDir,
          entry,
          packagePath,
          installedState: restoredState,
        });
      } catch (rollbackVerificationError) {
        throw new AggregateError(
          [error, rollbackVerificationError],
          `Subapp update failed and the restored package health check also failed: ${rollbackVerificationError.message || rollbackVerificationError}`,
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    cleanupPreparedTarball(preparedTrustedTarball);
  }
}

async function prepareTrustedPackageTarball(rootDir, entry, options = {}) {
  const trustRequired = requiresTrustedSubappDistribution(
    entry,
    options.indexUrl,
    options.releaseTrustPolicies,
  );
  const signedDistribution = entry.distribution !== undefined;
  if (!trustRequired && !signedDistribution) return null;
  if (trustRequired && !signedDistribution) {
    throw new SubappReleaseTrustError(
      `A signed distribution is required for ${entry.package}@${entry.version}.`,
    );
  }
  if (!trustRequired) {
    throw new SubappReleaseTrustError(
      `No trusted release policy matches ${entry.package}@${entry.version}.`,
    );
  }
  const stagingRoot = fs.mkdtempSync(path.join(rootDir, '.subapp-download-'));
  const tarballPath = path.join(stagingRoot, 'package.tgz');
  try {
    const download = options.downloadFile || downloadFileWithProgress;
    await download(
      entry.distribution.tarballUrl,
      tarballPath,
      (percent) => options.progressTracker?.setDownload(percent),
      options,
    );
    options.progressTracker?.setDownload(100);
    const verification = await verifyDownloadedSubappDistribution({
      entry,
      indexUrl: options.indexUrl,
      policies: options.releaseTrustPolicies,
      tarballPath,
    });
    return Object.freeze({ stagingRoot, tarballPath, verification });
  } catch (error) {
    cleanupPreparedTarball({ stagingRoot });
    throw error;
  }
}

function cleanupPreparedTarball(prepared) {
  if (!prepared?.stagingRoot || !fs.existsSync(prepared.stagingRoot)) return;
  try {
    fs.rmSync(prepared.stagingRoot, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      '[subapp-manager] failed to cleanup trusted download staging:',
      error.message || error,
    );
  }
}

async function verifyInstalledSubappStartup({
  packagePath,
  entry,
  phase,
  env = process.env,
  startupTimeoutMs = SUBAPP_HEALTH_STARTUP_TIMEOUT_MS,
  shutdownTimeoutMs = SUBAPP_HEALTH_SHUTDOWN_TIMEOUT_MS,
}) {
  const packageManifest = readJson(path.join(packagePath, 'package.json'));
  const mainEntry = resolvePackageRelativePath(
    packagePath,
    packageManifest.main || 'index.js',
    'subapp main entry',
  ).resolved;
  if (!fs.existsSync(mainEntry)) {
    throw new Error(`Subapp ${phase} health check main entry is missing.`);
  }
  const stderr = [];
  const child = spawn(process.execPath, [
    mainEntry,
    'serve',
    '--host', '127.0.0.1',
    '--port', '0',
  ], {
    cwd: packagePath,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.stderr.on('data', (chunk) => appendBoundedOutput(stderr, chunk));
  try {
    const startup = await waitForSubappHealthStartup(
      child,
      stderr,
      startupTimeoutMs,
    );
    if (startup.event !== 'ready') {
      throw new Error(
        `Subapp ${phase} startup health check failed: ${publicStartupMessage(startup.data)}`,
      );
    }
    await stopSubappHealthProbe(child, startup.data, shutdownTimeoutMs);
    return {
      status: 'ready',
      phase,
      packageName: entry.package,
      packageVersion: packageManifest.version,
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForSubappHealthExit(child, shutdownTimeoutMs).catch(() => {
        child.kill('SIGKILL');
      });
    }
  }
}

function waitForSubappHealthStartup(child, stderr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(
      `Subapp startup health check timed out: ${stderr.join('').trim()}`,
    )), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > SUBAPP_HEALTH_OUTPUT_LIMIT) {
        finish(new Error('Subapp startup health output exceeded the allowed limit.'));
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.event === 'ready' || message?.event === 'fatal') {
          finish(null, { event: message.event, data: message.data });
          return;
        }
      }
    };
    const onExit = (code, signal) => finish(new Error(
      `Subapp exited before startup health was reported (code=${code}, signal=${signal}): ${stderr.join('').trim()}`,
    ));
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function stopSubappHealthProbe(child, readyData, timeoutMs) {
  const shutdownUrl = safeSubappShutdownUrl(readyData);
  if (shutdownUrl) {
    const response = await fetch(shutdownUrl.toString(), {
      method: 'POST',
      headers: { Origin: shutdownUrl.origin },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)),
    });
    if (!response.ok) {
      throw new Error(`Subapp startup health shutdown returned HTTP ${response.status}.`);
    }
  } else {
    child.kill('SIGTERM');
  }
  const exit = await waitForSubappHealthExit(child, timeoutMs);
  if (exit.code !== 0 && exit.signal === null) {
    throw new Error(`Subapp startup health process exited with code ${exit.code}.`);
  }
}

function waitForSubappHealthExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('Subapp startup health process did not stop in time.'));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

function safeSubappShutdownUrl(readyData) {
  const baseValue = typeof readyData?.origin === 'string'
    ? readyData.origin
    : typeof readyData?.baseUrl === 'string'
      ? readyData.baseUrl
      : '';
  const shutdownValue = typeof readyData?.shutdownUrl === 'string'
    ? readyData.shutdownUrl
    : '';
  if (!baseValue || !shutdownValue) return null;
  try {
    const baseUrl = new URL(baseValue);
    const shutdownUrl = new URL(shutdownValue, baseUrl);
    if (
      baseUrl.protocol !== 'http:'
      || shutdownUrl.protocol !== 'http:'
      || shutdownUrl.origin !== baseUrl.origin
      || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(shutdownUrl.hostname)
    ) {
      return null;
    }
    return shutdownUrl;
  } catch {
    return null;
  }
}

function appendBoundedOutput(chunks, chunk) {
  chunks.push(chunk.toString('utf8'));
  while (Buffer.byteLength(chunks.join(''), 'utf8') > SUBAPP_HEALTH_OUTPUT_LIMIT) {
    chunks.shift();
  }
}

function publicStartupMessage(data) {
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  return message || 'runtime reported fatal';
}

function createSubappManager(options = {}) {
  const rootDir = resolveSubappRoot(options);
  const indexUrl = options.indexUrl || process.env.AILY_SUBAPP_INDEX_URL || DEFAULT_INDEX_URL;
  const releaseTrustPolicies = normalizeSubappReleaseTrustPolicies(
    options.releaseTrustPolicies,
  );
  let currentIndex = null;
  let currentMeta = null;

  async function loadIndex(forceRefresh = false) {
    const localIndex = readDevelopmentIndexCache(rootDir);
    if (localIndex?.dev === true) {
      currentIndex = localIndex;
      currentMeta = {
        indexUrl,
        source: 'cache',
        fetchedAt: new Date().toISOString(),
        warning: null,
      };
      return { index: localIndex, meta: currentMeta };
    }
    if (currentIndex?.dev === true) {
      currentIndex = null;
      currentMeta = null;
    }
    if (currentIndex && !forceRefresh) return { index: currentIndex, meta: currentMeta };
    try {
      const index = await fetchRemoteIndex(indexUrl, options.fetchImpl);
      writeIndexCache(rootDir, index);
      currentIndex = index;
      currentMeta = { indexUrl, source: 'network', fetchedAt: new Date().toISOString(), warning: null };
      return { index, meta: currentMeta };
    } catch (error) {
      const cached = readIndexCache(rootDir);
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
    const { index, meta } = await loadIndex(payload.refresh === true);
    return createCatalogState(rootDir, index, payload.locale || 'en', meta);
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
      const { index } = await loadIndex(false);
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
        onProgress,
      });
      const mutationOptions = {
        ...options,
        indexUrl,
        progressTracker,
        releaseTrustPolicies,
      };

      try {
        if (
          (action === 'update' || action === 'uninstall')
          && typeof options.beforePackageMutation === 'function'
        ) {
          await options.beforePackageMutation({
            action,
            id,
            toolId: TOOL_ID_ALIASES[id] || id,
            entry,
            rootDir,
          });
        }
        if (action === 'uninstall') {
          await uninstallInstalledPackage(rootDir, entry, options.runNpm || runNpm, mutationOptions);
        } else if (action === 'update') {
          await replaceInstalledPackage(rootDir, entry, options.runNpm || runNpm, mutationOptions);
        } else {
          progressTracker.start();
          await installPackage(rootDir, entry, options.runNpm || runNpm, mutationOptions);
          progressTracker.complete();
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
      }
      return list({ locale: payload.locale || 'en' });
    });
  }

  return {
    rootDir,
    indexUrl,
    list,
    install: (payload) => mutate('install', payload),
    update: (payload) => mutate('update', payload),
    uninstall: (payload) => mutate('uninstall', payload),
  };
}

let handlersRegistered = false;
let defaultManager = null;

function registerSubappManagerHandlers(getMainWindow = () => null, options = {}) {
  if (handlersRegistered) return;
  const { ipcMain } = require('electron');

  const sendProgress = (progress) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('subapp-manager-progress', progress);
    }
  };

  defaultManager = createSubappManager({
    ...options,
    onProgress: sendProgress,
    verifyInstalledPackage: options.verifyInstalledPackage
      || verifyInstalledSubappStartup,
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
  ipcMain.handle('subapp-manager-uninstall', handleMutation('uninstall'));
  handlersRegistered = true;
}

module.exports = {
  DEFAULT_INDEX_URL,
  TOOL_ID_ALIASES,
  clampProgress,
  createCatalogState,
  createMutationProgressTracker,
  createSubappManager,
  downloadFileWithProgress,
  isBusyRenameError,
  packagePathFor,
  parseDependencyProgressLog,
  prepareNpmSpawn,
  quoteWindowsShellPath,
  registerSubappManagerHandlers,
  renameWithBusyRetry,
  resolveSubappRoot,
  safeSubappShutdownUrl,
  validateIndex,
  verifyInstalledSubappStartup,
};
