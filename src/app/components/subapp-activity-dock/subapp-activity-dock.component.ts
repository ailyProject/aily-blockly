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

import { MainUiAutomationService } from '@integration/automation/public-api';
import { ToolI18nService } from '@core/preferences/public-api';
import {
  SubappActivityService,
  hasDockEmbeddedViewControl,
  type SubappActivity,
} from '@integration/subapps/public-api';
import { ChildToolSurfaceHostComponent } from '../../tools/child-tool-surface-host/child-tool-surface-host.component';
import { ChildToolNativeObserverComponent } from '../../tools/child-tool-native-observer/child-tool-native-observer.component';
import { getChildToolConfig } from '../../configs/tool.config';

@Component({
  selector: 'app-subapp-activity-dock',
  imports: [CommonModule, TranslateModule, NzResizableModule, ChildToolSurfaceHostComponent, ChildToolNativeObserverComponent],
  templateUrl: './subapp-activity-dock.component.html',
  styleUrl: './subapp-activity-dock.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubappActivityDockComponent {
  readonly hasEmbeddedViewControl = hasDockEmbeddedViewControl;
  readonly minWidth = 280;
  isNativeObserver(toolId: string): boolean { return getChildToolConfig(toolId)?.runtime?.observer === true; }
  readonly maxWidth = 480;
  dockWidth = 320;

  @Output() readonly expandedChange = new EventEmitter<boolean>();

  private readonly activityService = inject(SubappActivityService);
  private readonly mainUiAutomation = inject(MainUiAutomationService);
  private readonly toolI18n = inject(ToolI18nService);
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
      const activities = this.expandedActivities();
      for (const activity of activities) void this.toolI18n.load(activity.toolId);
      const expanded = activities.length > 0;
      if (expanded === this.lastReportedExpanded) {
        return;
      }
      this.lastReportedExpanded = expanded;
      this.expandedChange.emit(expanded);
    });
  }

  activityTitle(activity: SubappActivity): string {
    return getChildToolConfig(activity.toolId)?.titleKey || activity.title;
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

  async openFull(activity: SubappActivity, mode: 'embedded' | 'window' = 'embedded'): Promise<void> {
    await this.mainUiAutomation.openChildApp({
      toolId: activity.toolId,
      mode,
    });
  }

  runtimeLabel(activity: SubappActivity): string {
    switch (activity.runtimeState) {
      case 'ready':
        return 'SUBAPP_DOCK.RUNTIME_READY';
      case 'starting':
        return 'SUBAPP_DOCK.RUNTIME_STARTING';
      case 'error':
        return 'SUBAPP_DOCK.RUNTIME_ERROR';
      case 'stopped':
        return 'SUBAPP_DOCK.RUNTIME_STOPPED';
      default:
        return 'SUBAPP_DOCK.RUNTIME_UNKNOWN';
    }
  }

  invocationLabel(activity: SubappActivity): string {
    switch (activity.invocationState) {
      case 'running':
        return 'SUBAPP_DOCK.INVOCATION_RUNNING';
      case 'succeeded':
        return 'SUBAPP_DOCK.INVOCATION_SUCCEEDED';
      case 'failed':
        return 'SUBAPP_DOCK.INVOCATION_FAILED';
      case 'cancelled':
        return 'SUBAPP_DOCK.INVOCATION_CANCELLED';
      default:
        return 'SUBAPP_DOCK.INVOCATION_IDLE';
    }
  }
}
