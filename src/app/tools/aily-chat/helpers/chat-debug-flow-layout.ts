import type { HostSessionDebugFlowNode } from './chat-debug-flow-graph';

export interface HostSessionDebugLayoutNode {
  readonly id: string;
  readonly kind: HostSessionDebugFlowNode['kind'];
  readonly label: string;
  readonly sublabel?: string;
  readonly tooltip?: string;
  readonly isError?: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly mergedCount?: number;
  readonly isMergedExpanded?: boolean;
}

export interface HostSessionDebugLayoutEdge {
  readonly fromId?: string;
  readonly toId?: string;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
}

export interface HostSessionDebugSubgraphRect {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly nodeId: string;
  readonly collapsedChildCount?: number;
}

export interface HostSessionDebugFlowLayout {
  readonly nodes: HostSessionDebugLayoutNode[];
  readonly edges: HostSessionDebugLayoutEdge[];
  readonly subgraphs: HostSessionDebugSubgraphRect[];
  readonly width: number;
  readonly height: number;
}

export interface HostSessionDebugFlowChartRenderResult {
  readonly svg: SVGElement;
  readonly focusableElements: Map<string, SVGElement>;
  readonly adjacency: Map<string, { next: string[]; prev: string[] }>;
  readonly positions: Map<string, { x: number; y: number }>;
}

interface HostSessionDebugSubtreeLayout {
  nodes: HostSessionDebugLayoutNode[];
  edges: HostSessionDebugLayoutEdge[];
  subgraphs: HostSessionDebugSubgraphRect[];
  width: number;
  height: number;
  entryNode: HostSessionDebugLayoutNode;
  exitNodes: HostSessionDebugLayoutNode[];
}

interface HostSessionDebugChildGroup {
  readonly type: 'sequential' | 'parallel';
  readonly children: HostSessionDebugFlowNode[];
}

interface PendingExpansion {
  readonly mergedNode: HostSessionDebugLayoutNode;
  readonly children: readonly HostSessionDebugFlowNode[];
}

const NODE_HEIGHT = 36;
const MESSAGE_NODE_HEIGHT = 52;
const NODE_MIN_WIDTH = 140;
const NODE_MAX_WIDTH = 320;
const NODE_PADDING_H = 16;
const NODE_PADDING_V = 6;
const NODE_GAP_Y = 24;
const NODE_BORDER_RADIUS = 6;
const EDGE_STROKE_WIDTH = 1.5;
const FONT_SIZE = 12;
const SUBLABEL_FONT_SIZE = 10;
const SUBGRAPH_PADDING = 12;
const CANVAS_PADDING = 24;
const PARALLEL_GAP_X = 40;
const SUBGRAPH_HEADER_HEIGHT = 22;
const GUTTER_WIDTH = 3;
const MERGED_TOGGLE_WIDTH = 36;
const PARALLEL_TIME_THRESHOLD_MS = 5_000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SUBGRAPH_COLORS = [
  'var(--aily-chart-purple, #b267e6)',
  'var(--aily-chart-blue, #3dc9b0)',
  'var(--aily-chart-yellow, #e5c07b)',
  'var(--aily-chart-orange, #d19a66)',
];

export function layoutHostSessionDebugFlowGraph(
  roots: HostSessionDebugFlowNode[],
  options?: { collapsedIds?: ReadonlySet<string>; expandedMergedIds?: ReadonlySet<string> },
): HostSessionDebugFlowLayout {
  if (roots.length === 0) {
    return { nodes: [], edges: [], subgraphs: [], width: 0, height: 0 };
  }

  const groups = groupChildren(roots);
  const pendingExpansions: PendingExpansion[] = [];
  const result: HostSessionDebugFlowLayout = {
    nodes: [],
    edges: [],
    subgraphs: [],
    width: 0,
    height: 0,
  };

  const { maxWidth, endY } = layoutGroups(
    groups,
    CANVAS_PADDING,
    CANVAS_PADDING,
    0,
    [],
    result,
    options?.collapsedIds,
    options?.expandedMergedIds,
    pendingExpansions,
  );

  resolvePendingExpansions(pendingExpansions, result);

  let width = maxWidth + CANVAS_PADDING * 2;
  let height = endY - NODE_GAP_Y + CANVAS_PADDING;

  for (const node of result.nodes) {
    width = Math.max(width, node.x + node.width + CANVAS_PADDING);
    height = Math.max(height, node.y + node.height + CANVAS_PADDING);
  }
  for (const subgraph of result.subgraphs) {
    width = Math.max(width, subgraph.x + subgraph.width + CANVAS_PADDING);
    height = Math.max(height, subgraph.y + subgraph.height + CANVAS_PADDING);
  }

  centerLayout(result, width / 2);
  return { ...result, width, height };
}

