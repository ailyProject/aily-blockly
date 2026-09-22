const SAFE_STORAGE_CHANNELS = Object.freeze({
  availability: 'safe-storage:is-encryption-available',
  encryptBase64: 'safe-storage:encrypt-base64',
  decryptBase64: 'safe-storage:decrypt-base64',
});

const MAX_PLAIN_TEXT_LENGTH = 64 * 1024;
const MAX_ENCRYPTED_BASE64_LENGTH = 256 * 1024;
const registeredIpcMains = new WeakSet();

function registerSafeStorageIpc(ipcMain, safeStorage) {
  if (registeredIpcMains.has(ipcMain)) return;
  registeredIpcMains.add(ipcMain);

  registerSyncHandler(ipcMain, SAFE_STORAGE_CHANNELS.availability, () => (
    Boolean(safeStorage?.isEncryptionAvailable?.())
  ));
  registerSyncHandler(ipcMain, SAFE_STORAGE_CHANNELS.encryptBase64, plainText => {
    requireSafeStorage(safeStorage);
    requireBoundedString(plainText, 'Plain text', MAX_PLAIN_TEXT_LENGTH);
    return Buffer.from(safeStorage.encryptString(plainText)).toString('base64');
  });
  registerSyncHandler(ipcMain, SAFE_STORAGE_CHANNELS.decryptBase64, encryptedBase64 => {
    requireSafeStorage(safeStorage);
    requireBoundedString(
      encryptedBase64,
      'Encrypted value',
      MAX_ENCRYPTED_BASE64_LENGTH,
    );
    if (
      encryptedBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(encryptedBase64)
    ) {
      throw new TypeError('Encrypted value must be valid Base64');
    }
    return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
  });
}

function registerSyncHandler(ipcMain, channel, handler) {
  ipcMain.on(channel, (event, payload) => {
    try {
      event.returnValue = { ok: true, value: handler(payload) };
    } catch (error) {
      event.returnValue = {
        ok: false,
        error: error instanceof Error ? error.message : String(error || 'Safe storage failed'),
      };
    }
  });
}

function requireSafeStorage(safeStorage) {
  if (
    !safeStorage
    || typeof safeStorage.encryptString !== 'function'
    || typeof safeStorage.decryptString !== 'function'
    || !safeStorage.isEncryptionAvailable()
  ) {
    throw new Error('System safe storage is unavailable');
  }
}

function requireBoundedString(value, label, maxLength) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (!value || value.length > maxLength) {
    throw new RangeError(`${label} has an invalid length`);
  }
}

module.exports = {
  SAFE_STORAGE_CHANNELS,
  registerSafeStorageIpc,
};
