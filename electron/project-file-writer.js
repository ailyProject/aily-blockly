const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_PROJECT_FILE_BYTES: MAX_BYTES, projectFileHash: hash, projectFileFault: fault,
  projectFileGuard, createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration } = require('./project-file-access');

const FILES = new Set(['project.abi', 'project.abs', 'project.abs.map.json']);
const PROJECT_FILE_PUBLICATION_VERSION = 2;

/**
 * Preload-owned single-file commit. All cooperating processes use the same project lock.
 * The final guard/CAS/rename is synchronous on the renderer's event loop: no context-change
 * await gap. Bulk temporary-file I/O is async. This is NOT a multi-file transaction or
 * protection from arbitrary external writers. Abandoned locks are never auto-stolen.
 */
async function replaceProjectText(request, assertCurrent, options = {}) {
  const files = options.files || fs;
  const { projectPath, fileName, expectedHash, content, backup } = request || {};
  const timeoutMs = options.timeoutMs ?? 5000;
  let temporary;
  let temporaryOwned = false;
  let backupTemporary;
  let backupHash;
  let renameAttempted = false;
  let read;
  let assertRoot;
  let bytes;
  let result;
  const warnings = [];
  const guard = projectFileGuard(assertCurrent);
  try {
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath) || !FILES.has(fileName)
      || typeof content !== 'string' || !(expectedHash === null || /^sha256:[a-f0-9]{64}$/.test(expectedHash))
      || (backup !== undefined && (backup !== 'project-data' || fileName !== 'project.abi' || expectedHash === null))
      || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw fault('PROJECT_FILE_INVALID', 'Expected an absolute project path, a supported mirror name and an exact byte hash.');
    }
    bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_BYTES) throw fault('PROJECT_FILE_TOO_LARGE', 'Project mirror exceeds the 128 MiB publication limit.');
    guard();
    const root = await files.promises.realpath(projectPath);
    guard();
    const access = createProjectFileAccess(root, projectPath, files);
    const { checkRoot, checkDirectory, readRegular } = access;
    const target = path.join(root, fileName);
    const lockDirectory = path.join(root, '.aily');
    assertRoot = checkRoot;
    read = () => readRegular(target);
    checkRoot();
    // Refuse known conflicts before creating any temporary file or lock directory.
    const original = read();
    if (hash(original) !== expectedHash) return { status: 'CONFLICT', error: 'Project file changed; external content was retained.' };
    if (!original?.equals(bytes)) {
      temporary = path.join(root, `.${fileName}.${randomUUID()}.tmp`);
      const handle = await files.promises.open(temporary, 'wx', 0o600);
      temporaryOwned = true;
      try {
        guard();
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
    }
    if (backup) {
      guard();
      checkRoot();
      const backupPath = path.join(root, `.project-data-backup.${randomUUID()}.tmp`);
      const backupHandle = await files.promises.open(backupPath, 'wx', 0o600);
      backupTemporary = backupPath;
      try {
        guard();
        await backupHandle.writeFile(original);
        await backupHandle.sync();
      } finally { await backupHandle.close(); }
    }
    guard();
    checkRoot();
    const lock = await acquireProjectFileLock(access, guard, timeoutMs);
    try {
      // No awaits from the guard through the final byte check and rename.
      guard();
      lock.assertOwned();
      assertNoPendingAbsGeneration(access);
      const previous = read();
      if (hash(previous) !== expectedHash) result = { status: 'CONFLICT', error: 'Project file changed before commit; external content was retained.' };
      else {
        if (backup) {
          const directory = path.join(lockDirectory, 'project-data-backups');
          try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          checkDirectory(directory);
          const backupPath = path.join(directory, `${expectedHash.slice(7)}.abi`);
          // Publish a fully flushed original without ever replacing an existing backup.
          // Hard-link then remove our temporary name; a crash can leave a recoverable
          // extra link, never a partially written file masquerading as a valid backup.
          try { files.linkSync(backupTemporary, backupPath); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
          files.unlinkSync(backupTemporary);
          backupTemporary = undefined;
          if (!readRegular(backupPath)?.equals(previous)) throw fault('PROJECT_FILE_BACKUP_CONFLICT', 'Project Data backup is not the expected original; retained all files.');
          backupHash = expectedHash;
          guard();
          if (hash(read()) !== expectedHash) throw fault('PROJECT_FILE_CONFLICT', 'Project file changed while preparing its backup; external content was retained.');
        }
        if (!previous?.equals(bytes)) {
          renameAttempted = true;
          files.renameSync(temporary, target);
          temporaryOwned = false;
        }
        if (!read()?.equals(bytes)) throw fault('PROJECT_FILE_COMMIT_UNCERTAIN', 'Project file changed during publication.');
        result = { status: 'COMMITTED', hash: hash(bytes) };
      }
    } finally {
      warnings.push(...lock.release());
    }
  } catch (error) {
    if (renameAttempted) {
      try {
        const actual = read();
        result = actual?.equals(bytes) ? { status: 'COMMITTED', hash: hash(bytes) }
          : hash(actual) === expectedHash ? { status: 'NOT_COMMITTED', code: error.code, error: error.message }
          : { status: 'UNKNOWN', code: 'PROJECT_FILE_COMMIT_UNCERTAIN', error: error.message };
      } catch (inspectionError) {
        result = { status: 'UNKNOWN', code: 'PROJECT_FILE_COMMIT_UNCERTAIN', error: inspectionError.message };
      }
    } else result = { status: 'NOT_COMMITTED', code: error.code || 'PROJECT_FILE_WRITE_FAILED', error: error.message };
  } finally {
    if (temporaryOwned) {
      try { assertRoot(); await files.promises.unlink(temporary); }
      catch (error) { if (error.code !== 'ENOENT') warnings.push(error.message); }
    }
    if (backupTemporary) {
      try { assertRoot(); await files.promises.unlink(backupTemporary); }
      catch (error) { if (error.code !== 'ENOENT') warnings.push(error.message); }
    }
  }
  return { ...result, ...(backupHash ? { backupHash } : {}), ...(warnings.length ? { warnings } : {}) };
}

module.exports = { replaceProjectText, PROJECT_FILE_PUBLICATION_VERSION };