export function renderHostSessionDebugFlowChartSvg(
  layout: HostSessionDebugFlowLayout,
): HostSessionDebugFlowChartRenderResult {
  const focusableElements = new Map<string, SVGElement>();
  const svg = svgEl('svg', {
    width: layout.width,
    height: layout.height,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: 'img',
    'aria-label': `Imported debug flow chart with ${layout.nodes.length} nodes`,
  });
  svg.classList.add('chat-debug-flowchart-svg');

  renderSubgraphs(svg, layout.subgraphs, focusableElements);
  renderEdges(svg, layout.edges);
  renderNodes(svg, layout.nodes, focusableElements);

  const positions = new Map<string, { x: number; y: number }>();
  for (const subgraph of layout.subgraphs) {
    positions.set(`sg:${subgraph.nodeId}`, { x: subgraph.x, y: subgraph.y });
  }
  for (const node of layout.nodes) {
    positions.set(node.id, { x: node.x, y: node.y });
  }

  const sortedFocusableElements = new Map(
    [...focusableElements.entries()].sort((left, right) => {
      const leftPosition = positions.get(left[0]);
      const rightPosition = positions.get(right[0]);
      if (!leftPosition || !rightPosition) {
        return 0;
      }

      return leftPosition.y !== rightPosition.y
        ? leftPosition.y - rightPosition.y
        : leftPosition.x - rightPosition.x;
    }),
  );

  const adjacency = new Map<string, { next: string[]; prev: string[] }>();
  for (const edge of layout.edges) {
    if (!edge.fromId || !edge.toId) {
      continue;
    }

    const fromEntry = adjacency.get(edge.fromId) ?? { next: [], prev: [] };
    fromEntry.next.push(edge.toId);
    adjacency.set(edge.fromId, fromEntry);

    const toEntry = adjacency.get(edge.toId) ?? { next: [], prev: [] };
    toEntry.prev.push(edge.fromId);
    adjacency.set(edge.toId, toEntry);
  }

  return {
    svg,
    focusableElements: sortedFocusableElements,
    adjacency,
    positions,
  };
}

function groupChildren(children: readonly HostSessionDebugFlowNode[]): HostSessionDebugChildGroup[] {
  const subagentIndices: number[] = [];
  for (let index = 0; index < children.length; index += 1) {
    if (children[index].kind === 'subagentInvocation') {
      subagentIndices.push(index);
    }
  }

  if (subagentIndices.length < 2) {
    return [{ type: 'sequential', children: [...children] }];
  }

  const parallelClusters: number[][] = [];
  let cluster: number[] = [subagentIndices[0]];
  for (let index = 1; index < subagentIndices.length; index += 1) {
    const previousCreated = children[subagentIndices[index - 1]].created;
    const currentCreated = children[subagentIndices[index]].created;
    if (Math.abs(currentCreated - previousCreated) <= PARALLEL_TIME_THRESHOLD_MS) {
      cluster.push(subagentIndices[index]);
    } else {
      if (cluster.length >= 2) {
        parallelClusters.push(cluster);
      }
      cluster = [subagentIndices[index]];
    }
  }

  if (cluster.length >= 2) {
    parallelClusters.push(cluster);
  }

  if (parallelClusters.length === 0) {
    return [{ type: 'sequential', children: [...children] }];
  }

  const parallelIndices = new Set<number>();
  for (const currentCluster of parallelClusters) {
    for (const index of currentCluster) {
      parallelIndices.add(index);
    }
  }

  const groups: HostSessionDebugChildGroup[] = [];
  let clusterIndex = 0;
  let index = 0;
  while (index < children.length) {
    if (clusterIndex < parallelClusters.length && index === parallelClusters[clusterIndex][0]) {
      const currentCluster = parallelClusters[clusterIndex];
      const lastIndex = currentCluster[currentCluster.length - 1];
      const setup: HostSessionDebugFlowNode[] = [];
      const subagents: HostSessionDebugFlowNode[] = [];
      for (let childIndex = currentCluster[0]; childIndex <= lastIndex; childIndex += 1) {
        if (parallelIndices.has(childIndex)) {
          subagents.push(children[childIndex]);
        } else {
          setup.push(children[childIndex]);
        }
      }

      if (setup.length > 0) {
        groups.push({ type: 'sequential', children: setup });
      }
      groups.push({ type: 'parallel', children: subagents });
      index = lastIndex + 1;
      clusterIndex += 1;
      continue;
    }

    const startIndex = index;
    const nextClusterStart = clusterIndex < parallelClusters.length ? parallelClusters[clusterIndex][0] : children.length;
    while (index < nextClusterStart && !parallelIndices.has(index)) {
      index += 1;
    }
    if (index > startIndex) {
      groups.push({ type: 'sequential', children: [...children.slice(startIndex, index)] });
    }
  }

  return groups;
}

