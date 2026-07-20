const fs = require('fs');
const { Buffer } = require('buffer');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const childDir = path.join(rootDir, 'child');

// 子应用不再由本脚本拉取和编译。它们由主软件读取远端
// subapp-index.json，并安装到用户级 npm-global/app 目录。
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
  const cloneCommand = branch
    ? `git clone -b ${branch} ${url} ${JSON.stringify(name)}`
    : `git clone ${url} ${JSON.stringify(name)}`;
  run(cloneCommand, childDir, { env: getGitAuthEnv() });
  return { repoDir, existed: false };
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
  for (const repo of REPOS) {
    const { repoDir, existed } = ensureRepoDir(repo.name, repo.url, repo.branch);
    if (!existed) run('npm install', repoDir);
    if (repo.buildCommand) run(repo.buildCommand, repoDir);
    else if (repo.buildScript) run(`npm run ${repo.buildScript}`, repoDir);
  }

  installRootLocalDependency('child/aily-lex');
  console.log('\n[done] core child repos ready. Subapps are installed at runtime from the remote catalog.');
}

main();
