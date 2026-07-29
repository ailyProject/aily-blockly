import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostBinding,
  Input,
  Output,
  computed,
  effect,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { NzResizableModule, type NzResizeEvent } from 'ng-zorro-antd/resizable';
import { BehaviorSubject, switchMap } from 'rxjs';

import { MainUiAutomationService } from '../../../../services/main-ui-automation.service';
import {
  SubappActivityService,
  type SubappActivity,
} from '../../../../services/subapp-activity.service';
import { ChildToolSurfaceHostComponent } from '../../../child-tool-surface-host/child-tool-surface-host.component';

@Component({
  selector: 'aily-chat-subapp-dock',
  imports: [CommonModule, TranslateModule, NzResizableModule, ChildToolSurfaceHostComponent],
  templateUrl: './chat-subapp-dock.component.html',
  styleUrl: './chat-subapp-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSubappDockComponent {
  readonly minWidth = 280;
  readonly maxWidth = 480;
  dockWidth = 320;

  @Output() readonly expandedChange = new EventEmitter<boolean>();

  private readonly activityService = inject(SubappActivityService);
  private readonly mainUiAutomation = inject(MainUiAutomationService);
  private readonly sessionIdSubject = new BehaviorSubject<string>('');
  private lastReportedExpanded: boolean | null = null;

  private readonly sessionActivities = toSignal(
    this.sessionIdSubject.pipe(
      switchMap(sessionId => this.activityService.activitiesForSession$(sessionId)),
    ),
    { initialValue: [] as readonly SubappActivity[] },
  );

  readonly expandedActivities = computed(() =>
    this.sessionActivities().filter(activity => activity.surfaceState === 'expanded'),
  );

  constructor() {
    effect(() => {
      const expanded = this.expandedActivities().length > 0;
      if (expanded === this.lastReportedExpanded) {
        return;
      }
      this.lastReportedExpanded = expanded;
      this.expandedChange.emit(expanded);
    });
  }

  @HostBinding('class.is-open')
  get isOpen(): boolean {
    return this.expandedActivities().length > 0;
  }

  @HostBinding('style.flex-basis.px')
  get hostFlexBasis(): number {
    return this.isOpen ? this.dockWidth : 0;
  }

  @HostBinding('style.width.px')
  get hostWidth(): number {
    return this.isOpen ? this.dockWidth : 0;
  }

  @Input()
  set sessionId(value: string | null | undefined) {
    this.sessionIdSubject.next(String(value || '').trim());
  }

  collapse(activity: SubappActivity): void {
    this.activityService.setSurfaceState(activity.sessionId, activity.toolId, 'collapsed');
  }

  onResize(event: NzResizeEvent): void {
    if (typeof event.width !== 'number') return;
    this.dockWidth = Math.max(this.minWidth, Math.min(this.maxWidth, Math.round(event.width)));
  }

  async openFull(activity: SubappActivity): Promise<void> {
    await this.mainUiAutomation.openChildApp({
      toolId: activity.toolId,
      mode: 'embedded',
    });
  }

  runtimeLabel(activity: SubappActivity): string {
    switch (activity.runtimeState) {
      case 'ready':
        return 'Runtime ready';
      case 'starting':
        return 'Runtime starting';
      case 'error':
        return 'Runtime error';
      case 'stopped':
        return 'Runtime stopped';
      default:
        return 'Runtime status unknown';
    }
  }

  invocationLabel(activity: SubappActivity): string {
    switch (activity.invocationState) {
      case 'running':
        return 'Agent running';
      case 'succeeded':
        return 'Last call succeeded';
      case 'failed':
        return 'Last call failed';
      case 'cancelled':
        return 'Last call cancelled';
      default:
        return 'No active call';
    }
  }
}
