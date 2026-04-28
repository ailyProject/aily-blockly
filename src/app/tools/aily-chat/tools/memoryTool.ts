/**
 * memory 工具 — 持久化记忆系统
 *
 * 参考 Copilot 的 memory 工具设计，采用 aily.md 文件存储。
 * 两层作用域：
 *   1. 项目记忆 — 存储在项目根目录的 aily.md 中（项目级，跨会话）
 *   2. 全局记忆 — 存储在 appDataPath/aily-memory.md 中（跨项目，跨会话）
 *
 * 每层都是一个 Markdown 文件，AI 可以自由读写。
 */

import { ToolUseResult } from './tools';
import { AilyHost } from '../core/host';

// ============================
// 类型定义
// ============================

export type MemoryScope = 'project' | 'global';

export type MemoryCommand = 'read' | 'write' | 'append' | 'replace' | 'clear';

export interface MemoryToolArgs {
  /** 操作命令 */
  command: MemoryCommand;
  /** 作用域：project（项目级） / global（全局） */
  scope: MemoryScope;
  /** 写入/追加的内容（write / append 时必填） */
  content?: string;
  /** str_replace 专用：要替换的旧文本 */
  old_text?: string;
  /** str_replace 专用：替换后的新文本 */
  new_text?: string;
}

// ============================
// 路径解析
// ============================

function getMemoryFilePath(scope: MemoryScope): string | null {
  const host = AilyHost.get();

  if (scope === 'project') {
    const projectPath = host.project?.currentProjectPath;
    if (!projectPath) return null;
    return host.path.join(projectPath, 'aily.md');
  }

  if (scope === 'global') {
    const appDataPath = host.path?.getAppDataPath?.();
    if (!appDataPath) return null;
    return host.path.join(appDataPath, 'aily-memory.md');
  }

  return null;
}

function ensureParentDir(filePath: string): void {
  const fs = AilyHost.get().fs;
  const path = AilyHost.get().path;
  const dir = path.dirname ? path.dirname(filePath) : filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================
// 工具主函数
// ============================

export async function memoryTool(args: MemoryToolArgs): Promise<ToolUseResult> {
  const { command, scope, content, old_text, new_text } = args;
  const fs = AilyHost.get().fs;

  // 参数验证
  if (!command) return { is_error: true, content: '参数错误：command 不能为空' };
  if (!scope) return { is_error: true, content: '参数错误：scope 不能为空，可选 "project" 或 "global"' };

  const filePath = getMemoryFilePath(scope);
  if (!filePath) {
    const hint = scope === 'project'
      ? '当前未打开项目，无法使用项目记忆。请先创建/打开项目。'
      : '无法获取全局存储路径。';
    return { is_error: true, content: hint };
  }

  const scopeLabel = scope === 'project' ? '项目记忆 (aily.md)' : '全局记忆 (aily-memory.md)';

  try {
    switch (command) {
      // ---- 读取 ----
      case 'read': {
        if (!fs.existsSync(filePath)) {
          return { is_error: false, content: `${scopeLabel} 为空（文件尚未创建）。`, metadata: { empty: true } };
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        if (!data.trim()) {
          return { is_error: false, content: `${scopeLabel} 为空。`, metadata: { empty: true } };
        }
        return { is_error: false, content: data, metadata: { scope, path: filePath, size: data.length } };
      }

      // ---- 覆写 ----
      case 'write': {
        if (content === undefined || content === null) {
          return { is_error: true, content: '参数错误：write 命令需要 content 参数' };
        }
        ensureParentDir(filePath);
        fs.writeFileSync(filePath, content, 'utf-8');
        return { is_error: false, content: `✅ ${scopeLabel} 已更新 (${content.length} 字符)`, metadata: { scope, path: filePath } };
      }

      // ---- 追加 ----
      case 'append': {
        if (!content) {
          return { is_error: true, content: '参数错误：append 命令需要 content 参数' };
        }
        ensureParentDir(filePath);
        let existing = '';
        if (fs.existsSync(filePath)) {
          existing = fs.readFileSync(filePath, 'utf-8');
        }
        const separator = existing && !existing.endsWith('\n') ? '\n' : '';
        const newContent = existing + separator + content;
        fs.writeFileSync(filePath, newContent, 'utf-8');
        return { is_error: false, content: `✅ 已追加到${scopeLabel} (+${content.length} 字符)`, metadata: { scope, path: filePath } };
      }

      // ---- 精确替换 ----
      case 'replace': {
        if (!old_text || new_text === undefined) {
          return { is_error: true, content: '参数错误：replace 命令需要 old_text 和 new_text 参数' };
        }
        if (!fs.existsSync(filePath)) {
          return { is_error: true, content: `${scopeLabel} 文件不存在，无法替换` };
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        if (!data.includes(old_text)) {
          return { is_error: true, content: `在${scopeLabel}中未找到要替换的文本` };
        }
        const updated = data.replace(old_text, new_text);
        fs.writeFileSync(filePath, updated, 'utf-8');
        return { is_error: false, content: `✅ ${scopeLabel} 替换成功`, metadata: { scope, path: filePath } };
      }

      // ---- 清空 ----
      case 'clear': {
        if (fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, '', 'utf-8');
        }
        return { is_error: false, content: `✅ ${scopeLabel} 已清空`, metadata: { scope, path: filePath } };
      }

      default:
        return { is_error: true, content: `未知命令: ${command}。可选: read, write, append, replace, clear` };
    }
  } catch (error: any) {
    return { is_error: true, content: `${scopeLabel}操作失败: ${error.message}` };
  }
}

/**
 * 获取记忆内容（供系统提示注入使用，非工具调用）
 * 自动读取项目/全局记忆并合并为提示词片段
 */
export function getMemoryPromptSnippet(): string {
  const fs = AilyHost.get().fs;
  const parts: string[] = [];

  // 项目记忆
  const projectPath = getMemoryFilePath('project');
  if (projectPath && fs.existsSync(projectPath)) {
    try {
      const data = fs.readFileSync(projectPath, 'utf-8').trim();
      if (data) {
        // 限制注入长度
        const truncated = data.length > 2000 ? data.substring(0, 2000) + '\n...(已截断)' : data;
        parts.push(`<projectMemory>\n${truncated}\n</projectMemory>`);
      }
    } catch { /* ignore */ }
  }

  // 全局记忆
  const globalPath = getMemoryFilePath('global');
  if (globalPath && fs.existsSync(globalPath)) {
    try {
      const data = fs.readFileSync(globalPath, 'utf-8').trim();
      if (data) {
        const truncated = data.length > 1000 ? data.substring(0, 1000) + '\n...(已截断)' : data;
        parts.push(`<globalMemory>\n${truncated}\n</globalMemory>`);
      }
    } catch { /* ignore */ }
  }

  return parts.length > 0 ? parts.join('\n') : '';
}
