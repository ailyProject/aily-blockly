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
});
const STARTUP_TIMEOUTS = Object.freeze({
  'aily-chat-react': 30000,
  'ffs-manager-child': 10000,
});
const DEFAULT_TOOLBAR_IDS = new Set(['aily-chat-react']);
const mutationQueues = new Map();

function resolveAppDataPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.AILY_APPDATA_PATH) return path.resolve(env.AILY_APPDATA_PATH);
  if (platform === 'win32') return path.join(home, 'AppData', 'Local', 'aily-project');
  if (platform === 'darwin') return path.join(home, 'Library', 'aily-project');
  return path.join(home, '.config', 'aily-project');
}

function resolveSubappRoot(options = {}) {
  if (options.rootDir) return path.resolve(options.rootDir);
  return path.join(
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
    const startupTimeoutMs = STARTUP_TIMEOUTS[toolId];

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
        app: {
          ...entry.app,
          id: toolId,
          ...(DEFAULT_TOOLBAR_IDS.has(toolId) ? { defaultToolbar: true } : {}),
          ...(toolId === 'aily-chat-react' ? { more: 'v2' } : {}),
        },
      } : null,
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
    const queued = next.finally(() => {
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
      } else {
        await (options.runNpm || runNpm)([
          'install', '--prefix', rootDir, '--save-exact', '--omit=dev', '--no-audit', '--no-fund',
          '--foreground-scripts', `${entry.package}@${entry.version}`,
        ], options);
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
