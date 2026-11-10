import { TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { UiService } from '@core/app-shell/public-api';
import { ToolContainerComponent } from './tool-container.component';

describe('ToolContainerComponent close control', () => {
  it('exposes a named focusable button with a title-bar hit target and emits the close request', () => {
    TestBed.configureTestingModule({
      imports: [ToolContainerComponent, TranslateModule.forRoot()],
      providers: [{ provide: UiService, useValue: {} }],
    });
    const translation = TestBed.inject(TranslateService);
    translation.setTranslation('en', { COMMON: { CLOSE: 'Close' } });
    translation.use('en');
    const fixture = TestBed.createComponent(ToolContainerComponent);
    fixture.componentRef.setInput('title', 'Aily Simulator');
    const host: HTMLElement = fixture.nativeElement;
    host.style.cssText = 'display: block; width: 320px; height: 160px;';
    const closeRequested = jasmine.createSpy('closeRequested');
    fixture.componentInstance.closeEvent.subscribe(closeRequested);
    fixture.detectChanges();

    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    expect(button).not.toBeNull();
    expect(button.type).toBe('button');
    button.focus();
    expect(document.activeElement).toBe(button);

    const { top, right, bottom, left } = button.getBoundingClientRect();
    const content = host.querySelector<HTMLElement>('.content')!;
    expect(bottom).toBeLessThanOrEqual(content.getBoundingClientRect().top);
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2) as HTMLElement;
    expect(button.contains(hit)).toBeTrue();
    hit.click();
    expect(closeRequested).toHaveBeenCalledTimes(1);
  });
});
