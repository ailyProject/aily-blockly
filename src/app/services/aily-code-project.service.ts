import { Injectable } from '@angular/core';
import { PlatformService } from './platform.service';

/**
 * Aily Code 项目创建参数。
 * 只承载新建项目最小集合：名称 + 保存目录，避免与 blockly 的 NewProjectData 互相串味。
 */
export interface AilyCodeNewProjectData {
  /** 用户输入的项目名（允许中文等），最终作为目录名。空格会被替换为 `_`。 */
  name: string;
  /** 项目保存的父目录（绝对路径），最终目录 = path + name。 */
  path: string;
  /**
   * 来自 Blockly 新建向导的步骤数据：
   * 驱动 `project.aci.target`，并写入与 `package.json` 对齐的 dependencies / boardDependencies / devmode。
   */
  wizardTarget?: {
    /** 开发板 npm 包名（写入 dependencies / boardDependencies） */
    boardPkgName: string;
    /** frameworkPlatforms 中的逻辑 boardId（如 unor4wifi），写入 target.board */
    targetBoardId: string;
    /** 向导中展示的开发板昵称，便于用户在 .aci 中辨识 */
    boardNickname: string;
    /** 所选板卡包的 semver / tag */
    boardPkgVersion: string;
    /** Blockly 侧的 devmode，如 arduino、micropython */
    framework: string;
    /** frameworkPlatforms 中对应 framework 的 platform npm 包名 */
    platform?: string;
    /** platform npm 包版本（可选；未指定则安装时解析 registry 最新） */
    platformVersion?: string;
  };
}

/**
 * 创建结果。
 * - ok=true 时返回最终项目根目录绝对路径，方便上层"在资源管理器打开"。
 * - ok=false 时返回错误原因，让上层决定提示文案。
 */
export interface AilyCodeNewProjectResult {
  ok: boolean;
  projectPath?: string;
  error?: string;
}

/**
 * 与 Blockly 模板根目录 package.json 同构的一组字段；
 * project.aci 中与 npm 对齐的部分应与此保持一致（双写）。
 */
interface BlocklyAlignedPackageManifest {
  name: string;
  nickname: string;
  version: string;
  private: true;
  description: string;
  devmode?: string;
  dependencies: Record<string, string>;
  boardDependencies?: Record<string, string>;
}

/**
 * AilyCodeProjectService
 * ---------------------------------------------
 * 专门用于按照 aily-code docs/aily-code最终目录与生命周期设计.md 第 3.1 节
 * 推荐的目录结构创建一个全新的 aily-code 项目骨架。
 *
 * 设计原则（与 blockly 工程落地独立，但字段与 Blockly package.json 口径对齐便于互操作）：
 *   1. 不调用 ProjectService/NpmService 的安装逻辑；manifest 写入磁盘后可由用户在项目目录内自行 `npm install`；
 *   2. 不调用 projectService.projectOpen，避免触发 blockly 状态机；
 *   3. 仅依赖 PlatformService（路径分隔符）与 preload 暴露的 window['fs']、window['path']；
 *   4. 全部产物落地到用户选定的目录，绝不写入 AppData，便于团队协作 / Git 版本化。
 */
@Injectable({ providedIn: 'root' })
export class AilyCodeProjectService {

  constructor(private platformService: PlatformService) { }

