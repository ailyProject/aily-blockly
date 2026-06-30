import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { AilyHost } from '../../../core/host';
import {
  appendDetailSections,
  buildInstructionDetailProjection,
  buildStandardStateViewerProjection,
  type DetailSectionDescriptor,
  type InstructionDiagnosticFilter,
  type InstructionFilterChip,
  type StateDetailOutputGroup,
  type StateDetailSection,
  type StateTone,
} from './activity-detail-items';
import { getBlocklyArtifactReferenceLabel, resolveBlocklyArtifactReferenceTarget } from '../../../helpers/chat-artifact-reference';

interface StateBadge {
  label: string;
  value: string;
  tone?: StateTone;
}

interface StateViewerData {
  state?: string;
  text?: string;
  progress?: number;
  id?: string;
  kind?: string;
  metadata?: Record<string, unknown> | null;
}

@Component({
  selector: 'x-aily-state-viewer',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  template: `
    <div
      class="ac-state"
      [attr.data-state]="data?.state"
      [attr.data-kind]="data?.kind || null"
      [class.ac-state-embedded]="embedded"
      [class.ac-state-body-only]="bodyOnly"
      [class.ac-state-has-details]="hasDetails"
      [class.ac-state-expanded]="expanded">
      @if (data?.state === 'doing') {
        <div class="ac-state-progress-bg" [style.animation-duration]="data?.progress != null ? '0s' : '2s'">
          @if (data?.progress != null) {
            <div class="ac-state-progress-fill" [style.width.%]="data.progress"></div>
          }
        </div>
      }
      @if (!bodyOnly) {
        <button
          type="button"
          class="ac-state-header"
          [class.ac-state-header-clickable]="hasExpandableDetails && !embedded"
          [attr.aria-expanded]="(hasExpandableDetails && !embedded) ? expanded : null"
          [attr.aria-label]="(hasExpandableDetails && !embedded) ? ((expanded ? 'AILY_CHAT.DETAIL_COLLAPSE_STATE' : 'AILY_CHAT.DETAIL_EXPAND_STATE') | translate) : null"
          (click)="hasExpandableDetails && !embedded ? toggleExpanded() : null">
          <i [class]="stateIconClass"></i>
          <div class="ac-state-title-group">
            <span class="ac-state-text">{{ headerTitle || data?.text }}</span>
            @if (headerSubtitle) {
              <span class="ac-state-subtitle">{{ headerSubtitle }}</span>
            }
          </div>
          @if (headerStatusLabel) {
            <span class="ac-state-status" [attr.data-tone]="headerStatusTone">{{ headerStatusLabel }}</span>
          } @else if (data?.progress != null) {
            <span class="ac-state-pct">{{ data.progress }}%</span>
          }
          @if (hasExpandableDetails && !embedded) {
            <i class="fa-light fa-chevron-down ac-state-arrow" aria-hidden="true"></i>
          }
        </button>
      }

      @if (hasDetails) {
        @if (showSummaryBadges() || (hasExpandableDetails && !embedded)) {
          <div class="ac-state-summary">
            @if (showSummaryBadges()) {
              <div class="ac-state-badges ac-state-badges-standalone">
                @for (badge of summaryBadges; track badge.label + ':' + badge.value) {
                  <span class="ac-state-badge" [attr.data-tone]="badge.tone || 'neutral'">
                    <span class="ac-state-badge-label">{{ badge.label | translate }}</span>
                    <span class="ac-state-badge-value">{{ badge.value }}</span>
                  </span>
                }
              </div>
            }

            @if (hasExpandableDetails && !embedded) {
              <button
                type="button"
                class="ac-state-toggle"
                [attr.aria-expanded]="expanded"
                [attr.aria-label]="(expanded ? 'AILY_CHAT.DETAIL_COLLAPSE' : 'AILY_CHAT.DETAIL_EXPAND') | translate"
                (click)="toggleExpanded()">
                <span class="ac-state-toggle-label">{{ (expanded ? 'AILY_CHAT.DETAIL_COLLAPSE' : 'AILY_CHAT.DETAIL_EXPAND') | translate }}</span>
                <i class="fa-light fa-chevron-down ac-state-toggle-icon" aria-hidden="true"></i>
              </button>
            }
          </div>
        }

        @if (instructionFilterChips.length > 0) {
          <div class="ac-state-filters">
            @for (chip of instructionFilterChips; track chip.id) {
              <button
                type="button"
                class="ac-state-filter"
                [class.ac-state-filter-active]="chip.active"
                [attr.data-tone]="chip.tone || 'neutral'"
                [attr.aria-pressed]="chip.active"
                (click)="selectInstructionFilter(chip.id)">
                <span class="ac-state-filter-label">{{ chip.label }}</span>
                <span class="ac-state-filter-count">{{ chip.count }}</span>
              </button>
            }
          </div>
        }

        @if ((embedded || expanded) && sections.length > 0) {
          <div class="ac-state-detail">
            @for (section of sections; track section.title) {
              <div class="ac-state-section">
                @if (section.title) {
                  <div class="ac-state-section-title">{{ section.title | translate }}</div>
                }
                @if (getOutputGroups(section).length > 0) {
                  <div class="ac-state-output-groups">
                    @for (group of getOutputGroups(section); track group.id) {
                      <div class="ac-state-output-group" [attr.data-group-kind]="group.kind">
                        @for (row of group.rows; track row.id) {
                          <div class="ac-state-list-item" [attr.data-tone]="row.tone || 'neutral'" [attr.data-output-kind]="row.outputKind || 'default'">
                            <div class="ac-state-list-head">
                              <span class="ac-state-list-title">{{ row.title | translate }}</span>
                              @if (row.trailing) {
                                <span class="ac-state-list-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing | translate }}</span>
                              }
                            </div>
                            @if (row.subtitle) {
                              <div class="ac-state-list-subtitle">{{ row.subtitle }}</div>
                            }
                            @if (row.outputKind === 'code') {
                              <div class="ac-state-output-code-note">
                                <pre class="ac-state-output-code-block"><code [attr.data-language]="row.outputLanguage || null" [textContent]="row.outputCode || ''"></code></pre>
                              </div>
                            }
                            @if (row.outputKind === 'image' && getOutputImageSource(row); as imageSource) {
                              <div class="ac-state-output-image-shell">
                                <img class="ac-state-output-image-preview" [src]="imageSource" [alt]="row.outputLabel || row.title" />
                              </div>
                            }
                            @if (row.outputLabel || row.outputMimeType) {
                              <div class="ac-state-list-meta">
                                @if (row.outputLabel) {
                                  <span class="ac-state-list-meta-chip">{{ row.outputLabel }}</span>
                                }
                                @if (row.outputMimeType) {
                                  <span class="ac-state-list-meta-chip">{{ row.outputMimeType }}</span>
                                }
                              </div>
                            }
                            @if (row.reference) {
                              <div class="ac-state-list-reference-shell">
                                <span class="ac-state-list-reference">{{ getResolvedReferenceLabel(row.reference) }}</span>
                                @if (canOpenReference(row.reference)) {
                                  <button type="button" class="ac-state-list-open" (click)="openReference(row.reference, $event)">打开</button>
                                }
                              </div>
                            }
                            @if (getOutputResourceHref(row); as resourceHref) {
                              <a class="ac-state-list-link" [href]="resourceHref" target="_blank" rel="noopener noreferrer" (click)="openExternalLink(resourceHref, $event)">{{ resourceHref }}</a>
                            }
                            @if (row.note) {
                              <div class="ac-state-list-note">{{ row.note }}</div>
                            }
                          </div>
                        }
                      </div>
                    }
                  </div>
                } @else {
                  <div class="ac-state-list">
                    @for (row of section.rows; track row.id) {
                      <div class="ac-state-list-item" [attr.data-tone]="row.tone || 'neutral'">
                        <div class="ac-state-list-head">
                          <span class="ac-state-list-title">{{ row.title }}</span>
                          @if (row.trailing) {
                            <span class="ac-state-list-pill" [attr.data-tone]="row.tone || 'neutral'">{{ row.trailing }}</span>
                          }
                        </div>
                        @if (row.subtitle) {
                          <div class="ac-state-list-subtitle">{{ row.subtitle }}</div>
                        }
                        @if (row.outputLabel || row.outputMimeType) {
                          <div class="ac-state-list-meta">
                            @if (row.outputLabel) {
                              <span class="ac-state-list-meta-chip">{{ row.outputLabel }}</span>
                            }
                            @if (row.outputMimeType) {
                              <span class="ac-state-list-meta-chip">{{ row.outputMimeType }}</span>
                            }
                          </div>
                        }
                        @if (row.reference) {
                          <div class="ac-state-list-reference-shell">
                            <span class="ac-state-list-reference">{{ getResolvedReferenceLabel(row.reference) }}</span>
                            @if (canOpenReference(row.reference)) {
                              <button type="button" class="ac-state-list-open" (click)="openReference(row.reference, $event)">打开</button>
                            }
                          </div>
                        }
                        @if (row.outputUri) {
                          <a class="ac-state-list-link" [href]="row.outputUri" target="_blank" rel="noopener noreferrer" (click)="openExternalLink(row.outputUri, $event)">{{ row.outputUri }}</a>
                        }
                        @if (row.note) {
                          <div class="ac-state-list-note">{{ row.note }}</div>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      /* ===== State Viewer — 对齐 Copilot progress-container / chatThinkingBox 风格 ===== */
      :host {
        display: block;
        width: 100%;
        min-width: 0;
      }

      /* === 对齐 think-viewer：无卡片背景，纯平透明 === */
      .ac-state {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 2px 0;
        border-radius: 0;
        font-size: 13px;
        margin: 0;
        background: transparent;
        border: none;
        color: var(--chat-fg, #cccccc);
        overflow: visible;
      }

      .ac-state.ac-state-embedded {
        padding: 0;
        border-radius: 0;
        background: transparent;
        border: none;
        gap: 3px;
      }

      .ac-state.ac-state-body-only {
        gap: 6px;
      }

      .ac-state.ac-state-embedded .ac-state-header {
        gap: 6px;
      }

      .ac-state.ac-state-embedded .ac-state-title-group {
        flex-direction: row;
        align-items: center;
        gap: 6px;
      }

      .ac-state.ac-state-embedded .ac-state-text {
        font-size: 12px;
        line-height: 1.35;
        color: var(--chat-fg-dim, #8e8e8e);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ac-state.ac-state-embedded .ac-state-pct {
        min-width: auto;
        font-size: 11px;
        color: var(--chat-fg-muted, #6a6a6a);
      }

      /* === think-viewer header 风格：可点击、hover 高亮 === */
      .ac-state-header {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        min-width: 0;
        padding: 3px 4px;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        border-radius: 5px;
        cursor: default;
      }
      .ac-state-header.ac-state-header-clickable {
        cursor: pointer;
        transition: background 0.15s;
      }
      .ac-state-header.ac-state-header-clickable:hover {
        background: var(--chat-bg-hover, rgba(255,255,255,0.06));
      }
      .ac-state-arrow {
        margin-left: auto;
        font-size: 10px;
        color: var(--chat-fg-muted, #6a6a6a);
        transition: transform 0.15s ease;
        flex-shrink: 0;
      }
      .ac-state.ac-state-expanded .ac-state-arrow {
        transform: rotate(180deg);
      }

      /* ===== 进度扫光背景（Copilot shimmer-progress 对齐）===== */
      .ac-state-progress-bg {
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg,
          rgba(117, 190, 255, 0.08) 0%,
          transparent 50%,
          rgba(117, 190, 255, 0.08) 100%);
        background-size: 200% 100%;
        animation: ac-state-sweep 2s ease-in-out infinite;
        pointer-events: none;
      }
      .ac-state-progress-fill {
        position: absolute;
        inset: 0;
        background: rgba(117, 190, 255, 0.10);
        transition: width 0.3s ease-out;
      }
      @keyframes ac-state-sweep {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      /* 状态颜色（图标与文字）*/
      .ac-state[data-state='doing'] i { color: var(--chat-info, #75beff); }
      .ac-state[data-state='done']  i { color: var(--chat-success, #89d185); }
      .ac-state[data-state='warn']  i { color: var(--chat-warn, #cca700); }
      .ac-state[data-state='error'] i { color: var(--chat-error, #f14c4c); }
      .ac-state[data-state='info']  i { color: var(--chat-info, #75beff); }
      .ac-state i { position: relative; flex-shrink: 0; font-size: 12px; width: 14px; text-align: center; }
      .ac-state-title-group {
        position: relative;
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .ac-state-text {
        position: relative;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--chat-fg, #cccccc);
        font-size: 12px;
        line-height: 1.3;
      }
      .ac-state-subtitle {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--chat-fg-dim, #8e8e8e);
        font-size: 11px;
        line-height: 1.25;
      }
      .ac-state-status {
        position: relative;
        flex-shrink: 0;
        font-size: 11px;
        color: var(--chat-fg-dim, #8e8e8e);
      }
      .ac-state-status[data-tone='info'] { color: var(--chat-info, #75beff); }
      .ac-state-status[data-tone='success'] { color: var(--chat-success, #89d185); }
      .ac-state-status[data-tone='warn'] { color: var(--chat-warn, #cca700); }
      .ac-state-status[data-tone='error'] { color: var(--chat-error, #f14c4c); }
      .ac-state-pct {
        position: relative;
        font-size: 11px;
        color: var(--chat-fg-dim, #8e8e8e);
        min-width: 32px;
        text-align: right;
      }

      .ac-state.ac-state-subagent {
        gap: 0;
        /* Copilot subagent/tool-use \u98ce\u683c\uff1a\u65e0\u9762\u677f\uff0c\u4e0e think-viewer \u7edf\u4e00 */
        background: transparent;
        border: none;
        padding: 2px 0;
      }

      .ac-subagent-header {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-width: 0;
        /* \u5bf9\u9f50 think-viewer .ac-think-header \u98ce\u683c */
        padding: 3px 6px;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
        transition: background 0.15s;
        margin: 0 -6px;
        width: calc(100% + 12px);
      }

      .ac-subagent-header:not(:disabled):hover {
        background: var(--chat-bg-hover, rgba(255,255,255,0.06));
      }

      .ac-subagent-header:disabled {
        cursor: default;
      }

      .ac-subagent-inline-meta {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-width: 0;
        color: var(--chat-fg-dim, #8e8e8e);
      }

      .ac-subagent-inline-agent {
        flex-shrink: 0;
        font-size: 12px;
        font-weight: 600;
        color: var(--chat-fg, #cccccc);
      }

      .ac-subagent-inline-subtitle {
        flex: 1;
        min-width: 0;
        font-size: 11px;
        line-height: 1.25;
        color: var(--chat-fg-dim, #8e8e8e);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ac-subagent-title-group {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }

      .ac-subagent-title {
        color: var(--chat-fg-head, #e3e3e3);
        font-size: 13px;
        font-weight: 500;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ac-subagent-subtitle {
        color: var(--chat-fg-dim, #8e8e8e);
        font-size: 11px;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .ac-subagent-state {
        flex-shrink: 0;
        font-size: 11px;
        line-height: 1;
        padding: 3px 7px;
        border-radius: 5px;
        background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
        border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
        color: var(--chat-fg-dim, #8e8e8e);
      }

      .ac-subagent-state[data-tone='info']    { color: var(--chat-info, #75beff); }
      .ac-subagent-state[data-tone='success'] { color: var(--chat-success, #89d185); }
      .ac-subagent-state[data-tone='warn']    { color: var(--chat-warn, #cca700); }
      .ac-subagent-state[data-tone='error']   { color: var(--chat-error, #f14c4c); }

      .ac-subagent-chevron {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--chat-fg-muted, #6a6a6a);
        transition: transform 0.2s ease;
      }

      .ac-state.ac-state-expanded .ac-subagent-chevron {
        transform: rotate(180deg);
      }

      /* === subagent 展开体：同 ac-state-detail，单一 border 框 === */
      .ac-subagent-body {
        display: flex;
        flex-direction: column;
        gap: 6px;
        width: 100%;
        padding: 6px 8px;
        margin-top: 2px;
        border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
        border-radius: 5px;
      }

      .ac-state.ac-state-embedded .ac-subagent-body {
        padding: 4px 6px;
        margin-top: 2px;
      }

      .ac-state.ac-state-embedded .ac-subagent-inline-meta {
        margin-bottom: 2px;
      }

      .ac-state.ac-state-embedded .ac-state-summary {
        align-items: flex-start;
        flex-direction: column;
        justify-content: flex-start;
        gap: 6px;
        margin-top: 4px;
      }

      .ac-state-summary-activity {
        gap: 5px;
      }

      .ac-state.ac-state-embedded .ac-state-badges {
        gap: 4px;
      }

      .ac-state.ac-state-embedded .ac-state-badge {
        padding: 2px 6px;
        background: rgba(255, 255, 255, 0.025);
        border-color: rgba(255, 255, 255, 0.04);
      }

      .ac-state-summary {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        min-width: 0;
      }

      /* === 展开体：对齐 Copilot .chat-used-context-list / .chat-confirmation-widget-message-container ===
       * 单个 border 框包裹所有展开内容，不再使用左侧连接线
       */
      .ac-state-detail {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 4px 8px;
        margin-top: 2px;
        border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
        border-radius: 5px;
      }

      .ac-state.ac-state-embedded .ac-state-detail {
        gap: 1px;
        padding: 4px 8px;
        margin-top: 2px;
      }

      .ac-state.ac-state-subagent .ac-state-detail {
        gap: 0;
        padding: 0;
        margin-top: 0;
        border: none;
        border-radius: 0;
        background: transparent;
      }

      .ac-state.ac-state-subagent .ac-state-section {
        padding: 4px 12px 4px 18px;
        gap: 3px;
      }

      .ac-state.ac-state-subagent .ac-state-section + .ac-state-section {
        margin-top: 0;
        border-top: none;
      }

      .ac-state.ac-state-subagent .ac-state-section-title {
        font-size: 11px;
        line-height: 1.2;
        font-weight: 500;
        letter-spacing: 0;
        margin-bottom: 1px;
      }

      .ac-state.ac-state-subagent .ac-state-list {
        gap: 0;
        margin-left: 2px;
        padding: 0 2px;
      }

      .ac-state.ac-state-subagent .ac-state-list-item {
        gap: 1px;
        padding: 3px 0;
      }

      .ac-state-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        flex: 1;
        min-width: 0;
      }
      .ac-state-badges-standalone {
        padding: 0 4px;
        margin-top: 2px;
      }

      .ac-state-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        border-radius: 5px;
        font-size: 11px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .ac-state-badge-label { color: var(--chat-fg-muted, #6a6a6a); }
      .ac-state-badge-value  { color: var(--chat-fg, #cccccc); }

      .ac-state-badge[data-tone='info'],
      .ac-state-list-pill[data-tone='info']    { color: var(--chat-info, #75beff); }
      .ac-state-badge[data-tone='success'],
      .ac-state-list-pill[data-tone='success'] { color: var(--chat-success, #89d185); }
      .ac-state-badge[data-tone='warn'],
      .ac-state-list-pill[data-tone='warn']    { color: var(--chat-warn, #cca700); }
      .ac-state-badge[data-tone='error'],
      .ac-state-list-pill[data-tone='error']   { color: var(--chat-error, #f14c4c); }

      .ac-state-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
        padding: 4px 8px;
        border: 0;
        border-radius: 5px;
        background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
        color: var(--chat-fg-dim, #8e8e8e);
        cursor: pointer;
        transition: background 0.2s ease, color 0.2s ease;
      }

      .ac-state-toggle:hover {
        background: var(--chat-bg-hover, rgba(255,255,255,0.06));
        color: var(--chat-fg-head, #e3e3e3);
      }

      .ac-state-toggle-label {
        font-size: 11px;
        line-height: 1;
      }

      .ac-state-toggle-icon {
        font-size: 10px;
        transition: transform 0.2s ease;
      }

      .ac-state-filters {
        position: relative;
        z-index: 1;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        width: 100%;
      }

      .ac-state-filter {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 8px;
        border-radius: 5px;
        border: 1px solid var(--chat-border, rgba(255,255,255,0.10));
        background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
        color: var(--chat-fg-dim, #8e8e8e);
        cursor: pointer;
        transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
      }

      .ac-state-filter:hover {
        background: var(--chat-bg-hover, rgba(255,255,255,0.06));
        color: var(--chat-fg-head, #e3e3e3);
      }

      .ac-state-filter.ac-state-filter-active {
        background: var(--chat-bg-deep, rgba(255,255,255,0.08));
        border-color: var(--chat-border, rgba(255,255,255,0.10));
        color: var(--chat-fg-head, #e3e3e3);
      }

      .ac-state-filter-label,
      .ac-state-filter-count {
        font-size: 11px;
        line-height: 1;
      }

      .ac-state-filter-count {
        padding: 1px 5px;
        border-radius: 5px;
        background: var(--chat-bg-deep, rgba(255,255,255,0.08));
      }

      .ac-state-filter[data-tone='success'] { color: var(--chat-success, #89d185); }
      .ac-state-filter[data-tone='warn']    { color: var(--chat-warn, #cca700); }
      .ac-state-filter[data-tone='error']   { color: var(--chat-error, #f14c4c); }
      .ac-state-filter[data-tone='info']    { color: var(--chat-info, #75beff); }

      .ac-state.ac-state-expanded .ac-state-toggle-icon {
        transform: rotate(180deg);
      }

      .ac-state-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .ac-state-section-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--chat-fg-muted, #6a6a6a);
        letter-spacing: 0.02em;
      }

      .ac-state.ac-state-embedded .ac-state-section-title {
        font-size: 10px;
        color: var(--chat-fg-muted, #6a6a6a);
      }

      .ac-state-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .ac-state-output-groups {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .ac-state-output-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .ac-state-output-group[data-group-kind='data'],
      .ac-state-output-group[data-group-kind='code'],
      .ac-state-output-group[data-group-kind='generic'] {
        padding: 10px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 5px;
        background: rgba(255,255,255,0.02);
      }

      .ac-state-output-group[data-group-kind='code'] {
        background: rgba(13, 17, 23, 0.38);
        border-color: rgba(255,255,255,0.1);
      }

      /* list-item：纯行，无卡片。Copilot 内部行没有独立 border/background。
       * 使用行间 separator 代替 gap */
      .ac-state-list-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 0;
        border-bottom: 1px solid var(--chat-border-dim, rgba(255,255,255,0.04));
      }

      .ac-state-list-item:last-child {
        border-bottom: none;
        padding-bottom: 0;
      }

      .ac-state-list-item:first-child {
        padding-top: 0;
      }

      /* tone 仅通过文字颜色体现，不再用 border-left 小卡片 */
      .ac-state-list-item[data-tone='info']    .ac-state-list-title { color: var(--chat-info, #75beff); }
      .ac-state-list-item[data-tone='success'] .ac-state-list-title { color: var(--chat-success, #89d185); }
      .ac-state-list-item[data-tone='warn']    .ac-state-list-title { color: var(--chat-warn, #cca700); }
      .ac-state-list-item[data-tone='error']   .ac-state-list-title { color: var(--chat-error, #f14c4c); }

      .ac-state-list-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .ac-state-list-title {
        color: var(--chat-fg-head, #e3e3e3);
        font-weight: 500;
      }


      .ac-state-list-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 4px;
      }

      .ac-state-list-meta-chip {
        padding: 2px 6px;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        font-size: 10px;
        line-height: 1.35;
        color: var(--chat-fg-dim, #8e8e8e);
      }

      .ac-state-list-reference-shell {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        margin-top: 4px;
      }

      .ac-state-list-reference {
        min-width: 0;
        font-size: 11px;
        line-height: 1.35;
        color: var(--chat-fg-dim, #8e8e8e);
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .ac-state-list-open {
        flex: 0 0 auto;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid var(--chat-border, rgba(255,255,255,0.10));
        background: transparent;
        color: var(--chat-fg, #cccccc);
        font-size: 10px;
        line-height: 1.2;
        cursor: pointer;
      }

      .ac-state-list-link {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        line-height: 1.35;
        color: #74b3ff;
        text-decoration: none;
        word-break: break-all;
      }

      .ac-state-output-image-shell {
        margin-top: 6px;
        overflow: hidden;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.015);
      }

      .ac-state-output-image-preview {
        display: block;
        max-width: 100%;
        height: auto;
      }

      .ac-state-output-code-note {
        margin-top: 6px;
      }

      .ac-state-output-code-block {
        margin: 0;
        padding: 10px 12px;
        overflow-x: auto;
        border-radius: 5px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(0,0,0,0.28);
      }

      .ac-state-output-code-block code {
        display: block;
        white-space: pre;
        font-family: Consolas, 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.5;
        color: var(--chat-fg, #cccccc);
      }

      .ac-state-list-link:hover {
        text-decoration: underline;
      }
      .ac-state.ac-state-embedded .ac-state-list-title {
        font-size: 12px;
        line-height: 1.35;
      }

      .ac-state-list-pill {
        flex-shrink: 0;
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 5px;
        background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
        border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
        color: var(--chat-fg-dim, #8e8e8e);
      }

      .ac-state-list-subtitle {
        font-size: 11px;
        color: var(--chat-fg-dim, #8e8e8e);
      }

      .ac-state.ac-state-embedded .ac-state-list-subtitle {
        color: var(--chat-fg-dim, #8e8e8e);
        line-height: 1.35;
      }

      .ac-state-list-note {
        font-size: 12px;
        color: var(--chat-fg, #cccccc);
        line-height: 1.45;
        white-space: normal;
        word-break: break-word;
      }

      .ac-state.ac-state-embedded .ac-state-list-note {
        color: var(--chat-fg, #cccccc);
        line-height: 1.4;
      }

      @keyframes ac-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .ac-spin {
        animation: ac-spin 0.8s linear infinite;
        display: inline-block;
      }
    `,
  ],
})
export class XAilyStateViewerComponent implements OnChanges {
  private static readonly expansionStateById = new Map<string, boolean>();

