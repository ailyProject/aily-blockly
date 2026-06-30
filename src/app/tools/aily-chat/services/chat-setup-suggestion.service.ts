import { Injectable } from '@angular/core';

import { AilyHost } from '../core/host';

const STORAGE_KEY_PREFIX = 'aily-chat:test-setup-suggestion:v1:';
const EXCLUDED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.angular',
  '.next',
  '.nuxt',
  'target',
  'bin',
  'obj',
]);
const PACKAGE_TEST_TOOL_NAMES = [
  'vitest',
  'jest',
  'mocha',
  'chai',
  'ava',
  'playwright',
  '@playwright/test',
  'cypress',
  'karma',
  'jasmine',
  'pytest',
  'nose',
  'unittest',
];
const CONFIG_FILE_PATTERNS = [
  /^vitest\.config\./i,
  /^jest\.config\./i,
  /^playwright\.config\./i,
  /^cypress\.config\./i,
  /^karma\.conf\./i,
  /^pytest\.ini$/i,
  /^tox\.ini$/i,
  /^conftest\.py$/i,
  /^phpunit\.xml(?:\.dist)?$/i,
];
const TEST_FILE_PATTERNS = [
  /(^|\.)test\.[^.]+$/i,
  /(^|\.)spec\.[^.]+$/i,
  /^test_[^.]+\.[^.]+$/i,
  /_test\.[^.]+$/i,
];
const PLACEHOLDER_TEST_SCRIPT = /echo\s+["']?error:\s*no test specified["']?\s*(?:&&|;)?\s*exit\s+1/i;
const TEST_GENERATION_PATTERNS = [
  /^\/tests\b/i,
  /(?:写|生成|创建|添加|补齐|补上|帮我写|帮我生成).{0,18}(?:单元测试|测试用例|测试|spec)/,
  /(?:为|给).{0,18}(?:函数|方法|组件|服务|类|模块|代码|文件).{0,18}(?:写|生成|创建|补).{0,12}(?:测试|spec)/,
  /\b(?:write|create|generate|add)\b[\s\S]{0,40}\b(?:unit tests?|tests?|specs?)\b/i,
  /\b(?:tests?|specs?)\b[\s\S]{0,20}\bfor\b/i,
];
const TEST_SETUP_PATTERNS = [
  /^\/setupTests\b/i,
  /(?:设置|配置|安装|搭建|补齐|初始化).{0,18}(?:测试环境|测试配置|测试基线|测试框架)/,
  /\b(?:setup|configure|install|bootstrap)\b[\s\S]{0,30}\b(?:test|tests|testing|jest|vitest|pytest)\b/i,
];

export interface ChatTestSetupInterception {
  projectKey: string;
  title: string;
  subtitle?: string;
  message: string;
  prompt: string;
}

interface ProjectDetection {
  prompt: string;
  descriptionTarget: string;
}

@Injectable()
export class ChatSetupSuggestionService {
  inspectRequest(content: string): ChatTestSetupInterception | null {
    const normalizedContent = normalizeRequestContent(content);
    if (!normalizedContent
      || !looksLikeTestGenerationRequest(normalizedContent)
      || looksLikeExplicitTestSetupRequest(normalizedContent)) {
      return null;
    }

    const projectPath = this.resolveProjectPath();
    const projectKey = projectPath ? normalizePathForKey(projectPath) : null;
    return this.buildInterception(projectPath, projectKey);
  }

  markSuggestionPresented(projectKey: string): void {
    if (!projectKey) {
      return;
    }

    writePromptedState(projectKey, true);
  }

  private buildInterception(
    projectPath: string | null,
    projectKey: string | null,
  ): ChatTestSetupInterception | null {
    if (!projectPath || !projectKey) {
      return null;
    }

    const host = AilyHost.get();
    const fileSystem = host.fs;
    if (!fileSystem?.existsSync || !fileSystem.existsSync(projectPath)) {
      return null;
    }

    const detection = detectProject(projectPath);
    if (!detection) {
      return null;
    }

    if (projectAlreadyHasTests(projectPath) || projectAlreadyHasTestingTooling(projectPath) || readPromptedState(projectKey)) {
      return null;
    }

    return {
      projectKey,
      title: '当前项目还没有测试基线',
      subtitle: detection.descriptionTarget,
      message: `你这次请求看起来是在生成测试，但当前 ${detection.descriptionTarget} 还没有明显的测试配置或测试文件。建议先补齐 Aily 可验证的测试环境，再继续生成具体测试。`,
      prompt: detection.prompt,
    };
  }

  private resolveProjectPath(): string | null {
    const project = AilyHost.get().project;
    const currentProjectPath = normalizePath(project?.currentProjectPath);
    const projectRootPath = normalizePath(project?.projectRootPath);
    if (currentProjectPath && projectRootPath && normalizePathForKey(currentProjectPath) !== normalizePathForKey(projectRootPath)) {
      return currentProjectPath;
    }
    return currentProjectPath || projectRootPath || null;
  }
}

function detectProject(projectPath: string): ProjectDetection | null {
  const packageJson = readPackageJson(projectPath);
  if (packageJson) {
    const framework = detectPackageFramework(packageJson);
    if (framework) {
      return {
        descriptionTarget: framework,
        prompt: buildFrameworkPrompt(framework),
      };
    }

    return {
      descriptionTarget: 'TypeScript/JavaScript 项目',
      prompt: '请先检查当前 TypeScript/JavaScript 项目是否缺少测试环境。如果缺少，请沿用现有工具链补齐最小可运行的测试配置、加入一个示例测试，并告诉我如何运行这些测试。',
    };
  }

  if (fileExists(projectPath, 'pyproject.toml') || fileExists(projectPath, 'requirements.txt') || fileExists(projectPath, 'setup.py')) {
    return {
      descriptionTarget: 'Python 项目',
      prompt: '请先检查当前 Python 项目是否缺少测试环境。如果缺少，请用 pytest 补齐最小可运行的测试配置、添加一个示例测试，并说明如何运行。',
    };
  }

  if (fileExists(projectPath, 'Cargo.toml')) {
    return {
      descriptionTarget: 'Rust 项目',
      prompt: '请先检查当前 Rust 项目是否缺少基础测试。如果缺少，请补一个最小可运行的测试模块或集成测试，并说明如何运行 cargo test。',
    };
  }

  if (fileExists(projectPath, 'go.mod')) {
    return {
      descriptionTarget: 'Go 项目',
      prompt: '请先检查当前 Go 项目是否缺少基础测试。如果缺少，请补一个最小可运行的测试文件，并说明如何运行 go test。',
    };
  }

  if (fileExists(projectPath, 'pom.xml') || fileExists(projectPath, 'build.gradle') || fileExists(projectPath, 'build.gradle.kts')) {
    return {
      descriptionTarget: 'Java 项目',
      prompt: '请先检查当前 Java 项目是否缺少测试环境。如果缺少，请补齐最小可运行的 JUnit 测试配置、添加一个示例测试，并说明如何运行。',
    };
  }

  return null;
}

function buildFrameworkPrompt(framework: string): string {
  switch (framework) {
    case 'Angular':
      return '请先检查当前 Angular 项目是否缺少测试环境。如果缺少，请沿用现有 Angular 工具链补齐最小可运行的单元测试配置、添加一个示例 spec，并说明如何运行。';
    case 'React':
      return '请先检查当前 React 项目是否缺少测试环境。如果缺少，请为现有 React 工程补齐最小可运行的组件或单元测试配置、添加一个示例测试，并说明如何运行。';
    case 'Vue':
      return '请先检查当前 Vue 项目是否缺少测试环境。如果缺少，请补齐最小可运行的 Vue 单元测试配置、添加一个示例测试，并说明如何运行。';
    case 'Next.js':
      return '请先检查当前 Next.js 项目是否缺少测试环境。如果缺少，请补齐最小可运行的测试配置、添加一个示例测试，并说明如何运行。';
    case 'NestJS':
      return '请先检查当前 NestJS 项目是否缺少测试环境。如果缺少，请补齐最小可运行的服务端测试配置、添加一个示例测试，并说明如何运行。';
    default:
      return `请先检查当前 ${framework} 项目是否缺少测试环境。如果缺少，请补齐最小可运行的测试配置、添加一个示例测试，并说明如何运行。`;
  }
}

function detectPackageFramework(packageJson: any): string | undefined {
  const dependencyNames = new Set<string>([
    ...Object.keys(asRecord(packageJson?.dependencies)),
    ...Object.keys(asRecord(packageJson?.devDependencies)),
  ]);

  if (dependencyNames.has('@angular/core')) {
    return 'Angular';
  }
  if (dependencyNames.has('next')) {
    return 'Next.js';
  }
  if (dependencyNames.has('@nestjs/core')) {
    return 'NestJS';
  }
  if (dependencyNames.has('react')) {
    return 'React';
  }
  if (dependencyNames.has('vue')) {
    return 'Vue';
  }
  if (dependencyNames.has('@sveltejs/kit') || dependencyNames.has('svelte')) {
    return 'Svelte';
  }
  if (dependencyNames.has('express')) {
    return 'Express';
  }
  return undefined;
}

function projectAlreadyHasTestingTooling(projectPath: string): boolean {
  const packageJson = readPackageJson(projectPath);
  if (packageJson) {
    const scripts = asRecord(packageJson.scripts);
    const testScript = typeof scripts['test'] === 'string' ? scripts['test'].trim() : '';
    if (testScript && !PLACEHOLDER_TEST_SCRIPT.test(testScript)) {
      return true;
    }

    const dependencyNames = [
      ...Object.keys(asRecord(packageJson.dependencies)),
      ...Object.keys(asRecord(packageJson.devDependencies)),
    ];
    if (dependencyNames.some((name) => PACKAGE_TEST_TOOL_NAMES.includes(name))) {
      return true;
    }
  }

  return readProjectEntries(projectPath).some((entry) => CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(entry.name)));
}

