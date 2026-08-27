import {
  getChildToolConfigs,
  replaceChildToolConfigs,
  type ChildToolConfig,
} from '../../../configs/tool.config';
import {
  appendSubappAgentContributions,
  collectSubappAgentToolBindings,
  createSubappAgentHandlers,
} from './blockly-subapp-agent-tools';
import { createBlocklyToolProvider } from './blockly-contributed-tools';
import { BlocklySkillProvider } from './blockly-skill-provider';
import { SkillRegistry } from './skill-registry';

function fixtureConfig(
  id: string,
  name = 'fixture_echo',
): ChildToolConfig {
  return {
    id,
    titleKey: `${id}.TITLE`,
    namespace: id.toUpperCase(),
    packagePath: `/subapps/${id}`,
    agent: {
      protocolVersion: 1,
      transport: 'aily-child-rpc',
      manifestPath: 'agent/tools.json',
      skills: [],
      tools: [{
        name,
        description: `Tool from ${id}`,
        rpc: { method: 'fixture.echo' },
        permission: 'read',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          additionalProperties: false,
        },
      }],
    },
  };
}

describe('manifest-driven subapp Agent tools', () => {
  it('contributes a unique installed subapp tool without serial-specific registration', () => {
    const bindings = collectSubappAgentToolBindings({
      fixture: fixtureConfig('fixture'),
    });
    const contributions: any[] = [];
    appendSubappAgentContributions(contributions, bindings);

    expect(bindings.map(binding => binding.toolId)).toEqual(['fixture']);
    expect(contributions.map(tool => tool.name)).toEqual(['fixture_echo']);
    expect(contributions[0].toolSet).toBe('subapp:fixture');
    expect(contributions[0].annotations.readOnly).toBeTrue();
  });

  it('does not expose ambiguous global tool names from multiple subapps', () => {
    const bindings = collectSubappAgentToolBindings({
      first: fixtureConfig('first', 'duplicate_tool'),
      second: fixtureConfig('second', 'duplicate_tool'),
    });

    expect(bindings).toEqual([]);
  });

  it('routes execution through the generic host capability with toolId', async () => {
    const bindings = collectSubappAgentToolBindings({
      fixture: fixtureConfig('fixture'),
    });
    const handlers = createSubappAgentHandlers(bindings);
    const execute = jasmine.createSpy('execute').and.resolveTo({
      ok: true,
      toolId: 'fixture',
      tool: 'fixture_echo',
      result: { value: 'pong' },
    });

    const result = await handlers['fixture_echo'](
      { value: 'ping' },
      { subappAgent: { execute } } as any,
    );

    expect(execute).toHaveBeenCalledWith({
      toolId: 'fixture',
      tool: 'fixture_echo',
      params: { value: 'ping' },
    }, undefined);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('text');
    if (result.content[0].type === 'text') {
      expect(result.content[0].text).toContain('"value":"pong"');
    }
  });

  it('refreshes contributions and invocation routing when the Subapp catalog changes', async () => {
    const originalConfigs = Object.values(getChildToolConfigs());
    let subscription: { dispose(): void } | undefined;
    try {
      replaceChildToolConfigs([]);
      const execute = jasmine.createSpy('execute').and.resolveTo({
        ok: true,
        result: { running: true },
      });
      const provider = createBlocklyToolProvider({
        subappAgent: { execute },
      } as any, { runtimeMode: 'blockly' });
      const onToolsChanged = jasmine.createSpy('onToolsChanged');
      subscription = provider.onToolsChanged?.(onToolsChanged);

      expect(provider.contributeTools().map(tool => tool.name)).not.toContain('fixture_runtime_status');
      replaceChildToolConfigs([
        fixtureConfig('fixture-debugger', 'fixture_runtime_status'),
      ]);

      expect(onToolsChanged).toHaveBeenCalledTimes(1);
      expect(provider.contributeTools().map(tool => tool.name)).toContain('fixture_runtime_status');

      const result = await provider.invoke('fixture_runtime_status', {});
      expect(result.isError).not.toBeTrue();
      expect(execute).toHaveBeenCalledWith({
        toolId: 'fixture-debugger',
        tool: 'fixture_runtime_status',
        params: {},
      }, undefined);

      replaceChildToolConfigs([]);
      expect(onToolsChanged).toHaveBeenCalledTimes(2);
      expect(provider.contributeTools().map(tool => tool.name)).not.toContain('fixture_runtime_status');
    } finally {
      subscription?.dispose();
      replaceChildToolConfigs(originalConfigs);
    }
  });

  it('forwards SkillRegistry changes through the Lex skill provider contract', () => {
    let registryListener: (() => void) | undefined;
    const dispose = jasmine.createSpy('dispose');
    spyOn(SkillRegistry, 'onDidChange').and.callFake(listener => {
      registryListener = listener;
      return { dispose };
    });
    const listener = jasmine.createSpy('listener');

    const subscription = new BlocklySkillProvider().onSkillsChanged(listener);
    registryListener?.();

    expect(listener).toHaveBeenCalledTimes(1);
    subscription.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
