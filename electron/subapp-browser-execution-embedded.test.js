'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerBrowserExecutionHandlers } = require('./subapp-browser-execution-ipc');
const { hostHarness, tick } = require('./test/fixtures/subapp-browser-view.cjs');

const embedded = h => ({ presentation: 'embedded', parent: h.parent, bounds: h.bounds, visible: true });

test('default BrowserWindow View stays compatible while an embedded View shares the existing Runtime and owners', async t => {
    const h = hostHarness(t), a = h.owner(), b = h.owner();
    const acquired = await h.host.acquire(a); await h.host.acquire(b);
    const runtimeWindow = h.windows[1], beforeWindows = h.windows.length;
    const legacy = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, { show: false });
    assert.deepEqual(Object.keys(legacy).sort(), ['connectionId', 'executionId']);
    assert.equal(h.windows.length, beforeWindows + 1); assert.equal(h.windows.at(-1).shown, undefined);
    assert.equal((await h.host.closeView({ ...a, ...legacy })).physicalClosed, true);
    const opened = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, embedded(h));
    const view = h.views[0];
    assert.equal(opened.presentation, 'embedded'); assert.equal(h.windows.length, beforeWindows + 1);
    assert.equal(h.parentWindow.children.has(view), true); assert.equal(view.visible, true);
    assert.deepEqual(view.options.webPreferences, runtimeWindow.options.webPreferences);
    assert.equal(view.webContents.getURL(), acquired.surfaces.full);
    assert.equal(view.webContents.received[0].data.purpose, 'view');
    assert.deepEqual(h.host.updateView({ ...a, ...opened }, { bounds: h.bounds, visible: false }), { updated: true });
    assert.equal(view.visible, false);
    assert.throws(() => h.host.updateView({ ...b, ...opened }, { bounds: h.bounds, visible: true }), /no longer current/);
    const closed = await h.host.closeView({ ...a, ...opened });
    assert.deepEqual(closed, { detached: true, physicalClosed: true });
    assert.equal(h.host.runtimes.size, 1); assert.equal(runtimeWindow.isDestroyed(), false);
    assert.equal(h.host.describe(h.host.runtimes.get(a.runtimeId)).refCount, 2);
    assert.equal(h.lifecycle.filter(message => message.type === 'owner-release').length, 0);
    assert.equal((await h.host.release(a)).refCount, 1);
    assert.equal(h.host.isCurrent({ ...b, executionId: acquired.executionId }), true);
    await h.host.release(b); assert.equal(h.host.runtimes.size, 0); assert.equal(h.serverCloses, 1);
});

test('embedded close retains the actual binding until destruction and retries a physical close failure', async t => {
    const h = hostHarness(t), a = h.owner(), b = h.owner(), acquired = await h.host.acquire(a); await h.host.acquire(b);
    const opened = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, embedded(h));
    const state = h.host.runtimes.get(a.runtimeId), contents = h.views[0].webContents;
    contents.holdClose = true;
    let settled = false; const pending = h.host.closeView({ ...a, ...opened }).then(value => { settled = true; return value; });
    await tick(); assert.equal(settled, false); assert.equal(state.connections.has(opened.connectionId), true);
    assert.equal(contents.isDestroyed(), false); assert.equal(h.host.describe(state).refCount, 2);
    contents.finishClose(); assert.equal((await pending).physicalClosed, true);
    assert.equal(state.connections.has(opened.connectionId), false);
    const retry = await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, embedded(h));
    const retryContents = h.views[1].webContents; retryContents.closeError = new Error('physical close failed');
    await assert.rejects(h.host.closeView({ ...a, ...retry }), /physical close failed/);
    assert.equal(state.connections.has(retry.connectionId), true); assert.equal(state.views.size, 1);
    assert.equal(retryContents.isDestroyed(), false);
    retryContents.closeError = null;
    assert.equal((await h.host.closeView({ ...a, ...retry })).physicalClosed, true);
    assert.equal(state.connections.has(retry.connectionId), false);
    assert.equal(h.host.isCurrent({ ...b, executionId: acquired.executionId }), true);
    assert.equal(h.lifecycle.filter(message => message.type === 'owner-release').length, 0);
});

