import { ChildToolNativeObserverComponent } from './child-tool-native-observer.component';
import { Subject } from 'rxjs';

describe('Native observer iframe transport', () => {
  let previous: unknown, component: ChildToolNativeObserverComponent, changed: () => void;
  let invoke: jasmine.Spy, post: jasmine.Spy, unsubscribe: jasmine.Spy, source: any;
  let theme: any, translate: any, markForCheck: jasmine.Spy;
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  beforeEach(() => {
    previous = (window as any).electronAPI;
    invoke = jasmine.createSpy('observeNative').and.callFake(async input => input.action === 'stop' ? { ok: true }
      : { ok: true, html: '<p>installed view</p>', snapshot: { runId: 'run-A', outcome: 'running' } });
    unsubscribe = jasmine.createSpy('unsubscribe');
    (window as any).electronAPI = { childToolSession: { observeNative: invoke,
      onNativeObserverChanged(callback: () => void) { changed = callback; return unsubscribe; } } };
    theme = { theme: () => 'dark', themeChanged$: new Subject() };
    translate = { currentLang: 'zh_cn', onLangChange: new Subject() };
    markForCheck = jasmine.createSpy('markForCheck');
    component = new ChildToolNativeObserverComponent({ bypassSecurityTrustHtml: (html: string) => html } as any,
      { run: (fn: () => void) => fn() } as any, theme, translate, { markForCheck } as any);
    component.toolId = 'simulator-debugger'; component.sessionId = 'conversation-A';
    post = jasmine.createSpy('postMessage'); source = { postMessage: post };
    component.frame = { nativeElement: { contentWindow: source } } as any;
  });
  afterEach(() => { component.ngOnDestroy(); (window as any).electronAPI = previous; });

  it('loads a passive document, refreshes on invalidation and forwards only exact-frame messages', async () => {
    component.ngOnChanges(); await settle();
    expect(invoke.calls.allArgs().map(args => args[0].action)).toEqual(['document', 'snapshot']);
    expect(markForCheck).toHaveBeenCalled(); // Async iframe appears while the Dock parent is otherwise unchanged.
    expect(post.calls.mostRecent().args[0].snapshot.runId).toBe('run-A');
    for (const event of [
      { source: {}, origin: 'null' }, { source, origin: 'https://untrusted.test' },
    ]) (component as any).onMessage({ ...event, data: { channel: 'aily-native-observer-v1', type: 'stop', id: 1, runId: 'run-A' } });
    expect(invoke.calls.count()).toBe(2);
    (component as any).onMessage({ source, origin: 'null', data: { channel: 'aily-native-observer-v1', type: 'stop', id: 1, runId: 'old-run' } });
    expect(invoke.calls.count()).toBe(2);
    (component as any).onMessage({ source, origin: 'null', data: { channel: 'aily-native-observer-v1', type: 'stop', id: 2, runId: 'run-A' } });
    await settle();
    expect(invoke.calls.mostRecent().args[0]).toEqual({ toolId: 'simulator-debugger', action: 'stop', sessionId: 'conversation-A', runId: 'run-A' });
    expect(post.calls.mostRecent().args[0].type).toBe('stop-result');
    changed(); await settle(); expect(invoke.calls.mostRecent().args[0].action).toBe('snapshot');
    component.ngOnDestroy(); expect(unsubscribe).toHaveBeenCalled();
    expect(invoke.calls.allArgs().every(args => ['document', 'snapshot', 'stop'].includes(args[0].action))).toBeTrue();
  });

  it('does not display a late document from the previous conversation', async () => {
    let old!: (result: unknown) => void;
    invoke.and.callFake(input => input.action === 'document' && input.sessionId === 'conversation-A'
      ? new Promise(resolve => old = resolve)
      : Promise.resolve({ ok: true, html: 'new-B', snapshot: { runId: 'run-B' } }));
    component.ngOnChanges(); component.sessionId = 'conversation-B'; component.ngOnChanges(); await settle();
    old({ ok: true, html: 'old-A', snapshot: { runId: 'run-A' } }); await settle();
    expect(component.html).toBe('new-B');
    expect(post.calls.mostRecent().args[0].snapshot.runId).toBe('run-B');
  });

  it('follows host theme and language without reloading or acquiring a Runtime', async () => {
    component.ngOnChanges(); await settle();
    expect(post.calls.mostRecent().args[0].context).toEqual({ theme: 'dark', language: 'zh_cn' });
    theme.theme = () => 'light'; theme.themeChanged$.next('light');
    translate.currentLang = 'en'; translate.onLangChange.next({ lang: 'en' });
    expect(post.calls.mostRecent().args[0].context).toEqual({ theme: 'light', language: 'en' });
    expect(invoke.calls.count()).toBe(2);
    component.ngOnDestroy(); const count = post.calls.count();
    theme.themeChanged$.next('dark'); expect(post.calls.count()).toBe(count);
  });

  it('reports missing assets to the host instead of leaving its loading overlay forever', async () => {
    invoke.and.resolveTo({ ok: false, errorCode: 'OBSERVER_UNAVAILABLE' });
    const failed = jasmine.createSpy('failed'); component.failed.subscribe(failed);
    component.ngOnChanges(); await settle();
    expect(failed).toHaveBeenCalledWith('OBSERVER_UNAVAILABLE');
    expect(component.html).toBeNull(); expect(markForCheck).toHaveBeenCalled();
  });
});
