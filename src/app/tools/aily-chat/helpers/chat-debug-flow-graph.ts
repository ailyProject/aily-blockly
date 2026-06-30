import type { HostSessionDebugEvent } from '../services/host-session-debug-events';

export interface HostSessionDebugFlowNode {
  readonly id: string;
  readonly eventId: string;
  readonly kind: HostSessionDebugEvent['kind'];
  readonly category?: string;
  readonly label: string;
  readonly sublabel?: string;
  readonly tooltip?: string;
  readonly isError?: boolean;
  readonly created: number;
  readonly children: readonly HostSessionDebugFlowNode[];
  readonly mergedNodes?: readonly HostSessionDebugFlowNode[];
}

export interface HostSessionDebugFlowFilterOptions {
  readonly isKindVisible: (kind: HostSessionDebugFlowNode['kind'], category?: string) => boolean;
  readonly textFilter: string;
}

export interface HostSessionDebugFlowSliceResult {
  readonly nodes: HostSessionDebugFlowNode[];
  readonly totalCount: number;
  readonly shownCount: number;
}

const SUBAGENT_TOOL_NAMES = ['runSubagent', 'search_subagent'];
const TOOL_EMOJI_PREFIX_RE = /^\u{1F6E0}\uFE0F?\s*/u;

export function buildHostSessionDebugFlowGraph(
  events: readonly HostSessionDebugEvent[],
): HostSessionDebugFlowNode[] {
  const filteredEvents = events.filter((event) => {
    return !(event.kind === 'subagentInvocation' && isSubagentToolName(event.agentName));
  });
  const idToEvent = new Map<string, HostSessionDebugEvent>();
  const idToChildren = new Map<string, HostSessionDebugEvent[]>();
  const roots: HostSessionDebugEvent[] = [];

  for (const event of filteredEvents) {
    idToEvent.set(event.id, event);
  }

  for (const event of filteredEvents) {
    if (event.parentEventId && idToEvent.has(event.parentEventId)) {
      const children = idToChildren.get(event.parentEventId) ?? [];
      children.push(event);
      idToChildren.set(event.parentEventId, children);
      continue;
    }

    roots.push(event);
  }

  const nodes = roots.map((event) => toFlowNode(event, filteredEvents, idToChildren));
  return collapseSubagentToolCalls(nodes);
}

export function filterHostSessionDebugFlowNodes(
  nodes: HostSessionDebugFlowNode[],
  options: HostSessionDebugFlowFilterOptions,
): HostSessionDebugFlowNode[] {
  let result = filterByKind(nodes, options.isKindVisible);
  if (options.textFilter.trim()) {
    result = filterByText(result, options.textFilter.trim().toLowerCase());
  }
  return result;
}

export function sliceHostSessionDebugFlowNodes(
  nodes: readonly HostSessionDebugFlowNode[],
  maxCount: number,
): HostSessionDebugFlowSliceResult {
  const totalCount = countFlowNodes(nodes);
  if (totalCount <= maxCount) {
    return { nodes: [...nodes], totalCount, shownCount: totalCount };
  }

  let remaining = maxCount;

  function sliceTree(nodeList: readonly HostSessionDebugFlowNode[]): HostSessionDebugFlowNode[] {
    const result: HostSessionDebugFlowNode[] = [];
    for (const node of nodeList) {
      if (remaining <= 0) {
        break;
      }

      remaining -= 1;
      if (!node.children.length || remaining <= 0) {
        result.push(node.children.length ? { ...node, children: [] } : node);
        continue;
      }

      const slicedChildren = sliceTree(node.children);
      result.push(slicedChildren !== node.children ? { ...node, children: slicedChildren } : node);
    }
    return result;
  }

  const sliced = sliceTree(nodes);
  return {
    nodes: sliced,
    totalCount,
    shownCount: maxCount - remaining,
  };
}

export function countFlowNodes(nodes: readonly HostSessionDebugFlowNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countFlowNodes(node.children), 0);
}

