import { ChangeDetectorRef } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { FooterComponent } from './footer.component';
import type { ActionState } from '../../../services/ui.service';
import type { ApplicationUpdateInfo, ApplicationUpdateStatus } from '../../../services/update.service';

describe('FooterComponent background update indicator', () => {
  function createComponent() {
    const uiService = {
      stateSubject: new Subject<ActionState>(),
      terminalIsOpen: false,
      currentBottomTab: '',
      turnBottomSider: jasmine.createSpy('turnBottomSider'),
    };
    const updateService = {
      updateStatus: new BehaviorSubject<ApplicationUpdateStatus>(''),
      updateProgress: new BehaviorSubject<number>(0),
      activeUpdateInfo: new BehaviorSubject<ApplicationUpdateInfo | null>(null),
      openUpdateDialog: jasmine.createSpy('openUpdateDialog'),
    };
    const changeDetector = {
      markForCheck: jasmine.createSpy('markForCheck'),
      detectChanges: jasmine.createSpy('detectChanges'),
    } as unknown as ChangeDetectorRef;
    const translate = {
      instant: (key: string, params: Record<string, unknown>) => `${key}:${params['version']}:${params['progress']}`,
    };
    const component = new FooterComponent(
      uiService as never,
      changeDetector,
      updateService as never,
      translate as never,
    );
    return { component, updateService };
  }

  it('shows progress while downloading and opens the update dialog on click', () => {
    const { component, updateService } = createComponent();

    updateService.activeUpdateInfo.next({ version: '1.2.3' });
    updateService.updateStatus.next('downloading');
    updateService.updateProgress.next(46.8);

    expect(component.showUpdateIndicator).toBeTrue();
    expect(component.updateProgress).toBe(46);
    expect(component.updateIndicatorTooltip).toContain('DOWNLOADING_TOOLTIP:1.2.3:46');

    const blur = jasmine.createSpy('blur');
    component.openUpdateDialog({ detail: 1, currentTarget: { blur } } as unknown as MouseEvent);
    expect(blur).toHaveBeenCalled();
    expect(updateService.openUpdateDialog).toHaveBeenCalled();
    component.ngOnDestroy();
  });

  it('keeps focus available for keyboard activation', () => {
    const { component, updateService } = createComponent();
    const blur = jasmine.createSpy('blur');

    component.openUpdateDialog({ detail: 0, currentTarget: { blur } } as unknown as MouseEvent);

    expect(blur).not.toHaveBeenCalled();
    expect(updateService.openUpdateDialog).toHaveBeenCalled();
    component.ngOnDestroy();
  });

  it('keeps the indicator visible and marks it ready after download completion', () => {
    const { component, updateService } = createComponent();

    updateService.activeUpdateInfo.next({ version: '1.2.3' });
    updateService.updateProgress.next(100);
    updateService.updateStatus.next('downloaded');

    expect(component.showUpdateIndicator).toBeTrue();
    expect(component.updateIndicatorTooltip).toContain('UPDATE_READY_TOOLTIP:1.2.3:100');
    component.ngOnDestroy();
  });
});
