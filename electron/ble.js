const { ipcMain } = require("electron");

const BLE_DEVICE_LIST_CHANNEL = 'ble-device-list';

let pendingBluetoothSelectionCallback = null;
let pendingBluetoothSelectionWebContents = null;
const lastBluetoothDeviceSignatures = new WeakMap();
const pausedBluetoothDeviceUpdates = new WeakSet();
const cancelledBluetoothDeviceRequests = new WeakSet();
const preferredBluetoothDeviceSelections = new WeakMap();
let bluetoothChooserEventCount = 0;
let bleHandlersRegistered = false;

function logBle(...args) {
  console.log('[BLE]', ...args);
}

function normalizeBluetoothDevices(deviceList = []) {
  const devices = new Map();
  for (const device of deviceList) {
    if (!device) continue;
    const deviceId = device.deviceId || device.id || device.device_id || device.address;
    if (!deviceId) continue;
    devices.set(deviceId, {
      deviceId,
      deviceName: device.deviceName || device.name || device.device_name || 'BLE OTA Device',
    });
  }
  return Array.from(devices.values());
}

function sendBluetoothDeviceList(webContents, deviceList) {
  if (!webContents || webContents.isDestroyed()) return;
  if (pausedBluetoothDeviceUpdates.has(webContents)) return;

  const normalizedDevices = normalizeBluetoothDevices(deviceList);
  const signature = JSON.stringify(normalizedDevices.map(device => `${device.deviceId}:${device.deviceName}`));
  if (lastBluetoothDeviceSignatures.get(webContents) === signature) return;

  lastBluetoothDeviceSignatures.set(webContents, signature);
  logBle('send devices to renderer:', normalizedDevices.length, normalizedDevices.map(device => device.deviceName || device.deviceId).join(', '));
  webContents.send(BLE_DEVICE_LIST_CHANNEL, normalizedDevices);
}

function finishBluetoothSelection(deviceId = '') {
  if (!pendingBluetoothSelectionCallback) return;

  if (pendingBluetoothSelectionWebContents) {
    preferredBluetoothDeviceSelections.delete(pendingBluetoothSelectionWebContents);
    pausedBluetoothDeviceUpdates.delete(pendingBluetoothSelectionWebContents);
    cancelledBluetoothDeviceRequests.delete(pendingBluetoothSelectionWebContents);
  }

  pendingBluetoothSelectionCallback(deviceId);
  pendingBluetoothSelectionCallback = null;
  pendingBluetoothSelectionWebContents = null;
}

function setupBluetoothPairing(targetWindow) {
  const ses = targetWindow.webContents.session;
  if (typeof ses.setBluetoothPairingHandler !== 'function') return;

  ses.setBluetoothPairingHandler((details, callback) => {
    logBle('pairing request:', details.deviceId || '', details.pairingKind || '');
    callback({ confirmed: true });
  });
}

function registerWebBluetoothChooser(targetWindow) {
  if (!targetWindow?.webContents) return;

  const webContents = targetWindow.webContents;
  logBle('register chooser for window');
  setupBluetoothPairing(targetWindow);

  webContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    bluetoothChooserEventCount++;
    pendingBluetoothSelectionCallback = callback;
    pendingBluetoothSelectionWebContents = webContents;

    if (cancelledBluetoothDeviceRequests.has(webContents)) {
      logBle('cancel deferred device request');
      finishBluetoothSelection('');
      return;
    }

    const normalizedDevices = normalizeBluetoothDevices(deviceList);
    const preferredDeviceId = preferredBluetoothDeviceSelections.get(webContents);
    if (preferredDeviceId) {
      const matchedDevice = normalizedDevices.find(device => device.deviceId === preferredDeviceId);
      if (matchedDevice) {
        logBle('auto selected preferred device:', matchedDevice.deviceName || matchedDevice.deviceId);
        finishBluetoothSelection(preferredDeviceId);
        return;
      }
    }

    if (bluetoothChooserEventCount <= 5 || bluetoothChooserEventCount % 20 === 0) {
      logBle('select-bluetooth-device event:', bluetoothChooserEventCount, 'raw count:', deviceList?.length || 0);
    }
    sendBluetoothDeviceList(webContents, normalizedDevices);
  });

  targetWindow.on('closed', () => {
    if (pendingBluetoothSelectionWebContents === webContents) {
      pendingBluetoothSelectionCallback = null;
      pendingBluetoothSelectionWebContents = null;
    }
  });
}

function registerBleHandlers() {
  if (bleHandlersRegistered) return;
  bleHandlersRegistered = true;

  ipcMain.handle('ble-select-device', async (_event, deviceId) => {
    logBle('renderer selected device:', deviceId || '(empty)');
    if (!pendingBluetoothSelectionCallback) {
      return { success: false, error: 'No active BLE device selection request' };
    }

    finishBluetoothSelection(deviceId || '');
    return { success: true };
  });

  ipcMain.handle('ble-cancel-device-request', async (event) => {
    logBle('renderer cancelled device request');
    if (pendingBluetoothSelectionCallback) {
      finishBluetoothSelection('');
    } else {
      preferredBluetoothDeviceSelections.delete(event.sender);
      cancelledBluetoothDeviceRequests.add(event.sender);
    }
    return { success: true };
  });

  ipcMain.handle('ble-set-preferred-device', async (event, deviceId) => {
    if (!deviceId) {
      preferredBluetoothDeviceSelections.delete(event.sender);
      return { success: true };
    }

    logBle('renderer preferred device for request:', deviceId);
    preferredBluetoothDeviceSelections.set(event.sender, deviceId);
    pausedBluetoothDeviceUpdates.delete(event.sender);
    cancelledBluetoothDeviceRequests.delete(event.sender);
    lastBluetoothDeviceSignatures.delete(event.sender);
    return { success: true };
  });

  ipcMain.handle('ble-start-device-list-updates', async (event) => {
    preferredBluetoothDeviceSelections.delete(event.sender);
    pausedBluetoothDeviceUpdates.delete(event.sender);
    cancelledBluetoothDeviceRequests.delete(event.sender);
    lastBluetoothDeviceSignatures.delete(event.sender);
    return { success: true };
  });

  ipcMain.handle('ble-stop-device-list-updates', async (event) => {
    pausedBluetoothDeviceUpdates.add(event.sender);
    return { success: true };
  });

  ipcMain.handle('ble-debug-state', async () => ({
    hasPendingSelection: !!pendingBluetoothSelectionCallback,
    chooserEventCount: bluetoothChooserEventCount,
    hasDeferredCancel: pendingBluetoothSelectionWebContents
      ? cancelledBluetoothDeviceRequests.has(pendingBluetoothSelectionWebContents)
      : false,
    preferredDeviceId: pendingBluetoothSelectionWebContents
      ? preferredBluetoothDeviceSelections.get(pendingBluetoothSelectionWebContents) || ''
      : '',
    deviceListUpdatesPaused: pendingBluetoothSelectionWebContents
      ? pausedBluetoothDeviceUpdates.has(pendingBluetoothSelectionWebContents)
      : false,
  }));
}

module.exports = {
  registerBleHandlers,
  registerWebBluetoothChooser,
};