  @Input() data: StateViewerData | null = null;
  @Input() embedded = false;
  @Input() bodyOnly = false;
  @Input() sessionId = '';
  @Input() preparedDetailSections: readonly DetailSectionDescriptor[] | null = null;

  summaryBadges: StateBadge[] = [];
  instructionFilterChips: InstructionFilterChip[] = [];
  sections: StateDetailSection[] = [];
  hasDetails = false;
  hasExpandableDetails = false;
  expanded = false;
  selectedInstructionFilter: InstructionDiagnosticFilter = 'all';
  headerTitle = '';
  headerSubtitle = '';
  headerStatusLabel = '';
  headerStatusTone: StateTone = 'neutral';

  private expansionIdentity = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data'] || changes['preparedDetailSections']) {
      this.rebuildDetails();
    }
  }

  get stateIconClass(): string {
    const map: Record<string, string> = {
      doing: 'fa-light fa-spinner-third ac-spin',
      done: 'fa-light fa-circle-check',
      warn: 'fa-light fa-triangle-exclamation',
      error: 'fa-light fa-circle-xmark',
      info: 'fa-light fa-circle-info',
    };
    return map[this.data?.state || ''] || 'fa-light fa-circle-info';
  }

  private rebuildDetails(): void {
    const hadExpandableDetails = this.hasExpandableDetails;

    this.summaryBadges = [];
    this.instructionFilterChips = [];
    this.sections = [];
    this.headerTitle = this.data?.text || '';
    this.headerSubtitle = '';
    this.headerStatusLabel = '';
    this.headerStatusTone = 'neutral';

    const nextExpansionIdentity = this.getExpansionIdentity();
    const expansionStateKey = this.getExpansionStateKey();
    const rememberedExpanded = expansionStateKey
      ? XAilyStateViewerComponent.expansionStateById.get(expansionStateKey)
      : undefined;

    const metadata = this.asRecord(this.data?.metadata);
    if (!this.data?.kind || !metadata) {
      this.hasDetails = false;
      this.hasExpandableDetails = false;
      this.expanded = false;
      this.expansionIdentity = nextExpansionIdentity;
      return;
    }

    switch (this.data.kind) {
      case 'tool_call':
        this.buildToolCallDetails(metadata);
        break;
      case 'instructions':
        this.buildInstructionDetails(metadata);
        break;
      case 'task_graph':
        this.buildTaskGraphDetails(metadata);
        break;
      case 'background_task':
        this.buildBackgroundTaskDetails(metadata);
        break;
      case 'agent_team':
        this.buildAgentTeamDetails(metadata);
        break;
      case 'task_scheduler':
        this.buildTaskSchedulerDetails(metadata);
        break;
      case 'task_autonomy':
        this.buildTaskAutonomyDetails(metadata);
        break;
      case 'compaction':
        this.buildCompactionDetails(metadata);
        break;
      case 'provider_context_management':
        this.buildProviderContextManagementDetails(metadata);
        break;
      default:
        break;
    }

    this.hasDetails = this.showSummaryBadges() || this.sections.length > 0;
    this.hasExpandableDetails = this.sections.length > 0;

    if (!this.hasExpandableDetails) {
      this.expanded = false;
      this.expansionIdentity = nextExpansionIdentity;
      return;
    }

    if (this.embedded) {
      this.expanded = true;
      this.expansionIdentity = nextExpansionIdentity;
      return;
    }

    if (typeof rememberedExpanded === 'boolean') {
      this.expanded = rememberedExpanded;
    } else if (this.expansionIdentity !== nextExpansionIdentity || !hadExpandableDetails) {
      this.expanded = this.shouldDefaultExpand();
    }

    this.expansionIdentity = nextExpansionIdentity;
  }

  private buildToolCallDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'tool_call',
      id: this.data?.id,
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
    this.pushDetailSections(projection.sections);
  }

  toggleExpanded(): void {
    if (this.embedded) {
      return;
    }
    if (!this.hasExpandableDetails) {
      return;
    }
    this.expanded = !this.expanded;

    const expansionStateKey = this.getExpansionStateKey();
    if (expansionStateKey) {
      XAilyStateViewerComponent.expansionStateById.set(expansionStateKey, this.expanded);
    }
  }

  selectInstructionFilter(filterId: InstructionDiagnosticFilter): void {
    if (this.selectedInstructionFilter === filterId) {
      return;
    }

    this.selectedInstructionFilter = filterId;
    this.rebuildDetails();
  }

  private buildTaskGraphDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'task_graph',
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
    this.pushDetailSections(projection.sections);
  }

  private buildBackgroundTaskDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'background_task',
      id: this.data?.id,
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
    if (projection.sections.length === 0) {
      return;
    }
    this.pushDetailSections(projection.sections);
  }

  private buildAgentTeamDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'agent_team',
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
    this.pushDetailSections(projection.sections);
  }

  private buildTaskSchedulerDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'task_scheduler',
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
  }

  private buildTaskAutonomyDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'task_autonomy',
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
  }

  private buildCompactionDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'compaction',
      id: this.data?.id,
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
    this.pushDetailSections(projection.sections);
  }

  private buildProviderContextManagementDetails(metadata: Record<string, unknown>): void {
    const projection = buildStandardStateViewerProjection({
      kind: 'provider_context_management',
      id: this.data?.id,
      metadata,
      preparedDetailSections: this.preparedDetailSections,
    });
    this.pushSummaryBadges(projection.badges);
    this.pushDetailSections(projection.sections);
  }

  private buildInstructionDetails(metadata: Record<string, unknown>): void {
    const projection = buildInstructionDetailProjection({
      id: this.data?.id,
      metadata,
      selectedFilter: this.selectedInstructionFilter,
    });

    this.selectedInstructionFilter = projection.filter;
    this.instructionFilterChips = projection.filterChips;
    this.pushSummaryBadges(projection.badges);
    this.pushDetailSections(projection.sections);
  }

  private pushBadge(label: string, value: string | undefined, tone: StateTone = 'neutral'): void {
    if (!value) return;
    this.summaryBadges.push({ label, value, tone });
  }

  private pushSummaryBadges(badges: readonly { label: string; value: string; tone?: StateTone }[]): void {
    for (const badge of badges) {
      this.pushBadge(badge.label, badge.value, badge.tone ?? 'neutral');
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private asRecordArray(value: unknown): Record<string, unknown>[] {
    return this.asArray(value)
      .map(item => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => !!item);
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private asBoolean(value: unknown): boolean {
    return value === true;
  }

  private asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private getExpansionIdentity(): string {
    return `${this.data?.kind || ''}:${this.data?.id || ''}`;
  }

  private getExpansionStateKey(): string | undefined {
    return this.asString(this.data?.id);
  }

  private shouldDefaultExpand(): boolean {
    return this.data?.state === 'doing' || this.data?.state === 'warn' || this.data?.state === 'error';
  }

  showSummaryBadges(): boolean {
    return this.summaryBadges.length > 0;
  }

  private pushDetailSections(descriptors: readonly DetailSectionDescriptor[]): void {
    appendDetailSections(this.sections, [], descriptors, false);
  }

  getOutputGroups(section: StateDetailSection): readonly StateDetailOutputGroup[] {
    if (section.outputGroups && section.outputGroups.length > 0) {
      return section.outputGroups;
    }

    return [];
  }

  getOutputImageSource(row: { outputKind?: string; outputUri?: string; outputData?: string; outputMimeType?: string }): string | null {
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

  getOutputResourceHref(row: { outputKind?: string; outputUri?: string }): string | null {
    return row.outputKind === 'resource' && row.outputUri ? row.outputUri : null;
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
