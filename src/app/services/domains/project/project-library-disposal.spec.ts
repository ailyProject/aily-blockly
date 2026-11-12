import { BehaviorSubject, Subject } from 'rxjs';
import { ProjectService } from './project.service';
import { ProjectLifecycleGate } from './project-lifecycle-gate';

describe('Blockly dependency discard belongs to editor disposal', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    const events: string[] = [];
    let mounted = true;
    Object.assign(service, {
      currentProjectPathSubject: new BehaviorSubject('/source'),
      stateSubject: new BehaviorSubject('loaded'),
      loadedBlocklyProjectPath: '/source',
      coderProjectsSubject: new BehaviorSubject([]), coderOperationsSubject: new BehaviorSubject(new Map()),
      projectLifecycle: new ProjectLifecycleGate(),
      messageService: { error: jasmine.createSpy('error'), warning: jasmine.createSpy('warning') },
      getProjectMode: () => 'blockly',
      stopProjectCommands: async () => { events.push('stop'); },
      closeInternal: async () => { events.push('close'); return true; },
      discardLibraryChanges: jasmine.createSpy('discard').and.callFake(async () => {
        expect(mounted).toBeFalse();
        expect(service.isProjectTransitionInProgress('/source')).toBeTrue();
        events.push('discard');
      }),
      rebuildBlocklyRuntimeAfterLibraryChange: jasmine.createSpy('rebuild'),
    });
    const graph = jasmine.createSpy('graph').and.resolveTo(true);
    Object.defineProperty(service, 'application', { value: {
      hasActiveProjectMutation: () => false, closeConnectionGraphWindows: graph,
    } });
    Object.defineProperty(service, 'router', { value: { url: '/main/blockly-editor?path=source', navigate: jasmine.createSpy('navigate').and.callFake(async () => {
      events.push('dispose'); mounted = false; service.router.url = '/main/guide'; return true;
    }) } });
    return { service, events, graph, mounted: () => mounted };
  }

  it('holds lifecycle ownership through teardown and discard, without rebuilding the old canvas', async () => {
    const { service, events } = fixture();
    expect(await service.close()).toBeTrue();
    expect(events).toEqual(['stop', 'dispose', 'discard', 'close']);
    expect(service.rebuildBlocklyRuntimeAfterLibraryChange).not.toHaveBeenCalled();
    expect(service.isProjectTransitionInProgress('/source')).toBeFalse();
  });

  it('stays closing during slow dependency cleanup without announcing a project load', async () => {
    const { service, mounted } = fixture();
    const states: string[] = [];
    service.stateSubject.subscribe((state: string) => states.push(state));
    let finishDiscard!: () => void;
    let startedDiscard!: () => void;
    const discarding = new Promise<void>(resolve => { startedDiscard = resolve; });
    service.discardLibraryChanges.and.callFake(() => {
      startedDiscard();
      return new Promise<void>(resolve => { finishDiscard = resolve; });
    });
    const closing = service.close();
    await discarding;
    expect(mounted()).toBeFalse();
    expect(states).toEqual(['loaded', 'closing']);
    expect(service.isProjectOpening).toBeFalse();
    expect(service.getBlocklyProjectLoadStatus('/source').ready).toBeFalse();
    expect(service.loadedBlocklyProjectPath).toBe('');
    expect(service.loadingBlocklyProjectPath).toBe('');
    expect(await service.hasUnsavedChanges()).toBeFalse();
    expect(service.isProjectTransitionInProgress('/source')).toBeTrue();
    finishDiscard();
    expect(await closing).toBeTrue();
    expect(states).not.toContain('loading');
  });

  it('leaves the loaded canvas and library edits intact when a child window refuses close', async () => {
    const { service, graph, mounted } = fixture(); graph.and.resolveTo(false);
    expect(await service.close()).toBeFalse();
    expect(mounted()).toBeTrue(); expect(service.stateSubject.value).toBe('loaded');
    expect(service.discardLibraryChanges).not.toHaveBeenCalled();
  });

  it('does not discard if Angular refuses the editor teardown', async () => {
    const { service, mounted } = fixture(); service.router.navigate.and.resolveTo(false);
    expect(await service.close()).toBeFalse();
    expect(mounted()).toBeTrue(); expect(service.stateSubject.value).toBe('loaded');
    expect(service.discardLibraryChanges).not.toHaveBeenCalled();
  });

  it('retires recovery only after accepted teardown and disposes its short-lived admission', async () => {
    const { service, mounted } = fixture();
    const commit = jasmine.createSpy('recovery commit').and.callFake(async () => { expect(mounted()).toBeFalse(); });
    const dispose = jasmine.createSpy('recovery capability disposal');
    service.application.prepareBlocklyRecoveryDiscard = jasmine.createSpy('prepare while editor exists').and.callFake(async () => {
      expect(mounted()).toBeTrue(); return { commit, dispose };
    });
    expect(await service.close()).toBeTrue();
    expect(commit).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps recovery restorable when the router vetoes an otherwise accepted departure', async () => {
    const { service } = fixture();
    const commit = jasmine.createSpy('must not discard').and.resolveTo(); const dispose = jasmine.createSpy('dispose');
    service.application.prepareBlocklyRecoveryDiscard = async () => ({ commit, dispose });
    service.router.navigate.and.resolveTo(false);
    expect(await service.close()).toBeFalse(); expect(commit).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1);
  });

  for (const decision of ['cancel', 'focus']) it(`retains the source activation after target lock ${decision}`, async () => {
    const { service, mounted } = fixture();
    const previous = window['projectLock'];
    window['projectLock'] = { tryAcquire: async () => ({ ok: false, conflict: true, holder: { pid: 123 } }),
      focusProcess: jasmine.createSpy('focus').and.resolveTo() };
    service.electronService = { exists: () => true, isElectron: true };
    service.ensureProjectModeAllowed = async () => true;
    service.promptProjectLockConflict = async () => decision;
    try {
      expect(await service.projectOpenInternal('/target', {}, () => {})).toBeFalse();
      expect(service.stateSubject.value).toBe('loaded'); expect(mounted()).toBeTrue();
      expect(service.discardLibraryChanges).not.toHaveBeenCalled();
      expect(service.router.navigate).not.toHaveBeenCalled();
    } finally { window['projectLock'] = previous; }
  });

  it('keeps failed dependency recovery retryable without reviving the retired canvas', async () => {
    const { service, mounted } = fixture();
    service.discardLibraryChanges.and.rejectWith(new Error('EACCES: dependency tree is locked'));
    expect(await service.close()).toBeFalse();
    expect(mounted()).toBeFalse(); expect(service.stateSubject.value).toBe('error');
    expect(service.blocklyProjectLoadFailure.error).toContain('EACCES');
    expect(service.isProjectTransitionInProgress('/source')).toBeFalse();
    service.discardLibraryChanges.and.resolveTo();
    expect(await service.close()).toBeTrue();
    expect(service.rebuildBlocklyRuntimeAfterLibraryChange).not.toHaveBeenCalled();
  });
});

