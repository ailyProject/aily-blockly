import type { AbsFieldDefinition, AbsFieldToken } from './abs-field-values';
import type { AbsProcedureStateContract } from './abs-procedures';
import type { AbsArgumentDefinition } from './abs-syntax';
import type { AbsDiagnostic } from './abs-diagnostics';

export const ABS_SCHEMA_HEADER = '# ABS Schema: 2';
// Projection algorithm identifier, independent of the production wire protocol version.
export const ABS_PROJECTION_VERSION = 'abs-v2.preview.5';

export interface AbsSourceRange { start: number; end: number }
export interface AbsSyntaxNode extends AbsSourceRange {
  type: string;
  fields: Record<string, AbsFieldToken>;
  /** UTF-16 literal boundaries in this source only; not persisted in the identity map. */
  fieldRanges: Record<string, AbsSourceRange>;
  inputs: Record<string, AbsSyntaxNode | null>;
  next?: AbsSyntaxNode;
  extraState?: unknown;
  extraRange?: AbsSourceRange;
  disabled: boolean;
}

/** Opaque serialized attributes remain in ABI, not the syntax tree or map. */
export interface AbsAbiBlock {
  type: string;
  id: string;
  fields?: Record<string, unknown>;
  inputs?: Record<string, { block?: AbsAbiBlock; shadow?: AbsAbiBlock; [key: string]: unknown }>;
  next?: { block: AbsAbiBlock; [key: string]: unknown };
  extraState?: unknown;
  [key: string]: unknown;
}
export interface AbsAbiWorkspace {
  blocks: { blocks: AbsAbiBlock[]; [key: string]: unknown };
  [key: string]: unknown;
}

export interface AbsNodeBinding extends AbsSourceRange {
  nodeKey: string;
  blockId: string;
  blockType: string;
  astPath: string;
  fingerprint: string;
}

export interface AbsIdentityMap {
  schemaVersion: 1;
  absSchemaVersion: 2;
  projectionVersion: string;
  generation: string;
  scope: { projectKey: string; pageId: string };
  baselineRef: string;
  baseAbiHash: string;
  pageAbiHash: string;
  savedAbiHash: string | null;
  baseAbsHash: string;
  nodes: AbsNodeBinding[];
  symbols: AbsSymbolBinding[];
  contractsHash: string;
}

export interface AbsSymbolBinding {
  nodeKey: string;
  astPath: string;
  kind: 'variable' | 'procedure';
  modelId: string;
}

/** Only schema locations are stored here. Model names/state have one source: the ABI. */
export interface AbsSymbolTable {
  kind: 'variable' | 'procedure';
  source: 'workspace' | 'document';
  path: string;
  idPath: string;
  namePath: string;
  typePath?: string;
}
export interface AbsProjectionContracts {
  fields: Record<string, Record<string, AbsFieldDefinition>>;
  /** Proven argument order per existing ID; absent/ambiguous types stay named-only. */
  syntax?: Record<string, readonly AbsArgumentDefinition[]>;
  /** Proven dropdown selectors for instance-specific syntax, not instructions to execute. */
  selectors?: Record<string, readonly string[]>;
  /** Additional host-owned model tables; Blockly variables use /variables by default. */
  symbolTables?: AbsSymbolTable[];
  procedures?: Record<string, AbsProcedureStateContract>;
}

export interface AbsProjection {
  /** Host-provided full project snapshot (may contain multiple pages/shared models). */
  document: unknown;
  /** Composed target workspace; the host owns page composition/extraction. */
  workspace: AbsAbiWorkspace;
  abs: string;
  map: AbsIdentityMap;
  /** Immutable generation-local contracts, not a process-global runtime cache. */
  contracts: AbsProjectionContracts;
}

export class AbsSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly range?: AbsSourceRange,
    readonly blockIds: readonly string[] = [],
    readonly diagnostic?: AbsDiagnostic,
  ) {
    super(message);
    this.name = 'AbsSyncError';
  }
}

export function isAbsBlockDisabled(block: AbsAbiBlock): boolean {
  return block['disabled'] === true || block['enabled'] === false
    || (Array.isArray(block['disabledReasons']) && block['disabledReasons'].length > 0);
}

export function absInputPath(parent: string, name: string): string {
  return `${parent}/inputs/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

export function absFieldPath(parent: string, name: string): string {
  return `${parent}/fields/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

export function getAbsFieldDefinition(contracts: AbsProjectionContracts, blockId: string, name: string): AbsFieldDefinition | undefined {
  const fields = Object.hasOwn(contracts.fields, blockId) ? contracts.fields[blockId] : undefined;
  return fields && Object.hasOwn(fields, name) ? fields[name] : undefined;
}
