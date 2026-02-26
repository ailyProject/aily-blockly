import {
  Component,
  Input,
  OnChanges,
  signal,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type { StreamingOption, ComponentMap } from 'ngx-x-markdown';
import { AilyChatCodeComponent } from './aily-chat-code.component';

@Component({
  selector: 'aily-x-dialog',
  templateUrl: './x-dialog.component.html',
  styleUrls: ['./x-dialog.component.scss'],
  standalone: true,
  imports: [CommonModule, XMarkdownComponent],
})
export class XDialogComponent implements OnChanges {
  @Input() role = 'user';
  @Input() content = '';
  @Input() doing = false;

  streamContent = signal('');
  streamingConfig = signal<StreamingOption>({ hasNextChunk: false, enableAnimation: false });
  readonly componentMap: ComponentMap = { code: AilyChatCodeComponent };

  private lastRaw = '';

  /** 检测 think 是否执行中（存在未闭合的 <think> 标签） */
  private isThinkExecuting(content: string): boolean {
    const lastThink = content.lastIndexOf('<think>');
    if (lastThink === -1) return false;
    const afterThink = content.slice(lastThink + 7);
    return !afterThink.includes('</think>');
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['doing'] || changes['content']) {
      const thinkExecuting = this.isThinkExecuting(this.content || '');
      this.streamingConfig.set({
        hasNextChunk: thinkExecuting ? false : this.doing,
        // enableAnimation: this.doing,
        // animationConfig: { fadeDuration: 150, easing: 'ease-in-out' },
      });
      // 流式结束时重新预处理，以便 normalizeAilyMermaid 将 aily-mermaid 转为 JSON 对象
      if (!this.doing) {
        const processed = this.preprocess(this.content || '');
        if (processed !== this.lastRaw) {
          this.lastRaw = processed;
          this.appendContent(processed);
        }
      }
    }
    if (changes['content']) {
      const processed = this.preprocess(this.content || '');
      if (processed !== this.lastRaw) {
        this.lastRaw = processed;
        this.appendContent(processed);
      }
    }
  }

  private appendContent(content: string): void {
    // const current = this.streamContent();
    // const separator = current && !current.endsWith('\n') ? '\n\n' : '';
    // this.streamContent.set(current + separator + content);
    this.streamContent.set(content);
  }

  // ===== Preprocessing =====

  private preprocess(content: string): string {
    if (!content) return '';
    content = this.filterToolCalls(content);
    content = this.filterThinkTags(content);
    content = this.filterContextTags(content);
    content = this.fixContent(content);
    content = this.normalizeAilyMermaid(content);
    content = this.replaceAgentNames(content);
    return content;
  }

  /**
   * aily-mermaid 块：等待数据完成后，将内容统一转换为 JSON 对象形式 {"code":"..."}
   * 供 x-markdown 内置 MermaidCodeComponent 直接解析
   * 仅在流式完成（!doing）时转换，避免流式过程中对不完整内容做无效转换
   */
  private normalizeAilyMermaid(content: string): string {
    if (this.doing) return content;
    return content.replace(/```aily-mermaid\n([\s\S]*?)```/g, (_match, inner) => {
      let trimmed = inner.trim();
      if (!trimmed) return _match;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed.code === 'string') return _match;
      } catch { /* 非 JSON 或无效，需包装 */ }
      return '```aily-mermaid\n' + JSON.stringify({ code: trimmed }) + '\n```';
    });
  }

  /**
   * 工具调用渲染：
   * 1. 扫描全部内容，构建 tool_id → 最终状态 的映射（Phase 1）
   * 2. 将每个 tool_call_request 行替换为对应状态的 aily-state 代码块（Phase 2）
   * 3. 移除内部事件行（ToolCallRequestEvent / ToolCallExecutionEvent / ToolCallSummaryMessage）
   *
   * 由于 x-markdown 使用增量 DOM 更新，当同一位置的 aily-state 状态改变
   * （doing → done/error）时，只更新对应节点，不会重复追加块。
   */
  private filterToolCalls(content: string): string {
    // Phase 1: 扫描所有 JSON 行，建立 tool_id → 最终状态 映射
    const toolMap = new Map<string, ToolCallEntry>();

    for (const line of content.split('\n')) {
      const json = tryJsonParse(line.trim());
      if (!json) continue;

      // 单个工具调用请求（streaming 中逐个产生）
      if (json.type === 'tool_call_request' && json.tool_id) {
        if (!toolMap.has(json.tool_id)) {
          toolMap.set(json.tool_id, {
            state: 'doing',
            text: buildToolText(json.tool_name, json.tool_args),
          });
        }
        continue;
      }

      // 工具执行结果事件：更新对应 tool_id 的状态
      if (json.type === 'ToolCallExecutionEvent' && Array.isArray(json.content)) {
        for (const item of json.content) {
          const callId: string = item.call_id || item.id;
          if (callId && toolMap.has(callId)) {
            toolMap.get(callId)!.state = item.is_error ? 'error' : 'done';
          }
        }
      }
    }

    // Phase 2: 逐行替换
    return content.split('\n').map(line => {
      const json = tryJsonParse(line.trim());
      if (!json) return line;

      if (json.type === 'tool_call_request' && json.tool_id) {
        const entry = toolMap.get(json.tool_id);
        if (!entry) return '';
        const stateData = { state: entry.state, text: entry.text };
        return '```aily-state\n' + JSON.stringify(stateData) + '\n```';
      }

      if (TOOL_EVENT_TYPES.has(json.type)) return '';

      return line;
    }).join('\n');
  }

  /**
   * 将 <think>...</think> 转换为 aily-think 代码块
   * 由 AilyChatCodeComponent 负责渲染
   */
  private filterThinkTags(content: string): string {
    let result = '';
    let i = 0;
    let inThink = false;
    let buf = '';

    while (i < content.length) {
      if (!inThink && content.startsWith('<think>', i)) {
        inThink = true; buf = ''; i += 7; continue;
      }
      if (inThink && content.startsWith('</think>', i)) {
        inThink = false;
        if (buf.trim()) {
          const encoded = btoa(encodeURIComponent(buf.trim()));
          result += '\n```aily-think\n' + JSON.stringify({ content: encoded, isComplete: true, encoded: true }) + '\n```\n';
        }
        buf = ''; i += 8; continue;
      }
      if (inThink) buf += content[i]; else result += content[i];
      i++;
    }

    // 流式传输中 think 块尚未闭合
    if (inThink && buf.trim()) {
      const encoded = btoa(encodeURIComponent(buf.trim()));
      result += '\n```aily-think\n' + JSON.stringify({ content: encoded, isComplete: false, encoded: true }) + '\n```\n';
    }

    return result;
  }

  /**
   * 将 <context>...</context> 转换为 aily-context 代码块
   * 由 AilyChatCodeComponent 负责渲染，替代旧式 HTML <details> 方案
   */
  private filterContextTags(content: string): string {
    content = content.replace(/<context>\n?([\s\S]*?)\n?<\/context>/g, (_m, inner: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return '';
      const label = this.extractContextLabel(trimmed);
      const encoded = btoa(encodeURIComponent(trimmed));
      return '\n```aily-context\n' + JSON.stringify({ label, content: encoded, encoded: true }) + '\n```\n';
    });
    // 剥离 <user-query> 包裹，保留内部文本
    return content.replace(/<user-query>([\s\S]*?)<\/user-query>/g, '$1');
  }

  private extractContextLabel(text: string): string {
    const parts: string[] = [];
    const cpp = text.match(/对应C\+\+代码行数:\s*(\S+)/);
    const abs = text.match(/对应ABS代码行数:\s*(\S+)/);
    if (cpp || abs) {
      const p = [...(abs ? [`A${abs![1]}`] : []), ...(cpp ? [`C${cpp![1]}`] : [])];
      parts.push(`blockly:${p.join('/')}`);
    }
    if (text.includes('参考文件:')) {
      const n = text.split('参考文件:')[1]?.split('\n\n')[0]?.match(/^- /gm)?.length ?? 0;
      if (n > 0) parts.push(`${n}个文件`);
    }
    if (text.includes('参考文件夹:')) {
      const n = text.split('参考文件夹:')[1]?.split('\n\n')[0]?.match(/^- /gm)?.length ?? 0;
      if (n > 0) parts.push(`${n}个文件夹`);
    }
    return parts.length > 0 ? parts.join(' + ') : '附加上下文';
  }

  /**
   * 修正 LLM 输出中的格式问题：转义字符、代码块格式等
   * [thinking...] 占位符在此处被移除，x-markdown 渲染空内容
   */
  private fixContent(content: string): string {
    content = content
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\[thinking\.\.\.?\]/g, '')
      // 移除工具结果/系统信息标签（AI 可能回显到响应文本中）
      .replace(/<toolResult>[\s\S]*?<\/toolResult>/g, '')
      .replace(/<info>[\s\S]*?<\/info>/g, '');

    const ailyTypes = ['aily-blockly', 'aily-board', 'aily-library', 'aily-state',
      'aily-button', 'aily-error', 'aily-mermaid', 'aily-task-action', 'aily-think', 'aily-context'];

    // 保留 match：当 after 为完整 aily 类型，或为某类型的流式前缀（如 aily-）时
    content = content.replace(/```([^\n`]*)/g, (match, after) =>
      ailyTypes.some(t => after.startsWith(t) || t.startsWith(after)) ? match : (after === '' ? '```\n' : '```\n' + after)
    );
    if (content.endsWith('```')) content += '\n';

    return content
      .replace(/```\n\s*flowchart/g, '```aily-mermaid\nflowchart')
      .replace(/\s*```(aily-(?:board|library|state|button|task-action|think|context))/g, '\n```$1\n');
  }

  private replaceAgentNames(content: string): string {
    return content.replace(/\[to_[^\]]+\]/g, m => AGENT_NAMES.get(m) ?? m);
  }
}

