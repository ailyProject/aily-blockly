import type { AbsGenerationEvidence } from './abs-generation-protocol';

/** One wire representation for the output already selected by its publisher.
 * This function does not observe, export, commit or grant an input capability. */
export function absProjectionReceipt(
  requestId: string, output: AbsGenerationEvidence,
  options: { persisted: boolean; inputAbiHash?: string | null; rebind?: string; synchronized?: boolean },
) {
  return { version: 2 as const, requestId, base: output.binding, output, persisted: options.persisted,
    ...(options.rebind ? { rebind: options.rebind } : {}), inputAbiHash: options.inputAbiHash,
    ...(options.synchronized ? { synchronized: true } : {}),
    validation: { ok: true, scope: 'generation-projection' } };
}
