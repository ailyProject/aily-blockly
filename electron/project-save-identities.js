const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => new Error('Settled save identity storage is unavailable or invalid.');

/** The per-project journal keeps the result. This private index only keeps
 * consumed IDs from acquiring a writer when that journal cannot be found. */
function createProjectSaveIdentities(appDataPath) {
  const root = appDataPath ? path.resolve(appDataPath, 'settled-save-identities') : null;

  function directory(dir, create) {
    if (create) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    let stat;
    try { stat = fs.lstatSync(dir); } catch (error) {
      if (!create && error.code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    return true;
  }

  function locate(requestId, create = false) {
    if (!root || typeof requestId !== 'string' || !/^pub2-[a-f0-9-]{36}$/.test(requestId)) throw unavailable();
    if (!directory(root, create)) return null;
    const key = digest(requestId);
    const shard = path.join(root, key.slice(0, 2));
    return directory(shard, create) ? path.join(shard, key.slice(2)) : null;
  }

  function read(file) {
    if (!file) return null;
    let before;
    try { before = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== 64) throw unavailable();
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw unavailable();
      const bytes = Buffer.alloc(64);
      if (fs.readSync(descriptor, bytes) !== bytes.length) throw unavailable();
      const value = bytes.toString('utf8');
      if (!/^[a-f0-9]{64}$/.test(value)) throw unavailable();
      return value;
    } finally { fs.closeSync(descriptor); }
  }

  function bindingDigest(binding) {
    if (typeof binding !== 'string' || !binding || binding.length > 64 * 1024) throw unavailable();
    return digest(binding);
  }

  return {
    inspect(requestId, binding) {
      const expected = bindingDigest(binding);
      const retained = read(locate(requestId));
      return retained === null ? 'missing' : retained === expected ? 'matching' : 'different';
    },
    remember(requestId, binding) {
      const expected = bindingDigest(binding);
      const file = locate(requestId, true);
      const retained = read(file);
      if (retained === expected) return;
      if (retained !== null) throw unavailable();
      const temporary = file + '.' + randomUUID() + '.tmp';
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        try { fs.writeFileSync(descriptor, expected); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        // A link publishes complete bytes only if the original ID is unclaimed.
        try { fs.linkSync(temporary, file); }
        catch (error) { if (error.code !== 'EEXIST' || read(file) !== expected) throw error; }
      } finally { fs.unlinkSync(temporary); }
    },
  };
}

module.exports = { createProjectSaveIdentities };