export function mergeDiscoveryNodes(
  nodes: readonly HostSessionDebugFlowNode[],
): HostSessionDebugFlowNode[] {
  const result: HostSessionDebugFlowNode[] = [];

  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (!(node.kind === 'generic' && node.category === 'discovery')) {
      const mergedChildren = mergeDiscoveryNodes(node.children);
      result.push(mergedChildren !== node.children ? { ...node, children: mergedChildren } : node);
      index += 1;
      continue;
    }

    const run: HostSessionDebugFlowNode[] = [node];
    let nextIndex = index + 1;
    while (nextIndex < nodes.length && nodes[nextIndex].kind === 'generic' && nodes[nextIndex].category === 'discovery') {
      run.push(nodes[nextIndex]);
      nextIndex += 1;
    }

    if (run.length < 2) {
      result.push(node);
      index = nextIndex;
      continue;
    }

    const uniqueLabels = [...new Set(run.map(item => item.label))];
    result.push({
      id: `merged-discovery:${run[0].id}`,
      eventId: `merged-discovery:${run[0].id}`,
      kind: 'generic',
      category: 'discovery',
      label: uniqueLabels.length <= 2 ? uniqueLabels.join(', ') : `${uniqueLabels[0]} +${run.length - 1} more`,
      sublabel: `${run.length} discovery steps`,
      tooltip: run.map(item => item.label + (item.sublabel ? `: ${item.sublabel}` : '')).join('\n'),
      created: run[0].created,
      children: [],
      mergedNodes: run,
    });
    index = nextIndex;
  }

  return result;
}

export function mergeToolCallNodes(
  nodes: readonly HostSessionDebugFlowNode[],
): HostSessionDebugFlowNode[] {
  const result: HostSessionDebugFlowNode[] = [];

  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node.kind !== 'toolCall') {
      const mergedChildren = mergeToolCallNodes(node.children);
      result.push(mergedChildren !== node.children ? { ...node, children: mergedChildren } : node);
      index += 1;
      continue;
    }

    const run: HostSessionDebugFlowNode[] = [node];
    let nextIndex = index + 1;
    while (nextIndex < nodes.length && nodes[nextIndex].kind === 'toolCall' && nodes[nextIndex].label === node.label) {
      run.push(nodes[nextIndex]);
      nextIndex += 1;
    }

    if (run.length < 2) {
      const mergedChildren = mergeToolCallNodes(node.children);
      result.push(mergedChildren !== node.children ? { ...node, children: mergedChildren } : node);
      index = nextIndex;
      continue;
    }

    result.push({
      id: `merged-toolCall:${run[0].id}`,
      eventId: `merged-toolCall:${run[0].id}`,
      kind: 'toolCall',
      label: node.label,
      sublabel: `${run.length} calls`,
      tooltip: run.map(item => item.label + (item.sublabel ? `: ${item.sublabel}` : '')).join('\n'),
      created: run[0].created,
      children: [],
      mergedNodes: run,
    });
    index = nextIndex;
  }

  return result;
}

function filterByKind(
  nodes: HostSessionDebugFlowNode[],
  isKindVisible: (kind: HostSessionDebugFlowNode['kind'], category?: string) => boolean,
): HostSessionDebugFlowNode[] {
  const result: HostSessionDebugFlowNode[] = [];
  let changed = false;

  for (const node of nodes) {
    if (!isKindVisible(node.kind, node.category)) {
      changed = true;
      if (node.kind === 'subagentInvocation') {
        continue;
      }
      result.push(...filterByKind([...node.children], isKindVisible));
      continue;
    }

    const filteredChildren = filterByKind([...node.children], isKindVisible);
    if (filteredChildren !== node.children) {
      changed = true;
      result.push({ ...node, children: filteredChildren });
      continue;
    }

    result.push(node);
  }

  return changed ? result : nodes;
}

function filterByText(nodes: HostSessionDebugFlowNode[], text: string): HostSessionDebugFlowNode[] {
  const result: HostSessionDebugFlowNode[] = [];

  for (const node of nodes) {
    if (nodeMatchesText(node, text)) {
      result.push(node);
      continue;
    }

    const filteredChildren = filterByText([...node.children], text);
    if (filteredChildren.length > 0) {
      result.push({ ...node, children: filteredChildren });
    }
  }

  return result;
}

function nodeMatchesText(node: HostSessionDebugFlowNode, text: string): boolean {
  return node.label.toLowerCase().includes(text)
    || (node.sublabel?.toLowerCase().includes(text) ?? false)
    || (node.tooltip?.toLowerCase().includes(text) ?? false);
}