  /**
   * 在 `data.path` 下创建以 `data.name` 命名的 aily-code 项目目录。
   * 整个流程是同步串行的：失败会立刻 reject，并尽可能保留已生成的中间文件以便人工排查。
   */
  async projectNew(data: AilyCodeNewProjectData): Promise<AilyCodeNewProjectResult> {
    try {
      const fs = window['fs'];
      const pathApi = window['path'];

      // 1. 入参校验：名称与父目录必须非空
      const rawName = String(data?.name ?? '').trim();
      const parentDir = String(data?.path ?? '').trim();
      if (!rawName) {
        return { ok: false, error: 'NAME_EMPTY' };
      }
      if (!parentDir) {
        return { ok: false, error: 'PATH_EMPTY' };
      }

      // 2. 规范化最终项目目录名：去空格，避免后续构建路径异常
      const safeName = rawName.replace(/\s+/g, '_');
      const projectPath = pathApi.join(parentDir, safeName);

      // 3. 同名目录已存在则直接拒绝，避免覆盖用户数据
      if (pathApi.isExists(projectPath)) {
        return { ok: false, error: 'PATH_EXISTS', projectPath };
      }

      // 4. 创建目录骨架（递归 mkdir）
      this.ensureDirs(projectPath);

      // 5. 写入根目录文件（若向导传入板卡上下文则带进 project.aci）
      const wizardCtx = data.wizardTarget;
      this.writeRootFiles(projectPath, safeName, rawName, wizardCtx);

      // 6. 写入 .aily/state 下的初始状态文件
      this.writeAilyStateFiles(projectPath);

      return { ok: true, projectPath };
    } catch (error: any) {
      console.error('[AilyCodeProjectService] projectNew 失败:', error);
      return { ok: false, error: error?.message || 'UNKNOWN' };
    }
  }

  /**
   * 仅负责递归 mkdir 项目骨架目录。
   * 顺序无要求，但分组列出来便于和 docs 第 3.1 节对齐审计。
   */
  private ensureDirs(root: string): void {
    const fs = window['fs'];
    const pathApi = window['path'];
    const join = (...parts: string[]) => pathApi.join(...parts);

    // 用户可见目录
    const userDirs = [
      root,
      join(root, 'src'),
      join(root, 'components'),
      join(root, 'include'),
      join(root, 'assets'),
      join(root, 'scripts'),
    ];

    // 隐藏工作区（.aily），所有内容应可重建
    const ailyDirs = [
      join(root, '.aily'),
      join(root, '.aily', 'generated'),
      join(root, '.aily', 'generated', 'cpp'),
      join(root, '.aily', 'generated', 'headers'),
      join(root, '.aily', 'bridge'),
      join(root, '.aily', 'bridge', 'cmake'),
      join(root, '.aily', 'build'),
      join(root, '.aily', 'build', 'debug'),
      join(root, '.aily', 'build', 'release'),
      join(root, '.aily', 'build', 'simulator'),
      join(root, '.aily', 'cache'),
      join(root, '.aily', 'cache', 'index'),
      join(root, '.aily', 'cache', 'downloads'),
      join(root, '.aily', 'cache', 'fingerprints'),
      join(root, '.aily', 'logs'),
      join(root, '.aily', 'state'),
    ];

    for (const dir of [...userDirs, ...ailyDirs]) {
      // mkdirSync 已是 recursive，重复存在不会抛错
      fs.mkdirSync(dir);
    }

    // 空目录用 .gitkeep 占位，方便后续 Git 化
    // const gitkeepDirs = [
    //   join(root, 'components'),
    //   join(root, 'include'),
    //   join(root, 'assets'),
    //   join(root, 'scripts'),
    // ];
    // for (const dir of gitkeepDirs) {
    //   fs.writeFileSync(join(dir, '.gitkeep'), '');
    // }
  }

  /**
   * 将向导里拿到的板卡包版本转成 npm/package.json 里常见的 semver 下限（ Blockly 多用 ^）。
   */
  private normalizeNpmDepRange(versionSpec: string): string {
    const v = String(versionSpec ?? '').trim();
    if (!v) {
      return '*';
    }
    if (/^[\^~]|^>=|^<=|^>|^</.test(v) || v === '*' || v === 'latest') {
      return v;
    }
    return `^${v}`;
  }

