import {
  findPreferredAilyChatTool,
  resolveAilyChatExternalInputOptions,
  resolveAilyChatMountDelay,
  resolvePreferredAilyChatTool,
} from './aily-chat-tool-routing';

describe('resolvePreferredAilyChatTool', () => {
  it('selects the React child chat when it is above the legacy chat', () => {
    expect(resolvePreferredAilyChatTool(['aily-chat', 'aily-chat-react']))
      .toBe('aily-chat-react');
  });

  it('selects the legacy chat when it is above the React child chat', () => {
    expect(resolvePreferredAilyChatTool(['aily-chat-react', 'aily-chat']))
      .toBe('aily-chat');
  });

  it('compares chat order even when a non-chat tool is currently on top', () => {
    expect(resolvePreferredAilyChatTool(['aily-chat', 'aily-chat-react', 'serial-monitor']))
      .toBe('aily-chat-react');
  });

  it('falls back to the legacy chat when no chat is open', () => {
    expect(resolvePreferredAilyChatTool(['serial-monitor']))
      .toBe('aily-chat');
  });

  it('reports no active chat when neither chat is open', () => {
    expect(findPreferredAilyChatTool(['serial-monitor'])).toBeNull();
  });

  it('reports the highest open chat for block-selection projection', () => {
    expect(findPreferredAilyChatTool(['aily-chat-react', 'serial-monitor', 'aily-chat']))
      .toBe('aily-chat');
  });
});

describe('Aily Chat external input timing', () => {
  it('waits for the remaining legacy mount window', () => {
    expect(resolveAilyChatMountDelay('aily-chat', 1_400, 1_000)).toBe(400);
    expect(resolveAilyChatMountDelay('aily-chat', 1_400, 1_500)).toBe(0);
    expect(resolveAilyChatMountDelay('aily-chat-react', 1_400, 1_000)).toBe(0);
  });

  it('does not start a competing new session on the first legacy delivery', () => {
    expect(resolveAilyChatExternalInputOptions(
      'aily-chat',
      { autoSend: true, newChatFirst: true },
      '',
    )).toEqual({ autoSend: true, newChatFirst: false });
  });

  it('starts fresh when the legacy chat already has a session', () => {
    expect(resolveAilyChatExternalInputOptions(
      'aily-chat',
      { autoSend: true, newChatFirst: true },
      'legacy-session',
    )).toEqual({ autoSend: true, newChatFirst: true });
  });
});