function toFlowNode(
  event: HostSessionDebugEvent,
  allEvents: readonly HostSessionDebugEvent[],
  idToChildren: ReadonlyMap<string, HostSessionDebugEvent[]>,
): HostSessionDebugFlowNode {
  const children = idToChildren.get(event.id)?.map((child) => toFlowNode(child, allEvents, idToChildren)) ?? [];
  const effectiveKind = getEffectiveKind(event);

  return {
    id: event.id,
    eventId: event.id,
    kind: effectiveKind,
    category: event.kind === 'generic' ? event.category : undefined,
    label: getEventLabel(event, effectiveKind),
    sublabel: getEventSublabel(event, effectiveKind),
    tooltip: getEventTooltip(event),
    isError: isErrorEvent(event),
    created: event.created,
    children,
  };
}

function getEffectiveKind(event: HostSessionDebugEvent): HostSessionDebugEvent['kind'] {
  if (event.kind !== 'generic') {
    return event.kind;
  }

  const normalizedName = event.name.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalizedName === 'usermessage' || normalizedName === 'userprompt' || normalizedName === 'user') {
    return 'userMessage';
  }
  if (normalizedName === 'response' || normalizedName.startsWith('agentresponse') || normalizedName.startsWith('assistantresponse')) {
    return 'agentResponse';
  }
  if (event.category === 'user' || event.category === 'userMessage') {
    return 'userMessage';
  }
  if (event.category === 'response' || event.category === 'agentResponse') {
    return 'agentResponse';
  }

  return event.kind;
}

function getEventLabel(
  event: HostSessionDebugEvent,
  effectiveKind: HostSessionDebugEvent['kind'],
): string {
  switch (effectiveKind) {
    case 'userMessage':
      return 'User Message';
    case 'modelTurn':
      return event.kind === 'modelTurn' ? (event.model ?? 'Model Turn') : 'Model Turn';
    case 'toolCall':
      return event.kind === 'toolCall' ? event.toolName : (event.kind === 'generic' ? event.name : 'Tool Call');
    case 'subagentInvocation':
      return event.kind === 'subagentInvocation' ? `Subagent: ${event.agentName}` : 'Subagent';
    case 'agentResponse':
      return 'Agent Response';
    case 'generic':
      return event.kind === 'generic' ? event.name : 'Event';
  }
}

function getEventSublabel(
  event: HostSessionDebugEvent,
  effectiveKind: HostSessionDebugEvent['kind'],
): string | undefined {
  switch (effectiveKind) {
    case 'modelTurn': {
      if (event.kind !== 'modelTurn') {
        return undefined;
      }

      return [
        event.requestName,
        typeof event.totalTokens === 'number' ? `${event.totalTokens} tokens` : undefined,
        typeof event.durationInMillis === 'number' ? formatDuration(event.durationInMillis) : undefined,
      ].filter((value): value is string => Boolean(value)).join(' · ') || undefined;
    }
    case 'toolCall': {
      if (event.kind !== 'toolCall') {
        return undefined;
      }

      return [
        event.result,
        typeof event.durationInMillis === 'number' ? formatDuration(event.durationInMillis) : undefined,
      ].filter((value): value is string => Boolean(value)).join(' · ') || undefined;
    }
    case 'subagentInvocation': {
      if (event.kind !== 'subagentInvocation') {
        return undefined;
      }

      return [
        event.status,
        typeof event.durationInMillis === 'number' ? formatDuration(event.durationInMillis) : undefined,
      ].filter((value): value is string => Boolean(value)).join(' · ') || undefined;
    }
    case 'userMessage':
    case 'agentResponse': {
      const text = event.kind === 'generic'
        ? event.details
        : ('message' in event ? event.message : undefined);
      return summarizeLine(text);
    }
    default:
      return undefined;
  }
}

