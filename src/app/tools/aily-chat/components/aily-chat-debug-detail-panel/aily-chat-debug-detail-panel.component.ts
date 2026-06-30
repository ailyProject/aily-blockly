import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';

import { AilyHost } from '../../core/host';
import {
  getHostSessionDebugEventDetails,
  getHostSessionDebugEventTitle,
  type HostSessionDebugCustomizationLogEntry,
  type HostSessionDebugEvent,
  type HostSessionDebugResolvedCustomizationSummaryContent,
  type HostSessionDebugResolvedEventContent,
  type HostSessionDebugResolvedMessageContent,
  type HostSessionDebugResolvedModelTurnContent,
  type HostSessionDebugResolvedTextContent,
  type HostSessionDebugResolvedToolCallContent,
} from '../../services/host-session-debug-events';
import { getBlocklyArtifactReferenceLabel, resolveBlocklyArtifactReferenceTarget } from '../../helpers/chat-artifact-reference';

interface CustomizationSectionViewModel {
  readonly title: string;
  readonly entries: readonly HostSessionDebugCustomizationLogEntry[];
}

interface EventBoundaryTag {
  readonly label: string;
  readonly value: string;
}

@Component({
  selector: 'aily-chat-debug-detail-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-chat-debug-detail-panel.component.html',
  styleUrl: './aily-chat-debug-detail-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatDebugDetailPanelComponent {
  @ViewChild('panelRoot') private panelRoot?: ElementRef<HTMLElement>;
  @Input() event: HostSessionDebugEvent | null = null;
  @Input() resolvedContent: HostSessionDebugResolvedEventContent | null = null;
  @Input() titleOverride: string | null = null;
  @Output() closeRequested = new EventEmitter<void>();

  get isVisible(): boolean {
    return Boolean(this.event || this.resolvedContent);
  }

  focus(): void {
    this.panelRoot?.nativeElement.focus();
  }

  get title(): string {
    if (this.titleOverride) {
      return this.titleOverride;
    }

    return this.event ? getHostSessionDebugEventTitle(this.event) : '事件详情';
  }

  get summary(): string | undefined {
    return this.event ? getHostSessionDebugEventDetails(this.event) : undefined;
  }

  get eventBoundaryTags(): readonly EventBoundaryTag[] {
    const event = this.event;
    if (!event) {
      return [];
    }

    const owner = event.ownerSessionId || event.sessionId;
    return [
      { label: 'owner', value: owner },
      { label: 'session', value: event.sessionId },
      { label: 'turn', value: event.turnId },
      ...(event.requestModeId || event.selectedModeId
        ? [{ label: 'mode', value: event.requestModeId || event.selectedModeId || '' }]
        : []),
      ...(event.eventSource ? [{ label: 'source', value: event.eventSource }] : []),
    ];
  }

  get messageContent(): HostSessionDebugResolvedMessageContent | null {
    return this.resolvedContent?.kind === 'message' ? this.resolvedContent : null;
  }

  get toolCallContent(): HostSessionDebugResolvedToolCallContent | null {
    return this.resolvedContent?.kind === 'toolCall' ? this.resolvedContent : null;
  }

  get modelTurnContent(): HostSessionDebugResolvedModelTurnContent | null {
    return this.resolvedContent?.kind === 'modelTurn' ? this.resolvedContent : null;
  }

  get customizationSummaryContent(): HostSessionDebugResolvedCustomizationSummaryContent | null {
    return this.resolvedContent?.kind === 'customizationSummary' ? this.resolvedContent : null;
  }

  get customizationSummaryLine(): string | null {
    const content = this.customizationSummaryContent;
    if (!content) {
      return null;
    }

    const base = `${content.counts.instructions} 条指令，${content.counts.skills} 个技能，${content.counts.agents} 个 Agent，${content.counts.hooks} 个 Hook，${content.counts.skipped} 条跳过`;
    return typeof content.durationInMillis === 'number'
      ? `${base}，耗时 ${content.durationInMillis.toFixed(1)}ms`
      : base;
  }

  get customizationSections(): readonly CustomizationSectionViewModel[] {
    const content = this.customizationSummaryContent;
    if (!content) {
      return [];
    }

    const instructionEntries = content.resolutionLogs.filter((entry) => {
      return entry.category === 'applying' || entry.category === 'referenced';
    });
    const skillEntries = content.resolutionLogs.filter((entry) => entry.category === 'skill');
    const agentEntries = content.resolutionLogs.filter((entry) => entry.category === 'custom-agent');
    const hookEntries = content.resolutionLogs.filter((entry) => entry.category === 'hook');
    const skippedEntries = content.resolutionLogs.filter((entry) => entry.category === 'skipped');

    return [
      { title: `指令 (${instructionEntries.length})`, entries: instructionEntries },
      { title: `技能 (${skillEntries.length})`, entries: skillEntries },
      { title: `Agents (${agentEntries.length})`, entries: agentEntries },
      { title: `Hooks (${hookEntries.length})`, entries: hookEntries },
      { title: `已跳过 (${skippedEntries.length})`, entries: skippedEntries },
    ].filter((section) => section.entries.length > 0);
  }

  get textContent(): HostSessionDebugResolvedTextContent | null {
    return this.resolvedContent?.kind === 'text' ? this.resolvedContent : null;
  }

  getReferenceDisplay(reference: string): string {
    const host = AilyHost.get();
    return getBlocklyArtifactReferenceLabel(host, reference, {
      cwd: this.getProjectPath(),
      sessionId: this.event?.sessionId,
    });
  }

  canOpenReference(reference: string): boolean {
    return Boolean(this.resolveReferenceTarget(reference)?.absolutePath && AilyHost.get().editor?.showTextDocument);
  }

  openReference(reference: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();

    const target = this.resolveReferenceTarget(reference);
    const projectPath = this.getProjectPath();
    if (!target || !projectPath) {
      return;
    }

    void Promise.resolve(AilyHost.get().editor?.showTextDocument?.(target.absolutePath, { projectPath }));
  }

  private resolveReferenceTarget(reference: string) {
    const host = AilyHost.get();
    return resolveBlocklyArtifactReferenceTarget(host, reference, {
      cwd: this.getProjectPath(),
      sessionId: this.event?.sessionId,
    });
  }

  private getProjectPath(): string {
    const host = AilyHost.get();
    return host.project.currentProjectPath || host.project.projectRootPath || '';
  }
}
