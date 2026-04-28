/**
 * Aily Skill Registry - 技能注册中心
 *
 * 单例模式，管理所有已发现的 Skills。
 * 职责：发现、解析、加载、搜索 Skills。
 *
 * 扫描来源（按优先级从低到高，同名后者覆盖前者）：
 * 0. Builtin Skills: ${rendererPath}/skills/          (随应用安装包分发，public/skills/)
 * 1. Global Skills:  ${AppDataPath}/aily-skills/      (用户全局自定义)
 * 2. Project Skills: ${projectRoot}/.aily/skills/     (项目专属)
 * 3. Cross-client:   ${projectRoot}/.agents/skills/   (规范推荐，跨客户端)
 */

import {
  IAilySkill, SkillMetadata, SkillOrigin,
  SkillSearchResult,
} from './skill-types';
import { AilyHost } from './host';

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
        topLevel[key] = val.replace(/^['"]|['"]$/g, '');
      }
    }
  }

  const m = metadataMap;
  const parseList = (s?: string) => s ? s.split(',').map(v => v.trim()) : undefined;

  return {
    name: topLevel['name'] || 'unknown',
    description: topLevel['description'] || '',
    license: topLevel['license'],
    compatibility: topLevel['compatibility'],
    allowedTools: topLevel['allowed-tools'],
    metadata: Object.keys(m).length > 0 ? m : undefined,
    version: m['version'],
    scope: m['scope'] as any,
    agents: parseList(m['agents']),
    autoActivate: m['auto-activate'] === 'true',
    tags: parseList(m['tags']),
    author: m['author'],
    sourceUrl: m['source-url'],
  };
}

// ============================
// Registry 实现
// ============================

class SkillRegistryImpl {
  private skills = new Map<string, IAilySkill>();
  private _initialized = false;
  /** 会话级：Agent 主动激活的 skill 名称集合（通过 load_skill 加载，可通过 unload 卸载） */
  private _activatedSkills = new Set<string>();

  // ========== 初始化 ==========

  /**
   * 扫描所有来源的 Skills。
   * 扫描顺序：builtin → 全局 → 项目 .aily/skills/ → 项目 .agents/skills/
   * 同名 skill 后扫描的覆盖先扫描的（项目级优先于全局优先于内置）。
   */
  async initialize(projectRoot?: string): Promise<void> {
    this.skills.clear();

    const host = AilyHost.get();
    if (!host?.fs || !host?.path) {
      console.warn('[SkillRegistry] Host API 不可用，跳过 skill 发现');
      this._initialized = true;
      return;
    }

    // 0. 加载内置 skills（随安装包分发，优先级最低）
    const builtinDir = this.getBuiltinSkillsDir();
    if (builtinDir) {
      this.scanDirectory(builtinDir, { type: 'builtin' });
    }

    // 1. 加载全局 skills（用户在 AppData 下自定义的）
    const globalDir = this.getGlobalSkillsDir();
    if (globalDir) {
      this.scanDirectory(globalDir, { type: 'global' });
    }

    // 2. 加载项目 .aily/skills/
    if (projectRoot) {
      const ailySkillsDir = host.path.join(projectRoot, '.aily', 'skills');
      this.scanDirectory(ailySkillsDir, { type: 'project', projectRoot });
    }

    // 3. 加载项目 .agents/skills/（Agent Skills 规范跨客户端互操作目录）
    if (projectRoot) {
      const agentsSkillsDir = host.path.join(projectRoot, '.agents', 'skills');
      this.scanDirectory(agentsSkillsDir, { type: 'project', projectRoot });
    }

    this._initialized = true;
    console.log(`[SkillRegistry] 初始化完成, 发现 ${this.skills.size} 个 skills`);
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

        const skillMdPath = host.path.join(skillDir, 'SKILL.md');
        if (!host.fs.existsSync(skillMdPath)) continue;

        try {
          const raw = host.fs.readFileSync(skillMdPath, 'utf-8');
          const { metadata, body } = parseSkillMd(raw);
          // 文件夹名优先于 YAML name（保证一致性）
          if (metadata.name === 'unknown') {
            metadata.name = entry;
          }

          const skill: IAilySkill = {
            metadata,
            folderPath: skillDir,
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
    } catch (e) {
      console.warn(`[SkillRegistry] 扫描目录失败: ${dir}`, e);
    }
  }

  // ========== 目录工具 ==========

  /**
   * 内置 skills 目录：
   * - 打包后：resources/app/electron/../renderer/skills/
   * - 开发模式回退：electron/../public/skills/
   */
  private getBuiltinSkillsDir(): string | null {
    const host = AilyHost.get();
    const electronPath = host.path?.getElectronPath?.();
    if (!electronPath) return null;

    const prodDir = host.path.join(electronPath, '..', 'renderer', 'skills');
    if (host.fs.existsSync(prodDir)) return prodDir;

    const devDir = host.path.join(electronPath, '..', 'public', 'skills');
    if (host.fs.existsSync(devDir)) return devDir;

    return null;
  }

  /** 全局 skills 目录：${appDataPath}/aily-skills/ */
  private getGlobalSkillsDir(): string | null {
    const host = AilyHost.get();
    const appDataPath = host.path?.getAppDataPath?.();
    if (!appDataPath) return null;
    return host.path.join(appDataPath, 'aily-skills');
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
        (skill as any).content = body;
        return body;
      } catch (e) {
        console.warn(`[SkillRegistry] 加载 skill 内容失败: ${skill.skillMdPath}`, e);
        return null;
      }
    }

