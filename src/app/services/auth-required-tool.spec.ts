import { collectOpenAuthRequiredToolIds, isAuthRequiredTool } from './auth-required-tool';
import {
  closeAuthRequiredTools,
  ProtectedToolCloseError,
} from './auth-required-tool-close';
import { runAuthSessionInvalidation } from './auth-session-invalidation';

describe('isAuthRequiredTool', () => {
  it('protects account, cloud, and both Aily Chat implementations', () => {
    expect(isAuthRequiredTool('user-center')).toBeTrue();
    expect(isAuthRequiredTool('cloud-space')).toBeTrue();
    expect(isAuthRequiredTool('aily-chat')).toBeTrue();
    expect(isAuthRequiredTool('aily-chat-react')).toBeTrue();
  });

  it('does not block local development tools or the app store', () => {
    expect(isAuthRequiredTool('serial-monitor')).toBeFalse();
    expect(isAuthRequiredTool('code-viewer')).toBeFalse();
    expect(isAuthRequiredTool('app-store')).toBeFalse();
  });

  it('collects embedded and detached protected tools without duplicates', () => {
    expect(collectOpenAuthRequiredToolIds(
      ['user-center', 'cloud-space', 'serial-monitor'],
      ['/child-tool/aily-chat-react', '/aily-chat', '/cloud-space', '/child-tool/aily-chat-react'],
    )).toEqual(['user-center', 'cloud-space', 'aily-chat-react', 'aily-chat']);
  });

  it('resolves hash routes reported by detached windows', () => {
    expect(collectOpenAuthRequiredToolIds([], [
      'http://localhost:4200/#/child-tool/aily-chat-react?standalone=true',
    ])).toEqual(['aily-chat-react']);
  });
});

describe('closeAuthRequiredTools', () => {
  it('uses the child lifecycle close path before the force-close fallback', async () => {
    const calls: string[] = [];

    await closeAuthRequiredTools(['aily-chat-react', 'cloud-space'], {
      isChildTool: (toolId) => toolId === 'aily-chat-react',
      prepareChildApp: async (toolId) => {
        calls.push(`prepare:${toolId}`);
        return { ok: true };
      },
      controlChildApp: async (toolId) => {
        calls.push(`lifecycle:${toolId}`);
        return { ok: toolId !== 'aily-chat-react' };
      },
      forceCloseToolEverywhere: async (toolId) => {
        calls.push(`force:${toolId}`);
        return true;
      },
    });

    expect(calls).toEqual([
      'prepare:aily-chat-react',
      'lifecycle:aily-chat-react',
      'force:aily-chat-react',
      'force:cloud-space',
    ]);
  });

  it('aborts when a protected tool cannot be closed', async () => {
    await expectAsync(closeAuthRequiredTools(['cloud-space'], {
      isChildTool: () => false,
      prepareChildApp: async () => ({ ok: true }),
      controlChildApp: async () => ({ ok: false }),
      forceCloseToolEverywhere: async () => false,
    })).toBeRejectedWith(jasmine.any(ProtectedToolCloseError));
  });

  it('does not close or force-close a child app when strict preparation fails', async () => {
    const controlChildApp = jasmine.createSpy('controlChildApp');
    const forceCloseToolEverywhere = jasmine.createSpy('forceCloseToolEverywhere');

    await expectAsync(closeAuthRequiredTools(['aily-chat-react'], {
      isChildTool: () => true,
      prepareChildApp: async () => ({ ok: false, message: 'active turn did not settle' }),
      controlChildApp,
      forceCloseToolEverywhere,
    })).toBeRejectedWith(jasmine.any(ProtectedToolCloseError));

    expect(controlChildApp).not.toHaveBeenCalled();
    expect(forceCloseToolEverywhere).not.toHaveBeenCalled();
  });
});

describe('runAuthSessionInvalidation', () => {
  it('saves and closes protected apps before clearing local auth and requesting login', async () => {
    const calls: string[] = [];

    const result = await runAuthSessionInvalidation({
      closeProtectedTools: async () => { calls.push('close'); },
      forceCloseProtectedTools: async () => { calls.push('force-close'); },
      stopProtectedRuntime: async () => { calls.push('stop-runtime'); },
      clearLocalAuthSession: async () => { calls.push('clear-auth'); },
      completeInvalidation: () => { calls.push('complete'); },
      showSessionReplacedNotice: () => { calls.push('notice'); },
      requestLogin: () => { calls.push('request-login'); },
    });

    expect(calls).toEqual([
      'close',
      'stop-runtime',
      'clear-auth',
      'complete',
      'notice',
      'request-login',
    ]);
    expect(result).toEqual({ gracefulCloseSucceeded: true, failures: [] });
  });

  it('forces closure and still clears auth when graceful child preparation fails', async () => {
    const calls: string[] = [];
    const failures: string[] = [];

    const result = await runAuthSessionInvalidation({
      closeProtectedTools: async () => {
        calls.push('close');
        throw new Error('prepare failed');
      },
      forceCloseProtectedTools: async () => { calls.push('force-close'); },
      stopProtectedRuntime: async () => { calls.push('stop-runtime'); },
      clearLocalAuthSession: async () => { calls.push('clear-auth'); },
      completeInvalidation: () => { calls.push('complete'); },
      showSessionReplacedNotice: () => { calls.push('notice'); },
      requestLogin: () => { calls.push('request-login'); },
      reportFailure: (stage) => { failures.push(stage); },
    });

    expect(calls).toEqual([
      'close',
      'force-close',
      'stop-runtime',
      'clear-auth',
      'complete',
      'notice',
      'request-login',
    ]);
    expect(failures).toEqual(['graceful-close']);
    expect(result).toEqual({
      gracefulCloseSucceeded: false,
      failures: ['graceful-close'],
    });
  });

  it('always settles the login recovery path after runtime or storage errors', async () => {
    const calls: string[] = [];

    const result = await runAuthSessionInvalidation({
      closeProtectedTools: async () => { calls.push('close'); },
      forceCloseProtectedTools: async () => { calls.push('force-close'); },
      stopProtectedRuntime: async () => {
        calls.push('stop-runtime');
        throw new Error('runtime failed');
      },
      clearLocalAuthSession: async () => {
        calls.push('clear-auth');
        throw new Error('storage failed');
      },
      completeInvalidation: () => { calls.push('complete'); },
      showSessionReplacedNotice: () => { calls.push('notice'); },
      requestLogin: () => { calls.push('request-login'); },
    });

    expect(calls.slice(-3)).toEqual(['complete', 'notice', 'request-login']);
    expect(result.failures).toEqual(['stop-runtime', 'clear-local-auth']);
  });
});
