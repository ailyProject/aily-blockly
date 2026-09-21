import type { BlocklyGeneratorMode } from './blockly-generator-factory';
import type { AbsHostBoundCall, AbsNativeBinding, AbsNativeCreation } from '../../../integrations/blockly/abs/abs-native-binding';
import type { AbsAbiWorkspace, AbsProjectionContracts } from '../../../integrations/blockly/abs/abs-state';
import type { AilyDataRef } from '@domain/project/project-data/public-api';
import type { AbsNativeModelDeclaration } from '../../../integrations/blockly/abs/abs-native-model-declarations';
import type { NativeGenerationEvidence } from './blockly-native-generation-evidence';

/** Data-only boundary. No host objects, functions, paths-to-load or filesystem APIs. */
export type NativeReplayStep =
  | { kind: 'script'; source: string; label: string }
  | { kind: 'definitions'; definitions: Record<string, any>[]; libraryName?: string }
  | { kind: 'context'; mode?: BlocklyGeneratorMode; messages?: Record<string, string>; boardConfig?: unknown; packageJson?: unknown }
  | { kind: 'messages'; value: Record<string, string> }
  | { kind: 'i18n'; packageName: string; value: unknown };

export interface NativeCandidateBlock {
  id: string;
  type: string;
  extraState?: unknown;
  /** Explicit sequence, never JSON key sorting or private updateShape_* calls. */
  fields: Array<{ name: string; value: unknown }>;
}

export interface NativeCandidateRequest {
  /** Internal deterministic namespace, never an Agent model-creation permission. */
  modelRequestId?: string;
  steps: NativeReplayStep[];
  blocks: NativeCandidateBlock[];
  /** Internal binding. Mutually exclusive with explicit blocks; no new public Agent contract. */
  abs?: string;
  /** Assigned by the existing identity reconciler; source offsets are not persisted IDs. */
  identities?: Array<{ start: number; id: string }>;
  /** Exact transaction-local creation journal from the first isolated binding. */
  creations?: AbsNativeCreation[];
  /** Host-adapter calls participate in syntax only; the complete ABI is verified later. */
  hostCalls?: AbsHostBoundCall[];
  /** Exact host-owned model table, not permission for callbacks to create/rename models. */
  variables?: NativeVariableState[];
  /** Already resolved by the host store; no path, filesystem session or service bridge. */
  values?: Array<{ ref: AilyDataRef; value: unknown }>;
  /** Verify the final merged ABI and actual code generation before touching the host. */
  verify?: { state: AbsAbiWorkspace; contracts: AbsProjectionContracts;
    /** Internal pass selection; the host evaluator always owns both passes. */
    uiPhase?: 'before-ui' | 'settled';
    modelDeclarations?: Array<AbsNativeModelDeclaration & { ownerId: string }> };
}

export interface NativeVariableState { id: string; name: string; type?: string; [key: string]: unknown }

export interface NativeCandidateResult {
  /** Internal evidence, consumed and removed by the host evaluator. */
  generationEvidence?: NativeGenerationEvidence;
  /** Native evidence, not by itself a prepared/validated ABS commit capability. */
  state: Record<string, any>;
  structures: Array<{ id: string; type: string; rows: Array<{
    input: { name: string; connection?: { type: number } };
    fields: Array<{ name: string; SERIALIZABLE: boolean }>;
  }> }>;
  binding?: AbsNativeBinding;
}

export interface NativeCandidateOptions {
  assertCurrent: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