    return null;
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
        skillMdPath: url,
        origin: { type: 'url', sourceUrl: url },
        content: body,
      };

      this.skills.set(metadata.name, skill);
      return skill;
    } catch (e) {
      console.warn(`[SkillRegistry] 从 URL 加载 skill 失败: ${url}`, e);
      return null;
    }
  }

  /**
   * 列出 skill 目录下的附带资源文件（scripts/, references/, assets/）。
   * 激活时返回给 LLM，供其按需加载。
   */
  listSkillResources(name: string): string[] {
    const skill = this.skills.get(name);
    if (!skill?.folderPath) return [];

    const host = AilyHost.get();
    if (!host?.fs) return [];

    const resources: string[] = [];
    const resourceDirs = ['scripts', 'references', 'assets'];

    for (const dir of resourceDirs) {
      const dirPath = host.path.join(skill.folderPath, dir);
      if (!host.fs.existsSync(dirPath)) continue;
      try {
        const entries = host.fs.readdirSync(dirPath);
        for (const entry of entries) {
          const fullPath = host.path.join(dirPath, entry);
          try {
            if (!host.fs.isDirectory(fullPath)) {
              resources.push(`${dir}/${entry}`);
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    return resources;
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
    return [...this.skills.values()].filter(
      s => !s.metadata.agents || s.metadata.agents.length === 0 || s.metadata.agents.includes(agentName)
    );
  }

  /** 获取自动激活的 skills（auto-activate: true） */
  getAutoActivateSkills(agentName?: string): IAilySkill[] {
    return [...this.skills.values()].filter(s => {
      if (!s.metadata.autoActivate) return false;
      if (agentName && s.metadata.agents && s.metadata.agents.length > 0) {
        return s.metadata.agents.includes(agentName);
      }
      return true;
    });
  }

  /**
   * 搜索 skills（三级策略，同 deferred tools 模式）。
   * 1. 精确名称匹配
   * 2. 标签/描述关键词匹配
   * 3. 模糊匹配
   */
  searchSkills(query: string, agentName?: string): SkillSearchResult[] {
    const q = query.toLowerCase();
    let candidates = agentName
      ? this.getSkillsForAgent(agentName)
      : this.getAll();

    // 1. 精确名称匹配
    const exact = candidates.filter(s => s.metadata.name === q);
    if (exact.length > 0) {
      return exact.map(skill => ({ skill, matchType: 'exact' as const }));
    }

    // 2. 标签匹配
    const tagMatches = candidates.filter(s =>
      s.metadata.tags?.some(t => t.toLowerCase().includes(q))
    );
    if (tagMatches.length > 0) {
      return tagMatches.map(skill => ({ skill, matchType: 'tag' as const }));
    }

    // 3. 名称/描述模糊匹配
    const fuzzy = candidates.filter(s =>
      s.metadata.name.toLowerCase().includes(q) ||
      s.metadata.description.toLowerCase().includes(q)
    );
    return fuzzy.map(skill => ({ skill, matchType: 'fuzzy' as const }));
  }

  /**
   * 生成 skills 索引列表文本（注入到系统提示中）。
   * 格式参考 getDeferredToolsListing()。
   */
  /**
   * 生成 skills 索引列表（渐进式发现：名称 → load_skill 加载完整内容）。
   * 只列出名称，类似 deferred tools 的渐进式索引模式。
   */
  getSkillsListing(agentName?: string): string {
    const skills = agentName
      ? this.getSkillsForAgent(agentName)
      : this.getAll();

    // 排除 auto-activate 和已激活的（它们的内容已通过 getActiveSkillsContent 持久注入）
    const listable = skills.filter(s => !s.metadata.autoActivate && !this._activatedSkills.has(s.metadata.name));
    if (listable.length === 0) return '';

    const names = listable.map(s => s.metadata.name);

    return [
      '<availableSkills>',
      `可用技能: ${names.join(', ')}`,
      '调用 load_skill 加载技能的完整指南。',
      '</availableSkills>',
    ].join('\n');
  }

  // ========== 会话级激活/卸载 ==========

  /**
   * 激活一个 skill（Agent 通过 load_skill 调用）。
   * 激活后其内容会通过 getActiveSkillsContent() 持久注入到每轮请求中。
   */
  activateSkill(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    // 确保内容已加载
    this.loadSkillContent(name);
    this._activatedSkills.add(name);
    return true;
  }

  /**
   * 卸载一个 Agent 主动加载的 skill。
   * auto-activate 的 skill 不可卸载（始终活跃）。
   */
  deactivateSkill(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    if (skill.metadata.autoActivate) return false;
    return this._activatedSkills.delete(name);
  }

  /** 获取当前已激活的 skill 名称列表（含 auto-activate） */
  getActivatedSkillNames(agentName?: string): string[] {
    const autoNames = this.getAutoActivateSkills(agentName).map(s => s.metadata.name);
    return [...new Set([...autoNames, ...this._activatedSkills])];
  }

  /** 清除会话级激活状态（会话结束时调用） */
  clearSessionState(): void {
    this._activatedSkills.clear();
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
}

/** 全局单例 */
export const SkillRegistry = new SkillRegistryImpl();