test('View physical close failure cannot prevent mandatory execution document and static server teardown', async t => {
    const h = hostHarness(t), a = h.owner(), acquired = await h.host.acquire(a);
    await h.host.openView({ ...a, executionId: acquired.executionId, surface: 'full' }, embedded(h));
    const contents = h.views[0].webContents; contents.closeError = new Error('View physical close failed');
    await assert.rejects(h.host.closeRuntime(a.runtimeId), /cleanup remains owned/);
    assert.equal(h.windows[1].isDestroyed(), true); assert.equal(h.serverCloses, 1);
    assert.equal(h.host.runtimes.size, 1); assert.equal(contents.isDestroyed(), false);
    contents.closeError = null;
    const receipt = await h.host.closeRuntime(a.runtimeId);
    assert.equal(receipt.physicalClosed, true); assert.equal(receipt.acknowledged, false);
    assert.equal(contents.isDestroyed(), true); assert.equal(h.host.runtimes.size, 0);
});

test('embedded IPC derives its parent from the sender and validates the original exact owner lease for updates', async t => {
    const h = hostHarness(t), a = h.owner(), b = h.owner(), handlers = new Map();
    const owners = new Map([[a.leaseId, a], [b.leaseId, b]]), generation = 'renderer-generation';
    const runtime = { streamId: h.runtimeId, hostInfo: { runtimeConfig: h.config } };
    const supervisor = { createOwnerGuard(sender, input) {
        const selected = owners.get(input.ownerSessionId);
        if (sender !== h.parent || input.generation !== generation || input.toolId !== h.config.id || !selected) throw new Error('Original owner lease mismatch');
        return selected.guard;
    } };
    let openOptions, updateCount = 0;
    const originalOpen = h.host.openView.bind(h.host), originalUpdate = h.host.updateView.bind(h.host);
    h.host.openView = (input, options) => { openOptions = options; return originalOpen(input, options); };
    h.host.updateView = (...args) => { updateCount++; return originalUpdate(...args); };
    registerBrowserExecutionHandlers({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, host: h.host,
        supervisor, resolveRuntime: () => runtime, prepareLaunch: async () => ({ config: h.config, release() {} }) });
    const invoke = (owner, payload, event = { sender: h.parent, senderFrame: h.parent.mainFrame }) => handlers.get('subapp-browser-execution')(event,
        { toolId: h.config.id, generation, ownerSessionId: owner.leaseId, ...payload });
    const acquired = await invoke(a, { action: 'acquire' }); await invoke(b, { action: 'acquire' });
    const forgedParent = new h.Contents();
    const opened = await invoke(a, { action: 'openView', runtimeId: acquired.endpoint.runtimeId, surface: 'full', presentation: 'embedded',
        bounds: h.bounds, visible: true, parent: forgedParent, target: forgedParent, url: 'https://not-selected.example/' });
    assert.equal(openOptions.parent, h.parent);
    assert.equal(h.views[0].webContents.getURL(), new URL(h.source.surfaces.full, 'http://127.0.0.1:49152/').href);
    const update = { action: 'updateView', runtimeId: acquired.endpoint.runtimeId, connectionId: opened.connectionId, bounds: h.bounds, visible: false };
    assert.deepEqual(await invoke(a, update), { updated: true }); assert.equal(h.views[0].visible, false);
    await assert.rejects(invoke(b, update), /no longer current/);
    await assert.rejects(invoke(a, { ...update, generation: 'old-generation' }), /Original owner lease mismatch/);
    await assert.rejects(invoke(a, update, { sender: h.parent, senderFrame: {} }), /owner main frame/);
    assert.equal(updateCount, 2);
    await invoke(a, { action: 'closeView', runtimeId: acquired.endpoint.runtimeId, connectionId: opened.connectionId });
    assert.equal(h.views[0].webContents.isDestroyed(), true);
    assert.equal(h.host.describe(h.host.runtimes.get(h.runtimeId)).refCount, 2);
});