  /**
   * 拼装与 Blockly 模板根目录 `package.json` 同构的一份清单；主板写入 `dependencies` 与 `boardDependencies`。
   */
  private buildBlocklyAlignedPackageManifest(
    safeName: string,
    displayName: string,
    wizardTarget?: AilyCodeNewProjectData['wizardTarget']
  ): BlocklyAlignedPackageManifest {
    const hasBoard = !!(wizardTarget?.boardPkgName && wizardTarget.boardPkgVersion);

    let dependencies: Record<string, string> = {};
    let boardDeps: Record<string, string> | undefined;

    if (hasBoard && wizardTarget) {
      const range = this.normalizeNpmDepRange(wizardTarget.boardPkgVersion);
      dependencies = { [wizardTarget.boardPkgName]: range };
      boardDeps = { [wizardTarget.boardPkgName]: range };
    }

    const description =
      displayName.trim() ||
      (hasBoard && wizardTarget ? `Blockly 向导：${wizardTarget.boardNickname || wizardTarget.boardPkgName}` : '') ||
      '';

    return {
      name: safeName,
      nickname: displayName,
      version: '0.0.1',
      private: true,
      description,
      ...(hasBoard && String(wizardTarget?.framework ?? '').trim() !== ''
        ? { devmode: wizardTarget!.framework }
        : {}),
      dependencies,
      ...(boardDeps && Object.keys(boardDeps).length > 0 ? { boardDependencies: boardDeps } : {})
    };
  }