function layoutGroups(
  groups: readonly HostSessionDebugChildGroup[],
  startX: number,
  startY: number,
  depth: number,
  previousExitNodes: readonly HostSessionDebugLayoutNode[],
  result: Pick<HostSessionDebugFlowLayout, 'nodes' | 'edges' | 'subgraphs'>,
  collapsedIds?: ReadonlySet<string>,
  expandedMergedIds?: ReadonlySet<string>,
  pendingExpansions?: PendingExpansion[],
): { exitNodes: HostSessionDebugLayoutNode[]; maxWidth: number; endY: number } {
  let currentY = startY;
  let maxWidth = 0;
  let exitNodes = [...previousExitNodes];

  for (const group of groups) {
    if (group.type === 'parallel') {
      const parallelGroup = layoutParallelGroup(
        group.children,
        startX,
        currentY,
        depth,
        collapsedIds,
        expandedMergedIds,
        pendingExpansions,
      );
      result.nodes.push(...parallelGroup.nodes);
      result.edges.push(...parallelGroup.edges);
      result.subgraphs.push(...parallelGroup.subgraphs);

      for (const previousNode of exitNodes) {
        for (const entryNode of parallelGroup.entryNodes) {
          result.edges.push(makeEdge(previousNode, entryNode));
        }
      }

      exitNodes = parallelGroup.exitNodes;
      maxWidth = Math.max(maxWidth, parallelGroup.width);
      currentY += parallelGroup.height + NODE_GAP_Y;
      continue;
    }

    for (const child of group.children) {
      const subtree = layoutSubtree(child, startX, currentY, depth, collapsedIds, expandedMergedIds, pendingExpansions);
      result.nodes.push(...subtree.nodes);
      result.edges.push(...subtree.edges);
      result.subgraphs.push(...subtree.subgraphs);

      for (const previousNode of exitNodes) {
        result.edges.push(makeEdge(previousNode, subtree.entryNode));
      }

      exitNodes = subtree.exitNodes;
      maxWidth = Math.max(maxWidth, subtree.width);
      currentY += subtree.height + NODE_GAP_Y;
    }
  }

  return { exitNodes, maxWidth, endY: currentY };
}

function makeEdge(from: HostSessionDebugLayoutNode, to: HostSessionDebugLayoutNode): HostSessionDebugLayoutEdge {
  return {
    fromId: from.id,
    toId: to.id,
    fromX: from.x + from.width / 2,
    fromY: from.y + from.height,
    toX: to.x + to.width / 2,
    toY: to.y,
  };
}

