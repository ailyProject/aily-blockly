import { createProjectDataMarker, materializeGenericProjectDataValues, type AilyDataRef } from '@domain/project/public-api';
import { sameAbsProgram } from './abs-program-state';

export interface AbsSaveComparisonPort {
  normalize(value: unknown): unknown;
  resolve<T>(ref: AilyDataRef): Promise<T>;
  assertCurrent(): void;
}

/** Compare persistence representations, never compact ABS state in place of the
 * saved ABI recipe. Only the existing, explicit layout exclusions are ignored;
 * identities, order, ownership, hidden state and unknown serializers stay exact. */
export async function sameAbsSavedProgram(a: unknown, b: unknown, port: AbsSaveComparisonPort): Promise<boolean> {
  port.assertCurrent();
  const normalize = (value: unknown) => {
    // Native normalization also repairs malformed page/schema discriminators.
    // It is a compatibility adapter for an unversioned legacy workspace only,
    // not authority to erase a competing document's invalid/unknown envelope.
    const legacy = value && typeof value === 'object' && !Array.isArray(value)
      && !Object.hasOwn(value, 'pages') && !Object.hasOwn(value, 'schemaVersion');
    const document = legacy ? port.normalize(value) : value;
    // The normal import schema adds this exact envelope to unmarked projects.
    // Do not strip or replace existing markers: unknown members and unsupported
    // versions remain significant, just like all other project extensions.
    return document && typeof document === 'object' && !Array.isArray(document)
      && !Object.hasOwn(document, '$ailyProjectData')
      ? { ...document, $ailyProjectData: createProjectDataMarker() } : document;
  };
  const left = normalize(a), right = normalize(b);
  port.assertCurrent();
  if (sameAbsProgram(left, right)) return true;
  const materialize = (value: unknown) => materializeGenericProjectDataValues(value, {
    resolve: async <T>(ref: AilyDataRef) => {
      port.assertCurrent();
      const result = await port.resolve<T>(ref);
      port.assertCurrent();
      return result;
    },
  });
  const materializedLeft = await materialize(left);
  const materializedRight = await materialize(right);
  port.assertCurrent();
  return sameAbsProgram(materializedLeft, materializedRight);
}

/** B is the verified saved-ABI recipe, D the exact disk observation and W the
 * prepared current canvas. A missing historical recipe cannot grant authority.
 * This is semantic admission only: the caller must retain raw disk/pointer CAS. */
export async function canSaveAbsWorkspace(
  savedAbi: string | null, diskAbi: string | null, currentAbi: string, port: AbsSaveComparisonPort,
): Promise<boolean> {
  if (diskAbi === null) return false;
  const disk = JSON.parse(diskAbi);
  if (savedAbi !== null && await sameAbsSavedProgram(JSON.parse(savedAbi), disk, port)) return true;
  return sameAbsSavedProgram(JSON.parse(currentAbi), disk, port);
}