  /**
   * 根目录用户可见文件：project.aci / aily.lock.json / package.json / README.md / .gitignore / src/main.cpp。
   * `.aily/generated/source-map.json` 等基础桥接占位也一并写入。
   */
  private writeRootFiles(
    root: string,
    safeName: string,
    displayName: string,
    wizardTarget?: AilyCodeNewProjectData['wizardTarget']
  ): void {
    const fs = window['fs'];
    const pathApi = window['path'];

    // Blockly 向导：把用户选的板卡/npm 版本映射到 target，便于 IDE 后续解析
    const hasWizard = !!(wizardTarget?.boardPkgName && wizardTarget.boardPkgVersion);
    const targetBlock = hasWizard
      ? {
          board: String(wizardTarget!.targetBoardId ?? '').trim() || wizardTarget!.boardPkgName,
          boardPackage: wizardTarget!.boardPkgName,
          chip: '',
          framework: wizardTarget!.framework ?? '',
          boardPackageVersion: wizardTarget!.boardPkgVersion,
          ...(String(wizardTarget!.platform ?? '').trim() !== ''
            ? { platform: String(wizardTarget!.platform).trim() }
            : {}),
          ...(String(wizardTarget!.platformVersion ?? '').trim() !== ''
            ? { platformVersion: String(wizardTarget!.platformVersion).trim() }
            : {}),
        }
      : {
          board: '',
          chip: '',
          framework: '',
          sdk: ''
        };

    // 板卡选择与依赖声明对齐 Blockly 侧的 package.json 习惯；无向导时为最小 npm 占位
    const pkg = this.buildBlocklyAlignedPackageManifest(safeName, displayName, wizardTarget);

    // project.aci：IDE 专有字段之外，npm/Blockly 层与 package.json 同构，主板在 dependencies 与 boardDependencies 中声明
    const projectAci: Record<string, unknown> = {
      $schema: 'https://aily.pro/schemas/project.aci.json',
      name: pkg.name,
      nickname: pkg.nickname,
      version: pkg.version,
      private: pkg.private,
      description: pkg.description,
      ...(pkg.devmode != null && pkg.devmode !== ''
        ? { devmode: pkg.devmode }
        : {}),
      dependencies: pkg.dependencies,
      ...(Object.keys(pkg.boardDependencies || {}).length > 0
        ? { boardDependencies: pkg.boardDependencies }
        : {}),
      target: targetBlock,
      entry: 'src/main.cpp',
      sourceRoots: ['src', 'components', 'include'],
      buildProfiles: ['debug', 'release', 'simulator'],
      upload: {},
      monitor: { baudRate: 115200 }
    };

    const ailyLock = {
      // 文档 4.2：解析结果快照，初始为空
      $schema: 'https://aily.pro/schemas/aily.lock.json',
      generatedAt: new Date().toISOString(),
      target: null,
      toolchains: [],
      packages: [],
      fingerprint: ''
    };

    // 根目录 package.json：与 project.aci 中 Blockly 对齐字段完全一致（磁盘双写，便于现有 npm/blockly 工具链）

    const readme = [
      `# ${displayName}`,
      '',
      '> 由 Aily Blockly 创建的 Aily Code 项目骨架。',
      '',
      '## 目录说明',
      '',
      '- `project.aci`：项目唯一真相源，由 IDE 维护。',
      '- `src/main.cpp`：默认源码入口。',
      '- `components/`：项目本地可复用模块。',
      '- `include/`：公共头文件。',
      '- `assets/`：图片、字库、资源文件。',
      '- `scripts/`：项目级辅助脚本。',
      '- `.aily/`：IDE 隐藏工作区（构建/索引/缓存均可重建，已加入 .gitignore）。',
      ''
    ].join('\n');

    // 忽略所有生成物 / 桥接层 / 缓存，保持 Git 历史干净
    const gitignore = [
      '# Aily Code 隐藏工作区（全部可由 .aci 重建，禁止提交）',
      '.aily/',
      '',
      '# 常见系统/编辑器临时文件',
      '.DS_Store',
      'Thumbs.db',
      '*.log',
      ''
    ].join('\n');

    // Arduino 风格默认入口，与 Blockly 生成代码结构一致
    const mainCpp = [
      '#include <Arduino.h>',
      '',
      'void setup() {',
      '  ',
      '}',
      '',
      'void loop() {',
      '  ',
      '}',
      ''
    ].join('\n');

    // source-map.json 桥接层占位：后续由 ShadowWorkspaceService 增量刷新
    const sourceMap = {
      version: 1,
      entries: []
    };

    const compileCommands: any[] = [];

    fs.writeFileSync(pathApi.join(root, 'project.aci'), JSON.stringify(projectAci, null, 2));
    fs.writeFileSync(pathApi.join(root, 'aily.lock.json'), JSON.stringify(ailyLock, null, 2));
    fs.writeFileSync(pathApi.join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(pathApi.join(root, 'README.md'), readme);
    fs.writeFileSync(pathApi.join(root, '.gitignore'), gitignore);
    fs.writeFileSync(pathApi.join(root, 'src', 'main.cpp'), mainCpp);

    fs.writeFileSync(
      pathApi.join(root, '.aily', 'generated', 'source-map.json'),
      JSON.stringify(sourceMap, null, 2)
    );
    fs.writeFileSync(
      pathApi.join(root, '.aily', 'bridge', 'compile_commands.json'),
      JSON.stringify(compileCommands, null, 2)
    );
  }

  /**
   * 写入 .aily/state 下的三个状态文件（文档 3.1 节明确列出）。
   * 全部默认空骨架，由后续运行时增量更新。
   */
  private writeAilyStateFiles(root: string): void {
    const fs = window['fs'];
    const pathApi = window['path'];
    const stateDir = pathApi.join(root, '.aily', 'state');

    const workspace = {
      lastOpenedAt: new Date().toISOString(),
      stage: 'Draft' // 对应文档第 7 节的状态机
    };
    const deviceHistory = { ports: [], probes: [] };
    const lastSession = { openFiles: [], activeFile: '' };

    fs.writeFileSync(pathApi.join(stateDir, 'workspace.json'), JSON.stringify(workspace, null, 2));
    fs.writeFileSync(pathApi.join(stateDir, 'device-history.json'), JSON.stringify(deviceHistory, null, 2));
    fs.writeFileSync(pathApi.join(stateDir, 'last-session.json'), JSON.stringify(lastSession, null, 2));
  }

  /**
   * 生成形如 `aily_code_20251029a` 的默认项目名，避免和已有目录撞名。
   * 用法与 ProjectService.generateUniqueProjectName 等价，但不共享其内部状态。
   */
  generateUniqueProjectName(parentPath: string, prefix = 'aily_code_'): string {
    const pathApi = window['path'];
    const pt = this.platformService.getPlatformSeparator();
    const date = new Date();
    const baseDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    const base = `${prefix}${baseDate}`;

    // a-z 后缀优先，撞了再使用数字
    for (let charCode = 97; charCode <= 122; charCode++) {
      const name = `${base}${String.fromCharCode(charCode)}`;
      if (!pathApi.isExists(parentPath + pt + name)) {
        return name;
      }
    }
    let i = 0;
    while (true) {
      const name = `${base}a${i}`;
      if (!pathApi.isExists(parentPath + pt + name)) return name;
      if (++i > 1000) return `${base}a${Date.now()}`;
    }
  }
}
