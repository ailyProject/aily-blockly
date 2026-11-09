'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { createGattAdmissionDiagnostic } = require('./subapp-gatt-main-ipc');
const file = () => path.join('/Volumes/data/aily-work/logs/w8-gatt-pre-scan-classification-20261108-a01', `gatt-admission-test-${randomUUID()}.ndjson`);
const read = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const codes = ['backend-ended', 'invalid-signal', 'cancelled', 'invalid-scan', 'scan-owned'];
const messages = ['Original GATT chooser authority is required', 'A local Bluetooth selection is already open',
    'Original GATT chooser window ended', 'Invalid GATT chooser response', 'Installed GATT scan API is incomplete',
    'Installed GATT scan owner is unavailable', 'Original network owner ended'];

test('existing sink preserves exact pre-scan codes and fixed product messages without changing the original errors', () => {
    const target = file(), sink = createGattAdmissionDiagnostic({ file: target });
    for (const code of codes) {
        const error = Object.freeze(Object.assign(new Error('untrusted device detail'), { code }));
        const before = Object.getOwnPropertyDescriptors(error); sink('choose-peer', error);
        assert.deepEqual(Object.getOwnPropertyDescriptors(error), before); assert.equal(error.code, code);
    }
    for (const message of messages) {
        const error = Object.freeze(new Error(message)); const before = Object.getOwnPropertyDescriptors(error);
        sink('choose-peer', error); assert.deepEqual(Object.getOwnPropertyDescriptors(error), before);
    }
    sink.close(); const rows = read(target); assert.equal(rows.length, codes.length + messages.length);
    for (let i = 0; i < codes.length; i++) { assert.equal(rows[i].errorCode, codes[i]); assert.equal(rows[i].message, '[message redacted]'); }
    for (let i = 0; i < messages.length; i++) { assert.equal(rows[codes.length + i].message, messages[i]); assert.equal(rows[codes.length + i].errorCode, null); }
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /untrusted device/);
});

test('default-off and exact-only pre-scan classification reject prefixes, appended values and accessors', () => {
    const untouched = file(), off = createGattAdmissionDiagnostic(); off('choose-peer', { code: 'scan-owned', message: messages[0] }); off.close();
    assert.equal(fs.existsSync(untouched), false);
    const target = file(), sink = createGattAdmissionDiagnostic({ file: target }); let getters = 0;
    for (const code of codes) sink('choose-peer', { code: code + ':private-token', message: messages[0] + ' private-device' });
    const accessors = {}; for (const name of ['message', 'code', 'connectivityCode', 'name', 'stack', 'cause', 'value'])
        Object.defineProperty(accessors, name, { enumerable: true, get() { getters++; throw Error('Private getter must not run'); } });
    sink('choose-peer', accessors); sink.close(); assert.equal(getters, 0);
    const rows = read(target); assert.equal(rows.length, codes.length + 1);
    for (const row of rows) { assert.equal(row.errorCode, null); assert.equal(row.message, '[message redacted]'); }
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /private-token|private-device|Private getter/);
});

test('the existing typed provider timeout is preserved by own-code IPC diagnostic adaptation while unknown codes stay redacted', () => {
    const result = Object.freeze({ schemaVersion: 1, kind: 'aily-host-gatt-provider-result', requestId: 'timeout-fixture',
        requestSequence: 1, operation: 'select', ok: false, errorCode: 'timeout' });
    const before = Object.getOwnPropertyDescriptors(result), target = file(), sink = createGattAdmissionDiagnostic({ file: target });
    // Same own-code envelope used by the actual IPC negative-result observer.
    const observed = Object.freeze({ code: result.errorCode }); sink('ipc-negative', observed);
    sink('ipc-negative', { code: 'timeout:untrusted-value', message: 'arbitrary device detail' }); sink.close();
    assert.deepEqual(Object.getOwnPropertyDescriptors(result), before); assert.equal(observed.code, 'timeout');
    const rows = read(target); assert.equal(rows.length, 2); assert.equal(rows[0].errorCode, 'timeout');
    assert.equal(rows[1].errorCode, null); assert.equal(rows[1].message, '[message redacted]');
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /untrusted-value|arbitrary device/);
});