// ===== Tool call helpers =====

interface ToolCallEntry {
  state: 'doing' | 'done' | 'error' | 'warn';
  text: string;
}

/** 需要从渲染内容中移除的内部事件类型 */
const TOOL_EVENT_TYPES = new Set([
  'ToolCallRequestEvent',
  'ToolCallExecutionEvent',
  'ToolCallSummaryMessage',
]);

function tryJsonParse(s: string): any {
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** 根据工具名和参数构建用户可读的描述文本 */
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
  } catch { /* ignore */ }
  return name;
}

// ===== Agent name map =====

const AGENT_NAMES = new Map<string, string>([
  ['[to_plannerAgent]', '🤔'],
  ['[to_projectAnalysisAgent]', '🤔'],
  ['[to_projectGenerationAgent]', '🤔'],
  ['[to_boardRecommendationAgent]', '🤨'],
  ['[to_libraryRecommendationAgent]', '🤨'],
  ['[to_arduinoLibraryAnalysisAgent]', '🤔'],
  ['[to_projectCreationAgent]', '😀'],
  ['[to_blocklyGenerationAgent]', '🤔'],
  ['[to_blocklyRepairAgent]', '🤔'],
  ['[to_compilationErrorRepairAgent]', '🤔'],
  ['[to_contextAgent]', '😀'],
  ['[to_libraryInstallationAgent]', '😀'],
  ['[to_fileOperationAgent]', '😁'],
  ['[to_user]', '😉'],
  ['[to_xxx]', '🤖'],
]);