describe('dependency-only persistence around library edits', () => {
  function fixture() {
    const service: any = Object.create(ProjectService.prototype), calls: string[] = [];
    const release = jasmine.createSpy('release'), lifecycleRelease = jasmine.createSpy('lifecycle release');
    const application: any = {
      hasActiveBlocklyBuildOrUpload: () => false, hasUnsavedBlocklyChanges: async () => false,
      prepareBlocklyLibraryEdit: async (_path: string, removed: string[]) => { application.removed = removed; calls.push('fence'); return { document: { pages: ['user-before-ai'] }, release, record: jasmine.createSpy('record') }; },
      captureBlocklyLibraryDocument: async () => ({ pages: ['after'] }),
      confirmBlocklyLibraryRestore: async (_offer: unknown, apply: () => Promise<void>) => { await apply(); return true; },
    };
    Object.defineProperty(service, 'currentProjectPath', {value:'/project',writable:true});
    Object.assign(service, { libraryChangesChanged: new Subject(),
      acquireProjectLifecycle: () => ({ release: lifecycleRelease }),
      save: async () => { calls.push('save-project'); return {success: true, projectSaved: true, generatedCodePublished: true}; },
      saveLibraryChanges: async () => { calls.push('save-dependencies'); },
      ensureBlocklyLibraryRuntimeReady: async () => { calls.push('runtime'); },
    });
    Object.defineProperty(service, 'application', {value: application});
    const previous = window['libraryDependencies'];
    window['libraryDependencies'] = {
      historyBegin: async () => { calls.push('checkpoint'); return {token:'test-token'}; },
      prepare: async () => { calls.push('source-extraction'); },
      historyCommit: async () => { calls.push('commit'); return {changed:true}; },
      historyPreview: async () => ({ packages: ['@aily-project/lib-test'], changes: [] }),
      historyDiscard: jasmine.createSpy('discard').and.resolveTo(),
    };
    return {service,application,calls,release,lifecycleRelease,restore:()=>{window['libraryDependencies']=previous;}};
  }

  it('does not touch dependencies or the canvas when library undo confirmation is cancelled', async () => {
    const f = fixture(), record = jasmine.createSpy('record');
    f.application.prepareBlocklyLibraryEdit = async () => ({ document: { pages: ['before'] }, release: f.release, record });
    f.application.confirmBlocklyLibraryRestore = jasmine.createSpy('confirm').and.resolveTo(false);
    window['libraryDependencies'].historyRestore = jasmine.createSpy('restore');
    try {
      const { token } = await f.service.beginLibraryMutation(['@aily-project/lib-test']);
      await f.service.finishLibraryMutation(token);
      const restores = f.release.calls.count(), saves = f.calls.filter(call => call === 'save-project').length;
      expect(await record.calls.mostRecent().args[0](false)).toBeFalse();
      expect(window['libraryDependencies'].historyRestore).not.toHaveBeenCalled();
      expect(f.release.calls.count()).toBe(restores);
      expect(f.calls.filter(call => call === 'save-project').length).toBe(saves);
    } finally { f.restore(); }
  });

  it('saves only dependencies and preserves a dirty canvas through runtime synchronization', async () => {
    const f=fixture(); f.application.hasUnsavedBlocklyChanges = async () => true;
    try {
      const {token}=await f.service.beginLibraryMutation(['@aily-project/lib-test']);
      expect(f.calls).toEqual(['fence','save-dependencies','checkpoint']);
      expect(f.service.isLibraryMutationInProgress()).toBeTrue();
      await f.service.finishLibraryMutation(token);
      expect(f.calls).toEqual(['fence','save-dependencies','checkpoint','runtime','commit']);
      expect(f.release).toHaveBeenCalledTimes(1);expect(f.lifecycleRelease).toHaveBeenCalledTimes(1);
      expect(f.service.isLibraryMutationInProgress()).toBeFalse();
    } finally {f.restore();}
  });

  it('prepares AI-reconciled sources once without saving the project', async () => {
    const f = fixture();
    window['libraryDependencies'].discard = async () => { f.calls.push('reconcile'); return {}; };
    (f.service as any).acceptLibraryStatus = () => {};
    try {
      const { token } = await f.service.beginLibraryMutation(['@aily-project/lib-test']);
      await f.service.finishLibraryMutation(token, true);
      expect(f.calls).toEqual(['fence','save-dependencies','checkpoint','reconcile','source-extraction','runtime','commit']);
    } finally { f.restore(); }
  });

  it('ignores legacy full-save proof and preserves unsaved canvas content', async () => {
    const f=fixture(), previousFs=window['fs'];
    window['fs']={readFileSync:()=> 'hello'};
    const hash='sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    try {
      const {token}=await f.service.beginLibraryMutation(['@aily-project/lib-test'],{abi:hash,abs:hash,map:hash});
      expect(f.calls).toEqual(['fence','save-dependencies','checkpoint']);
      await f.service.abortLibraryMutation(token);
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {window['fs']=previousFs;f.restore();}
  });

  it('checks removal usage with normalized package names before npm starts', async () => {
    const f=fixture();
    try {
      const {token}=await f.service.beginLibraryMutation(['@aily-project/lib-test@1.0.0'],undefined,['@aily-project/lib-test@1.0.0']);
      expect(f.application.removed).toEqual(['@aily-project/lib-test']);
      await f.service.abortLibraryMutation(token);
    } finally {f.restore();}
  });

  it('does not admit npm after dependency persistence fails', async () => {
    const f=fixture();f.service.saveLibraryChanges=async()=>{throw new Error('dependency write failed');};
    try {
      await expectAsync(f.service.beginLibraryMutation(['@aily-project/lib-test'])).toBeRejectedWithError(/dependency write failed/);
      expect(f.calls).toEqual(['fence']);expect(f.lifecycleRelease).toHaveBeenCalledTimes(1);
    } finally {f.restore();}
  });

  it('releases input and lifecycle after runtime failure without hiding the error', async () => {
    const f=fixture();f.service.ensureBlocklyLibraryRuntimeReady=async()=>{throw new Error('runtime failure');};
    try {
      const {token}=await f.service.beginLibraryMutation(['@aily-project/lib-test']);
      await expectAsync(f.service.finishLibraryMutation(token)).toBeRejectedWithError('runtime failure');
      expect(f.release).toHaveBeenCalledTimes(1);expect(f.lifecycleRelease).toHaveBeenCalledTimes(1);
      expect(f.service.isLibraryMutationInProgress()).toBeFalse();
      expect(window['libraryDependencies'].historyDiscard).toHaveBeenCalledTimes(1);
    } finally {f.restore();}
  });

  it('native redo restores the latest canvas from immediately before undo, including later AI edits', async () => {
    const f = fixture();
    let current = { pages: ['user-before-ai'] };
    const record = jasmine.createSpy('record');
    f.application.prepareBlocklyLibraryEdit = async () => ({ document: structuredClone(current), release: f.release, record });
    f.application.captureBlocklyLibraryDocument = async () => structuredClone(current);
    Object.assign(f.service, {
      acceptLibraryStatus: () => {}, getPackageJson: async () => {}, getEffectivePackageText: () => '{}',
      getBlocklyLibraryRuntimeSignature: () => 'same-runtime', markBlocklyLibraryRuntimeReady: () => {},
      rebuildActiveBlocklyLibraryRuntime: async (_path: string, _text: string, _signature: string, document: typeof current) => {
        current = structuredClone(document);
      },
    });
    window['libraryDependencies'].historyRestore = jasmine.createSpy('restore').and.resolveTo({});
    try {
      const { token } = await f.service.beginLibraryMutation(['@aily-project/lib-test']);
      await f.service.finishLibraryMutation(token);
      // abs_apply may add library blocks after lib_add has completed; it does
      // not create a separate native Blockly event above the library event.
      const aiDocument = { pages: ['user-before-ai', 'json-parse-and-serial-output'] };
      current = structuredClone(aiDocument);
      const restore = record.calls.mostRecent().args[0];
      await restore(false);
      expect(current).toEqual({ pages: ['user-before-ai'] });
      await restore(true);
      expect(current).toEqual(aiDocument);
      await restore(false);
      await restore(true);
      expect(current).toEqual(aiDocument);
      await restore(false);
      const rebuild = f.service.rebuildActiveBlocklyLibraryRuntime;
      let failRuntime = true;
      f.service.rebuildActiveBlocklyLibraryRuntime = async (...args: unknown[]) => {
        if (failRuntime) { failRuntime = false; throw new Error('runtime failed'); }
        return rebuild(...args);
      };
      await expectAsync(restore(true)).toBeRejectedWithError('runtime failed');
      expect(current).toEqual({ pages: ['user-before-ai'] });
      expect(f.service.isLibraryMutationInProgress()).toBeFalse();
      await restore(true);
      expect(current).toEqual(aiDocument);
      expect(f.calls).not.toContain('save-project');
    } finally { f.restore(); }
  });

});

