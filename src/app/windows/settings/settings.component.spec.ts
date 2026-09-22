import { fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { SettingsComponent } from './settings.component';

describe('SettingsComponent development mode preference', () => {
  function createComponent(configService: {
    getDevelopmentModePreference: jasmine.Spy;
    setDevelopmentModePreference: jasmine.Spy;
  }): SettingsComponent {
    return new SettingsComponent(
      {} as any,
      {} as any,
      {} as any,
      { ...configService, configReloaded$: new Subject<void>() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { observe: () => new Subject() } as any,
      { markForCheck() {} } as any,
      {} as any,
    );
  }

  it('reads the current preference from ConfigService', () => {
    const configService = {
      getDevelopmentModePreference: jasmine.createSpy('getDevelopmentModePreference').and.returnValue('coder'),
      setDevelopmentModePreference: jasmine.createSpy('setDevelopmentModePreference').and.returnValue(Promise.resolve('coder')),
    };
    const component = createComponent(configService);

    expect(component.developmentModePreference).toBe('coder');
  });

  it('saves preference changes immediately from settings', () => {
    const configService = {
      getDevelopmentModePreference: jasmine.createSpy('getDevelopmentModePreference').and.returnValue('auto'),
      setDevelopmentModePreference: jasmine.createSpy('setDevelopmentModePreference').and.returnValue(Promise.resolve('blockly')),
    };
    const component = createComponent(configService);

    component.onDevelopmentModePreferenceChange('blockly');

    expect(configService.setDevelopmentModePreference).toHaveBeenCalledWith('blockly', 'settings');
  });
});

describe('Settings cleanup dialogs', () => {
  let component: any;
  let preview: Subject<any>;
  let process: Subject<any>;
  let afterClose: Subject<void>;
  let originalFsp: any;

  beforeEach(() => {
    originalFsp = window['fsp'];
    window['fsp'] = { directoryStats: jasmine.createSpy('directoryStats').and.resolveTo({ count: 100, size: 1000 }) };
    preview = new Subject();
    process = new Subject();
    afterClose = new Subject();
    component = Object.create(SettingsComponent.prototype);
    Object.assign(component, {
      cleanupDialog: null, cleanupModalRef: null, cacheClearing: null, dependencyRemoving: null,
      cacheProgressTimer: null, destroyed: false, cleanupDestroyed$: new Subject<void>(),
      cacheStatsRequestId: 0,
      cmdService: { spawn: jasmine.createSpy('spawn').and.returnValues(preview, process) },
      modal: {
        create: jasmine.createSpy('create').and.returnValue({
          afterClose,
          updateConfig: jasmine.createSpy('updateConfig'),
          close: jasmine.createSpy('close').and.callFake(() => afterClose.next()),
          destroy: jasmine.createSpy('destroy'),
        }),
      },
      cdr: { detectChanges: jasmine.createSpy('detectChanges') },
      translateService: { instant: (key: string) => key },
      settingsService: { boardList: [], toolList: [], sdkList: [], compilerList: [] },
      coderDependencySubscription: new Subject().subscribe(),
      configReloadSubscription: new Subject().subscribe(),
    });
    spyOn(component, 'getAilyBuilderPath').and.returnValue('/cache');
    spyOn(component, 'sendLog');
    spyOn(component, 'loadCacheStats').and.resolveTo();
  });

  afterEach(() => {
    component.ngOnDestroy();
    window['fsp'] = originalFsp;
  });

  function finishPreview() {
    // JSON may span several process output chunks.
    preview.next({ type: 'stdout', data: '{"total":' });
    preview.next({ type: 'stdout', data: '{"deletedFiles":20}}' });
    preview.next({ type: 'close', code: 0 });
    preview.complete();
    flushMicrotasks();
  }

  it('requires confirmation for all cleanup and treats dismissal as cancellation', () => {
    component.clearCache('all');
    expect(component.cleanupDialog.phase).toBe('confirm');
    expect(component.modal.create.calls.mostRecent().args[0].nzFooter).toBeNull();
    expect(component.cmdService.spawn).not.toHaveBeenCalled();
    component.onCleanupDialogAction('close');
    expect(component.cleanupDialog).toBeNull();

    component.removeGlobalDependencies('all');
    expect(component.cleanupDialog.kind).toBe('dependencies');
    expect(component.cleanupDialog.phase).toBe('confirm');
  });

  for (const option of ['all', 'unused-7', 'unused-30']) {
    it(`shows file progress for ${option} and reaches 100 only on a successful exit`, fakeAsync(() => {
      component.clearCache(option);
      if (option === 'all') component.onCleanupDialogAction('confirm');
      expect(component.cleanupDialog.phase).toBe('running');
      expect(component.cleanupDialogButtons).toEqual([]);
      expect(component.cmdService.spawn.calls.first().args[1]).toEqual(['cache', 'clear', `--${option}`, '--dry-run', '--json']);
      finishPreview();
      expect(component.cmdService.spawn.calls.mostRecent().args[1]).toEqual(['cache', 'clear', `--${option}`]);

      window['fsp'].directoryStats.and.resolveTo({ count: 90, size: 900 });
      tick(750);
      flushMicrotasks();
      expect(component.cleanupDialog.percent).toBe(55);
      component.onCleanupDialogAction('close');
      component.clearCache('all');
      component.removeGlobalDependencies('all');
      expect(component.cleanupDialog.phase).toBe('running');
      expect(component.cmdService.spawn).toHaveBeenCalledTimes(2);

      window['fsp'].directoryStats.and.resolveTo({ count: 80, size: 800 });
      tick(750);
      flushMicrotasks();
      expect(component.cleanupDialog.percent).toBe(99);
      process.next({ type: 'close', code: 0 });
      process.complete();
      expect(component.cleanupDialog.percent).toBe(100);
      expect(component.cleanupDialog.phase).toBe('success');
      expect(component.cacheClearing).toBeNull();
      expect(component.cacheProgressTimer).toBeNull();
      expect(component.loadCacheStats).toHaveBeenCalledTimes(1);
    }));
  }

  for (const failure of ['event', 'observable', 'exit']) {
    it(`settles ${failure} failures without reporting completion`, fakeAsync(() => {
      component.clearCache('unused-7');
      finishPreview();
      if (failure === 'observable') process.error(new Error('spawn failed'));
      else process.next(failure === 'event' ? { type: 'error', error: 'spawn failed' } : { type: 'close', code: 1 });
      expect(component.cleanupDialog.phase).toBe('error');
      expect(component.cleanupDialog.percent).toBeLessThan(100);
      expect(component.cacheClearing).toBeNull();
      expect(component.cacheProgressTimer).toBeNull();
      expect(component.cleanupDialogButtons.length).toBe(1);
    }));
  }

  it('does not delete when preview fails or when the window closes during preview', fakeAsync(() => {
    component.clearCache('unused-30');
    preview.error(new Error('preview failed'));
    flushMicrotasks();
    expect(component.cleanupDialog.phase).toBe('error');
    expect(component.cmdService.spawn).toHaveBeenCalledTimes(1);
    component.onCleanupDialogAction('close');

    component.cmdService.spawn.and.returnValue(new Subject());
    component.clearCache('unused-30');
    component.ngOnDestroy();
    flushMicrotasks();
    expect(component.cmdService.spawn).toHaveBeenCalledTimes(2);
  }));

  it('ignores a directory scan that finishes after cleanup', fakeAsync(() => {
    component.clearCache('unused-7');
    finishPreview();
    let finishScan: (stats: any) => void;
    window['fsp'].directoryStats.and.returnValue(new Promise(resolve => { finishScan = resolve; }));
    tick(750);
    process.next({ type: 'close', code: 0 });
    component.onCleanupDialogAction('close');
    finishScan!({ count: 0 });
    flushMicrotasks();
    expect(component.cleanupDialog).toBeNull();
    expect(component.cacheProgressTimer).toBeNull();
  }));

  it('uses dependency progress and leaves failure retryable', fakeAsync(() => {
    let rejectRemoval: (error: Error) => void;
    let reportProgress: (percent: number) => void;
    component.npmService = {
      removeGlobalDependencies: jasmine.createSpy('remove').and.callFake((days, progress) => {
        expect(days).toBe(90);
        reportProgress = progress;
        return new Promise((resolve, reject) => { rejectRemoval = reject; });
      }),
    };
    component.removeGlobalDependencies('unused-90');
    reportProgress!(80);
    expect(component.cleanupDialog.percent).toBe(80);
    reportProgress!(10);
    expect(component.cleanupDialog.percent).toBe(80);
    rejectRemoval!(new Error('resource is busy'));
    flushMicrotasks();
    expect(component.cleanupDialog.phase).toBe('error');
    expect(component.dependencyRemoving).toBeNull();
    component.onCleanupDialogAction('close');

    component.npmService.removeGlobalDependencies.and.resolveTo({ packageNames: [], resourcePaths: [] });
    component.removeGlobalDependencies('unused-30');
    flushMicrotasks();
    expect(component.cleanupDialog.phase).toBe('success');
    expect(component.cleanupDialog.percent).toBe(100);
    expect(component.cleanupDialog.text).toBe('SETTINGS.FIELDS.DEPENDENCY_NONE_REMOVED');
  }));
});
