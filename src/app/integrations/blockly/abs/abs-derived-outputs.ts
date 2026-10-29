import type { GeneratedSourcePublicationReceipt } from '../../../editors/blockly-editor/services/generated-code-artifacts';

export interface AbsDerivedOutputs { published: boolean; code?: string; error?: string;
  sourceArchive?: GeneratedSourcePublicationReceipt['sourceArchive'] }
type PreparedCode = { code: string | null; error?: string };

/** Source publication and generated artifacts have independent outcomes. Reuse
 * this report for export/save and apply without undoing a committed source. */
export function describeAbsDerivedOutputs(prepared?: PreparedCode | null, publicationFailure?: { error: unknown }) {
  // Undefined means no generation was requested (e.g. a projection-only export).
  // Null or code:null means generation was attempted but produced no artifacts.
  const generationError = prepared === null || prepared?.code === null
    ? prepared?.error || 'The current generator did not produce code. Inspect the active library/runtime before compiling.'
    : prepared?.error;
  const warnings: string[] = [];
  if (generationError) warnings.push(`Current canvas code generation failed: ${generationError}`);
  const failure = publicationFailure?.error;
  const publicationError = publicationFailure
    ? failure instanceof Error ? failure.message : String(failure) : undefined;
  if (publicationError !== undefined) warnings.push(`Generation committed; derived outputs were not fully published: ${publicationError}`);
  const published = warnings.length === 0;
  const output: AbsDerivedOutputs | undefined = prepared === undefined && !publicationFailure ? undefined : { published, ...(!published ? {
    code: generationError ? 'PROJECT_CODE_GENERATION_FAILED'
      : typeof (failure as any)?.code === 'string' ? (failure as any).code : 'PROJECT_DERIVED_OUTPUT_PENDING',
    error: [generationError, publicationError].filter(value => value !== undefined).join('\n'),
  } : {}) };
  return { output, warnings };
}