describe('AI dependency history retains the unsaved canvas', () => {
  const projectPath = '/history-project';
  function fixture() {
    const service: any = Object.create(ProjectService.prototype);
    const files = new Map([
      [`${projectPath}/package.json`, JSON.stringify({ name: 'project', dependencies: { '@aily-project/lib-a': '1.0.0' } })],
      [`${projectPath}/project.abi`, 'saved-abi'], [`${projectPath}/project.abs`, 'unapplied-abs'],
      [`${projectPath}/project.abs.map.json`, 'saved-map'],
    ]);
    const priorFs = window['fs'], priorDependencies = window['libraryDependencies'];
    window['fs'] = { existsSync: file => files.has(file), readFileSync: file => files.get(file) };
    const dependencies = window['libraryDependencies'] = {
      status: jasmine.createSpy('status').and.resolveTo({ dirty: false, busy: false }),
      discard: jasmine.createSpy('reconcile').and.resolveTo({}), prepare: jasmine.createSpy('prepare').and.resolveTo({}),
    };
    const edit = { document: { dirty: true }, usedLibraries: [] as string[], release: jasmine.createSpy('release') };
    const lease = { release: jasmine.createSpy('release lifecycle') };
    const application = {
      hasActiveBlocklyBuildOrUpload: () => false,
      confirmBlocklyLibraryRestore: jasmine.createSpy('confirm').and.callFake(async (_offer, apply) => { await apply(); return true; }),
      prepareBlocklyLibraryEdit: jasmine.createSpy('capture live').and.resolveTo(edit),
    };
    Object.defineProperties(service, { currentProjectPath: { value: projectPath }, application: { value: application } });
    Object.assign(service, { acquireProjectLifecycle: () => lease, isSameProjectPath: (a, b) => a === b,
      acceptLibraryStatus: () => {}, ensureBlocklyLibraryRuntimeReady: jasmine.createSpy('refresh').and.resolveTo(),
      save: jasmine.createSpy('save').and.throwError('Must not save canvas'), libraryChangesChanged: new Subject() });
    return { service, files, edit, lease, application, dependencies,
      close: () => { if (service.libraryHistoryNavigation) service.releaseLibraryHistoryNavigation(service.libraryHistoryNavigation.token);
        window['fs'] = priorFs; window['libraryDependencies'] = priorDependencies; } };
  }
  it('reconciles directly without confirmation, saving or replacing the live document', async () => {
    const f = fixture();
    try {
      const { token } = await f.service.beginLibraryHistoryNavigation(['package.json', 'package-lock.json']);
      expect(f.service.isLibraryMutationInProgress()).toBeTrue();
      expect(f.application.confirmBlocklyLibraryRestore).not.toHaveBeenCalled();
      f.files.set(`${projectPath}/package.json`, JSON.stringify({ name: 'project', dependencies: {} }));
      await f.service.synchronizeLibraryHistoryNavigation(token, ['package.json']);
      expect(f.dependencies.discard).toHaveBeenCalledOnceWith(projectPath, { reconcile: true, historyRestored: true });
      expect(f.service.ensureBlocklyLibraryRuntimeReady).toHaveBeenCalledOnceWith(projectPath);
      expect(f.service.save).not.toHaveBeenCalled();
      expect(f.files.get(`${projectPath}/project.abi`)).toBe('saved-abi');
      expect(f.files.get(`${projectPath}/project.abs`)).toBe('unapplied-abs');
      expect(f.edit.document).toEqual({ dirty: true });
      f.service.releaseLibraryHistoryNavigation(token);
      expect(f.edit.release).toHaveBeenCalledTimes(1); expect(f.lease.release).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
  it('pending dependency changes release the editor without prompting or reconciling', async () => {
    const f = fixture(); f.dependencies.status.and.resolveTo({ dirty: true, busy: false });
    try {
      await expectAsync(f.service.beginLibraryHistoryNavigation(['package.json'])).toBeRejectedWithError('请先处理待完成的库依赖变更。');
      expect(f.application.confirmBlocklyLibraryRestore).not.toHaveBeenCalled();
      expect(f.edit.release).toHaveBeenCalledTimes(1);
      expect(f.lease.release).toHaveBeenCalledTimes(1);
      expect(f.dependencies.discard).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  for (const conflict of ['code', 'settings', 'used-library', 'write-set']) it(`rejects ${conflict} before npm and permits history rollback`, async () => {
    const f = fixture();
    try {
      const { token } = await f.service.beginLibraryHistoryNavigation(['package.json']);
      const old = new Map(f.files);
      if (conflict === 'code') f.files.set(`${projectPath}/project.abs`, 'external candidate');
      if (conflict === 'settings') f.files.set(`${projectPath}/package.json`, '{"name":"changed"}');
      if (conflict === 'used-library') { f.edit.usedLibraries.push('@aily-project/lib-a'); f.files.set(`${projectPath}/package.json`, '{"name":"project"}'); }
      await expectAsync(f.service.synchronizeLibraryHistoryNavigation(token, [conflict === 'write-set' ? 'project.abs' : 'package.json'])).toBeRejected();
      expect(f.dependencies.discard).not.toHaveBeenCalled();
      for (const [file, content] of old) f.files.set(file, content);
      await f.service.synchronizeLibraryHistoryNavigation(token, ['package.json']);
      expect(f.dependencies.discard).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
});