function layoutSubtree(
  node: HostSessionDebugFlowNode,
  startX: number,
  y: number,
  depth: number,
  collapsedIds?: ReadonlySet<string>,
  expandedMergedIds?: ReadonlySet<string>,
  pendingExpansions?: PendingExpansion[],
): HostSessionDebugSubtreeLayout {
  const isMerged = (node.mergedNodes?.length ?? 0) >= 2;
  const isMergedExpanded = isMerged && expandedMergedIds?.has(node.id);
  const mergedExtraWidth = isMerged ? MERGED_TOGGLE_WIDTH : 0;
  const nodeWidth = measureNodeWidth(node.label, node.sublabel) + mergedExtraWidth;
  const isSubagent = node.kind === 'subagentInvocation';
  const isCollapsed = isSubagent && collapsedIds?.has(node.id);
  const nodeHeight = isMessageKind(node.kind) && node.sublabel ? MESSAGE_NODE_HEIGHT : NODE_HEIGHT;

  const layoutNode: HostSessionDebugLayoutNode = {
    id: node.id,
    kind: node.kind,
    label: node.label,
    sublabel: node.sublabel,
    tooltip: node.tooltip,
    isError: node.isError,
    x: startX,
    y,
    width: nodeWidth,
    height: nodeHeight,
    mergedCount: isMerged ? node.mergedNodes?.length : undefined,
    isMergedExpanded,
  };

  const result: HostSessionDebugSubtreeLayout = {
    nodes: [layoutNode],
    edges: [],
    subgraphs: [],
    width: nodeWidth,
    height: nodeHeight,
    entryNode: layoutNode,
    exitNodes: [layoutNode],
  };

  if (isMergedExpanded && node.mergedNodes && pendingExpansions) {
    pendingExpansions.push({ mergedNode: layoutNode, children: node.mergedNodes });
    return result;
  }

  if (node.children.length === 0 && !isCollapsed) {
    return result;
  }

  if (isCollapsed) {
    const collapsedHeight = SUBGRAPH_HEADER_HEIGHT + SUBGRAPH_PADDING * 2;
    const totalChildCount = countDescendants(node);
    const subgraphY = (y + nodeHeight + NODE_GAP_Y) - NODE_GAP_Y / 2;
    const subgraphWidth = Math.max(NODE_MIN_WIDTH, measureSubgraphHeaderWidth(node.label)) + SUBGRAPH_PADDING * 2;
    result.subgraphs.push({
      label: node.label,
      x: startX - SUBGRAPH_PADDING,
      y: subgraphY,
      width: subgraphWidth,
      height: collapsedHeight,
      depth,
      nodeId: node.id,
      collapsedChildCount: totalChildCount,
    });
    result.edges.push({
      fromX: startX + nodeWidth / 2,
      fromY: y + nodeHeight,
      toX: startX - SUBGRAPH_PADDING + subgraphWidth / 2,
      toY: subgraphY,
    });
    result.width = Math.max(nodeWidth, subgraphWidth);
    result.height = nodeHeight + NODE_GAP_Y + collapsedHeight;
    return result;
  }

  if (node.children.length === 0) {
    return result;
  }

  const childDepth = isSubagent ? depth + 1 : depth;
  const indentX = isSubagent ? SUBGRAPH_PADDING : 0;
  const groups = groupChildren(node.children);

  let childStartY = y + nodeHeight + NODE_GAP_Y;
  if (isSubagent) {
    childStartY += SUBGRAPH_HEADER_HEIGHT;
  }

  const { exitNodes, maxWidth, endY } = layoutGroups(
    groups,
    startX + indentX,
    childStartY,
    childDepth,
    [layoutNode],
    result,
    collapsedIds,
    expandedMergedIds,
    pendingExpansions,
  );

  const totalChildrenHeight = endY - childStartY - NODE_GAP_Y;
  let subgraphContentWidth = maxWidth;
  if (isSubagent) {
    subgraphContentWidth = Math.max(maxWidth, measureSubgraphHeaderWidth(node.label));
    result.subgraphs.push({
      label: node.label,
      x: startX - SUBGRAPH_PADDING,
      y: (y + nodeHeight + NODE_GAP_Y) - NODE_GAP_Y / 2,
      width: subgraphContentWidth + SUBGRAPH_PADDING * 2,
      height: totalChildrenHeight + SUBGRAPH_HEADER_HEIGHT + NODE_GAP_Y,
      depth,
      nodeId: node.id,
    });
  }

  result.width = Math.max(nodeWidth, maxWidth + indentX * 2, isSubagent ? subgraphContentWidth + indentX * 2 : 0);
  result.height = nodeHeight + NODE_GAP_Y + totalChildrenHeight + (isSubagent ? SUBGRAPH_HEADER_HEIGHT : 0);
  result.exitNodes = exitNodes;
  return result;
}

function layoutParallelGroup(
  children: readonly HostSessionDebugFlowNode[],
  startX: number,
  y: number,
  depth: number,
  collapsedIds?: ReadonlySet<string>,
  expandedMergedIds?: ReadonlySet<string>,
  pendingExpansions?: PendingExpansion[],
): {
  nodes: HostSessionDebugLayoutNode[];
  edges: HostSessionDebugLayoutEdge[];
  subgraphs: HostSessionDebugSubgraphRect[];
  entryNodes: HostSessionDebugLayoutNode[];
  exitNodes: HostSessionDebugLayoutNode[];
  width: number;
  height: number;
} {
  const subtreeLayouts: HostSessionDebugSubtreeLayout[] = [];
  let totalWidth = 0;
  let maxHeight = 0;

  for (const child of children) {
    const subtree = layoutSubtree(child, 0, y, depth, collapsedIds, expandedMergedIds, pendingExpansions);
    subtreeLayouts.push(subtree);
    totalWidth += subtree.width;
    maxHeight = Math.max(maxHeight, subtree.height);
  }
  totalWidth += (children.length - 1) * PARALLEL_GAP_X;

  const nodes: HostSessionDebugLayoutNode[] = [];
  const edges: HostSessionDebugLayoutEdge[] = [];
  const subgraphs: HostSessionDebugSubgraphRect[] = [];
  const entryNodes: HostSessionDebugLayoutNode[] = [];
  const exitNodes: HostSessionDebugLayoutNode[] = [];

  let currentX = startX;
  for (const subtree of subtreeLayouts) {
    const offsetNodes = subtree.nodes.map(node => ({ ...node, x: node.x + currentX }));
    const offsetEdges = subtree.edges.map(edge => ({
      fromId: edge.fromId,
      toId: edge.toId,
      fromX: edge.fromX + currentX,
      fromY: edge.fromY,
      toX: edge.toX + currentX,
      toY: edge.toY,
    }));
    const offsetSubgraphs = subtree.subgraphs.map(subgraph => ({ ...subgraph, x: subgraph.x + currentX }));

    nodes.push(...offsetNodes);
    edges.push(...offsetEdges);
    subgraphs.push(...offsetSubgraphs);
    entryNodes.push(offsetNodes.find(node => node.id === subtree.entryNode.id)!);

    const exitIds = new Set(subtree.exitNodes.map(node => node.id));
    exitNodes.push(...offsetNodes.filter(node => exitIds.has(node.id)));
    currentX += subtree.width + PARALLEL_GAP_X;
  }

  return { nodes, edges, subgraphs, entryNodes, exitNodes, width: totalWidth, height: maxHeight };
}

