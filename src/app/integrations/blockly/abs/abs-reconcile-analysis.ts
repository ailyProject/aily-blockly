import { absJson, createAbsNodeFingerprinter, indexAbsAbi, indexAbsSyntax, validateAbsProjection } from './abs-identity-map';
import { absIdentityPolicy } from './abs-identity-policy';
import { matchAbsIdentities } from './abs-identity-matcher';
import { parseAbsSyntax } from './abs-syntax';
import { absSyntaxOptions } from './abs-syntax-contracts';
import type { AbsProjection, AbsSyntaxNode } from './abs-state';
import type { AbsSourceEdits } from './abs-edit-provenance';

/** Transaction-local pure analysis. Nothing received from a callback or returned
 * as a draft is retained here. Each draft still owns a full mutable snapshot. */
export function createAbsReconcileAnalysis(input: AbsProjection, source: string) {
  return candidateAnalysis(baselineAnalysis(absJson(input)), source);
}

/** One bounded baseline, scoped by the host's captured runtime + current field
 * contracts. Exact bytes, not generation IDs/events, establish a cache hit.
 * No draft, callbacks, candidate AST or native execution result is retained. */
export function createAbsReconcileAnalysisFactory() {
  let retained: { text: string; scope: string; analysis: ReturnType<typeof baselineAnalysis> } | undefined;
  return (input: AbsProjection, source: string, scope: string) => {
    const text = absJson(input);
    if (retained?.text !== text || retained.scope !== scope) {
      retained = undefined;
      const analysis = baselineAnalysis(text);
      // Oversized projects still work, just without cross-candidate retention.
      if (2 * (text.length + scope.length) <= 8 * 1024 * 1024) retained = { text, scope, analysis };
      return candidateAnalysis(analysis, source);
    }
    return candidateAnalysis(retained.analysis, source);
  };
}

function baselineAnalysis(text: string) {
  const snapshot = (): AbsProjection => JSON.parse(text);
  const baseline = snapshot();
  let validation: Promise<void> | undefined;
  const validate = () => validation ??= validateAbsProjection(baseline).catch(error => {
    validation = undefined; throw error;
  });
  const prepare = () => {
    const original = parseAbsSyntax(baseline.abs, absSyntaxOptions(baseline.workspace, baseline.contracts));
    const bindings = new Map(baseline.map.nodes.map(binding => [binding.astPath, binding.blockId]));
    const originalIds = new Map(indexAbsSyntax(original).map(entry => [entry.node, bindings.get(entry.path)!]));
    const identity = absIdentityPolicy(baseline, originalIds, indexAbsAbi(baseline.workspace));
    return { original, originalIds, identity };
  };
  let prepared: ReturnType<typeof prepare> | undefined;
  return { snapshot, validate, fingerprint: createAbsNodeFingerprinter(),
    original: () => prepared ??= prepare(), source: baseline.abs };
}

function candidateAnalysis(baseline: ReturnType<typeof baselineAnalysis>, source: string) {
  // Cache only successful matching: private original nodes by candidate position.
  // Candidate AST references must never survive into another pass.
  let matched: { key: string; originals: (AbsSyntaxNode | null)[] } | undefined;
  return {
    snapshot: baseline.snapshot, validate: baseline.validate,
    async match(edited: AbsSyntaxNode[], sourceEdits?: AbsSourceEdits) {
      await baseline.validate();
      const { original, originalIds, identity } = baseline.original();
      const entries = indexAbsSyntax(edited);
      const key = absJson({ syntax: edited, sourceEdits: sourceEdits ?? null });
      let matches: ReadonlyMap<AbsSyntaxNode, AbsSyntaxNode>;
      if (matched?.key === key) {
        matches = new Map(entries.flatMap(({ node }, index) => matched!.originals[index] ? [[node, matched!.originals[index]!]] : []));
      } else {
        matches = await matchAbsIdentities(baseline.source, source, original, edited, sourceEdits, identity.requiresIdentity, baseline.fingerprint);
        matched = { key, originals: entries.map(({ node }) => matches.get(node) ?? null) };
      }
      return { matches, originalIds, identity };
    },
  };
}
