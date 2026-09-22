import type * as Blockly from 'blockly';
import { normalizeArduinoGeneratedCode, type BlockCodeMapping } from '../components/blockly/generators/arduino/arduino';
import { runWithPreparedActiveProjectGenerator, type ProjectGenerator } from './blockly-generator-runtime.service';
import { captureArduinoGeneratedArtifacts } from './generated-code-artifacts';
import { canonicalJsonStringify } from '@domain/project/public-api';

export interface BlocklyCodeScope {
  readonly workspace: Blockly.Workspace;
  readonly generator: ProjectGenerator | null;
  readonly runtimeRevision: number;
  readonly dataSession: unknown;
  readonly pageId: string;
  readonly revision: number;
  readonly document: unknown;
}

/** No live Generator, mutable map or caller-owned artifact survives the synchronous phase. */
export interface PreparedBlocklyCode {
  readonly revision: number;
  readonly code: string | null;
  readonly artifacts: ReturnType<typeof captureArduinoGeneratedArtifacts>;
  readonly blockCodeMapText: string | null;
  readonly sourceWorkspace?: Readonly<{ documentText: string; revision: number; runtimeRevision: number; pageId: string }>;
  readonly error?: string;
}

type CodeStamp = Omit<BlocklyCodeScope, 'document'>;
const sameContext = (a: CodeStamp, b: CodeStamp) => a.workspace === b.workspace && a.generator === b.generator
  && a.runtimeRevision === b.runtimeRevision && a.dataSession === b.dataSession && a.pageId === b.pageId;
const sameRevision = (a: CodeStamp, b: CodeStamp) => sameContext(a, b) && a.revision === b.revision;

/** Owned by one editor. Preparation may register models; it never writes project files. */
export class BlocklyProjectCodePreparation {
  private entry?: { stamp: CodeStamp; result: PreparedBlocklyCode };

  clear(): void { this.entry = undefined; }

  async prepare(capture: () => BlocklyCodeScope, force = false): Promise<PreparedBlocklyCode | null> {
    const before = capture();
    if (!before.generator) return null;
    if (!force && this.entry && sameRevision(before, this.entry.stamp)) return this.entry.result;
    this.clear();
    const prepared = await runWithPreparedActiveProjectGenerator(before.workspace, generator => {
      if (!sameRevision(before, capture())) throw new Error('Project changed before code preparation.');
      let result: Omit<PreparedBlocklyCode, 'revision'>;
      try {
        const rawCode = generator.workspaceToCode(before.workspace);
        if (rawCode && typeof (rawCode as any).then === 'function') throw new Error('Blockly code generation must remain synchronous.');
        const code = normalizeArduinoGeneratedCode(rawCode);
        const map = (generator as { blockCodeMap?: Map<string, BlockCodeMapping> }).blockCodeMap;
        result = Object.freeze({ code, artifacts: captureArduinoGeneratedArtifacts(generator),
          blockCodeMapText: map ? JSON.stringify([...map]) : null });
      } catch (error) {
        // Saving editable Blockly does not require compilable code. Never publish partial outputs.
        result = Object.freeze({ code: null, artifacts: null, blockCodeMapText: null,
          error: error instanceof Error ? error.message : String(error) });
      }
      const { document, ...stamp } = capture();
      if (!sameContext(before, stamp)) throw new Error('Project runtime changed during code preparation.');
      return { stamp, result: Object.freeze({ ...result, revision: stamp.revision,
        ...(result.code !== null ? { sourceWorkspace: Object.freeze({ documentText: canonicalJsonStringify(document),
          revision: stamp.revision, runtimeRevision: stamp.runtimeRevision, pageId: stamp.pageId }) } : {}) }) };
    }, before.document);
    // Only the synchronous Generator phase may contribute model changes, not async continuations.
    if (!sameRevision(prepared.stamp, capture())) throw new Error('Project changed after code preparation.');
    this.entry = prepared;
    return prepared.result;
  }
}
