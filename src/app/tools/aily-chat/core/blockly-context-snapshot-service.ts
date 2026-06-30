import { AilyHost } from './host';
import { isSchematicAgentIdentifier } from './agent-identifiers';
import {
  buildBlocklyContextSnapshot,
  summarizeBlocklyContextSnapshot,
  type BlocklyContextSnapshot,
  type BlocklyContextSummaryOptions,
} from './blockly-environment-context';
import { getProjectContextTool } from '../tools/connectionGraphTool';

interface BlocklyContextResolveOptions {
  scopes?: readonly string[];
  forceRefresh?: boolean;
  reason?: string;
}

interface BlocklyContextSummaryRequest extends BlocklyContextResolveOptions {
  agentType?: string;
  summaryOptions?: BlocklyContextSummaryOptions;
}

export interface BlocklyContextSnapshotService {
  getSnapshot(options?: BlocklyContextResolveOptions): Promise<BlocklyContextSnapshot>;
  invalidate(scopes: readonly string[], reason: string): void;
  summarize(snapshot: BlocklyContextSnapshot, options?: BlocklyContextSummaryOptions): readonly string[];
  getSummary(options?: BlocklyContextSummaryRequest): Promise<readonly string[]>;
}

let contextSnapshotVersion = 1;
let lastInvalidatedReason: string | undefined;

function tryParseJson(content: string | undefined): any | undefined {
  if (!content) {
    return undefined;
  }

  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function getVariantStatusCounts(contextData: any): { available: number; pending: number } {
  let available = 0;
  let pending = 0;

  const countVariants = (catalog: any): void => {
    if (!Array.isArray(catalog?.models)) {
      return;
    }

    for (const model of catalog.models) {
      if (!Array.isArray(model?.variants)) {
        continue;
      }

      for (const variant of model.variants) {
        if (variant?.status === 'available') {
          available += 1;
        } else {
          pending += 1;
        }
      }
    }
  };

  countVariants(contextData?.currentBoard);
  if (Array.isArray(contextData?.catalogs)) {
    for (const catalog of contextData.catalogs) {
      countVariants(catalog);
    }
  }

  return { available, pending };
}

async function getSchematicOverlaySummaryLines(host: any): Promise<readonly string[]> {
  const lines: string[] = [];
  const connectionGraph = host.connectionGraph;
  const project = host.project;

  if (!connectionGraph || !project) {
    return lines;
  }

  try {
    const projectContext = await getProjectContextTool(connectionGraph, project, { includeNeedsGeneration: true });
    if (!projectContext.is_error) {
      const contextData = tryParseJson(projectContext.content);
      const board = contextData?.currentBoard;
      if (board) {
        const boardLabel = board.displayName || board.packageSlug || project.currentBoard || 'current board';
        const boardStatus = board.catalogStatus || 'unknown';
        const boardPinmapId = board.pinmapId ? `, ${board.pinmapId}` : '';
        lines.push(`Schematic board pinmap: ${boardLabel} (${boardStatus}${boardPinmapId})`);
      }

      const hardwareCatalogCount = Array.isArray(contextData?.catalogs)
        ? contextData.catalogs.length
        : (typeof contextData?.catalogCount === 'number' ? contextData.catalogCount : 0);
      const softwareLibraryCount = Array.isArray(contextData?.softwareLibraries)
        ? contextData.softwareLibraries.length
        : 0;
      if (hardwareCatalogCount > 0 || softwareLibraryCount > 0) {
        lines.push(`Schematic catalogs: ${hardwareCatalogCount} hardware catalog(s), ${softwareLibraryCount} software library card(s)`);
      }

      const variantStatusCounts = getVariantStatusCounts(contextData);
      if (variantStatusCounts.available > 0 || variantStatusCounts.pending > 0) {
        lines.push(
          `Schematic pinmap variants: ${variantStatusCounts.available} available, ${variantStatusCounts.pending} pending generation/config`,
        );
      }

      const missingCatalogLibraries = Array.isArray(contextData?.librariesMissingCatalog)
        ? contextData.librariesMissingCatalog
            .map((entry: any) => entry?.packageSlug || entry?.displayName)
            .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
        : [];
      if (missingCatalogLibraries.length > 0) {
        const displayed = missingCatalogLibraries.slice(0, 5);
        const remaining = missingCatalogLibraries.length - displayed.length;
        lines.push(
          `Schematic missing pinmap catalogs (${missingCatalogLibraries.length}): ${displayed.join(', ')}`
          + (remaining > 0 ? ` ... (+${remaining} more)` : ''),
        );
      }

      if (typeof contextData?.cppCode === 'string' && contextData.cppCode.trim().length > 0) {
        lines.push('Schematic generated C++ is available for hardware inference.');
      }
    }
  } catch {
    // Best-effort overlay only; keep shared context available even if schematic extras fail.
  }

  try {
    if (connectionGraph.hasAWSFile?.()) {
      const awsContent = connectionGraph.readAWSFile?.();
      const lineCount = typeof awsContent === 'string' && awsContent.length > 0
        ? awsContent.split(/\r?\n/).length
        : 0;
      lines.push(`Current AWS draft: present${lineCount > 0 ? ` (${lineCount} line(s))` : ''}`);
    } else {
      lines.push('Current AWS draft: none saved yet.');
    }
  } catch {
    // Best-effort overlay only.
  }

  try {
    const currentSchematic = connectionGraph.getConnectionGraph?.();
    if (currentSchematic?.components && currentSchematic?.connections) {
      lines.push(
        `Current schematic: ${currentSchematic.components.length} component(s), ${currentSchematic.connections.length} connection(s) saved`,
      );
    } else {
      lines.push('Current schematic: none saved yet.');
    }
  } catch {
    // Best-effort overlay only.
  }

  return lines;
}

export function createBlocklyContextSnapshotService(
  resolveHost: () => any = () => AilyHost.get(),
): BlocklyContextSnapshotService {
  return {
  async getSnapshot(_options?: BlocklyContextResolveOptions): Promise<BlocklyContextSnapshot> {
    const snapshot = await buildBlocklyContextSnapshot(resolveHost(), {
      version: contextSnapshotVersion,
      invalidatedBy: lastInvalidatedReason,
    });
    lastInvalidatedReason = undefined;
    return snapshot;
  },

  invalidate(_scopes: readonly string[], reason: string): void {
    contextSnapshotVersion += 1;
    lastInvalidatedReason = reason;
  },

  summarize(snapshot: BlocklyContextSnapshot, options?: BlocklyContextSummaryOptions): readonly string[] {
    return summarizeBlocklyContextSnapshot(snapshot, options);
  },

  async getSummary(options?: BlocklyContextSummaryRequest): Promise<readonly string[]> {
    const snapshot = await this.getSnapshot(options);
    const lines = [...this.summarize(snapshot, options?.summaryOptions)];
    if (isSchematicAgentIdentifier(options?.agentType)) {
      lines.push(...await getSchematicOverlaySummaryLines(resolveHost()));
    }
    return lines;
  },
  };
}

const service: BlocklyContextSnapshotService = createBlocklyContextSnapshotService();

export function getBlocklyContextSnapshotService(): BlocklyContextSnapshotService {
  return service;
}
