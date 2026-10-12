'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const project = require('./aily-code-project');
const { confirmLibraryProjections } = require('./library-source-evidence');
const { confirmBuildSource, sourceManifest } = require('./build-source-capture');
const { readBuildInputRecordBinding } = require('./build-input-record');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`PROJECT_INPUTS_CHANGED: ${message}`); };
const state = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const canonical = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;

function buildOutputs(root) {
    const realRoot = fs.realpathSync(root);
    const directory = path.join(realRoot, '.build');
    if (fs.existsSync(directory) && fs.realpathSync(directory) !== directory) fail('Build directory traverses a link.');
    return { directory, artifact: path.join(directory, 'aily-artifact-manifest.json'), delivery: path.join(directory, 'aily-build-delivery.json') };
}

function removeBuildDeliveryTicket(outputs) {
    for (const filename of [outputs.delivery, path.join(outputs.directory, 'aily-library-projections.json')]) {
        try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

/** Preprocessing revokes current-project delivery authority, not a portable
 * Artifact from the last successful compile. Its files still require hashes
 * to match at import; preserving the manifest does not grant acceptance.
 */
function invalidateBuildDeliveryTicket(root) {
    removeBuildDeliveryTicket(buildOutputs(root));
}

/** Compile/source publication still invalidate the previous Artifact too. */
function invalidateBuildDelivery(root) {
    const outputs = buildOutputs(root);
    try { fs.unlinkSync(outputs.artifact); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    removeBuildDeliveryTicket(outputs);
}

// This intentionally records a source boundary, NOT complete/hermetic build inputs.
// npm library origins, tools, SDK response files and cache provenance remain outside it.
function captureProjectSources(config) {
    const root = fs.realpathSync(config.currentProjectPath);
    const coder = project.isAilyCodeProjectRoot(root);
    const records = [], states = [];
    let bytes = 0;
    // Product-owned logs and history objects change while Agent/build work runs;
    // they are derived metadata, not compiler sources. All other project paths
    // remain guarded, including arbitrary root headers and Coder local libraries.
    const excluded = relative => ['.git', '.temp', '.build', '.log', '.workspace-history', 'node_modules', '.aily/build'].some(name => relative === name || relative.startsWith(name + '/'))
        || (coder && /^sketch\/(?:preprocess\.json|target-compile\.json|library-cache\.json|compile-preprocess-[^/]+\.json)$/.test(relative));
    const visit = (filename, relative, depth = 0, exclusions = true) => {
        if (exclusions && excluded(relative)) return;
        if (depth > 64) fail('Source tree exceeds depth limit.');
        const before = fs.lstatSync(filename);
        if (before.isSymbolicLink()) fail(`Implicit source link refused: ${relative}`);
        if (before.isDirectory()) {
            for (const name of fs.readdirSync(filename).sort()) visit(path.join(filename, name), relative ? `${relative}/${name}` : name, depth + 1, exclusions);
            return;
        }
        if (!before.isFile() || relative.length > 512) fail('Unsupported source entry.');
        if (records.length >= 4096 || (bytes += before.size) > 256 * 1024 * 1024) fail('Source capture exceeds file/byte budget.');
        const raw = fs.readFileSync(filename), after = fs.statSync(filename);
        if (state(before) !== state(after)) fail('Source changed while capturing.');
        // Build result metadata is not a source edit. Keep the same normalization
        // as the lightweight capture so post-build publication cannot stale itself.
        const contents = relative === 'package.json' ? Buffer.from(sourceManifest(raw)) : raw;
        records.push({ path: relative, sizeBytes: contents.length, sha256: hash(contents) });
        // Result publication may run while a consumer awaits the live editor.
        // Compare the manifest's semantic source state, not its result-only mtime.
        states.push(`${relative}:${relative === 'package.json' ? hash(contents) : state(after)}`);
    };
    visit(root, '');
    if (typeof config.boardModule !== 'string' || !/^@[^/\\]+\/[^/\\]+$/.test(config.boardModule) || config.boardModule.includes('..')) fail('Invalid board package name.');
    const boardRoot = fs.realpathSync(path.join(root, 'node_modules', config.boardModule));
    // Explicit board aliases are allowed, but their real identity is part of the record.
    for (const name of ['board.json', 'package.json']) visit(path.join(boardRoot, name), `board/${name}`, 0, false);
    if (config.partitionFilePath && fs.existsSync(config.partitionFilePath)) {
        visit(config.partitionFilePath, 'configured-partition', 0, false);
    }
    const body = { schemaVersion: 1, scope: 'project-source-boundary', mode: coder ? 'coder' : 'blockly',
        projectLocationSha256: hash(canonical(root)), boardLocationSha256: hash(canonical(boardRoot)),
        boardModule: config.boardModule, sourceSha256: hash(Buffer.from(config.code)), files: records };
    return { digest: hash(JSON.stringify(body)), states, body, fileCount: records.length, sizeBytes: bytes };
}

function projectInputDifferences(before, after, phase) {
    const { files: previousFiles, ...previousBody } = before.body;
    const { files: currentFiles, ...currentBody } = after.body;
    const rows = snapshot => new Map(snapshot.body.files.map((file, index) =>
        [file.path, { file, state: snapshot.states[index] }]));
    const previous = rows(before), current = rows(after), differences = [];
    let count = 0;
    for (const relative of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
        const a = previous.get(relative), b = current.get(relative);
        const change = !a ? 'added' : !b ? 'removed'
            : a.file.sha256 !== b.file.sha256 || a.file.sizeBytes !== b.file.sizeBytes ? 'content'
            : a.state !== b.state ? 'stat' : null;
        if (!change) continue;
        count++;
        if (differences.length < 12) {
            const safe = typeof relative === 'string' && relative.length <= 512
                && !path.posix.isAbsolute(relative) && !/^[a-z]:/i.test(relative)
                && !/[\\\u0000-\u001f\u007f]/.test(relative)
                && !relative.split('/').some(segment => segment === '..');
            differences.push({ path: safe ? relative : '[unreportable-relative-path]', change });
        }
    }
    return { schemaVersion: 1, kind: 'aily-project-input-differences',
        phase: ['before-target-compile', 'before-delivery', 'after-delivery'].includes(phase) ? phase : 'unspecified',
        bodyChanged: JSON.stringify(previousBody) !== JSON.stringify(currentBody),
        differences, totalCount: count, truncatedCount: count - differences.length };
}

function confirmProjectSources(before, config, phase = 'unspecified') {
    const after = captureProjectSources(config);
    if (before.digest !== after.digest || JSON.stringify(before.states) !== JSON.stringify(after.states)) {
        const error = new Error('PROJECT_INPUTS_CHANGED: Project sources/configuration changed; discard this build and retry.');
        error.code = 'PROJECT_INPUTS_CHANGED';
        // Private failure facts only. The normal compile entry persists them in
        // its excluded build directory; they never alter the user error text.
        Object.defineProperties(error, {
            projectInputDifferences: { value: projectInputDifferences(before, after, phase) },
            projectInputDiagnosticRoot: { value: fs.realpathSync(config.currentProjectPath) },
        });
        throw error;
    }
}

function captureCompilerEntry(root, sourcePath) {
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) fail('Compiler entry must be an absolute source path.');
    const realRoot = fs.realpathSync(root), filename = path.resolve(sourcePath);
    const relative = path.relative(realRoot, filename).split(path.sep).join('/');
    if (!relative || relative.length > 512 || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
        fail('Compiler entry escapes the project boundary.');
    }
    let checked = realRoot;
    for (const segment of relative.split('/')) {
        checked = path.join(checked, segment);
        if (fs.lstatSync(checked).isSymbolicLink()) fail('Compiler entry traverses an implicit link.');
    }
    const before = fs.statSync(filename);
    if (!before.isFile() || before.size > 128 * 1024 * 1024) fail('Compiler entry exceeds the source boundary.');
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== before.size || state(before) !== state(fs.statSync(filename))) fail('Compiler entry changed while capturing.');
    return { scope: 'project-compiler-entry', path: relative, sizeBytes: bytes.length, sha256: hash(bytes) };
}

function publishBuildDelivery(config, snapshot, compileSourcePath, expectedFqbn, librarySnapshot, buildId = randomUUID()) {
    const outputs = buildOutputs(config.currentProjectPath);
    let temporary;
    try {
        if (!/^[a-f0-9-]{36}$/.test(buildId)) fail('Invalid build owner identity.');
        confirmProjectSources(snapshot, config, 'before-delivery');
        const sourceCapture = confirmBuildSource(config);
        const libraryProjections = librarySnapshot ? confirmLibraryProjections(librarySnapshot) : undefined;
        const bytes = fs.readFileSync(outputs.artifact);
        if (bytes.length > 2 * 1024 * 1024) fail('Artifact manifest exceeds budget.');
        const artifact = JSON.parse(bytes);
        const executionSource = captureCompilerEntry(config.currentProjectPath, compileSourcePath);
        if (artifact.kind !== 'aily-build-artifact' || artifact.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(artifact.artifactId)
            || typeof expectedFqbn !== 'string' || artifact.target?.fqbn !== expectedFqbn
            || artifact.build?.inputs?.scope !== 'build-graph-facts' || !/^[a-f0-9]{64}$/.test(artifact.build.inputs.digest)
            || artifact.build?.source?.sha256 !== snapshot.body.sourceSha256 || executionSource.sha256 !== snapshot.body.sourceSha256
            || artifact.build.source.sizeBytes !== executionSource.sizeBytes) fail('Artifact does not match this source/build-graph build.');
        readBuildInputRecordBinding(config.currentProjectPath, artifact.build.inputs);
        const receipt = { schemaVersion: 1, kind: 'aily-build-delivery', buildId, completedAt: new Date().toISOString(),
            artifactId: artifact.artifactId, manifestSha256: hash(bytes), buildInputsDigest: artifact.build.inputs.digest,
            project: { scope: snapshot.body.scope, mode: snapshot.body.mode, locationSha256: snapshot.body.projectLocationSha256,
                boardModule: snapshot.body.boardModule, fqbn: expectedFqbn, digest: snapshot.digest, sourceSha256: snapshot.body.sourceSha256,
                fileCount: snapshot.fileCount, sizeBytes: snapshot.sizeBytes },
            executionSource,
            ...(libraryProjections ? { libraryProjections } : {}), ...(sourceCapture ? { sourceCapture } : {}), currentProjectAcceptance: false };
        temporary = `${outputs.delivery}.${receipt.buildId}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { flag: 'wx' });
        confirmProjectSources(snapshot, config, 'after-delivery');
        confirmBuildSource(config);
        if (librarySnapshot) confirmLibraryProjections(librarySnapshot);
        if (hash(fs.readFileSync(outputs.artifact)) !== receipt.manifestSha256) fail('Artifact changed before delivery.');
        if (JSON.stringify(captureCompilerEntry(config.currentProjectPath, compileSourcePath)) !== JSON.stringify(executionSource)) {
            fail('Compiler entry changed before delivery.');
        }
        fs.renameSync(temporary, outputs.delivery);
        return receipt;
    } catch (error) {
        invalidateBuildDelivery(config.currentProjectPath);
        throw error;
    } finally {
        if (temporary) { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
}

/** Only the directly spawned host process owns this IPC channel. Nothing is
 * printed as an authentication token or persisted as trusted authority. */
async function reportBuildDelivery(config, receipt) {
    const artifact = JSON.parse(fs.readFileSync(buildOutputs(config.currentProjectPath).artifact));
    if (artifact.build?.inputs?.digest !== receipt.buildInputsDigest) fail('Build-graph record changed before delivery report.');
    const inputRecordSha256 = readBuildInputRecordBinding(config.currentProjectPath, artifact.build.inputs);
    const receiptSha256 = hash(fs.readFileSync(buildOutputs(config.currentProjectPath).delivery));
    if (typeof process.send !== 'function') return;
    const message = { type: 'aily.build.delivery', requestDigest: hash(JSON.stringify(config)),
        buildId: receipt.buildId, inputRecordSha256, receiptSha256 };
    await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

module.exports = { captureProjectSources, confirmProjectSources, invalidateBuildDelivery, invalidateBuildDeliveryTicket, publishBuildDelivery, reportBuildDelivery };
