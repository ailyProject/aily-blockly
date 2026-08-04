import type { ChildToolAgentDefinition } from '../configs/tool.config';
import { resolveSubappAgentPresentation } from './subapp-agent-presentation';

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
