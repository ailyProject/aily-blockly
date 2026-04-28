import {
  Component,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  EventEmitter,
  signal,
  SimpleChanges,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { XMarkdownComponent } from 'ngx-x-markdown';
import type { StreamingOption, ComponentMap } from 'ngx-x-markdown';
import { AilyChatCodeComponent } from './aily-chat-code.component';
import { ChatAPI } from '../../core/api-endpoints';
import { AilyHost } from '../../core/host';
import { EditCheckpointService } from '../../services/edit-checkpoint.service';
import { ChatPerformanceTracer } from '../../services/chat-perf-tracer';
import { storeThinkContent, deleteThinkContent } from '../../core/think-content-store';
import { ResourceItem } from '../../core/chat-types';


@Component({
  selector: 'aily-x-dialog',
  templateUrl: './x-dialog.component.html',
  styleUrls: ['./x-dialog.component.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, TranslateModule, NzToolTipModule, XMarkdownComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class XDialogComponent implements OnChanges, AfterViewChecked, OnDestroy {
  @Input() role = 'user';
  @Input() content = '';
  @Input() doing = false;
  /** 消息来源：mainAgent 为主Agent，其他值为子Agent名称 */
  @Input() source: string = 'mainAgent';
  /** 是否为最后一条 aily 消息（显示操作按钮） */
  @Input() isLastAily = false;
  /** 当前会话 ID */
  @Input() sessionId = '';
  @Input() msgIndex = -1;
  @Input() currentMode = 'agent';
  @Input() currentModelName = '';
  /** 该消息创建时使用的模型名称 */
  @Input() turnModelName = '';
  @Input() isWaiting = false;

  /** 本组件 dialog-box 是否被 hover */
  dialogBoxHovered = false;

  @Output() editAndResend = new EventEmitter<{ msgIndex: number; newText: string; resources: ResourceItem[] }>();
  @Output() editModeToggle = new EventEmitter<{ event: MouseEvent; type: 'mode' }>();
  @Output() editModelToggle = new EventEmitter<{ event: MouseEvent; type: 'model' }>();
  @Output() editAddFile = new EventEmitter<void>();
  @Output() editAddFolder = new EventEmitter<void>();

  @ViewChild('subagentBody') subagentBodyRef?: ElementRef<HTMLElement>;
  @ViewChild('editTextarea') editTextareaRef?: ElementRef<HTMLTextAreaElement>;

  /** 判断是否为子Agent消息 */
  get isSubagent(): boolean {
    return this.source && this.source !== 'mainAgent';
  }

  /** 获取子Agent显示名称 */
  get subagentDisplayName(): string {
    if (!this.isSubagent) return '';
    // 将 camelCase 转换为更可读的格式，如 schematicAgent -> Schematic Agent
    return this.source
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  }

  /** 子Agent折叠面板展开状态 */
  subagentExpanded = false;
  private shouldScrollSubagent = false;
  private prevDoing = false;
  /** 子Agent 正文区：用户未主动上滚时跟随流式到底部 */
  private subagentStickToBottom = true;
  private readonly subagentScrollBottomThresholdPx = 48;

  streamContent = signal('');
  streamingConfig = signal<StreamingOption>({ hasNextChunk: false, enableAnimation: false });
  readonly componentMap: ComponentMap = { code: AilyChatCodeComponent };

  // ★ 自适应节流 preprocess：内容短时每帧更新，内容长时降低频率，避免 x-markdown 全量 parse 卡顿
  private _preprocessRafId: number | null = null;
  private _preprocessTimerId: ReturnType<typeof setTimeout> | null = null;
  private _pendingContent: string | null = null;
  private _lastPreprocessTime = 0;
  // ★ filterToolCalls 缓存：避免每次 preprocess 都全量 split + parse
  private _ftcCacheInput = '';
  private _ftcCacheOutput = '';
  private _ftcToolMap = new Map<string, ToolCallEntry>();
  // ★ filterThinkTags 缓存：避免流式中每帧重新 btoa(encodeURIComponent()) 全部 think 内容
  private _fttCacheInput = '';
  private _fttCacheOutput = '';
  // ★ think 内容外部化：仅存储 ref key 列表，内容在 think-content-store 中
  private _thinkRefKeys: string[] = [];
  /** 是否显示操作栏 */
  showActions = false;
  /** 反馈状态 */
  feedbackState: 'helpful' | 'unhelpful' | null = null;

  // ===== 编辑模式 =====
  isEditing = false;
  editText = '';
  editResources: ResourceItem[] = [];
  showEditAddList = false;

  constructor(
    private editCheckpointService: EditCheckpointService,
    private cdr: ChangeDetectorRef,
  ) {}

  /** 是否可显示操作栏（非 doing 的最后一条 aily 消息） */
  get canShowActions(): boolean {
    return this.isLastAily && !this.doing && this.role === 'aily' && !this.isSubagent;
  }

  get canShowLimitActions(): boolean {
    return this.role !== 'user' && !this.doing && this.msgIndex > 0;
  }

  get canShowCheckpointAction(): boolean {
    return !this.doing && this.msgIndex > 0;
  }

  get canRenderCheckpointAnchor(): boolean {
    return this.role === 'user' && this.msgIndex >= 0;
  }

  get showCheckpointAnchor(): boolean {
    return this.canRenderCheckpointAnchor && this.dialogBoxHovered;
  }

  /** 是否可编辑用户消息（非 doing 的 user 消息） */
  get canEditUserMessage(): boolean {
    return this.role === 'user' && !this.doing && !this.isWaiting;
  }

  onDialogMouseEnter(): void {
    this.showActions = true;
    this.dialogBoxHovered = true;
  }

  onDialogMouseLeave(): void {
    this.showActions = false;
    this.dialogBoxHovered = false;
  }

  onRegenerate(): void {
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true, detail: { action: 'regenerate' }
    }));
  }

  onRestoreCheckpoint(): void {
    if (this.msgIndex < 0) return;
    document.dispatchEvent(new CustomEvent('aily-task-action', {
      bubbles: true, detail: { action: 'restoreCheckpoint', listIndex: this.msgIndex }
    }));
  }

  onCopyContent(): void {
    const raw = this.content || '';
    const text = this.extractCopyText(raw);
    navigator.clipboard.writeText(text).catch(() => {});
  }

  onFeedback(feedback: 'helpful' | 'unhelpful'): void {
    if (this.feedbackState === feedback || !this.sessionId) return;
    this.feedbackState = feedback;
    AilyHost.get().auth.getToken!().then(token => {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      fetch(`${ChatAPI.conversationFeedback}/${this.sessionId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ feedback }),
      }).catch(() => {});
    }).catch(() => {});
  }

  // ===== 编辑模式操作 =====

  /** 点击用户消息进入编辑模式 */
  onUserMessageClick(): void {
    if (!this.canEditUserMessage || this.isEditing) return;
    const { text, resources } = this.parseUserContent(this.content || '');
    this.editText = text;
    this.editResources = resources;
    this.showEditAddList = false;
    this.isEditing = true;
    // 下一帧再 focus，确保 @if (isEditing) 已渲染出 textarea
    setTimeout(() => this.editTextareaRef?.nativeElement?.focus(), 0);
  }

  onCancelEdit(): void {
    this.isEditing = false;
    this.editText = '';
    this.editResources = [];
    this.showEditAddList = false;
  }

  onSubmitEdit(): void {
    const trimmed = this.editText.trim();
    if (!trimmed) return;
    this.isEditing = false;
    this.editAndResend.emit({
      msgIndex: this.msgIndex,
      newText: trimmed,
      resources: [...this.editResources],
    });
    this.editText = '';
    this.editResources = [];
    this.showEditAddList = false;
  }

  onEditKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.onCancelEdit();
    } else if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      this.onSubmitEdit();
    } else if (event.key === 'Enter' && event.ctrlKey) {
      // Ctrl+Enter 换行
      const textarea = event.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      this.editText = this.editText.substring(0, start) + '\n' + this.editText.substring(end);
      setTimeout(() => { textarea.selectionStart = textarea.selectionEnd = start + 1; }, 0);
      event.preventDefault();
    }
  }

  onEditRemoveResource(index: number): void {
    if (index >= 0 && index < this.editResources.length) {
      this.editResources.splice(index, 1);
    }
  }

  onEditToggleAddList(): void {
    this.showEditAddList = !this.showEditAddList;
  }

  /** 从父组件接收添加的文件资源 */
  addEditResource(item: ResourceItem): void {
    const exists = this.editResources.some(r =>
      r.type === item.type && (r.path === item.path || r.url === item.url)
    );
    if (!exists) {
      this.editResources.push(item);
      this.cdr.markForCheck();
    }
  }

  /** 从消息 content 中解析出纯文本和 resources */
  private parseUserContent(content: string): { text: string; resources: ResourceItem[] } {
    const resources: ResourceItem[] = [];
    let text = content;

    const attachMatch = content.match(/<(?:attachments|context)>\n?([\s\S]*?)\n?<\/(?:attachments|context)>/);
    if (attachMatch) {
      const inner = attachMatch[1].trim();
      text = content.replace(attachMatch[0], '').trim();

      // 解析参考文件
      const fileSection = inner.match(/参考文件:\n((?:- .+\n?)+)/);
      if (fileSection) {
        const lines = fileSection[1].trim().split('\n');
        for (const line of lines) {
          const path = line.replace(/^- /, '').trim();
          if (path) {
            const name = path.split(/[/\\]/).pop() || path;
            resources.push({ type: 'file', path, name });
          }
        }
      }

      // 解析参考文件夹
      const folderSection = inner.match(/参考文件夹:\n((?:- .+\n?)+)/);
      if (folderSection) {
        const lines = folderSection[1].trim().split('\n');
        for (const line of lines) {
          const path = line.replace(/^- /, '').trim();
          if (path) {
            const name = path.split(/[/\\]/).pop() || path;
            resources.push({ type: 'folder', path, name });
          }
        }
      }

      // 解析参考URL
      const urlSection = inner.match(/参考URL:\n((?:- .+\n?)+)/);
      if (urlSection) {
        const lines = urlSection[1].trim().split('\n');
        for (const line of lines) {
          const url = line.replace(/^- /, '').trim();
          if (url) {
            try {
              const urlObj = new URL(url);
              resources.push({ type: 'url', url, name: urlObj.hostname + urlObj.pathname });
            } catch { /* skip invalid */ }
          }
        }
      }
    }

    return { text, resources };
  }

  private extractCopyText(content: string): string {
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
        inThink = true; buf = ''; i += 7; continue;
      }
      if (inThink && content.startsWith('</think>', i)) {
        inThink = false;
        if (buf.trim()) parts.push('> [思考]\n> ' + buf.trim().split('\n').join('\n> '));
        buf = ''; i += 8; continue;
      }
      if (inThink) { buf += content[i]; i++; continue; }

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
      if (stripped) parts.push(line);
    }

    if (inThink && buf.trim()) {
      parts.push('> [思考]\n> ' + buf.trim().split('\n').join('\n> '));
    }

    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private lastRaw = '';

  /** 检测 think 是否执行中（存在未闭合的 <think> 标签） */
  private isThinkExecuting(content: string): boolean {
    const lastThink = content.lastIndexOf('<think>');
    if (lastThink === -1) return false;
    const afterThink = content.slice(lastThink + 7);
    return !afterThink.includes('</think>');
  }

  ngOnChanges(changes: SimpleChanges) {
    // 子Agent折叠面板：doing时自动展开，完成时自动收起
    if (this.isSubagent && changes['doing']) {
      if (this.doing) {
        this.subagentExpanded = true;
        if (changes['doing'].previousValue !== true) {
          this.subagentStickToBottom = true;
        }
      } else if (this.prevDoing && !this.doing) {
        // 从doing→done：自动折叠
        this.subagentExpanded = false;
      }
      this.prevDoing = this.doing;
    }
    if (this.isSubagent && changes['content']) {
      this.shouldScrollSubagent = true;
    }

    if (changes['doing'] || changes['content']) {
      const hasNextChunk = this.doing && !this.isThinkExecuting(this.content || '');
      this.streamingConfig.set({ hasNextChunk });

      const content = this.content || '';

      if (this.doing && changes['content'] && !changes['doing']) {
        // ★ 自适应节流：根据内容长度动态调整更新间隔
        // 短内容 (<5KB): 每帧更新 (rAF ~16ms)
        // 中内容 (5-20KB): 每 120ms
        // 长内容 (20-50KB): 每 300ms
        // 超长内容 (50-100KB): 每 600ms
        // 巨大内容 (>100KB): 每 1000ms
        // x-markdown 每次 set 都全量 parse+sanitize，耗时与内容长度成正比
        this._pendingContent = content;
        const len = content.length;
        const interval = len < 5000 ? 0 : len < 20000 ? 120 : len < 50000 ? 300 : len < 100000 ? 600 : 1000;
        const now = performance.now();
        const elapsed = now - this._lastPreprocessTime;

        if (interval === 0) {
          // 短内容：保持 rAF 节流（原有行为）
          if (this._preprocessTimerId !== null) { clearTimeout(this._preprocessTimerId); this._preprocessTimerId = null; }
          if (this._preprocessRafId === null) {
            ChatPerformanceTracer.mark('preprocess_rAF_scheduled');
            this._preprocessRafId = requestAnimationFrame(() => {
              this._preprocessRafId = null;
              this._flushPendingPreprocess();
            });
          }
        } else if (elapsed >= interval) {
          // 已超过间隔：立即在下一 rAF 处理
          if (this._preprocessTimerId !== null) { clearTimeout(this._preprocessTimerId); this._preprocessTimerId = null; }
          if (this._preprocessRafId === null) {
            this._preprocessRafId = requestAnimationFrame(() => {
              this._preprocessRafId = null;
              this._flushPendingPreprocess();
            });
          }
        } else if (this._preprocessTimerId === null && this._preprocessRafId === null) {
          // 间隔未到且没有 pending 的定时器：设置定时器，到期后在 rAF 处理
          const remaining = interval - elapsed;
          this._preprocessTimerId = setTimeout(() => {
            this._preprocessTimerId = null;
            this._preprocessRafId = requestAnimationFrame(() => {
              this._preprocessRafId = null;
              this._flushPendingPreprocess();
            });
          }, remaining);
        }
        // 否则已有 pending timer/rAF，跳过（最终会用最新 _pendingContent）
        return;
      }

      // 非流式或 doing 变化：立即全量预处理（状态转换、流式结束等关键时刻）
      if (this._preprocessRafId !== null) {
        cancelAnimationFrame(this._preprocessRafId);
        this._preprocessRafId = null;
      }
      if (this._preprocessTimerId !== null) {
        clearTimeout(this._preprocessTimerId);
        this._preprocessTimerId = null;
      }
      this._pendingContent = null;
      ChatPerformanceTracer.mark('preprocess_immediate', `doing=${this.doing}`);
      this._doFullPreprocess(content);
    }
  }

  /** 自适应节流 flush：执行 pending preprocess 并更新时间戳 */
  private _flushPendingPreprocess(): void {
    if (this._pendingContent !== null) {
      const _ps = ChatPerformanceTracer.begin('preprocess_rAF_exec');
      this._doFullPreprocess(this._pendingContent);
      this._lastPreprocessTime = performance.now();
      this._pendingContent = null;
      ChatPerformanceTracer.end(_ps, 'preprocess_rAF_exec');
    }
  }

  private _doFullPreprocess(content: string): void {
    const processed = this.preprocess(content);
    if (processed !== this.lastRaw) {
      this.lastRaw = processed;
      this.streamContent.set(processed);
    }
  }

  onSubagentBodyScroll(event: Event): void {
    const el = event.target as HTMLElement | null;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.subagentStickToBottom = dist <= this.subagentScrollBottomThresholdPx;
  }

  ngAfterViewChecked(): void {
    if ((this.shouldScrollSubagent || this.doing) && this.subagentBodyRef?.nativeElement) {
      const el = this.subagentBodyRef.nativeElement;
      const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distBottom <= this.subagentScrollBottomThresholdPx;
      const allowScroll =
        this.subagentStickToBottom && (nearBottom || this.shouldScrollSubagent);
      if (allowScroll) {
        el.scrollTop = el.scrollHeight;
      }
      this.shouldScrollSubagent = false;
    }
  }

  ngOnDestroy(): void {
    if (this._preprocessRafId !== null) cancelAnimationFrame(this._preprocessRafId);
    if (this._preprocessTimerId !== null) clearTimeout(this._preprocessTimerId);
    for (const key of this._thinkRefKeys) deleteThinkContent(key);
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
   * 工具调用渲染（增量优化版）：
   * - 缓存上次结果，仅处理新增部分
   * - 合并两次 split 为一次，单遍扫描 + 替换
   * - toolMap 持久化复用，仅增加新条目
   */
  private filterToolCalls(content: string): string {
    // 快速路径：内容完全没变，直接返回缓存
    if (content === this._ftcCacheInput) return this._ftcCacheOutput;

    const toolMap = this._ftcToolMap;
    // 如果内容不是在缓存基础上追加（如回退/替换），重置 toolMap
    if (!content.startsWith(this._ftcCacheInput)) {
      toolMap.clear();
    }

    // 单次 split，Phase 1+2 共用行数组
    const lines = content.split('\n');
    let hasToolEvents = false;

    // Phase 1: 扫描所有 JSON 行，更新 tool_id → 最终状态映射
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const json = tryJsonParse(trimmed);
      if (!json) continue;
      hasToolEvents = true;

      if (json.type === 'tool_call_request' && json.tool_id) {
        if (!toolMap.has(json.tool_id)) {
          toolMap.set(json.tool_id, {
            state: 'doing',
            text: buildToolText(json.tool_name, json.tool_args),
          });
        }
      } else if (json.type === 'ToolCallExecutionEvent' && Array.isArray(json.content)) {
        for (const item of json.content) {
          const callId: string = item.call_id || item.id;
          if (callId && toolMap.has(callId)) {
            toolMap.get(callId)!.state = item.is_error ? 'error' : 'done';
          }
        }
      }
    }

    // 快速路径：没有任何工具事件行，直接返回原内容
    if (!hasToolEvents && toolMap.size === 0) {
      this._ftcCacheInput = content;
      this._ftcCacheOutput = content;
      return content;
    }

    // Phase 2: 逐行替换（复用同一行数组，原地构建结果）
    let result = '';
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const json = tryJsonParse(trimmed);
      if (!json) {
        result += (i > 0 ? '\n' : '') + lines[i];
        continue;
      }

      if (json.type === 'tool_call_request' && json.tool_id) {
        const entry = toolMap.get(json.tool_id);
        if (!entry) {
          // empty line
        } else {
          const stateData = { state: entry.state, text: entry.text };
          result += (i > 0 ? '\n' : '') + '```aily-state\n' + JSON.stringify(stateData) + '\n```';
        }
        continue;
      }

      if (TOOL_EVENT_TYPES.has(json.type)) continue;

      result += (i > 0 ? '\n' : '') + lines[i];
    }

    this._ftcCacheInput = content;
    this._ftcCacheOutput = result;
    return result;
  }

  /**
   * 将 <think>...</think> 转换为 aily-think 代码块
   * 由 AilyChatCodeComponent 负责渲染
   *
   * ★ P0-perf: think 内容外部化到 think-content-store
   * 之前：btoa(encodeURIComponent(raw)) 嵌入代码块 → ~40KB/block → x-markdown 每帧解析全部
   * 现在：仅嵌入 ~80 byte 引用 JSON → x-markdown 解析 <10KB
   */
  private filterThinkTags(content: string): string {
    // 快速路径：内容完全没变
    if (content === this._fttCacheInput) return this._fttCacheOutput;
    // 快速路径：没有 <think> 标签
    if (!content.includes('<think>')) {
      this._fttCacheInput = content;
      this._fttCacheOutput = content;
      return content;
    }

    // 位置化 key：think_{msgIndex}_{thinkIndex}，同一 think 块跨帧 key 稳定
    this._thinkRefKeys = [];
    let thinkIndex = 0;
    const parts: string[] = [];
    let pos = 0;

    while (pos < content.length) {
      const thinkStart = content.indexOf('<think>', pos);
      if (thinkStart === -1) {
        // 没有更多 <think>，直接追加剩余内容
        parts.push(content.slice(pos));
        pos = content.length;
        break;
      }

      // 追加 <think> 之前的内容
      if (thinkStart > pos) {
        parts.push(content.slice(pos, thinkStart));
      }

      const bodyStart = thinkStart + 7; // '<think>'.length
      const thinkEnd = content.indexOf('</think>', bodyStart);

      if (thinkEnd === -1) {
        // 未闭合的 <think>：流式中显示 loading，流式结束标记为完成
        const buf = content.slice(bodyStart).trim();
        if (buf) {
          const key = `think_${this.msgIndex}_${thinkIndex++}`;
          storeThinkContent(key, buf);
          this._thinkRefKeys.push(key);
          const isComplete = !this.doing;
          parts.push('\n```aily-think\n' + JSON.stringify({ ref: key, isComplete }) + '\n```\n');
        }
        pos = content.length;
        break;
      }

      // 完整的 <think>...</think> 块
      const buf = content.slice(bodyStart, thinkEnd).trim();
      if (buf) {
        const key = `think_${this.msgIndex}_${thinkIndex++}`;
        storeThinkContent(key, buf);
        this._thinkRefKeys.push(key);
        parts.push('\n```aily-think\n' + JSON.stringify({ ref: key, isComplete: true }) + '\n```\n');
      }
      pos = thinkEnd + 8; // '</think>'.length
    }

    const result = parts.join('');
    this._fttCacheInput = content;
    this._fttCacheOutput = result;
    return result;
  }

  /**
   * 将 <context>...</context> 转换为 aily-context 代码块
   * 由 AilyChatCodeComponent 负责渲染，替代旧式 HTML <details> 方案
   */
  private filterContextTags(content: string): string {
    // 处理 <attachments> / <context>（兼容旧标签）→ aily-context 代码块
    content = content.replace(/<(?:attachments|context)>\n?([\s\S]*?)\n?<\/(?:attachments|context)>/g, (_m, inner: string) => {
      const trimmed = inner.trim();
      if (!trimmed) return '';
      const label = this.extractContextLabel(trimmed);
      const encoded = btoa(encodeURIComponent(trimmed));
      return '\n```aily-context\n' + JSON.stringify({ label, content: encoded, encoded: true }) + '\n```\n';
    });
    return content;
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
    // 将 \n \t \r 转义转为真实字符，但跳过代码块内部（避免破坏 JSON 结构）
    content = content.replace(/(```[\s\S]*?```)|\\([ntr])/g, (match, codeBlock, escChar) => {
      if (codeBlock) return codeBlock;
      switch (escChar) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        default: return match;
      }
    });
    content = content
      .replace(/\[thinking\.\.\.?\]/g, '')
      // 移除工具结果/系统信息标签（AI 可能回显到响应文本中）
      .replace(/<toolResult>[\s\S]*?<\/toolResult>/g, '')
      .replace(/<info>[\s\S]*?<\/info>/g, '');

    const ailyTypes = ['aily-blockly', 'aily-board', 'aily-library', 'aily-state',
      'aily-button', 'aily-error', 'aily-mermaid', 'aily-task-action', 'aily-think', 'aily-context', 'aily-question', 'aily-approval'];

    // 保留 match：当 after 为完整 aily 类型、流式前缀、或有效语言标识符（如 json、typescript）时
    // 若将 ```json 误改为 ```\njson，会导致 lang 解析错误、内容多出 "json" 文字
    const isValidLang = (s: string) => /^[a-zA-Z0-9+#_.-]+$/.test(s.trim()) && s.trim().length > 0;
    content = content.replace(/```([^\n`]*)/g, (match, after) => {
      if (ailyTypes.some(t => after.startsWith(t) || t.startsWith(after))) return match;
      if (isValidLang(after)) return match; // 保留 ```json、```typescript 等标准代码块
      return after === '' ? '```\n' : '```\n' + after;
    });
    if (content.endsWith('```')) content += '\n';

    return content
      .replace(/```\n\s*flowchart/g, '```aily-mermaid\nflowchart')
      .replace(/\s*```(aily-(?:board|library|state|button|task-action|think|context|question|approval))/g, '\n```$1\n');
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
