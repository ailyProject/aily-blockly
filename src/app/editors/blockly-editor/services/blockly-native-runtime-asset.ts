import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import type { AbsResourceDiagnostic } from '../../../integrations/blockly/abs/abs-diagnostics';

/** Loading the host's build artifact is separate from parsing/running a candidate.
 * No fallback, retry, project mutation or third-party library request belongs here. */
export async function loadNativeRuntimeAsset(baseURI: string, expectedHash: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let url: URL;
  try { url = new URL('blockly/runtime/native-candidate.js', baseURI); }
  catch { throw new AbsSyncError('ABS_NATIVE_ASSET_UNAVAILABLE', 'The host renderer has no valid native runtime asset URL.', undefined, [], {
    reason: 'invalid-base-url', hint: 'Repair the Blockly renderer URL/build. Retain the ABS candidate; project recovery, export and changing ABS transport cannot fix asset loading.',
  }); }
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  const resource: AbsResourceDiagnostic = { url: url.href, expectedHash };
  const fail = (reason: string): never => { throw new AbsSyncError('ABS_NATIVE_ASSET_UNAVAILABLE',
    `Cannot load the host native Blockly runtime (${reason}).`, undefined, [], { reason, resource,
      hint: 'Check this URL in host DevTools; fix the asset service, then rebuild/reload Blockly. Retain ABS; do not retry unchanged apply/validate, switch transport, export or recover the project.',
    }); };
  if (!['http:', 'https:'].includes(url.protocol)) fail('unsupported-protocol');
  let response: Response;
  try { response = await fetch(url, { signal, credentials: 'omit', cache: 'no-cache' }); }
  catch { signal.throwIfAborted(); return fail('fetch-failed'); }
  signal.throwIfAborted();
  resource.status = response.status;
  if (!response.ok) fail('http-status');
  let bytes: ArrayBuffer;
  try { bytes = await response.arrayBuffer(); }
  catch { signal.throwIfAborted(); return fail('body-read-failed'); }
  signal.throwIfAborted();
  let digest: ArrayBuffer;
  try { digest = await crypto.subtle.digest('SHA-256', bytes); }
  catch { signal.throwIfAborted(); return fail('integrity-check-unavailable'); }
  signal.throwIfAborted();
  resource.actualHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (resource.actualHash !== expectedHash) throw new AbsSyncError('ABS_NATIVE_ASSET_MISMATCH',
    'Native candidate asset does not match the host build.', undefined, [], { reason: 'integrity-mismatch', resource,
      hint: 'Rebuild and reload the Blockly renderer and native asset from the same source revision. Retain ABS; do not retry unchanged apply/validate, switch transport, export or recover the project.',
    });
  return new TextDecoder().decode(bytes);
}
