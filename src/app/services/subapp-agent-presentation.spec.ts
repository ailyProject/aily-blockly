import type { ChildToolAgentDefinition } from '../configs/tool.config';
import { classifyRecordedChildToolRuntimeEntry } from './child-tool-runtime-entry';
import { resolveSubappAgentPresentation } from './subapp-agent-presentation';
import { acquireSubappRuntimePresentationLease } from './subapp-runtime-presentation-lease';

describe('resolveSubappAgentPresentation', () => {
  it('routes declared embedded UI into the conversation Dock without opening another app surface', () => {
    const result = resolveSubappAgentPresentation({}, definition({
      mode: 'embedded',
      surface: 'compact',
    }));

    expect(result).toEqual({
      uiMode: 'none',
      activityPresentation: {
        mode: 'dock',
        surface: 'compact',
        autoOpen: 'always',
      },
    });
  });

  it('treats an explicit embedded request as Dock presentation even when the manifest defaults to window', () => {
    const result = resolveSubappAgentPresentation(
      { presentUi: 'embedded' },
      definition({ mode: 'window', surface: 'compact' }),
    );

    expect(result.uiMode).toBe('none');
    expect(result.activityPresentation).toEqual({
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'always',
    });
  });

  it('opens a separate child-app surface only for window mode', () => {
    expect(resolveSubappAgentPresentation(
      { presentUi: 'window' },
      definition({ mode: 'dock', surface: 'compact' }),
    )).toEqual({
      uiMode: 'window',
      activityPresentation: { mode: 'window', surface: 'compact' },
    });

    expect(resolveSubappAgentPresentation(
      { presentUi: 'none' },
      definition({ mode: 'dock', surface: 'compact', autoOpen: 'always' }),
    )).toEqual({ uiMode: 'none' });
  });

  it('keeps native Dock conditions and auto-open behavior unchanged', () => {
    const tool = definition({
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'first-active',
      when: { param: 'action', values: ['open'] },
    });

    expect(resolveSubappAgentPresentation({ action: 'status' }, tool)).toEqual({ uiMode: 'none' });
    expect(resolveSubappAgentPresentation({ action: 'open' }, tool)).toEqual({
      uiMode: 'none',
      activityPresentation: {
        mode: 'dock',
        surface: 'compact',
        autoOpen: 'first-active',
      },
    });
  });

  it('keeps an already-open independent window when a semantic open omits presentUi', () => {
    const tool = definition({
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'first-active',
      when: { param: 'action', values: ['open'] },
    });

    expect(resolveSubappAgentPresentation({ action: 'open' }, tool, 'window')).toEqual({
      uiMode: 'window',
      activityPresentation: {
        mode: 'window',
        surface: 'compact',
        autoOpen: 'first-active',
      },
    });
  });

  it('lets explicit presentation override the active independent window', () => {
    const tool = definition({
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'first-active',
      when: { param: 'action', values: ['open'] },
    });

    expect(resolveSubappAgentPresentation(
      { action: 'open', presentUi: 'embedded' },
      tool,
      'window',
    )).toEqual({
      uiMode: 'none',
      activityPresentation: {
        mode: 'dock',
        surface: 'compact',
        autoOpen: 'first-active',
      },
    });
  });

  it('does not let repeated explicit UI arguments bypass the presentation condition', () => {
    const tool = definition({
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'first-active',
      when: { param: 'action', values: ['open'] },
    });

    expect(resolveSubappAgentPresentation(
      { action: 'status', presentUi: 'embedded' },
      tool,
    )).toEqual({ uiMode: 'none' });
    expect(resolveSubappAgentPresentation(
      { action: 'close', presentUi: 'window' },
      tool,
    )).toEqual({ uiMode: 'none' });
  });
});

describe('independent-window Runtime attachment', () => {
  const expectedEntry = {
    expectedEntry: 'index.js',
    expectedPackagePath: '/installed/subapp-serial-debugger',
  };

  it('trusts matching registration metadata without requiring process argv', () => {
    expect(classifyRecordedChildToolRuntimeEntry({
      ...expectedEntry,
      recordedEntry: 'index.js',
      recordedPackagePath: '/installed/subapp-serial-debugger',
    })).toBe('current');
  });

  it('rejects mismatched registration metadata and preserves the legacy fallback', () => {
    expect(classifyRecordedChildToolRuntimeEntry({
      ...expectedEntry,
      recordedEntry: 'server/index.js',
      recordedPackagePath: '/installed/subapp-serial-debugger',
    })).toBe('stale');
    expect(classifyRecordedChildToolRuntimeEntry({
      ...expectedEntry,
      recordedEntry: 'index.js',
      recordedPackagePath: '/old/subapp-serial-debugger',
    })).toBe('stale');
    expect(classifyRecordedChildToolRuntimeEntry({
      ...expectedEntry,
      recordedEntry: '',
      recordedPackagePath: '',
    })).toBe('unknown');
  });

  it('rejects a Runtime retained from an earlier pnpm dev session', () => {
    expect(classifyRecordedChildToolRuntimeEntry({
      ...expectedEntry,
      expectedDevSessionId: 'dev-current',
      recordedEntry: 'index.js',
      recordedPackagePath: '/installed/subapp-serial-debugger',
      recordedDevSessionId: 'dev-old',
    })).toBe('stale');
    expect(classifyRecordedChildToolRuntimeEntry({
      ...expectedEntry,
      expectedDevSessionId: 'dev-current',
      recordedEntry: 'index.js',
      recordedPackagePath: '/installed/subapp-serial-debugger',
      recordedDevSessionId: 'dev-current',
    })).toBe('current');
  });

  it('holds a shared Runtime across window startup and releases it only once', async () => {
    const calls: string[] = [];
    const owner = {
      acquire: async (toolId: string) => {
        calls.push(`acquire:${toolId}`);
        return {};
      },
      release: async (toolId: string) => {
        calls.push(`release:${toolId}`);
      },
    };

    const release = await acquireSubappRuntimePresentationLease(owner, 'serial-debugger');
    calls.push('window.open');
    calls.push('rpc.attach');
    await release();
    await release();

    expect(calls).toEqual([
      'acquire:serial-debugger',
      'window.open',
      'rpc.attach',
      'release:serial-debugger',
    ]);
  });
});

function definition(
  presentation: ChildToolAgentDefinition['presentation'],
): ChildToolAgentDefinition {
  return {
    name: 'fixture_status',
    description: 'Fixture tool',
    rpc: { method: 'fixture.status' },
    presentation,
    inputSchema: { type: 'object', properties: {} },
  };
}
