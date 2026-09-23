'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const project = require('./aily-code-project');
const { confirmLibraryProjections } = require('./library-source-evidence');
const { confirmBuildSource, sourceManifest } = require('./build-source-capture');
const { readBuildInputContextBinding } = require('./build-input-context');
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

/** Called before preprocessing too, so early failures cannot leave an old success ticket. */
function invalidateBuildDelivery(root) {
    const outputs = buildOutputs(root);
    for (const filename of [outputs.artifact, outputs.delivery, path.join(outputs.directory, 'aily-library-projections.json'), path.join(outputs.directory, 'aily-build-input-context.json')]) {
        try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

// This intentionally records a source boundary, NOT complete/hermetic build inputs.
// npm library origins, tools, SDK response files and cache provenance remain outside it.
function captureProjectSources(config) {
    const root = fs.realpathSync(config.currentProjectPath);
    const coder = project.isAilyCodeProjectRoot(root);
    const records = [], states = [];
    let bytes = 0;
    const excluded = relative => ['.git', '.temp', '.build', 'node_modules', '.aily/build'].some(name => relative === name || relative.startsWith(name + '/'))
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

function confirmProjectSources(before, config) {
    const after = captureProjectSources(config);
    if (before.digest !== after.digest || JSON.stringify(before.states) !== JSON.stringify(after.states)) {
        fail('Project sources/configuration changed; discard this build and retry.');
    }
}

function publishBuildDelivery(config, snapshot, compileSourcePath, expectedFqbn, librarySnapshot, buildId = randomUUID()) {
    const outputs = buildOutputs(config.currentProjectPath);
    let temporary;
    try {
        if (!/^[a-f0-9-]{36}$/.test(buildId)) fail('Invalid build owner identity.');
        confirmProjectSources(snapshot, config);
        const sourceCapture = confirmBuildSource(config);
        const libraryProjections = librarySnapshot ? confirmLibraryProjections(librarySnapshot) : undefined;
        const bytes = fs.readFileSync(outputs.artifact);
        if (bytes.length > 2 * 1024 * 1024) fail('Artifact manifest exceeds budget.');
        const artifact = JSON.parse(bytes);
        const source = fs.readFileSync(compileSourcePath);
        if (artifact.kind !== 'aily-build-artifact' || artifact.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(artifact.artifactId)
            || typeof expectedFqbn !== 'string' || artifact.target?.fqbn !== expectedFqbn
            || artifact.build?.inputs?.scope !== 'prepared-dependency-trees' || !/^[a-f0-9]{64}$/.test(artifact.build.inputs.digest)
            || artifact.build?.source?.sha256 !== snapshot.body.sourceSha256 || hash(source) !== snapshot.body.sourceSha256
            || artifact.build.source.sizeBytes !== source.length) fail('Artifact does not match this source/prepared-input build.');
        const receipt = { schemaVersion: 1, kind: 'aily-build-delivery', buildId, completedAt: new Date().toISOString(),
            artifactId: artifact.artifactId, manifestSha256: hash(bytes), preparedInputsDigest: artifact.build.inputs.digest,
            project: { scope: snapshot.body.scope, mode: snapshot.body.mode, locationSha256: snapshot.body.projectLocationSha256,
                boardModule: snapshot.body.boardModule, fqbn: expectedFqbn, digest: snapshot.digest, sourceSha256: snapshot.body.sourceSha256,
                fileCount: snapshot.fileCount, sizeBytes: snapshot.sizeBytes },
            ...(libraryProjections ? { libraryProjections } : {}), ...(sourceCapture ? { sourceCapture } : {}), currentProjectAcceptance: false };
        temporary = `${outputs.delivery}.${receipt.buildId}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { flag: 'wx' });
        confirmProjectSources(snapshot, config);
        confirmBuildSource(config);
        if (librarySnapshot) confirmLibraryProjections(librarySnapshot);
        if (hash(fs.readFileSync(outputs.artifact)) !== receipt.manifestSha256) fail('Artifact changed before delivery.');
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
    const inputContextSha256 = readBuildInputContextBinding(config.currentProjectPath, receipt.preparedInputsDigest);
    if (typeof process.send !== 'function') return;
    const message = { type: 'aily.build.delivery', requestDigest: hash(JSON.stringify(config)),
        buildId: receipt.buildId, inputContextSha256, receiptSha256: hash(fs.readFileSync(buildOutputs(config.currentProjectPath).delivery)) };
    await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

module.exports = { captureProjectSources, confirmProjectSources, invalidateBuildDelivery, publishBuildDelivery, reportBuildDelivery };
