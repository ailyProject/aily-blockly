'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PROFILE, QUERY, RESULT } = require('../child/scripts/simulation-transport-profile');

for (const variant of ['normal', 'no-reply', 'disconnected', 'send-error', 'oversized']) {
    test(`actual supervised cmd listener privately relays only a bounded reply: ${variant}`, async () => {
        const filename = require.resolve('./cmd'), localRequire = createRequire(filename), handlers = new Map();
        const sent = [], observed = []; let abandoned = 0;
        const child = Object.assign(new EventEmitter(), { pid: 12345, connected: variant !== 'disconnected',
            stdout: new EventEmitter(), stderr: new EventEmitter(), send(message, done) {
                sent.push(message); done(variant === 'send-error' ? new Error('closed') : null);
            } });
        const context = { module: { exports: {} }, process, __dirname, setTimeout, clearTimeout,
            console: { info() {}, log() {}, warn() {}, error() {} }, require(name) {
                if (name === 'electron') return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
                if (name === 'child_process') return { spawn: () => child };
                if (name === './platform') return { isLinux: true };
                if (name === './build-workspace-supervisor') return { createBuildWorkspaceSupervisor: () => undefined };
                if (name === './child-process-message-port') {
                    const port = localRequire(name), clone = value => JSON.parse(JSON.stringify(value));
                    // VM objects have another Object.prototype. Recreate the
                    // same JSON realm boundary as a real Node IPC delivery.
                    return { normalizeProcessMessagePortConfig: value => port.normalizeProcessMessagePortConfig(clone(value)),
                        normalizeProcessMessage: (value, limit) => port.normalizeProcessMessage(clone(value), limit) };
                }
                return localRequire(name);
            } };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        const api = context.module.exports;
        const reply = { type: RESULT, requestDigest: 'a'.repeat(64), phase: 'before-compile', ok: true, profile: PROFILE,
            ...(variant === 'oversized' ? { oversized: 'x'.repeat(4096) } : {}) };
        api.registerCmdHandlers(undefined, { buildDeliveryAuthority: { async begin() { return {
            handle: 'fixture', abandon() { abandoned++; }, onMessage(message) { observed.push(message);
                return variant === 'no-reply' ? undefined : reply; }, onExit() {},
        }; } } });
        const owner = { id: 7, mainFrame: {}, isDestroyed: () => false, send() {} };
        const result = await handlers.get('cmd-run')({ sender: owner, senderFrame: owner.mainFrame }, {
            command: process.execPath, args: ['compile.js', 'request.json'], streamId: 'private-profile-compile',
            shellProfile: false, buildDeliveryRequest: 'request.json',
        });
        assert.equal(result.success, true, JSON.stringify(result));
        child.emit('message', { type: QUERY, requestDigest: 'a'.repeat(64), phase: 'before-compile' });
        assert.equal(observed.length, 1);
        if (['disconnected', 'oversized', 'no-reply'].includes(variant)) assert.equal(sent.length, 0);
        else { assert.equal(sent.length, 1); assert.deepEqual(sent[0], reply); }
        assert.equal(abandoned, ['disconnected', 'oversized', 'send-error'].includes(variant) ? 1 : 0);
        child.emit('close', 0, null);
    });
}
