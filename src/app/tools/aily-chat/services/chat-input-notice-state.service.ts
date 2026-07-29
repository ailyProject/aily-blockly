import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subscription } from 'rxjs';

import { AuthQuotaStateService } from './auth-quota-state.service';
import { RequestQuotaStateService, type RequestQuotaServiceState } from './request-quota-state.service';
import {
  createRequestQuotaInputNotice,
  createRequestRateLimitInputNotice,
  type RequestQuotaSnapshot,
} from './request-quota-snapshot';
import { type ChatInputNotice, isSameChatInputNotice } from './chat-input-notice';
import {
  ChatRemoteCapabilityService,
  type ChatRemoteCapabilitySnapshot,
} from './chat-remote-capability.service';

const INPUT_NOTICE_THRESHOLDS = [50, 75, 90, 95];

@Injectable({
  providedIn: 'root',
})
export class ChatInputNoticeStateService implements OnDestroy {
  private readonly inputNoticeSubject = new BehaviorSubject<ChatInputNotice | null>(null);
  readonly inputNotice$ = this.inputNoticeSubject.asObservable();
  private readonly subscription = new Subscription();
  private readonly notifications = new Map<string, ChatInputNotice>();
  private readonly dismissedNoticeIds = new Set<string>();
  private readonly insertionOrder = new Map<string, number>();
  private nextInsertionOrder = 0;
  private readonly sourceNoticeIds = new Map<ChatInputNotice['source'], string>();
  private latestRequestQuotaSnapshot: RequestQuotaSnapshot | null = null;
  private latestRequestState: RequestQuotaServiceState | null = null;

