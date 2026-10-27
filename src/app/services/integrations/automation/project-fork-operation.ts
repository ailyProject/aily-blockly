import type { ProjectSaveAsOutcome, ProjectService } from '@domain/project/public-api';
import { sameAbsProjectDirectory } from '../../../integrations/blockly/abs/abs-project-path';

type ForkProjectService = Pick<ProjectService,
  'currentProjectPath' | 'getProjectMode' | 'isProjectOpening' | 'isProjectTransitionInProgress' | 'saveRecoveryAs'>
  & Partial<Pick<ProjectService, 'getBlocklyProjectLoadStatus'>>;

export interface ProjectForkNative {
  path: {
    dirname(path: string): string;
    basename(path: string): string;
    join(...paths: string[]): string;
    resolve(path: string): string;
    isAbsolute(path: string): boolean;
  };
  exists(path: string): boolean;
  realpath?: (path: string) => Promise<string>;
  forkPolicy?: (params: { sourceProject: string; project: string }) => Promise<{
    version: 1; sourceProject: string; project: string; activation: 'same-host' | 'deferred'; reason?: 'isolated-repair-host' }>;
  windows: boolean;
}

function nativePort(): ProjectForkNative {
  return { path: window['path'], exists: path => window['fs'].existsSync(path),
    realpath: window['fs']?.realpathAsync, forkPolicy: window['fs']?.projectRepairEnvironment?.forkPolicy,
    windows: window['platform']?.isWindows === true };
}

function automaticTarget(source: string, native: ProjectForkNative): string {
  const name = native.path.basename(source).slice(0, 80);
  const parent = native.path.dirname(source);
  for (let attempt = 0; attempt < 8; attempt++) {
    const target = native.path.join(parent, `${name}-recovered-${crypto.randomUUID().slice(0, 8)}`);
    if (!native.exists(target)) return target;
  }
  throw Object.assign(new Error('无法选择未占用的恢复副本路径，请明确指定新的 targetPath。'), { code: 'PROJECT_FORK_TARGET_BUSY' });
}

/** No synthetic live canvas is installed for a closed source. The adapter only
 * shares target validation and truthful outcome formatting with ordinary fork;
 * the domain publishes a disk-primary copy before opening the target. */
export async function forkClosedProject(service: ForkProjectService & Pick<ProjectService, 'saveClosedRecoveryAs'>,
  source: string, native = nativePort()): Promise<Record<string, any>> {
  if (service.currentProjectPath) return { ok: false, operation: 'project_fork', sourceProject: source,
    projectSaved: false, activated: false, code: 'PROJECT_RECOVERY_OPEN_VIEW_ACTIVE',
    message: 'A current view must be retained; recovery opening cannot replace or save it.' };
  const adapter: ForkProjectService = {
    get currentProjectPath() { return service.currentProjectPath || source; },
    getProjectMode: project => service.getProjectMode(project),
    get isProjectOpening() { return service.isProjectOpening; },
    isProjectTransitionInProgress: project => service.isProjectTransitionInProgress(project),
    saveRecoveryAs: target => service.saveClosedRecoveryAs(source, target),
    getBlocklyProjectLoadStatus: project => service.getBlocklyProjectLoadStatus!(project),
  };
  return forkProject(adapter, source, {}, native);
}

