import type { ProjectService } from '@domain/project/public-api';
import type { BuilderService } from '@domain/build/public-api';
import {
  allocatePartitions, inferDraft, parseFlashSize, parsePartitionCsv,
  serializePartitions, validatePartitions, MIB, SECTOR, type PartitionDraft,
} from './partition-layout';

export interface FlashOption { value: string | null; bytes: number; }
export interface PartitionManagerContext {
  token: string;
  projectPath: string;
  projectName: string;
  boardName: string;
  flashBytes: number;
  flashOptions: FlashOption[];
  csv: string;
  source: 'project' | 'legacy' | 'board' | 'sdk' | 'cloud' | 'missing';
  customSelected: boolean;
  filePath: string;
  draft: PartitionDraft | null;
}
interface Session {
  context: PartitionManagerContext;
  // 草稿绑定读取时的编译模式，切换模式后要求重新载入，避免保存过期的开发板分区配置。
  cloud: boolean;
  signature: string;
  watched: Array<{ path: string; content: string | null }>;
}
const sessions = new Map<string, Session>();
const readOptional = (fs: any, path: string): string | null => fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null;
const projectSignature = (pkg: any, board: any): string => JSON.stringify([pkg.entry, pkg.devmode, pkg.board, pkg.dependencies, pkg.projectConfig, board]);

/** Metadata is only a UI hint; malformed values must never become editor state. */
function isPartitionDraft(value: unknown): value is PartitionDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return ['iot', 'xiaozhi', 'large'].includes(draft['preset'] as string)
    && ['recommended', 'fixed', 'remaining'].includes(draft['appMode'] as string)
    && ['fixed', 'remaining'].includes(draft['storageMode'] as string)
    && ['ota', 'storage', 'coredump'].every(key => typeof draft[key] === 'boolean')
    && Number.isSafeInteger(draft['flashBytes']) && Number(draft['flashBytes']) > 0 && Number(draft['flashBytes']) <= 256 * MIB
    && ['appBytes', 'storageBytes', 'nvsBytes'].every(key => Number.isSafeInteger(draft[key])
      && Number(draft[key]) >= 0 && Number(draft[key]) <= 256 * MIB && Number(draft[key]) % SECTOR === 0);
}

export function resolvePartitionPaths(projectPath: string, pkg: any, isCoder: boolean, path: any) {
  const root = path.resolve(projectPath);
  const source = isCoder ? path.dirname(path.join(root, pkg.arduinoSketch === true ? '.' : 'sketch', pkg.entry || 'src/main.cpp')) : path.join(root, 'src');
  const filePath = path.join(source, 'partitions.csv');
  const relative = path.relative(root, filePath);
  if (!relative || relative === '..' || relative.startsWith('../') || relative.startsWith('..\\') || path.isAbsolute(relative)) {
    throw new Error('项目入口路径超出当前项目，无法保存分区。');
  }
  return { filePath, legacyPath: path.join(root, 'partitions.csv') };
}

/** Stage all files first; roll back the whole update on a write/rename failure. */
export function writePartitionTransaction(fs: any, path: any, files: Array<{ path: string; content: string }>): void {
  const suffix = `.partition-${crypto.randomUUID()}`;
  const staged = files.map(file => ({ ...file, temp: file.path + suffix + '.tmp', backup: file.path + suffix + '.bak', existed: fs.existsSync(file.path), backedUp: false, installed: false }));
  try {
    for (const file of staged) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.temp, file.content);
    }
    for (const file of staged) {
      if (file.existed) { fs.renameSync(file.path, file.backup); file.backedUp = true; }
      fs.renameSync(file.temp, file.path);
      file.installed = true;
    }
  } catch (error) {
    const recovery: string[] = [];
    for (const file of [...staged].reverse()) {
      try {
        if (file.installed) fs.unlinkSync(file.path);
        if (file.backedUp) fs.renameSync(file.backup, file.path);
      } catch { recovery.push(file.backup); }
    }
    if (recovery.length) throw new Error(`保存失败，部分原文件需从备份恢复：${recovery.join('、')}`);
    throw error;
  } finally {
    for (const file of staged) {
      try { if (fs.existsSync(file.temp)) fs.unlinkSync(file.temp); } catch { /* Original files remain recoverable. */ }
    }
  }
  for (const file of staged) {
    try { if (fs.existsSync(file.backup)) fs.unlinkSync(file.backup); } catch { /* A retained backup does not invalidate the committed configuration. */ }
  }
}

