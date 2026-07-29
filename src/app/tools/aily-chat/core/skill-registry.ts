/**
 * Aily Skill Registry - 技能注册中心
 *
 * 单例模式，管理所有已发现的 Skills。
 * 职责：发现、解析、加载、搜索 Skills。
 *
 * 扫描来源（按优先级从低到高，同名后者覆盖前者）：
 * 0. Builtin Skills: ${rendererPath}/skills/          (随应用安装包分发，public/skills/)
 * 1. Global Skills:  ${AppDataPath}/aily-skills/      (用户全局自定义)
 * 2. Configured User: userSkillFolders                (显式配置)
 * 3. Project Skills: ${projectRoot}/.aily/skills/     (项目专属)
 * 4. Cross-client:   ${projectRoot}/.agents/skills/   (规范推荐，跨客户端)
 * 5. Configured Project: projectSkillFolders          (显式配置)
 */

import {
  IAilySkill, SkillMetadata, SkillOrigin,
  SkillSearchResult,
  type SkillContextMode,
  type SkillInvocationContext,
  type SkillRelatedFile,
  type LoadedSkillSummary,
} from './skill-types';
import { normalizeAgentIdentifiers } from './agent-identifiers';
import { AilyHost } from './host';
import { isAilyCategoryDebugEnabled } from './chat-debug-flags';
import { getChildToolConfigs, onChildToolConfigsChanged } from '../../../configs/tool.config';

const MAX_SKILL_RELATED_FILES = 50;
const MAX_SKILL_RELATED_DEPTH = 5;
const SKILL_LISTING_CHAR_BUDGET = 15000;
const SKILL_LISTING_TRUNCATED_NAMES_BUDGET = 5000;
const SKILL_DISCOVERY_REFRESH_DEBOUNCE_MS = 100;
const IGNORED_SKILL_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.cache',
  'coverage',
]);

function isSkillRegistryTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceSkillRegistry', [
    '__AILY_CHAT_TRACE_SKILL_REGISTRY__',
    'AILY_CHAT_TRACE_SKILL_REGISTRY',
  ]);
}

interface SkillRegistryInitializeOptions {
  readonly projectSkillFolders?: readonly string[];
  readonly userSkillFolders?: readonly string[];
  readonly debugSource?: string;
}

// ============================
// YAML Frontmatter 解析
// ============================

/**
 * 从 SKILL.md 内容中解析 YAML frontmatter 和 body。
 * 格式: ---\nyaml\n---\nmarkdown body
 */
function parseSkillMd(raw: string): { metadata: SkillMetadata; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // 无 frontmatter — 将整个内容作为 body, name 从文件夹推断
    return {
      metadata: { name: 'unknown', description: '' },
      body: raw,
    };
  }
  const yamlStr = match[1];
  const body = match[2];
  const metadata = parseSimpleYaml(yamlStr);
  return { metadata, body };
}

function normalizeSkillPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function trimQuotedValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function parseFrontmatterBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return undefined;
}

function parseFrontmatterList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inlineItems = trimmed.slice(1, -1)
      .split(',')
      .map(item => trimQuotedValue(item))
      .filter(Boolean);
    return inlineItems.length > 0 ? inlineItems : undefined;
  }

  const items = trimmed
    .split(',')
    .map(item => trimQuotedValue(item))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseSkillMode(value: string | undefined): SkillContextMode {
  return value?.trim().toLowerCase() === 'fork' ? 'fork' : 'inline';
}

/**
 * 轻量级 YAML 解析器 —— 支持 Agent Skills 规范的 frontmatter 格式。
 * 顶级字段：name, description, license, compatibility, allowed-tools
 * Aily 扩展字段：metadata 嵌套 map 下的 version, author, scope, agents, auto-activate, tags 等
 */
function parseSimpleYaml(yaml: string): SkillMetadata {
  const topLevel: Record<string, string> = {};
  const metadataMap: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  let inMetadata = false;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    if (inMetadata) {
      const nestedKv = line.match(/^  ([a-zA-Z_-]+)\s*:\s*(.*)/);
      if (nestedKv) {
        metadataMap[nestedKv[1].trim()] = nestedKv[2].trim().replace(/^['"]|['"]$/g, '');
        continue;
      }
      if (!line.startsWith(' ')) {
        inMetadata = false;
      } else {
        continue;
      }
    }

    const kvMatch = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      if (key === 'metadata' && !val) {
        inMetadata = true;
        continue;
      }
      if (val) {
        topLevel[key] = trimQuotedValue(val);
      }
    }
  }

  const m = metadataMap;
  const parsedName = topLevel['name'] || 'unknown';
  const description = topLevel['description'] || '';
  const userInvocable = parseFrontmatterBoolean(topLevel['user-invokable'] ?? topLevel['userInvocable']);
  const disableModelInvocation = parseFrontmatterBoolean(topLevel['disable-model-invocation'] ?? topLevel['disableModelInvocation']);
  const targets = parseFrontmatterList(topLevel['target'] ?? topLevel['targets'] ?? topLevel['session-type'] ?? topLevel['sessionType']);
  const parseList = (s?: string) => parseFrontmatterList(s);
  const parsedAgents = normalizeAgentIdentifiers(parseList(m['agents']));

  return {
    name: parsedName,
    description,
    license: topLevel['license'],
    compatibility: topLevel['compatibility'],
    allowedTools: topLevel['allowed-tools'],
    metadata: Object.keys(m).length > 0 ? m : undefined,
    version: m['version'],
    scope: m['scope'] as any,
    agents: parsedAgents.length > 0 ? parsedAgents : undefined,
    autoActivate: m['auto-activate'] === 'true',
    tags: parseList(m['tags']),
    author: m['author'],
    sourceUrl: m['source-url'],
    userInvocable,
    disableModelInvocation,
    context: parseSkillMode(topLevel['context']),
    targets,
  };
}

