import { EventEmitter } from 'node:events';

import { expect, test, type ElectronApplication } from '@playwright/test';

import { closeAilyElectronApp } from '../fixtures/electron-app';

class FakeElectronProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    return true;
  }
}

test.describe('Electron E2E cleanup', () => {
  test('通过 app.quit 触发应用清理生命周期', async () => {
    const processRef = new FakeElectronProcess();
    let quitCalls = 0;
    let closeCalls = 0;
    const app = {
      process: () => processRef,
      evaluate: async (callback: (electron: { app: { quit: () => void } }) => unknown) =>
        callback({
          app: {
            quit: () => {
              quitCalls += 1;
              processRef.exitCode = 0;
              processRef.emit('exit', 0, null);
            },
          },
        }),
      close: async () => {
        closeCalls += 1;
      },
    } as unknown as ElectronApplication;

    await closeAilyElectronApp(app, 20);

    expect(quitCalls).toBe(1);
    expect(closeCalls).toBe(0);
  });
});