function projectAlreadyHasTests(projectPath: string): boolean {
  const directEntries = readProjectEntries(projectPath);
  if (directEntries.some((entry) => isTestEntry(entry.name))) {
    return true;
  }

  return scanForTests(projectPath, 3);
}

function scanForTests(rootPath: string, remainingDepth: number): boolean {
  if (remainingDepth <= 0) {
    return false;
  }

  for (const entry of readProjectEntries(rootPath)) {
    if (isTestEntry(entry.name)) {
      return true;
    }

    if (!entry.isDirectory() || EXCLUDED_SCAN_DIRS.has(entry.name.toLowerCase())) {
      continue;
    }

    const childPath = joinPath(rootPath, entry.name);
    if (scanForTests(childPath, remainingDepth - 1)) {
      return true;
    }
  }

  return false;
}

function isTestEntry(name: string): boolean {
  const normalized = name.trim();
  return normalized === 'test'
    || normalized === 'tests'
    || normalized === '__tests__'
    || normalized === 'spec'
    || normalized === 'specs'
    || TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
    || CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function readPackageJson(projectPath: string): any | null {
  const packageJsonPath = joinPath(projectPath, 'package.json');
  if (!fileExists(projectPath, 'package.json')) {
    return null;
  }

  try {
    return JSON.parse(AilyHost.get().fs.readFileSync(packageJsonPath, 'utf-8'));
  } catch {
    return null;
  }
}

function fileExists(projectPath: string, fileName: string): boolean {
  const fileSystem = AilyHost.get().fs;
  return Boolean(fileSystem?.existsSync?.(joinPath(projectPath, fileName)));
}

function readProjectEntries(projectPath: string): Array<{ name: string; isDirectory(): boolean }> {
  const host = AilyHost.get();
  const fileSystem = host.fs;
  if (!fileSystem?.existsSync || !fileSystem.existsSync(projectPath)) {
    return [];
  }

  try {
    if (fileSystem.readDirSync) {
      return fileSystem.readDirSync(projectPath);
    }

    return fileSystem.readdirSync(projectPath).map((name) => ({
      name,
      isDirectory: () => fileSystem.statSync(joinPath(projectPath, name)).isDirectory(),
    }));
  } catch {
    return [];
  }
}

function joinPath(basePath: string, segment: string): string {
  const pathUtils = AilyHost.get().path;
  if (pathUtils?.join) {
    return pathUtils.join(basePath, segment);
  }
  return `${basePath.replace(/[\\/]+$/, '')}/${segment}`;
}

function normalizePath(pathValue: string | null | undefined): string | null {
  if (typeof pathValue !== 'string') {
    return null;
  }
  const trimmed = pathValue.trim();
  return trimmed ? trimmed : null;
}

function normalizePathForKey(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

function normalizeRequestContent(content: string): string {
  return typeof content === 'string' ? content.trim() : '';
}

function looksLikeTestGenerationRequest(content: string): boolean {
  return TEST_GENERATION_PATTERNS.some((pattern) => pattern.test(content));
}

function looksLikeExplicitTestSetupRequest(content: string): boolean {
  return TEST_SETUP_PATTERNS.some((pattern) => pattern.test(content));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readPromptedState(projectKey: string): boolean {
  try {
    return window.localStorage?.getItem(`${STORAGE_KEY_PREFIX}${projectKey}`) === '1';
  } catch {
    return false;
  }
}

function writePromptedState(projectKey: string, value: boolean): void {
  try {
    if (value) {
      window.localStorage?.setItem(`${STORAGE_KEY_PREFIX}${projectKey}`, '1');
      return;
    }

    window.localStorage?.removeItem(`${STORAGE_KEY_PREFIX}${projectKey}`);
  } catch {
    // ignore storage failures
  }
}
