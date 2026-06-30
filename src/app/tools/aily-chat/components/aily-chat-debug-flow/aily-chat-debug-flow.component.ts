import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AilyChatDebugDetailPanelComponent } from '../aily-chat-debug-detail-panel/aily-chat-debug-detail-panel.component';
import {
  buildHostSessionDebugFlowGraph,
  countFlowNodes,
  filterHostSessionDebugFlowNodes,
  mergeDiscoveryNodes,
  mergeToolCallNodes,
  sliceHostSessionDebugFlowNodes,
  type HostSessionDebugFlowNode,
} from '../../helpers/chat-debug-flow-graph';
import {
  layoutHostSessionDebugFlowGraph,
  renderHostSessionDebugFlowChartSvg,
  type HostSessionDebugFlowChartRenderResult,
  type HostSessionDebugFlowLayout,
} from '../../helpers/chat-debug-flow-layout';
import {
  type HostSessionDebugEvent,
  type HostSessionDebugResolvedEventContent,
} from '../../services/host-session-debug-events';
import { ChatDebugBrowserService } from '../../services/chat-debug-browser.service';
import { AilyChatDebugBreadcrumbComponent } from '../aily-chat-debug-breadcrumb/aily-chat-debug-breadcrumb.component';

@Component({
  selector: 'aily-chat-debug-flow',
  standalone: true,
  imports: [CommonModule, FormsModule, AilyChatDebugBreadcrumbComponent, AilyChatDebugDetailPanelComponent],
  templateUrl: './aily-chat-debug-flow.component.html',
  styleUrl: './aily-chat-debug-flow.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class AilyChatDebugFlowComponent implements AfterViewInit {
  private static readonly PAGE_SIZE = 100;
  private static readonly MIN_SCALE = 0.1;
  private static readonly MAX_SCALE = 5;
  private static readonly ZOOM_STEP = 0.15;
  private static readonly WHEEL_ZOOM_FACTOR = 0.002;
  private static readonly CLICK_THRESHOLD_SQ = 25;

  private _events: readonly HostSessionDebugEvent[] = [];
  private flowGraph: readonly HostSessionDebugFlowNode[] = [];
  private filteredFlowGraph: readonly HostSessionDebugFlowNode[] = [];
  private visibleFlowGraph: readonly HostSessionDebugFlowNode[] = [];
  private eventById = new Map<string, HostSessionDebugEvent>();
  private collapsedNodeIds = new Set<string>();
  private expandedMergedIds = new Set<string>();
  private renderedNodeIds = new Set<string>();
  private chartLayout: HostSessionDebugFlowLayout = { nodes: [], edges: [], subgraphs: [], width: 0, height: 0 };
  private chartRenderResult: HostSessionDebugFlowChartRenderResult | null = null;
  private focusedElementId: string | null = null;
  private svgWrapper: HTMLDivElement | null = null;
  private svgElement: SVGElement | null = null;
  private scale = 1;
  private translateX = 0;
  private translateY = 0;
  private isPanning = false;
  private startX = 0;
  private startY = 0;
  private mouseDownX = 0;
  private mouseDownY = 0;
  private hasUserPanned = false;
  private suppressNextClick = false;

  @ViewChild('svgHost') private svgHost?: ElementRef<HTMLDivElement>;
  @ViewChild('canvas') private canvas?: ElementRef<HTMLDivElement>;
  @ViewChild(AilyChatDebugDetailPanelComponent) private detailPanel?: AilyChatDebugDetailPanelComponent;

  selectedNodeId: string | null = null;
  selectedEvent: HostSessionDebugEvent | null = null;
  selectedResolvedContent: HostSessionDebugResolvedEventContent | null = null;
  selectedDetailTitle: string | null = null;
  textFilter = '';
  visibleLimit = AilyChatDebugFlowComponent.PAGE_SIZE;
  readonly kindFilterOrder: readonly HostSessionDebugFlowNode['kind'][] = [
    'userMessage',
    'modelTurn',
    'toolCall',
    'generic',
    'subagentInvocation',
    'agentResponse',
  ];
  readonly kindFilters: Record<HostSessionDebugFlowNode['kind'], boolean> = {
    userMessage: true,
    modelTurn: true,
    toolCall: true,
    generic: true,
    subagentInvocation: true,
    agentResponse: true,
  };
  private lastSliceTotalCount = 0;
  private lastSliceShownCount = 0;

  constructor(
    private readonly debugBrowserService: ChatDebugBrowserService,
  ) {}

  ngAfterViewInit(): void {
    this.renderChart();
  }

  @Input({ required: true }) sessionTitle = '';
  @Input({ required: true }) sessionId = '';
  @Input() sourceSessionId = '';
  @Input() importedAt = 0;
  @Input()
  set events(value: readonly HostSessionDebugEvent[]) {
    this._events = value;
    this.flowGraph = buildHostSessionDebugFlowGraph(value);
    this.eventById = new Map(value.map((event) => [event.id, event]));
    this.collapsedNodeIds = new Set<string>();
    this.expandedMergedIds = new Set<string>();
    this.focusedElementId = null;
    this.visibleLimit = AilyChatDebugFlowComponent.PAGE_SIZE;
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.hasUserPanned = false;
    this.recomputeVisibleGraph();
  }

  get events(): readonly HostSessionDebugEvent[] {
    return this._events;
  }

  @Output() overviewRequested = new EventEmitter<void>();
  @Output() homeRequested = new EventEmitter<void>();
  @Output() closeRequested = new EventEmitter<void>();

  get graph(): readonly HostSessionDebugFlowNode[] {
    return this.visibleFlowGraph;
  }

  get hasVisibleFlow(): boolean {
    return this.filteredFlowGraph.length > 0;
  }

  get totalNodeCount(): number {
    return countFlowNodes(this.filteredFlowGraph);
  }

  get maxDepth(): number {
    return getMaxDepth(this.filteredFlowGraph);
  }

  get subagentCount(): number {
    return countNodesByKind(this.filteredFlowGraph, 'subagentInvocation');
  }

  get errorNodeCount(): number {
    return countErrorNodes(this.filteredFlowGraph);
  }

  get hasMoreNodes(): boolean {
    return this.graph.length > 0 && this.shownNodeCount < this.lastSliceTotalCount;
  }

  get shownNodeCount(): number {
    return this.lastSliceShownCount;
  }

  selectNode(node: HostSessionDebugFlowNode): void {
    this.selectedNodeId = node.id;
    this.refreshSelection();
    this.renderChart();
  }

  selectNodeById(nodeId: string): void {
    this.selectedNodeId = nodeId;
    this.refreshSelection();
    this.renderChart();
  }

  clearSelection(): void {
    this.selectedNodeId = null;
    this.selectedEvent = null;
    this.selectedResolvedContent = null;
    this.selectedDetailTitle = null;
    this.renderChart();
  }

  onFilterChanged(): void {
    this.visibleLimit = AilyChatDebugFlowComponent.PAGE_SIZE;
    this.hasUserPanned = false;
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.recomputeVisibleGraph();
  }

  toggleKind(kind: HostSessionDebugFlowNode['kind']): void {
    this.kindFilters[kind] = !this.kindFilters[kind];
    this.visibleLimit = AilyChatDebugFlowComponent.PAGE_SIZE;
    this.hasUserPanned = false;
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.recomputeVisibleGraph();
  }

  showMore(): void {
    this.visibleLimit += AilyChatDebugFlowComponent.PAGE_SIZE;
    this.recomputeVisibleGraph();
  }

  onCanvasClick(event: MouseEvent): void {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }

    const target = event.target as Element | null;
    if (!target) {
      return;
    }

    const mergedToggle = target.closest('[data-merged-id]');
    if (mergedToggle) {
      const mergedId = mergedToggle.getAttribute('data-merged-id');
      if (mergedId) {
        this.toggleMergedNode(mergedId);
      }
      return;
    }

    const subgraphHeader = target.closest('[data-subgraph-id]');
    if (subgraphHeader) {
      const subgraphId = subgraphHeader.getAttribute('data-subgraph-id');
      if (subgraphId) {
        this.toggleSubgraph(subgraphId);
      }
      return;
    }

    const nodeElement = target.closest('[data-node-id]');
    if (nodeElement) {
      const nodeId = nodeElement.getAttribute('data-node-id');
      if (nodeId) {
        const isToggle = nodeElement.getAttribute('data-is-toggle') === 'true';
        if (isToggle) {
          this.toggleMergedNode(nodeId);
        } else {
          this.selectNodeById(nodeId);
        }
      }
    }
  }

  onCanvasFocusIn(event: FocusEvent): void {
    const target = event.target as Element | null;
    if (!target) {
      return;
    }

    const subgraphId = target.getAttribute('data-subgraph-id');
    if (subgraphId) {
      this.focusedElementId = `sg:${subgraphId}`;
      return;
    }

    const nodeId = target.getAttribute('data-node-id');
    if (nodeId) {
      this.focusedElementId = nodeId;
    }
  }

  onCanvasKeyDown(event: KeyboardEvent): void {
    const target = event.target as Element | null;
    if (!target) {
      return;
    }

    const subgraphId = target.getAttribute('data-subgraph-id');
    const nodeId = target.getAttribute('data-node-id');
    const isToggle = target.getAttribute('data-is-toggle') === 'true';

    switch (event.key) {
      case 'Tab': {
        if (this.focusedElementId) {
          const moved = this.focusAdjacentElement(this.focusedElementId, event.shiftKey ? -1 : 1);
          if (moved) {
            event.preventDefault();
          } else if (!event.shiftKey && this.detailPanel?.isVisible) {
            event.preventDefault();
            this.detailPanel.focus();
          }
        } else if (!event.shiftKey) {
          event.preventDefault();
          this.focusFirstElement();
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (subgraphId) {
          this.toggleSubgraph(subgraphId);
        } else if (nodeId) {
          if (isToggle) {
            this.toggleMergedNode(nodeId);
          } else {
            this.selectNodeById(nodeId);
          }
        }
        break;
      }
      case 'ArrowDown': {
        event.preventDefault();
        if (this.focusedElementId) {
          this.focusEdgeNeighbor(this.focusedElementId, 'next');
        } else {
          this.focusFirstElement();
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (this.focusedElementId) {
          this.focusEdgeNeighbor(this.focusedElementId, 'prev');
        } else {
          this.focusFirstElement();
        }
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (subgraphId && this.collapsedNodeIds.has(subgraphId)) {
          this.toggleSubgraph(subgraphId);
          this.focusFirstChildOfNode(subgraphId);
        } else if (nodeId && isToggle) {
          if (!this.expandedMergedIds.has(nodeId)) {
            this.toggleMergedNode(nodeId);
          }
          this.focusFirstChildOfNode(nodeId);
        } else if (!this.focusedElementId) {
          this.focusFirstElement();
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (subgraphId && !this.collapsedNodeIds.has(subgraphId)) {
          this.toggleSubgraph(subgraphId);
          this.restoreFocus(`sg:${subgraphId}`);
        } else if (nodeId && isToggle && this.expandedMergedIds.has(nodeId)) {
          this.toggleMergedNode(nodeId);
          this.restoreFocus(nodeId);
        } else if (this.focusedElementId) {
          this.focusEdgeNeighbor(this.focusedElementId, 'prev');
        }
        break;
      }
      case 'Home':
        event.preventDefault();
        this.focusFirstElement();
        break;
      case 'End':
        event.preventDefault();
        this.focusLastElement();
        break;
      case '=':
      case '+':
        if (!event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          this.zoomBy(AilyChatDebugFlowComponent.ZOOM_STEP);
        }
        break;
      case '-':
        if (!event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          this.zoomBy(-AilyChatDebugFlowComponent.ZOOM_STEP);
        }
        break;
    }
  }

  onCanvasMouseDown(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    this.isPanning = true;
    this.hasUserPanned = true;
    this.startX = event.clientX - this.translateX;
    this.startY = event.clientY - this.translateY;
    this.mouseDownX = event.clientX;
    this.mouseDownY = event.clientY;
    const canvas = this.canvas?.nativeElement;
    if (canvas) {
      canvas.style.cursor = 'grabbing';
    }
  }

  onCanvasWheel(event: WheelEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const canvas = this.canvas?.nativeElement;
    if (!canvas) {
      return;
    }

    this.hasUserPanned = true;
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const delta = -event.deltaY * AilyChatDebugFlowComponent.WHEEL_ZOOM_FACTOR;
    const newScale = Math.min(
      AilyChatDebugFlowComponent.MAX_SCALE,
      Math.max(AilyChatDebugFlowComponent.MIN_SCALE, this.scale * (1 + delta)),
    );
    const scaleFactor = newScale / this.scale;
    this.translateX = mouseX - (mouseX - this.translateX) * scaleFactor;
    this.translateY = mouseY - (mouseY - this.translateY) * scaleFactor;
    this.scale = newScale;
    this.applyTransform();
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMouseMove(event: MouseEvent): void {
    if (!this.isPanning) {
      return;
    }

    if (event.buttons === 0) {
      this.onDocumentMouseUp(event);
      return;
    }

    this.translateX = event.clientX - this.startX;
    this.translateY = event.clientY - this.startY;
    this.applyTransform();
  }

  @HostListener('document:mouseup', ['$event'])
  onDocumentMouseUp(event: MouseEvent): void {
    if (!this.isPanning) {
      return;
    }

    this.isPanning = false;
    const canvas = this.canvas?.nativeElement;
    if (canvas) {
      canvas.style.cursor = 'grab';
    }

    const deltaX = event.clientX - this.mouseDownX;
    const deltaY = event.clientY - this.mouseDownY;
    this.suppressNextClick = deltaX * deltaX + deltaY * deltaY >= AilyChatDebugFlowComponent.CLICK_THRESHOLD_SQ;
  }

  isSelected(node: HostSessionDebugFlowNode): boolean {
    return this.selectedNodeId === node.id;
  }

  private refreshSelection(): void {
    if (!this.selectedNodeId) {
      this.selectedEvent = null;
      this.selectedResolvedContent = null;
      this.selectedDetailTitle = null;
      return;
    }

    if (!this.renderedNodeIds.has(this.selectedNodeId)) {
      this.selectedNodeId = null;
      this.selectedEvent = null;
      this.selectedResolvedContent = null;
      this.selectedDetailTitle = null;
      return;
    }

    const directEvent = this.eventById.get(this.selectedNodeId) ?? null;
    if (directEvent) {
      this.selectedEvent = directEvent;
      this.selectedDetailTitle = null;
      this.selectedResolvedContent = this.debugBrowserService.resolveActiveImportedDebugEventContent(directEvent.id);
      return;
    }

    const node = findFlowNodeById(this.visibleFlowGraph, this.selectedNodeId);
    if (!node) {
      this.selectedNodeId = null;
      this.selectedEvent = null;
      this.selectedResolvedContent = null;
      this.selectedDetailTitle = null;
      return;
    }

    this.selectedNodeId = null;
    this.selectedEvent = null;
    this.selectedResolvedContent = null;
    this.selectedDetailTitle = null;
  }

  private recomputeVisibleGraph(): void {
    this.filteredFlowGraph = filterHostSessionDebugFlowNodes([...this.flowGraph], {
      isKindVisible: (kind) => this.kindFilters[kind],
      textFilter: this.textFilter,
    });
    const slice = sliceHostSessionDebugFlowNodes(this.filteredFlowGraph, this.visibleLimit);
    this.visibleFlowGraph = mergeToolCallNodes(mergeDiscoveryNodes(slice.nodes));
    this.lastSliceTotalCount = slice.totalCount;
    this.lastSliceShownCount = slice.shownCount;
    this.updateChartLayout();
  }

  private toggleSubgraph(nodeId: string): void {
    if (this.collapsedNodeIds.has(nodeId)) {
      this.collapsedNodeIds.delete(nodeId);
    } else {
      this.collapsedNodeIds.add(nodeId);
    }
    this.clearSelectionSilently();
    this.updateChartLayout();
  }

  private toggleMergedNode(nodeId: string): void {
    if (this.expandedMergedIds.has(nodeId)) {
      this.expandedMergedIds.delete(nodeId);
    } else {
      this.expandedMergedIds.add(nodeId);
    }
    this.clearSelectionSilently();
    this.updateChartLayout();
  }

  private clearSelectionSilently(): void {
    this.selectedNodeId = null;
    this.selectedEvent = null;
    this.selectedResolvedContent = null;
    this.selectedDetailTitle = null;
  }

  private updateChartLayout(): void {
    this.chartLayout = layoutHostSessionDebugFlowGraph([...this.visibleFlowGraph], {
      collapsedIds: this.collapsedNodeIds,
      expandedMergedIds: this.expandedMergedIds,
    });
    this.renderedNodeIds = new Set(this.chartLayout.nodes.map(node => node.id));
    this.refreshSelection();
    this.renderChart();
  }

  private renderChart(): void {
    const host = this.svgHost?.nativeElement;
    if (!host) {
      return;
    }

    host.replaceChildren();
    this.chartRenderResult = null;
    this.svgWrapper = null;
    this.svgElement = null;
    if (this.chartLayout.nodes.length === 0) {
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'chat-debug-flowchart-svg-wrapper';
    this.chartRenderResult = renderHostSessionDebugFlowChartSvg(this.chartLayout);
    wrapper.appendChild(this.chartRenderResult.svg);
    host.appendChild(wrapper);
    this.svgWrapper = wrapper;
    this.svgElement = this.chartRenderResult.svg;

    if (!this.hasUserPanned) {
      this.centerContent();
    } else {
      this.applyTransform();
    }

    if (this.selectedNodeId) {
      const selected = this.chartRenderResult.focusableElements.get(this.selectedNodeId);
      selected?.classList.add('selected');
    }

    if (this.focusedElementId) {
      this.restoreFocus(this.focusedElementId);
    }
  }

  private focusFirstElement(): void {
    const first = this.chartRenderResult?.focusableElements.values().next();
    if (!first?.done) {
      first.value.focus();
    }
  }

  private focusLastElement(): void {
    if (!this.chartRenderResult) {
      return;
    }

    const entries = [...this.chartRenderResult.focusableElements.values()];
    entries.at(-1)?.focus();
  }

  private focusAdjacentElement(currentKey: string, direction: 1 | -1): boolean {
    if (!this.chartRenderResult) {
      return false;
    }

    const keys = [...this.chartRenderResult.focusableElements.keys()];
    const currentIndex = keys.indexOf(currentKey);
    if (currentIndex === -1) {
      return false;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= keys.length) {
      return false;
    }

    const element = this.chartRenderResult.focusableElements.get(keys[nextIndex]);
    if (!element) {
      return false;
    }

    element.focus();
    return true;
  }

  private focusEdgeNeighbor(currentId: string, direction: 'next' | 'prev'): boolean {
    const neighbors = this.chartRenderResult?.adjacency.get(currentId)?.[direction];
    if (!neighbors?.length || !this.chartRenderResult) {
      return false;
    }

    for (const id of neighbors) {
      const element = this.chartRenderResult.focusableElements.get(id);
      if (element) {
        element.focus();
        return true;
      }
    }

    return false;
  }

  private focusFirstChildOfNode(nodeId: string): void {
    if (!this.chartRenderResult) {
      return;
    }

    const flowNode = findFlowNodeById(this.visibleFlowGraph, nodeId);
    if (!flowNode) {
      return;
    }

    const candidates = flowNode.mergedNodes?.length
      ? flowNode.mergedNodes
      : collectDescendantNodes(flowNode.children);
    const parentPosition = this.chartRenderResult.positions.get(nodeId);
    let bestCandidate: string | null = null;

    for (const candidate of candidates) {
      if (!this.chartRenderResult.focusableElements.has(candidate.id)) {
        continue;
      }

      if (!bestCandidate) {
        bestCandidate = candidate.id;
      }

      if (parentPosition) {
        const position = this.chartRenderResult.positions.get(candidate.id);
        if (position && position.x > parentPosition.x) {
          bestCandidate = candidate.id;
          break;
        }
      }
    }

    if (bestCandidate) {
      this.restoreFocus(bestCandidate);
    }
  }

  private restoreFocus(elementId: string): void {
    const element = this.chartRenderResult?.focusableElements.get(elementId);
    if (!element) {
      return;
    }

    this.focusedElementId = elementId;
    element.focus();
  }

  private zoomBy(delta: number): void {
    const canvas = this.canvas?.nativeElement;
    if (!canvas) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const newScale = Math.min(
      AilyChatDebugFlowComponent.MAX_SCALE,
      Math.max(AilyChatDebugFlowComponent.MIN_SCALE, this.scale * (1 + delta)),
    );
    const scaleFactor = newScale / this.scale;
    this.translateX = centerX - (centerX - this.translateX) * scaleFactor;
    this.translateY = centerY - (centerY - this.translateY) * scaleFactor;
    this.scale = newScale;
    this.hasUserPanned = true;
    this.applyTransform();
  }

  private applyTransform(): void {
    if (this.svgWrapper) {
      this.svgWrapper.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
    }
  }

  private centerContent(): void {
    const canvas = this.canvas?.nativeElement;
    if (!canvas || !this.svgElement) {
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const svgWidth = Number(this.svgElement.getAttribute('width') || 0);
    const padding = 20;
    this.translateX = Math.max(padding, (canvasRect.width - svgWidth) / 2);
    this.translateY = padding;
    this.applyTransform();
  }
}

function findFlowNodeById(
  nodes: readonly HostSessionDebugFlowNode[],
  id: string,
): HostSessionDebugFlowNode | null {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }

    const child = findFlowNodeById(node.children, id);
    if (child) {
      return child;
    }
  }

  return null;
}

function collectDescendantNodes(nodes: readonly HostSessionDebugFlowNode[]): HostSessionDebugFlowNode[] {
  const result: HostSessionDebugFlowNode[] = [];
  for (const node of nodes) {
    result.push(node);
    result.push(...collectDescendantNodes(node.children));
  }
  return result;
}

function countNodesByKind(nodes: readonly HostSessionDebugFlowNode[], kind: HostSessionDebugFlowNode['kind']): number {
  return nodes.reduce((total, node) => {
    return total + (node.kind === kind ? 1 : 0) + countNodesByKind(node.children, kind);
  }, 0);
}

function countErrorNodes(nodes: readonly HostSessionDebugFlowNode[]): number {
  return nodes.reduce((total, node) => {
    return total + (node.isError ? 1 : 0) + countErrorNodes(node.children);
  }, 0);
}

function getMaxDepth(nodes: readonly HostSessionDebugFlowNode[], depth = 0): number {
  if (!nodes.length) {
    return depth;
  }

  return Math.max(...nodes.map(node => getMaxDepth(node.children, depth + 1)));
}