import { AbsReadbackOptions, assertAbsReadback } from './abs-readback';
import { AbsAbiWorkspace } from './abs-state';

/** Transitional entry: explicit requests and graph ownership, allowing library defaults. */
export function assertAbsRequestedState(
  expected: AbsAbiWorkspace, actual: AbsAbiWorkspace, fieldDefinition: AbsReadbackOptions['fieldDefinition'],
): void {
  assertAbsReadback(expected, actual, { mode: 'requested', fieldDefinition });
}
