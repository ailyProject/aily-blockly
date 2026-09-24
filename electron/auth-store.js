const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function readRecord(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

function writeRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function credentials(record) {
  return {
    ...(typeof record.access_token === 'string' && record.access_token.trim()
      ? { access_token: record.access_token } : {}),
    ...(typeof record.refresh_token === 'string' && record.refresh_token.trim()
      ? { refresh_token: record.refresh_token } : {}),
    ...(typeof record.updated_at === 'string' ? { updated_at: record.updated_at } : {}),
  };
}

// All operations, including first-run migration, run under the host's cross-process lock.
function createAuthStore(appDataPath, withLock) {
  const filePath = path.join(appDataPath, '.aily');
  const migrationPath = path.join(appDataPath, 'auth', 'shared-migration.json');

  function initialize() {
    if (fs.existsSync(migrationPath)) return;
    const current = readRecord(filePath);
    const blocklyPath = path.join(appDataPath, 'auth', 'blockly.json');
    // Early split-store versions left .aily behind when Blockly signed out.
    const blocklySignedOut = fs.existsSync(path.join(appDataPath, 'auth', 'blockly-migration.json'))
      && !fs.existsSync(blocklyPath);
    const candidates = [
      blocklySignedOut ? {} : credentials(current),
      credentials(readRecord(blocklyPath)),
      credentials(readRecord(path.join(appDataPath, 'auth', 'coder.json'))),
    ].filter(record => record.access_token);
    candidates.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
    if (candidates.length) {
      const latest = candidates[0];
      writeRecord(filePath, { ...current, ...latest, refresh_token: latest.refresh_token, updated_at: latest.updated_at });
    } else if (blocklySignedOut) {
      fs.rmSync(filePath, { force: true });
    }
    // Keep the old files, but never import them again after a shared logout.
    writeRecord(migrationPath, { completed: true });
  }

  return {
    read: () => withLock(() => {
      initialize();
      return credentials(readRecord(filePath));
    }),
    write: (record, expectedRefreshToken) => withLock(() => {
      initialize();
      const current = readRecord(filePath);
      if (expectedRefreshToken !== undefined && current.refresh_token !== expectedRefreshToken) return false;
      const next = { ...credentials(record), updated_at: new Date().toISOString() };
      if (!next.access_token) throw new Error('Access token cannot be empty');
      writeRecord(filePath, { ...current, ...next, refresh_token: next.refresh_token });
      return true;
    }),
    clear: expectedAccessToken => withLock(() => {
      initialize();
      if (expectedAccessToken !== undefined) {
        const currentToken = credentials(readRecord(filePath)).access_token;
        if (currentToken && currentToken !== expectedAccessToken) return false;
      }
      fs.rmSync(filePath, { force: true });
      return true;
    }),
  };
}

module.exports = { createAuthStore };
