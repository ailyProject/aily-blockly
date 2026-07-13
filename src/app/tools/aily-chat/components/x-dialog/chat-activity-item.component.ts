import { ChangeDetectionStrategy, ChangeDetectorRef, Component, Input, OnChanges, SimpleChanges, ViewChild, forwardRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type { ComponentMap } from 'ngx-x-markdown';

import { AilyHost } from '../../core/host';
import { AilyChatCodeComponent } from './aily-chat-code.component';
import { ChatTerminalPartComponent } from './chat-terminal-part/chat-terminal-part.component';
import { XAilyThinkViewerComponent } from './x-aily-think-viewer/x-aily-think-viewer.component';
import { XAilyMermaidViewerComponent } from './x-aily-mermaid-viewer/x-aily-mermaid-viewer.component';
import { AilyMarkdownExternalLinksDirective } from '../../directives/aily-markdown-external-links.directive';
import type { ActivityGroupDisplayItem, ActivityToolbarActionDisplayData, ActivityToolHeaderDisplayData } from './chat-activity-group.types';
import { XAilyConfirmationViewerComponent } from './x-aily-confirmation-viewer/x-aily-confirmation-viewer.component';
import {
  getDiffDisplayLines,
  getDiffOutputHref,
  getGroupedDiffFiles,
  isDiffOutputRow,
  isGroupedDiffOutputGroup,
  type DiffDisplayFile,
  type DiffDisplayLine,
} from './chat-activity-diff-widget';
import {
  buildInstructionDetailProjection,
  type DetailSectionDescriptor,
  type StateDetailOutputGroup,
  type StateDetailRow,
  type InstructionDiagnosticFilter,
} from './x-aily-state-viewer/activity-detail-items';
import { getBlocklyArtifactReferenceLabel, resolveBlocklyArtifactReferenceTarget } from '../../helpers/chat-artifact-reference';
import { openChatProcessWindow } from '../../helpers/chat-process-window';
import { resolveChildToolIdFromProcess } from '../../helpers/child-tool-process-summary';
import { getChildToolConfig } from '../../../../configs/tool.config';
import { resolveTerminalLifecycleState } from '../../core/terminal-status';
import { OPEN_MAX_REQUESTS_SETTINGS_ACTION_ID } from '../../core/chat-runtime-confirmation-actions';
import {
  ChatRuntimeInteractionHostService,
  type RuntimeCommandSessionActionResult,
  type RuntimeConfirmationDecision,
} from '../../services/chat-runtime-interaction-host.service';
import { ChatViewService } from '../../services/chat-view.service';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';

@Component({
  selector: 'aily-chat-activity-item',
  standalone: true,
  imports: [CommonModule, TranslateModule, XMarkdownComponent, XAilyConfirmationViewerComponent, ChatTerminalPartComponent, XAilyThinkViewerComponent, XAilyMermaidViewerComponent, AilyMarkdownExternalLinksDirective, forwardRef(() => ChatActivityItemComponent)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="cag-item"
      [attr.data-kind]="item.kind"
      [class.cag-item-first]="first"
      [class.cag-item-last]="last"
      [class.cag-item-tool]="isToolHeader()"
      [class.cag-item-only]="only"
      [class.cag-item-pending-approval]="isPendingApprovalItem()">
      <div class="cag-item-icon-shell ccenter" [class.loading-icon]="item.kind !== 'thinking' && item.isSpinning" [class.lloading]="item.kind !== 'thinking' && item.isSpinning">
        <i [class]="item.iconClass"
           [class.cag-spin]="item.kind === 'thinking' && item.isSpinning"
           class="cag-item-icon"
           [style.color]="item.iconColor"></i>
      </div>

      <div class="cag-item-body">
        @if (item.kind === 'thinking') {
          <div class="cag-item-thinking-content">
            <x-aily-think-viewer
              [data]="getThinkingViewerData()"
              [embedded]="true"
              [impliedWordLoadRate]="impliedWordLoadRate"
              [contentDeltaHandler]="contentDeltaHandler" />
          </div>
        } @else {
          <div
            class="cag-item-summary"
            [class.cag-item-summary-clickable]="hasDetailContent()"
            [attr.role]="hasDetailContent() ? 'button' : null"
            [attr.tabindex]="hasDetailContent() ? '0' : null"
            [attr.aria-expanded]="hasDetailContent() ? detailExpanded : null"
            (click)="toggleDetail()"
            (keydown.enter)="toggleDetail()"
            (keydown.space)="toggleDetailFromKeyboard($event)">
            <!-- @if (item.kicker) {
              <div class="cag-item-kicker">{{ item.kicker }}</div>
            } -->

            @if (isToolHeader()) {
              <div class="cag-item-tool-title">
                <div class="cag-item-tool-title-main">
                  <span class="cag-item-tool-title-label">{{ (stableToolHeader?.title || item.label) | translate }}</span>
                  @if (stableToolHeader?.subtitle) {
                    <small class="cag-item-tool-title-subtitle">{{ stableToolHeader?.subtitle | translate }}</small>
                  }
                </div>
                <span class="cag-item-tool-title-side">
                  @if (shouldRenderHeaderToolbar() && item.toolbarActions?.length) {
                    <span class="cag-item-toolbar" aria-label="工具操作">
                      @for (action of item.toolbarActions; track action.id) {
                        <button
                          type="button"
                          class="cag-item-toolbar-button"
                          [disabled]="isToolbarActionDisabled(action)"
                          [attr.title]="(action.tooltip || action.label) | translate"
                          [attr.aria-label]="action.label | translate"
                          (click)="handleToolbarAction(action, $event)">
                          <i [class]="action.iconClass"></i>
                        </button>
                      }
                    </span>
                  }
                  @if (stableToolHeader?.meta) {
                    <span class="cag-item-head-meta">{{ stableToolHeader?.meta }}</span>
                  }
                  @if (stableToolHeader?.pill) {
                    <span class="cag-item-pill" [attr.data-tone]="stableToolHeader?.pillTone">{{ stableToolHeader?.pill | translate }}</span>
                  }
                  @if (hasDetailContent()) {
                    <span class="cag-item-chevron-wrap" aria-hidden="true">
                      <i class="fa-light fa-chevron-down cag-item-chevron" [class.cag-item-chevron-expanded]="detailExpanded"></i>
                    </span>
                  }
                </span>
              </div>
            } @else {
              <div class="cag-item-head">
                <span class="cag-item-label">{{ item.label | translate }}</span>
                <span class="cag-item-head-trailing">
                  @if (item.headerMeta) {
                    <span class="cag-item-head-meta">{{ item.headerMeta }}</span>
                  }
                  @if (item.pill) {
                    <span class="cag-item-pill" [attr.data-tone]="item.pillTone">{{ item.pill | translate }}</span>
                  }
                  @if (hasDetailContent()) {
                    <span class="cag-item-chevron-wrap" aria-hidden="true">
                      <i class="fa-light fa-chevron-down cag-item-chevron" [class.cag-item-chevron-expanded]="detailExpanded"></i>
                    </span>
                  }
                </span>
              </div>

              @if (item.subtitle) {
                <div class="cag-item-subtitle">{{ item.subtitle }}</div>
              }
            }

            @if (item.note && item.detailKind === 'invocation') {
              <div class="cag-item-note cag-item-summary-note">
                @if (item.noteRenderMode === 'plain') {
                  <pre class="cag-item-plain-note" [textContent]="item.note || ''"></pre>
                } @else {
                  <x-markdown
                    [content]="item.note || ''"
                    [components]="componentMap"
                    rootClassName="x-markdown-dark cag-item-markdown"
                    ailyMarkdownExternalLinks
                  />
                }
              </div>
            }
          </div>

          @if (item.note && item.detailKind !== 'invocation') {
            <div class="cag-item-note">
              @if (item.noteRenderMode === 'plain') {
                <pre class="cag-item-plain-note" [textContent]="item.note || ''"></pre>
              } @else {
                <x-markdown
                  [content]="item.note || ''"
                  [components]="componentMap"
                  rootClassName="x-markdown-dark cag-item-markdown"
                  ailyMarkdownExternalLinks
                />
              }
            </div>
          }

          @if (shouldRenderInlineApproval()) {
            <div class="cag-item-confirmation-body" data-detail-kind="invocation">
              <x-aily-confirmation-viewer
                class="chat-confirmation-widget2 cag-item-confirmation-widget cag-item-approval"
                [data]="item.approval"
                [embedded]="true"
                [interactive]="isInteractiveInlineApproval()"
                (decision)="onInlineApprovalDecision($event)" />
            </div>
          }

          @if (item.children?.length) {
            <div class="cag-item-children">
              @for (child of item.children; track child.id) {
                <div class="cag-item-child" [attr.data-kind]="child.kind" [attr.data-tone]="child.tone || 'neutral'">
                  @if (child.title || child.trailing) {
                    <div class="cag-item-child-head">
                      <span class="cag-item-child-title">{{ child.title }}</span>
                      @if (child.trailing) {
                        <span class="cag-item-child-pill" [attr.data-tone]="child.tone || 'neutral'">{{ child.trailing }}</span>
                      }
                    </div>
                  }
                  @if (child.subtitle) {
                    <div class="cag-item-child-subtitle">{{ child.subtitle }}</div>
                  }
                  @if (child.content) {
                    <div class="cag-item-child-note">
                      <x-markdown
                        [content]="child.content"
                        [components]="componentMap"
                        rootClassName="x-markdown-dark cag-item-markdown"
                        ailyMarkdownExternalLinks
                      />
                    </div>
                  }
                </div>
              }
            </div>
          }

          @if (item.nestedItems?.length) {
            <div class="cag-item-nested-list">
              @for (nestedItem of item.nestedItems; track nestedItem.id; let nestedFirst = $first; let nestedLast = $last; let nestedCount = $count) {
                <aily-chat-activity-item
                  [item]="nestedItem"
                  [sessionId]="sessionId"
                  [first]="nestedFirst"
                  [last]="nestedLast"
                  [only]="nestedCount === 1"
                  [contentDeltaHandler]="contentDeltaHandler" />
              }
            </div>
          }

          @if (item.subagentItems?.length) {
            <div class="cag-subagent-owned-list" data-subagent-owned-list="true">
              @for (subagentItem of item.subagentItems; track subagentItem.id; let subagentFirst = $first; let subagentLast = $last; let subagentCount = $count) {
                <aily-chat-activity-item
                  [item]="subagentItem"
                  [sessionId]="sessionId"
                  [first]="subagentFirst"
                  [last]="subagentLast"
                  [only]="subagentCount === 1"
                  [contentDeltaHandler]="contentDeltaHandler" />
              }
            </div>
          }

          @if (hasDetailContent() && detailExpanded) {
            <div class="cag-item-detail-body" [attr.data-detail-kind]="item.detailKind || 'state'">
              @if (item.instructionMetadata) {
                <div class="cag-item-instruction-body">
                  @if (getInstructionProjection().badges.length > 0) {
                    <div class="cag-item-state-badges">
                      @for (badge of getInstructionProjection().badges; track badge.label + ':' + badge.value) {
                        <span class="cag-item-state-badge" [attr.data-tone]="badge.tone || 'neutral'">
                          <span class="cag-item-state-badge-label">{{ badge.label }}</span>
                          <span class="cag-item-state-badge-value">{{ badge.value }}</span>
                        </span>
                      }
                    </div>
                  }

                  @if (getInstructionProjection().filterChips.length > 0) {
                    <div class="cag-item-instruction-filters">
                      @for (chip of getInstructionProjection().filterChips; track chip.id) {
                        <button
                          type="button"
                          class="cag-item-instruction-filter"
                          [class.cag-item-instruction-filter-active]="chip.active"
                          [attr.data-tone]="chip.tone || 'neutral'"
                          [attr.aria-pressed]="chip.active"
                          (click)="selectInstructionFilter(chip.id)">
                          <span class="cag-item-instruction-filter-label">{{ chip.label }}</span>
                          <span class="cag-item-instruction-filter-count">{{ chip.count }}</span>
                        </button>
                      }
                    </div>
                  }

                  @for (section of getInstructionProjection().sections; track section.title) {
                    <div class="cag-item-detail-section">
                      @if (section.title) {
                        <div class="cag-item-detail-section-title">{{ section.title | translate }}</div>
                      }
                      @for (row of section.rows; track row.id) {
                        <div class="cag-item-detail-row" [attr.data-tone]="row.tone || 'neutral'">
                          <div class="cag-item-detail-row-head">
                            <span class="cag-item-detail-row-title">{{ row.title | translate }}</span>
                            @if (row.trailing) {
                              <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing | translate }}</span>
                            }
                          </div>
                          @if (row.subtitle) {
                            <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                          }
                          @if (row.reference) {
                            <div class="cag-item-detail-row-reference-shell">
                              <span class="cag-item-detail-row-reference">{{ getResolvedReferenceLabel(row.reference) }}</span>
                              @if (canOpenReference(row.reference)) {
                                <button type="button" class="cag-item-detail-row-open" (click)="openReference(row.reference, $event)">打开</button>
                              }
                            </div>
                          }
                          @if (row.note) {
                            <div class="cag-item-detail-row-note">
                              <x-markdown
                                [content]="row.note"
                                [components]="componentMap"
                                rootClassName="x-markdown-dark cag-item-markdown"
                                ailyMarkdownExternalLinks
                              />
                            </div>
                          }
                        </div>
                      }
                    </div>
                  }
                </div>
              } @else if (item.detailKind === 'invocation') {
                @if (item.invocationDetail?.progressSection; as progressSection) {
                  <div class="cag-item-progress-container" [attr.data-state]="item.pillTone || 'neutral'">
                    @for (row of progressSection.rows; track row.id) {
                      <div class="cag-item-progress-step" [attr.data-tone]="row.tone || 'neutral'">
                        <div class="cag-item-progress-message">
                          <div class="cag-item-progress-title-row">
                            <span class="cag-item-progress-title">{{ row.title }}</span>
                            @if (row.trailing) {
                              <span class="cag-item-progress-stats">{{ row.trailing }}</span>
                            }
                          </div>
                          @if (row.subtitle) {
                            <div class="cag-item-progress-subtitle">{{ row.subtitle }}</div>
                          }
                          @if (row.note) {
                            <div class="cag-item-progress-note">
                              <x-markdown
                                [content]="row.note"
                                [components]="componentMap"
                                rootClassName="x-markdown-dark cag-item-markdown"
                                ailyMarkdownExternalLinks
                              />
                            </div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }

                @if (item.invocationDetail?.hasWidgetSections) {
                  <div class="chat-confirmation-widget2 cag-item-tool-widget" [class.cag-item-tool-post-confirmation]="item.invocationDetail?.postConfirmation">
                    <div class="chat-confirmation-widget-title cag-item-tool-widget-title">
                      <span class="chat-confirmation-widget-title-inner">{{ item.invocationDetail?.widgetTitle }}</span>
                    </div>

                    @if (item.approvalSummary; as approvalSummary) {
                      <div class="cag-item-tool-confirmation-summary" [attr.data-tone]="approvalSummary.tone">
                        <div class="cag-item-tool-confirmation-summary-head">
                          <span class="cag-item-tool-confirmation-summary-title">{{ approvalSummary.statusLabel }}</span>
                          @if (approvalSummary.scopeLabel) {
                            <span class="cag-item-detail-row-pill" [attr.data-tone]="approvalSummary.tone">{{ approvalSummary.scopeLabel }}</span>
                          }
                        </div>
                        <div class="cag-item-tool-confirmation-summary-note">{{ approvalSummary.note }}</div>
                      </div>
                    }

                    @if (item.invocationDetail?.argsSection; as argsSection) {
                      <div class="cag-item-tool-body cag-item-tool-args" [attr.data-section-title]="argsSection.title">
                        <div class="cag-item-tool-body-title">输入</div>
                        @for (row of argsSection.rows; track row.id) {
                          <div class="cag-item-invocation-args">
                            <div class="cag-item-invocation-args-title">{{ row.title }}</div>
                            @if (row.note) {
                              <div class="cag-item-invocation-args-note">
                                <x-markdown
                                  [content]="row.note"
                                  [components]="componentMap"
                                  rootClassName="x-markdown-dark cag-item-markdown"
                                  ailyMarkdownExternalLinks
                                />
                              </div>
                            }
                          </div>
                        }
                      </div>
                    }

                    @for (section of item.invocationDetail?.outputSections || []; track section.title) {
                      <div class="cag-item-tool-body cag-item-tool-output" [attr.data-section-title]="section.title">
                        <div class="cag-item-tool-body-title">{{ item.invocationDetail?.outputTitle }}</div>
                        <div class="cag-item-invocation-output-list">
                          @for (group of getOutputGroups(section); track group.id) {
                            <div class="cag-item-invocation-output-group" [attr.data-group-kind]="group.kind">
                              @if (isGroupedDiffGroup(group)) {
                                <div class="cag-item-invocation-multi-diff">
                                  @for (diffFile of getGroupedDiffFiles(group.rows); track diffFile.id) {
                                    <section class="cag-item-invocation-diff-file">
                                      <div class="cag-item-invocation-diff-file-header">
                                        <div class="cag-item-invocation-diff-file-title-wrap">
                                          <div class="cag-item-invocation-diff-file-title">{{ diffFile.title }}</div>
                                          @if (diffFile.subtitle) {
                                            <div class="cag-item-invocation-diff-file-subtitle">{{ diffFile.subtitle }}</div>
                                          }
                                        </div>
                                        <div class="cag-item-invocation-diff-file-meta">
                                          @if (diffFile.href) {
                                            <a class="cag-item-invocation-diff-file-link" [href]="diffFile.href" target="_blank" rel="noopener noreferrer" (click)="openExternalLink(diffFile.href, $event)">{{ diffFile.href }}</a>
                                          }
                                          @if (diffFile.language && diffFile.language !== 'diff') {
                                            <span class="cag-item-invocation-diff-language">{{ diffFile.language }}</span>
                                          }
                                          <span class="cag-item-invocation-diff-stat cag-item-invocation-diff-stat-add">+{{ diffFile.addedCount }}</span>
                                          <span class="cag-item-invocation-diff-stat cag-item-invocation-diff-stat-remove">-{{ diffFile.removedCount }}</span>
                                        </div>
                                      </div>

                                      @for (hunk of diffFile.hunks; track hunk.id) {
                                        <div class="cag-item-invocation-diff-hunk">
                                          <button type="button" class="cag-item-invocation-diff-hunk-toggle" (click)="toggleDiffHunk(hunk.id)">
                                            <span class="cag-item-invocation-diff-hunk-title">{{ hunk.header }}</span>
                                            <span class="cag-item-invocation-diff-hunk-meta">
                                              <span class="cag-item-invocation-diff-stat cag-item-invocation-diff-stat-add">+{{ hunk.addedCount }}</span>
                                              <span class="cag-item-invocation-diff-stat cag-item-invocation-diff-stat-remove">-{{ hunk.removedCount }}</span>
                                              <i class="fa-light fa-chevron-down cag-item-chevron" [class.cag-item-chevron-expanded]="!isDiffHunkCollapsed(hunk.id)"></i>
                                            </span>
                                          </button>

                                          @if (!isDiffHunkCollapsed(hunk.id)) {
                                            <div class="cag-item-invocation-output-diff-block">
                                              @for (diffLine of hunk.lines; track diffLine.id) {
                                                <div class="cag-item-invocation-output-diff-line" [attr.data-kind]="diffLine.kind">
                                                  <span class="cag-item-invocation-output-diff-line-number">{{ diffLine.leftLine ?? '' }}</span>
                                                  <span class="cag-item-invocation-output-diff-line-number">{{ diffLine.rightLine ?? '' }}</span>
                                                  <span class="cag-item-invocation-output-diff-marker">{{ diffLine.marker }}</span>
                                                  <span class="cag-item-invocation-output-diff-text" [textContent]="diffLine.text"></span>
                                                </div>
                                              }
                                            </div>
                                          }
                                        </div>
                                      }
                                    </section>
                                  }
                                </div>
                              } @else if (group.kind === 'terminal') {
                                <aily-chat-terminal-part
                                  [command]="getTerminalCommandText(group)"
                                  [subtitle]="getTerminalCommandSubtitle(group)"
                                  [status]="getTerminalCommandStatus(group)"
                                  [tone]="getTerminalGroupTone(group)"
                                  [iconClass]="getTerminalGroupIconClass(group)"
                                  [hasOutput]="hasTerminalOutput(group)"
                                  [output]="getTerminalOutputText(group)"
                                  [actions]="getTerminalToolbarActions()"
                                  (actionSelected)="handleTerminalToolbarAction($event)"
                                  [contentDeltaHandler]="contentDeltaHandler" />
                              } @else {
                                @for (row of group.rows; track row.id) {
                                <div class="cag-item-invocation-output" [attr.data-tone]="row.tone || 'neutral'" [attr.data-output-kind]="row.outputKind || 'default'">
                                  @if (row.outputKind === 'terminal-command') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-command">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      @if (row.note) {
                                        <div class="cag-item-invocation-output-command-note">
                                          <x-markdown
                                            [content]="row.note"
                                            [components]="componentMap"
                                            rootClassName="x-markdown-dark cag-item-markdown"
                                            ailyMarkdownExternalLinks
                                          />
                                        </div>
                                      }
                                    </div>
                                  } @else if (row.outputKind === 'terminal-stream') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-stream" [attr.data-stream]="row.outputChannel || 'stdout'">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      @if (row.note) {
                                        <div class="cag-item-invocation-output-stream-note">
                                          <pre class="cag-item-invocation-output-terminal-block"><code [textContent]="row.note"></code></pre>
                                        </div>
                                      }
                                    </div>
                                  } @else if (row.outputKind === 'image') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-image">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      @if (getOutputImageSource(row); as imageSource) {
                                        <div class="cag-item-invocation-output-image-preview-shell">
                                          <img class="cag-item-invocation-output-image-preview" [src]="imageSource" [alt]="row.outputLabel || row.title" />
                                        </div>
                                      }
                                      @if (row.outputLabel || row.outputMimeType) {
                                        <div class="cag-item-invocation-output-image-meta">
                                          @if (row.outputLabel) {
                                            <span class="cag-item-invocation-output-image-label">{{ row.outputLabel }}</span>
                                          }
                                          @if (row.outputMimeType) {
                                            <span class="cag-item-invocation-output-image-mime">{{ row.outputMimeType }}</span>
                                          }
                                        </div>
                                      }
                                      @if (row.note) {
                                        <div class="cag-item-invocation-output-image-note">
                                          <x-markdown
                                            [content]="row.note"
                                            [components]="componentMap"
                                            rootClassName="x-markdown-dark cag-item-markdown"
                                            ailyMarkdownExternalLinks
                                          />
                                        </div>
                                      }
                                    </div>
                                  } @else if (row.outputKind === 'resource') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-resource">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      @if (row.outputLabel || row.outputMimeType) {
                                        <div class="cag-item-invocation-output-resource-meta">
                                          @if (row.outputLabel) {
                                            <span class="cag-item-invocation-output-resource-label">{{ row.outputLabel }}</span>
                                          }
                                          @if (row.outputMimeType) {
                                            <span class="cag-item-invocation-output-resource-mime">{{ row.outputMimeType }}</span>
                                          }
                                        </div>
                                      }
                                      @if (getOutputResourceHref(row); as resourceHref) {
                                        <a class="cag-item-invocation-output-resource-link" [href]="resourceHref" target="_blank" rel="noopener noreferrer" (click)="openExternalLink(resourceHref, $event)">{{ resourceHref }}</a>
                                      }
                                      @if (row.note) {
                                        <div class="cag-item-invocation-output-resource-note">
                                          <x-markdown
                                            [content]="row.note"
                                            [components]="componentMap"
                                            rootClassName="x-markdown-dark cag-item-markdown"
                                            ailyMarkdownExternalLinks
                                          />
                                        </div>
                                      }
                                    </div>
                                  } @else if (row.outputKind === 'mermaid') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-mermaid">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      <x-aily-mermaid-viewer
                                        [data]="{ code: row.outputCode || row.note || '' }"
                                        [streamStatus]="'done'"
                                        [mermaidInstance]="mermaidInstance"></x-aily-mermaid-viewer>
                                      @if (row.outputLabel || row.outputMimeType) {
                                        <div class="cag-item-invocation-output-resource-meta">
                                          @if (row.outputLabel) {
                                            <span class="cag-item-invocation-output-resource-label">{{ row.outputLabel }}</span>
                                          }
                                          @if (row.outputMimeType) {
                                            <span class="cag-item-invocation-output-resource-mime">{{ row.outputMimeType }}</span>
                                          }
                                        </div>
                                      }
                                    </div>
                                  } @else if (row.outputKind === 'code') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-code">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      <div class="cag-item-invocation-output-code-note">
                                        @if (isDiffOutput(row)) {
                                          <div class="cag-item-invocation-output-diff-shell">
                                            <div class="cag-item-invocation-output-diff-meta">
                                              @if (getOutputCodeHref(row); as codeHref) {
                                                <a class="cag-item-invocation-output-diff-file-link" [href]="codeHref" target="_blank" rel="noopener noreferrer" (click)="openExternalLink(codeHref, $event)">{{ codeHref }}</a>
                                              }
                                              @if (row.outputLanguage && row.outputLanguage !== 'diff') {
                                                <span class="cag-item-invocation-output-diff-language">{{ row.outputLanguage }}</span>
                                              }
                                            </div>
                                            <div class="cag-item-invocation-output-diff-block">
                                              @for (diffLine of getDiffLines(row); track diffLine.id) {
                                                <div class="cag-item-invocation-output-diff-line" [attr.data-kind]="diffLine.kind">
                                                  <span class="cag-item-invocation-output-diff-line-number">{{ diffLine.leftLine ?? '' }}</span>
                                                  <span class="cag-item-invocation-output-diff-line-number">{{ diffLine.rightLine ?? '' }}</span>
                                                  <span class="cag-item-invocation-output-diff-marker">{{ diffLine.marker }}</span>
                                                  <span class="cag-item-invocation-output-diff-text" [textContent]="diffLine.text"></span>
                                                </div>
                                              }
                                            </div>
                                          </div>
                                        } @else {
                                          <pre class="cag-item-invocation-output-code-block"><code [attr.data-language]="row.outputLanguage || null" [textContent]="row.outputCode || ''"></code></pre>
                                        }
                                      </div>
                                    </div>
                                  } @else if (row.outputKind === 'changed-file') {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-changed-file" [attr.data-tone]="row.tone || 'neutral'">
                                      <span class="cag-item-invocation-output-changed-file-code">{{ row.outputLabel || '?' }}</span>
                                      <div class="cag-item-invocation-output-changed-file-body">
                                        <div class="cag-item-invocation-output-changed-file-head">
                                          <span class="cag-item-invocation-output-changed-file-title">{{ row.title }}</span>
                                          @if (row.trailing) {
                                            <span class="cag-item-invocation-output-changed-file-status">{{ row.trailing }}</span>
                                          }
                                        </div>
                                        @if (row.subtitle) {
                                          <div class="cag-item-invocation-output-changed-file-subtitle">{{ row.subtitle }}</div>
                                        }
                                        @if (row.note) {
                                          <div class="cag-item-invocation-output-changed-file-note">
                                            <x-markdown
                                              [content]="row.note"
                                              [components]="componentMap"
                                              rootClassName="x-markdown-dark cag-item-markdown"
                                              ailyMarkdownExternalLinks
                                            />
                                          </div>
                                        }
                                      </div>
                                    </div>
                                  } @else {
                                    <div class="cag-item-invocation-output-subpart cag-item-invocation-output-generic">
                                      <div class="cag-item-detail-row-head">
                                        <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                        @if (row.trailing) {
                                          <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                        }
                                      </div>
                                      @if (row.subtitle) {
                                        <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                                      }
                                      @if (row.note) {
                                        <div class="cag-item-detail-row-note">
                                          <x-markdown
                                            [content]="row.note"
                                            [components]="componentMap"
                                            rootClassName="x-markdown-dark cag-item-markdown"
                                            ailyMarkdownExternalLinks
                                          />
                                        </div>
                                      }
                                    </div>
                                  }
                                </div>
                                }
                              }
                            </div>
                          }
                        </div>
                      </div>
                    }

                    @for (section of item.invocationDetail?.historySections || []; track section.title) {
                      <div class="cag-item-tool-body cag-item-tool-history" [attr.data-section-title]="section.title">
                        <div class="cag-item-tool-body-title">{{ section.title }}</div>
                        <div class="cag-item-invocation-timeline">
                          @for (row of section.rows; track row.id) {
                            <div class="cag-item-invocation-row" [attr.data-tone]="row.tone || 'neutral'">
                              <div class="cag-item-detail-row-head">
                                <span class="cag-item-detail-row-title">{{ row.title }}</span>
                                @if (row.trailing) {
                                  <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                                }
                              </div>
                              @if (row.subtitle) {
                                <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                              }
                              @if (row.note) {
                                <div class="cag-item-detail-row-note">
                                  <x-markdown
                                    [content]="row.note"
                                    [components]="componentMap"
                                    rootClassName="x-markdown-dark cag-item-markdown"
                                    ailyMarkdownExternalLinks
                                  />
                                </div>
                              }
                            </div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              } @else {
                @for (section of item.detailSections || []; track section.title) {
                  <div class="cag-item-detail-section">
                    @if (section.title) {
                      <div class="cag-item-detail-section-title">{{ section.title }}</div>
                    }
                    @for (row of section.rows; track row.id) {
                      <div class="cag-item-detail-row" [attr.data-tone]="row.tone || 'neutral'">
                        <div class="cag-item-detail-row-head">
                          <span class="cag-item-detail-row-title">{{ row.title }}</span>
                          @if (row.trailing) {
                            <span class="cag-item-detail-row-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                          }
                        </div>
                        @if (row.subtitle) {
                          <div class="cag-item-detail-row-subtitle">{{ row.subtitle }}</div>
                        }
                        @if (row.note) {
                          <div class="cag-item-detail-row-note">
                            <x-markdown
                              [content]="row.note"
                              [components]="componentMap"
                              rootClassName="x-markdown-dark cag-item-markdown"
                              ailyMarkdownExternalLinks
                            />
                          </div>
                        }
                      </div>
                    }
                  </div>
                }
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      min-width: 0;
    }

    .cag-item {
      position: relative;
      display: flex;
      align-items: flex-start;
      padding: 4px 12px 4px 24px;
      gap: 0;
    }

    .cag-item::before {
      content: '';
      position: absolute;
      left: 10px;
      top: 0;
      bottom: 0;
      width: 1px;
      border-radius: 0;
      background-color: var(--chat-border, rgba(255,255,255,0.10));
      mask-image: linear-gradient(to bottom, #000 0 4px, transparent 5px 18px, #000 21px 100%);;
      -webkit-mask-image: linear-gradient(to bottom, #000 0 4px, transparent 5px 18px, #000 21px 100%);;
    }

    .cag-item:not(.cag-item-tool)::before {
      mask-image: linear-gradient(to bottom, #000 0 4px, transparent 0px 16px, #000 24px 100%);
      -webkit-mask-image: linear-gradient(to bottom, #000 0 4px, transparent 0px 16px, #000 24px 100%);
    }

    .cag-item.cag-item-first::before {
      mask-image: linear-gradient(to bottom, transparent 0 16px, #000 24px 100%);
      -webkit-mask-image: linear-gradient(to bottom, transparent 0 16px, #000 24px 100%);
    }

    .cag-item.cag-item-first:not(.cag-item-tool)::before {
      mask-image: linear-gradient(to bottom, transparent 0 18px, #000 24px 100%);
      -webkit-mask-image: linear-gradient(to bottom, transparent 0 18px, #000 24px 100%);
    }

    .cag-item.cag-item-last::before {
      mask-image: linear-gradient(to bottom, #000 0 4px, transparent 5px 100%);
      -webkit-mask-image: linear-gradient(to bottom, #000 0 4px, transparent 5px 100%);
    }

    .cag-item.cag-item-last:not(.cag-item-tool)::before {
      mask-image: linear-gradient(to bottom, #000 0 4px, transparent 4px 100%);
      -webkit-mask-image: linear-gradient(to bottom, #000 0 4px, transparent 4px 100%);
    }

    .cag-item.cag-item-only::before {
      background: none;
      mask-image: none;
      -webkit-mask-image: none;
    }

    .cag-item.cag-item-pending-approval::before {
      background: none;
      mask-image: none;
      -webkit-mask-image: none;
    }

    .cag-item[data-kind='thinking'] {
      padding-top: 4px;
      padding-bottom: 4px;
      padding-left: 24px;
    }

    .cag-item-icon-shell {
      position: absolute;
      left: 5px;
      top: 6px;
      width: 12px;
      height: 12px;
    }

    .cag-item:not(.cag-item-tool) .cag-item-icon-shell {
      top: 6px;
    }

    .cag-item-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      font-size: 12px;
    }

    .cag-item-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .cag-item-summary {
      min-width: 0;
      min-height: 12px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2px;
      padding-top: 0;
    }

    .cag-item-summary-clickable {
      cursor: pointer;
    }

    .cag-item-summary-clickable:focus-visible {
      outline: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      outline-offset: 2px;
      border-radius: 5px;
    }

    .cag-item-thinking-content {
      min-width: 0;
    }

    .cag-item-kicker {
      margin-bottom: 2px;
      font-size: 10px;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .cag-item-head {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      justify-content: space-between;
    }

    .cag-item-head-trailing {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .cag-item-tool-title {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      min-width: 0;
      min-height: 16px;
    }

    .cag-item-tool-title-main {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      min-width: 0;
      color: var(--chat-fg-dim, #8e8e8e);
      line-height: 1.35;
      white-space: normal;
    }

    .cag-item-tool-title-label {
      display: inline;
      font-size: 12px;
      color: inherit;
      line-height: 1.35;
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-tool-title-subtitle {
      opacity: 0.7;
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-tool-title-subtitle::before {
      content: ' - ';
    }

    .cag-item-tool-title-side {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      align-self: flex-end;
    }

    .cag-item-toolbar {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }

    .cag-item-toolbar-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--chat-fg-dim, #8e8e8e);
      cursor: pointer;
      line-height: 1;
    }

    .cag-item-toolbar-button:hover:not(:disabled),
    .cag-item-toolbar-button:focus-visible:not(:disabled) {
      color: var(--chat-fg, #cccccc);
      background: rgba(255,255,255,0.07);
      border-color: rgba(255,255,255,0.10);
      outline: none;
    }

    .cag-item-toolbar-button:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }

    .cag-item-head-meta {
      color: var(--chat-fg-muted, #6a6a6a);
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
    }

    .cag-item-label {
      display: block;
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: var(--chat-fg-dim, #8e8e8e);
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-pill {
      flex-shrink: 0;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 5px;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
      color: var(--chat-fg-muted, #6a6a6a);
    }
    .cag-item-pill[data-tone='info']    { color: var(--chat-info, #75beff); }
    .cag-item-pill[data-tone='success'] { color: var(--chat-success, #89d185); }
    .cag-item-pill[data-tone='warn']    { color: var(--chat-warn, #cca700); }
    .cag-item-pill[data-tone='error']   { color: var(--chat-error, #f14c4c); }

    .cag-item-subtitle {
      margin-top: 2px;
      font-size: 12px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-chevron-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 12px;
    }

    .cag-item-chevron {
      font-size: 9px;
      color: var(--chat-fg-muted, #6a6a6a);
      transition: transform 0.15s ease;
    }

    .cag-item-chevron-expanded {
      transform: rotate(180deg);
    }

    .cag-item-note {
      margin-top: 2px;
      min-width: 0;
    }

    .cag-item-summary-note {
      pointer-events: none;
    }

    .cag-item-plain-note {
      margin: 0;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      font-family: inherit;
    }

    .cag-item-approval {
      display: block;
      min-width: 0;
    }

    .cag-item-confirmation-body {
      margin-top: 6px;
      min-width: 0;
    }

    .cag-item-confirmation-widget {
      border: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-radius: 5px;
      overflow: hidden;
      background: rgba(255,255,255,0.02);
    }

    .cag-item-confirmation-body .cag-item-approval {
      margin-top: 0;
    }

    .cag-item-children {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 5px;
    }

    .cag-item-child {
      min-width: 0;
      padding: 3px 0;
      border-bottom: 1px solid var(--chat-border-dim, rgba(255,255,255,0.04));
    }

    .cag-item-child:last-child {
      padding-bottom: 0;
      border-bottom: none;
    }

    .cag-item-child-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
    }

    .cag-item-child-title {
      min-width: 0;
      font-size: 11px;
      line-height: 1.3;
      color: var(--chat-fg, #cccccc);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-child-pill {
      flex-shrink: 0;
      padding: 1px 6px;
      border-radius: 5px;
      font-size: 10px;
      line-height: 1.1;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
      background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .cag-item-child-pill[data-tone='info']    { color: var(--chat-info, #75beff); }
    .cag-item-child-pill[data-tone='success'] { color: var(--chat-success, #89d185); }
    .cag-item-child-pill[data-tone='warn']    { color: var(--chat-warn, #cca700); }
    .cag-item-child-pill[data-tone='error']   { color: var(--chat-error, #f14c4c); }

    .cag-item-child-subtitle {
      margin-top: 2px;
      font-size: 11px;
      line-height: 1.3;
      color: var(--chat-fg-dim, #8e8e8e);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-child-note {
      margin-top: 3px;
      min-width: 0;
    }

    .cag-item-nested-list {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 0;
      margin-top: 5px;
      margin-left: 8px;
      min-width: 0;
    }

    .cag-item-nested-list::before {
      content: '';
      position: absolute;
      left: -8px;
      top: 2px;
      bottom: 2px;
      border-left: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
      pointer-events: none;
    }

    .cag-subagent-owned-list {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 0;
      margin-top: 6px;
      margin-left: 10px;
      padding-left: 8px;
      min-width: 0;
      border-left: 1px solid color-mix(in srgb, var(--chat-info, #75beff) 36%, transparent);
    }

    .cag-subagent-owned-list::before {
      content: 'subagent';
      align-self: flex-start;
      margin: 0 0 2px -1px;
      padding: 1px 5px;
      border-radius: 4px;
      font-size: 10px;
      line-height: 1.2;
      color: var(--chat-info, #75beff);
      background: color-mix(in srgb, var(--chat-info, #75beff) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--chat-info, #75beff) 18%, transparent);
    }

    .cag-item-detail-body {
      margin-top: 5px;
      padding: 5px;
      border: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-radius: 5px;
      background: color-mix(in srgb, var(--aily-chat-viewer-panel, var(--chat-bg-subtle, rgba(255,255,255,0.025))) 86%, var(--chat-bg-hover, transparent) 14%);
    }

    .cag-item-detail-body[data-detail-kind='invocation'] {
      border-color: var(--chat-border-dim, rgba(255,255,255,0.08));
      background: color-mix(in srgb, var(--aily-chat-viewer-card-bg, var(--chat-bg-subtle, rgba(255,255,255,0.02))) 88%, var(--chat-bg-hover, transparent) 12%);
    }

    :host-context([data-theme='light']) .cag-item-detail-body {
      --cag-detail-inner-border: color-mix(in srgb, var(--aily-border-tertiary, #bfbfbf) 96%, #000 4%);
      --cag-detail-inner-border-soft: color-mix(in srgb, var(--aily-border-tertiary, #bfbfbf) 98%, #000 2%);
      --cag-detail-inner-bg: color-mix(in srgb, var(--aily-bg-secondary, #e0e0e0) 96%, #000 4%);
      --cag-detail-inner-bg-soft: color-mix(in srgb, var(--aily-bg-secondary, #e0e0e0) 98%, #000 2%);
      border-color: color-mix(in srgb, var(--aily-border-tertiary, #bfbfbf) 98%, #000 2%);
      background: color-mix(in srgb, var(--aily-bg-tertiary, #d6d6d6) 42%, var(--aily-bg-elevated, #ededed) 58%);
    }

    :host-context([data-theme='light']) .cag-item-detail-body[data-detail-kind='invocation'] {
      border-color: color-mix(in srgb, var(--aily-border-tertiary, #bfbfbf) 98%, #000 2%);
      background: color-mix(in srgb, var(--aily-bg-tertiary, #d6d6d6) 52%, var(--aily-bg-secondary, #e0e0e0) 48%);
    }

    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-state-badge,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-instruction-filter,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-tool-widget,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-tool-confirmation-summary,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-args,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output-group[data-group-kind='data'],
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output-group[data-group-kind='code'],
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output-group[data-group-kind='generic'],
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output-subpart {
      border-color: var(--cag-detail-inner-border);
      background: var(--cag-detail-inner-bg-soft);
    }

    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-tool-widget-title,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-tool-body + .cag-item-tool-body,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-detail-section + .cag-item-detail-section,
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output[data-output-kind='terminal-command'] + .cag-item-invocation-output[data-output-kind='terminal-stream'],
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output[data-output-kind='terminal-stream'] + .cag-item-invocation-output[data-output-kind='terminal-stream'],
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-invocation-output[data-output-kind='changed-file'] + .cag-item-invocation-output[data-output-kind='changed-file'],
    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-detail-row + .cag-item-detail-row {
      border-color: var(--cag-detail-inner-border-soft);
    }

    :host-context([data-theme='light']) .cag-item-detail-body .cag-item-instruction-filter-active {
      border-color: var(--cag-detail-inner-border);
      background: var(--cag-detail-inner-bg);
    }

    .cag-item-detail-body[data-detail-kind='subagent'] {
      margin-top: 2px;
      padding: 0;
      border: none;
      border-radius: 0;
      background: transparent;
    }

    .cag-item-detail-body[data-detail-kind='subagent'] .cag-item-detail-section {
      padding: 4px 12px 4px 18px;
      gap: 4px;
    }

    .cag-item-detail-body[data-detail-kind='subagent'] .cag-item-detail-section + .cag-item-detail-section {
      margin-top: 0;
      padding-top: 2px;
      border-top: none;
    }

    .cag-item-detail-body[data-detail-kind='subagent'] .cag-item-detail-section-title {
      margin-bottom: 2px;
      font-size: 11px;
      line-height: 1.2;
      font-weight: 500;
      letter-spacing: 0;
      text-transform: none;
    }

    .cag-item-detail-body[data-detail-kind='subagent'] .cag-item-detail-row {
      padding-left: 2px;
    }

    .cag-item-detail-body[data-detail-kind='subagent'] .cag-item-detail-row + .cag-item-detail-row {
      margin-top: 4px;
      padding-top: 4px;
      border-top: none;
    }

    .cag-item-detail-body[data-detail-kind='subagent'] .cag-item-detail-row-note {
      margin-top: 2px;
    }

    .cag-item-instruction-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .cag-item-state-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .cag-item-state-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 6px;
      border-radius: 5px;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
      background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
      font-size: 10px;
      line-height: 1.2;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .cag-item-state-badge[data-tone='info'] { color: var(--chat-info, #75beff); }
    .cag-item-state-badge[data-tone='success'] { color: var(--chat-success, #89d185); }
    .cag-item-state-badge[data-tone='warn'] { color: var(--chat-warn, #cca700); }
    .cag-item-state-badge[data-tone='error'] { color: var(--chat-error, #f14c4c); }

    .cag-item-state-badge-label {
      opacity: 0.8;
    }

    .cag-item-state-badge-value {
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-instruction-filters {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .cag-item-instruction-filter {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 5px;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.08));
      background: rgba(255,255,255,0.02);
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 10px;
      line-height: 1.2;
      cursor: pointer;
    }

    .cag-item-instruction-filter-active {
      background: rgba(255,255,255,0.06);
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-instruction-filter[data-tone='info'] { color: var(--chat-info, #75beff); }
    .cag-item-instruction-filter[data-tone='success'] { color: var(--chat-success, #89d185); }
    .cag-item-instruction-filter[data-tone='warn'] { color: var(--chat-warn, #cca700); }
    .cag-item-instruction-filter[data-tone='error'] { color: var(--chat-error, #f14c4c); }

    .cag-item-instruction-filter-count {
      opacity: 0.8;
    }

    .cag-item-tool-widget {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      overflow: hidden;
      background: rgba(255,255,255,0.02);
    }

    .cag-item-tool-post-confirmation {
      border-color: rgba(137, 209, 133, 0.18);
      background: rgba(137, 209, 133, 0.04);
    }

    .cag-item-tool-widget-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 22px;
      padding: 4px 8px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 12px;
      line-height: 1.35;
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-tool-widget-title .chat-confirmation-widget-title-inner {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 1;
      font-size: inherit;
      line-height: inherit;
      color: inherit;
    }

    .cag-item-tool-widget-title .chat-confirmation-widget-title-inner .rendered-markdown,
    .cag-item-tool-widget-title .chat-confirmation-widget-title-inner .rendered-markdown p {
      display: inline;
      margin: 0 !important;
      line-height: inherit;
    }

    .cag-item-tool-widget-title .codicon,
    .cag-item-tool-widget-title [class^='fa-'],
    .cag-item-tool-widget-title [class*=' fa-'] {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      font-size: 12px;
      line-height: 1;
    }

    .cag-item-tool-confirmation-summary {
      margin: 5px;
      padding: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(255,255,255,0.03);
    }

    .cag-item-tool-confirmation-summary[data-tone='success'] {
      border-color: rgba(137, 209, 133, 0.22);
      background: rgba(137, 209, 133, 0.05);
    }

    .cag-item-tool-confirmation-summary[data-tone='warn'] {
      border-color: rgba(204, 167, 0, 0.22);
      background: rgba(204, 167, 0, 0.05);
    }

    .cag-item-tool-confirmation-summary-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
    }

    .cag-item-tool-confirmation-summary-title {
      min-width: 0;
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-tool-confirmation-summary-note {
      margin-top: 4px;
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-progress-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 0;
      border: none;
      background: transparent;
    }

    .cag-item-progress-step {
      display: flex;
      gap: 0;
      min-width: 0;
      margin-bottom: 5px;
    }

    .cag-item-progress-message {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .cag-item-progress-title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }

    .cag-item-progress-title {
      min-width: 0;
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg, #cccccc);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-progress-stats {
      flex-shrink: 0;
      font-size: 10px;
      line-height: 1.2;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .cag-item-progress-subtitle {
      font-size: 11px;
      line-height: 1.3;
      color: var(--chat-fg-dim, #8e8e8e);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-progress-note {
      min-width: 0;
    }

    .cag-item-tool-body {
      padding: 5px;
    }

    .cag-item-tool-body + .cag-item-tool-body {
      padding-top: 5px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .cag-item-tool-body-title {
      margin-bottom: 5px;
      font-size: 10px;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .cag-item-detail-section + .cag-item-detail-section {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
    }

    .cag-item-detail-section-title {
      margin-bottom: 5px;
      font-size: 10px;
      line-height: 1.1;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .cag-item-invocation-args {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(255,255,255,0.03);
      padding: 5px 5px;
    }

    .cag-item-invocation-args-title {
      margin-bottom: 4px;
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg, #cccccc);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-invocation-args-note {
      min-width: 0;
      font-size: 11px;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .cag-item-invocation-timeline {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .cag-item-invocation-output-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .cag-item-invocation-output-group[data-group-kind='data'],
    .cag-item-invocation-output-group[data-group-kind='code'],
    .cag-item-invocation-output-group[data-group-kind='generic'] {
      padding: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(255,255,255,0.02);
    }

    .cag-item-invocation-output-subpart {
      min-width: 0;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(255,255,255,0.03);
      padding: 5px;
    }

    .cag-item-invocation-output[data-output-kind='terminal-command'],
    .cag-item-invocation-output[data-output-kind='terminal-stream'] {
      min-width: 0;
      padding: 0;
    }

    .cag-item-invocation-output[data-output-kind='changed-file'] {
      min-width: 0;
      padding: 0;
    }

    .cag-item-invocation-output[data-output-kind='terminal-command'] + .cag-item-invocation-output[data-output-kind='terminal-stream'],
    .cag-item-invocation-output[data-output-kind='terminal-stream'] + .cag-item-invocation-output[data-output-kind='terminal-stream'] {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }

    .cag-item-invocation-output[data-output-kind='changed-file'] + .cag-item-invocation-output[data-output-kind='changed-file'] {
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px solid rgba(255,255,255,0.04);
    }

    .cag-item-invocation-output[data-output-kind='terminal-command'] .cag-item-invocation-output-subpart,
    .cag-item-invocation-output[data-output-kind='terminal-stream'] .cag-item-invocation-output-subpart {
      border: none;
      border-radius: 0;
      background: transparent;
      padding: 0;
    }

    .cag-item-invocation-output[data-output-kind='changed-file'] .cag-item-invocation-output-subpart {
      border: none;
      border-radius: 0;
      background: transparent;
      padding: 0;
    }

    .cag-item-invocation-output-group[data-group-kind='terminal'] {
      min-width: 0;
      padding: 0;
      border: none;
      border-radius: 0;
      background: transparent;
    }

    .cag-item-invocation-output-command {
      background: transparent;
    }

    .cag-item-invocation-output-command .cag-item-detail-row-head,
    .cag-item-invocation-output-stream .cag-item-detail-row-head {
      align-items: center;
      gap: 8px;
      min-height: 22px;
    }

    .cag-item-invocation-output-changed-file {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      min-width: 0;
    }

    .cag-item-invocation-output-changed-file-code {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 10px;
      line-height: 1;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .cag-item-invocation-output-changed-file[data-tone='info'] .cag-item-invocation-output-changed-file-code {
      color: var(--chat-info, #75beff);
      border-color: rgba(117, 190, 255, 0.18);
      background: rgba(117, 190, 255, 0.08);
    }

    .cag-item-invocation-output-changed-file[data-tone='success'] .cag-item-invocation-output-changed-file-code {
      color: var(--chat-success, #89d185);
      border-color: rgba(137, 209, 133, 0.2);
      background: rgba(137, 209, 133, 0.08);
    }

    .cag-item-invocation-output-changed-file[data-tone='warn'] .cag-item-invocation-output-changed-file-code {
      color: var(--chat-warn, #cca700);
      border-color: rgba(204, 167, 0, 0.22);
      background: rgba(204, 167, 0, 0.08);
    }

    .cag-item-invocation-output-changed-file[data-tone='error'] .cag-item-invocation-output-changed-file-code {
      color: var(--chat-error, #f14c4c);
      border-color: rgba(241, 76, 76, 0.22);
      background: rgba(241, 76, 76, 0.08);
    }

    .cag-item-invocation-output-changed-file-body {
      flex: 1;
      min-width: 0;
    }

    .cag-item-invocation-output-changed-file-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      min-height: 22px;
    }

    .cag-item-invocation-output-changed-file-title {
      min-width: 0;
      font-size: 12px;
      line-height: 1.35;
      color: var(--chat-fg, #cccccc);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-invocation-output-changed-file-status {
      flex-shrink: 0;
      font-size: 10px;
      line-height: 1.2;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .cag-item-invocation-output-changed-file[data-tone='info'] .cag-item-invocation-output-changed-file-status {
      color: var(--chat-info, #75beff);
    }

    .cag-item-invocation-output-changed-file[data-tone='success'] .cag-item-invocation-output-changed-file-status {
      color: var(--chat-success, #89d185);
    }

    .cag-item-invocation-output-changed-file[data-tone='warn'] .cag-item-invocation-output-changed-file-status {
      color: var(--chat-warn, #cca700);
    }

    .cag-item-invocation-output-changed-file[data-tone='error'] .cag-item-invocation-output-changed-file-status {
      color: var(--chat-error, #f14c4c);
    }

    .cag-item-invocation-output-changed-file-subtitle {
      margin-top: 1px;
      font-size: 11px;
      line-height: 1.3;
      color: var(--chat-fg-dim, #8e8e8e);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-invocation-output-changed-file-note {
      margin-top: 3px;
      min-width: 0;
    }

    .cag-item-invocation-output-image,
    .cag-item-invocation-output-resource {
      background: rgba(116, 179, 255, 0.05);
      border-color: rgba(116, 179, 255, 0.16);
    }

    .cag-item-invocation-output-group[data-group-kind='code'] {
      background: rgba(13, 17, 23, 0.38);
      border-color: rgba(255,255,255,0.1);
    }

    .cag-item-invocation-multi-diff {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .cag-item-invocation-diff-file {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(8, 11, 16, 0.84);
    }

    .cag-item-invocation-diff-file-header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 2px 0 8px;
      background: linear-gradient(180deg, rgba(8, 11, 16, 0.98), rgba(8, 11, 16, 0.88));
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }

    .cag-item-invocation-diff-file-title-wrap {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .cag-item-invocation-diff-file-title {
      font-size: 12px;
      line-height: 1.4;
      font-weight: 600;
      color: var(--chat-fg, #cccccc);
      word-break: break-word;
    }

    .cag-item-invocation-diff-file-subtitle {
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      white-space: pre-wrap;
    }

    .cag-item-invocation-diff-file-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      align-items: center;
      min-width: 0;
    }

    .cag-item-invocation-diff-hunk {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .cag-item-invocation-diff-hunk-toggle {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 6px 8px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(255,255,255,0.03);
      color: var(--chat-fg, #cccccc);
      cursor: pointer;
      text-align: left;
    }

    .cag-item-invocation-diff-hunk-title {
      font-family: Consolas, 'Courier New', monospace;
      font-size: 11px;
      line-height: 1.4;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .cag-item-invocation-diff-hunk-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .cag-item-invocation-diff-stat {
      font-size: 10px;
      line-height: 1.2;
      font-family: Consolas, 'Courier New', monospace;
    }

    .cag-item-invocation-diff-stat-add {
      color: #8ae0d4;
    }

    .cag-item-invocation-diff-stat-remove {
      color: #ff9ab1;
    }

    .cag-item-invocation-output-code {
      background: rgba(13, 17, 23, 0.72);
      border-color: rgba(255,255,255,0.12);
    }

    .cag-item-invocation-output-stream[data-stream='stdout'] {
      background: transparent;
      border-color: transparent;
    }

    .cag-item-invocation-output-stream[data-stream='stderr'] {
      background: transparent;
      border-color: transparent;
    }

    .cag-item-invocation-output-command-note,
    .cag-item-invocation-output-code-note,
    .cag-item-invocation-output-stream-note,
    .cag-item-invocation-output-image-note,
    .cag-item-invocation-output-resource-note {
      min-width: 0;
      margin-top: 4px;
    }

    .cag-item-invocation-output-command-note,
    .cag-item-invocation-output-stream-note {
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      margin-top: 2px;
    }

    .cag-item-invocation-output-command .cag-item-detail-row-title,
    .cag-item-invocation-output-stream .cag-item-detail-row-title {
      font-size: 12px;
      line-height: 1.35;
    }

    .cag-item-invocation-output-code-block {
      margin: 0;
      padding: 10px 12px;
      overflow-x: auto;
      border-radius: 5px;
      border: 1px solid var(--aily-chat-viewer-code-border, var(--chat-border-dim, rgba(255,255,255,0.08)));
      background: var(--aily-chat-viewer-code-bg, var(--chat-bg-subtle, rgba(255,255,255,0.02)));
    }

    .cag-item-invocation-output-code-block code {
      display: block;
      white-space: pre;
      font-family: Consolas, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.5;
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-invocation-output-terminal-block {
      margin: 0;
      padding: 8px 10px;
      overflow-x: auto;
      max-height: 260px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(0,0,0,0.24);
    }

    .cag-item-invocation-output-terminal-block code {
      display: block;
      white-space: pre;
      font-family: Consolas, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.45;
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-invocation-output-diff-shell {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .cag-item-invocation-output-diff-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .cag-item-invocation-output-diff-file-link {
      color: #4da3ff;
      text-decoration: none;
      font-size: 11px;
      line-height: 1.35;
      word-break: break-all;
    }

    .cag-item-invocation-output-diff-file-link:hover {
      text-decoration: underline;
    }

    .cag-item-invocation-output-diff-language {
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.05);
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 10px;
      line-height: 1.2;
      text-transform: lowercase;
      letter-spacing: 0.04em;
    }

    .cag-item-invocation-output-diff-block {
      overflow: hidden;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(7, 10, 14, 0.92);
    }

    .cag-item-invocation-output-diff-line {
      display: grid;
      grid-template-columns: 44px 44px 18px minmax(0, 1fr);
      align-items: stretch;
      min-width: 0;
      border-top: 1px solid rgba(255,255,255,0.04);
      font-family: Consolas, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.5;
    }

    .cag-item-invocation-output-diff-line:first-child {
      border-top: none;
    }

    .cag-item-invocation-output-diff-line[data-kind='context'] {
      background: rgba(255,255,255,0.015);
    }

    .cag-item-invocation-output-diff-line[data-kind='add'] {
      background: rgba(49, 149, 138, 0.18);
    }

    .cag-item-invocation-output-diff-line[data-kind='delete'] {
      background: rgba(137, 47, 70, 0.22);
    }

    .cag-item-invocation-output-diff-line-number,
    .cag-item-invocation-output-diff-marker,
    .cag-item-invocation-output-diff-text {
      padding: 3px 8px;
      min-width: 0;
    }

    .cag-item-invocation-output-diff-line-number {
      text-align: right;
      color: rgba(255,255,255,0.38);
      background: rgba(255,255,255,0.025);
      user-select: none;
    }

    .cag-item-invocation-output-diff-marker {
      padding-left: 6px;
      padding-right: 4px;
      color: rgba(255,255,255,0.68);
      user-select: none;
    }

    .cag-item-invocation-output-diff-line[data-kind='add'] .cag-item-invocation-output-diff-marker {
      color: #8ae0d4;
    }

    .cag-item-invocation-output-diff-line[data-kind='delete'] .cag-item-invocation-output-diff-marker {
      color: #ff9ab1;
    }

    .cag-item-invocation-output-diff-text {
      white-space: pre;
      overflow-x: auto;
      color: var(--chat-fg, #cccccc);
    }

    .cag-item-invocation-output-image-preview-shell {
      margin-top: 6px;
      padding: 6px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 5px;
      background: rgba(0,0,0,0.14);
    }

    .cag-item-invocation-output-image-preview {
      display: block;
      max-width: 100%;
      max-height: 220px;
      border-radius: 5px;
      object-fit: contain;
      background: rgba(255,255,255,0.02);
    }

    .cag-item-invocation-output-image-meta,
    .cag-item-invocation-output-resource-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
      font-size: 10px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .cag-item-invocation-output-image-label,
    .cag-item-invocation-output-image-mime,
    .cag-item-invocation-output-resource-label,
    .cag-item-invocation-output-resource-mime {
      padding: 2px 6px;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.06);
    }

    .cag-item-invocation-output-resource-link {
      display: block;
      margin-top: 6px;
      color: #74b3ff;
      text-decoration: none;
      word-break: break-all;
    }

    .cag-item-invocation-output-resource-link:hover {
      text-decoration: underline;
    }

    .cag-item-invocation-row {
      min-width: 0;
      padding: 1px 0;
    }

    .cag-item-detail-row + .cag-item-detail-row {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--chat-border-dim, rgba(255,255,255,0.04));
    }

    .cag-item-detail-row-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
    }

    .cag-item-detail-row-title {
      min-width: 0;
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg, #cccccc);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-detail-row-pill {
      flex-shrink: 0;
      padding: 1px 6px;
      border-radius: 5px;
      font-size: 10px;
      line-height: 1.1;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
      background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .cag-item-detail-row-pill[data-tone='info']    { color: var(--chat-info, #75beff); }
    .cag-item-detail-row-pill[data-tone='success'] { color: var(--chat-success, #89d185); }
    .cag-item-detail-row-pill[data-tone='warn']    { color: var(--chat-warn, #cca700); }
    .cag-item-detail-row-pill[data-tone='error']   { color: var(--chat-error, #f14c4c); }

    .cag-item-detail-row-subtitle {
      margin-top: 2px;
      font-size: 11px;
      line-height: 1.3;
      color: var(--chat-fg-dim, #8e8e8e);
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-detail-row-note {
      margin-top: 3px;
      min-width: 0;
    }

    .cag-item-detail-row-reference-shell {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      margin-top: 4px;
    }

    .cag-item-detail-row-reference {
      min-width: 0;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 11px;
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cag-item-detail-row-open {
      flex: 0 0 auto;
      border: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-radius: 999px;
      background: transparent;
      color: var(--chat-fg, #cccccc);
      padding: 1px 8px;
      cursor: pointer;
      font-size: 10px;
      line-height: 1.2;
    }

    :host ::ng-deep .cag-item-markdown,
    :host ::ng-deep .cag-item-markdown.x-markdown,
    :host ::ng-deep .cag-item-markdown .x-markdown {
      font-size: 12px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      font-weight: 400;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    :host ::ng-deep .cag-item-thinking-content .cag-item-markdown,
    :host ::ng-deep .cag-item-thinking-content .cag-item-markdown.x-markdown,
    :host ::ng-deep .cag-item-thinking-content .cag-item-markdown .x-markdown {
      font-size: 12px;
      line-height: 1.35;
      color: var(--chat-fg-dim, #8e8e8e);
      font-weight: 400;
    }

    :host ::ng-deep .cag-item-markdown p,
    :host ::ng-deep .cag-item-markdown li,
    :host ::ng-deep .cag-item-markdown blockquote {
      font-size: inherit;
      line-height: inherit;
      color: inherit;
      font-weight: inherit;
    }

    :host ::ng-deep .cag-item-markdown p {
      margin: 0 0 4px;
    }

    :host ::ng-deep .cag-item-markdown p:last-child {
      margin-bottom: 0;
    }

    :host ::ng-deep .cag-item-markdown ul,
    :host ::ng-deep .cag-item-markdown ol {
      margin: 2px 0 4px;
      padding-left: 1.2em;
      color: inherit;
    }

    :host ::ng-deep .cag-item-markdown strong {
      color: inherit;
      font-weight: 600;
    }

    :host ::ng-deep .cag-item-markdown a {
      color: var(--chat-link, #4daafc);
    }

    :host ::ng-deep .cag-item-markdown code:not(pre code) {
      font-size: 11px;
      line-height: 1.25;
      color: var(--chat-fg-dim, #8e8e8e);
      background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
      border-radius: 3px;
      padding: 0 3px;
    }

    @keyframes cag-spin {
      to { transform: rotate(360deg); }
    }

    .cag-spin {
      display: inline-block;
      transform-origin: center center;
      transform-box: fill-box;
      will-change: transform;
      animation: cag-spin 0.8s linear infinite;
    }
  `],
})
export class ChatActivityItemComponent implements OnChanges {
  private readonly translate = inject(TranslateService);
  @Input({ required: true }) item!: ActivityGroupDisplayItem;
  @Input() sessionId = '';
  @Input() impliedWordLoadRate: number | undefined;
  @Input() first = false;
  @Input() last = false;
  @Input() only = false;
  @Input() contentDeltaHandler: (() => void) | undefined;
  @ViewChild(XAilyThinkViewerComponent) private thinkingViewer?: XAilyThinkViewerComponent;

  readonly componentMap: ComponentMap = { code: AilyChatCodeComponent };
  private readonly runtimeInteractionHost = inject(ChatRuntimeInteractionHostService, { optional: true });
  private readonly chatViewState = inject(ChatViewService, { optional: true });
  private readonly cdr = inject(ChangeDetectorRef);

  detailExpanded = false;
  stableToolHeader: ActivityToolHeaderDisplayData | null = null;
  mermaidInstance: any = null;
  private stableToolHeaderItemId = '';
  private mermaidLoading = false;

  emitContentDelta(): void {
    this.contentDeltaHandler?.();
  }

  shouldRenderInlineApproval(): boolean {
    return !!this.item?.approval && (this.item.approval.resolved === true || this.hasActiveInlineApproval());
  }

  isPendingApprovalItem(): boolean {
    return !!this.item?.approval && this.item.approval.resolved !== true;
  }

  isInteractiveInlineApproval(): boolean {
    return this.hasActiveInlineApproval();
  }

  onInlineApprovalDecision(decision: RuntimeConfirmationDecision): void {
    if (!this.sessionId || !this.hasActiveInlineApproval()) {
      return;
    }

    const activeConfirmation = this.runtimeInteractionHost?.getActiveConfirmation(this.sessionId);
    if (!activeConfirmation) {
      return;
    }

    if (decision.sideEffectOnly && typeof decision.actionId === 'string' && decision.actionId.length > 0) {
      if (decision.actionId === OPEN_MAX_REQUESTS_SETTINGS_ACTION_ID) {
        this.chatViewState?.openSettings();
        return;
      }

      this.runtimeInteractionHost?.triggerConfirmationAction(this.sessionId, activeConfirmation.id, decision.actionId);
      return;
    }

    if (activeConfirmation.toolCallId) {
      this.runtimeInteractionHost?.resolveToolApproval(this.sessionId, activeConfirmation.toolCallId, decision);
      return;
    }

    this.runtimeInteractionHost?.resolveConfirmation(this.sessionId, activeConfirmation.id, decision);
  }

  private hasActiveInlineApproval(): boolean {
    if (!this.sessionId || !this.item?.approval) {
      return false;
    }

    const activeConfirmation = this.runtimeInteractionHost?.getActiveConfirmation(this.sessionId);
    if (!activeConfirmation) {
      return false;
    }

    if (activeConfirmation.partId && this.item.approval.partId) {
      return activeConfirmation.partId === this.item.approval.partId;
    }

    if (activeConfirmation.askId && this.item.approval.askId) {
      return activeConfirmation.askId === this.item.approval.askId;
    }

    if (activeConfirmation.toolCallId && this.item.approval.toolCallId) {
      return activeConfirmation.toolCallId === this.item.approval.toolCallId;
    }

    return false;
  }

  selectedInstructionFilter: InstructionDiagnosticFilter = 'all';
  private readonly collapsedDiffHunks = new Set<string>();
  private lastAutoDetailExpanded = false;
  private thinkingViewerDataCacheKey = '';
  private thinkingViewerDataCache: {
    content?: string;
    ref?: string;
    contentLength?: number;
    isComplete?: boolean;
  } | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['item']) {
      const previousItem = changes['item'].previousValue as ActivityGroupDisplayItem | undefined;
      this.syncInputFromItem(previousItem);
    }
  }

  applyVisibleActivityItemPatch(input: {
    readonly item: ActivityGroupDisplayItem;
    readonly sessionId: string;
    readonly impliedWordLoadRate?: number;
    readonly first: boolean;
    readonly last: boolean;
    readonly only: boolean;
  }): boolean {
    if (!input.item || input.item.id !== this.item?.id) {
      return false;
    }
    const previousItem = this.item;
    this.item = input.item;
    this.sessionId = input.sessionId;
    this.impliedWordLoadRate = input.impliedWordLoadRate;
    this.first = input.first;
    this.last = input.last;
    this.only = input.only;
    if (canPatchStreamingThinkingItemWithoutDetect(previousItem, input.item)) {
      this.thinkingViewerDataCacheKey = '';
      this.thinkingViewerDataCache = null;
      if (this.thinkingViewer?.applyVisibleThinkingPatch(
        this.getThinkingViewerData(),
        input.impliedWordLoadRate,
      )) {
        return true;
      }
    }
    this.syncInputFromItem(previousItem);
    this.cdr.detectChanges();
    return true;
  }

  private syncInputFromItem(previousItem: ActivityGroupDisplayItem | undefined): void {
    const syncStartedAt = performance.now();
    const isSameItem = previousItem?.id === this.item.id;
    const nextAutoDetailExpanded = this.shouldAutoExpandDetails();

    if (!isSameItem) {
      this.detailExpanded = nextAutoDetailExpanded;
    } else if (nextAutoDetailExpanded !== this.lastAutoDetailExpanded) {
      this.detailExpanded = nextAutoDetailExpanded;
    } else if (this.item.detailExpanded === true && !this.detailExpanded && !this.isCommandSessionContinuedInBackground()) {
      this.detailExpanded = true;
    }

    if (this.detailExpanded) {
      this.ensureLazyDetailLoaded();
    }
    void this.ensureMermaidInstance();

    this.syncStableToolHeader(isSameItem);
    this.lastAutoDetailExpanded = nextAutoDetailExpanded;
    this.selectedInstructionFilter = 'all';
    const markdownSurfaceCount = countActivityItemMarkdownSurfaces(this.item, this.detailExpanded);
    ChatPerformanceTracer.increment('activity_item.markdown_instances', markdownSurfaceCount);
    ChatPerformanceTracer.recordDuration(
      'activity_item.input_sync',
      performance.now() - syncStartedAt,
      `id=${this.item.id},kind=${this.item.kind},detail=${this.detailExpanded},markdownSurfaces=${markdownSurfaceCount}`,
      { slowThresholdMs: 4 },
    );
  }

  hasDetailSections(): boolean {
    return (this.item.detailSections?.length || 0) > 0;
  }

  isToolHeader(): boolean {
    return !!this.item.toolHeader || this.item.headerKind === 'tool';
  }

  private syncStableToolHeader(isSameItem: boolean): void {
    const nextHeader = this.item.toolHeader;
    if (!nextHeader) {
      this.stableToolHeader = null;
      this.stableToolHeaderItemId = '';
      return;
    }

    if (!isSameItem || this.stableToolHeaderItemId !== this.item.id || !this.stableToolHeader) {
      this.stableToolHeader = { ...nextHeader };
      this.stableToolHeaderItemId = this.item.id;
      return;
    }

    this.stableToolHeader = {
      title: nextHeader.title || this.stableToolHeader.title,
      subtitle: nextHeader.subtitle || this.stableToolHeader.subtitle,
      meta: nextHeader.meta || this.stableToolHeader.meta,
      pill: nextHeader.pill,
      pillTone: nextHeader.pillTone,
    };
  }

  getThinkingViewerData(): {
    content?: string;
    ref?: string;
    contentLength?: number;
    isComplete?: boolean;
  } {
    const thinking = this.item.thinking;
    const cacheKey = [
      this.item.id,
      thinking?.ref ?? '',
      thinking?.content ?? this.item.note ?? '',
      thinking?.contentLength ?? '',
      thinking?.isComplete ?? !this.item.isSpinning,
    ].join('\u0000');
    if (this.thinkingViewerDataCacheKey === cacheKey && this.thinkingViewerDataCache) {
      return this.thinkingViewerDataCache;
    }

    this.thinkingViewerDataCacheKey = cacheKey;
    if (thinking?.ref) {
      this.thinkingViewerDataCache = {
        ref: thinking.ref,
        ...(typeof thinking.contentLength === 'number' ? { contentLength: thinking.contentLength } : {}),
        isComplete: thinking.isComplete,
      };
      return this.thinkingViewerDataCache;
    }

    this.thinkingViewerDataCache = {
      content: thinking?.content ?? this.item.note ?? '',
      isComplete: thinking?.isComplete ?? !this.item.isSpinning,
    };
    return this.thinkingViewerDataCache;
  }

  shouldRenderHeaderToolbar(): boolean {
    return !this.hasTerminalOutputGroup();
  }

  getTerminalToolbarActions(): readonly ActivityToolbarActionDisplayData[] {
    return (this.item.toolbarActions || []).filter(action => this.shouldShowTerminalToolbarAction(action));
  }

  private shouldShowTerminalToolbarAction(action: ActivityToolbarActionDisplayData): boolean {
    if (action.id === 'continue-background') {
      const processId = this.getToolbarProcessId(action);
      return !!processId
        && !action.disabled
        && this.runtimeInteractionHost?.isCommandSessionBackground(this.sessionId, processId) !== true;
    }
    if (action.id === 'stop-process') {
      return !!this.getToolbarProcessId(action) && !action.disabled;
    }
    if (action.id === 'open-output-file') {
      return !action.disabled;
    }
    if (action.id === 'open-process-window') {
      return !!this.getToolbarProcessId(action) && !action.disabled;
    }
    return true;
  }

  private hasTerminalOutputGroup(): boolean {
    const invocationDetail = this.item.invocationDetail;
    if (!invocationDetail) {
      return false;
    }

    return invocationDetail.outputSections.some(section =>
      this.getOutputGroups(section).some(group => group.kind === 'terminal'),
    );
  }

  getInstructionProjection() {
    return buildInstructionDetailProjection({
      id: this.item.id,
      metadata: this.item.instructionMetadata || null,
      selectedFilter: this.selectedInstructionFilter,
    });
  }

  selectInstructionFilter(filterId: InstructionDiagnosticFilter): void {
    this.selectedInstructionFilter = filterId;
  }

  handleToolbarAction(action: ActivityToolbarActionDisplayData, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    this.runToolbarAction(action);
  }

  handleTerminalToolbarAction(action: ActivityToolbarActionDisplayData): void {
    this.runToolbarAction(action);
  }

  private runToolbarAction(action: ActivityToolbarActionDisplayData): void {
    if (this.isToolbarActionDisabled(action)) {
      return;
    }

    switch (action.id) {
      case 'toggle-output':
        this.toggleDetail();
        return;
      case 'open-output-file':
        this.openToolbarOutputFile(action);
        return;
      case 'open-process-window':
        this.openToolbarProcessWindow(action);
        return;
      case 'continue-background':
        void this.continueToolbarProcessInBackground(action);
        return;
      case 'stop-process':
        void this.stopToolbarProcess(action);
        return;
      default:
        return;
    }
  }

  isToolbarActionDisabled(action: ActivityToolbarActionDisplayData): boolean {
    if (action.disabled) {
      return true;
    }
    if (action.id === 'continue-background') {
      const processId = this.getToolbarProcessId(action);
      return !processId || this.runtimeInteractionHost?.isCommandSessionBackground(this.sessionId, processId) === true;
    }
    return false;
  }

  private async continueToolbarProcessInBackground(action: ActivityToolbarActionDisplayData): Promise<void> {
    const processId = this.getToolbarProcessId(action);
    if (!processId || !this.runtimeInteractionHost) {
      return;
    }

    await this.runtimeInteractionHost.requestCommandSessionAction(this.sessionId, {
      actionId: 'continue_background',
      processId,
      outputSessionId: typeof action.data?.['outputSessionId'] === 'string' ? action.data['outputSessionId'] : undefined,
      outputFilePath: typeof action.data?.['outputFilePath'] === 'string' ? action.data['outputFilePath'] : undefined,
    });
    this.detailExpanded = false;
    this.item = {
      ...this.item,
      toolHeader: this.item.toolHeader
        ? {
            ...this.item.toolHeader,
            pill: '后台运行',
            pillTone: 'neutral',
          }
        : this.item.toolHeader,
      toolbarActions: this.item.toolbarActions?.filter(toolbarAction => toolbarAction.id !== 'continue-background'),
    };
    this.cdr.markForCheck();
  }

  private async stopToolbarProcess(action: ActivityToolbarActionDisplayData): Promise<void> {
    const processId = this.getToolbarProcessId(action);
    if (!processId || !this.runtimeInteractionHost) {
      return;
    }

    const result = await this.runtimeInteractionHost.requestCommandSessionAction(this.sessionId, {
      actionId: 'stop',
      processId,
      outputSessionId: typeof action.data?.['outputSessionId'] === 'string' ? action.data['outputSessionId'] : undefined,
      outputFilePath: typeof action.data?.['outputFilePath'] === 'string' ? action.data['outputFilePath'] : undefined,
    });
    this.applyCommandSessionActionResult(result);
  }

  private applyCommandSessionActionResult(result: RuntimeCommandSessionActionResult): void {
    if (!result.ok || result.actionId !== 'stop') {
      return;
    }

    const snapshot = result.snapshot;
    const running = snapshot?.running === true;
    const exitCode = typeof snapshot?.exitCode === 'number' ? snapshot.exitCode : 130;
    const status = snapshot?.status || 'killed';
    const stopped = !running;
    const terminalState = resolveTerminalLifecycleState({ running, exitCode, status });

    this.item = {
      ...this.item,
      isSpinning: running,
      iconClass: terminalState === 'running'
        ? this.item.iconClass
        : terminalState === 'failed'
          ? 'fa-light fa-circle-xmark'
          : terminalState === 'cancelled'
            ? 'fa-light fa-circle-minus'
            : 'fa-light fa-circle-check',
      iconColor: running
        ? this.item.iconColor
        : terminalState === 'failed'
          ? '#d4380d'
          : terminalState === 'cancelled'
            ? '#d89614'
            : '#389e0d',
      toolHeader: this.item.toolHeader
        ? {
            ...this.item.toolHeader,
            meta: stopped && exitCode != null ? `退出码 ${exitCode}` : this.item.toolHeader.meta,
            pill: stopped
              ? (terminalState === 'cancelled'
                  ? '已取消'
                  : (status === 'killed' ? '已停止' : this.item.toolHeader.pill))
              : this.item.toolHeader.pill,
            pillTone: stopped
              ? (terminalState === 'failed'
                  ? 'error'
                  : (terminalState === 'cancelled' || status === 'killed' ? 'warn' : this.item.toolHeader.pillTone))
              : this.item.toolHeader.pillTone,
          }
        : this.item.toolHeader,
      toolbarActions: this.item.toolbarActions?.filter(toolbarAction =>
        toolbarAction.id !== 'stop-process' && toolbarAction.id !== 'continue-background',
      ),
    };
    this.cdr.markForCheck();
  }

  private getToolbarProcessId(action: ActivityToolbarActionDisplayData): string {
    return typeof action.data?.['processId'] === 'string'
      ? action.data['processId'].trim()
      : '';
  }

  private openToolbarOutputFile(action: ActivityToolbarActionDisplayData): void {
    const outputFilePath = typeof action.data?.['outputFilePath'] === 'string'
      ? action.data['outputFilePath'].trim()
      : '';
    if (!outputFilePath) {
      return;
    }

    AilyHost.get().shell?.openByExplorer?.(outputFilePath);
  }

  private openToolbarProcessWindow(action: ActivityToolbarActionDisplayData): void {
    const processId = this.getToolbarProcessId(action);
    if (!processId || !this.sessionId) {
      return;
    }

    const command = typeof action.data?.['command'] === 'string'
      ? action.data['command']
      : undefined;
    const toolId = resolveChildToolIdFromProcess({
      processId,
      command,
      cwd: typeof action.data?.['cwd'] === 'string' ? action.data['cwd'] : undefined,
      outputFilePath: typeof action.data?.['outputFilePath'] === 'string' ? action.data['outputFilePath'] : undefined,
      subappName: typeof action.data?.['subappName'] === 'string' ? action.data['subappName'] : undefined,
    });
    if (toolId) {
      AilyHost.get().ui?.openToolWindow?.(toolId, { title: this.resolveChildToolDisplayName(toolId) });
      return;
    }

    openChatProcessWindow({
      sessionId: this.sessionId,
      processId,
      outputSessionId: typeof action.data?.['outputSessionId'] === 'string'
        ? action.data['outputSessionId']
        : undefined,
      outputFilePath: typeof action.data?.['outputFilePath'] === 'string'
        ? action.data['outputFilePath']
        : undefined,
      command,
    });
  }

  private resolveChildToolDisplayName(toolId: string): string {
    const config = getChildToolConfig(toolId);
    if (!config) {
      return toolId;
    }

    const globalName = this.translate.instant(config.namespace);
    if (typeof globalName === 'string' && globalName && globalName !== config.namespace) {
      return globalName;
    }

    const title = this.translate.instant(config.titleKey);
    if (typeof title === 'string' && title && title !== config.titleKey) {
      return title;
    }

    return toolId;
  }

  hasDetailContent(): boolean {
    return this.hasDetailSections() || !!this.item.loadDetail || !!this.item.instructionMetadata;
  }

  shouldAutoExpandDetails(): boolean {
    if (this.isCommandSessionContinuedInBackground()) {
      return false;
    }

    if (this.item.detailExpanded === true) {
      return true;
    }

    if (!this.hasDetailContent()) {
      return false;
    }

    if (this.item.detailKind === 'invocation') {
      return this.item.isSpinning && this.hasLiveInvocationOutput();
    }

    return this.item.isSpinning;
  }

  private hasLiveInvocationOutput(): boolean {
    const invocationDetail = this.item.invocationDetail;
    if (!invocationDetail) {
      return false;
    }

    return invocationDetail.outputSections.some((section) => (section.rows?.length || 0) > 0);
  }

  private isCommandSessionContinuedInBackground(): boolean {
    const action = this.item.toolbarActions?.find(toolbarAction =>
      toolbarAction.id === 'continue-background' || toolbarAction.id === 'stop-process',
    );
    const processId = action ? this.getToolbarProcessId(action) : '';
    return !!processId && this.runtimeInteractionHost?.isCommandSessionBackground(this.sessionId, processId) === true;
  }

  toggleDetail(): void {
    if (!this.hasDetailContent()) {
      return;
    }
    const nextExpanded = !this.detailExpanded;
    if (nextExpanded) {
      this.ensureLazyDetailLoaded();
      void this.ensureMermaidInstance();
    }
    this.detailExpanded = nextExpanded;
  }

  toggleDetailFromKeyboard(event: Event): void {
    event.preventDefault();
    this.toggleDetail();
  }

  private ensureLazyDetailLoaded(): void {
    if (!this.item.loadDetail || this.item.detailSections?.length || this.item.invocationDetail) {
      return;
    }

    const startedAt = performance.now();
    const detail = this.item.loadDetail();
    (this.item as ActivityGroupDisplayItem).detailSections = detail.detailSections;
    (this.item as ActivityGroupDisplayItem).invocationDetail = detail.invocationDetail;
    if (detail.detailKind) {
      (this.item as ActivityGroupDisplayItem).detailKind = detail.detailKind;
    }
    ChatPerformanceTracer.recordDuration(
      'activity_item.lazy_detail_load',
      performance.now() - startedAt,
      `id=${this.item.id},kind=${this.item.detailKind || 'unknown'},sections=${detail.detailSections?.length || 0}`,
      { slowThresholdMs: 8 },
    );
  }

  private async ensureMermaidInstance(): Promise<void> {
    if (this.mermaidInstance || this.mermaidLoading || !this.hasMermaidRows()) {
      return;
    }

    this.mermaidLoading = true;
    try {
      const module = await import('mermaid');
      this.mermaidInstance = module.default ?? module;
      this.cdr.markForCheck();
    } finally {
      this.mermaidLoading = false;
    }
  }

  private hasMermaidRows(): boolean {
    return this.collectMermaidRows(this.getDetailSectionsForMermaid()).length > 0;
  }

  private getDetailSectionsForMermaid(): readonly DetailSectionDescriptor[] {
    if (!this.item) {
      return [];
    }
    const sections: readonly DetailSectionDescriptor[] = [
      ...(this.item.detailSections || []),
      ...(this.item.invocationDetail?.progressSection ? [this.item.invocationDetail.progressSection] : []),
      ...(this.item.invocationDetail?.argsSection ? [this.item.invocationDetail.argsSection] : []),
      ...(this.item.invocationDetail?.outputSections || []),
      ...(this.item.invocationDetail?.historySections || []),
    ];

    return sections;
  }

  private collectMermaidRows(sections: readonly DetailSectionDescriptor[]): readonly StateDetailRow[] {
    const rows: StateDetailRow[] = [];
    const seen = new Set<string>();
    for (const section of sections) {
      for (const row of section.rows || []) {
        this.addMermaidRow(rows, seen, row);
      }
      for (const group of section.outputGroups || []) {
        for (const row of group.rows || []) {
          this.addMermaidRow(rows, seen, row);
        }
      }
    }
    return rows;
  }

  private addMermaidRow(rows: StateDetailRow[], seen: Set<string>, row: StateDetailRow): void {
    if (row.outputKind !== 'mermaid') {
      return;
    }
    const code = row.outputCode || row.note || '';
    if (!code.trim()) {
      return;
    }
    const key = row.id || `${row.title || 'mermaid'}:${code}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    rows.push(row);
  }

  getOutputImageSource(row: StateDetailRow): string | null {
    if (row.outputKind !== 'image') {
      return null;
    }
    if (row.outputUri) {
      return row.outputUri;
    }
    if (row.outputData) {
      return `data:${row.outputMimeType || 'image/png'};base64,${row.outputData}`;
    }
    return null;
  }

  getOutputResourceHref(row: StateDetailRow): string | null {
    return row.outputKind === 'resource' && row.outputUri ? row.outputUri : null;
  }

  getOutputCodeHref(row: StateDetailRow): string | null {
    return getDiffOutputHref(row);
  }

  openExternalLink(url: string | null | undefined, event?: Event): void {
    if (!url) {
      return;
    }

    event?.preventDefault();
    event?.stopPropagation();

    const host = AilyHost.get();
    if (host.shell?.openByBrowser) {
      host.shell.openByBrowser(url);
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  isDiffOutput(row: StateDetailRow): boolean {
    return isDiffOutputRow(row);
  }

  isGroupedDiffGroup(group: StateDetailOutputGroup): boolean {
    return isGroupedDiffOutputGroup(group);
  }

  getTerminalGroupTone(group: StateDetailOutputGroup): 'info' | 'success' | 'error' | 'neutral' {
    const command = this.getTerminalCommandRow(group);
    if (command?.tone === 'info' || command?.tone === 'success' || command?.tone === 'error' || command?.tone === 'neutral') {
      return command.tone;
    }

    const status = `${command?.trailing || ''} ${command?.subtitle || ''}`.toLowerCase();
    if (status.includes('运行') || status.includes('running')) {
      return 'info';
    }
    if (status.includes('失败') || status.includes('error') || status.includes('exit') && !status.includes('exit 0') || status.includes('退出码 ') && !status.includes('退出码 0')) {
      return 'error';
    }
    if (status.includes('完成') || status.includes('success') || status.includes('completed') || status.includes('退出码 0')) {
      return 'success';
    }
    if (group.rows.some(row => row.outputChannel === 'stderr' && (row.note || '').trim().length > 0)) {
      return 'error';
    }
    return 'neutral';
  }

  getTerminalGroupIconClass(group: StateDetailOutputGroup): string {
    const tone = this.getTerminalGroupTone(group);
    if (tone === 'success') {
      return 'fa-light fa-circle-check';
    }
    if (tone === 'error') {
      return 'fa-light fa-circle-xmark';
    }
    if (tone === 'info') {
      return 'fa-light fa-spinner-third cag-spin';
    }
    return 'fa-light fa-terminal';
  }

  getTerminalCommandText(group: StateDetailOutputGroup): string {
    return this.getTerminalCommandRow(group)?.note?.trim() || 'terminal command';
  }

  getTerminalCommandSubtitle(group: StateDetailOutputGroup): string | undefined {
    return this.getTerminalCommandRow(group)?.subtitle;
  }

  getTerminalCommandStatus(group: StateDetailOutputGroup): string | undefined {
    return this.getTerminalCommandRow(group)?.trailing;
  }

  hasTerminalOutput(group: StateDetailOutputGroup): boolean {
    return group.rows.some(row => row.outputKind === 'terminal-stream' && (row.note || '').trim().length > 0);
  }

  getTerminalOutputText(group: StateDetailOutputGroup): string {
    const stdout = group.rows
      .filter(row => row.outputKind === 'terminal-stream' && row.outputChannel !== 'stderr')
      .map(row => row.note || '')
      .filter(text => text.length > 0)
      .join('\n');
    const stderr = group.rows
      .filter(row => row.outputKind === 'terminal-stream' && row.outputChannel === 'stderr')
      .map(row => row.note || '')
      .filter(text => text.length > 0)
      .join('\n');

    if (stdout && stderr) {
      return `${stdout.replace(/\s+$/u, '')}\n\n[stderr]\n${stderr}`;
    }
    return stdout || stderr;
  }

  getGroupedDiffFiles(rows: readonly StateDetailRow[]): readonly DiffDisplayFile[] {
    return getGroupedDiffFiles(rows);
  }

  getDiffLines(row: StateDetailRow): readonly DiffDisplayLine[] {
    return getDiffDisplayLines(row);
  }

  isDiffHunkCollapsed(hunkId: string): boolean {
    return this.collapsedDiffHunks.has(hunkId);
  }

  toggleDiffHunk(hunkId: string): void {
    if (this.collapsedDiffHunks.has(hunkId)) {
      this.collapsedDiffHunks.delete(hunkId);
      return;
    }
    this.collapsedDiffHunks.add(hunkId);
  }

  getOutputGroups(section: DetailSectionDescriptor): readonly StateDetailOutputGroup[] {
    if (section.outputGroups && section.outputGroups.length > 0) {
      return section.outputGroups;
    }

    return section.rows.length > 0
      ? [{ id: `${section.title}:fallback`, kind: 'generic', rows: section.rows }]
      : [];
  }

  private getTerminalCommandRow(group: StateDetailOutputGroup): StateDetailRow | undefined {
    return group.rows.find(row => row.outputKind === 'terminal-command');
  }

  getResolvedReferenceLabel(reference: string): string {
    const host = AilyHost.get();
    return getBlocklyArtifactReferenceLabel(host, reference, {
      cwd: this.getProjectPath(),
      sessionId: this.sessionId,
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
      sessionId: this.sessionId,
    });
  }

  private getProjectPath(): string {
    const host = AilyHost.get();
    return host.project.currentProjectPath || host.project.projectRootPath || '';
  }
}

function canPatchStreamingThinkingItemWithoutDetect(
  previous: ActivityGroupDisplayItem,
  next: ActivityGroupDisplayItem,
): boolean {
  return previous.id === next.id
    && previous.kind === 'thinking'
    && next.kind === 'thinking'
    && previous.isSpinning
    && next.isSpinning
    && previous.thinking?.isComplete === false
    && next.thinking?.isComplete === false
    && !!previous.thinking.ref
    && previous.thinking.ref === next.thinking.ref
    && previous.iconClass === next.iconClass
    && previous.iconColor === next.iconColor
    && previous.kicker === next.kicker
    && previous.label === next.label
    && previous.subtitle === next.subtitle
    && previous.headerMeta === next.headerMeta
    && previous.pill === next.pill
    && previous.pillTone === next.pillTone;
}

function countActivityItemMarkdownSurfaces(item: ActivityGroupDisplayItem, detailExpanded: boolean): number {
  let count = 0;
  if (item.note && item.noteRenderMode !== 'plain') {
    count += 1;
  }
  for (const child of item.children || []) {
    if (child.content) {
      count += 1;
    }
  }
  for (const nestedItem of item.nestedItems || []) {
    count += countActivityItemMarkdownSurfaces(nestedItem, detailExpanded);
  }
  for (const subagentItem of item.subagentItems || []) {
    count += countActivityItemMarkdownSurfaces(subagentItem, detailExpanded);
  }

  if (!detailExpanded) {
    return count;
  }

  count += countDetailSectionMarkdownSurfaces(item.detailSections || []);
  const invocation = item.invocationDetail;
  if (invocation) {
    if (invocation.progressSection) {
      count += countDetailSectionMarkdownSurfaces([invocation.progressSection]);
    }
    if (invocation.argsSection) {
      count += countDetailSectionMarkdownSurfaces([invocation.argsSection]);
    }
    count += countDetailSectionMarkdownSurfaces(invocation.outputSections);
    count += countDetailSectionMarkdownSurfaces(invocation.historySections);
  }
  return count;
}

function countDetailSectionMarkdownSurfaces(sections: readonly DetailSectionDescriptor[]): number {
  let count = 0;
  for (const section of sections) {
    for (const row of section.rows || []) {
      if (row.note) {
        count += 1;
      }
      if (row.outputCode) {
        count += 1;
      }
    }
    for (const group of section.outputGroups || []) {
      for (const row of group.rows || []) {
        if (row.note) {
          count += 1;
        }
        if (row.outputCode) {
          count += 1;
        }
      }
    }
  }
  return count;
}
