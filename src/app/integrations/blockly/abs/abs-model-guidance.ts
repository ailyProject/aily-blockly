/** Authoring recovery describes declarations, never the host's model allocation API. */
export function availableAbsModelName(name: string, names: Iterable<string>): string {
  const occupied = new Set([...names].map(value => value.toLowerCase()));
  const base = name.replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 230) || 'object';
  const prefix = /^[\p{L}_]/u.test(base) ? base : '_' + base;
  for (let index = 2; ; index++) if (!occupied.has(`${prefix}_${index}`.toLowerCase())) return `${prefix}_${index}`;
}

export function absModelRecovery(reason: 'missing' | 'type-conflict' | 'identity-conflict' | 'ambiguous'): string {
  switch (reason) {
    case 'missing':
      return 'Read the block library README; include its documented declaration/initializer ABS call and references in one candidate. Check name, scope and enabled state. If registration still fails, report the initializer/runtime defect; never fabricate models.';
    case 'type-conflict':
      return 'This name belongs to an existing model of another type. Keep that model; use a distinct name consistently in the documented initializer and references for the new object. Do not retype/delete models or reset the ABS baseline.';
    case 'ambiguous':
      return 'Several models match this reference. Preserve existing identities; use the documented declaration and an unambiguous object name. Do not guess an ID, create another model or reset the ABS baseline.';
    case 'identity-conflict':
      return 'The declaration conflicts with an existing model name or identity. Preserve the existing model; use a distinct name for a new object. If the unchanged documented initializer reproduces this, report a library/runtime defect.';
  }
}
