import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import type { captureArduinoGeneratedArtifacts } from './generated-code-artifacts';
import type { GeneratorMacroEffect } from './generator-project-effects';

/** Evidence from exactly one generation in a disposable replay realm. */
export interface NativeGenerationEvidence {
  code: string;
  artifacts: ReturnType<typeof captureArduinoGeneratedArtifacts>;
  deferredUi: boolean;
  projectMacros?: readonly GeneratorMacroEffect[];
}

/** Compare independent first generations, not successive calls on mutable library state. */
export function assertNativeGenerationStable(before: NativeGenerationEvidence, after: NativeGenerationEvidence): void {
  const fail = (field: string, left: string, right: string): never => {
    const a = left.split('\n'), b = right.split('\n');
    let line = 0;
    while (line < Math.max(a.length, b.length) && a[line] === b[line]) line++;
    throw new AbsSyncError('ABS_GENERATION_UNSTABLE',
      `Independent native generation changed generated code or artifacts: ${field}, line ${line + 1}.`, undefined, [], {
        field, reason: 'independent-generation-mismatch',
        received: `before: ${(a[line] ?? '<missing>').slice(0, 100)}; after: ${(b[line] ?? '<missing>').slice(0, 100)}`,
        hint: 'Library generation is not stable across isolated replay/UI settlement. Inspect this difference; do not change ABS identities, remove protected roots or create missing models to retry.',
      });
  };
  if (before.code !== after.code) fail('code', before.code, after.code);
  if (absJson(before.projectMacros ?? []) !== absJson(after.projectMacros ?? [])) {
    fail('project-macros', absJson(before.projectMacros ?? []), absJson(after.projectMacros ?? []));
  }
  if (absJson(before.artifacts) !== absJson(after.artifacts)) {
    const left = before.artifacts ?? [], right = after.artifacts ?? [];
    const names = new Set([...left, ...right].map(item => item.fileName));
    for (const name of names) {
      const a = left.find(item => item.fileName === name), b = right.find(item => item.fileName === name);
      if (absJson(a ?? null) !== absJson(b ?? null)) {
        if (a && b && a.content === b.content) fail(`artifact-metadata:${name}`, absJson(a), absJson(b));
        fail(`artifact:${name}`, a?.content ?? '<missing>', b?.content ?? '<missing>');
      }
    }
    fail('artifact-manifest', absJson(before.artifacts), absJson(after.artifacts));
  }
}
