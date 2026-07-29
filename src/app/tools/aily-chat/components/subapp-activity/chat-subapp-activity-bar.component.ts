import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, HostBinding, Input, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslateModule } from '@ngx-translate/core';
import { BehaviorSubject, switchMap } from 'rxjs';

import {
  SubappActivityService,
  type SubappActivity,
} from '../../../../services/subapp-activity.service';

@Component({
  selector: 'aily-chat-subapp-activity-bar',
  imports: [CommonModule, TranslateModule],
  templateUrl: './chat-subapp-activity-bar.component.html',
  styleUrl: './chat-subapp-activity-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSubappActivityBarComponent {
  private readonly activityService = inject(SubappActivityService);
  private readonly sessionIdSubject = new BehaviorSubject<string>('');

  readonly activities = toSignal(
    this.sessionIdSubject.pipe(
      switchMap(sessionId => this.activityService.activitiesForSession$(sessionId)),
    ),
    { initialValue: [] as readonly SubappActivity[] },
  );

  @Input()
  set sessionId(value: string | null | undefined) {
    this.sessionIdSubject.next(String(value || '').trim());
  }

  @HostBinding('class.has-activity')
  get hasActivity(): boolean {
    return this.activities().length > 0;
  }

  toggle(activity: SubappActivity): void {
    this.activityService.setSurfaceState(
      activity.sessionId,
      activity.toolId,
      activity.surfaceState === 'expanded' ? 'collapsed' : 'expanded',
    );
  }

  statusLabel(activity: SubappActivity): string {
    if (activity.invocationState === 'running') return 'Agent running';
    if (activity.runtimeState === 'error') return 'Runtime error';
    if (activity.invocationState === 'failed') return 'Last call failed';
    if (activity.invocationState === 'cancelled') return 'Last call cancelled';
    if (activity.runtimeState === 'ready') return 'Runtime ready';
    if (activity.runtimeState === 'starting') return 'Runtime starting';
    if (activity.runtimeState === 'stopped') return 'Runtime stopped';
    return 'Previously used';
  }
}
