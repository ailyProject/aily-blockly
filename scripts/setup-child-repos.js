const fs = require('fs');
const { Buffer } = require('buffer');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const childDir = path.join(rootDir, 'child');

const REPOS = [
  {
    name: 'aily-coder',
    url: 'https://github.com/ailyProject/aily-coder.git',
    branch: 'downey',
    buildScript: 'build:netlify',
  },
  {
    name: 'aily-lex',
    url: 'https://github.com/ailyProject/aily-lex.git',
    buildCommand: 'npx tsc -b --force',
  },
];

const SUBAPP_REPO = {
  name: 'aily-subapp',
  url: 'https://github.com/ailyProject/aily-subapp.git',
  branch: 'main',
  buildScript: 'build',
  skipDirNames: new Set(['node_modules', 'scripts', 'dist', 'templates']),
};

const NATIVE_RUNTIME_PACKAGES = new Set([
  '@abandonware/noble',
  'serialport',
]);

function readCliListOption(name) {
  const values = [];
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const prefix = `--${name}=`;
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
      continue;
    }
    if (arg === `--${name}` && args[index + 1] && !args[index + 1].startsWith('--')) {
      values.push(args[index + 1]);
      index += 1;
    }
  }

  return values
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasCliFlag(name) {
  return process.argv.slice(2).some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function createToolNameFilter(toolNames) {
  if (!toolNames || toolNames.length === 0) {
    return null;
  }
  return new Set(toolNames);
}

function getGitAuthEnv() {
  const token = process.env.CHILD_REPOS_TOKEN;

  if (!token) {
    return {};
  }

  const credential = Buffer.from(`x-access-token:${token}`).toString('base64');

  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${credential}`,
  };
}

function run(command, cwd, options = {}) {
  console.log(`\n> (${path.relative(rootDir, cwd)}) ${command}\n`);
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

function runOptional(command, cwd) {
  try {
    run(command, cwd);
    return true;
  } catch {
    return false;
  }
}

function copyScopedModule(sourceModules, destModules, packageName) {
  const segments = packageName.split('/');
  const source = path.join(sourceModules, ...segments);
  const destination = path.join(destModules, ...segments);

  if (!fs.existsSync(source)) {
    return false;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  return true;
}

function copyNativeRuntimeModules(sourceDir, packageDir, packageJson) {
  const sourceModules = path.join(sourceDir, 'node_modules');
  const destModules = path.join(packageDir, 'node_modules');
  const dependencies = packageJson.dependencies || {};

  fs.mkdirSync(destModules, { recursive: true });

  for (const packageName of Object.keys(dependencies)) {
    if (NATIVE_RUNTIME_PACKAGES.has(packageName)) {
      copyScopedModule(sourceModules, destModules, packageName);
    }
  }

  const serialportScope = path.join(sourceModules, '@serialport');
  if (fs.existsSync(serialportScope)) {
    fs.cpSync(serialportScope, path.join(destModules, '@serialport'), { recursive: true });
  }

  const nobleScope = path.join(sourceModules, '@abandonware');
  if (fs.existsSync(nobleScope)) {
    fs.cpSync(nobleScope, path.join(destModules, '@abandonware'), { recursive: true });
  }
}

function copyToolAssets(sourceDir, packageDir) {
  for (const dirName of ['i18n', 'skill', 'vendor', 'ui']) {
    const source = path.join(sourceDir, dirName);
    if (!fs.existsSync(source)) {
      continue;
    }

    fs.cpSync(source, path.join(packageDir, dirName), { recursive: true });
  }
}

function publishToolDist(repoDir, toolName) {
  const packageDir = path.join(repoDir, toolName, 'dist', toolName);
  const workspaceDir = path.join(repoDir, 'dist', toolName);

  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.cpSync(packageDir, workspaceDir, { recursive: true });
}

function recoverNativeToolDist(repoDir, toolName) {
  const sourceDir = path.join(repoDir, toolName);
  const packageDir = path.join(sourceDir, 'dist', toolName);
  const packageJsonPath = path.join(sourceDir, 'package.json');

  if (!fs.existsSync(path.join(packageDir, 'index.js'))) {
    console.warn(`[subapp] cannot recover ${toolName}: esbuild output missing`);
    return false;
  }

  if (!fs.existsSync(path.join(sourceDir, 'node_modules'))) {
    console.warn(`[subapp] cannot recover ${toolName}: source node_modules missing`);
    return false;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  copyNativeRuntimeModules(sourceDir, packageDir, packageJson);

  if (packageJson.scripts?.['build:ui']) {
    const uiOutDir = path.join(packageDir, 'ui');
    run(`npm run build:ui -- --outdir ${JSON.stringify(uiOutDir)}`, sourceDir);
  } else {
    copyToolAssets(sourceDir, packageDir);
  }

  publishToolDist(repoDir, toolName);
  console.log(`[subapp] recovered native tool ${toolName} from source node_modules`);
  return true;
}

function buildSubappTools(repoDir, selectedToolNames = null) {
  const selected = createToolNameFilter(selectedToolNames);
  const toolNames = listToolProjects(repoDir, SUBAPP_REPO.skipDirNames)
    .map((toolDir) => path.basename(toolDir));
  const targetToolNames = selected
    ? toolNames.filter((toolName) => selected.has(toolName))
    : toolNames;
  const built = [];
  const skipped = [];

  for (const toolName of targetToolNames) {
    const buildCommand = `npm run ${SUBAPP_REPO.buildScript} -- ${JSON.stringify(toolName)}`;

    if (runOptional(buildCommand, repoDir)) {
      built.push(toolName);
      continue;
    }

    console.warn(`[subapp] build failed for ${toolName}, attempting recovery...`);
    if (recoverNativeToolDist(repoDir, toolName)) {
      built.push(toolName);
      continue;
    }

    skipped.push(toolName);
  }

  if (!targetToolNames.length) {
    throw new Error(`No matching subapp tools found${selected ? `: ${Array.from(selected).join(', ')}` : ''}`);
  }

  if (!built.length) {
    throw new Error(`No subapp tools were built or recovered${selected ? `: ${Array.from(selected).join(', ')}` : ''}`);
  }

  if (skipped.length) {
    console.warn(`[subapp] skipped tools: ${skipped.join(', ')}`);
  }

  console.log(`[subapp] ready tools: ${built.join(', ')}`);
  return built;
}

function isGitRepo(repoDir) {
  return fs.existsSync(path.join(repoDir, '.git'));
}

function syncExistingRepo(repoDir, branch) {
  if (!isGitRepo(repoDir)) {
    return;
  }

  const gitAuthEnv = getGitAuthEnv();

  if (branch) {
    run(`git fetch origin ${branch}`, repoDir, { env: gitAuthEnv });
    run(`git checkout ${branch}`, repoDir, { env: gitAuthEnv });
  }

  run('git pull --ff-only', repoDir, { env: gitAuthEnv });
}

function ensureRepoDir(name, url, branch) {
  const repoDir = path.join(childDir, name);
  const existed = fs.existsSync(repoDir);

  if (existed) {
    console.log(`[exists] ${name}: ${repoDir}`);
    syncExistingRepo(repoDir, branch);
    return { repoDir, existed: true };
  }

  fs.mkdirSync(childDir, { recursive: true });
  const cloneCmd = branch
    ? `git clone -b ${branch} ${url} ${JSON.stringify(name)}`
    : `git clone ${url} ${JSON.stringify(name)}`;
  run(cloneCmd, childDir, { env: getGitAuthEnv() });
  return { repoDir, existed: false };
}

function listToolProjects(repoDir, skipDirNames) {
  return fs.readdirSync(repoDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => !skipDirNames.has(entry.name))
    .map((entry) => path.join(repoDir, entry.name))
    .filter((toolDir) => fs.existsSync(path.join(toolDir, 'package.json')));
}

function installSubappToolProjects(repoDir, selectedToolNames = null) {
  const selected = createToolNameFilter(selectedToolNames);
  const toolDirs = listToolProjects(repoDir, SUBAPP_REPO.skipDirNames)
    .filter((toolDir) => !selected || selected.has(path.basename(toolDir)));

  for (const toolDir of toolDirs) {
    run('npm install', toolDir);

    const uiDir = path.join(toolDir, 'ui');
    if (fs.existsSync(path.join(uiDir, 'package.json'))) {
      run('npm install', uiDir);
    }
  }
}

function syncBuiltTools(repoDir, builtToolNames, toolsDir, options = {}) {
  if (!builtToolNames.length) {
    throw new Error('No built subapp tools to sync');
  }

  fs.mkdirSync(toolsDir, { recursive: true });

  for (const toolName of builtToolNames) {
    const sourceDir = path.join(repoDir, toolName, 'dist', toolName);
    const targetDir = path.join(toolsDir, toolName);

    if (!fs.existsSync(path.join(sourceDir, 'index.js'))) {
      throw new Error(`Built subapp tool output was not found: ${sourceDir}`);
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    console.log(`[copy] ${path.relative(rootDir, sourceDir)} -> ${path.relative(rootDir, targetDir)}`);
  }

  if (options.removeStale === false) {
    return;
  }

  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || builtToolNames.includes(entry.name)) {
      continue;
    }

    const staleDir = path.join(toolsDir, entry.name);
    fs.rmSync(staleDir, { recursive: true, force: true });
    console.log(`[remove] stale tool directory ${path.relative(rootDir, staleDir)}`);
  }
}

function setupSubapp(options = {}) {
  console.log('\n[subapp] preparing aily-subapp child tools...');
  ensureRepoDir(SUBAPP_REPO.name, SUBAPP_REPO.url, SUBAPP_REPO.branch);

  const repoDir = path.join(childDir, SUBAPP_REPO.name);
  const toolsDir = path.join(childDir, 'tools');
  const selectedToolNames = options.toolNames || null;

  run('npm install', repoDir);
  installSubappToolProjects(repoDir, selectedToolNames);
  const builtToolNames = buildSubappTools(repoDir, selectedToolNames);
  syncBuiltTools(repoDir, builtToolNames, toolsDir, {
    removeStale: !selectedToolNames,
  });

  console.log(`\n[subapp] copied ${builtToolNames.length} tool(s) to ${path.relative(rootDir, toolsDir)}`);
}

function installRootLocalDependency(relativePath) {
  const dependencyDir = path.join(rootDir, relativePath);
  if (!fs.existsSync(path.join(dependencyDir, 'package.json'))) {
    console.warn(`[skip] local dependency not found: ${relativePath}`);
    return;
  }

  run(`npm install --no-audit --no-fund ${JSON.stringify(`file:${relativePath.replace(/\\/g, '/')}`)}`, rootDir);
}

function main() {
  const subappOnlyTools = readCliListOption('subapp-only');
  if (subappOnlyTools.length > 0) {
    setupSubapp({ toolNames: subappOnlyTools });
    console.log('\n[done] selected subapp child tools ready.');
    return;
  }

  if (hasCliFlag('subapp-only')) {
    throw new Error('--subapp-only requires at least one tool name');
  }

  for (const repo of REPOS) {
    const { repoDir, existed } = ensureRepoDir(repo.name, repo.url, repo.branch);

    if (!existed) {
      run('npm install', repoDir);
    }

    if (repo.buildCommand) {
      run(repo.buildCommand, repoDir);
    } else if (repo.buildScript) {
      run(`npm run ${repo.buildScript}`, repoDir);
    }
  }

  installRootLocalDependency('child/aily-lex');
  setupSubapp();
  console.log('\n[done] child repos ready.');
}

main();