/** Save a new physical workspace; never retire the original build or copy its owner. */
export async function forkProject(service: ForkProjectService, requestedProject: string | undefined,
  params: Record<string, unknown>, native = nativePort()): Promise<Record<string, any>> {
  const sourceProject = service.currentProjectPath;
  let target: string | undefined;
  const fail = (code: string, message: string) => ({ ok: false, operation: 'project_fork', sourceProject,
    project: target ?? sourceProject, projectSaved: false, activated: false, code, message });
  try {
    if (!sourceProject) return fail('PROJECT_FORK_NO_PROJECT', '当前主程序未打开项目。');
    if (service.getProjectMode(sourceProject) !== 'blockly') {
      return fail('PROJECT_FORK_UNSUPPORTED', '当前只支持 Blockly 工作区快照副本；不调用会保存源工程的 Coder 另存为。');
    }
    if (service.isProjectOpening || service.isProjectTransitionInProgress(sourceProject)) {
      return fail('PROJECT_FORK_CONTEXT_BUSY', '项目正在切换、重载或关闭；尚未开始创建副本。');
    }
    if ((requestedProject && !await sameAbsProjectDirectory(requestedProject, sourceProject, native.realpath, native.windows))
      || sourceProject !== service.currentProjectPath) {
      return fail('PROJECT_FORK_CONTEXT_STALE', '请求的源项目与当前工作区不一致；未创建副本。');
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(key => key !== 'targetPath')
      || params['targetPath'] !== undefined && (typeof params['targetPath'] !== 'string' || !params['targetPath'])) {
      return fail('PROJECT_FORK_INVALID', '仅接受可选的绝对 targetPath，不接受草稿内容或清锁参数。');
    }
    target = typeof params['targetPath'] === 'string' ? params['targetPath'] : automaticTarget(sourceProject, native);
    if (!native.path.isAbsolute(target)) return fail('PROJECT_FORK_TARGET_INVALID', 'targetPath 必须是源目录外的新绝对路径。');
    target = native.path.resolve(target);
    const pathKey = (value: string) => {
      const key = value.replace(/\\/g, '/').replace(/\/+$/, '');
      return native.windows ? key.toLowerCase() : key;
    };
    if (pathKey(target) === pathKey(sourceProject) || pathKey(target).startsWith(`${pathKey(sourceProject)}/`)) {
      return fail('PROJECT_FORK_TARGET_INVALID', '恢复副本必须位于源项目目录外；未调用保存。');
    }
    // SaveAs owns destination reservation, immutable source capture, copy filtering
    // and physical-parent validation. Do not save the source or create another mask
    // that would block its own activation through the normal project lifecycle.
    const policy = await native.forkPolicy?.({ sourceProject, project: target });
    if (policy && (policy.version !== 1 || policy.sourceProject !== sourceProject || policy.project !== target
      || !['same-host', 'deferred'].includes(policy.activation)
      || policy.activation === 'deferred' && policy.reason !== 'isolated-repair-host')) {
      return fail('PROJECT_FORK_POLICY_INVALID', 'The native source-host activation policy did not match this exact copy.');
    }
    if (sourceProject !== service.currentProjectPath) return fail('PROJECT_FORK_CONTEXT_STALE', 'The source view changed before publication.');
    const outcome: ProjectSaveAsOutcome | void = policy?.activation === 'deferred'
      ? await service.saveRecoveryAs(target, { activation: 'retain-source' }) : await service.saveRecoveryAs(target);
    if (!outcome
      || !await sameAbsProjectDirectory(outcome.project, target, native.realpath, native.windows)
      || !await sameAbsProjectDirectory(outcome.sourceProject, sourceProject, native.realpath, native.windows)) {
      return fail('PROJECT_FORK_UNCONFIRMED', '未收到完整副本保存回执；请检查目标，不要删除原工程或重复覆盖。');
    }
    if (!outcome.projectSaved) {
      return { ...outcome, ok: false, operation: 'project_fork', sourceProject, project: outcome.project, activated: false,
        originalWorkspaceReleased: false,
        message: outcome.error || '目标快照保存尚未确认；保留源工程和目标以供检查。',
        guidance: 'projectSaved:false 不表示目标目录已删除。先检查已返回的目标与诊断，不要覆盖重试、删除恢复副本或解除源构建保护。' };
    }
    const activeProject = service.currentProjectPath;
    const activated = outcome.activated === true && await sameAbsProjectDirectory(
      outcome.project, activeProject, native.realpath, native.windows) && service.currentProjectPath === activeProject;
    const loadStatus = activeProject && await sameAbsProjectDirectory(outcome.project, activeProject, native.realpath, native.windows)
      && service.currentProjectPath === activeProject
      ? service.getBlocklyProjectLoadStatus?.(outcome.project) : undefined;
    const confirmedActivation = activated && service.currentProjectPath === activeProject;
    return { ...outcome, ok: true, operation: 'project_fork', sourceProject, project: outcome.project,
      ...(loadStatus ? { loadStatus } : {}),
      projectSaved: true, activated: confirmedActivation, partial: outcome.partial || !confirmedActivation,
      message: outcome.activationDeferred ? '完整副本已保存，当前独立修复视图继续保留；由已认证的原生宿主为新目标准备独立修复环境。'
        : confirmedActivation ? '已创建并打开独立工作区副本，原工程及其构建保护保持不变。'
        : '副本已保存，但尚未打开；原工作区保留。请等待当前宿主操作结束后打开副本，再继续校验或编译。',
      originalWorkspaceReleased: false,
      guidance: outcome.activationDeferred ? '不要在当前修复子进程直接打开新目标，不重新复制或解除源保护；通过已认证的目标宿主交接后 inspect/resume 新目标。'
        : outcome.recoverySource?.kind === 'saved-document'
        ? outcome.activationBlocked
          ? '完整磁盘工程已保全，但半初始化画布未能归档；原视图继续保留，不得直接打开副本丢弃未保全视图。先读取 activationBlocked 和加载/依赖诊断，不清原工程保护。'
          : '副本主 ABI 来自完整磁盘文档；半初始化画布单独归档，没有冒充完整程序。仅在目标加载就绪、新 ABS 基线建立后继续；不应用原草稿、不清除原工程保护。'
        : '此操作保存完整当前画布快照，不应用尚未导入的 ABS 草稿。仅在已激活的副本中继续；不得把旧编译日志或产物当作副本的本次验收结果。' };
  } catch (error) {
    return fail((error as any)?.code || 'PROJECT_FORK_FAILED', error instanceof Error ? error.message : String(error));
  }
}
