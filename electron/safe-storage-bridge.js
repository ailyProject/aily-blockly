const { SAFE_STORAGE_CHANNELS } = require('./safe-storage-ipc');

function createSafeStorageBridge(ipcRenderer) {
  const encryptStringToBase64 = plainText => requestSync(
    ipcRenderer,
    SAFE_STORAGE_CHANNELS.encryptBase64,
    plainText,
  );
  const decryptStringFromBase64 = encryptedBase64 => requestSync(
    ipcRenderer,
    SAFE_STORAGE_CHANNELS.decryptBase64,
    encryptedBase64,
  );

  return {
    isEncryptionAvailable: () => Boolean(requestSync(
      ipcRenderer,
      SAFE_STORAGE_CHANNELS.availability,
    )),
    encryptString: plainText => Buffer.from(encryptStringToBase64(plainText), 'base64'),
    decryptString: encrypted => decryptStringFromBase64(
      Buffer.from(encrypted).toString('base64'),
    ),
    encryptStringToBase64,
    decryptStringFromBase64,
  };
}

function requestSync(ipcRenderer, channel, payload) {
  const response = ipcRenderer.sendSync(channel, payload);
  if (!response || response.ok !== true) {
    throw new Error(String(response?.error || 'Safe storage IPC failed'));
  }
  return response.value;
}

module.exports = { createSafeStorageBridge };
