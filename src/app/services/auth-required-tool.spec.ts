import { collectOpenAuthRequiredToolIds, isAuthRequiredTool } from './auth-required-tool';

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
