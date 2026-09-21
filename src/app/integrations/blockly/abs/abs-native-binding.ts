import type { AbsAbiBlock, AbsSyntaxNode } from './abs-state';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import type { AbsArgumentDefinition } from './abs-syntax-binding';
import type { AbsNativeModelDeclaration } from './abs-native-model-declarations';

/** A captured pure host adapter owns this call; native discovery is not its proof. */
export interface AbsHostBoundCall {
  start: number;
  type: string;
  argumentOrder?: readonly AbsArgumentDefinition[];
  extraState?: unknown;
}

/** Host-only, source-instance evidence. Never an Agent payload or a type-wide permission. */
export interface AbsNativeBlock {
  id: string;
  type: string;
  shape: AbsBlockShapeContract;
  /** Native serializer defaults; topology and existing metadata remain reconciler-owned. */
  seed: AbsAbiBlock;
}

export interface AbsNativeInstance extends AbsNativeBlock { start: number }

/** Ephemeral replay identity, allocated before init. Never written to ABS/map. */
export interface AbsNativeCreation { owner: number; ordinal: number; type: string; id: string }

/** A newly created owner may adopt an omitted input or a proven covered fallback. */
export interface AbsNativeDefault {
  owner: number;
  input: string;
  state: NonNullable<AbsAbiBlock['inputs']>[string];
  instances: AbsNativeBlock[];
  /** An explicit real child covers this captured native fallback. */
  fallback?: true;
}

export interface AbsNativeBinding {
  modelDeclarations?: AbsNativeModelDeclaration[];
  source: string;
  syntax: AbsSyntaxNode[];
  instances: AbsNativeInstance[];
  hostCalls?: AbsHostBoundCall[];
  creations?: AbsNativeCreation[];
  defaults?: AbsNativeDefault[];
}
