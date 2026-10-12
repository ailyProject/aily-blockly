import { assertSynchronousNativeCandidate } from './blockly-native-candidate-policy';
import { cloneNativeCandidateRequest, encodeNativeCandidateRequest, decodeNativeCandidateResult } from './blockly-native-transfer';
import { restoreAbsFailure } from '../../../integrations/blockly/abs/abs-diagnostics';
import nativeBuild from '../../../../../.generated/blockly-runtime/manifest.json';
import type { NativeCandidateOptions, NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';
import { assertNativeGenerationStable } from './blockly-native-generation-evidence';
import { createNativeRuntimeAssetLoader } from './blockly-native-runtime-asset';
import { NATIVE_CANDIDATE_PHASES, nativeCandidateBudget, nativeCandidateTimeout, type NativeCandidatePhase } from './blockly-native-progress';
import { nativeReplayEvent, describeNativeReplayEvent, type NativeReplayEvent } from './blockly-native-replay-diagnostics';

const loadNativeRuntimeAsset = createNativeRuntimeAssetLoader();

/** Disposable state isolation, not an adversarial JavaScript CPU/security sandbox. */
export async function evaluateNativeCandidate(request: NativeCandidateRequest, options: NativeCandidateOptions): Promise<NativeCandidateResult> {
  const detached = cloneNativeCandidateRequest(request);
  if (!detached.verify) return evaluateNativeCandidatePass(detached, options);
  const budget = nativeCandidateBudget(options.timeoutMs, 2);
  const deadline = Date.now() + budget.totalMs;
  const pass = (uiPhase: 'before-ui' | 'settled') => {
    options.signal?.throwIfAborted(); options.assertCurrent();
    const remaining = Math.min(budget.perPassMs, deadline - Date.now());
    if (remaining <= 0) throw nativeCandidateTimeout('realm', budget.totalMs);
    return evaluateNativeCandidatePass({ ...detached, verify: { ...detached.verify!, uiPhase } }, { ...options, timeoutMs: remaining });
  };
  // Library handlers may keep counters on the generator, in closures or globals.
  // Each pass replays into its own realm and generates once; no guessed reset list.
  const before = await pass('before-ui');
  if (!before.generationEvidence) throw new Error('Native generation evidence is missing.');
  let result = before;
  if (before.generationEvidence.deferredUi) {
    result = await pass('settled');
    if (!result.generationEvidence) throw new Error('Native generation evidence is missing.');
    assertNativeGenerationStable(before.generationEvidence, result.generationEvidence);
  }
  const { generationEvidence: _evidence, ...verified } = result;
  return verified;
}

async function evaluateNativeCandidatePass(request: NativeCandidateRequest, options: NativeCandidateOptions): Promise<NativeCandidateResult> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent(); };
  assertCurrent();
  // Snapshot before the first await: callers cannot change the request during asset loading.
  const detached = cloneNativeCandidateRequest(request);
  assertSynchronousNativeCandidate(detached);
  const { perPassMs: timeoutMs } = nativeCandidateBudget(options.timeoutMs, 1);
  const abort = new AbortController();
  let phase: NativeCandidatePhase = 'asset';
  let replayObservation: { detail: string; realmMs: number; receivedAt: number } | undefined;
  const outstandingRegistration = new Map<number, NativeReplayEvent>();
  const onAbort = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = nativeCandidateTimeout(phase, timeoutMs);
    if (phase === 'replay' && replayObservation) {
      error.message += ` Last observed: ${replayObservation.detail}; realm=${Math.round(replayObservation.realmMs)}ms, received ${Math.round(performance.now() - replayObservation.receivedAt)}ms ago. This is the last delivered observation, not proof of the current execution point.`;
      if (outstandingRegistration.size) error.message += ' Outstanding registration observations: '
        + [...outstandingRegistration.values()].slice(0, 4).map(event => describeNativeReplayEvent(event, detached.steps)).join('; ') + '.';
    }
    abort.abort(error);
  }, timeoutMs);
  let frame: HTMLIFrameElement | undefined, channel: MessageChannel | undefined;
  try {
    const source = await loadNativeRuntimeAsset(document.baseURI, nativeBuild.sha256, abort.signal);
    assertCurrent(); abort.signal.throwIfAborted();
    phase = 'realm';
    frame = document.createElement('iframe');
    // Keep real SVG geometry available; display:none makes native measurements invalid.
    frame.style.cssText = 'position:fixed;left:-11000px;top:0;width:1024px;height:768px;border:0;pointer-events:none;';
    frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('sandbox', 'allow-scripts'); // Deliberately no allow-same-origin or host preload.
    frame.setAttribute('data-blockly-native-candidate', 'true');
    const escapeScript = (text: string) => text.replace(/<\/script/gi, '<\\/script');
    frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;; connect-src &#39;none&#39;; frame-src &#39;none&#39;; form-action &#39;none&#39;; base-uri &#39;none&#39;">'
      + '<script type="module">' + escapeScript(source) + '</script>';
    channel = new MessageChannel();
    const result = await new Promise<NativeCandidateResult>((resolve, reject) => {
      const fail = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', fail, { once: true });
      channel!.port1.onmessage = event => {
        try {
          const reply = event.data;
          if (NATIVE_CANDIDATE_PHASES.includes(reply?.phase)) {
            phase = reply.phase;
            const replay = phase === 'replay' ? nativeReplayEvent(reply.replay) : undefined;
            if (replay && Number.isFinite(reply.elapsedMs) && reply.elapsedMs >= 0) {
              const detail = describeNativeReplayEvent(replay, detached.steps);
              if (detail) {
                replayObservation = { detail, realmMs: reply.elapsedMs, receivedAt: performance.now() };
                if ('id' in replay) {
                  if (replay.event === 'timer-end' || replay.event === 'timer-cancel') outstandingRegistration.delete(replay.id);
                  else if (outstandingRegistration.has(replay.id) || outstandingRegistration.size < 128) outstandingRegistration.set(replay.id, replay);
                }
              }
            }
            return;
          }
          assertCurrent(); abort.signal.throwIfAborted();
          if (!reply?.ok) throw restoreAbsFailure(reply?.error || 'Native candidate failed.');
          if (typeof reply.result?.state !== 'string' || !Array.isArray(reply.result.structures)) throw new Error('Invalid native candidate response.');
          resolve(decodeNativeCandidateResult(reply.result));
        } catch (error) { reject(error); }
      };
      channel!.port1.onmessageerror = () => reject(new Error('Native candidate response is not transferable.'));
      frame!.onload = () => {
        try { assertCurrent(); abort.signal.throwIfAborted(); frame!.contentWindow!.postMessage(encodeNativeCandidateRequest(detached), '*', [channel!.port2]); }
        catch (error) { reject(error); }
      };
      document.body.appendChild(frame!);
    });
    assertCurrent(); return result;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
    channel?.port1.close(); channel?.port2.close(); frame?.remove();
  }
}
