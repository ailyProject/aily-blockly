import { ChangeDetectorRef, SimpleChange, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChildToolPresentationComponent } from './child-tool-presentation.component';
import { CHILD_TOOL_NATIVE_PRESENTATION, CHILD_TOOL_PRESENTATION_OVERRIDES,
  CHILD_TOOL_PRESENTATION_PLATFORM, CHILD_TOOL_WEB_PRESENTATIONS } from './child-tool-presentation.providers';

// Exercise the real selector with explicit loader doubles; no tool Runtime,
// project, compiler, presentation component or product UI is started.
describe('Trusted per-tool presentation choice', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('allows an explicit Web simulator on a Native host and keeps other tools on the original Native path', async () => {
    const webType: Type<unknown> = class WebPresentation {};
    const nativeType: Type<unknown> = class NativePresentation {};
    let webLoads = 0, nativeLoads = 0;
    TestBed.configureTestingModule({ providers: [
      { provide: CHILD_TOOL_PRESENTATION_PLATFORM, useValue: 'native' },
      { provide: CHILD_TOOL_PRESENTATION_OVERRIDES, useValue: Object.freeze({ simulator: 'web' }) },
      { provide: CHILD_TOOL_NATIVE_PRESENTATION, useValue: async () => { nativeLoads++; return nativeType; } },
      { provide: CHILD_TOOL_WEB_PRESENTATIONS, useValue: { simulator: {
        load: async () => { webLoads++; return webType; }, inputs: () => ({ borrowedOriginalProject: true }),
      } } },
      { provide: ChangeDetectorRef, useValue: { markForCheck() {} } },
    ] });
    const component = TestBed.runInInjectionContext(() => new ChildToolPresentationComponent());
    component.toolId = 'simulator';
    component.ngOnChanges({ toolId: new SimpleChange('', 'simulator', true) });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(component.component).toBe(webType);
    expect(component.inputs).toEqual({ borrowedOriginalProject: true });
    expect(webLoads).toBe(1); expect(nativeLoads).toBe(0);
    component.toolId = 'serial-monitor';
    component.ngOnChanges({ toolId: new SimpleChange('simulator', 'serial-monitor', false) });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(component.component).toBe(nativeType);
    expect(component.inputs).toEqual({ toolId: 'serial-monitor', active: true });
    expect(webLoads).toBe(1); expect(nativeLoads).toBe(1); component.ngOnDestroy();
  });
});
