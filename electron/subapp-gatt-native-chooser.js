'use strict';
const choosers = new WeakSet();

function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid GATT chooser data');
    const properties = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !properties[key] || !('value' in properties[key])))
        throw new TypeError('Invalid GATT chooser fields');
    return Object.fromEntries(keys.map(key => [key, properties[key].value]));
}
function choices(value) {
    const snapshot = record(value, ['state', 'candidates']);
    if (snapshot.state !== 'stopped' || !Array.isArray(snapshot.candidates) || snapshot.candidates.length > 16)
        throw new TypeError('Original GATT scan has not stopped');
    const properties = Object.getOwnPropertyDescriptors(snapshot.candidates), rows = [];
    if (Reflect.ownKeys(snapshot.candidates).length !== snapshot.candidates.length + 1)
        throw new TypeError('Invalid GATT candidates');
    for (let index = 0; index < snapshot.candidates.length; index++) {
        const property = properties[index];
        if (!property || !('value' in property)) throw new TypeError('Invalid GATT candidate');
        const row = record(property.value, ['candidateId', 'label', 'rssi']);
        if (typeof row.candidateId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(row.candidateId)
            || rows.some(old => old.candidateId === row.candidateId)
            || typeof row.label !== 'string' || row.label.length < 1 || Buffer.byteLength(row.label, 'utf8') > 128
            || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(row.label)
            || row.rssi !== null && (!Number.isInteger(row.rssi) || row.rssi < -127 || row.rssi > 127))
            throw new TypeError('Invalid GATT candidate metadata');
        rows.push(Object.freeze(row));
    }
    return Object.freeze(rows);
}

/** Two explicit user choices: permit a finite local scan, then select one of
 * that scan's opaque candidates. No OS address/permission/scope enters the
 * browser request. Cancel, owner change and errors join the original scan. */
function createMainGattNativeChooser({ dialog, getMainWindow, backend } = {}) {
    if (typeof dialog?.showMessageBox !== 'function' || typeof getMainWindow !== 'function'
        || typeof backend?.scan !== 'function' || typeof backend.createDriver !== 'function'
        || typeof backend.releaseSelection !== 'function') return null;
    let busy = false;
    const chooser = async function choosePeer(_input, signal, requireCurrentAuthority) {
        if (!signal || typeof signal.throwIfAborted !== 'function' || typeof requireCurrentAuthority !== 'function')
            throw new TypeError('Original GATT chooser authority is required');
        if (busy) throw new Error('A local Bluetooth selection is already open');
        const main = getMainWindow();
        if (!main || main.isDestroyed() || signal.aborted) return Object.freeze({ outcome: 'cancelled' });
        function current() {
            requireCurrentAuthority(); signal.throwIfAborted();
            if (main.isDestroyed() || getMainWindow() !== main) throw new Error('Original GATT chooser window ended');
        }
        function response(value, maximum) {
            if (!Number.isInteger(value?.response) || value.response < 0 || value.response > maximum)
                throw new TypeError('Invalid GATT chooser response');
            return value.response;
        }
        let scan, selected, transferred = false;
        busy = true;
        try {
            current();
            const permission = await dialog.showMessageBox(main, { type: 'question', noLink: true,
                title: '连接本机蓝牙设备', message: '允许当前仿真会话扫描附近的蓝牙设备？',
                detail: '扫描最多持续 5 秒。随后可选择一个设备，供当前会话读取、写入及接收通知。关闭或复位仿真后需要重新选择。',
                buttons: ['取消', '扫描设备'], defaultId: 0, cancelId: 0, signal });
            current();
            if (response(permission, 1) === 0) return Object.freeze({ outcome: 'cancelled' });
            scan = await backend.scan({ durationMs: 5000, maxCandidates: 16 }, signal);
            // A partially acquired scan is always owned before readiness.
            if (!scan || !scan.ready || typeof scan.close !== 'function' || typeof scan.snapshot !== 'function'
                || typeof scan.select !== 'function') throw new Error('Installed GATT scan API is incomplete');
            await scan.ready;
            await scan.close();
            current();
            const rows = choices(scan.snapshot());
            if (!rows.length) {
                await dialog.showMessageBox(main, { type: 'info', title: '未发现蓝牙设备',
                    message: '请确认设备正在广播，然后重新选择。', buttons: ['确定'], defaultId: 0, cancelId: 0, signal });
                current();
                return Object.freeze({ outcome: 'cancelled' });
            }
            const selection = await dialog.showMessageBox(main, { type: 'question', noLink: true,
                title: '选择蓝牙设备', message: '请选择允许当前仿真会话连接的设备。',
                detail: rows.map((row, index) => `${index + 1}. ${row.label}`).join('\n'),
                buttons: ['取消', ...rows.map(row => `连接 ${row.label}`)], defaultId: 0, cancelId: 0, signal });
            current();
            const index = response(selection, rows.length);
            if (index === 0) return Object.freeze({ outcome: 'cancelled' });
            selected = scan.select(rows[index - 1].candidateId);
            if (!selected || typeof selected.peerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(selected.peerId))
                throw new Error('Installed GATT peer selection is invalid');
            current();
            transferred = true;
            return Object.freeze({ outcome: 'selected', peerId: selected.peerId,
                createDriver: () => { current(); return backend.createDriver(selected); },
                // The provider joins this logical acquisition even if a fresh
                // Core query fails before driver construction. Consumed driver
                // ownership is separate and is never released by this callback.
                abandon: () => backend.releaseSelection(selected) });
        } finally {
            try { if (scan) await scan.close(); }
            catch (error) { transferred = false; throw error; }
            finally {
                try { if (selected && !transferred) backend.releaseSelection(selected); }
                finally { busy = false; }
            }
        }
    };
    choosers.add(chooser);
    return chooser;
}
function isMainGattNativeChooser(value) { return typeof value === 'function' && choosers.has(value); }
module.exports = { createMainGattNativeChooser, isMainGattNativeChooser };
