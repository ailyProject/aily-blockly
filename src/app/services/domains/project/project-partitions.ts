import {
  allocatePartitions, createPreset, parseFlashSize, parsePartitionCsv, serializePartitions, validatePartitions,
} from '@shared/public-api';
import { resolvePartitionPaths } from '@shared/public-api';

interface PartitionProject {
  currentProjectPath: string;
  currentBoardConfig: any;
  isCloudBuild(): boolean;
  isAilyCodeProject(root: string): boolean;
  getPackageJson(): Promise<any>;
  getEffectivePackageText(projectPath: string): string;
  getBoardJson(): Promise<any>;
  getBoardConfigMenu(options: { persistDefaults: boolean }): Promise<any[]>;
  getBoardFile(name: string): Promise<string | null>;
  getSdkPath(options: { optional: boolean }): Promise<string>;
  getBoardBuildProperties(overrides: Record<string, unknown>): Promise<Record<string, string>>;
  getCloudPartitionTemplate(name: string): Promise<string | null>;
}

const signature = (pkg: any) => JSON.stringify(
  [pkg.entry, pkg.arduinoSketch, pkg.devmode, pkg.board, pkg.dependencies, pkg.projectConfig],
  (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value,
);

/** Both compile entry points call this before hashing or freezing source files. */
export async function ensureProjectPartitionFile(
  project: PartitionProject, fs: any, path: any, assertCurrent: () => void = () => {},
): Promise<{ filePath: string; source: 'project' | 'legacy' | 'board' | 'sdk' | 'cloud' | 'generated'; created: boolean } | null> {
  const root = project.currentProjectPath;
  const board = project.currentBoardConfig;
  const cloud = project.isCloudBuild();
  const readSaved = () => signature(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
  // Library edits are installed immediately but remain unsaved until Save.
  // Capture each authority independently, including disk before the first await:
  // a valid pending edit differs from disk without either input having changed.
  const saved = readSaved();
  const pkg = await project.getPackageJson();
  const expected = signature(pkg);
  const guard = () => {
    assertCurrent();
    if (project.currentProjectPath !== root || project.currentBoardConfig !== board || project.isCloudBuild() !== cloud
      || readSaved() !== saved
      || signature(JSON.parse(project.getEffectivePackageText(root))) !== expected) {
      throw new Error('BUILD_SOURCE_STALE: 项目或开发板配置已改变，请重新编译。');
    }
  };
  guard();
  const target = board || await project.getBoardJson();
  if (!String(target?.core || target?.type || '').toLowerCase().includes('esp32')) return null;
  // Ordinary SDK schemes must remain untouched, including projects without a CSV.
  if (pkg.projectConfig?.PartitionScheme !== undefined && pkg.projectConfig.PartitionScheme !== 'custom') return null;
  const menu = await project.getBoardConfigMenu({ persistDefaults: false });
  const selected = { ...pkg.projectConfig };
  for (const item of menu) {
    const option = item.children?.find(child => child.check);
    if (option && selected[item.key] === undefined) selected[item.key] = option.data;
  }
  guard();
  if (selected.PartitionScheme !== 'custom') return null;
  const { filePath, legacyPath } = resolvePartitionPaths(root, pkg, project.isAilyCodeProject(root), path);
  if (fs.existsSync(filePath)) return { filePath, source: 'project', created: false };

  let csv: string | null = null;
  let source: 'legacy' | 'board' | 'sdk' | 'cloud' | 'generated' = 'generated';
  let origin: string | undefined;
  if (fs.existsSync(legacyPath)) { origin = legacyPath; source = 'legacy'; }
  else { origin = await project.getBoardFile('partitions.csv') || undefined; source = 'board'; }
  guard();
  if (origin) csv = fs.readFileSync(origin, 'utf8');

  if (csv === null) {
    // Resolve the board's default non-custom scheme without changing package.json.
    const defaultScheme = menu.find(item => item.key === 'PartitionScheme' && !item.disabled)?.children
      ?.find(item => item.data !== 'custom' && !item.disabled && !item.extra?.selectAction);
    const sdk = cloud ? '' : await project.getSdkPath({ optional: true });
    const properties = cloud || sdk ? await project.getBoardBuildProperties({ ...selected,
      ...(defaultScheme ? { PartitionScheme: defaultScheme.data } : {}) }) : {};
    const configuredFlash = parseFlashSize(selected.FlashSize);
    const propertyFlash = parseFlashSize(properties['build.flash_size']);
    const flashBytes = configuredFlash || propertyFlash;
    if (!flashBytes || configuredFlash && propertyFlash && configuredFlash !== propertyFlash) {
      throw new Error('无法确认自定义分区的 Flash 容量，请在开发板设置或 Dock 分区工具中选择实际容量后重试。');
    }
    const name = properties['build.partitions'];
    if (name && name !== 'custom' && /^[\w.-]+$/.test(name)) {
      let template: string | null = null;
      let templatePath: string | undefined;
      if (cloud) template = await project.getCloudPartitionTemplate(name);
      else {
        templatePath = path.join(sdk, 'tools', 'partitions', name + '.csv');
        if (fs.existsSync(templatePath)) template = fs.readFileSync(templatePath, 'utf8');
      }
      if (template !== null) {
        const parsed = parsePartitionCsv(template);
        const validation = validatePartitions(parsed.rows, flashBytes);
        if (!parsed.errors.length && !validation.errors.length) {
          csv = template; origin = templatePath; source = cloud ? 'cloud' : 'sdk';
        }
      }
    }
    if (csv === null) {
      const layout = allocatePartitions(createPreset('iot', flashBytes));
      const errors = [...layout.errors, ...validatePartitions(layout.rows, flashBytes).errors];
      if (errors.length) throw new Error(`无法生成适配当前 Flash 的默认分区，请使用 Dock 分区工具调整：${[...new Set(errors)].join('；')}`);
      csv = serializePartitions(layout.rows);
      source = 'generated';
    }
  }

  guard();
  if (origin && fs.readFileSync(origin, 'utf8') !== csv) throw new Error('BUILD_SOURCE_STALE: 分区模板已改变，请重新编译。');
  // A concurrent editor/save wins. Never replace an existing project CSV.
  if (fs.existsSync(filePath)) return { filePath, source: 'project', created: false };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, csv);
    // link is atomic and refuses to replace a file created by another writer.
    try { fs.linkSync(temp, filePath); }
    catch (error) {
      // Electron's context bridge may omit the native error code.
      if (!fs.existsSync(filePath)) throw error;
      return { filePath, source: 'project', created: false };
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return { filePath, source, created: true };
}
