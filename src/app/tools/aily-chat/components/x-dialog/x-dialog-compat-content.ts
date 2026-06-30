import { AGENT_NAMES } from '../../core/agent-names';
import { stripHistoricalThinkingPrefix } from '../../services/content-sanitizer.service';

/**
 * Historical markdown-first transcript compatibility helpers for x-dialog.
 *
 * Phase 2: All aily messages now use Part-based rendering. These transforms
 * only exist for user messages and copy-to-clipboard functionality.
 */
export function preprocessHistoricalDialogContent(content: string): string {
  if (!content) return '';

  return stripHistoricalThinkingPrefix(content)
    .replace(/<final_answer[^>]*>\n?/g, '')
    .replace(/\n?<\/final_answer>/g, '')
    .replace(/<toolResult>[\s\S]*?<\/toolResult>/g, '')
    .replace(/<info>[\s\S]*?<\/info>/g, '')
    .replace(/\[to_[^\]]+\]/g, m => AGENT_NAMES.get(m) ?? m);
}

export function extractHistoricalDialogCopyText(content: string): string {
  content = stripHistoricalThinkingPrefix(content || '');

  const parts: string[] = [];
  const toolMap = new Map<string, ToolCallEntry>();

  for (const line of content.split('\n')) {
    const json = tryJsonParse(line.trim());
    if (!json) continue;
    if (json.type === 'tool_call_request' && json.tool_id) {
      if (!toolMap.has(json.tool_id)) {
        toolMap.set(json.tool_id, { state: 'doing', text: buildToolText(json.tool_name, json.tool_args) });
      }
    }
    if (json.type === 'ToolCallExecutionEvent' && Array.isArray(json.content)) {
      for (const item of json.content) {
        const callId: string = item.call_id || item.id;
        if (callId && toolMap.has(callId)) {
          toolMap.get(callId)!.state = item.is_error ? 'error' : 'done';
        }
      }
    }
  }

  let i = 0;
  let buf = '';
  let inThink = false;

  while (i < content.length) {
    if (!inThink && content.startsWith('<think>', i)) {
      inThink = true;
      buf = '';
      i += 7;
      continue;
    }
    if (inThink && content.startsWith('</think>', i)) {
      inThink = false;
      if (buf.trim()) {
        parts.push('> [思考]\n> ' + buf.trim().split('\n').join('\n> '));
      }
      buf = '';
      i += 8;
      continue;
    }
    if (inThink) {
      buf += content[i];
      i++;
      continue;
    }

    const lineEnd = content.indexOf('\n', i);
    const line = lineEnd === -1 ? content.slice(i) : content.slice(i, lineEnd);
    i = lineEnd === -1 ? content.length : lineEnd + 1;

    const json = tryJsonParse(line.trim());
    if (json) {
      if (json.type === 'tool_call_request' && json.tool_id) {
        const entry = toolMap.get(json.tool_id);
        if (entry) {
          const icon = entry.state === 'done' ? '✓' : entry.state === 'error' ? '✗' : '⋯';
          parts.push(`${icon} ${entry.text}`);
        }
      }
      continue;
    }

    const stripped = line.replace(/<(?:attachments|context)>[\s\S]*?<\/(?:attachments|context)>/g, '').trim();
    if (stripped) {
      parts.push(line);
    }
  }

  if (inThink && buf.trim()) {
    parts.push('> [思考]\n> ' + buf.trim().split('\n').join('\n> '));
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

interface ToolCallEntry {
  state: 'doing' | 'done' | 'error' | 'warn';
  text: string;
}

function tryJsonParse(s: string): any {
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildToolText(toolName: string, argsStr: string): string {
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
  } catch {
    // ignore malformed historical tool arguments
  }
  return name;
}