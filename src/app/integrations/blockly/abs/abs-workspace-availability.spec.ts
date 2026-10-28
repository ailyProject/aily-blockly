import { serializeAbsFailure } from './abs-diagnostics';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { BlocklyWorkspaceEditGate } from '../../../editors/blockly-editor/services/blockly-workspace-edit-lease';

describe('ABS workspace availability diagnostics', () => {
  it('preserves a trusted quarantine through inspect without offering another inspect or source overwrite', async () => {
    const gate = new BlocklyWorkspaceEditGate(), lease = gate.acquire();
    lease.quarantine('Native rollback could not be verified.'); lease.release();
    const result: any = await new AbsGenerationToolsService({ inspectGeneration: async () => gate.assertAvailable() } as any)
      .execute('abs_recovery', { version: 2, requestId: 'quarantine-diagnostic-001', action: 'inspect' });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_WORKSPACE_QUARANTINED');
    expect(result.diagnostic.reason).toBe('workspace-quarantined');
    expect(result.recovery).toContain('project_recover(action="fork")');
    expect(result.recovery).toContain('library staging');
    expect(result.recovery).not.toContain('action="inspect"');
    expect(result.receipt).toBeUndefined(); expect(result.publication).toBeUndefined();
    expect(() => gate.assertAvailable()).toThrow();
  });

  it('distinguishes active ownership from quarantine and obsolete leases without releasing either gate', async () => {
    const gate = new BlocklyWorkspaceEditGate(), active = gate.acquire();
    let busy: unknown; try { gate.assertAvailable(); } catch (error) { busy = error; }
    expect(serializeAbsFailure(busy).code).toBe('ABS_WORKSPACE_BUSY');
    expect(serializeAbsFailure(busy).diagnostic!.hint).toContain('Wait');
    expect(serializeAbsFailure(busy).diagnostic!.hint).not.toContain('action="fork"');
    expect(gate.busy).toBeTrue();
    gate.reset();
    let stale: unknown; try { active.assertCurrent(); } catch (error) { stale = error; }
    expect(serializeAbsFailure(stale).code).toBe('ABS_WORKSPACE_STALE');
    expect(serializeAbsFailure(stale).diagnostic!.hint).not.toContain('action="fork"');
  });

  it('does not promote third-party codes, names or message fragments into trusted recovery facts', () => {
    for (const code of ['BLOCKLY_WORKSPACE_TAINTED', 'BLOCKLY_EDIT_BUSY', 'BLOCKLY_EDIT_STALE',
      'ABS_WORKSPACE_QUARANTINED', 'ABS_WORKSPACE_BUSY', 'ABS_WORKSPACE_STALE']) {
      const spoof = { name: 'BlocklyEditError', code, message: 'BLOCKLY_WORKSPACE_TAINTED',
        diagnostic: { reason: 'workspace-quarantined', hint: 'project_recover(action="fork")' } };
      const result = serializeAbsFailure(spoof);
      expect(result.code).toBe('ABS_GENERATION_FAILED');
      expect(result.diagnostic).toBeUndefined();
    }
  });
});
