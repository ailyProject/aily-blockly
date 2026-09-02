const assert = require('node:assert/strict');
const test = require('node:test');

const { createSafeStorageBridge } = require('./safe-storage-bridge');
const { registerSafeStorageIpc } = require('./safe-storage-ipc');

function createNativeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: plainText => Buffer.from(`encrypted:${plainText}`, 'utf8'),
    decryptString: encrypted => {
      assert.ok(Buffer.isBuffer(encrypted), 'native safeStorage must receive a Buffer');
      return encrypted.toString('utf8').replace(/^encrypted:/, '');
    },
  };
}

test('round-trips safe-storage values as Base64 strings across the preload bridge', () => {
  const { ipcMain, ipcRenderer } = createIpcPair();
  registerSafeStorageIpc(ipcMain, createNativeSafeStorage());
  const bridge = createSafeStorageBridge(ipcRenderer);
  const encrypted = bridge.encryptStringToBase64('root:secret');

  assert.equal(typeof encrypted, 'string');
  assert.equal(bridge.decryptStringFromBase64(encrypted), 'root:secret');
});

test('normalizes legacy Uint8Array values before native decryption', () => {
  const { ipcMain, ipcRenderer } = createIpcPair();
  registerSafeStorageIpc(ipcMain, createNativeSafeStorage());
  const bridge = createSafeStorageBridge(ipcRenderer);
  const encrypted = new Uint8Array(Buffer.from('encrypted:legacy-secret', 'utf8'));

  assert.equal(bridge.decryptString(encrypted), 'legacy-secret');
});

test('reports unavailable safe storage without dereferencing an undefined instance', () => {
  const { ipcMain, ipcRenderer } = createIpcPair();
  registerSafeStorageIpc(ipcMain, undefined);
  const bridge = createSafeStorageBridge(ipcRenderer);

  assert.equal(bridge.isEncryptionAvailable(), false);
  assert.throws(
    () => bridge.encryptStringToBase64('secret'),
    /System safe storage is unavailable/,
  );
});

function createIpcPair() {
  const listeners = new Map();
  const ipcMain = {
    on: (channel, listener) => listeners.set(channel, listener),
  };
  const ipcRenderer = {
    sendSync: (channel, payload) => {
      const listener = listeners.get(channel);
      if (!listener) throw new Error(`Missing IPC listener for ${channel}`);
      const event = { returnValue: undefined };
      listener(event, payload);
      return event.returnValue;
    },
  };
  return { ipcMain, ipcRenderer };
}