function resolvePendingExpansions(
  pendingExpansions: readonly PendingExpansion[],
  result: Pick<HostSessionDebugFlowLayout, 'nodes' | 'edges' | 'subgraphs'>,
): void {
  for (const expansion of pendingExpansions) {
    const { mergedNode, children } = expansion;
    const childrenTotalHeight = children.length * NODE_HEIGHT + (children.length - 1) * NODE_GAP_Y;
    const rangeTop = mergedNode.y;
    const rangeBottom = mergedNode.y + childrenTotalHeight;

    let maxRightX = mergedNode.x + mergedNode.width;
    for (const node of result.nodes) {
      if (node.y + node.height > rangeTop && node.y < rangeBottom) {
        maxRightX = Math.max(maxRightX, node.x + node.width);
      }
    }
    for (const subgraph of result.subgraphs) {
      if (subgraph.y + subgraph.height > rangeTop && subgraph.y < rangeBottom) {
        maxRightX = Math.max(maxRightX, subgraph.x + subgraph.width);
      }
    }

    const expandX = maxRightX + PARALLEL_GAP_X;
    let expandY = mergedNode.y;
    const childNodes: HostSessionDebugLayoutNode[] = [];

    for (const child of children) {
      const width = measureNodeWidth(child.label, child.sublabel);
      const childNode: HostSessionDebugLayoutNode = {
        id: child.id,
        kind: child.kind,
        label: child.label,
        sublabel: child.sublabel,
        tooltip: child.tooltip,
        isError: child.isError,
        x: expandX,
        y: expandY,
        width,
        height: NODE_HEIGHT,
      };
      childNodes.push(childNode);
      result.nodes.push(childNode);
      expandY += NODE_HEIGHT + NODE_GAP_Y;
    }

    const edgeY = childNodes[0].y + childNodes[0].height / 2;
    result.edges.push({
      fromId: mergedNode.id,
      toId: childNodes[0].id,
      fromX: mergedNode.x + mergedNode.width,
      fromY: edgeY,
      toX: expandX,
      toY: edgeY,
    });

    for (let index = 0; index < childNodes.length - 1; index += 1) {
      result.edges.push(makeEdge(childNodes[index], childNodes[index + 1]));
    }
  }
}

