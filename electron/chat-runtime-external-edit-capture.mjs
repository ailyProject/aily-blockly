import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

const DEFAULT_MAX_FILE_COUNT = 5_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const EXCLUDED_DIRECTORY_NAMES = new Map([
  ['.aily', 'Aily runtime state is outside workspace restore ownership'],
  ['.chat_history', 'chat history is session state, not workspace content'],
  ['.git', 'Git metadata is outside workspace restore ownership'],
  ['.log', 'command process logs are runtime output'],
  ['node_modules', 'dependency trees are intentionally outside bounded capture'],
]);
const BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.bmp', '.bz2', '.dll', '.doc', '.docx', '.eot', '.exe',
  '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.mkv', '.mp3', '.mp4', '.ogg', '.otf',
  '.pdf', '.png', '.rar', '.so', '.tar', '.ttf', '.wav', '.webp', '.woff', '.woff2',
  '.xls', '.xlsx', '.zip',
]);

export function createWorkerExternalEditService(options) {
  return new WorkerExternalEditService(options);
}

class WorkerExternalEditService {
  constructor(options) {
    this.sessionId = normalizeId(options?.sessionId);
    this.timeline = options?.timeline;
    this.getActiveTurnId = typeof options?.getActiveTurnId === 'function'
      ? options.getActiveTurnId
      : () => undefined;
    this.getWorkspaceRoot = typeof options?.getWorkspaceRoot === 'function'
      ? options.getWorkspaceRoot
      : () => options?.workspaceRoot;
    this.maxFileCount = positiveInteger(options?.maxFileCount, DEFAULT_MAX_FILE_COUNT);
    this.maxTotalBytes = positiveInteger(options?.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
    this.maxFileBytes = positiveInteger(options?.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.operations = new Map();
  }

  async startExternalEdits(input) {
    const requestId = normalizeId(input?.requestId);
    const toolCallId = normalizeId(input?.toolCallId);
    const operationId = normalizeId(input?.operationId);
    if (!this.sessionId || !requestId || !toolCallId || !operationId) {
      throw new Error('External edit capture identity is incomplete.');
    }
    if (this.operations.has(operationId)) {
      throw new Error(`External edit operation already exists: ${operationId}`);
    }
    const activeTurnId = normalizeId(this.getActiveTurnId());
    if (activeTurnId && activeTurnId !== requestId) {
      throw new Error(`External edit turn mismatch: requested ${requestId}, active ${activeTurnId}.`);
    }

    const workspaceRoot = path.resolve(String(this.getWorkspaceRoot() || ''));
    const roots = uniqueResolvedPaths(input?.roots)
      .map(root => ({ root, insideWorkspace: isPathInside(workspaceRoot, root) }));
    const captures = [];
    const warnings = [];
    for (const candidate of roots) {
      if (!candidate.insideWorkspace) {
        captures.push({ mode: 'untracked', root: candidate.root });
        warnings.push(`${candidate.root}: outside the active workspace and not restorable`);
        continue;
      }
      captures.push(await this.captureBefore(candidate.root, warnings));
    }
    if (captures.length === 0) {
      captures.push({ mode: 'untracked', root: workspaceRoot });
      warnings.push('No declared workspace root was available; external changes are not restorable.');
    }

    this.operations.set(operationId, {
      operationId,
      requestId,
      toolCallId,
      captures,
      warnings,
    });
    return { operationId, warnings: [...warnings] };
  }

  async stopExternalEdits(input) {
    const operationId = normalizeId(input?.operationId);
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new Error(`Unknown external edit operation: ${operationId}`);
    }
    this.operations.delete(operationId);

    const warnings = [...operation.warnings];
    const changesByPath = new Map();
    for (const capture of operation.captures) {
      const result = capture.mode === 'git'
        ? await this.collectGitChanges(capture)
        : capture.mode === 'manifest'
          ? await this.collectManifestChanges(capture)
          : { changes: [], warnings: [] };
      for (const warning of result.warnings) {
        warnings.push(warning);
      }
      for (const change of result.changes) {
        changesByPath.set(changeIdentity(change), change);
      }
    }

    const changes = [...changesByPath.values()].sort((left, right) => left.filePath.localeCompare(right.filePath));
    if (changes.length > 0) {
      const transactionId = `${operation.operationId}:reconcile`;
      try {
        await this.timeline.recordMutationBatch({
          sessionId: this.sessionId,
          turnId: operation.requestId,
          toolCallId: operation.toolCallId,
          transactionId,
          status: 'committed',
          receipts: changes.map((change, sequence) => createMutationReceipt({
            sessionId: this.sessionId,
            turnId: operation.requestId,
            toolCallId: operation.toolCallId,
            transactionId,
            operationId: `${transactionId}:${sequence}`,
            sequence,
            change,
          })),
        });
      } catch (error) {
        await rollbackChanges(changes);
        throw new Error(`External edit timeline commit failed; captured files were restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      trackedChangeCount: changes.length,
      warnings: uniqueStrings(warnings),
    };
  }

  async captureBefore(root, warnings) {
    const gitRoot = await resolveGitRoot(root);
    if (gitRoot && isPathInside(gitRoot, root)) {
      try {
        const beforeCommit = await createGitCheckpoint(gitRoot);
        warnings.push(`${gitRoot}: Git-ignored files are outside the checkpoint and remain untracked`);
        return { mode: 'git', root, gitRoot, beforeCommit };
      } catch (error) {
        warnings.push(`${root}: Git snapshot unavailable (${error instanceof Error ? error.message : String(error)}); using bounded manifest capture`);
      }
    }
    const baseline = await captureManifest(root, this.captureLimits());
    warnings.push(...baseline.warnings);
    return { mode: 'manifest', root, baseline };
  }

  async collectGitChanges(capture) {
    const warnings = [];
    let afterCommit;
    try {
      afterCommit = await createGitCheckpoint(capture.gitRoot, capture.beforeCommit);
    } catch (error) {
      return {
        changes: [],
        warnings: [`${capture.root}: unable to close Git external-edit snapshot (${error instanceof Error ? error.message : String(error)})`],
      };
    }

    const entries = await readGitDiff(capture.gitRoot, capture.beforeCommit, afterCommit);
    const changes = [];
    for (const entry of entries) {
      if (entry.kind === 'rename') {
        await this.appendGitRenameChange(
          changes,
          warnings,
          capture,
          capture.beforeCommit,
          afterCommit,
          entry.oldPath,
          entry.newPath,
        );
      } else if (entry.kind === 'delete') {
        await this.appendGitChange(changes, warnings, capture, capture.beforeCommit, afterCommit, entry.path, null);
      } else if (entry.kind === 'create') {
        await this.appendGitChange(changes, warnings, capture, capture.beforeCommit, afterCommit, null, entry.path);
      } else {
        await this.appendGitChange(changes, warnings, capture, capture.beforeCommit, afterCommit, entry.path, entry.path);
      }
    }
    return { changes, warnings };
  }

  async appendGitRenameChange(
    changes,
    warnings,
    capture,
    beforeCommit,
    afterCommit,
    beforePath,
    afterPath,
  ) {
    const fromPath = path.resolve(capture.gitRoot, beforePath);
    const toPath = path.resolve(capture.gitRoot, afterPath);
    if (!isPathInside(capture.root, fromPath) || !isPathInside(capture.root, toPath)) {
      return;
    }
    const exclusion = findExcludedPath(capture.root, fromPath)
      ?? findExcludedPath(capture.root, toPath);
    if (exclusion) {
      warnings.push(`${exclusion.path}: ${exclusion.reason}; changes are not restorable`);
      return;
    }
    const before = await readGitBlob(capture.gitRoot, beforeCommit, beforePath, this.maxFileBytes);
    const after = await readGitBlob(capture.gitRoot, afterCommit, afterPath, this.maxFileBytes);
    if (before?.excludedReason || after?.excludedReason) {
      warnings.push(`${toPath}: ${before?.excludedReason ?? after?.excludedReason}; changes are not restorable`);
      return;
    }
    const contentKind = inferContentKind(toPath, after?.bytes ?? before?.bytes);
    changes.push({
      operationKind: 'rename',
      filePath: toPath,
      fromPath,
      toPath,
      beforeBytes: before?.bytes ?? null,
      afterBytes: after?.bytes ?? null,
      contentKind,
    });
  }

  async appendGitChange(changes, warnings, capture, beforeCommit, afterCommit, beforePath, afterPath) {
    const relativePath = afterPath ?? beforePath;
    const filePath = path.resolve(capture.gitRoot, relativePath);
    if (!isPathInside(capture.root, filePath)) {
      return;
    }
    const exclusion = findExcludedPath(capture.root, filePath);
    if (exclusion) {
      warnings.push(`${exclusion.path}: ${exclusion.reason}; changes are not restorable`);
      return;
    }
    const before = beforePath
      ? await readGitBlob(capture.gitRoot, beforeCommit, beforePath, this.maxFileBytes)
      : null;
    const after = afterPath
      ? await readGitBlob(capture.gitRoot, afterCommit, afterPath, this.maxFileBytes)
      : null;
    if (before?.excludedReason || after?.excludedReason) {
      warnings.push(`${filePath}: ${before?.excludedReason ?? after?.excludedReason}; changes are not restorable`);
      return;
    }
    changes.push({
      operationKind: before === null
        ? 'create'
        : after === null
          ? 'delete'
          : inferContentKind(filePath, after?.bytes ?? before?.bytes) === 'notebook'
            ? 'notebook-edit'
            : 'replace',
      filePath,
      beforeBytes: before?.bytes ?? null,
      afterBytes: after?.bytes ?? null,
      contentKind: inferContentKind(filePath, after?.bytes ?? before?.bytes),
    });
  }

  async collectManifestChanges(capture) {
    const current = await captureManifest(capture.root, this.captureLimits());
    const warnings = [...current.warnings];
    const allPaths = new Set([...capture.baseline.files.keys(), ...current.files.keys()]);
    const changes = [];
    for (const filePath of allPaths) {
      const before = capture.baseline.files.get(filePath) ?? null;
      const after = current.files.get(filePath) ?? null;
      if (buffersEqual(before?.bytes, after?.bytes)) {
        continue;
      }
      changes.push({
        operationKind: before === null
          ? 'create'
          : after === null
            ? 'delete'
            : inferContentKind(filePath, after?.bytes ?? before?.bytes) === 'notebook'
              ? 'notebook-edit'
              : 'replace',
        filePath,
        beforeBytes: before?.bytes ?? null,
        afterBytes: after?.bytes ?? null,
        contentKind: inferContentKind(filePath, after?.bytes ?? before?.bytes),
      });
    }
    return { changes, warnings };
  }

  captureLimits() {
    return {
      maxFileCount: this.maxFileCount,
      maxTotalBytes: this.maxTotalBytes,
      maxFileBytes: this.maxFileBytes,
    };
  }
}

async function captureManifest(root, limits) {
  const files = new Map();
  const warnings = [];
  let fileCount = 0;
  let totalBytes = 0;
  let exhausted = false;

  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      warnings.push(`${directory}: cannot enumerate (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`${target}: symbolic links are outside bounded capture`);
        continue;
      }
      if (entry.isDirectory()) {
        const exclusionReason = EXCLUDED_DIRECTORY_NAMES.get(entry.name);
        if (exclusionReason) {
          warnings.push(`${target}: ${exclusionReason}; changes are not restorable`);
          continue;
        }
        await visit(target);
        continue;
      }
      if (!entry.isFile()) {
        warnings.push(`${target}: non-file workspace entry is outside bounded capture`);
        continue;
      }
      if (exhausted) {
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(target);
      } catch (error) {
        warnings.push(`${target}: cannot stat (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      if (stat.size > limits.maxFileBytes) {
        warnings.push(`${target}: ${stat.size} bytes exceeds the per-file capture limit; changes are not restorable`);
        continue;
      }
      if (fileCount + 1 > limits.maxFileCount || totalBytes + stat.size > limits.maxTotalBytes) {
        exhausted = true;
        warnings.push(`${root}: bounded capture limit reached; remaining paths are not restorable`);
        continue;
      }
      try {
        const bytes = await fs.readFile(target);
        files.set(path.resolve(target), { bytes });
        fileCount += 1;
        totalBytes += bytes.byteLength;
      } catch (error) {
        warnings.push(`${target}: cannot read baseline (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  await visit(root);
  return { files, warnings: uniqueStrings(warnings), fileCount, totalBytes };
}

async function resolveGitRoot(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return path.resolve(String(stdout).trim());
  } catch {
    return null;
  }
}

async function createGitCheckpoint(gitRoot, parentCommit) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-external-edit-'));
  const indexPath = path.join(tempDir, 'checkpoint.index');
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: 'Aily Session',
    GIT_AUTHOR_EMAIL: 'session@aily.local',
    GIT_COMMITTER_NAME: 'Aily Session',
    GIT_COMMITTER_EMAIL: 'session@aily.local',
  };
  try {
    if (parentCommit) {
      await runGit(gitRoot, ['read-tree', parentCommit], env);
    } else {
      try {
        await runGit(gitRoot, ['read-tree', 'HEAD'], env);
      } catch {
        await runGit(gitRoot, ['read-tree', '--empty'], env);
      }
    }
    await runGit(gitRoot, ['add', '-A', '--', '.'], env);
    const tree = (await runGit(gitRoot, ['write-tree'], env)).trim();
    const args = ['commit-tree', tree];
    if (parentCommit) {
      args.push('-p', parentCommit);
    }
    args.push('-m', 'Aily external edit checkpoint');
    return (await runGit(gitRoot, args, env)).trim();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readGitDiff(gitRoot, beforeCommit, afterCommit) {
  const output = await runGit(gitRoot, [
    'diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', beforeCommit, afterCommit,
  ]);
  const fields = output.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      continue;
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (oldPath && newPath) {
        entries.push({ kind: 'rename', oldPath, newPath });
      }
      continue;
    }
    const relativePath = fields[index++];
    if (!relativePath) {
      continue;
    }
    entries.push({
      kind: status.startsWith('A') ? 'create' : status.startsWith('D') ? 'delete' : 'modify',
      path: relativePath,
    });
  }
  return entries;
}

async function readGitBlob(gitRoot, commit, relativePath, maxFileBytes) {
  const object = `${commit}:${relativePath.replace(/\\/g, '/')}`;
  try {
    const type = (await runGit(gitRoot, ['cat-file', '-t', object])).trim();
    if (type !== 'blob') {
      return { excludedReason: `Git object type ${type} is not a file blob` };
    }
    const size = Number((await runGit(gitRoot, ['cat-file', '-s', object])).trim());
    if (!Number.isFinite(size) || size > maxFileBytes) {
      return { excludedReason: `${size} bytes exceeds the per-file capture limit` };
    }
    const { stdout } = await execFileAsync('git', ['cat-file', 'blob', object], {
      cwd: gitRoot,
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: Math.max(GIT_MAX_BUFFER, size + 1024),
    });
    return { bytes: Buffer.from(stdout) };
  } catch (error) {
    return { excludedReason: `cannot read checkpoint blob (${error instanceof Error ? error.message : String(error)})` };
  }
}

async function runGit(cwd, args, env) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return String(stdout);
}

function createMutationReceipt(input) {
  const { change } = input;
  const beforeText = change.contentKind === 'binary' ? undefined : decodeText(change.beforeBytes);
  const afterText = change.contentKind === 'binary' ? undefined : decodeText(change.afterBytes);
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    transactionId: input.transactionId,
    operationId: input.operationId,
    sequence: input.sequence,
    operationKind: change.operationKind,
    filePath: change.filePath,
    existedBefore: change.beforeBytes !== null,
    ...(change.operationKind === 'rename'
      ? { fromPath: change.fromPath, toPath: change.toPath }
      : {}),
    contentKind: change.contentKind,
    ...(change.contentKind === 'binary'
      ? { beforeBytes: change.beforeBytes, afterBytes: change.afterBytes }
      : { beforeContent: beforeText, afterContent: afterText }),
  };
}

async function rollbackChanges(changes) {
  const failures = [];
  for (const change of [...changes].reverse()) {
    try {
      if (change.operationKind === 'rename') {
        await fs.rm(change.toPath, { force: true });
        await fs.mkdir(path.dirname(change.fromPath), { recursive: true });
        await fs.writeFile(change.fromPath, change.beforeBytes);
        continue;
      }
      if (change.beforeBytes === null) {
        await fs.rm(change.filePath, { force: true });
      } else {
        await fs.mkdir(path.dirname(change.filePath), { recursive: true });
        await fs.writeFile(change.filePath, change.beforeBytes);
      }
    } catch (error) {
      failures.push(`${change.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`External edit rollback failed: ${failures.join('; ')}`);
  }
}

function changeIdentity(change) {
  return change.operationKind === 'rename'
    ? `rename:${change.fromPath}->${change.toPath}`
    : `${change.operationKind}:${change.filePath}`;
}

function findExcludedPath(root, filePath) {
  const relative = path.relative(root, filePath);
  for (const segment of relative.split(path.sep)) {
    const reason = EXCLUDED_DIRECTORY_NAMES.get(segment);
    if (reason) {
      return { path: path.join(root, relative.split(path.sep).slice(0, relative.split(path.sep).indexOf(segment) + 1).join(path.sep)), reason };
    }
  }
  return null;
}

function inferContentKind(filePath, bytes) {
  if (path.extname(filePath).toLowerCase() === '.ipynb') {
    return 'notebook';
  }
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || bytes?.includes(0)) {
    return 'binary';
  }
  if (bytes) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return 'binary';
    }
  }
  return 'text';
}

function decodeText(bytes) {
  return bytes === null ? null : Buffer.from(bytes ?? []).toString('utf8');
}

function buffersEqual(left, right) {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return Buffer.from(left).equals(Buffer.from(right));
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uniqueResolvedPaths(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => normalizeId(value))
    .filter(Boolean)
    .map(value => path.resolve(value)))];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
