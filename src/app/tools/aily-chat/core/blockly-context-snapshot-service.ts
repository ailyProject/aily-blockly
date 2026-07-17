import { AilyHost } from './host';
import { isSchematicAgentIdentifier } from './agent-identifiers';
import {
  buildBlocklyContextSnapshot,
  summarizeBlocklyContextSnapshot,
  type BlocklyContextSnapshot,
  type BlocklyContextSummaryOptions,
} from './blockly-environment-context';

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

function getVariantStatusCounts(catalogLike: any): { available: number; pending: number } {
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

  countVariants(catalogLike);

  return { available, pending };
}

function normalizePath(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
}

function joinHostPath(host: any, ...parts: string[]): string {
  const pathApi = host?.path ?? (typeof window !== 'undefined' ? (window as any).path : undefined);
  if (pathApi && typeof pathApi.join === 'function') {
    return pathApi.join(...parts);
  }
  return parts.join('/').replace(/\/+/g, '/');
}

function resolveSchematicProjectPath(host: any, snapshot: BlocklyContextSnapshot): string {
  const fs = host?.fs;
  const candidates = [
    snapshot.projectInfo?.projectPath,
    host?.project?.currentProjectPath,
    host?.project?.projectRootPath,
  ]
    .map(normalizePath)
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  if (!fs?.existsSync) {
    return candidates[0] ?? '';
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(joinHostPath(host, candidate, 'package.json'))) {
        return candidate;
      }
    } catch {
      // Keep trying the next candidate.
    }
  }

  return candidates[0] ?? '';
}

function formatCatalogVariantSuffix(catalog: any): string {
  const counts = getVariantStatusCounts(catalog);
  const total = counts.available + counts.pending;
  return total > 0 ? `(${total} variants)` : '';
}

async function getSchematicOverlaySummaryLines(host: any, snapshot: BlocklyContextSnapshot): Promise<readonly string[]> {
  const lines: string[] = [];
  const connectionGraph = host.connectionGraph;
  const project = host.project;
  const fs = host?.fs;

  if (!connectionGraph || !project) {
    return lines;
  }

  try {
    const projectPath = resolveSchematicProjectPath(host, snapshot);
    if (projectPath && fs?.existsSync?.(joinHostPath(host, projectPath, 'node_modules'))) {
      const packagesBasePath = joinHostPath(host, projectPath, 'node_modules');
      const allLibraries = typeof connectionGraph.scanAllLibraries === 'function'
        ? connectionGraph.scanAllLibraries(packagesBasePath)
        : [];

      const hardwareCatalogLibraries: any[] = [];
      const softwareCatalogLibraries: any[] = [];
      const missingCatalogLibraries: any[] = [];
      let availableVariants = 0;
      let pendingVariants = 0;

      try {
        const boardPackagePath = typeof project.getBoardPackagePath === 'function'
          ? await project.getBoardPackagePath()
          : '';
        const boardPackageSlug = normalizePath(boardPackagePath).split('/').pop() || normalizePath(project.currentBoard) || 'current board';
        let boardLabel = normalizePath(project.currentBoard) || boardPackageSlug || 'current board';
        let boardStatus = 'missing';

        if (boardPackagePath) {
          const boardCatalog = typeof connectionGraph.readPinmapCatalog === 'function'
            ? connectionGraph.readPinmapCatalog(boardPackagePath)
            : null;
          if (boardCatalog) {
            boardLabel = boardCatalog.displayName || boardPackageSlug || boardLabel;
            boardStatus = 'available';
            const counts = getVariantStatusCounts(boardCatalog);
            availableVariants += counts.available;
            pendingVariants += counts.pending;
          } else {
            const boardConfig = typeof connectionGraph.getBoardConfig === 'function'
              ? connectionGraph.getBoardConfig(boardPackagePath)
              : null;
            if (boardConfig) {
              boardLabel = boardConfig.name || boardPackageSlug || boardLabel;
              boardStatus = 'legacy_pinmap';
            }
          }
        }

        lines.push(`Schematic board pinmap: ${boardLabel} (${boardStatus})`);
      } catch {
        // Best-effort overlay only.
      }

      for (const library of allLibraries) {
        if (library?.hasPinmapCatalog && library.catalog) {
          if (library.catalog.type === 'software') {
            softwareCatalogLibraries.push(library);
            continue;
          }

          hardwareCatalogLibraries.push(library);
          const counts = getVariantStatusCounts(library.catalog);
          availableVariants += counts.available;
          pendingVariants += counts.pending;
          continue;
        }

        missingCatalogLibraries.push(library);
      }

      if (hardwareCatalogLibraries.length > 0 || softwareCatalogLibraries.length > 0 || missingCatalogLibraries.length > 0) {
        lines.push(
          `Pinmap catalog inventory: ${hardwareCatalogLibraries.length} hardware catalog(s), `
          + `${softwareCatalogLibraries.length} software card(s), `
          + `${missingCatalogLibraries.length} missing catalog(s)`,
        );
      }

      const catalogEntries = [
        ...hardwareCatalogLibraries.map(library => `${library.packageSlug}=available${formatCatalogVariantSuffix(library.catalog)}`),
        ...softwareCatalogLibraries.map(library => `${library.packageSlug}=software`),
        ...missingCatalogLibraries.map(library => `${library.packageSlug}=missing_catalog`),
      ];
      if (catalogEntries.length > 0) {
        const displayed = catalogEntries.slice(0, 10);
        const remaining = catalogEntries.length - displayed.length;
        lines.push(
          `Library pinmap catalogs (${displayed.length}/${catalogEntries.length} shown): ${displayed.join('; ')}`
          + (remaining > 0 ? ` ... (+${remaining} more)` : ''),
        );
      }

      if (availableVariants > 0 || pendingVariants > 0) {
        lines.push(`Schematic pinmap variants: ${availableVariants} available, ${pendingVariants} pending generation/config`);
      }

      if (missingCatalogLibraries.length > 0) {
        const displayed = missingCatalogLibraries
          .map(library => library.packageSlug || library.displayName)
          .filter((value: unknown): value is string => typeof value === 'string' && value.length > 0)
          .slice(0, 5);
        const remaining = missingCatalogLibraries.length - displayed.length;
        lines.push(
          `Schematic missing pinmap catalogs (${missingCatalogLibraries.length}): ${displayed.join(', ')}`
          + (remaining > 0 ? ` ... (+${remaining} more)` : ''),
        );
      }
    }
  } catch {
    // Best-effort overlay only; keep shared context available even if schematic extras fail.
  }

  try {
    const generatedCode = host.editor?.getGeneratedCode?.();
    if (typeof generatedCode === 'string' && generatedCode.trim().length > 0) {
      lines.push('Schematic generated C++ is available for hardware inference.');
    }
  } catch {
    // Best-effort overlay only.
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
    const shouldUseSchematicSummary = isSchematicAgentIdentifier(options?.agentType);
    const summaryOptions = shouldUseSchematicSummary
      ? {
          ...options?.summaryOptions,
          includeReadmeReferences: false,
          includeLibrariesWithoutReadme: false,
        }
      : options?.summaryOptions;
    const lines = [...this.summarize(snapshot, summaryOptions)];
    if (shouldUseSchematicSummary) {
      lines.push(...await getSchematicOverlaySummaryLines(resolveHost(), snapshot));
    }
    return lines;
  },
  };
}

const service: BlocklyContextSnapshotService = createBlocklyContextSnapshotService();

export function getBlocklyContextSnapshotService(): BlocklyContextSnapshotService {
  return service;
}
