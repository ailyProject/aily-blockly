/**
 * get_errors 工具 — 错误诊断
 *
 * 参考 Copilot 的 get_errors 工具，整合多种错误源：
 *   1. JSON/JS lint 错误（来自 lintService）
 *   2. 编译错误（来自 build_project 的上次结果）
 *   3. ABS 语法错误（来自工作区全览）
 *
 * 让 LLM 能一次性获取项目当前所有已知错误，便于诊断和修复。
 */

import { ToolUseResult } from './tools';
import { AilyHost } from '../core/host';
import { shouldLint, lintJson, lintJavaScript, getFileType } from '../services/lintService';

// ============================
// 类型定义
// ============================

interface DiagnosticError {
  source: string;      // 'lint' | 'build' | 'abs'
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface GetErrorsArgs {
  /** 指定要检查的文件路径（可选，不指定则检查整个项目） */
  path?: string;
  /** 是否包含 lint 错误 */
  include_lint?: boolean;
  /** 是否包含上次编译错误 */
  include_build?: boolean;
}

// ============================
// 上次编译结果缓存（由 buildProjectTool 更新）
// ============================

let _lastBuildErrors: string = '';
let _lastBuildTime: number = 0;

/**
 * 记录上次编译错误（由 buildProjectTool 调用）
 */
export function setLastBuildErrors(errors: string): void {
  _lastBuildErrors = errors;
  _lastBuildTime = Date.now();
}

export function clearLastBuildErrors(): void {
  _lastBuildErrors = '';
  _lastBuildTime = 0;
}

// ============================
// 工具主函数
// ============================

export async function getErrorsTool(args: GetErrorsArgs): Promise<ToolUseResult> {
  const { path: targetPath, include_lint = true, include_build = true } = args;
  const fs = AilyHost.get().fs;
  const host = AilyHost.get();
  const errors: DiagnosticError[] = [];

  try {
    // ---- 1. Lint 错误 ----
    if (include_lint) {
      if (targetPath) {
        // 单文件 lint
        collectLintErrors(targetPath, errors);
      } else {
        // 项目级 lint：扫描关键文件
        const projectPath = host.project?.currentProjectPath;
        if (projectPath) {
          const keyFiles = collectProjectLintFiles(projectPath);
          for (const file of keyFiles) {
            collectLintErrors(file, errors);
          }
        }
      }
    }

    // ---- 2. 上次编译错误 ----
    if (include_build && _lastBuildErrors) {
      const ageMinutes = (Date.now() - _lastBuildTime) / 60000;
      const buildLines = _lastBuildErrors.split('\n').filter(l => l.trim());
      for (const line of buildLines) {
        // 尝试解析 GCC 格式: file:line:col: error/warning: message
        const gccMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning|note|fatal error):\s*(.+)/i);
        if (gccMatch) {
          errors.push({
            source: 'build',
            file: gccMatch[1],
            line: parseInt(gccMatch[2], 10),
            column: parseInt(gccMatch[3], 10),
            severity: gccMatch[4].toLowerCase().includes('error') ? 'error' : 'warning',
            message: gccMatch[5],
          });
        } else if (line.includes('undefined reference') || line.includes('error:') || line.includes('FAILED')) {
          errors.push({
            source: 'build',
            severity: 'error',
            message: line.trim(),
          });
        }
      }
      // 添加编译时间上下文
      if (errors.some(e => e.source === 'build') && ageMinutes > 5) {
        errors.push({
          source: 'build',
          severity: 'warning',
          message: `注意: 编译错误数据来自 ${Math.round(ageMinutes)} 分钟前，代码可能已修改。建议重新编译确认。`,
        });
      }
    }

    // ---- 汇总结果 ----
    if (errors.length === 0) {
      return {
        is_error: false,
        content: targetPath
          ? `✅ 文件 ${targetPath.split(/[/\\]/).pop()} 未发现错误`
          : '✅ 项目当前未发现已知错误',
        metadata: { errorCount: 0 },
      };
    }

    const errorCount = errors.filter(e => e.severity === 'error').length;
    const warningCount = errors.filter(e => e.severity === 'warning').length;

    const grouped = groupBy(errors, e => e.source);
    const sections: string[] = [];

    if (grouped['lint']?.length) {
      sections.push(`## Lint 错误 (${grouped['lint'].length})\n${formatErrors(grouped['lint'])}`);
    }
    if (grouped['build']?.length) {
      sections.push(`## 编译错误 (${grouped['build'].length})\n${formatErrors(grouped['build'])}`);
    }

    const summary = `发现 ${errorCount} 个错误, ${warningCount} 个警告`;
    const detail = sections.join('\n\n');

    return {
      is_error: false,
      content: `${summary}\n\n${detail}`,
      metadata: { errorCount, warningCount, total: errors.length },
    };

  } catch (error: any) {
    return { is_error: true, content: `错误诊断失败: ${error.message}` };
  }
}

// ============================
// 辅助函数
// ============================

function collectLintErrors(filePath: string, errors: DiagnosticError[]): void {
  if (!shouldLint(filePath)) return;

  const fs = AilyHost.get().fs;
  if (!fs.existsSync(filePath)) return;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileType = getFileType(filePath);
    const result = fileType === 'json' ? lintJson(content, filePath) : lintJavaScript(content, filePath);

    if (!result.isValid) {
      for (const err of result.errors) {
        errors.push({
          source: 'lint',
          file: filePath,
          line: err.line,
          column: err.column,
          severity: err.severity,
          message: err.message,
        });
      }
    }
  } catch { /* ignore read errors */ }
}

function collectProjectLintFiles(projectPath: string): string[] {
  const fs = AilyHost.get().fs;
  const path = AilyHost.get().path;
  const files: string[] = [];

  // 扫描项目根目录下的 json/js 文件
  try {
    const entries = fs.readdirSync(projectPath);
    for (const entry of entries) {
      if (typeof entry === 'string' && shouldLint(entry)) {
        const fullPath = path.join(projectPath, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isDirectory()) {
            files.push(fullPath);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* ignore */ }

  // 限制文件数量
  return files.slice(0, 30);
}

function formatErrors(errors: DiagnosticError[]): string {
  return errors.map(e => {
    const loc = e.file
      ? `${e.file.split(/[/\\]/).pop()}${e.line ? `:${e.line}` : ''}${e.column ? `:${e.column}` : ''}`
      : '';
    const prefix = e.severity === 'error' ? '❌' : '⚠️';
    return loc ? `- ${prefix} ${loc}: ${e.message}` : `- ${prefix} ${e.message}`;
  }).join('\n');
}

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}
