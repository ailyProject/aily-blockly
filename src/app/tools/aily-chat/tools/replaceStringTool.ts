/**
 * replace_string_in_file 工具 — 精确字符串替换（从 editFileTool 拆分）
 *
 * 参考 Copilot 的 replace_string_in_file 工具设计：
 * - 单文件单次精确替换
 * - 必须唯一匹配
 * - 自动 lint 检测
 */

import { ToolUseResult } from './tools';
import { normalizePath } from '../services/security.service';
import { lintAndFormat, shouldLint } from '../services/lintService';
import { AilyHost } from '../core/host';
import { readFile as asyncReadFile, writeFile as asyncWriteFile, exists as asyncExists, mkdir as asyncMkdir } from '../core/async-fs';

function createResultWithLint(filePath: string, content: string, successMessage: string): ToolUseResult {
  let lintMessage = '';
  if (shouldLint(filePath) && content) {
    lintMessage = lintAndFormat(content, filePath);
  }
  if (lintMessage) {
    return { is_error: true, content: `${successMessage}${lintMessage}` };
  }
  return { is_error: false, content: successMessage };
}

async function detectEncoding(filePath: string): Promise<BufferEncoding> {
  try {
    await asyncReadFile(filePath, 'utf-8');
    return 'utf-8';
  } catch {
    try {
      await asyncReadFile(filePath, 'utf16le');
      return 'utf16le';
    } catch { return 'utf-8'; }
  }
}

export interface ReplaceStringArgs {
  path: string;
  old_string: string;
  new_string: string;
}

/**
 * 单次精确替换文件中的字符串
 */
export async function replaceStringInFileTool(args: ReplaceStringArgs): Promise<ToolUseResult> {
  try {
    const { path: filePath, old_string, new_string } = args;
    const fs = AilyHost.get().fs;
    const pathUtil = AilyHost.get().path;

    if (!filePath) {
      return { is_error: true, content: '参数错误：path 不能为空' };
    }

    const normalized = normalizePath(filePath);

    if (!normalized || normalized.trim() === '') {
      return { is_error: true, content: `无效的文件路径: "${filePath}"` };
    }

    if (old_string === undefined || new_string === undefined) {
      return { is_error: true, content: '参数错误：需要同时提供 old_string 和 new_string' };
    }

    if (old_string === new_string) {
      return { is_error: true, content: '新旧字符串完全相同，无需修改' };
    }

    // 新建文件（old_string 为空）
    if (old_string === '') {
      if (await asyncExists(normalized)) {
        return { is_error: true, content: `文件已存在: ${normalized}。old_string 为空仅用于创建新文件` };
      }
      const dir = pathUtil.dirname ? pathUtil.dirname(normalized) : normalized.substring(0, normalized.lastIndexOf('\\'));
      if (!await asyncExists(dir)) { await asyncMkdir(dir, { recursive: true }); }
      await asyncWriteFile(normalized, new_string, 'utf-8');
      const msg = `✅ 新文件创建成功\n文件: ${normalized}\n行数: ${new_string.split('\n').length}`;
      return createResultWithLint(normalized, new_string, msg);
    }

    // 文件必须存在
    if (!await asyncExists(normalized)) {
      return { is_error: true, content: `文件不存在: ${normalized}` };
    }

    const encoding = await detectEncoding(normalized);
    const content = await asyncReadFile(normalized, encoding);

    if (!content.includes(old_string)) {
      return {
        is_error: true,
        content: `要替换的字符串在文件中未找到。\n字符串长度: ${old_string.length} 字符\n文件: ${normalized}\n\n提示: 确保 old_string 与文件内容完全匹配（包括空格、缩进、换行符）`
      };
    }

    const matchCount = content.split(old_string).length - 1;
    if (matchCount > 1) {
      return {
        is_error: true,
        content: `找到 ${matchCount} 个匹配。为安全起见只允许单个匹配。\n\n建议: 在 old_string 中包含更多上下文（3-5行）以唯一标识目标位置\n文件: ${normalized}`
      };
    }

    const updated = content.replace(old_string, new_string);
    await asyncWriteFile(normalized, updated, encoding);

    const beforeLines = content.substring(0, content.indexOf(old_string)).split('\n').length;
    const oldLines = old_string.split('\n').length;
    const newLines = new_string.split('\n').length;
    const msg = `✅ 替换成功\n文件: ${normalized}\n位置: 第 ${beforeLines} 行\n行数: ${oldLines} → ${newLines}`;
    return createResultWithLint(normalized, updated, msg);

  } catch (error: any) {
    return { is_error: true, content: `替换失败: ${error.message}\n文件: ${args.path}` };
  }
}

export interface MultiReplaceArgs {
  replacements: Array<{
    path: string;
    old_string: string;
    new_string: string;
  }>;
}

/**
 * 批量精确替换（多文件/多处，顺序执行）
 */
export async function multiReplaceStringInFileTool(args: MultiReplaceArgs): Promise<ToolUseResult> {
  const { replacements } = args;

  if (!replacements || !Array.isArray(replacements) || replacements.length === 0) {
    return { is_error: true, content: '参数错误：replacements 必须是非空数组' };
  }

  if (replacements.length > 50) {
    return { is_error: true, content: `替换操作数量过多 (${replacements.length})。单次最多 50 个。` };
  }

  const results: { index: number; path: string; success: boolean; message: string }[] = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < replacements.length; i++) {
    const r = replacements[i];
    const result = await replaceStringInFileTool({
      path: r.path,
      old_string: r.old_string,
      new_string: r.new_string,
    });
    if (result.is_error) {
      failCount++;
      results.push({ index: i + 1, path: r.path, success: false, message: result.content });
    } else {
      successCount++;
      results.push({ index: i + 1, path: r.path, success: true, message: '成功' });
    }
  }

  const summary = results.map(r =>
    `${r.index}. [${r.success ? '✅' : '❌'}] ${r.path.split(/[/\\]/).pop()} — ${r.message.split('\n')[0]}`
  ).join('\n');

  const hasErrors = failCount > 0;
  return {
    is_error: hasErrors,
    content: `批量替换完成: ${successCount} 成功, ${failCount} 失败\n\n${summary}`,
    metadata: { successCount, failCount, total: replacements.length },
  };
}