// ============================
// Registry 实现
// ============================

class SkillRegistryImpl {
  private skills = new Map<string, IAilySkill>();
  private _initialized = false;
  /** 会话级：仅 restore / persisted keep-path 会写入的 session skills，不再作为 inline load_skill 默认主路径。 */
  private _activatedSkills = new Set<string>();
  private readonly _changeListeners = new Set<() => void>();
  private _watchSubscriptions = new Map<string, (() => void) | { close?(): void; dispose?(): void; unsubscribe?(): void } | void>();
  private _watchTargetPaths = new Map<string, string>();
  private _watchTargetRoots = new Map<string, string[]>();
  private _watchedProjectRoot: string | undefined;
  private _initializationOptions: SkillRegistryInitializeOptions = {};
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _initializationSequence = 0;

  constructor() {
    onChildToolConfigsChanged(() => {
      if (this._initialized) {
        this.scheduleDiscoveryRefresh();
      }
    });
  }

  // ========== 初始化 ==========

  /**
   * 扫描所有来源的 Skills。
   * 扫描顺序：builtin → 全局 aily-skills → 配置的用户目录 → 项目 .aily/skills/ → 项目 .agents/skills/ → 配置的项目目录
   * 同名 skill 后扫描的覆盖先扫描的（项目级优先于全局优先于内置）。
   */
  async initialize(projectRoot?: string, options: SkillRegistryInitializeOptions = {}): Promise<void> {
    const initializationSequence = ++this._initializationSequence;
    const startedAt = Date.now();
    const debugSource = typeof options.debugSource === 'string' && options.debugSource.trim().length > 0
      ? options.debugSource.trim()
      : 'unspecified';
    this._watchedProjectRoot = projectRoot;
    this._initializationOptions = this.normalizeInitializationOptions(options);
    this.skills.clear();

    if (isSkillRegistryTraceEnabled()) {
      console.info('[SkillRegistry][debug] initialize start', {
        initializationSequence,
        debugSource,
        projectRoot: projectRoot ?? null,
        activatedSkillCount: this._activatedSkills.size,
        wasInitialized: this._initialized,
      });
    }

    const host = AilyHost.get();
    if (!host?.fs || !host?.path) {
      this.disposeDiscoveryWatchers();
      console.warn('[SkillRegistry] Host API 不可用，跳过 skill 发现');
      this._initialized = true;
      return;
    }

    // 0. 加载内置 skills（随安装包分发，优先级最低）
    for (const builtinDir of this.getBuiltinSkillsDirs()) {
      this.scanDirectory(builtinDir, { type: 'builtin' });
    }

    for (const childToolSkillFile of this.getChildToolSkillFiles()) {
      this.scanSkillFile(childToolSkillFile, { type: 'builtin' });
    }

    // 1. 加载全局 skills（用户在 AppData 下自定义的）
    const globalDir = this.getGlobalSkillsDir();
    if (globalDir) {
      this.scanDirectory(globalDir, { type: 'user' });
    }

    for (const userSkillDir of this.resolveConfiguredSkillDirectories(
      this._initializationOptions.userSkillFolders,
      'user',
      projectRoot,
      host,
    )) {
      this.scanDirectory(userSkillDir, { type: 'user' });
    }

    // 3. 加载项目 .aily/skills/
    if (projectRoot) {
      const ailySkillsDir = host.path.join(projectRoot, '.aily', 'skills');
      this.scanDirectory(ailySkillsDir, { type: 'project', projectRoot });
    }

    // 4. 加载项目 .agents/skills/（Agent Skills 规范跨客户端互操作目录）
    if (projectRoot) {
      const agentsSkillsDir = host.path.join(projectRoot, '.agents', 'skills');
      this.scanDirectory(agentsSkillsDir, { type: 'project', projectRoot });
    }

    for (const projectSkillDir of this.resolveConfiguredSkillDirectories(
      this._initializationOptions.projectSkillFolders,
      'project',
      projectRoot,
      host,
    )) {
      this.scanDirectory(projectSkillDir, { type: 'project', projectRoot: projectRoot || projectSkillDir });
    }

    // Installation/uninstallation can remove a previously activated child-tool skill.
    // Keep session state aligned with the currently discoverable inventory.
    for (const name of Array.from(this._activatedSkills)) {
      if (!this.skills.has(name)) this._activatedSkills.delete(name);
    }

    this.refreshDiscoveryWatchers(projectRoot, host);
    this._initialized = true;
    this.emitDidChange('initialize-complete');
    console.log(`[SkillRegistry] 初始化完成, 发现 ${this.skills.size} 个 skills`, {
      initializationSequence,
      debugSource,
      durationMs: Date.now() - startedAt,
    });
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  // ========== 目录扫描 ==========

  private scanDirectory(dir: string, origin: SkillOrigin): void {
    const host = AilyHost.get();
    if (!host.fs.existsSync(dir)) return;

    try {
      const entries = host.fs.readdirSync(dir);
      for (const entry of entries) {
        const skillDir = host.path.join(dir, entry);
        // 跳过非目录
        try {
          if (!host.fs.isDirectory(skillDir)) continue;
        } catch {
          continue;
        }

        this.scanSkillFile(host.path.join(skillDir, 'SKILL.md'), origin);
      }
    } catch (e) {
      console.warn(`[SkillRegistry] 扫描目录失败: ${dir}`, e);
    }
  }

  private scanSkillFile(skillMdPath: string, origin: SkillOrigin): void {
    const host = AilyHost.get();
    if (!host.fs.existsSync(skillMdPath)) return;
    const skillDir = host.path.dirname(skillMdPath);
    const entry = host.path.basename(skillDir);

    try {
      const raw = host.fs.readFileSync(skillMdPath, 'utf-8');
      const { metadata, body } = parseSkillMd(raw);
      const parsedName = metadata.name;
      metadata.displayName = parsedName && parsedName !== 'unknown' && parsedName !== entry
        ? parsedName
        : undefined;
      metadata.name = entry;

      const skill: IAilySkill = {
        metadata,
        folderPath: skillDir,
        baseDir: skillDir,
        skillMdPath,
        origin,
        // auto-activate skills 立即加载 body
        content: metadata.autoActivate ? body : undefined,
      };

      this.skills.set(metadata.name, skill);
    } catch (e) {
      console.warn(`[SkillRegistry] 解析 skill 失败: ${skillMdPath}`, e);
    }
  }

  // ========== 目录工具 ==========

  /**
   * 内置 skills 目录。Angular 会把 public/skills 打进 renderer/skills；
   * 本地开发、dist 预览和 Electron 打包路径都作为候选目录处理。
   */
  private getBuiltinSkillsDirs(): string[] {
    const host = AilyHost.get();
    const electronPath = host.path?.getElectronPath?.();
    if (!electronPath) return [];

    const candidates = [
      host.path.join(electronPath, '..', 'renderer', 'skills'),
      host.path.join(electronPath, '..', 'dist', 'aily-blockly', 'browser', 'skills'),
      host.path.join(electronPath, '..', 'public', 'skills'),
    ];
    const seen = new Set<string>();
    const directories: string[] = [];

    for (const candidate of candidates) {
      const identity = this.normalizeWatchTargetIdentity(candidate, host);
      if (!identity || seen.has(identity) || !host.fs.existsSync(candidate)) {
        continue;
      }

      seen.add(identity);
      directories.push(candidate);
    }

    return directories;
  }

  /** Installed subapps declare package-relative skill files in package.json. */
  private getChildToolSkillFiles(): string[] {
    const host = AilyHost.get();
    const files = new Set<string>();
    for (const config of Object.values(getChildToolConfigs())) {
      if (!config.packagePath || !config.agent?.skills?.length) continue;
      for (const declaredSkill of config.agent.skills) {
        const skillFile = host.path.join(config.packagePath, declaredSkill);
        if (host.fs.existsSync(skillFile)) files.add(skillFile);
      }
    }
    return Array.from(files).sort((left, right) => left.localeCompare(right));
  }

  /**
   * Watch each manifest-declared skill directory.
   */
  private getChildToolSkillWatchRoots(host: ReturnType<typeof AilyHost.get>): string[] {
    const roots = new Set<string>();
    for (const skillFile of this.getChildToolSkillFiles()) {
      roots.add(host.path.dirname(skillFile));
    }
    return Array.from(roots);
  }

  /** Global skills directory: {appDataPath}/aily-skills/. */
  private getGlobalSkillsDir(): string | null {
    const host = AilyHost.get();
    const appDataPath = host.path?.getAppDataPath?.();
    if (!appDataPath) return null;
    return host.path.join(appDataPath, 'aily-skills');
  }

  private normalizeInitializationOptions(options: SkillRegistryInitializeOptions | undefined): SkillRegistryInitializeOptions {
    return {
      debugSource: typeof options?.debugSource === 'string' ? options.debugSource : undefined,
      userSkillFolders: this.normalizeConfiguredFolderEntries(options?.userSkillFolders),
      projectSkillFolders: this.normalizeConfiguredFolderEntries(options?.projectSkillFolders),
    };
  }

  private normalizeConfiguredFolderEntries(entries: readonly string[] | undefined): string[] {
    if (!Array.isArray(entries)) {
      return [];
    }

    return entries
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  }

  private resolveConfiguredSkillDirectories(
    entries: readonly string[] | undefined,
    source: 'project' | 'user',
    projectRoot: string | undefined,
    host: ReturnType<typeof AilyHost.get>,
  ): string[] {
    const directories: string[] = [];
    const seen = new Set<string>();

    for (const entry of this.normalizeConfiguredFolderEntries(entries)) {
      const resolvedDirectory = this.resolveConfiguredSkillDirectory(entry, source, projectRoot, host);
      if (!resolvedDirectory) {
        continue;
      }

      const identity = this.normalizeWatchTargetIdentity(resolvedDirectory, host);
      if (!identity || seen.has(identity)) {
        continue;
      }

      seen.add(identity);
      directories.push(resolvedDirectory);
    }

    return directories;
  }

  private resolveConfiguredSkillDirectory(
    entry: string,
    source: 'project' | 'user',
    projectRoot: string | undefined,
    host: ReturnType<typeof AilyHost.get>,
  ): string | null {
    const normalizedEntry = entry.trim();
    if (!normalizedEntry) {
      return null;
    }

    const userHome = host.path?.getUserHome?.() || '';
    const basePath = source === 'user' ? userHome : projectRoot || '';

    if (normalizedEntry === '~') {
      return userHome || null;
    }

    if (/^~[\\/]/.test(normalizedEntry)) {
      if (!userHome) {
        return null;
      }

      return host.path.join(userHome, normalizedEntry.replace(/^~[\\/]/, ''));
    }

    if (host.path?.isAbsolute?.(normalizedEntry)) {
      return normalizedEntry;
    }

    if (!basePath) {
      return null;
    }

    return host.path.join(basePath, normalizedEntry);
  }

  // ========== Skill 加载 ==========

  /**
   * 加载 skill 的完整 body 内容（延迟加载）。
   * 首次加载后缓存在 skill.content 中。
   */
  loadSkillContent(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;

    if (skill.content !== undefined) return skill.content;

    // 从文件读取
    if (skill.folderPath) {
      try {
        const host = AilyHost.get();
        const raw = host.fs.readFileSync(skill.skillMdPath, 'utf-8');
        const { body } = parseSkillMd(raw);
        const normalizedBody = this.decorateSkillBody(skill, body);
        (skill as any).content = normalizedBody;
        return normalizedBody;
      } catch (e) {
        console.warn(`[SkillRegistry] 加载 skill 内容失败: ${skill.skillMdPath}`, e);
        return null;
      }
    }

    return null;
  }

  private isTrustedSkillSource(skill: IAilySkill | undefined | null): skill is IAilySkill {
    return !!skill && skill.origin.type !== 'url';
  }

  /**
   * 从 URL 直接加载 skill（不安装到磁盘，仅缓存在内存）。
   * 需要宿主环境提供 fetch 能力。
   */
  async loadFromUrl(url: string, fetchFn: (url: string) => Promise<string>): Promise<IAilySkill | null> {
    try {
      const raw = await fetchFn(url);
      const { metadata, body } = parseSkillMd(raw);

      const skill: IAilySkill = {
        metadata,
        folderPath: '',
        baseDir: '',
        skillMdPath: url,
        origin: { type: 'url', sourceUrl: url },
        content: body,
      };

      this.skills.set(metadata.name, skill);
      this.emitDidChange('load-from-url');
      return skill;
    } catch (e) {
      console.warn(`[SkillRegistry] 从 URL 加载 skill 失败: ${url}`, e);
      return null;
    }
  }

  private getSkillDisplayName(skill: IAilySkill): string {
    return skill.metadata.displayName || skill.metadata.name;
  }

  private getSkillMode(skill: IAilySkill): SkillContextMode {
    return skill.metadata.context || 'inline';
  }

  private isChildToolSkill(skill: IAilySkill): boolean {
    const skillPath = normalizeSkillPath(skill.skillMdPath);
    return skillPath.includes('/child/tools/');
  }

  private decorateSkillBody(skill: IAilySkill, body: string): string {
    if (!this.isChildToolSkill(skill)) {
      return body;
    }

    return [
      body,
      '',
      '## Host Runtime Notes',
      '',
      '- In this packaged app, child tool folders may only expose bundled entrypoints and assets such as `index.js`, `package.json`, `ui/`, `i18n/`, or `vendor/`.',
      '- Before reading implementation files, inspect the current packaged folder with `list_dir` and then read concrete files such as `package.json` or `index.js` that actually exist.',
      '- Do not assume repo-only source files like `core.js`, `server.js`, `cli.js`, `ui/src/*`, or registry files like `child/tools/index.json` exist in the current workspace unless you have listed them first.',
      '- If a child tool process returns `processId`, `outputSessionId`, or `outputFilePath`, inspect its output with `command_status`, `command_tail`, `command_read`, `command_search`, or `log_tool` instead of `read_file` on the output path.',
    ].join('\n');
  }

  private getSkillRelatedFiles(skill: IAilySkill): SkillRelatedFile[] {
    if (!skill?.baseDir) return [];

    const host = AilyHost.get();
    if (!host?.fs) return [];

    const baseDir = skill.baseDir;
    const normalizedBaseDir = normalizeSkillPath(baseDir).replace(/\/+$/g, '');
    const relatedFiles: SkillRelatedFile[] = [];
    const visited = new Set<string>();

    const walk = (dirPath: string, depth: number): void => {
      if (depth > MAX_SKILL_RELATED_DEPTH || relatedFiles.length >= MAX_SKILL_RELATED_FILES) {
        return;
      }

      const normalizedDirPath = normalizeSkillPath(dirPath);
      if (visited.has(normalizedDirPath)) {
        return;
      }
      visited.add(normalizedDirPath);

      let entries: string[];
      try {
        entries = host.fs.readdirSync(dirPath);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (relatedFiles.length >= MAX_SKILL_RELATED_FILES) {
          return;
        }

        const fullPath = host.path.join(dirPath, entry);
        let isDirectory = false;
        try {
          isDirectory = host.fs.isDirectory(fullPath);
        } catch {
          continue;
        }

        if (isDirectory) {
          if (IGNORED_SKILL_DIRECTORY_NAMES.has(entry.toLowerCase())) {
            continue;
          }
          walk(fullPath, depth + 1);
          continue;
        }

        const normalizedFullPath = normalizeSkillPath(fullPath);
        if (normalizedFullPath === normalizeSkillPath(skill.skillMdPath)) {
          continue;
        }

        if (!normalizedFullPath.startsWith(normalizedBaseDir)) {
          continue;
        }

        const relativePath = normalizedFullPath.slice(normalizedBaseDir.length).replace(/^\/+/, '');
        if (!relativePath) {
          continue;
        }

        const firstSegment = relativePath.split('/')[0]?.toLowerCase();
        const category = firstSegment === 'scripts'
          ? 'script'
          : firstSegment === 'references'
            ? 'reference'
            : firstSegment === 'assets'
              ? 'asset'
              : 'other';
        relatedFiles.push({
          path: relativePath,
          uri: normalizedFullPath,
          category,
        });
      }
    };

    walk(baseDir, 0);
    return relatedFiles.sort((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * 列出 skill 目录下的附带资源文件（scripts/, references/, assets/）。
   * 保留给旧调用方；新路径应使用 getSkillContext()。
   */
  listSkillResources(name: string): string[] {
    const skill = this.skills.get(name);
    if (!skill) {
      return [];
    }

    return this.getSkillRelatedFiles(skill).map(file => file.path);
  }

  getSkillContext(name: string): SkillInvocationContext | null {
    const skill = this.skills.get(name);
    if (!this.isTrustedSkillSource(skill)) {
      return null;
    }

    const body = skill.content || this.loadSkillContent(name);
    if (!body) {
      return null;
    }

    return {
      name: skill.metadata.name,
      displayName: this.getSkillDisplayName(skill),
      description: skill.metadata.description || '',
      body,
      skillMdPath: normalizeSkillPath(skill.skillMdPath),
      baseDir: skill.baseDir ? normalizeSkillPath(skill.baseDir) : undefined,
      mode: this.getSkillMode(skill),
      userInvocable: skill.metadata.userInvocable !== false,
      modelInvocable: skill.metadata.disableModelInvocation !== true && !!skill.metadata.description,
      relatedFiles: this.getSkillRelatedFiles(skill),
    };
  }

  getLoadedSkillSummaries(agentName?: string): LoadedSkillSummary[] {
    return this.getActivatedSkillNames(agentName)
      .map(name => this.getSkillContext(name))
      .filter((context): context is SkillInvocationContext => !!context)
      .map(context => ({
        name: context.name,
        displayName: context.displayName,
        description: context.description,
        skillMdPath: context.skillMdPath,
        baseDir: context.baseDir,
        mode: context.mode,
        relatedFileCount: context.relatedFiles.length,
      }));
  }

  // ========== 查询 & 搜索 ==========

  /** 获取所有已注册 skills */
  getAll(): IAilySkill[] {
    return [...this.skills.values()];
  }

  /** 获取指定名称的 skill */
  get(name: string): IAilySkill | undefined {
    return this.skills.get(name);
  }

  /** 按 agent 过滤 skills */
  getSkillsForAgent(agentName: string): IAilySkill[] {
    const normalizedAgentNames = normalizeAgentIdentifiers([agentName]);
    const normalizedAgentName = normalizedAgentNames[0] ?? agentName;
    return [...this.skills.values()].filter(
      s => {
        if (!this.isTrustedSkillSource(s)) {
          return false;
        }
        const skillAgents = normalizeAgentIdentifiers(s.metadata.agents);
        const skillTargets = normalizeAgentIdentifiers(s.metadata.targets);
        const matchesAgent = skillAgents.length === 0 || skillAgents.includes(normalizedAgentName);
        const matchesTarget = skillTargets.length === 0 || skillTargets.includes(normalizedAgentName);
        return matchesAgent && matchesTarget;
      }
    );
  }

  /** 获取自动激活的 skills（auto-activate: true） */
  getAutoActivateSkills(agentName?: string): IAilySkill[] {
    return [...this.skills.values()].filter(s => {
      if (!this.isTrustedSkillSource(s)) return false;
      if (!s.metadata.autoActivate) return false;
      if (agentName && s.metadata.agents && s.metadata.agents.length > 0) {
        const normalizedAgentName = normalizeAgentIdentifiers([agentName])[0] ?? agentName;
        return normalizeAgentIdentifiers(s.metadata.agents).includes(normalizedAgentName);
      }
      return true;
    });
  }

  /**
   * 搜索 skills（三级策略，同 deferred tools 模式）。
   * 1. 精确名称匹配
   * 2. 关键词打分匹配（名称/标签优先于描述）
   * 3. 无匹配时返回空结果
   */
  searchSkills(query: string, agentName?: string): SkillSearchResult[] {
    const q = query.toLowerCase().trim();
    if (!q) {
      return [];
    }
    let candidates = agentName
      ? this.getSkillsForAgent(agentName)
      : this.getAll().filter(skill => this.isTrustedSkillSource(skill));

    // 1. 精确名称匹配
    const exact = candidates.filter(s => {
      const name = s.metadata.name.toLowerCase();
      const displayName = s.metadata.displayName?.toLowerCase();
      return name === q || displayName === q;
    });
    if (exact.length > 0) {
      return exact.map(skill => ({ skill, matchType: 'exact' as const }));
    }

    const queryTokens = tokenizeSkillSearchQuery(q);
    const scored = candidates
      .map(skill => {
        const name = skill.metadata.name.toLowerCase();
        const displayName = skill.metadata.displayName?.toLowerCase() ?? '';
        const description = skill.metadata.description.toLowerCase();
        const tags = (skill.metadata.tags ?? []).map(tag => tag.toLowerCase());
        let score = 0;
        let matchType: SkillSearchResult['matchType'] = 'fuzzy';

        if (name.includes(q) || displayName.includes(q)) {
          score += 80;
          matchType = 'exact';
        }

        if (tags.some(tag => tag === q || tag.includes(q))) {
          score += 40;
          if (matchType !== 'exact') {
            matchType = 'tag';
          }
        }

        for (const token of queryTokens) {
          if (name === token || displayName === token) {
            score += 60;
            matchType = 'exact';
            continue;
          }
          if (name.includes(token) || displayName.includes(token)) {
            score += 25;
            if (matchType !== 'exact') {
              matchType = 'fuzzy';
            }
          }
          if (tags.some(tag => tag === token)) {
            score += 20;
            if (matchType !== 'exact') {
              matchType = 'tag';
            }
            continue;
          }
          if (tags.some(tag => tag.includes(token))) {
            score += 12;
            if (matchType !== 'exact') {
              matchType = 'tag';
            }
          }
          if (description.includes(token)) {
            score += 8;
          }
        }

        return score > 0 ? { skill, matchType, score } : null;
      })
      .filter((entry): entry is { skill: IAilySkill; matchType: SkillSearchResult['matchType']; score: number } => !!entry)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.skill.metadata.name.localeCompare(right.skill.metadata.name);
      });

    return scored.map(({ skill, matchType }) => ({ skill, matchType }));
  }

  /**
   * 生成 skills 索引列表文本（注入到系统提示中）。
   * 格式参考 getDeferredToolsListing()。
   */
  /**
   * 生成 skills 索引列表（渐进式发现：名称 → load_skill 加载完整内容）。
   * 只列出名称，类似 deferred tools 的渐进式索引模式。
   */
  getSkillsListing(
    agentName?: string,
    options?: {
      readonly availableToolNames?: ReadonlySet<string> | readonly string[] | null;
    },
  ): string {
    const skills = agentName
      ? this.getSkillsForAgent(agentName)
      : this.getAll();
    const availableToolNames = normalizeAvailableToolNames(options?.availableToolNames);
    const hasLoadSkillTool = !availableToolNames || availableToolNames.has('load_skill');
    const hasReadFileTool = !availableToolNames || availableToolNames.has('read_file');

    // 排除 auto-activate 和已激活的（它们的内容已通过 getActiveSkillsContent 持久注入）
    const listable = skills.filter(s => !s.metadata.autoActivate
      && !this._activatedSkills.has(s.metadata.name)
      && !!s.metadata.description
      && s.metadata.disableModelInvocation !== true);
    if (listable.length === 0) return '';

    const allEntries = listable.map(skill => {
        const context = this.getSkillContext(skill.metadata.name);
        const flags = [
          `user-invocable: ${context?.userInvocable === false ? 'false' : 'true'}`,
          `model-invocable: ${context?.modelInvocable === false ? 'false' : 'true'}`,
          `mode: ${context?.mode || 'inline'}`,
          ...(!hasLoadSkillTool ? [`uri: ${normalizeSkillPath(skill.skillMdPath)}`] : []),
        ];
        return `- ${skill.metadata.name}: ${skill.metadata.description} (${flags.join(', ')})`;
      });

    const entries: string[] = [];
    let truncatedAtIndex = allEntries.length;
    let charCount = 0;

    for (let i = 0; i < allEntries.length; i += 1) {
      const entry = allEntries[i];
      const entryLength = entry.length + 1;
      if (hasLoadSkillTool && charCount + entryLength > SKILL_LISTING_CHAR_BUDGET) {
        truncatedAtIndex = i;
        break;
      }
      charCount += entryLength;
      entries.push(entry);
    }

    if (truncatedAtIndex < listable.length) {
      const truncatedSkills = listable.slice(truncatedAtIndex);
      const names: string[] = [];
      let nameListLength = 0;
      for (const skill of truncatedSkills) {
        const addition = (names.length > 0 ? 2 : 0) + skill.metadata.name.length;
        if (nameListLength + addition > SKILL_LISTING_TRUNCATED_NAMES_BUDGET) {
          break;
        }
        nameListLength += addition;
        names.push(skill.metadata.name);
      }
      const remaining = truncatedSkills.length - names.length;
      const nameList = names.join(', ');
      if (nameList) {
        entries.push(remaining > 0
          ? `Additional skills available (invoke by name): ${nameList}... and ${remaining} more`
          : `Additional skills available (invoke by name): ${nameList}`);
      }
    }

    if (entries.length === 0) {
      return '';
    }

    return [
      '<skills>',
      ...entries,
      '',
      buildSkillsListingInstruction({
        hasLoadSkillTool,
        hasReadFileTool,
      }),
      '</skills>',
    ].join('\n');
  }

  // ========== 会话级激活/卸载 ==========

  /**
    * 激活一个 session-scoped skill。
    * 当前仅 restore / persisted keep-path 应调用这里；inline `load_skill` 不再默认写入该集合。
   */
  activateSkill(name: string): boolean {
    const skill = this.skills.get(name);
    if (!this.isTrustedSkillSource(skill)) return false;
    // 确保内容已加载
    this.loadSkillContent(name);
    const sizeBefore = this._activatedSkills.size;
    this._activatedSkills.add(name);
    if (this._activatedSkills.size !== sizeBefore) {
      this.emitDidChange('activate-skill');
    }
    return true;
  }

  /**
    * 卸载一个 session-scoped skill。
   * auto-activate 的 skill 不可卸载（始终活跃）。
   */
  deactivateSkill(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    if (skill.metadata.autoActivate) return false;
    const didDelete = this._activatedSkills.delete(name);
    if (didDelete) {
      this.emitDidChange('deactivate-skill');
    }
    return didDelete;
  }

  /** 获取当前已激活的 skill 名称列表（含 auto-activate） */
  getActivatedSkillNames(agentName?: string): string[] {
    const autoNames = this.getAutoActivateSkills(agentName).map(s => s.metadata.name);
    return [...new Set([...autoNames, ...this._activatedSkills])];
  }

  /** 清除会话级激活状态（会话结束时调用） */
  clearSessionState(debugSource: string = 'unspecified'): void {
    if (this._activatedSkills.size === 0) {
      if (isSkillRegistryTraceEnabled()) {
        console.info('[SkillRegistry][debug] clear session state skipped', {
          debugSource,
          activatedSkillCount: 0,
        });
      }
      return;
    }

    const clearedSkillCount = this._activatedSkills.size;
    this._activatedSkills.clear();
    if (isSkillRegistryTraceEnabled()) {
      console.info('[SkillRegistry][debug] clear session state', {
        debugSource,
        clearedSkillCount,
      });
    }
    this.emitDidChange('clear-session-state');
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this._changeListeners.add(listener);
    return {
      dispose: () => {
        this._changeListeners.delete(listener);
      },
    };
  }

  /**
   * 获取所有活跃 skills 的合并内容（auto-activate + Agent 激活的）。
   * 用 <rules> 标签包裹，便于压缩时清理、下轮重新注入。
   *
   * 这是 Copilot 式的"每轮重新组装"模式的核心方法。
   */
  getActiveSkillsContent(agentName?: string): string {
    const contents: string[] = [];

    // 1. auto-activate skills
    const autoSkills = this.getAutoActivateSkills(agentName);
    for (const skill of autoSkills) {
      const body = skill.content || this.loadSkillContent(skill.metadata.name);
      if (body) contents.push(body);
    }

    // 2. Agent 主动激活的 skills
    for (const name of this._activatedSkills) {
      // 跳过已在 auto-activate 中包含的
      if (autoSkills.some(s => s.metadata.name === name)) continue;
      const body = this.loadSkillContent(name);
      if (body) contents.push(body);
    }

    if (contents.length === 0) return '';
    return `<rules>\n${contents.join('\n\n')}\n</rules>`;
  }

  /**
   * @deprecated 使用 getActiveSkillsContent() 替代
   */
  getAutoActivateContent(agentName?: string): string {
    return this.getActiveSkillsContent(agentName);
  }

  /** 已注册 skill 数量 */
  get size(): number {
    return this.skills.size;
  }

  private refreshDiscoveryWatchers(projectRoot: string | undefined, host: ReturnType<typeof AilyHost.get>): void {
    if (typeof host.fs?.watch !== 'function') {
      this.disposeDiscoveryWatchers();
      return;
    }

    const watchTargets = this.collectDiscoveryWatchTargets(projectRoot, host);
    const nextTargetKeys = new Set<string>();
    const nextWatchTargetPaths = new Map<string, string>();
    const nextWatchTargetRoots = new Map<string, string[]>();
    const createdTargetKeys = new Set<string>();

    for (const watchTarget of watchTargets) {
      const targetKey = this.normalizeWatchTargetIdentity(watchTarget.watchPath, host);
      nextTargetKeys.add(targetKey);
      nextWatchTargetPaths.set(targetKey, watchTarget.watchPath);
      const roots = nextWatchTargetRoots.get(targetKey) ?? [];
      roots.push(watchTarget.discoveryRoot);
      nextWatchTargetRoots.set(targetKey, roots);
      if (this._watchSubscriptions.has(targetKey) || createdTargetKeys.has(targetKey)) {
        continue;
      }

      try {
        const subscription = host.fs.watch(watchTarget.watchPath, (
          eventOrPayload?: string | { eventType?: string; filename?: string | null },
          filename?: string | null,
        ) => {
          const eventType = typeof eventOrPayload === 'string'
            ? eventOrPayload
            : eventOrPayload?.eventType;
          const changedFilename = typeof eventOrPayload === 'object' ? eventOrPayload?.filename : filename;
          if (!this.shouldRefreshDiscoveryForWatchEvent(targetKey, eventType, changedFilename, host)) {
            return;
          }
          this.scheduleDiscoveryRefresh();
        });
        if (subscription) {
          this._watchSubscriptions.set(targetKey, subscription);
        }
        createdTargetKeys.add(targetKey);
      } catch {
        // Ignore unsupported watch failures; read-side initialize remains authoritative.
      }
    }

    for (const [targetKey, subscription] of Array.from(this._watchSubscriptions.entries())) {
      if (nextTargetKeys.has(targetKey)) {
        continue;
      }

      this.disposeDiscoveryWatchSubscription(subscription);
      this._watchSubscriptions.delete(targetKey);
    }

    this._watchTargetPaths = nextWatchTargetPaths;
    this._watchTargetRoots = nextWatchTargetRoots;
  }

  private collectDiscoveryWatchTargets(
    projectRoot: string | undefined,
    host: ReturnType<typeof AilyHost.get>,
  ): Array<{ watchPath: string; discoveryRoot: string }> {
    const roots: string[] = [];
    for (const builtinDir of this.getBuiltinSkillsDirs()) {
      roots.push(builtinDir);
    }

    roots.push(...this.getChildToolSkillWatchRoots(host));

    const globalDir = this.getGlobalSkillsDir();
    if (globalDir) {
      roots.push(globalDir);
    }

    roots.push(...this.resolveConfiguredSkillDirectories(
      this._initializationOptions.userSkillFolders,
      'user',
      projectRoot,
      host,
    ));

    if (projectRoot) {
      roots.push(
        host.path.join(projectRoot, '.aily', 'skills'),
        host.path.join(projectRoot, '.agents', 'skills'),
      );
    }

    roots.push(...this.resolveConfiguredSkillDirectories(
      this._initializationOptions.projectSkillFolders,
      'project',
      projectRoot,
      host,
    ));

    const watchTargets: Array<{ watchPath: string; discoveryRoot: string }> = [];
    for (const rootPath of roots) {
      for (const targetPath of this.resolveWatchTargetsForDiscoveryRoot(rootPath, host)) {
        watchTargets.push({ watchPath: targetPath, discoveryRoot: rootPath });
      }
    }

    return watchTargets;
  }

  private resolveWatchTargetsForDiscoveryRoot(rootPath: string, host: ReturnType<typeof AilyHost.get>): string[] {
    const targets: string[] = [];
    const nearestExistingDirectory = this.findNearestExistingDirectory(rootPath, host);
    if (nearestExistingDirectory) {
      targets.push(nearestExistingDirectory);
    }

    try {
      if (host.fs.existsSync(rootPath) && host.fs.isDirectory(rootPath)) {
        targets.push(rootPath);
      }
    } catch {
      // Ignore transient fs errors while resolving watch targets.
    }

    return targets;
  }

  private shouldRefreshDiscoveryForWatchEvent(
    targetKey: string,
    eventType: string | undefined,
    filename: string | null | undefined,
    host: ReturnType<typeof AilyHost.get>,
  ): boolean {
    const discoveryRoots = this._watchTargetRoots.get(targetKey) ?? [];
    if (discoveryRoots.length === 0) {
      return true;
    }

    const normalizedFilename = typeof filename === 'string'
      ? normalizeSkillPath(filename).replace(/^\/+|\/+$/g, '').trim()
      : '';
    if (!normalizedFilename) {
      return true;
    }

    const normalizedEventType = typeof eventType === 'string' ? eventType.trim().toLowerCase() : '';
    return discoveryRoots.some(rootPath => {
      const watchPath = this._watchPathForTargetKey(targetKey);
      if (!watchPath) {
        return true;
      }

      const relativeSegments = this.relativeDiscoverySegments(watchPath, rootPath, host);
      if (relativeSegments.length === 0) {
        return true;
      }

      const changedSegments = normalizedFilename.split('/').filter(segment => segment.length > 0);
      if (changedSegments.length === 0) {
        return true;
      }

      if (normalizedEventType === 'rename') {
        return changedSegments[0] === relativeSegments[0];
      }

      return changedSegments[0] === relativeSegments[0];
    });
  }

  private _watchPathForTargetKey(targetKey: string): string | null {
    return this._watchTargetPaths.get(targetKey) ?? null;
  }

  private relativeDiscoverySegments(
    watchPath: string,
    rootPath: string,
    host: ReturnType<typeof AilyHost.get>,
  ): string[] {
    const normalizedWatchPath = normalizeSkillPath(watchPath).replace(/\/+$|\/+$/g, '').trim();
    const normalizedRootPath = normalizeSkillPath(rootPath).replace(/\/+$|\/+$/g, '').trim();
    if (!normalizedWatchPath || !normalizedRootPath || normalizedWatchPath === normalizedRootPath) {
      return [];
    }

    const relativePath = normalizeSkillPath(host.path.relative(watchPath, rootPath)).replace(/^\/+|\/+$/g, '').trim();
    if (!relativePath || relativePath.startsWith('..')) {
      return [];
    }

    return relativePath.split('/').filter(segment => segment.length > 0);
  }

  private findNearestExistingDirectory(rootPath: string, host: ReturnType<typeof AilyHost.get>): string | null {
    let currentPath = typeof rootPath === 'string' ? rootPath.trim() : '';
    while (currentPath) {
      try {
        if (host.fs.existsSync(currentPath) && host.fs.isDirectory(currentPath)) {
          return currentPath;
        }
      } catch {
        // Ignore unsupported stat lookups and keep walking upward.
      }

      const parentPath = host.path.dirname(currentPath);
      if (!parentPath || parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }

    return null;
  }

  private normalizeWatchTargetIdentity(targetPath: string, host: ReturnType<typeof AilyHost.get>): string {
    const normalizedPath = normalizeSkillPath(targetPath).replace(/\/+$/g, '').trim();
    if (!normalizedPath) {
      return '';
    }

    return host.platform?.isWindows ? normalizedPath.toLowerCase() : normalizedPath;
  }

  private scheduleDiscoveryRefresh(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }

    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      void this.initialize(this._watchedProjectRoot, this._initializationOptions).catch((error) => {
        console.warn('[SkillRegistry] Skills 刷新失败:', error);
      });
    }, SKILL_DISCOVERY_REFRESH_DEBOUNCE_MS);
  }

