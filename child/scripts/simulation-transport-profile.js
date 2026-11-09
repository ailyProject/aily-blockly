'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const PROFILE = 'esp32-classic-spp-ahc2-v2';
const PROVIDER = 'aily.esp32-spp-vhci-v2';
const QUERY = 'aily.build.compilation-profile.query';
const RESULT = 'aily.build.compilation-profile.result';
const hash = value => createHash('sha256').update(value).digest('hex');
const fault = () => new Error('SIMULATION_COMPILATION_PROFILE_UNAVAILABLE: Current host/package/Builder does not authorize this simulation compilation profile.');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');

/** Intent is derived from this compile's refreshed preprocess result. This is
 * not permission: Main supplies permission separately, and Builder validates
 * the actual SDK sources, target ABI, wrappers and recorded build inputs. */
function captureSppCompileIntent(config, filename, fqbn) {
    if (config.simulationTransportProfile !== undefined && config.simulationTransportProfile !== PROFILE) throw fault();
    const explicit = config.simulationTransportProfile === PROFILE;
    if (config.simulationDebug !== true && config.graphSemanticRevision === undefined) {
        if (explicit) throw fault();
        return null;
    }
    const read = () => {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.size > 32 * 1024 * 1024) throw fault();
        const bytes = fs.readFileSync(filename), after = fs.statSync(filename);
        if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw fault();
        return { bytes, identity: JSON.stringify([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, hash(bytes)]) };
    };
    const captured = read(), data = JSON.parse(captured.bytes), arduino = data.arduinoConfig;
    const selected = Array.isArray(data.dependencies)
        ? data.dependencies.filter(item => item.type === 'library' && item.name === 'BluetoothSerial') : [];
    let candidate = data.success === true && arduino?.fqbn === fqbn
        && arduino?.fqbnParsed?.package === 'esp32' && arduino?.fqbnParsed?.platform === 'esp32'
        && arduino?.board?.['build.mcu'] === 'esp32' && selected.length === 1;
    if (candidate) {
        const sdk = arduino.platform?.['runtime.platform.path'];
        candidate = typeof sdk === 'string' && path.isAbsolute(sdk)
            && typeof selected[0].path === 'string' && path.isAbsolute(selected[0].path)
            && fs.realpathSync(selected[0].path) === fs.realpathSync(path.join(sdk, 'libraries/BluetoothSerial/src'));
    }
    if (!candidate) {
        if (explicit) throw fault();
        return null;
    }
    return Object.freeze({ explicit, assertCurrent() { if (read().identity !== captured.identity) throw fault(); } });
}

function queryCompilationProfile(config, phase, channel = process, timeoutMs = 5000) {
    if (typeof channel.send !== 'function' || channel.connected !== true || config.recordProjectDelivery !== true) return Promise.resolve(null);
    const requestDigest = hash(JSON.stringify(config));
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            channel.removeListener('message', receive); channel.removeListener('disconnect', disconnected);
            error ? reject(error) : resolve(result);
        };
        const receive = message => {
            if (message?.type !== RESULT) return;
            if (!exact(message, ['type', 'requestDigest', 'phase', 'ok', 'profile'])
                || message.requestDigest !== requestDigest || message.phase !== phase || message.ok !== true
                || ![null, PROFILE].includes(message.profile)) finish(fault());
            else finish(null, message.profile);
        };
        const disconnected = () => finish(fault());
        const timer = setTimeout(() => finish(fault()), timeoutMs);
        channel.on('message', receive); channel.once('disconnect', disconnected);
        try { channel.send({ type: QUERY, requestDigest, phase }, error => { if (error) finish(fault()); }); }
        catch { finish(fault()); }
    });
}

async function authorizeSimulationTransportProfile(config, filename, fqbn, channel = process) {
    const intent = captureSppCompileIntent(config, filename, fqbn);
    if (!intent) return null;
    const profile = await queryCompilationProfile(config, 'before-compile', channel);
    intent.assertCurrent();
    if (profile === null) {
        if (intent.explicit) throw fault();
        return null;
    }
    return Object.freeze({ profile, assertCurrent: intent.assertCurrent, async confirm() {
        intent.assertCurrent();
        if (await queryCompilationProfile(config, 'before-delivery', channel) !== profile) throw fault();
        intent.assertCurrent();
    } });
}

module.exports = { PROFILE, PROVIDER, QUERY, RESULT, captureSppCompileIntent, queryCompilationProfile, authorizeSimulationTransportProfile };
