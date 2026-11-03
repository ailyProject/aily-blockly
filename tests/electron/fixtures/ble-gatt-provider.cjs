'use strict';
// Controlled native boundary only; Core, catalog, ATT and subscription logic stay real.
function createProvider() {
  const calls = Object.fromEntries(['start', 'stop', 'open', 'close', 'discover', 'invalidate', 'read', 'write', 'enable', 'disable'].map(key => [key, []]));
  const connections = new Map(), listeners = new Map();
  let observation;
  const uuid = value => `0000${value}00001000800000805f9b34fb`;
  const nodes = [{ token: 's', kind: 'service', uuid: uuid('180a'), parentToken: null, attributeHandle: 1 },
    ...['c0', 'c1'].map((token, index) => ({ token, kind: 'characteristic', uuid: uuid('2a29'), parentToken: 's',
      attributeHandle: index + 2, properties: ['read', 'write', 'notify'] }))];
  const writeLimits = { withResponse: { known: true, value: 20, source: 'controlled' }, withoutResponse: { known: true, value: 20, source: 'controlled' } };
  const provider = {
    capabilities: () => ({ implementationAvailable: true, provider: 'test-only', permission: 'controlled', radio: 'controlled' }),
    gattCapabilities: () => ({ implementationAvailable: true }),
    snapshot: () => ({ bluetoothInitialized: false, controlled: true, nativeInitialized: false, pendingControlReplies: 0, helperProcesses: 0 }),
    start(params) { calls.start.push(params); observation = params.onObservation; return { confirmed: true }; },
    stop(params) { calls.stop.push(params); observation = null; return { confirmed: true, watcherStopped: true }; },
    openConnection(params) { calls.open.push(params); const token = `native-${calls.open.length}`; connections.set(token, params);
      return Promise.resolve({ confirmed: true, connectionToken: token, providerEpoch: 'controlled', nativeObjectCreated: true, linkState: 'connected', writeLimits }); },
    closeConnection(token) { calls.close.push(token); connections.delete(token);
      for (const key of listeners.keys()) if (key.startsWith(`${token}:`)) listeners.delete(key);
      return Promise.resolve({ confirmed: true, referencesReleased: true }); },
    discoverGatt(token, params) { calls.discover.push({ token, params }); return Promise.resolve({ confirmed: true, providerEpoch: 'controlled', databaseEpoch: params.databaseEpoch, nodes, writeLimits }); },
    invalidateCatalog(token, params) { calls.invalidate.push({ token, params }); return Promise.resolve({ confirmed: true, referencesReleased: true }); },
    readGatt(token, params) { calls.read.push({ token, params }); return Promise.resolve({ confirmed: true, source: 'read', valueHex: params.attributeToken === 'c0' ? '10' : '11' }); },
    writeGatt(token, params) { calls.write.push({ token, params }); return Promise.resolve({ confirmed: true, acceptedBytes: params.valueHex.length / 2,
      effects: { submitted: 'confirmed', nativeAccepted: 'confirmed', attConfirmed: 'confirmed', applicationAck: 'unknown' } }); },
    enableNotifications(token, params) { calls.enable.push({ token, params }); const key = `${token}:${params.attributeToken}`;
      listeners.set(key, { params, sequence: 0 }); return Promise.resolve({ confirmed: true, physicalEnabled: true, listenerToken: `listener:${key}` }); },
    disableNotifications(token, params) { calls.disable.push({ token, params }); listeners.delete(`${token}:${params.attributeToken}`); return Promise.resolve({ confirmed: true, listenerRemoved: true }); },
    close() { observation = null; }
  };
  return { provider, calls,
    observe() { if (!observation) throw Error('No active scanner'); observation({ deviceKey: 'controlled-device', name: 'Lifecycle fixture', rssi: -44, sections: [] }); },
    emit(token, attributeToken, valueHex) { const key = `${token}:${attributeToken}`, value = listeners.get(key); if (!value) throw Error('No physical listener');
      value.params.onValue({ providerEpoch: 'controlled', connectionEpoch: connections.get(token).connectionEpoch, databaseEpoch: value.params.databaseEpoch,
        attributeToken, listenerToken: `listener:${key}`, sequence: ++value.sequence, valueHex }); },
    counts() { return Object.fromEntries(Object.entries(calls).map(([key, value]) => [key, value.length])); },
    resources() { return { connections: connections.size, listeners: listeners.size }; }
  };
}
module.exports = { createProvider };
