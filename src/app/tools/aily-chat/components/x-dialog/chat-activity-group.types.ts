import type { ToolApprovalAction, ToolApprovalScope } from '../../helpers/tool-approval-ui';
import type { DetailSectionDescriptor } from './x-aily-state-viewer/activity-detail-items';

export interface ActivityApprovalDisplayData {
  kind?: 'approval' | 'confirmation';
  partId?: string;
  askId?: string;
  toolCallId?: string;
  toolName?: string;
  title: string;
  subtitle?: string;
  message: string;
  description?: string;
  args?: any;
  resolved?: boolean;
  approved?: boolean;
  scope?: ToolApprovalScope;
  actions: readonly ToolApprovalAction[];
  primaryScope: ToolApprovalScope;
}

export interface ActivityApprovalSummaryDisplayData {
  tone: 'success' | 'warn';
  statusLabel: string;
  scopeLabel?: string;
  note: string;
}

export interface ActivityToolHeaderDisplayData {
  title: string;
  subtitle?: string;
  meta?: string;
  pill?: string;
  pillTone: string;
}

export interface ActivityToolbarActionDisplayData {
  id: string;
  iconClass: string;
  label: string;
  tooltip?: string;
  disabled?: boolean;
  data?: Record<string, unknown>;
}

export interface ActivityGroupHeaderDisplayData {
  kind: 'default' | 'tool' | 'thinking' | 'subagent' | 'state' | 'collaboration';
  title: string;
  titleDetail?: string;
  detail?: string;
}

export interface ActivityInvocationDisplayData {
  progressSection?: DetailSectionDescriptor;
  argsSection?: DetailSectionDescriptor;
  outputSections: readonly DetailSectionDescriptor[];
  historySections: readonly DetailSectionDescriptor[];
  hasWidgetSections: boolean;
  widgetTitle: string;
  outputTitle: string;
  postConfirmation: boolean;
}

export interface ActivityLazyDetailData {
  detailSections?: readonly DetailSectionDescriptor[];
  invocationDetail?: ActivityInvocationDisplayData;
  detailKind?: 'invocation' | 'state' | 'subagent';
}

export interface ActivityGroupDisplayChild {
  id: string;
  kind: 'detail' | 'thinking' | 'tool' | 'text';
  title?: string;
  subtitle?: string;
  content?: string;
  trailing?: string;
  tone?: string;
}

export interface ActivityGroupDisplayItem {
  id: string;
  /** Stable source-part revision used to preserve mounted list-item renderers. */
  revision?: string;
  kind: 'thinking' | 'activity';
  headerKind?: 'default' | 'tool';
  toolHeader?: ActivityToolHeaderDisplayData;
  iconClass: string;
  isSpinning: boolean;
  iconColor: string;
  kicker?: string;
  label: string;
  subtitle?: string;
  note?: string;
  noteRenderMode?: 'markdown' | 'plain';
  thinking?: {
    content?: string;
    ref?: string;
    isComplete?: boolean;
    contentLength?: number;
  };
  headerMeta?: string;
  pill: string;
  pillTone: string;
  approval?: ActivityApprovalDisplayData;
  approvalSummary?: ActivityApprovalSummaryDisplayData;
  invocationDetail?: ActivityInvocationDisplayData;
  loadDetail?: () => ActivityLazyDetailData;
  toolbarActions?: readonly ActivityToolbarActionDisplayData[];
  children?: readonly ActivityGroupDisplayChild[];
  nestedItems?: readonly ActivityGroupDisplayItem[];
  subagentItems?: readonly ActivityGroupDisplayItem[];
  detailSections?: readonly DetailSectionDescriptor[];
  detailExpanded?: boolean;
  detailKind?: 'invocation' | 'state' | 'subagent';
  instructionMetadata?: Record<string, unknown> | null;
}
