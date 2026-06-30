/**
 * 诊断数据收集 — 从 getErrorsTool.ts 提取的纯逻辑部分
 *
 * - 编译错误缓存（setLastBuildErrors / clearLastBuildErrors）
 * - collectDiagnostics（供 lex IDiagnosticsExtension 桥接使用）
 */

import { AilyHost } from './host';
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
// 原始诊断数据收集（供 lex IDiagnosticsExtension 桥接使用）
// ============================

/**
 * 收集原始诊断项（lint + build 缓存），返回结构化数据。
 * 由 lex 引擎的 get_errors 核心工具通过 IDiagnosticsExtension.getErrors() 桥接调用。
 */
export async function collectDiagnostics(filePaths?: string[]): Promise<{
  file: string; line: number; column: number; severity: string; message: string; code?: string;
}[]> {
  const host = AilyHost.get();
  const errors: DiagnosticError[] = [];

  try {
    // Lint errors
    if (filePaths && filePaths.length > 0) {
      for (const fp of filePaths) {
        collectLintErrors(fp, errors);
      }
    } else {
      const projectPath = host.project?.currentProjectPath;
      if (projectPath) {
        const keyFiles = collectProjectLintFiles(projectPath);
        for (const file of keyFiles) {
          collectLintErrors(file, errors);
        }
      }
    }

    // Build error cache
    if (_lastBuildErrors) {
      const buildLines = _lastBuildErrors.split('\n').filter(l => l.trim());
      for (const line of buildLines) {
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
          errors.push({ source: 'build', severity: 'error', message: line.trim() });
        }
      }
    }
  } catch { /* ignore */ }

  return errors.map(e => ({
    file: e.file || '',
    line: e.line || 0,
    column: e.column || 0,
    severity: e.severity,
    message: e.message,
    code: e.source, // map source to code field
  }));
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
