import { BlocklyEditError } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';
import type { AbsFailure } from './abs-diagnostics';

const availability = {
  BLOCKLY_WORKSPACE_TAINTED: {
    code: 'ABS_WORKSPACE_QUARANTINED', reason: 'workspace-quarantined',
    hint: 'The canvas is quarantined because native recovery could not be verified. Preserve the canvas, ABS candidate and library staging. Call project_recover(action="fork") to save an independent recovery project without generating code from or overwriting the source. Do not repeat inspect unchanged, force reload, delete locks or edit internal ABI/map files. The original guard and conversation/history stay intact. Address the returned target explicitly; if not activated, use app_open on that target. Read its fresh ABS and deliberately apply the retained change normally.',
  },
  BLOCKLY_EDIT_BUSY: {
    code: 'ABS_WORKSPACE_BUSY', reason: 'workspace-busy',
    hint: 'Wait for the current workspace operation to finish; use only read-only app_info or an existing operation receipt to observe it. Preserve the canvas, candidate and library staging. This is active ownership, not a quarantined canvas: do not fork to bypass it, replay writes, kill owners, delete locks or force reload. Continue only after observing completion and rechecking the current project.',
  },
  BLOCKLY_EDIT_STALE: {
    code: 'ABS_WORKSPACE_STALE', reason: 'workspace-stale',
    hint: 'The workspace activation or edit lease changed. Preserve the original candidate and its intent generation. Read app_info to identify the current project before reading its fresh ABS; do not reuse the obsolete lease or substitute a new generation on the old candidate. This does not prove quarantine or authorize fork, reload or unlock.',
  },
} as const;

/** Only our gate's error instance is authority for ownership/quarantine facts. */
export function trustedAbsWorkspaceFailure(error: unknown): AbsFailure | undefined {
  if (!(error instanceof BlocklyEditError)) return undefined;
  const state = availability[error.code];
  if (!state) return undefined;
  return { code: state.code, message: error.message.slice(0, 2000),
    diagnostic: { reason: state.reason, hint: state.hint } };
}

export function isReservedAbsWorkspaceCode(code: unknown): boolean {
  return typeof code === 'string' && Object.values(availability).some(state => state.code === code)
    || typeof code === 'string' && Object.prototype.hasOwnProperty.call(availability, code);
}
