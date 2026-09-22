import { toHostResourceLifecycleRequest } from '../../services/subapp-resource-lifecycle-adapter';

describe('resource lifecycle upload adapter', () => {
  it('maps a serial monitor disconnect signal to a generic suspend request', () => {
    expect(toHostResourceLifecycleRequest('serial-monitor:disconnect', {
      port: 'COM3',
      portType: 'serial',
      operationId: 'upload-1',
    })).toEqual({
      action: 'suspend',
      resource: { kind: 'serial', id: 'COM3' },
      operationId: 'upload-1',
      reason: 'firmware-upload',
      restore: true,
      safeBoundaryTimeoutMs: 1500,
    });
  });

  it('maps the matching reconnect signal and preserves restore hints', () => {
    expect(toHostResourceLifecycleRequest('serial-monitor:connect', {
      port: 'COM3',
      portType: 'serial',
      operationId: 'upload-1',
      outcome: 'success',
      settleMs: 900,
      recovery: {
        protocolVersion: 1,
        boardFamily: 'avr-native-usb',
        expectedReenumeration: 'required',
        maxWaitMs: 25000,
        retryIntervalMs: 250,
        settleMs: 1000,
        guard: {
          blockMutationsUntilSettled: true,
          reason: 'avr-native-usb-reenumeration',
        },
        portMatch: {
          allowPathChange: true,
          allowProductIdChange: true,
        },
      },
    })).toEqual({
      action: 'resume',
      resource: { kind: 'serial', id: 'COM3' },
      operationId: 'upload-1',
      reason: 'firmware-upload',
      restore: true,
      maxWaitMs: 25000,
      retryIntervalMs: 250,
      settleMs: 900,
      outcome: 'success',
      recovery: {
        protocolVersion: 1,
        boardFamily: 'avr-native-usb',
        expectedReenumeration: 'required',
        maxWaitMs: 25000,
        retryIntervalMs: 250,
        settleMs: 1000,
        guard: {
          blockMutationsUntilSettled: true,
          reason: 'avr-native-usb-reenumeration',
        },
        portMatch: {
          allowPathChange: true,
          allowProductIdChange: true,
        },
      },
    });
  });

  it('does not translate non-serial or unrelated signals', () => {
    expect(toHostResourceLifecycleRequest('serial-monitor:disconnect', {
      port: 'BLE-1',
      portType: 'ble',
    })).toBeNull();
    expect(toHostResourceLifecycleRequest('other-tool:refresh', { port: 'COM3' })).toBeNull();
  });
});
