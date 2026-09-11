import type { IMenuItem } from '../../configs/menu.config';
import type { ElectronService } from '@core/platform/public-api';
import type { BuilderService } from '@domain/build/public-api';
import type { ProjectService } from '@domain/project/public-api';

function configOptions(menu: IMenuItem[]): IMenuItem[] {
  return menu.flatMap(item => item.children || []).filter(item =>
    !item.sep && !!item.key && ['string', 'number', 'boolean'].includes(typeof item.data),
  );
}

export async function getBoardConfig(projectService: ProjectService): Promise<Record<string, unknown>> {
  const project = projectService.currentProjectPath;
  const board = projectService.currentBoardConfig;
  if (!project || !board) {
    return { ok: false, reason: 'board_not_ready', message: '请先打开项目并等待开发板加载完成。' };
  }

  const menu = await projectService.getBoardConfigMenu({ persistDefaults: false });
  const packageJson = await projectService.getPackageJson();
  const configured = packageJson?.projectConfig || {};

  return {
    ok: true,
    operation: 'get_board_config',
    project,
    board: board['description'] || '',
    core: board['core'] || '',
    config_type: board['type'] || '',
    config_items: menu.filter(item => !item.sep && configOptions([item]).length > 0).map(item => {
      const options = configOptions([item]);
      const key = item.key || options[0].key!;
      const selected = options.find(option => option.check);

      return {
        name: item.name || key,
        config_key: key,
        configured_value: configured[key] === undefined ? null : String(configured[key]),
        current_value: selected ? String(selected.data) : null,
        options: options.map(option => ({
          name: option.name || String(option.data),
          value: String(option.data),
          selected: option.check === true,
          available: item.disabled !== true && option.disabled !== true && !option.extra?.selectAction,
          ...(option.extra?.selectAction ? { select_action: option.extra.selectAction } : {}),
        })),
      };
    }),
  };
}

export async function setBoardConfig(
  projectService: ProjectService,
  builderService: BuilderService,
  electronService: ElectronService,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const project = projectService.currentProjectPath;
  const configKey = input['config_key'];
  const configValue = input['config_value'];
  const base = { operation: 'set_board_config', project, config_key: configKey };

  if (!project || !projectService.currentBoardConfig) {
    return { ...base, ok: false, reason: 'board_not_ready', message: '请先打开项目并等待开发板加载完成。' };
  }
  if (typeof configKey !== 'string' || !configKey || typeof configValue !== 'string') {
    return { ...base, ok: false, reason: 'invalid_board_config_input', message: 'config_key 和 config_value 必须是 get_board_config 返回的字符串。' };
  }

  const menu = await projectService.getBoardConfigMenu({ persistDefaults: false });
  const selection = configOptions(menu).find(item => item.key === configKey && String(item.data) === configValue);
  if (!selection) {
    return { ...base, ok: false, reason: 'invalid_board_config_option', message: '当前开发板不支持此配置键值，请重新调用 get_board_config。' };
  }
  const parent = menu.find(item => item.children?.includes(selection));
  if (parent?.disabled || selection.disabled || selection.extra?.selectAction) {
    return {
      ...base,
      ok: false,
      reason: 'board_config_action_unavailable',
      message: selection.extra?.selectAction
        ? `此选项还要求执行 ${selection.extra.selectAction}，配置工具不会隐式执行设备操作。`
        : '当前配置选项已禁用。',
    };
  }

  const packageJson = await projectService.getPackageJson();
  if (projectService.currentProjectPath !== project || !packageJson) {
    return { ...base, ok: false, reason: 'project_changed', message: '当前项目已改变，请重新查询板卡配置。' };
  }
  const oldValue = packageJson.projectConfig?.[configKey];
  const changed = oldValue !== selection.data;
  const result = { ...base, old_value: oldValue ?? null, new_value: selection.data, changed };
  let persisted = false;

  try {
    packageJson.projectConfig = { ...packageJson.projectConfig, [configKey]: selection.data };
    await projectService.setPackageJson(packageJson);
    persisted = true;

    // A retry must also finish synchronization after a previous partial failure.
    if (selection.extra?.refreshRuntimeBoardConfig) {
      await projectService.refreshRuntimeBoardConfig();
    }
    if (selection.extra?.syncPinConfig) {
      await projectService.syncBoardPinConfig(selection);
    }

    const saved = await projectService.getPackageJson();
    if (projectService.currentProjectPath !== project || saved?.projectConfig?.[configKey] !== selection.data) {
      throw new Error('配置回读与目标值不一致，请重新读取当前项目配置。');
    }

    const customPartition: Record<string, unknown> = {};
    if (configKey === 'PartitionScheme' && selection.data === 'custom') {
      const sourceDirectory = projectService.isAilyCodeProject(project)
        ? window['path'].dirname(electronService.pathJoin(project, 'sketch', saved.entry || 'src/main.cpp'))
        : electronService.pathJoin(project, 'src');
      const requiredFilePath = electronService.pathJoin(sourceDirectory, 'partitions.csv');
      const legacyFilePath = electronService.pathJoin(project, 'partitions.csv');
      customPartition['required_file_path'] = requiredFilePath;
      customPartition['compatible_legacy_file_path'] = legacyFilePath;
      customPartition['requires_file'] = !electronService.exists(requiredFilePath) && !electronService.exists(legacyFilePath);
    }

    const requiresFile = customPartition['requires_file'] === true;
    if (!requiresFile) builderService.triggerPreprocess('config-changed');

    return {
      ...result,
      ...customPartition,
      ok: true,
      persisted: true,
      preprocess_requested: !requiresFile,
      message: requiresFile
        ? '配置已保存。请先在 required_file_path 创建自定义分区 CSV，再调用 project_build。'
        : '配置已保存并请求预处理；这不代表编译完成，请调用 project_build 验证。',
    };
  } catch (error) {
    return {
      ...result,
      ok: false,
      persisted,
      reason: persisted ? 'board_config_sync_failed' : 'board_config_save_failed',
      message: `${persisted ? '配置已保存，但同步或验证失败' : '配置保存失败'}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
