/**
 * Content Deserializer — 将历史消息的 content string 反序列化为 ChatPart[]
 *
 * 用途：加载会话历史时，将旧的 string content 重建为 Part 模型，
 * 使历史消息也能走 Part-based 渲染路径，消灭双轨渲染。
 *
 * 支持两种历史格式：
 *   1. Part-serialized: 由 serializeToContent() 生成的 aily-state/aily-error 等代码块
 *   2. Legacy: 原始 JSON 工具事件行 + <think> 标签 + markdown
 */

import {
  ChatPart, buildConfirmationPartId, mkMarkdown, mkThinking, mkToolCall, mkState, mkError, mkQuestion, mkConfirmation, mkTerminal,
} from './chat-parts';
import type { ConfirmationPart, TerminalPart } from './chat-parts';
import { getThinkContent } from './think-content-store';
import { AGENT_NAMES } from './agent-names';

/** 需要从渲染内容中移除的内部事件 JSON 类型 */
const TOOL_EVENT_TYPES = new Set([
  'ToolCallRequestEvent',
  'ToolCallExecutionEvent',
  'ToolCallSummaryMessage',
]);

/**
 * 将历史消息的 content string 反序列化为 ChatPart[]。
 * 单遍扫描，识别 <think>、code fence、JSON 工具行等结构边界。
 */
