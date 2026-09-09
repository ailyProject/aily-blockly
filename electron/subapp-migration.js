// Temporary installations only: keep live package paths intact until the host is idle.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');

function migrationDirectory(rootDir, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id === '..') {
    throw new Error('Invalid migration catalog id');
  }
  return path.join(rootDir, 'migration', id);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readPending(rootDir, entry) {
  const directory = migrationDirectory(rootDir, entry.id);
  const file = path.join(directory, 'pending.json');
  if (!fs.existsSync(file)) return null;

  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.schemaVersion !== 1 || record.entry?.id !== entry.id
    || record.entry?.package !== entry.package
    || !/^install-[a-f0-9-]+$/.test(record.batch)) {
    throw new Error(`Invalid pending migration: ${entry.id}`);
  }
  const project = path.join(directory, record.batch);
  const relativePackage = path.join('node_modules', ...entry.package.split('/'));
  const packagePath = path.resolve(project, relativePackage);
  if (!packagePath.startsWith(`${project}${path.sep}`)) {
    throw new Error('Invalid migration package path');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json'), 'utf8'));
  if (manifest.name !== entry.package || manifest.version !== record.entry.version) {
    throw new Error(`Pending migration package does not match its record: ${entry.id}`);
  }
  return { ...record, project, packagePath };
}

function createCandidate(rootDir, entry) {
  const directory = migrationDirectory(rootDir, entry.id);
  const batch = `install-${randomUUID()}`;
  const project = path.join(directory, batch);
  fs.mkdirSync(project, { recursive: true });
  writeJson(path.join(project, 'package.json'), {
    name: 'aily-subapp-migration', private: true, version: '1.0.0',
  });
  return { batch, project };
}

function publishCandidate(rootDir, entry, candidate, distribution) {
  writeJson(path.join(migrationDirectory(rootDir, entry.id), 'pending.json'), {
    schemaVersion: 1,
    entry,
    batch: candidate.batch,
    distribution,
    installedAt: new Date().toISOString(),
  });
}

function hasPendingMigrations(rootDir) {
  const directory = path.join(rootDir, 'migration');
  return fs.existsSync(directory) && fs.readdirSync(directory, { withFileTypes: true })
    .some(item => item.isDirectory()
      && fs.existsSync(path.join(directory, item.name, 'pending.json')));
}

// A failed process inventory must defer shared-tree writes, never authorize them.
function hasProcessesUsingRoot(rootDir, platform = process.platform) {
  const needle = path.resolve(rootDir);
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

function recoverRestore(rootDir, directory) {
  const file = path.join(directory, 'restore.json');
  if (!fs.existsSync(file)) return;
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^restore-[a-f0-9-]+$/.test(journal.workspace)) {
    throw new Error('Invalid migration restore journal');
  }
  const workspace = path.join(directory, journal.workspace);
  const backup = path.join(workspace, 'backup');
  const modules = path.join(rootDir, 'node_modules');
  const oldModules = path.join(backup, 'node_modules');

  if (journal.phase !== 'committed') {
    if (fs.existsSync(oldModules)) {
      fs.rmSync(modules, { recursive: true, force: true });
      fs.renameSync(oldModules, modules);
    } else if (!journal.modulesExisted) {
      fs.rmSync(modules, { recursive: true, force: true });
    }
    for (const name of ['package.json', 'package-lock.json']) {
      if (journal.manifests[name]) fs.copyFileSync(path.join(backup, name), path.join(rootDir, name));
      else fs.rmSync(path.join(rootDir, name), { force: true });
    }
  } else {
    // Canonical installation was committed; pending must no longer redirect launches.
    fs.rmSync(path.join(directory, 'pending.json'), { force: true });
  }
  fs.rmSync(file, { force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

// Caller owns the shared installation/start lock and has proved the tree idle.
async function restoreCanonical(rootDir, entry, install) {
  const directory = migrationDirectory(rootDir, entry.id);
  recoverRestore(rootDir, directory);
  const pending = readPending(rootDir, entry);
  if (!pending) return false;

  const workspaceName = `restore-${randomUUID()}`;
  const workspace = path.join(directory, workspaceName);
  const prepared = path.join(workspace, 'prepared');
  const backup = path.join(workspace, 'backup');
  fs.mkdirSync(prepared, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  const journal = { workspace: workspaceName, phase: 'swapping', manifests: {}, modulesExisted: fs.existsSync(path.join(rootDir, 'node_modules')) };
  const journalPath = path.join(directory, 'restore.json');

  try {
    for (const name of ['package.json', 'package-lock.json']) {
      const source = path.join(rootDir, name);
      journal.manifests[name] = fs.existsSync(source);
      if (journal.manifests[name]) {
        fs.copyFileSync(source, path.join(prepared, name));
        fs.copyFileSync(source, path.join(backup, name));
      }
    }
    if (journal.modulesExisted) {
      fs.cpSync(path.join(rootDir, 'node_modules'), path.join(prepared, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    }
    // npm works on a private copy so a failed dependency resolution cannot damage the live tree.
    await install(prepared, pending);
    writeJson(journalPath, journal);
    if (journal.modulesExisted) fs.renameSync(path.join(rootDir, 'node_modules'), path.join(backup, 'node_modules'));
    fs.renameSync(path.join(prepared, 'node_modules'), path.join(rootDir, 'node_modules'));
    for (const name of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(prepared, name), path.join(rootDir, name));
    }
    writeJson(journalPath, { ...journal, phase: 'committed' });
    recoverRestore(rootDir, directory);
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (fs.existsSync(journalPath)) recoverRestore(rootDir, directory);
    else fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  readPending,
  createCandidate,
  publishCandidate,
  hasPendingMigrations,
  hasProcessesUsingRoot,
  restoreCanonical,
};