  private disposeDiscoveryWatchers(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }

    for (const subscription of this._watchSubscriptions.values()) {
      this.disposeDiscoveryWatchSubscription(subscription);
    }
    this._watchSubscriptions.clear();
    this._watchTargetPaths.clear();
    this._watchTargetRoots.clear();
  }

  private disposeDiscoveryWatchSubscription(
    subscription: (() => void) | { close?(): void; dispose?(): void; unsubscribe?(): void } | void,
  ): void {
    if (!subscription) {
      return;
    }

    if (typeof subscription === 'function') {
      subscription();
      return;
    }

    if (typeof subscription.unsubscribe === 'function') {
      subscription.unsubscribe();
      return;
    }
    if (typeof subscription.dispose === 'function') {
      subscription.dispose();
      return;
    }
    subscription.close?.();
  }

  private emitDidChange(reason: string): void {
    if (isSkillRegistryTraceEnabled()) {
      console.info('[SkillRegistry][debug] emit change', {
        reason,
        listenerCount: this._changeListeners.size,
        skillCount: this.skills.size,
        activatedSkillCount: this._activatedSkills.size,
      });
    }
    for (const listener of Array.from(this._changeListeners)) {
      listener();
    }
  }
}

/** 全局单例 */
export const SkillRegistry = new SkillRegistryImpl();

function normalizeAvailableToolNames(
  value: ReadonlySet<string> | readonly string[] | null | undefined,
): ReadonlySet<string> | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = Array.from(value)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim());
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function buildSkillsListingInstruction(input: {
  readonly hasLoadSkillTool: boolean;
  readonly hasReadFileTool: boolean;
}): string {
  if (input.hasLoadSkillTool) {
    return 'The listed skills are discovery metadata, not loaded instructions. When a listed skill clearly applies to the current task, call load_skill with action="load" and the exact skill name before relying on it. Do not load unrelated skills. Use action="search" only when no listed skill clearly fits or an additional skill must be discovered. Searching does not load a skill; after search, call load_skill again with action="load" and an exact name before claiming a skill is loaded.';
  }

  if (input.hasReadFileTool) {
    return 'When a user request falls within a skill\'s domain, use read_file to acquire the full instructions from the skill\'s SKILL.md file URI before continuing.';
  }

  return 'When a listed skill applies to the request, treat it as a blocking requirement and defer the task until the required skill instructions become readable in the current tool set.';
}

function tokenizeSkillSearchQuery(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const normalized = tokens
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length > 0);
  return normalized.length > 0 ? [...new Set(normalized)] : [query];
}