  constructor(
    private readonly authQuotaStateService: AuthQuotaStateService,
    private readonly requestQuotaStateService: RequestQuotaStateService,
    private readonly remoteCapabilityService: ChatRemoteCapabilityService,
  ) {
    this.subscription.add(
      this.authQuotaStateService.authQuotaInputNotice$.subscribe((notice) => {
        this.syncSourceNotification('auth-quota', notice);
      }),
    );
    this.subscription.add(
      this.requestQuotaStateService.requestQuotaSnapshot$.subscribe((requestQuotaSnapshot) => {
        this.latestRequestQuotaSnapshot = requestQuotaSnapshot;
        this.syncSourceNotification('request-quota', this.computeRequestNotice());
      }),
    );
    this.subscription.add(
      this.requestQuotaStateService.snapshot$.subscribe((requestState) => {
        this.latestRequestState = requestState;
        this.syncSourceNotification('request-quota', this.computeRequestNotice());
      }),
    );
    this.subscription.add(
      this.remoteCapabilityService.snapshot$.subscribe((snapshot) => {
        this.syncSourceNotification('remote-capability', createRemoteCapabilityNotice(snapshot));
      }),
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  getInputNotice(): ChatInputNotice | null {
    return this.inputNoticeSubject.getValue();
  }

  syncExecutionModeNotice(context: {
    permissionLevel?: string | null;
    approvalsReviewer?: string | null;
    approvalPolicy?: string | null;
  }): void {
    this.syncSourceNotification('mode-guidance', this.createExecutionModeNotice(context));
  }

  acceptProjectedRuntimeNotice(notice: ChatInputNotice | null | undefined): void {
    if (!notice) {
      this.syncSourceNotification('request-quota', null);
      return;
    }

    this.syncSourceNotification(notice.source, notice);
  }

  dismissCurrentNotice(): void {
    const notice = this.getInputNotice();
    if (!notice) {
      return;
    }

    this.dismissNotification(notice.id);
  }

  handleMessageSubmitted(): void {
    let changed = false;
    for (const notice of this.notifications.values()) {
      if (notice.autoDismissOnMessage && !this.dismissedNoticeIds.has(notice.id)) {
        this.dismissedNoticeIds.add(notice.id);
        changed = true;
      }
    }

    if (changed) {
      this.publishActiveNotice();
    }
  }

  private computeRequestNotice(): ChatInputNotice | null {
    const activeFailureNotice = createRequestQuotaInputNotice(this.latestRequestQuotaSnapshot);
    if (activeFailureNotice) {
      return activeFailureNotice;
    }

    return this.checkRateLimitThreshold(
      this.latestRequestState?.rateLimitSnapshots?.['session'],
      'session',
    ) ?? this.checkRateLimitThreshold(
      this.latestRequestState?.rateLimitSnapshots?.['weekly'],
      'weekly',
    );
  }

  private createExecutionModeNotice(context: {
    permissionLevel?: string | null;
    approvalsReviewer?: string | null;
    approvalPolicy?: string | null;
  }): ChatInputNotice | null {
    const permissionLevel = typeof context.permissionLevel === 'string'
      ? context.permissionLevel.trim().toLowerCase()
      : '';
    const approvalsReviewer = typeof context.approvalsReviewer === 'string'
      ? context.approvalsReviewer.trim().toLowerCase()
      : '';
    const approvalPolicy = typeof context.approvalPolicy === 'string'
      ? context.approvalPolicy.trim().toLowerCase()
      : '';

    const autopilotEnabled = permissionLevel === 'autopilot';
    const autoReviewEnabled = approvalsReviewer === 'auto_review';
    if (!autopilotEnabled && !autoReviewEnabled) {
      return null;
    }

    if (autopilotEnabled) {
      return {
        id: `mode-guidance:autopilot:${autoReviewEnabled ? 'auto-review' : 'manual-review'}:${approvalPolicy || 'none'}`,
        source: 'mode-guidance',
        kind: 'mode-guidance',
        title: 'Autopilot is enabled.',
        subtitle: autoReviewEnabled
          ? 'The agent can keep executing until completion. Auto Review only evaluates approval requests and does not guarantee allow.'
          : 'The agent can keep executing until completion. Approval requests are still reviewed manually with the current reviewer setup.',
        tone: 'warning',
        iconClass: 'fa-light fa-triangle-exclamation',
      };
    }

    return {
      id: `mode-guidance:auto-review:${approvalPolicy || 'none'}`,
      source: 'mode-guidance',
      kind: 'mode-guidance',
      title: 'Auto Review is enabled.',
      subtitle: 'Auto Review only evaluates approval requests. It does not switch execution mode to Autopilot.',
      tone: 'info',
      iconClass: 'fa-light fa-circle-info',
    };
  }

  private checkRateLimitThreshold(
    snapshot: RequestQuotaServiceState['rateLimitSnapshots'] extends Readonly<Record<string, infer Snapshot>> ? Snapshot | undefined : never,
    type: 'session' | 'weekly',
  ): ChatInputNotice | null {
    if (!snapshot || snapshot.unlimited) {
      return null;
    }

    const percentUsed = 100 - snapshot.percentRemaining;
    if (percentUsed < INPUT_NOTICE_THRESHOLDS[0]) {
      return null;
    }

    return createRequestRateLimitInputNotice(type, Math.round(percentUsed), snapshot.resetAt);
  }

  private syncSourceNotification(
    source: ChatInputNotice['source'],
    notice: ChatInputNotice | null,
  ): void {
    const previousId = this.sourceNoticeIds.get(source);
    if (!notice) {
      if (previousId) {
        this.deleteNotification(previousId);
        this.sourceNoticeIds.delete(source);
      }
      return;
    }

    if (previousId && previousId !== notice.id) {
      this.deleteNotification(previousId);
    }

    this.sourceNoticeIds.set(source, notice.id);
    this.setNotification(notice);
  }

  private setNotification(notice: ChatInputNotice): void {
    this.notifications.set(notice.id, notice);
    this.dismissedNoticeIds.delete(notice.id);
    this.insertionOrder.set(notice.id, this.nextInsertionOrder++);
    this.publishActiveNotice();
  }

  private deleteNotification(id: string): void {
    const removed = this.notifications.delete(id);
    if (!removed) {
      return;
    }

    this.dismissedNoticeIds.delete(id);
    this.insertionOrder.delete(id);
    this.publishActiveNotice();
  }

  private dismissNotification(id: string): void {
    if (!this.notifications.has(id) || this.dismissedNoticeIds.has(id)) {
      return;
    }

    this.dismissedNoticeIds.add(id);
    this.publishActiveNotice();
  }

  private publishActiveNotice(): void {
    this.acceptNotice(this.getActiveNotice());
  }

  private getActiveNotice(): ChatInputNotice | null {
    let best: ChatInputNotice | null = null;
    let bestOrder = -1;

    for (const notice of this.notifications.values()) {
      if (this.dismissedNoticeIds.has(notice.id)) {
        continue;
      }

      const order = this.insertionOrder.get(notice.id) ?? 0;
      if (!best) {
        best = notice;
        bestOrder = order;
        continue;
      }

      const sourcePriorityDelta = getNoticeSourcePriority(notice) - getNoticeSourcePriority(best);
      if (sourcePriorityDelta > 0) {
        best = notice;
        bestOrder = order;
        continue;
      }

      if (sourcePriorityDelta < 0) {
        continue;
      }

      const severityDelta = getNoticeSeverityRank(notice) - getNoticeSeverityRank(best);
      if (severityDelta > 0 || (severityDelta === 0 && order > bestOrder)) {
        best = notice;
        bestOrder = order;
      }
    }

    return best;
  }

  private acceptNotice(notice: ChatInputNotice | null): void {
    if (isSameChatInputNotice(this.getInputNotice(), notice)) {
      return;
    }

    this.inputNoticeSubject.next(notice);
  }
}

function getNoticeSeverityRank(notice: ChatInputNotice): number {
  switch (notice.tone) {
    case 'error':
      return 2;
    case 'warning':
      return 1;
    case 'info':
    case 'muted':
    default:
      return 0;
  }
}

function getNoticeSourcePriority(notice: ChatInputNotice): number {
  if (notice.source === 'remote-capability') {
    return 3;
  }

  if (notice.source === 'auth-quota') {
    return 2;
  }

  if (notice.source === 'request-quota') {
    return 1;
  }

  return 0;
}

function createRemoteCapabilityNotice(
  snapshot: ChatRemoteCapabilitySnapshot,
): ChatInputNotice | null {
  switch (snapshot.state) {
    case 'offline_cached':
      return {
        id: 'remote-capability:offline-cached',
        source: 'remote-capability',
        kind: 'offline',
        title: 'You are offline.',
        subtitle: 'Local conversations remain available. Reconnect to send with a built-in model.',
        tone: 'warning',
        iconClass: 'fa-light fa-cloud-slash',
      };
    case 'signed_out':
      return {
        id: 'remote-capability:signed-out',
        source: 'remote-capability',
        kind: 'signed-out',
        title: 'Sign in to use built-in models.',
        subtitle: 'Local conversations and configured custom models remain available.',
        tone: 'muted',
        iconClass: 'fa-light fa-user',
      };
    case 'unavailable':
      return {
        id: 'remote-capability:unavailable',
        source: 'remote-capability',
        kind: 'unavailable',
        title: 'The model service is currently unavailable.',
        subtitle: 'Local conversations remain available. The connection will be checked again in the background.',
        tone: 'warning',
        iconClass: 'fa-light fa-triangle-exclamation',
      };
    case 'unknown':
    case 'authenticated':
    default:
      return null;
  }
}
