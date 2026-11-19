import { cloneBlocklyJson } from '@domain/project/project-document/public-api';
import { indexAbsAbi } from './abs-abi-index';
import { assertGenerationRequest } from './abs-generation-protocol';
import { AbsSyncError, isAbsBlockDisabled, type AbsAbiBlock, type AbsAbiWorkspace } from './abs-state';

export const ABS_MANUAL_DISABLED_REASON = 'MANUALLY_DISABLED';
/** JavaScript string length: UTF-16 code units after JSON decoding, not UTF-8 bytes. */
export const ABS_BLOCK_STATE_ID_MAX_LENGTH = 512;
export interface AbsBlockStateChange { blockId: string; disabled?: boolean; collapsed?: boolean }
export interface AbsBlockStateInspectRequest {
  version: 2; requestId: string; action: 'inspect'; blockIds?: string[]; blockTypes?: string[];
  limit?: number; offset?: number;
}
export interface AbsBlockStateUpdateRequest {
  version: 2; requestId: string; action: 'update'; expectedGeneration?: string; expectedCanvas?: string; changes: AbsBlockStateChange[];
}
export type AbsBlockStateRequest = AbsBlockStateInspectRequest | AbsBlockStateUpdateRequest;
export interface AbsBlockState {
  blockId: string; type: string; disabled: boolean; manualDisabled: boolean;
  disabledReasons: string[]; collapsed: boolean; editable: boolean;
}
export interface AbsBlockStatePlan {
  request: AbsBlockStateUpdateRequest;
  workspace: AbsAbiWorkspace;
  beforeStates: AbsBlockState[];
  states: AbsBlockState[];
  changed: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
const blockId = (value: unknown): value is string => {
  if (typeof value === 'string' && value.length > ABS_BLOCK_STATE_ID_MAX_LENGTH) {
    const hint = 'Keep the candidate and exact native IDs; do not rename/truncate IDs or edit ABI/map. Retry only supported exact inspected IDs; report the over-limit target as unsupported, not completed.';
    throw Object.assign(new AbsSyncError('ABS_BLOCK_STATE_ID_LIMIT',
      `Block ID length ${value.length} exceeds ${ABS_BLOCK_STATE_ID_MAX_LENGTH} UTF-16 code units after JSON decoding. No block states were changed. ${hint}`,
      undefined, [], { reason: 'block-id-length', hint,
        capacity: { phase: 'block-state-admission', resource: 'blockIdCodeUnits', actual: value.length, limit: ABS_BLOCK_STATE_ID_MAX_LENGTH } }),
      { publication: { status: 'NOT_COMMITTED' } });
  }
  return text(value, ABS_BLOCK_STATE_ID_MAX_LENGTH);
};
const invalid = (): never => { throw new AbsSyncError('ABS_REQUEST_INVALID', 'Block state requests accept inspect filters or an explicit update of existing block IDs, disabled and collapsed only.'); };
const list = (value: unknown, maximum: number, valid = (value: unknown) => text(value)) => value === undefined ||
  Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every(valid) && new Set(value).size === value.length;

/** This protocol does not authorize field, identity, model, protection or library-reason edits. */
export function readAbsBlockStateRequest(input: unknown): AbsBlockStateRequest {
  if (!record(input)) invalid();
  assertGenerationRequest(input);
  if (input['action'] === 'inspect') {
    if (Object.keys(input).some(key => !['version', 'requestId', 'action', 'blockIds', 'blockTypes', 'limit', 'offset'].includes(key))
      || !list(input['blockIds'], 256, blockId) || !list(input['blockTypes'], 16)
      || input['limit'] !== undefined && (!Number.isSafeInteger(input['limit']) || Number(input['limit']) < 1 || Number(input['limit']) > 256)
      || input['offset'] !== undefined && (!Number.isSafeInteger(input['offset']) || Number(input['offset']) < 0 || Number(input['offset']) > 100000)) invalid();
  } else if (input['action'] === 'update') {
    const changes = input['changes'];
    const authorities = ['expectedGeneration', 'expectedCanvas'].filter(key => Object.hasOwn(input, key));
    if (Object.keys(input).some(key => !['version', 'requestId', 'action', 'expectedGeneration', 'expectedCanvas', 'changes'].includes(key))
      || authorities.length !== 1 || typeof input[authorities[0]] !== 'string'
      || !/^[A-Za-z0-9_-]{1,96}$/.test(input[authorities[0]] as string)
      || !Array.isArray(changes) || !changes.length || changes.length > 256
      || changes.some(change => !record(change) || !blockId(change['blockId'])
        || Object.keys(change).some(key => !['blockId', 'disabled', 'collapsed'].includes(key))
        || !['disabled', 'collapsed'].some(key => Object.hasOwn(change, key))
        || ['disabled', 'collapsed'].some(key => Object.hasOwn(change, key) && typeof change[key] !== 'boolean'))
      || new Set(changes.map(change => change.blockId)).size !== changes.length) invalid();
  } else invalid();
  return cloneBlocklyJson(input) as unknown as AbsBlockStateRequest;
}

export function describeAbsBlockState(block: AbsAbiBlock): AbsBlockState {
  const reasons = block['disabledReasons'];
  if (reasons !== undefined && (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string'))) {
    throw new AbsSyncError('ABS_BLOCK_STATE_INVALID', 'Existing disabled reasons are not a valid native reason list.', undefined, [block.id]);
  }
  const disabledReasons = [...reasons as string[] ?? []];
  return { blockId: block.id, type: block.type, disabled: isAbsBlockDisabled(block),
    manualDisabled: disabledReasons.includes(ABS_MANUAL_DISABLED_REASON), disabledReasons,
    collapsed: block['collapsed'] === true, editable: block['editable'] !== false };
}

/** Pure whole-batch admission; no native callback or input object mutation. */
export function planAbsBlockStateChanges(workspace: AbsAbiWorkspace, input: AbsBlockStateUpdateRequest): AbsBlockStatePlan {
  const request = readAbsBlockStateRequest(input);
  if (request.action !== 'update') return invalid();
  const candidate = cloneBlocklyJson(workspace), blocks = indexAbsAbi(candidate);
  const beforeStates = request.changes.map(change => {
    const block = blocks.get(change.blockId);
    if (!block) throw new AbsSyncError('ABS_BLOCK_STATE_UNAVAILABLE', 'An existing block ID was not found. Inspect current block states; do not guess IDs.', undefined, [change.blockId]);
    const state = describeAbsBlockState(block);
    if (!state.editable) throw new AbsSyncError('ABS_STATE_EDIT_FORBIDDEN', 'A non-editable block cannot have its state changed.', undefined, [change.blockId]);
    return state;
  });
  let changed = false;
  const states = request.changes.map((change, index) => {
    const block = blocks.get(change.blockId)!, before = beforeStates[index];
    if (change.disabled !== undefined && change.disabled !== before.manualDisabled) {
      const reasons = change.disabled ? [...before.disabledReasons, ABS_MANUAL_DISABLED_REASON]
        : before.disabledReasons.filter(reason => reason !== ABS_MANUAL_DISABLED_REASON);
      if (reasons.length) block['disabledReasons'] = reasons; else delete block['disabledReasons'];
      changed = true;
    }
    if (change.collapsed !== undefined && change.collapsed !== before.collapsed) {
      if (change.collapsed) block['collapsed'] = true; else delete block['collapsed'];
      changed = true;
    }
    return describeAbsBlockState(block);
  });
  return { request, workspace: candidate, beforeStates, states, changed };
}
