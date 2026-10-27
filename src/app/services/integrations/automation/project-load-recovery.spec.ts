import { captureProjectDiskRecovery, inspectProjectDiskRecovery } from '@domain/project/public-api';
import { inspectFailedProjectLoad } from './project-load-recovery';
import { BlocklyLiveOperationBridgeService } from '@integration/automation/public-api';

describe('failed-load recovery source isolation', () => {
  const source = '/isolated/failed-source', target = '/isolated/recovered';
  const request = { version: 2, requestId: 'failed-load-inspect-001', action: 'inspect' };
  const loadStatus = { ready: false, state: 'error', error: 'Library initialization did not finish.' };
  let files: Map<string, string>, writes: string[], previous: any;
  const abi = '{ "schemaVersion": 3, "pages": [{"id":"page-1","content":{"blocks":{"blocks":[{"id":"keep","type":"opaque","deletable":false,"collapsed":true,"disabledReasons":["MANUALLY_DISABLED"],"extraState":{"params":[1,null,"界"]}}]}}}] }';

  beforeEach(() => {
    previous = window['fs']; writes = [];
    files = new Map([
      [`${source}/package.json`, '{"name":"source","dependencies":{"@aily-project/lib-test":"1"}}'],
      [`${source}/project.abi`, abi], [`${source}/project.abs`, 'retained unapplied source'],
      [`${source}/project.abs.map.json`, '{"old":"scope"}'],
      [`${source}/aily-data/value.txt`, 'external resource bytes'],
    ]);
    window['fs'] = {
      existsSync: path => files.has(path), readFileSync: path => {
        if (!files.has(path)) throw new Error(`ENOENT ${path}`); return files.get(path);
      },
      writeFileSync: (path, value, options) => {
        if (options?.flag === 'wx' && files.has(path)) throw new Error('EEXIST');
        writes.push(path); files.set(path, value);
      },
    } as any;
  });
  afterEach(() => window['fs'] = previous);
  const copy = () => {
    for (const [name, text] of [...files]) if (name.startsWith(source + '/')) {
      const relative = name.slice(source.length + 1);
      if (!['project.abs', 'project.abs.map.json'].includes(relative)) files.set(`${target}/${relative}`, text);
    }
  };

  it('uses complete saved ABI bytes as primary and independently archives a half-empty native view', async () => {
    const before = [...files], fragment = { schemaVersion: 3, pages: [{ content: { blocks: { blocks: [] } } }] };
    const snapshot = await captureProjectDiskRecovery(source, () => {}, { documentText: JSON.stringify(fragment) });
    copy(); const result = await snapshot.publish(target);
    expect(result.projectSaved).toBeTrue(); expect(result.projectionPending).toBeTrue();
    expect(result.recoverySource).toEqual({ version: 1, kind: 'saved-document', complete: true,
      loadFailed: true, partialCanvas: 'archived' });
    expect(files.get(`${target}/project.abi`)).toBe(abi);
    expect(files.get(`${target}/aily-data/value.txt`)).toBe('external resource bytes');
    expect(files.has(`${target}/project.abs`)).toBeFalse(); expect(files.has(`${target}/project.abs.map.json`)).toBeFalse();
    const archive = JSON.parse(files.get(result.recoveryArchive!)!);
    expect(archive.partialCanvas).toEqual({ captured: true, document: fragment });
    expect(archive.files['project.abi']).toBe(abi); expect(archive.files['project.abs']).toBe('retained unapplied source');
    for (const [name, value] of before) expect(files.get(name)).toBe(value);
    expect(writes.every(name => name.startsWith(target + '/'))).toBeTrue();
    snapshot.dispose(); expect(snapshot.isCurrent()).toBeFalse();
  });

  it('retains the source view when its partial native document cannot be archived', async () => {
    const snapshot = await captureProjectDiskRecovery(source, () => {}, { error: 'serializer failed' });
    copy(); const result = await snapshot.publish(target);
    expect(snapshot.activationBlocked?.reason).toBe('partial-canvas-unavailable');
    expect(result.activationBlocked).toEqual(snapshot.activationBlocked);
    expect(result.recoverySource?.partialCanvas).toBe('unavailable');
    expect(files.get(`${target}/project.abi`)).toBe(abi);
    expect(JSON.parse(files.get(result.recoveryArchive!)!).partialCanvas).toEqual({ captured: false, error: 'serializer failed' });
  });

  it('preserves invalid ABS bytes without lossy decoding or inheriting them as target mirrors', async () => {
    let draft = new Uint8Array([0xff, 0xfe, 0x41]);
    (window['fs'] as any).readFileBuffer = (path: string) => path === `${source}/project.abs`
      ? draft : new TextEncoder().encode(files.get(path)!);
    const snapshot = await captureProjectDiskRecovery(source, () => {}, { notApplicable: true });
    copy(); const result = await snapshot.publish(target);
    const archive = JSON.parse(files.get(result.recoveryArchive!)!);
    expect(archive.files['project.abs']).toBeNull();
    expect(archive.rawFiles['project.abs']).toEqual(jasmine.objectContaining({ encoding: 'base64', bytes: 3, contents: '//5B' }));
    expect(files.has(`${target}/project.abs`)).toBeFalse();
    expect(files.get(`${source}/project.abs`)).toBe('retained unapplied source');
    draft = new Uint8Array([0xfe, 0xfe, 0x41]);
    expect(snapshot.isCurrent()).toBeFalse();
  });

  it('refuses a changed source or destination without overwriting either document', async () => {
    const snapshot = await captureProjectDiskRecovery(source, () => {}, { documentText: '{}' }); copy();
    files.set(`${source}/project.abs`, 'newer candidate');
    await expectAsync(snapshot.publish(target)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RECOVERY_SOURCE_CHANGED' }));
    expect(writes).toEqual([]); expect(files.get(`${source}/project.abs`)).toBe('newer candidate');
    files.set(`${source}/project.abs`, 'retained unapplied source');
    files.set(`${target}/project.abi`, 'newer target');
    await expectAsync(snapshot.publish(target)).toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RECOVERY_TARGET_CONFLICT' }));
    expect(writes).toEqual([]); expect(files.get(`${target}/project.abi`)).toBe('newer target');
  });

  it('retains the original view when its partial fragment changes after capture', async () => {
    let current = true, fenced = false;
    const snapshot = await captureProjectDiskRecovery(source, () => {}, { documentText: '{}', isCurrent: () => current,
      freezeForActivation: () => { fenced = true; return () => { fenced = false; }; } });
    copy(); await snapshot.publish(target);
    const release = snapshot.freezeForActivation!(); expect(fenced).toBeTrue(); release(); expect(fenced).toBeFalse();
    current = false;
    expect(snapshot.isCurrent()).toBeFalse(); expect(() => snapshot.freezeForActivation!()).toThrow();
    expect(files.get(`${source}/project.abi`)).toBe(abi);
  });

  for (const value of [null, '[1]', '{broken']) it(`does not invent a complete source from ${value}`, async () => {
    if (value === null) files.delete(`${source}/project.abi`); else files.set(`${source}/project.abi`, value);
    await expectAsync(captureProjectDiskRecovery(source, () => {}, { documentText: '{}' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'PROJECT_RECOVERY_SOURCE_UNAVAILABLE' }));
    expect(writes).toEqual([]);
  });

  it('returns byte-bound saved-document facts and a specific fork offer without touching private store or native state', async () => {
    const disk = await inspectProjectDiskRecovery(source, () => {});
    expect(disk.abi).toBe('available'); expect(disk.hashes.abi).toMatch(/^sha256:[a-f0-9]{64}$/);
    const result: any = await inspectFailedProjectLoad(source, loadStatus, request, () => {});
    expect(result.ok).toBeTrue(); expect(result.receipt).toEqual({ version: 2, requestId: request.requestId, action: 'inspect' });
    expect(result.diagnostics.loadRecovery).toEqual(jasmine.objectContaining({ version: 1,
      source: 'saved-document', pendingMutation: false, disk, offer: { action: 'fork' } }));
    expect(result.recoverySource).toBeUndefined();
    expect(result.nextAction).toEqual({ tool: 'project_recover', input: { project: source, action: 'fork' } });
    expect(writes).toEqual([]);
  });

  it('does not offer a fork for an unavailable primary or claim ownership when inspection changes', async () => {
    files.delete(`${source}/project.abi`);
    const missing: any = await inspectFailedProjectLoad(source, loadStatus, request, () => {});
    expect(missing.ok).toBeFalse(); expect(missing.diagnostics.loadRecovery.offer).toBeUndefined(); expect(missing.nextAction).toBeUndefined();
    const busy: any = await inspectFailedProjectLoad(source, loadStatus, request,
      () => { throw Object.assign(new Error('busy'), { code: 'PROJECT_RECOVERY_SOURCE_BUSY' }); });
    expect(busy.ok).toBeFalse(); expect(busy.code).toBe('PROJECT_RECOVERY_SOURCE_BUSY');
    expect(busy.nextAction).toEqual({ tool: 'app_info', input: {} }); expect(writes).toEqual([]);
  });

  it('keeps protocol and request-field admission strict before reading the disk', async () => {
    await expectAsync(inspectFailedProjectLoad(source, loadStatus, { ...request, version: 1 }, () => {})).toBeRejected();
    await expectAsync(inspectFailedProjectLoad(source, loadStatus, { ...request, token: 'invented' }, () => {})).toBeRejected();
    expect(writes).toEqual([]);
  });

  it('routes real failed-load inspect before readiness but keeps apply/save and active writers gated', async () => {
    const bridge: any = Object.create(BlocklyLiveOperationBridgeService.prototype);
    const calls: string[] = [];
    bridge.projectService = { currentProjectPath: source, getProjectMode: () => 'blockly', isProjectOpening: false,
      isProjectTransitionInProgress: () => false, getBlocklyProjectLoadStatus: () => loadStatus };
    bridge.aiOperations = { setActive: () => calls.push('mutation'), hasBlocking: () => false };
    bridge.mutationSequence = 0;
    const priorPath = window['path']; window['path'] = { ...priorPath };
    try {
      const result = await bridge.execute({ operation: 'abs_recovery', params: request });
      expect(result.ok).toBeTrue(); expect(result.diagnostics.loadRecovery.source).toBe('saved-document');
      expect(calls).toEqual([]);
      const save = await bridge.execute({ operation: 'project_save', params: {} });
      expect(save.reason).toBe('project_load_failed');
      expect(save.nextAction).toEqual({ tool: 'project_recover', input: { project: source, action: 'inspect' } });
      bridge.absApplyInProgress = true;
      const blocked = await bridge.execute({ operation: 'abs_recovery', params: request });
      expect(blocked.reason).toBe('abs_apply_in_progress');
    } finally { window['path'] = priorPath; }
  });
});
