import { EMPTY } from 'rxjs';
import { ConfigService } from '../src/app/services/core/preferences/config.service';

describe('Blockly preference autosave', () => {
  it('serializes changes and persists only the chosen fields, not unrelated drafts', async () => {
    const service = new ConfigService({} as any, { isElectron: true } as any,
      { isLoggedIn$: EMPTY, authSnapshot$: EMPTY, canUseCloudCompilation: false } as any);
    const base = { region: 'cn', project_path: '/saved', blockly: { renderer: 'thrasos', autoSave: true, sounds: true } };
    (service as any).persistedDataSnapshot = structuredClone(base);
    service.data = { ...structuredClone(base), project_path: '/unsaved-draft' } as any;
    const snapshots: any[] = [];
    spyOn<any>(service, 'persistCurrentData').and.callFake(async (next: any) => {
      snapshots.push(structuredClone(next));
      (service as any).persistedDataSnapshot = structuredClone(next);
    });
    await Promise.all([service.saveBlocklyPreference('renderer', 'zelos'), service.saveBlocklyPreference('autoSave', false)]);
    expect(snapshots[0].blockly.renderer).toBe('zelos');
    expect(snapshots[1].blockly).toEqual({ renderer: 'zelos', autoSave: false, sounds: true });
    expect(snapshots.every(item => item.project_path === '/saved')).toBeTrue();
    expect(service.data.project_path).toBe('/unsaved-draft');
    await expectAsync(service.saveBlocklyPreference('renderer', 'unknown')).toBeRejected();
  });

  it('propagates disk failures instead of reporting a successful save', async () => {
    const service = new ConfigService({} as any, { isElectron: true } as any,
      { isLoggedIn$: EMPTY, authSnapshot$: EMPTY, canUseCloudCompilation: false } as any);
    service.data = { blockly: {} } as any;
    spyOn<any>(service, 'persistCurrentData').and.rejectWith(new Error('disk full'));
    await expectAsync(service.saveBlocklyPreference('renderer', 'zelos')).toBeRejectedWithError('disk full');
  });
});