function centerLayout(layout: Pick<HostSessionDebugFlowLayout, 'nodes' | 'edges' | 'subgraphs'>, centerX: number): void {
  if (layout.nodes.length === 0) {
    return;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  for (const node of layout.nodes) {
    minX = Math.min(minX, node.x);
    maxX = Math.max(maxX, node.x + node.width);
  }

  const deltaX = centerX - (minX + maxX) / 2;
  for (let index = 0; index < layout.nodes.length; index += 1) {
    layout.nodes[index] = { ...layout.nodes[index], x: layout.nodes[index].x + deltaX };
  }
  for (let index = 0; index < layout.edges.length; index += 1) {
    const edge = layout.edges[index];
    layout.edges[index] = {
      fromId: edge.fromId,
      toId: edge.toId,
      fromX: edge.fromX + deltaX,
      fromY: edge.fromY,
      toX: edge.toX + deltaX,
      toY: edge.toY,
    };
  }
  for (let index = 0; index < layout.subgraphs.length; index += 1) {
    layout.subgraphs[index] = { ...layout.subgraphs[index], x: layout.subgraphs[index].x + deltaX };
  }
}

function renderSubgraphs(
  svg: SVGElement,
  subgraphs: readonly HostSessionDebugSubgraphRect[],
  focusableElements: Map<string, SVGElement>,
): void {
  for (let index = 0; index < subgraphs.length; index += 1) {
    const subgraph = subgraphs[index];
    const color = SUBGRAPH_COLORS[subgraph.depth % SUBGRAPH_COLORS.length];
    const isCollapsed = typeof subgraph.collapsedChildCount === 'number';
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('chat-debug-flowchart-subgraph');

    const rectAttrs = {
      x: subgraph.x,
      y: subgraph.y,
      width: subgraph.width,
      height: subgraph.height,
      rx: NODE_BORDER_RADIUS,
      ry: NODE_BORDER_RADIUS,
    };
    const clipId = `host-session-subgraph-${index}`;
    const clipPath = svgEl('clipPath', { id: clipId });
    clipPath.appendChild(svgEl('rect', rectAttrs));
    svg.appendChild(clipPath);

    group.appendChild(svgEl('rect', { ...rectAttrs, fill: color, opacity: 0.06 + subgraph.depth * 0.02 }));
    group.appendChild(svgEl('rect', { ...rectAttrs, fill: 'none', stroke: color, 'stroke-width': 1, 'stroke-dasharray': '6,3', opacity: 0.5 }));
    group.appendChild(svgEl('rect', {
      x: subgraph.x,
      y: subgraph.y,
      width: GUTTER_WIDTH,
      height: subgraph.height,
      fill: color,
      opacity: 0.7,
      'clip-path': `url(#${clipId})`,
    }));

    const headerGroup = document.createElementNS(SVG_NS, 'g');
    headerGroup.classList.add('chat-debug-flowchart-subgraph-header');
    headerGroup.setAttribute('data-subgraph-id', subgraph.nodeId);
    headerGroup.setAttribute('tabindex', '0');
    headerGroup.setAttribute('role', 'button');
    headerGroup.setAttribute('aria-expanded', String(!isCollapsed));
    headerGroup.setAttribute(
      'aria-label',
      `${subgraph.label}: ${isCollapsed ? 'collapsed' : 'expanded'}${isCollapsed && typeof subgraph.collapsedChildCount === 'number' ? `, ${subgraph.collapsedChildCount} items hidden` : ''}`,
    );

    headerGroup.appendChild(svgEl('rect', {
      x: subgraph.x,
      y: subgraph.y,
      width: subgraph.width,
      height: SUBGRAPH_HEADER_HEIGHT,
      fill: color,
      opacity: 0.15,
      'clip-path': `url(#${clipId})`,
    }));

    const headerText = svgEl('text', {
      x: subgraph.x + GUTTER_WIDTH + 8,
      y: subgraph.y + SUBGRAPH_HEADER_HEIGHT / 2 + 4,
      'font-size': SUBLABEL_FONT_SIZE,
      fill: color,
      'font-family': 'var(--aily-font-family, sans-serif)',
      'font-weight': '600',
    });
    headerText.textContent = `${isCollapsed ? '▶' : '▼'} ${subgraph.label}`;
    headerGroup.appendChild(headerText);
    group.appendChild(headerGroup);
    focusableElements.set(`sg:${subgraph.nodeId}`, headerGroup as unknown as SVGElement);

    if (isCollapsed && typeof subgraph.collapsedChildCount === 'number') {
      const badgeText = svgEl('text', {
        x: subgraph.x + subgraph.width / 2,
        y: subgraph.y + SUBGRAPH_HEADER_HEIGHT + SUBGRAPH_PADDING + 4,
        'font-size': SUBLABEL_FONT_SIZE,
        fill: 'var(--aily-text-muted, #8b949e)',
        'font-family': 'var(--aily-font-family, sans-serif)',
        'font-style': 'italic',
        'text-anchor': 'middle',
      });
      badgeText.textContent = `+${subgraph.collapsedChildCount} items`;
      group.appendChild(badgeText);
    }

    svg.appendChild(group);
  }
}

function renderEdges(svg: SVGElement, edges: readonly HostSessionDebugLayoutEdge[]): void {
  const strokeAttrs = {
    fill: 'none',
    stroke: 'var(--aily-text-muted, #8b949e)',
    'stroke-width': EDGE_STROKE_WIDTH,
    'stroke-linecap': 'round',
  };
  const radius = 6;

  for (const edge of edges) {
    const middleY = (edge.fromY + edge.toY) / 2;
    const isHorizontal = edge.fromY === edge.toY;
    let pathData = '';

    if (isHorizontal || edge.fromX === edge.toX) {
      pathData = `M ${edge.fromX} ${edge.fromY} L ${edge.toX} ${edge.toY}`;
    } else {
      const deltaX = edge.toX - edge.fromX;
      const direction = deltaX > 0 ? 1 : -1;
      const absoluteDeltaX = Math.abs(deltaX);
      const cornerRadius = Math.min(radius, absoluteDeltaX / 2, (edge.toY - edge.fromY) / 4);

      pathData = `M ${edge.fromX} ${edge.fromY}`
        + ` L ${edge.fromX} ${middleY - cornerRadius}`
        + ` Q ${edge.fromX} ${middleY}, ${edge.fromX + direction * cornerRadius} ${middleY}`
        + ` L ${edge.toX - direction * cornerRadius} ${middleY}`
        + ` Q ${edge.toX} ${middleY}, ${edge.toX} ${middleY + cornerRadius}`
        + ` L ${edge.toX} ${edge.toY}`;
    }

    svg.appendChild(svgEl('path', { ...strokeAttrs, d: pathData }));

    const arrowSize = 5;
    let arrowPath = '';
    if (isHorizontal) {
      const direction = edge.toX > edge.fromX ? 1 : -1;
      arrowPath = `M ${edge.toX - direction * arrowSize * 1.5} ${edge.toY - arrowSize} L ${edge.toX} ${edge.toY} L ${edge.toX - direction * arrowSize * 1.5} ${edge.toY + arrowSize}`;
    } else {
      arrowPath = `M ${edge.toX - arrowSize} ${edge.toY - arrowSize * 1.5} L ${edge.toX} ${edge.toY} L ${edge.toX + arrowSize} ${edge.toY - arrowSize * 1.5}`;
    }

    svg.appendChild(svgEl('path', {
      ...strokeAttrs,
      'stroke-linejoin': 'round',
      d: arrowPath,
    }));
  }
}

function renderNodes(
  svg: SVGElement,
  nodes: readonly HostSessionDebugLayoutNode[],
  focusableElements: Map<string, SVGElement>,
): void {
  const fontFamily = 'var(--aily-font-family, sans-serif)';
  const nodeFill = 'var(--aily-surface-primary, #252526)';

  for (const node of nodes) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.classList.add('chat-debug-flowchart-node');
    group.setAttribute('data-node-id', node.id);
    group.setAttribute('tabindex', '0');
    group.setAttribute('role', 'img');
    group.setAttribute('aria-label', node.sublabel ? `${node.label}, ${node.sublabel}` : node.label);
    focusableElements.set(node.id, group as unknown as SVGElement);

    if (node.tooltip) {
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = node.tooltip;
      group.appendChild(title);
    }

    const color = getNodeColor(node.kind, node.isError);
    const safeId = node.id.replace(/[^a-zA-Z0-9]/g, '_');
    const rectAttrs = {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rx: NODE_BORDER_RADIUS,
      ry: NODE_BORDER_RADIUS,
    };
    const clipId = `host-session-node-${safeId}`;
    const clipPath = svgEl('clipPath', { id: clipId });
    clipPath.appendChild(svgEl('rect', rectAttrs));
    svg.appendChild(clipPath);

    const focusOffset = 3;
    group.appendChild(svgEl('rect', {
      class: 'chat-debug-flowchart-focus-ring',
      x: node.x - focusOffset,
      y: node.y - focusOffset,
      width: node.width + focusOffset * 2,
      height: node.height + focusOffset * 2,
      rx: NODE_BORDER_RADIUS + focusOffset,
      ry: NODE_BORDER_RADIUS + focusOffset,
      fill: 'none',
      stroke: 'var(--aily-focus-border, #58a6ff)',
      'stroke-width': 2,
    }));

    group.appendChild(svgEl('rect', {
      ...rectAttrs,
      class: 'chat-debug-flowchart-node-body',
      fill: nodeFill,
      stroke: color,
      'stroke-width': node.isError ? 2 : 1.5,
    }));
    group.appendChild(svgEl('rect', {
      x: node.x,
      y: node.y,
      width: 4,
      height: node.height,
      fill: color,
      'clip-path': `url(#${clipId})`,
    }));

    const textX = node.x + NODE_PADDING_H;
    const isMessage = isMessageKind(node.kind);
    if (isMessage && node.sublabel) {
      const header = svgEl('text', {
        x: textX,
        y: node.y + NODE_PADDING_V + SUBLABEL_FONT_SIZE,
        'font-size': SUBLABEL_FONT_SIZE,
        fill: 'var(--aily-text-muted, #8b949e)',
        'font-family': fontFamily,
        'clip-path': `url(#${clipId})`,
      });
      header.textContent = node.label;
      group.appendChild(header);

      const message = svgEl('text', {
        x: textX,
        y: node.y + node.height - NODE_PADDING_V - 2,
        'font-size': FONT_SIZE,
        fill: 'var(--aily-text-primary, #e6edf3)',
        'font-family': fontFamily,
        'clip-path': `url(#${clipId})`,
      });
      message.textContent = node.sublabel;
      group.appendChild(message);
    } else if (node.sublabel) {
      const label = svgEl('text', {
        x: textX,
        y: node.y + NODE_PADDING_V + FONT_SIZE,
        'font-size': FONT_SIZE,
        fill: 'var(--aily-text-primary, #e6edf3)',
        'font-family': fontFamily,
        'clip-path': `url(#${clipId})`,
      });
      label.textContent = node.label;
      group.appendChild(label);

      const sublabel = svgEl('text', {
        x: textX,
        y: node.y + node.height - NODE_PADDING_V,
        'font-size': SUBLABEL_FONT_SIZE,
        fill: 'var(--aily-text-muted, #8b949e)',
        'font-family': fontFamily,
        'clip-path': `url(#${clipId})`,
      });
      sublabel.textContent = node.sublabel;
      group.appendChild(sublabel);
    } else {
      const label = svgEl('text', {
        x: textX,
        y: node.y + node.height / 2 + FONT_SIZE / 2 - 1,
        'font-size': FONT_SIZE,
        fill: 'var(--aily-text-primary, #e6edf3)',
        'font-family': fontFamily,
        'clip-path': `url(#${clipId})`,
      });
      label.textContent = node.label;
      group.appendChild(label);
    }

    if (node.mergedCount) {
      group.setAttribute('data-is-toggle', 'true');
      renderMergedToggle(group, node, color, fontFamily);
    }

    svg.appendChild(group);
  }
}

