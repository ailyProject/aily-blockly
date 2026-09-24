const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { normalizeBuildProduct } = require('./build-product');

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
function createAuthStore(appDataPath, product, withLock) {
  const id = normalizeBuildProduct(product);
  const filePath = path.join(appDataPath, 'auth', `${id}.json`);
  const migrationPath = path.join(appDataPath, 'auth', 'blockly-migration.json');
  const legacyPath = path.join(appDataPath, '.aily');

  function initialize() {
    if (id !== 'blockly' || fs.existsSync(migrationPath)) return;
    if (!fs.existsSync(filePath)) {
      const legacy = credentials(readRecord(legacyPath));
      if (legacy.access_token) writeRecord(filePath, legacy);
    }
    // Keep this marker when credentials are cleared; never resurrect legacy login.
    writeRecord(migrationPath, { completed: true });
  }

  function syncLegacy(record) {
    if (id !== 'blockly') return;
    if (!record.access_token) {
      fs.rmSync(legacyPath, { force: true });
      return;
    }
    const legacy = readRecord(legacyPath);
    if (['access_token', 'refresh_token', 'updated_at'].every(key => legacy[key] === record[key])) return;
    writeRecord(legacyPath, {
      ...legacy,
      access_token: record.access_token,
      refresh_token: record.refresh_token,
      updated_at: record.updated_at,
    });
  }

  return {
    restoreLegacy: () => withLock(() => {
      if (id !== 'blockly') return;
      initialize();
      syncLegacy(credentials(readRecord(filePath)));
    }),
    read: () => withLock(() => {
      initialize();
      const record = credentials(readRecord(filePath));
      if (record.access_token) {
        try {
          syncLegacy(record);
        } catch (error) {
          console.warn('[Auth] Failed to sync .aily compatibility file:', error?.code || 'UNKNOWN');
        }
      }
      return record;
    }),
    write: (record, expectedRefreshToken) => withLock(() => {
      initialize();
      const current = readRecord(filePath);
      if (expectedRefreshToken !== undefined && current.refresh_token !== expectedRefreshToken) return false;
      const next = { ...credentials(record), updated_at: new Date().toISOString() };
      if (!next.access_token) throw new Error('Access token cannot be empty');
      // Keep rotated refresh tokens authoritative even if the compatibility write fails.
      writeRecord(filePath, next);
      syncLegacy(next);
      return true;
    }),
    clear: () => withLock(() => {
      initialize();
      try {
        fs.rmSync(filePath, { force: true });
      } finally {
        syncLegacy({});
      }
    }),
  };
}

module.exports = { createAuthStore };
