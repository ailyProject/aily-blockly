import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import type { AbsNativeRequestPayload } from '../../../integrations/blockly/abs/abs-diagnostics';
import type { NativeCandidateRequest } from './blockly-native-candidate-protocol';
import { NATIVE_CANDIDATE_LIMITS } from './blockly-native-budget';
import { nativeRequestFootprint, type NativeRequestFootprint } from './blockly-native-request-footprint';

const size = (value: unknown): number => value === undefined ? 0 : nativeRequestFootprint(value).units;

/** Failure-only bounded observations. Never return source, resource contents or paths. */
export function nativeRequestPayload(request: NativeCandidateRequest, footprint: NativeRequestFootprint): AbsNativeRequestPayload {
  // Components have independent backing-store deduplication. The request-wide
  // accounting remains authoritative when aliases cross component boundaries.
  const components = {
    replay: size(request.steps), graphics: size(request.graphics), abs: size(request.abs), blocks: size(request.blocks),
    bindings: size(request.identities) + size(request.creations) + size(request.hostCalls),
    models: size(request.variables) + size(request.retainedModelCalls) + size(request.retainedModelIds),
    resources: size(request.values), verification: size(request.verify), envelope: 0,
  };
  components.envelope = Math.max(0, footprint.units - Object.values(components).reduce((sum, value) => sum + value, 0));
  const replay = { steps: request.steps.length, script: 0, definitions: 0, context: 0, messages: 0, i18n: 0, other: 0 };
  for (const step of request.steps) {
    const kind = step.kind;
    if (kind === 'script' || kind === 'definitions' || kind === 'context' || kind === 'messages' || kind === 'i18n') replay[kind] += size(step);
    else replay.other += size(step);
  }
  return { ...footprint, components, replay };
}

/** Retain the existing operational limit; do not equate host replay with user block count. */
export function assertNativeRequestCapacity(request: NativeCandidateRequest): void {
  const footprint = nativeRequestFootprint(request), limit = NATIVE_CANDIDATE_LIMITS.requestCharacters;
  if (footprint.units <= limit) return;
  const requestPayload = nativeRequestPayload(request, footprint), { components } = requestPayload;
  const runtime = components.replay + components.graphics;
  const reason = runtime > footprint.units / 2 ? 'native-runtime-capacity'
    : components.resources > footprint.units / 2 ? 'native-resource-capacity' : 'native-capacity';
  const hint = reason === 'native-runtime-capacity'
    ? 'Host runtime replay dominates this request, not ABS block count. Preserve the current canvas, saved project and unapplied ABS; do not delete code, extract unrelated logic or retry the same request. Follow only a verified preserving runtime recovery.'
    : reason === 'native-resource-capacity'
      ? 'Prepared resource data dominates this request. Preserve every resource and the unapplied ABS; do not delete data, split apply or retry unchanged. Inspect the bounded payload profile before choosing a supported recovery.'
      : 'Keep the original project and ABS draft. Use the payload profile to identify the actual capacity consumer. Extract cohesive logic only if workspace data dominates; preserve behavior and do not split apply or retry unchanged.';
  throw new AbsSyncError('ABS_LIMIT', `Native candidate requestCharacters count ${footprint.units} exceeds limit ${limit} (request; text characters + backing bytes).`,
    undefined, [], { reason, capacity: { phase: 'request', resource: 'requestCharacters', actual: footprint.units, limit }, requestPayload, hint });
}
