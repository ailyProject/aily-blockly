'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMainGattNativeChooser } = require('./subapp-gatt-native-chooser');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
    const calls = [], main = { isDestroyed: () => false }; let currentMain = main;
    const selected = Object.freeze({ peerId: 'opaque-peer-1' }), driver = { peerId: selected.peerId };
    let consumed = false, stopped = false, closes = 0, valid = true;
    const scan = { ready: options.ready ?? Promise.resolve(),
        snapshot: () => ({ state: stopped ? 'stopped' : 'scanning', candidates: options.rows ?? [{ candidateId: 'opaque-candidate-1', label: 'Controlled peer', rssi: -30 }] }),
        select(id) { calls.push('select'); assert(stopped); assert(!consumed); assert.equal(id, 'opaque-candidate-1'); consumed = true; options.select?.(); return selected; },
        async close() { calls.push('scan-close'); closes++; if (options.close) await options.close(); stopped = true; } };
    const backend = {
        async scan(input, signal) { calls.push('scan'); assert.deepEqual(input, { durationMs: 5000, maxCandidates: 16 }); assert(signal); return scan; },
        createDriver(value) { assert.equal(value, selected); calls.push('create-driver'); return driver; },
        releaseSelection(value) { assert.equal(value, selected); calls.push('abandon-selection'); },
    };
    const dialogs = [];
    const dialog = { async showMessageBox(parent, input) {
        assert.equal(parent, main); dialogs.push(input); calls.push(`dialog-${dialogs.length}`);
        assert.equal(input.defaultId, 0); assert.equal(input.cancelId, 0); assert(input.signal);
        return options.dialog ? options.dialog(input, dialogs.length) : { response: 1 };
    } };
    const chooser = createMainGattNativeChooser({ backend, dialog, getMainWindow: () => currentMain });
    const guard = () => { if (!valid) throw Error('owner ended'); };
    return { chooser, calls, dialogs, guard, driver, closeCount: () => closes,
        end: () => { valid = false; }, replaceWindow: () => { currentMain = {}; } };
}

test('construction and cancelled permission never scan, acquire a driver or connect', async () => {
    const f = fixture({ dialog: () => ({ response: 0 }) }); assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.chooser({}, new AbortController().signal, f.guard), { outcome: 'cancelled' });
    assert.deepEqual(f.calls, ['dialog-1']);
});

test('original scan is stopped before device consent, opaque selection and lazy driver construction', async () => {
    const f = fixture(), result = await f.chooser({}, new AbortController().signal, f.guard);
    assert.equal(result.outcome, 'selected'); assert.equal(result.peerId, 'opaque-peer-1');
    assert.deepEqual(f.calls, ['dialog-1', 'scan', 'scan-close', 'dialog-2', 'select', 'scan-close']);
    assert.equal(f.calls.includes('create-driver'), false); assert.equal(result.createDriver(), f.driver);
    assert.equal(f.calls.at(-1), 'create-driver'); f.end(); assert.throws(result.createDriver, /owner ended/);
    result.abandon(); assert.equal(f.calls.at(-1), 'abandon-selection');
});

test('cancellation of an in-flight original scan joins its close, without a second dialog', async () => {
    let settle; const ready = new Promise(resolve => { settle = resolve; }), abort = new AbortController();
    const f = fixture({ ready }), pending = f.chooser({}, abort.signal, f.guard);
    await tick(); abort.abort(); settle(); await assert.rejects(pending);
    assert.equal(f.dialogs.length, 1); assert(f.closeCount() >= 1); assert(!f.calls.includes('select'));
});

test('a failed original scan close prevents selection and is not treated as confirmed cleanup', async () => {
    const f = fixture({ close: async () => { throw Error('scan still owns Native'); } });
    await assert.rejects(f.chooser({}, new AbortController().signal, f.guard), /still owns Native/);
    assert.equal(f.dialogs.length, 1); assert(!f.calls.includes('select')); assert(!f.calls.includes('create-driver'));
});

test('late consent after owner or parent-window change cannot create a peer selection', async () => {
    for (const action of ['end', 'replaceWindow']) {
        let f; f = fixture({ dialog: (_input, n) => { if (n === 2) f[action](); return { response: 1 }; } });
        await assert.rejects(f.chooser({}, new AbortController().signal, f.guard));
        assert(!f.calls.includes('select')); assert(f.closeCount() >= 1);
    }
});

test('overlapping selection cannot start another scan or borrow the first candidate table', async () => {
    let settle; const ready = new Promise(resolve => { settle = resolve; }), f = fixture({ ready });
    const first = f.chooser({}, new AbortController().signal, f.guard); await tick();
    await assert.rejects(f.chooser({}, new AbortController().signal, f.guard), /already open/);
    settle(); await first; assert.equal(f.calls.filter(x => x === 'scan').length, 1);
});

test('untrusted candidate labels and duplicate identities are rejected before a device chooser', async () => {
    for (const rows of [[{ candidateId: 'a', label: 'peer\u202e', rssi: -20 }],
        [{ candidateId: 'a', label: 'peer', rssi: -20 }, { candidateId: 'a', label: 'other', rssi: -30 }]]) {
        const f = fixture({ rows }); await assert.rejects(f.chooser({}, new AbortController().signal, f.guard), /candidate/);
        assert.equal(f.dialogs.length, 1); assert(!f.calls.includes('select'));
    }
});

test('no discovered peer is reported honestly and does not choose a synthetic device', async () => {
    const f = fixture({ rows: [], dialog: (_input, n) => ({ response: n === 1 ? 1 : 0 }) });
    assert.deepEqual(await f.chooser({}, new AbortController().signal, f.guard), { outcome: 'cancelled' });
    assert.equal(f.dialogs[1].title, '未发现蓝牙设备'); assert(!f.calls.includes('select'));
});

test('an opaque selection acquired just before owner loss is abandoned by the original chooser', async () => {
    let f; f = fixture({ select: () => f.end() });
    await assert.rejects(f.chooser({}, new AbortController().signal, f.guard), /owner ended/);
    assert(f.calls.includes('select')); assert(f.calls.includes('abandon-selection')); assert(!f.calls.includes('create-driver'));
});
