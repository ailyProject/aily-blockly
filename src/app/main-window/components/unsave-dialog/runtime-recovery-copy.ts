import type { ProjectSaveAsOutcome } from '@domain/project/public-api';
import type { UnsaveDialogCustomData } from './unsave-dialog.component';

export function runtimeRecoveryDialogData(leaving = false): UnsaveDialogCustomData {
  return { title: '完整画布已受保护',
    text: '库运行时未能重建，当前视图可能不完整。可以把重建前的完整画布保存到独立副本，不覆盖原工程或应用 AI 草稿；Agent 也可通过项目恢复工具修复运行时。',
    buttons: [{ text: 'UNSAVE_DIALOG.CANCEL', type: 'default', action: 'cancel' },
      { text: leaving ? '保存完整副本并继续' : '保存完整恢复副本', type: 'primary', action: 'recovery-copy' }] };
}

interface RecoveryCopyProject {
  currentProjectPath: string;
  captureCurrentProjectGuard(): () => boolean;
  hasBlocklyRuntimeRecovery(path: string): boolean;
  saveRecoveryAs(target: string, options: { activation: 'retain-source' }): Promise<ProjectSaveAsOutcome>;
}

/** Shared UI workflow. Copy acknowledgement never acknowledges the source as
 * saved, and a late picker result cannot select another workspace incarnation. */
export async function saveRuntimeRecoveryCopy(project: RecoveryCopyProject, path: string,
  pickTarget: () => Promise<string>, feedback: { success(message: string): unknown; error(message: string): unknown }): Promise<boolean> {
  const unchanged = project.captureCurrentProjectGuard();
  if (path !== project.currentProjectPath || !project.hasBlocklyRuntimeRecovery(path)) return false;
  const target = await pickTarget();
  if (!target || !unchanged()) return false;
  const outcome = await project.saveRecoveryAs(target, { activation: 'retain-source' });
  const saved = unchanged() && outcome.projectSaved && outcome.recoverySource?.origin === 'runtime-snapshot';
  if (saved) feedback.success('完整恢复副本已保存；原工程和未应用的 AI 草稿保持不变。');
  else feedback.error(outcome.error || '恢复副本尚未确认保存成功，当前工程仍保留。');
  return saved;
}
