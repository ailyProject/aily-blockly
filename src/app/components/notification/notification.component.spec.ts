import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { BehaviorSubject } from 'rxjs';
import { NoticeService, UiService } from '@core/app-shell/public-api';
import { NotificationComponent } from './notification.component';

describe('NotificationComponent progress animation', () => {
  let component: NotificationComponent;
  let nextFrame: FrameRequestCallback;
  let cancelFrame: jasmine.Spy;

  beforeEach(() => {
    component = new NotificationComponent(
      {} as any,
      { detectChanges: jasmine.createSpy('detectChanges') } as unknown as ChangeDetectorRef,
      {} as any,
    );
    spyOn(performance, 'now').and.returnValue(1000);
    spyOn(window, 'requestAnimationFrame').and.callFake(callback => {
      nextFrame = callback;
      return 1;
    });
    cancelFrame = spyOn(window, 'cancelAnimationFrame');
  });

  afterEach(() => component.ngOnDestroy());

  it('never goes negative when a shared frame timestamp predates a long render', () => {
    component.startProgressAnimation(100);
    nextFrame(400);
    expect(component.progressValue).toBe(0);
    nextFrame(1000);
    expect(component.progressValue).toBe(0);
    nextFrame(1150);
    expect(component.progressValue).toBe(75);
    nextFrame(1300);
    expect(component.progressValue).toBe(100);
    expect(component.targetProgress).toBe(100);
  });

  it('keeps a decreasing or interrupted progress animation within its endpoints', () => {
    component.progressValue = 100;
    component.startProgressAnimation(0);
    nextFrame(400);
    expect(component.progressValue).toBe(100);
    nextFrame(1150);
    expect(component.progressValue).toBe(25);
    component.startProgressAnimation(50);
    expect(cancelFrame).toHaveBeenCalled();
    nextFrame(1300);
    expect(component.progressValue).toBe(50);
  });

  it('recovers from an invalid starting value and clamps invalid targets', () => {
    for (const initial of [-442, 300, NaN, Infinity]) {
      component.progressValue = initial;
      component.startProgressAnimation(120);
      nextFrame(400);
      expect(component.progressValue).toBeGreaterThanOrEqual(0);
      expect(component.progressValue).toBeLessThanOrEqual(100);
      nextFrame(1300);
      expect(component.progressValue).toBe(100);
    }
    for (const target of [-1, NaN, Infinity]) {
      component.startProgressAnimation(target);
      nextFrame(1300);
      expect(component.progressValue).toBe(0);
    }
  });

  it('renders bounded start, middle and final frames in the real notification template', async () => {
    const stateSubject = new BehaviorSubject<any>(null);
    await TestBed.configureTestingModule({
      imports: [NotificationComponent, TranslateModule.forRoot()],
      providers: [
        { provide: NoticeService, useValue: { stateSubject } },
        { provide: UiService, useValue: {} },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotificationComponent);
    fixture.detectChanges();
    stateSubject.next({ state: 'doing', title: 'Download', text: 'Progress', progress: 100 });
    fixture.componentInstance.startProgressAnimation(100);
    // Angular's render scheduler also requests frames. Retain this animation's
    // callback so scheduler callbacks cannot replace the controlled test frame.
    const animateFrame = nextFrame;
    const percent = () => fixture.nativeElement.querySelector('.num-box').textContent.trim();
    animateFrame(400);
    expect(percent()).toBe('0%');
    animateFrame(1150);
    expect(percent()).toBe('75%');
    animateFrame(1300);
    expect(percent()).toBe('100%');
    fixture.destroy();
  });

  it('sizes short/long notices and action buttons without synchronous layout reads during progress updates', async () => {
    const stateSubject = new BehaviorSubject<any>(null);
    await TestBed.configureTestingModule({
      imports: [NotificationComponent, TranslateModule.forRoot()],
      providers: [{provide: NoticeService, useValue: {stateSubject}}, {provide: UiService, useValue: {}}],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotificationComponent);
    fixture.detectChanges();
    const reads = spyOn(Element.prototype, 'getBoundingClientRect').and.callThrough();
    const update = (data: any) => {
      reads.calls.reset(); stateSubject.next(data);
      expect(reads).not.toHaveBeenCalled();
      return fixture.nativeElement.querySelector('.notification-box') as HTMLElement;
    };
    let box = update({state: 'doing', title: 'A', text: 'B', progress: 10});
    expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(250);
    expect(box.getBoundingClientRect().width).toBeLessThanOrEqual(252);
    box = update({state: 'doing', title: 'Download', text: 'Long filename '.repeat(40), progress: 20, stop() {}});
    expect(box.getBoundingClientRect().width).toBeLessThanOrEqual(450);
    expect(box.getBoundingClientRect().width).toBeGreaterThanOrEqual(448);
    const text = box.querySelector('.text') as HTMLElement;
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    box = update({state: 'error', title: 'Error', text: 'Retry', onRetry() {}, detail: 'log'});
    expect(box.querySelectorAll('.btns .btn').length).toBe(3);
    expect(box.getBoundingClientRect().width).toBeLessThanOrEqual(450);
    fixture.destroy();
  });
});