async function loadContext(project: ProjectService, requestedPath: string): Promise<PartitionManagerContext> {
  if (!requestedPath || requestedPath !== project.currentProjectPath) throw new Error('请先在主窗口切换到此项目，再重新载入分区方案。');
  const cloud = project.isCloudBuild();
  const board = project.currentBoardConfig;
  if (!String(board?.core || board?.type || '').toLowerCase().includes('esp32')) throw new Error('当前开发板不是受支持的 ESP32 开发板。');
  const pkg = await project.getPackageJson();
  const menu = await project.getBoardConfigMenu({ persistDefaults: false });
  const custom = menu.flatMap(item => item.children || []).find(item => item.key === 'PartitionScheme' && item.data === 'custom');
  if (!custom || custom.disabled || menu.find(item => item.children?.includes(custom))?.disabled) throw new Error('当前开发板未提供 custom 分区选项。');
  const { filePath, legacyPath } = resolvePartitionPaths(requestedPath, pkg, project.isAilyCodeProject(requestedPath), window['path']);
  const fs = window['fs'];
  const path = window['path'];
  const selected: Record<string, any> = { ...pkg.projectConfig };
  for (const item of menu) {
    const current = item.children?.find(child => child.check);
    if (current && selected[item.key] === undefined) selected[item.key] = current.data;
  }
  const flashOptions: FlashOption[] = menu.filter(item => !item.disabled).flatMap(item => item.children || [])
    .filter(item => item.key === 'FlashSize' && !item.disabled && !item.extra?.selectAction)
    .map(item => ({ value: String(item.data), bytes: parseFlashSize(item.data) }))
    .filter(item => item.bytes > 0);
  let flashBytes = parseFlashSize(selected['FlashSize']);
  const watched = [filePath, legacyPath].map(p => ({ path: p, content: readOptional(fs, p) }));
  let csv = watched[0].content ?? watched[1].content ?? '';
  let source: PartitionManagerContext['source'] = watched[0].content !== null ? 'project' : watched[1].content !== null ? 'legacy' : 'missing';
  // 本地读取 SDK 默认值，云模式读取网关元数据；查看分区时不修改项目的开发板选项。
  const sdkPath = cloud ? '' : await project.getSdkPath();
  const boardId = String(board.type || '').split(':').pop();
  const boardsTxt = sdkPath ? readOptional(fs, path.join(sdkPath, 'boards.txt')) : null;
  const properties: Record<string, string> = {};
  const raw: Record<string, string> = {};
  if (cloud) {
    Object.assign(properties, await project.getBoardBuildProperties());
    flashBytes ||= parseFlashSize(properties['build.flash_size']);
  }
  if (boardsTxt) {
    for (const line of boardsTxt.split(/\r?\n/)) {
      const equal = line.indexOf('=');
      if (equal < 0 || !line.startsWith(boardId + '.')) continue;
      raw[line.slice(boardId.length + 1, equal)] = line.slice(equal + 1).trim();
    }
    for (const [key, value] of Object.entries(raw)) if (!key.startsWith('menu.')) properties[key] = value;
    for (const [key, value] of Object.entries(selected)) {
      const prefix = `menu.${key}.${value}.`;
      for (const [entry, setting] of Object.entries(raw)) if (entry.startsWith(prefix)) properties[entry.slice(prefix.length)] = setting;
    }
    flashBytes ||= parseFlashSize(properties['build.flash_size']);
  }
  if (!flashOptions.length && flashBytes) flashOptions.push({ value: null, bytes: flashBytes });
  const boardPartitionPath = await project.getBoardFile('partitions.csv');
  if (source === 'missing' && boardPartitionPath) {
    csv = readOptional(fs, boardPartitionPath) || '';
    if (csv) { source = 'board'; watched.push({ path: boardPartitionPath, content: csv }); }
  }
  if (source === 'missing' && sdkPath && selected['PartitionScheme'] !== 'custom') {
    const partitionName = properties['build.partitions'];
    if (partitionName && /^[\w.-]+$/.test(partitionName)) {
      const sdkCsv = path.join(sdkPath, 'tools', 'partitions', partitionName + '.csv');
      const content = readOptional(fs, sdkCsv);
      if (content !== null) { csv = content; source = 'sdk'; watched.push({ path: sdkCsv, content }); }
    }
  }
  // 云模式不安装 SDK，从当前目标公开的模板恢复默认分区，项目自己的 CSV 始终优先。
  if (source === 'missing' && cloud && selected['PartitionScheme'] !== 'custom') {
    const name = properties['build.partitions'];
    if (name && /^[\w.-]+$/.test(name)) {
      const content = await project.getCloudPartitionTemplate(name);
      if (content === null) throw new Error('云编译目标未提供当前分区模板。');
      csv = content;
      source = 'cloud';
    }
  }
  const latestPkg = await project.getPackageJson();
  if (project.currentProjectPath !== requestedPath || project.currentBoardConfig !== board || project.isCloudBuild() !== cloud) throw new Error('项目、开发板或编译设置已改变，请重新打开分区管理器。');
  if (projectSignature(latestPkg, board) !== projectSignature(pkg, board)) throw new Error('项目配置已改变，请重新载入。');
  const parsed = parsePartitionCsv(csv);
  let draft = !parsed.errors.length && csv ? inferDraft(parsed.rows, flashBytes) : null;
  const metadata = pkg.ailyPartitionManager;
  if (metadata?.version === 1 && metadata.csv === csv && isPartitionDraft(metadata.draft) && metadata.draft.flashBytes === flashBytes) {
    const generated = allocatePartitions(metadata.draft);
    if (!generated.errors.length && serializePartitions(generated.rows) === csv) draft = metadata.draft;
  }
  const context: PartitionManagerContext = {
    token: crypto.randomUUID(), projectPath: requestedPath, projectName: pkg.nickname || pkg.name || path.basename(requestedPath),
    boardName: board.description || board.name || board.type || 'ESP32', flashBytes, flashOptions,
    csv, source, filePath, customSelected: selected['PartitionScheme'] === 'custom', draft,
  };
  if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
  sessions.set(context.token, { context, cloud, signature: projectSignature(pkg, board), watched });
  return context;
}

