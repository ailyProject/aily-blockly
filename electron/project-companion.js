const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const runFile = promisify(execFile);
const APPLICATIONS = {
  blockly: { name: 'Aily Blockly', bundleId: 'blockly.aily.pro', names: ['aily blockly', 'aily-blockly'] },
  coder: { name: 'Aily Coder', bundleId: 'coder.aily.pro', names: ['Aily Coder', 'aily-coder'] },
};
const DOWNLOAD_URL = 'https://aily.pro';

function applicationForMode(mode) {
  if (!Object.hasOwn(APPLICATIONS, mode)) throw new Error('Invalid project mode');
  return APPLICATIONS[mode];
}

function readProjectMode(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)
    || !fs.statSync(projectPath).isDirectory()) throw new Error('Invalid project directory');
  const manifestPath = path.join(projectPath, 'package.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  if (manifest?.type === 'coder') return 'coder';
  if (fs.existsSync(path.join(projectPath, 'project.abi'))) return 'blockly';
  if (fs.existsSync(path.join(projectPath, 'project.aci'))) return 'coder';
  throw new Error('Unknown project type');
}

function windowsInstallDirectories(registry, application) {
  return registry.split(/(?=^HKEY_)/m).flatMap((entry) => {
    const value = (name) => entry.match(new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)$`, 'mi'))?.[1]?.trim();
    const displayName = value('DisplayName')?.toLowerCase();
    if (!application.names.some((name) => {
      const prefix = name.toLowerCase();
      return displayName === prefix || (displayName?.startsWith(`${prefix} `)
        && /^\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(displayName.slice(prefix.length + 1)));
    })) return [];
    const location = value('InstallLocation');
    if (location) return [location.replace(/^"|"$/g, '')];
    const icon = value('DisplayIcon')?.replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '');
    return icon ? [path.win32.dirname(icon)] : [];
  });
}

async function findCompanionApplication(mode, options = {}) {
  const application = applicationForMode(mode);
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const exists = options.exists || fs.existsSync;
  const run = options.run || runFile;
  const home = options.home || os.homedir();
  const runQuiet = async (command, args) => {
    try {
      return (await run(command, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout || '';
    } catch { return ''; }
  };

  if (platform === 'darwin') {
    const indexed = await runQuiet('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${application.bundleId}'`]);
    const candidates = [
      ...indexed.split('\n').filter(Boolean),
      ...['/Applications', path.join(home, 'Applications')].flatMap((root) =>
        application.names.map((name) => path.join(root, `${name}.app`))),
    ];
    for (const candidate of new Set(candidates)) {
      if (!exists(candidate)) continue;
      const bundleId = await runQuiet('/usr/bin/plutil', [
        '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(candidate, 'Contents/Info.plist'),
      ]);
      if (bundleId.trim() === application.bundleId) return candidate;
    }
    return null;
  }

  if (platform === 'win32') {
    // NSIS supports custom installation directories and both per-user/per-machine installs.
    const registry = await Promise.all([
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ].map((key) => runQuiet('reg.exe', ['query', key, '/s'])));
    const roots = registry.flatMap((data) => windowsInstallDirectories(data, application));
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
      roots.push(...application.names.map((name) => path.win32.join(base, name)));
    }
    for (const root of new Set(roots)) {
      for (const name of application.names) {
        const candidate = path.win32.join(root, `${name}.exe`);
        if (exists(candidate)) return candidate;
      }
    }
    return null;
  }

  const binary = `aily-${mode}`;
  const candidates = [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((root) => path.join(root, binary)),
    ...application.names.map((name) => path.join('/opt', name, binary)),
  ];
  return candidates.find((candidate) => path.isAbsolute(candidate) && exists(candidate)) || null;
}

function companionLaunch(applicationPath, projectPath, platform = process.platform, env = process.env, mode = 'blockly') {
  const launchEnv = { ...env };
  // The receiving packaged app must resolve its own identity and renderer, not inherit ours.
  for (const key of ['AILY_BUILD_PRODUCT', 'AILY_BUILD_FLAVOR', 'AILY_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) {
    delete launchEnv[key];
  }
  // Retain the existing route arguments for older installed versions without --open-project.
  const projectArgs = [
    `--open-project=${projectPath}`,
    `--route=main/${mode === 'coder' ? 'code-editor-pro' : 'blockly-editor'}`,
    `--query=${encodeURIComponent(JSON.stringify({ path: projectPath }))}`,
  ];
  return {
    command: platform === 'darwin' ? '/usr/bin/open' : applicationPath,
    args: platform === 'darwin'
      ? ['-n', '-a', applicationPath, '--args', ...projectArgs]
      : projectArgs,
    options: { shell: false, detached: true, stdio: 'ignore', env: launchEnv },
  };
}

async function openCompanionProject(mode, projectPath, options = {}) {
  applicationForMode(mode);
  if (readProjectMode(projectPath) !== mode) throw new Error('Project type does not match the target application');
  const applicationPath = await (options.find || findCompanionApplication)(mode);
  if (!applicationPath) return { ok: false, reason: 'not_installed', error: 'Application is not installed' };
  const launch = companionLaunch(applicationPath, projectPath, options.platform, process.env, mode);
  await new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(launch.command, launch.args, launch.options);
    child.once('error', reject);
    if ((options.platform || process.platform) === 'darwin') {
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Application launch failed (${code})`)));
    } else {
      child.once('spawn', () => { child.unref(); resolve(); });
    }
  });
  return { ok: true };
}

function registerProjectCompanionIpc(ipcMain, shell) {
  ipcMain.handle('project-companion-status', async (_event, { mode } = {}) => {
    const application = applicationForMode(mode);
    return { installed: Boolean(await findCompanionApplication(mode)), application: application.name };
  });
  ipcMain.handle('project-companion-open', async (_event, { mode, projectPath } = {}) => {
    try { return await openCompanionProject(mode, projectPath); }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('project-companion-download', async () => {
    await shell.openExternal(DOWNLOAD_URL);
    return { ok: true };
  });
}

module.exports = { findCompanionApplication, companionLaunch, openCompanionProject, readProjectMode, windowsInstallDirectories, registerProjectCompanionIpc };