function renderMergedToggle(group: Element, node: HostSessionDebugLayoutNode, color: string, fontFamily: string): void {
  const toggleX = node.x + node.width - MERGED_TOGGLE_WIDTH;
  const toggleGroup = document.createElementNS(SVG_NS, 'g');
  toggleGroup.classList.add('chat-debug-flowchart-merged-toggle');
  toggleGroup.setAttribute('data-merged-id', node.id);

  toggleGroup.appendChild(svgEl('line', {
    x1: toggleX,
    y1: node.y + 4,
    x2: toggleX,
    y2: node.y + node.height - 4,
    stroke: 'var(--aily-text-muted, #8b949e)',
    'stroke-width': 0.5,
    opacity: 0.4,
  }));

  const chevron = svgEl('text', {
    x: toggleX + MERGED_TOGGLE_WIDTH / 2,
    y: node.y + node.height / 2 + 4,
    'font-size': 9,
    fill: color,
    'font-family': fontFamily,
    'text-anchor': 'middle',
    cursor: 'pointer',
  });
  chevron.textContent = node.isMergedExpanded ? '◀' : '▶';
  toggleGroup.appendChild(chevron);
  toggleGroup.appendChild(svgEl('rect', {
    x: toggleX,
    y: node.y,
    width: MERGED_TOGGLE_WIDTH,
    height: node.height,
    fill: 'transparent',
    cursor: 'pointer',
  }));

  group.appendChild(toggleGroup);
}

