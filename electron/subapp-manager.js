// 远端子应用目录与用户级 npm 安装管理。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const semver = require('semver');

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

  const index = {};
  for (const [indexId, rawEntry] of Object.entries(rawIndex)) {
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
      id,
      titleKey,
      namespace,
      package: validatePackageName(rawEntry.package),
      version: validateVersion(rawEntry.version),
      app: {
        name: typeof app.name === 'string' && app.name.trim() ? app.name.trim() : titleKey,
        description: typeof app.description === 'string' && app.description.trim()
          ? app.description.trim()
          : `${namespace}.DESCRIPTION`,
        icon: typeof app.icon === 'string' && app.icon.trim()
          ? app.icon.trim()
          : 'fa-light fa-puzzle-piece',
        enabled: app.enabled !== false,
      },
      i18n: {
        defaultLocale,
        locales,
      },
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
    const startupTimeoutMs = positiveInteger(
      declaredRuntime.startupTimeoutMs,
      STARTUP_TIMEOUTS[toolId] || 0,
      2 * 60 * 1000,
    );
    const resourceLifecycle = readRuntimeResourceLifecycleConfig(declaredRuntime);
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
        ...(resourceLifecycle ? { runtime: { resourceLifecycle } } : {}),
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
    apps: Object.values(index).map((entry) => {
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
        enabled: entry.app.enabled,
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

function runNpm(args, options = {}) {
  return new Promise((resolve, reject) => {
    const platform = options.platform || process.platform;
    const command = npmExecutable(options.env, platform);
    const child = spawn(command, args, {
      env: { ...process.env, ...(options.env || {}) },
      shell: platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
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

async function replaceInstalledPackage(rootDir, entry, npmRunner, options) {
  const packagePath = packagePathFor(rootDir, entry.package);
  const backupRoot = fs.mkdtempSync(path.join(rootDir, '.subapp-update-'));
  const backupPath = path.join(backupRoot, 'package');
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const packageJsonSnapshot = snapshotFile(packageJsonPath);
  const packageLockSnapshot = snapshotFile(packageLockPath);
  let backedUp = false;

  try {
    if (fs.existsSync(packagePath)) {
      fs.renameSync(packagePath, backupPath);
      backedUp = true;
    }

    await npmRunner(packageInstallArgs(rootDir, entry), options);
    const installedState = readInstalledState(rootDir, entry);
    if (!installedState.installed || installedState.installedVersion !== entry.version) {
      throw new Error(
        `Subapp update verification failed: expected ${entry.version}, got ${installedState.installedVersion || 'missing'}`,
      );
    }

    fs.rmSync(backupRoot, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(packagePath)) {
      fs.rmSync(packagePath, { recursive: true, force: true });
    }
    if (backedUp && fs.existsSync(backupPath)) {
      fs.mkdirSync(path.dirname(packagePath), { recursive: true });
      fs.renameSync(backupPath, packagePath);
    }
    restoreFile(packageJsonPath, packageJsonSnapshot);
    restoreFile(packageLockPath, packageLockSnapshot);
    fs.rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
}

function createSubappManager(options = {}) {
  const rootDir = resolveSubappRoot(options);
  const indexUrl = options.indexUrl || process.env.AILY_SUBAPP_INDEX_URL || DEFAULT_INDEX_URL;
  let currentIndex = null;
  let currentMeta = null;

  async function loadIndex(forceRefresh = false) {
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
      ensureInstallProject(rootDir);

      if (action === 'uninstall') {
        await (options.runNpm || runNpm)([
          'uninstall', '--prefix', rootDir, '--no-audit', '--no-fund', entry.package,
        ], options);
      } else if (action === 'update') {
        await replaceInstalledPackage(rootDir, entry, options.runNpm || runNpm, options);
      } else {
        await (options.runNpm || runNpm)(packageInstallArgs(rootDir, entry), options);
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

function registerSubappManagerHandlers(getMainWindow = () => null) {
  if (handlersRegistered) return;
  const { ipcMain } = require('electron');
  defaultManager = createSubappManager();

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
  createCatalogState,
  createSubappManager,
  packagePathFor,
  registerSubappManagerHandlers,
  resolveSubappRoot,
  validateIndex,
};
