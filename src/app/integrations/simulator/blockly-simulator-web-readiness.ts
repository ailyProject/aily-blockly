import type { BlocklySimulatorProjectScope } from './blockly-simulator-web-publication';
import type { SimulatorWebSelectedProjectContext } from './simulator-web-product.source';

interface BlocklyGeneratedCodeReadiness {
  waitForReusableGeneratedCode(options: { signal: AbortSignal; timeoutMs: number }): Promise<string>;
}

/** Wait for the original generator before capturing its source-content bookend.
 * Project generation belongs to the original scope; this helper never hashes
 * source, changes an Artifact, or turns pending content into an identity. */
export async function readReadyBlocklySimulatorContext(
  scope: Pick<BlocklySimulatorProjectScope, 'projectIdentity' | 'callbacks' | 'requireCurrent'>,
  generatedCode: BlocklyGeneratedCodeReadiness,
  signal: AbortSignal,
): Promise<SimulatorWebSelectedProjectContext> {
  const requireCurrent = () => { signal.throwIfAborted(); scope.requireCurrent(); };
  requireCurrent();
  await generatedCode.waitForReusableGeneratedCode({ signal, timeoutMs: 30_000 });
  requireCurrent();
  const context = await scope.callbacks.readContext({ projectIdentity: scope.projectIdentity }, signal) as SimulatorWebSelectedProjectContext;
  requireCurrent();
  // An edit can invalidate generation while the Authority hashes its snapshot.
  // Leave its original scope/Artifact validation intact instead of caching null.
  if (context.workspaceSourceSha256 === null) {
    throw Object.assign(new Error('The current Blockly project source is not ready.'), { code: 'source-not-ready' });
  }
  return context;
}