export function deserializeContentToParts(content: string): ChatPart[] {
  if (!content || typeof content !== 'string') return [];

  const parts: ChatPart[] = [];
  let mdBuf = '';

  // 将累积的 markdown 文本冲刷为 MarkdownPart
  const flushMd = () => {
    // 清理 markdown 中的残余标签
    let cleaned = mdBuf
      .replace(/\[thinking\.\.\.?\]/g, '')
      .replace(/<toolResult>[\s\S]*?<\/toolResult>/g, '')
      .replace(/<info>[\s\S]*?<\/info>/g, '')
      .replace(/\[to_[^\]]+\]/g, m => AGENT_NAMES.get(m) ?? m);
    // 合并连续空行
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    if (cleaned.trim()) {
      parts.push(mkMarkdown(cleaned));
    }
    mdBuf = '';
  };

  // 预处理：剥离 <final_answer> 标签（保留内部文本）
  content = content
    .replace(/<final_answer[^>]*>\n?/g, '')
    .replace(/\n?<\/final_answer>/g, '');

  let pos = 0;

  while (pos < content.length) {
    // ── <think>...</think> ──
    if (content.startsWith('<think>', pos)) {
      flushMd();
      const bodyStart = pos + 7;
      const thinkEnd = content.indexOf('</think>', bodyStart);
      if (thinkEnd === -1) {
        // 未闭合 — 历史中视为完成
        const buf = content.slice(bodyStart).trim();
        if (buf) parts.push(mkThinking(buf, true));
        pos = content.length;
        continue;
      }
      const buf = content.slice(bodyStart, thinkEnd).trim();
      if (buf) parts.push(mkThinking(buf, true));
      pos = thinkEnd + 8;
      continue;
    }

    // ── ``` code fence ──
    if (content.startsWith('```', pos)) {
      const langEnd = content.indexOf('\n', pos + 3);
      if (langEnd === -1) {
        mdBuf += content.slice(pos);
        pos = content.length;
        continue;
      }
      const lang = content.slice(pos + 3, langEnd).trim();
      const bodyStart = langEnd + 1;

      // 查找闭合 ```（可能紧跟换行或在行首）
      let closingIdx = content.indexOf('\n```', bodyStart);
      let fenceEnd: number;
      let body: string;

      if (closingIdx !== -1) {
        body = content.slice(bodyStart, closingIdx);
        fenceEnd = closingIdx + 4;
        // 跳过闭合 ``` 后的换行
        if (fenceEnd < content.length && content[fenceEnd] === '\n') fenceEnd++;
      } else if (content.endsWith('```') && bodyStart < content.length - 3) {
        body = content.slice(bodyStart, content.length - 3);
        fenceEnd = content.length;
      } else {
        // 无闭合 — 整块作为 markdown
        mdBuf += content.slice(pos);
        pos = content.length;
        continue;
      }

      // 按 language 路由到不同 Part
      if (lang === 'aily-state') {
        flushMd();
        try {
          const data = JSON.parse(body.trim());
          if (
            data.displayKind === 'state'
            || data.kind === 'task_graph'
            || data.kind === 'task_scheduler'
            || data.kind === 'task_autonomy'
            || data.kind === 'agent_team'
            || data.kind === 'background_task'
            || data.kind === 'instructions'
            || data.kind === 'todo'
          ) {
            parts.push(mkState(
              data.id || `hist_state_${parts.length}`,
              data.text || data.message || '',
              data.state === 'doing' ? 'done' : (data.state || 'info'),
              data.kind,
              typeof data.progress === 'number' ? data.progress : undefined,
              data.metadata,
            ));
          } else {
            parts.push(mkToolCall(
              data.id || `hist_${parts.length}`,
              data.toolName || '',
              data.text || '',
              data.state === 'doing' ? 'done' : (data.state || 'done'),
            ));
          }
        } catch { /* skip broken */ }
        pos = fenceEnd;
        continue;
      }

      if (lang === 'aily-error') {
        flushMd();
        try {
          const data = JSON.parse(body.trim());
          parts.push(mkError(
            data.message || '',
            data.severity === 'warning'
              ? 'warning'
              : data.severity === 'info'
                ? 'info'
                : 'error',
            data.metadata && typeof data.metadata === 'object' ? data.metadata : undefined,
          ));
        } catch {}
        pos = fenceEnd;
        continue;
      }

      if (lang === 'aily-question') {
        flushMd();
        try {
          const data = JSON.parse(body.trim());
          const questionPart = mkQuestion(data.questions || [], data.isHistory ?? true, data.requestId || data.partId?.replace(/^question:/, ''));
          questionPart.partId = data.partId || questionPart.partId;
          if (data.answers) questionPart.answers = data.answers;
          parts.push(questionPart);
        } catch {}
        pos = fenceEnd;
        continue;
      }

      if (lang === 'aily-confirmation' || lang === 'aily-ask-confirm') {
        flushMd();
        try {
          const data = JSON.parse(body.trim());
          const p = mkConfirmation(
            data.askId || '',
            data.message || '',
            data.toolName,
            data.source,
            {
              args: data.args,
              description: typeof data.description === 'string' ? data.description : undefined,
            },
          );
          p.partId = typeof data.partId === 'string' && data.partId.trim().length > 0
            ? data.partId
            : buildConfirmationPartId(data.askId || '');
          if (typeof data.title === 'string' && data.title.trim()) {
            p.title = data.title;
          }
          if (typeof data.subtitle === 'string' && data.subtitle.trim()) {
            p.subtitle = data.subtitle;
          }
          if (Array.isArray(data.actions)) {
            p.actions = data.actions;
          }
          if (typeof data.primaryScope === 'string') {
            p.primaryScope = data.primaryScope as ConfirmationPart['primaryScope'];
          }
          p.resolved = data.resolved ?? true;
          if (data.result === 'confirmed') {
            p.result = 'approved';
          } else if (data.result === 'denied') {
            p.result = 'rejected';
          } else if (data.result) {
            p.result = data.result as ConfirmationPart['result'];
          }
          if (data.scope) {
            p.scope = data.scope as ConfirmationPart['scope'];
          }
          parts.push(p);
        } catch {}
        pos = fenceEnd;
        continue;
      }

      if (lang === 'aily-think') {
        flushMd();
        try {
          const data = JSON.parse(body.trim());
          let thinkContent = '';
          if (data.ref) thinkContent = getThinkContent(data.ref);
          if (!thinkContent && data.content) {
            thinkContent = data.encoded
              ? decodeURIComponent(atob(data.content))
              : data.content;
          }
          if (thinkContent) parts.push(mkThinking(thinkContent, true));
        } catch {}
        pos = fenceEnd;
        continue;
      }

      if (lang === 'aily-terminal') {
        flushMd();
        try {
          const data = JSON.parse(body.trim());
          const tp: TerminalPart = mkTerminal(data.command || '', data.toolCallId, data.partId, {
            sourceToolCallIds: Array.isArray(data.sourceToolCallIds) ? data.sourceToolCallIds : undefined,
            processId: data.processId,
            outputSessionId: data.outputSessionId,
            terminalId: data.terminalId,
            outputFilePath: data.outputFilePath,
            cwd: data.cwd,
            status: data.status,
            bytesTotal: data.bytesTotal,
            lastOutputAt: data.lastOutputAt,
            metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : undefined,
          });
          tp.output = data.output || '';
          tp.stderr = data.stderr || '';
          tp.exitCode = data.exitCode ?? data.exit_code;
          tp.isRunning = false; // 历史中终端不再运行
          parts.push(tp);
        } catch { /* skip broken */ }
        pos = fenceEnd;
        continue;
      }

      // 其他 code block (aily-mermaid, aily-context, aily-board, etc.) — 保留在 markdown 中
      mdBuf += content.slice(pos, fenceEnd);
      pos = fenceEnd;
      continue;
    }

    // ── JSON 工具事件行（Legacy 格式） ──
    const lineEnd = content.indexOf('\n', pos);
    const line = lineEnd === -1 ? content.slice(pos) : content.slice(pos, lineEnd);
    const trimmed = line.trim();

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const json = _tryJsonParse(trimmed);
      if (json) {
        if (json.type === 'tool_call_request' && json.tool_id) {
          flushMd();
          parts.push(mkToolCall(
            json.tool_id,
            json.tool_name || '',
            _buildToolText(json.tool_name, json.tool_args),
            'done', // 历史中已完成
          ));
          pos = lineEnd === -1 ? content.length : lineEnd + 1;
          continue;
        }

        if (json.type === 'ToolCallExecutionEvent' && Array.isArray(json.content)) {
          // 更新已有 ToolCallPart 的状态
          for (const item of json.content) {
            const callId: string = item.call_id || item.id;
            if (!callId) continue;
            for (const p of parts) {
              if (p.type === 'tool_call' && p.toolCallId === callId) {
                p.state = item.is_error ? 'error' : 'done';
                break;
              }
            }
          }
          pos = lineEnd === -1 ? content.length : lineEnd + 1;
          continue;
        }

        if (TOOL_EVENT_TYPES.has(json.type)) {
          // 跳过其他工具系统事件
          pos = lineEnd === -1 ? content.length : lineEnd + 1;
          continue;
        }
      }
    }

    // ── 普通文本行 → 累积到 markdown ──
    mdBuf += line;
    if (lineEnd !== -1) mdBuf += '\n';
    pos = lineEnd === -1 ? content.length : lineEnd + 1;
  }

  flushMd();
  return parts;
}

// ===== 辅助函数 =====

function _tryJsonParse(s: string): any {
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** 根据工具名和参数构建用户可读的描述文本 */
function _buildToolText(toolName: string, argsStr: string): string {
  const name = toolName || 'tool';
  try {
    const args = JSON.parse(argsStr || '{}');
    if (args.path) {
      const file = (args.path as string).split('/').filter(Boolean).pop() ?? args.path;
      return `${name}  ${file}`;
    }
    if (args.command) {
      const cmd = (args.command as string).split(' ').slice(0, 3).join(' ');
      return `${name}  ${cmd}`;
    }
    if (args.query || args.keyword) {
      return `${name}  ${args.query || args.keyword}`;
    }
  } catch { /* ignore */ }
  return name;
}
