import { cloneBlocklyJson, canonicalProjectJsonStringify } from '@domain/project/project-document/public-api';
import type { NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';

type Verification = NonNullable<NativeCandidateRequest['verify']>;
export type NativeCandidateWireRequest = Omit<NativeCandidateRequest, 'verify'> & {
  verify?: Omit<Verification, 'state'> & { state: string };
};
export type NativeCandidateWireResult = Omit<NativeCandidateResult, 'state' | 'binding'> & {
  state: string; binding?: string;
};

/** Binary prepared resources retain structured-clone semantics. Only the deep
 * JSON block graph uses the stack-safe project codec, including across ports. */
export function cloneNativeCandidateRequest(request: NativeCandidateRequest): NativeCandidateRequest {
  const { verify, ...metadata } = request;
  const detached: NativeCandidateRequest = structuredClone(metadata);
  if (verify) {
    const { state, ...verification } = verify;
    detached.verify = { ...structuredClone(verification), state: cloneBlocklyJson(state) };
  }
  return detached;
}

export function encodeNativeCandidateRequest(request: NativeCandidateRequest): NativeCandidateWireRequest {
  const { verify, ...metadata } = request;
  return { ...metadata, ...(verify ? { verify: { ...verify, state: canonicalProjectJsonStringify(verify.state) } } : {}) };
}

export function decodeNativeCandidateRequest(request: NativeCandidateWireRequest): NativeCandidateRequest {
  const { verify, ...metadata } = request;
  return { ...metadata, ...(verify ? { verify: { ...verify, state: JSON.parse(verify.state) } } : {}) };
}

export function encodeNativeCandidateResult(result: NativeCandidateResult): NativeCandidateWireResult {
  const { state, binding, ...metadata } = result;
  return { ...metadata, state: canonicalProjectJsonStringify(state),
    ...(binding ? { binding: canonicalProjectJsonStringify(binding) } : {}) };
}

export function decodeNativeCandidateResult(result: NativeCandidateWireResult): NativeCandidateResult {
  const { state, binding, ...metadata } = result;
  return { ...metadata, state: JSON.parse(state), ...(binding ? { binding: JSON.parse(binding) } : {}) };
}