export async function handlePartitionManagerRequest(
  project: ProjectService, builder: BuilderService, request: any, isBusy: () => boolean = () => false,
): Promise<any> {
  try {
    if (request.action === 'partition-manager-load') return { success: true, context: await loadContext(project, request.projectPath) };
    if (request.action !== 'partition-manager-save') throw new Error('未知分区操作。');
    if (isBusy()) throw new Error('项目正在安装、编译或上传，请等待完成后保存；当前草稿已保留。');
    const session = sessions.get(request.token);
    if (!session) throw new Error('编辑会话已失效，请重新载入分区方案。');
    const context = session.context;
    if (project.currentProjectPath !== context.projectPath) throw new Error('当前项目已切换。请在主窗口切回此项目后重试。');
    const pkg = await project.getPackageJson();
    if (isBusy()) throw new Error('项目正在安装、编译或上传，请等待完成后保存；当前草稿已保留。');
    if (sessions.get(request.token) !== session) throw new Error('此分区方案已保存，请重新载入。');
    if (project.currentProjectPath !== context.projectPath || project.isCloudBuild() !== session.cloud
      || projectSignature(pkg, project.currentBoardConfig) !== session.signature) throw new Error('项目配置、开发板或编译设置已改变，请重新载入后编辑。');
    const fs = window['fs'];
    const path = window['path'];
    if (session.watched.some(file => readOptional(fs, file.path) !== file.content)) throw new Error('分区文件已被外部修改，请重新载入；当前草稿尚未保存。');
    if (typeof request.csv !== 'string') throw new Error('分区 CSV 内容无效。');
    const selectedFlash = context.flashOptions.find(option => option.bytes === request.flashBytes);
    if (!selectedFlash) throw new Error('请选择当前开发板支持的 Flash 容量。');
    const parsed = parsePartitionCsv(request.csv);
    const validation = validatePartitions(parsed.rows, selectedFlash.bytes);
    const errors = [...parsed.errors, ...validation.errors];
    if (errors.length) throw new Error(errors.join('\n'));
    const projectConfig = { ...pkg.projectConfig, PartitionScheme: 'custom' };
    if (selectedFlash.value !== null) projectConfig.FlashSize = selectedFlash.value;
    let draft: PartitionDraft | null = null;
    if (isPartitionDraft(request.draft) && request.draft.flashBytes === selectedFlash.bytes) {
      const generated = allocatePartitions(request.draft);
      if (!generated.errors.length && serializePartitions(generated.rows) === request.csv) draft = request.draft;
    }
    const next = { ...pkg, projectConfig, ailyPartitionManager: { version: 1, csv: request.csv, draft } };
    const files = [
      { path: context.filePath, content: request.csv },
      { path: path.join(context.projectPath, 'package.json'), content: JSON.stringify(next, null, 2) },
    ];
    const isCoder = project.isAilyCodeProject(context.projectPath);
    const coderContext = isCoder && !project.isCoderProjectContext ? project.getCoderProjectContext(context.projectPath) : null;
    if (!isCoder) files.push({ path: path.join(context.projectPath, '.temp', 'package.json'), content: JSON.stringify(next, null, 2) });
    // No awaits after the final context check: a project activation cannot interleave this commit.
    writePartitionTransaction(fs, path, files);
    project.currentPackageData = next;
    if (coderContext) coderContext.currentPackageData = next;
    sessions.delete(context.token);
    let warning = '';
    try { builder.triggerPreprocess('config-changed'); } catch { warning = '方案已保存，预处理未启动，请手动重新编译。'; }
    return { success: true, warning, filePath: context.filePath };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