function getNodeColor(kind: HostSessionDebugFlowNode['kind'], isError?: boolean): string {
  if (isError) {
    return 'var(--aily-color-danger, #f85149)';
  }

  switch (kind) {
    case 'userMessage':
      return 'var(--aily-color-accent, #58a6ff)';
    case 'modelTurn':
      return 'var(--aily-chart-blue, #58a6ff)';
    case 'toolCall':
      return 'var(--aily-color-success, #73c991)';
    case 'subagentInvocation':
      return 'var(--aily-chart-purple, #b267e6)';
    case 'agentResponse':
      return 'var(--aily-text-primary, #e6edf3)';
    case 'generic':
      return 'var(--aily-text-muted, #8b949e)';
  }
}

function countDescendants(node: HostSessionDebugFlowNode): number {
  let count = node.children.length;
  for (const child of node.children) {
    count += countDescendants(child);
  }
  return count;
}

function measureNodeWidth(label: string, sublabel?: string): number {
  const charWidth = 7;
  const labelWidth = label.length * charWidth + NODE_PADDING_H * 2;
  const sublabelWidth = sublabel ? sublabel.length * (charWidth - 1) + NODE_PADDING_H * 2 : 0;
  return Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, labelWidth, sublabelWidth));
}

function measureSubgraphHeaderWidth(label: string): number {
  return label.length * 6 + SUBGRAPH_PADDING * 2 + 20;
}

function isMessageKind(kind: HostSessionDebugFlowNode['kind']): boolean {
  return kind === 'userMessage' || kind === 'agentResponse';
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}
