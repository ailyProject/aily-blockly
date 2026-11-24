'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cloudArtifactWorkspace } = require('./artifact-store');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

/** The saved ABI and hydrated workspace document have different byte formats.
 * Capture each independently; a missing/changed saved file grants no ABI proof. */
function captureCloudBuildAbi(root) {
  try {
    const file = path.join(root, 'project.abi'), before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 32n * 1024n * 1024n
        || key(fs.realpathSync(file)) !== key(file)) return undefined;
    const bytes = fs.readFileSync(file), after = fs.lstatSync(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size) return undefined;
    return `sha256:${hash(bytes)}`;
  } catch { return undefined; }
}

function unavailableCloudBuildSource(record, reason) {
  return { version: 1, kind: 'cloud-build-source', status: 'unavailable', project: record.root,
    buildRequestId: record.buildRequestId || record.requestId, reason };
}

function immutableFile(directory, name, content) {
  const file = path.join(directory, name);
  try { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o400 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(content)
        || key(fs.realpathSync(file)) !== key(file) || !fs.readFileSync(file).equals(Buffer.from(content))) throw error;
  }
  return file;
}

/** The broker calls this only under its verified result/reuse lease. Preserve
 * the exact submitted code, never a rolling project-layout sketch or SDK copy. */
function publishCloudBuildSource(record, directory, jobId = record.jobId) {
  const unavailable = reason => unavailableCloudBuildSource(record, reason);
  try {
    const buildRequestId = record.buildRequestId || record.requestId;
    const capture = record.config.sourceCapture;
    const code = record.config.code;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(buildRequestId || '')
        || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId || '') || !sha(record.snapshot.inputDigest)
        || typeof code !== 'string' || Buffer.byteLength(code) > 8 * 1024 * 1024) return unavailable('source-binding-unavailable');
    if (!capture || capture.schemaVersion !== 1 || capture.scope !== 'captured-build-source'
        || !['blockly', 'coder'].includes(capture.mode) || capture.sourceSha256 !== hash(code)
        || capture.projectLocationSha256 !== hash(key(record.root))) return unavailable('source-capture-unavailable');
    const { digest, ...body } = capture;
    if (digest !== hash(JSON.stringify(body))) return unavailable('source-capture-invalid');
    const workspace = capture.workspace;
    if (capture.mode === 'blockly' && (workspace?.scope !== 'serialized-blockly-document' || !sha(workspace.documentSha256)
        || !Number.isSafeInteger(workspace.revision) || workspace.revision < 0
        || !Number.isSafeInteger(workspace.runtimeRevision) || workspace.runtimeRevision < 0
        || typeof workspace.pageId !== 'string' || !workspace.pageId || workspace.pageId.length > 256)) return unavailable('workspace-capture-unavailable');
    const folder = path.basename(directory);
    const workspaceRoot = cloudArtifactWorkspace(record.root, { isolated: record.config.isolatedCloudBuild === true });
    if (!new RegExp(`^${jobId}-${uuid}$`).test(folder)
        || key(path.resolve(directory)) !== key(path.join(workspaceRoot, '.build', 'cloud', folder))) return unavailable('source-directory-invalid');
    for (const relative of ['', '.build', '.build/cloud', `.build/cloud/${folder}`]) {
      const current = path.join(workspaceRoot, relative), stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(fs.realpathSync(current)) !== key(current)) return unavailable('source-directory-invalid');
    }
    const sourceName = `aily-cloud-source-${capture.sourceSha256}.ino`;
    const metadataName = `aily-cloud-source-${hash(buildRequestId)}.json`;
    const metadata = { version: 1, kind: 'cloud-build-source', status: 'available', project: record.root, buildRequestId,
      cloudRequestId: record.requestId, jobId, inputDigest: record.snapshot.inputDigest,
      sourceSha256: capture.sourceSha256, bytes: Buffer.byteLength(code), source: sourceName, sourceCapture: capture,
      ...(record.sourceAbiHash && captureCloudBuildAbi(record.root) === record.sourceAbiHash ? { abiHash: record.sourceAbiHash } : {}) };
    immutableFile(directory, sourceName, code);
    immutableFile(directory, metadataName, JSON.stringify(metadata));
    const { source, sourceCapture, ...reference } = metadata;
    return { ...reference,
      path: path.join(directory, sourceName), metadataPath: path.join(directory, metadataName) };
  } catch {
    // A missing diagnostic source must not disguise a real compiler result.
    return unavailable('source-publication-unavailable');
  }
}

module.exports = { captureCloudBuildAbi, publishCloudBuildSource, unavailableCloudBuildSource };
