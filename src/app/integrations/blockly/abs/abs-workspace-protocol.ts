import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { openAbsHostStorage } from './abs-host-storage';
import { absProtocolReply } from './abs-live-protocol';
import { generationEvidence } from './abs-generation-protocol';
import { ABS_WORKSPACE_MODES, readAbsWorkspaceMode } from './abs-workspace-mode';
import { serializeAbsFailure } from './abs-diagnostics';
import { AbsSyncError } from './abs-state';
import { sameAbsProjectDirectory } from './abs-project-path';

/** Read-only negotiation. A marker selects an engine but cannot manufacture
 * accepted-source readiness or authority over a different physical project. */
export async function absWorkspaceProtocol(project: string, input: Record<string, unknown>,
  assertCurrent: () => void, supplied?: AbsSyncStoragePort) {
  const reply = absProtocolReply(project, input);
  if (!reply.ok) return reply;
  try {
    const port = supplied ?? await openAbsHostStorage(project, assertCurrent);
    const workspaceMode = await readAbsWorkspaceMode(port);
    assertCurrent();
    const protocol = { ...reply.protocol, workspaceMode, supportedWorkspaceModes: [...ABS_WORKSPACE_MODES] };
    if (workspaceMode === 'overlay-v1') return { ...reply, project: port.attachment?.root ?? project, protocol };
    if (!port.attachment) throw new AbsSyncError('ABS_WORKSPACE_MODE_UNINITIALIZED', 'Project mode requires its physical storage attachment.');
    const saved = await new AbsBaselineStore(port, { projectKey: port.attachment.root, pageId: '' }).readCommittedSnapshot();
    if (!saved || saved.abi === null || !await sameAbsProjectDirectory(saved.projection.map.scope.projectKey,
      port.attachment.root, undefined, /^[A-Za-z]:[/\\]|^\\\\/.test(port.attachment.root)))
      throw new AbsSyncError('ABS_WORKSPACE_MODE_UNINITIALIZED', 'Project mode has no verified accepted program; the selected engine was not changed.');
    const accepted = (await generationEvidence(saved.projection, saved.abi)).binding;
    assertCurrent();
    if (await readAbsWorkspaceMode(port) !== workspaceMode) throw new AbsSyncError('ABS_WORKSPACE_MODE_CHANGED', 'The selected project execution mode changed.');
    return { ...reply, project: port.attachment.root, protocol: { ...protocol, workspaceModeBinding: { version: 1, attachment: port.attachment,
      accepted, committedHash: saved.pointerHash } } };
  } catch (error) {
    return { ok: false, operation: 'abs_protocol', project, ...serializeAbsFailure(error) };
  }
}