function getEventTooltip(event: HostSessionDebugEvent): string | undefined {
  switch (event.kind) {
    case 'userMessage':
    case 'agentResponse':
      return truncateTooltip(event.message);
    case 'toolCall':
      return [
        event.toolName,
        event.input ? `Input: ${truncateTooltip(event.input)}` : undefined,
        event.output ? `Output: ${truncateTooltip(event.output)}` : undefined,
        event.result ? `Result: ${event.result}` : undefined,
      ].filter((value): value is string => Boolean(value)).join('\n') || undefined;
    case 'subagentInvocation':
      return [
        event.agentName,
        event.description,
        event.status ? `Status: ${event.status}` : undefined,
      ].filter((value): value is string => Boolean(value)).join('\n') || undefined;
    case 'modelTurn':
      return [
        event.requestName,
        event.model,
        typeof event.totalTokens === 'number' ? `Tokens: ${event.totalTokens}` : undefined,
      ].filter((value): value is string => Boolean(value)).join('\n') || undefined;
    case 'generic':
      return truncateTooltip(event.details);
  }
}

function isErrorEvent(event: HostSessionDebugEvent): boolean {
  return (event.kind === 'toolCall' && event.result === 'error')
    || (event.kind === 'modelTurn' && event.status === 'error')
    || (event.kind === 'generic' && event.level === 'error')
    || (event.kind === 'subagentInvocation' && event.status === 'failed');
}

function collapseSubagentToolCalls(
  nodes: readonly HostSessionDebugFlowNode[],
): HostSessionDebugFlowNode[] {
  let changed = false;
  const result: HostSessionDebugFlowNode[] = [];

  for (const node of nodes) {
    if (node.kind === 'toolCall' && isSubagentToolName(stripToolEmoji(node.label))) {
      changed = true;
      const flattenedChildren = flattenChildSessionRefs(node.children);
      const subagentChildren = flattenedChildren.filter(child => child.kind === 'subagentInvocation');
      if (subagentChildren.length > 0) {
        const otherChildren = flattenedChildren.filter(child => child.kind !== 'subagentInvocation');
        for (let index = 0; index < subagentChildren.length; index += 1) {
          const extraChildren = index === 0 ? otherChildren : [];
          result.push({
            ...subagentChildren[index],
            children: collapseSubagentToolCalls([...subagentChildren[index].children, ...extraChildren]),
          });
        }
      } else {
        result.push(...collapseSubagentToolCalls(flattenedChildren));
      }
      continue;
    }

    const nextChildren = collapseSubagentToolCalls(node.children);
    if (nextChildren !== node.children) {
      changed = true;
      result.push({
        ...node,
        children: nextChildren,
      });
      continue;
    }

    result.push(node);
  }

  return changed ? result : [...nodes];
}

function flattenChildSessionRefs(
  nodes: readonly HostSessionDebugFlowNode[],
): HostSessionDebugFlowNode[] {
  if (!nodes.some(node => node.kind === 'generic' && node.category === 'subagent')) {
    return [...nodes];
  }

  const result: HostSessionDebugFlowNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'generic' && node.category === 'subagent') {
      const subagentChild = node.children.find(child => child.kind === 'subagentInvocation');
      if (subagentChild) {
        const siblings = node.children.filter(child => child.id !== subagentChild.id);
        result.push({
          ...subagentChild,
          children: [...subagentChild.children, ...siblings],
        });
      } else {
        result.push(...node.children);
      }
      continue;
    }

    result.push(node);
  }

  return result;
}

function summarizeLine(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  const meaningfulLine = text.split('\n').map(line => line.trim()).find(line => line.length > 2);
  const firstLine = meaningfulLine ?? text.replace(/\s+/g, ' ').trim();
  if (!firstLine) {
    return undefined;
  }

  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function truncateTooltip(value: string | undefined, maxLength = 500): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }

  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function formatDuration(durationInMillis: number): string {
  return durationInMillis < 1000
    ? `${durationInMillis}ms`
    : `${(durationInMillis / 1000).toFixed(1)}s`;
}

function isSubagentToolName(name: string): boolean {
  for (const toolName of SUBAGENT_TOOL_NAMES) {
    if (name === toolName) {
      return true;
    }

    if (name.startsWith(toolName)) {
      const nextChar = name[toolName.length];
      if (nextChar === '-' || nextChar === ' ' || nextChar === '(' || nextChar === ':') {
        return true;
      }
    }
  }

  return false;
}

function stripToolEmoji(name: string): string {
  return name.replace(TOOL_EMOJI_PREFIX_RE, '');
}