'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const fault = message => Object.assign(new Error(`BUILD_DELIVERY_UNVERIFIED: ${message}`), { code: 'BUILD_DELIVERY_UNVERIFIED' });
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

function readJson(filename, limit) {
    if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > limit) throw fault('Unsafe or oversized input.');
    const bytes = fs.readFileSync(filename);
    if (bytes.length > limit) throw fault('Input exceeds budget.');
    return { value: JSON.parse(bytes), digest: hash(bytes) };
}

/** Ephemeral first-party provenance. Disk receipts alone can never enter this
 * registry. This proves an observed build/source boundary, not all SDK inputs,
 * Agent authorization, a sandbox against local code, or physical correctness.
 */
function createBuildDeliveryAuthority({ getOwner, querySource, childRoot }) {
    const { readBuildInputContextBinding } = require(path.join(childRoot, 'scripts/build-input-context.js'));
    const captures = require(path.join(childRoot, 'scripts/build-source-capture.js'));
    const sources = require(path.join(childRoot, 'scripts/compile-delivery.js'));
    const records = new Map();
    const epoch = randomUUID();
    function ownerFor(sender) {
        const owner = getOwner();
        if (!owner || owner.sender !== sender || sender.isDestroyed() || !Number.isSafeInteger(owner.generation) || owner.generation <= 0) {
            throw fault('Current main renderer is unavailable.');
        }
        return owner;
    }
    function assertOwner(entry) {
        if (ownerFor(entry.sender).generation !== entry.generation || records.get(entry.key) !== entry) throw fault('Owner/build generation changed.');
    }
    async function live(entry) {
        assertOwner(entry);
        const result = await querySource(entry.root);
        assertOwner(entry);
        const state = result?.source;
        if (result?.ok !== true || !state || key(fs.realpathSync(state.projectPath)) !== entry.key
            || state.mode !== entry.config.sourceCapture.mode || typeof state.activationId !== 'string'
            || !/^[a-f0-9-]{36}$/.test(state.activationId) || state.boardModule !== entry.config.boardModule) {
            throw fault('Active project/editor source is unavailable or changed.');
        }
        if (state.mode === 'blockly') {
            if (!['scope', 'documentSha256', 'revision', 'runtimeRevision', 'pageId'].every(name =>
                state.workspace?.[name] === entry.config.sourceCapture.workspace?.[name])) throw fault('Blockly workspace/runtime changed.');
        } else if (state.saved !== true) throw fault('Coder has unsaved files or its editor is not ready.');
        if (entry.activationId && entry.activationId !== state.activationId) throw fault('Project was switched or reloaded.');
        return state.activationId;
    }
    function files(entry) {
        const directory = path.join(entry.root, '.build');
        if (key(fs.realpathSync(directory)) !== key(directory)) throw fault('Build directory was redirected.');
        return { receipt: readJson(path.join(directory, 'aily-build-delivery.json'), 16384),
            artifact: readJson(path.join(directory, 'aily-artifact-manifest.json'), 2 * 1024 * 1024) };
    }
    function bindReceipt(entry, message) {
        assertOwner(entry);
        if (entry.state !== 'running' || entry.receipt || message?.type !== 'aily.build.delivery'
            || message.requestDigest !== entry.requestDigest || typeof message.buildId !== 'string'
            || !/^[a-f0-9-]{36}$/.test(message.buildId)) throw fault('Unexpected build receipt message.');
        const { receipt, artifact } = files(entry), value = receipt.value;
        if (receipt.digest !== message.receiptSha256 || value?.kind !== 'aily-build-delivery' || value.schemaVersion !== 1
            || value.buildId !== message.buildId || value.currentProjectAcceptance !== false
            || value.manifestSha256 !== artifact.digest || value.artifactId !== artifact.value.artifactId
            || artifact.value.kind !== 'aily-build-artifact' || artifact.value.schemaVersion !== 1
            || value.preparedInputsDigest !== artifact.value.build?.inputs?.digest
            || value.project?.digest !== sources.captureProjectSources(entry.config).digest
            || value.project?.sourceSha256 !== entry.config.sourceCapture.sourceSha256
            || value.project?.fqbn !== artifact.value.target?.fqbn
            || JSON.stringify(value.sourceCapture) !== JSON.stringify(entry.config.sourceCapture)) throw fault('Receipt does not belong to this request/process.');
        captures.confirmBuildSource(entry.config);
        if (typeof message.inputContextSha256 !== 'string'
            || readBuildInputContextBinding(entry.root, value.preparedInputsDigest) !== message.inputContextSha256) throw fault('Input context does not match the actual build report.');
        entry.inputContextSha256 = message.inputContextSha256;
        entry.receipt = receipt; entry.manifestDigest = artifact.digest;
    }
    function invalidate(projectPath) {
        if (!projectPath) return;
        try { records.delete(key(fs.realpathSync(projectPath))); } catch { /* No live project record. */ }
    }
    const api = {
        invalidate,
        async begin(sender, options) {
            const owner = ownerFor(sender);
            const root = fs.realpathSync(options.buildWorkspace), requestPath = options.buildDeliveryRequest;
            if (options.shellProfile !== false || options.args?.length !== 2 || options.args[1] !== requestPath
                || options.appDataResourceMode === 'write' || !options.appDataResourceToken
                || !['node', process.execPath].includes(options.command)
                || key(fs.realpathSync(options.args[0])) !== key(fs.realpathSync(path.join(childRoot, 'scripts/compile.js')))
                || !/^compile-request-[a-f0-9-]{36}\.json$/.test(path.basename(requestPath))
                || key(fs.realpathSync(path.dirname(requestPath))) !== key(path.join(root, '.temp'))) throw fault('Not a supervised host compile request.');
            const config = readJson(requestPath, 160 * 1024 * 1024).value;
            if (key(fs.realpathSync(config.currentProjectPath)) !== key(root) || config.recordProjectDelivery !== true
                || !config.sourceCapture) throw fault('Full delivery recording/source capture is required.');
            captures.confirmBuildSource(config);
            if (config.sourceCapture.mode === 'blockly' && !config.sourceCapture.workspace) throw fault('Blockly source capture is missing.');
            if (records.size >= 32) {
                const older = [...records.values()].find(item => item.state !== 'running');
                if (!older) throw fault('Too many pending delivery records.');
                records.delete(older.key);
            }
            const entry = { key: key(root), root, sender, generation: owner.generation, config,
                requestDigest: hash(JSON.stringify(config)), handle: `${epoch}:${randomUUID()}`, state: 'running' };
            records.set(entry.key, entry);
            try { entry.activationId = await live(entry); }
            catch (error) { if (records.get(entry.key) === entry) records.delete(entry.key); throw error; }
            return {
                handle: entry.handle,
                onMessage(message) {
                    try { bindReceipt(entry, message); }
                    catch (error) { entry.state = 'failed'; entry.error = error.message; }
                },
                onExit(code, signal, cancelled) {
                    entry.state = code === 0 && !signal && !cancelled && entry.receipt && entry.state === 'running' ? 'completed' : 'failed';
                },
                abandon() { if (records.get(entry.key) === entry) records.delete(entry.key); },
            };
        },
        async query(sender, { projectPath, handle } = {}) {
            ownerFor(sender);
            const entry = records.get(key(fs.realpathSync(projectPath)));
            if (!entry || entry.sender !== sender || (handle !== undefined && handle !== entry.handle)) throw fault('No matching build in this host lifetime.');
            assertOwner(entry);
            if (entry.state !== 'completed') return { status: entry.state, currentProjectAcceptance: false, message: entry.error };
            try {
                const before = sources.captureProjectSources(entry.config);
                if (before.digest !== entry.receipt.value.project.digest) throw fault('Project source/configuration changed.');
                await live(entry);
                captures.confirmBuildSource(entry.config);
                sources.confirmProjectSources(before, entry.config);
                const current = files(entry);
                if (current.receipt.digest !== entry.receipt.digest || current.artifact.digest !== entry.manifestDigest) throw fault('Delivery files changed.');
                if (readBuildInputContextBinding(entry.root, entry.receipt.value.preparedInputsDigest) !== entry.inputContextSha256) throw fault('Input context changed.');
                return { status: 'source-current', authority: 'host-observed-build', handle: entry.handle,
                    buildId: entry.receipt.value.buildId, receiptSha256: entry.receipt.digest,
                    manifestSha256: entry.manifestDigest, sourceCaptureDigest: entry.config.sourceCapture.digest,
                    scope: 'captured-source-and-project-boundary', currentProjectAcceptance: false };
            } catch (error) { entry.state = 'stale'; entry.error = error.message; throw error; }
        },
    };
    return api;
}

module.exports = { createBuildDeliveryAuthority };
