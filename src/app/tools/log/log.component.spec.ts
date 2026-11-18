import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { NzMessageService } from 'ng-zorro-antd/message';
import { UiService } from '@core/app-shell/public-api';
import { ElectronService, LogService, LogOptions, LogReadOptions } from '@core/platform/public-api';
import { ToolI18nService } from '@core/preferences/public-api';
import { ProjectService } from '@domain/project/public-api';
import { LogComponent } from './log.component';

describe('通知定位虚拟日志', () => {
  let fixture: ComponentFixture<LogComponent>;
  let entries: LogOptions[];
  let updates: Subject<LogOptions>;
  let reads: jasmine.Spy;

  async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 4000;
    while (!check() && Date.now() < deadline) {
      fixture.detectChanges();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(check()).toBeTrue();
  }

  beforeEach(async () => {
    entries = Array.from({ length: 1200 }, (_, i) => ({
      title: '编译', detail: `output-${i}\n${'variable-height line\n'.repeat(i % 6)}`,
      timestamp: 1000 + i, state: i === 80 ? 'warn' : 'info', mergeKey: `entry-${i}`,
    }));
    updates = new Subject<LogOptions>();
    reads = jasmine.createSpy('readPage').and.callFake(async (options: LogReadOptions) => {
      const limit = options.limit || 500;
      const end = options.mode === 'before' ? options.beforeOffset! : entries.length;
      const start = options.mode === 'after' ? options.afterOffset! : 0;
      const matches = entries.slice(start, end).filter(item =>
        (!options.errorsOnly || item.state === 'error') && (!options.keyword || item.detail!.includes(options.keyword)));
      const page = options.mode === 'after' ? matches.slice(0, limit) : matches.slice(-limit);
      return { generation: 0, entries: page, beforeOffset: Math.max(0, end - page.length), nextOffset: entries.length,
        hasMore: options.mode !== 'after' && end > page.length };
    });
    await TestBed.configureTestingModule({
      imports: [LogComponent, TranslateModule.forRoot()],
      providers: [
        { provide: LogService, useValue: { stateSubject: updates, readPage: reads, clear: async () => { entries = []; } } },
        { provide: NzMessageService, useValue: { error: jasmine.createSpy('error') } },
        { provide: UiService, useValue: {} },
        { provide: ProjectService, useValue: {} },
        { provide: ElectronService, useValue: {} },
        { provide: ToolI18nService, useValue: { load: async () => {} } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LogComponent);
    Object.assign(fixture.nativeElement.style, { position: 'absolute', top: '0', width: '600px', height: '240px' });
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  function focusedRowIsAtTop(): boolean {
    const box = fixture.nativeElement.querySelector('.log-box')?.getBoundingClientRect();
    const row = fixture.nativeElement.querySelector('.item.focused')?.getBoundingClientRect();
    return !!box && !!row && Math.abs(row.top - box.top) < 3;
  }

  it('首次加载时定位较早的变高日志，清除筛选，并保持后续输出不抢走位置', async () => {
    const component = fixture.componentInstance;
    component.onLogSearchChange('unrelated');
    component.onErrorFilterChange(true);
    await component.reveal(entries[80]);
    expect(component.logSearchKeyword).toBe('');
    expect(component.showOnlyErrors).toBeFalse();
    expect(reads.calls.allArgs().some(([options]) => options.mode === 'before')).toBeTrue();
    await waitFor(focusedRowIsAtTop);
    expect(fixture.nativeElement.querySelector('.item.focused').textContent).toContain('output-80');
    entries.push({ detail: 'later output', timestamp: 3000 });
    updates.next(entries.at(-1)!);
    await waitFor(() => component.logList.at(-1)?.detail === 'later output');
    expect(focusedRowIsAtTop()).toBeTrue();
    // 点击相同通知时，即使用户已经移到别处，也重新定位。
    component.virtualizer.scrollToIndex(1000, { align: 'start' });
    await component.reveal(entries[80]);
    await waitFor(focusedRowIsAtTop);
  });

  it('已清空的目标不重写旧错误，回到当前日志尾部', async () => {
    const component = fixture.componentInstance;
    const oldTarget = entries[80];
    await component.clear();
    entries.push({ title: 'current', detail: 'new output', timestamp: 5000 });
    await component.reveal(oldTarget);
    await waitFor(() => fixture.nativeElement.querySelector('.item .text')?.textContent === 'new output');
    expect(component.logList).toEqual(entries);
    expect(fixture.nativeElement.querySelector('.item.focused')).toBeNull();
  });
});
