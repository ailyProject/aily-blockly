/**
 * ChatViewAdapter — rAF 批处理 UI 适配层
 *
 * 核心逻辑：
 *   - 流式 streaming_chunk 事件合并到 pendingChunks，通过 requestAnimationFrame 每帧 flush 一次
 *   - 非流式事件（tool_call_state、status_change 等）立即应用
 *   - flush 时一次性拼接所有 pending chunks，只触发一次 list[] mutation → 一次 Angular CD
 *
 * 效果：将 "每 SSE token 一次 CD" 降为 "每动画帧一次 CD"（~60fps = 16ms 合并所有 token）
 */

import { ChatMessage, ToolCallState, ToolCallInfo } from '../core/chat-types';
import { ChatKernelEvent, StreamingChunkEvent } from '../core/chat-kernel-events';
import { ChatPerformanceTracer } from './chat-perf-tracer';
import {
  makeJsonSafe as _makeJsonSafe,
} from './content-sanitizer.service';
import { NgZone } from '@angular/core';

export class ChatViewAdapter {
  /** 待合并的流式 chunk 缓冲区 */
  private pendingChunks: StreamingChunkEvent[] = [];
  /** rAF 句柄 */
  private rafId: number | null = null;
  /** ★ 性能优化：toolCallId → list 索引，避免 displayToolCallState 全量 regex 扫描 */
  private toolCallStateIndex = new Map<string, number>();

  /** flush 回调（由 engine 注册，在 rAF 内执行实际 list 修改） */
  private onFlushCallback: (() => void) | null = null;

  constructor(
    /** 引用 engine.list — 直接操作（在 rAF 回调内，一帧只操作一次） */
    private getList: () => ChatMessage[],
    private pushToList: (msg: ChatMessage) => void,
    /** 获取当前消息来源 */
    private getCurrentSource: () => string,
    /** 获取当前模型名 */
    private getCurrentModelName: () => string | undefined,
    /** 获取 isWaiting 状态 */
    private getIsWaiting: () => boolean,
    /** 标记历史脏位 */
    private markHistoryDirty: () => void,
    /** Angular NgZone — 用于控制 CD 边界 */
    private ngZone?: NgZone,
    /** 变更检测回调（OnPush 模式下由组件注入 cdr.markForCheck） */
    private cdCallback?: () => void,
    /** 滚动到底部（可选，flush 后调用） */
    private scrollToBottom?: () => void,
  ) {}

  /**
   * 注册 flush 完成回调（用于在 rAF flush 后触发额外逻辑，如 scrollToBottom）
   */
  onFlush(cb: () => void): void {
    this.onFlushCallback = cb;
  }

  // ==================== 公共接口 ====================

  /**
   * 追加流式文本 — 走 rAF 批处理
   *
   * 等价于原 MessageDisplayHelper.appendMessage() 中的 streaming 路径，
   * 但延迟到下一个动画帧合并执行。
   */
  appendStreaming(role: string, text: string, source?: string): void {
    this.pendingChunks.push({ type: 'streaming_chunk', content: text, role, source });
    this.scheduleFlush();
  }

  /**
   * 立即追加消息 — 不走 rAF（用于非流式场景：error、aily-state、tool result）
   *
   * ★ 性能优化：与 pending flush 合并为单次 CD 周期（旧版先 flushNow→CD 再 _runInZone→CD = 2次）
   */
  appendImmediate(role: string, text: string, source?: string): void {
    this._immediateFlushAndRun(() => {
      this._doAppendMessage(role, text, source);
    });
  }

  /**
   * 显示工具调用状态块 — 立即执行
   * ★ 性能优化：flush + 状态更新合并为单次 CD 周期
   */
  displayToolCallState(toolCallInfo: ToolCallInfo, source?: string, toolCallStates?: { [key: string]: string }): void {
    this._immediateFlushAndRun(() => {
      const list = this.getList();
      const stateMessage = `\n\`\`\`aily-state\n{\n  "state": "${toolCallInfo.state}",\n  "text": "${_makeJsonSafe(toolCallInfo.text)}",\n  "id": "${toolCallInfo.id}"\n}\n\`\`\`\n\n\n`;

      if (toolCallInfo.state !== ToolCallState.DOING) {
        const cachedIdx = this.toolCallStateIndex.get(toolCallInfo.id);
        const newBlock =
          '```aily-state\n{\n  "state": "' + toolCallInfo.state +
          '",\n  "text": "' + _makeJsonSafe(toolCallInfo.text) +
          '",\n  "id": "' + toolCallInfo.id + '"\n}\n```';

        // ★ 性能优化：用 indexOf 定位代替正则扫描，避免 O(content_length) 回溯
        const idNeedle = '"id": "' + toolCallInfo.id + '"';

        if (cachedIdx !== undefined && cachedIdx < list.length && list[cachedIdx].role === 'aily') {
          const replaced = this._replaceAilyStateBlock(list[cachedIdx].content, idNeedle, newBlock);
          if (replaced !== null) {
            list[cachedIdx].content = replaced;
            this.markHistoryDirty();
            return;
          }
        }

        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role !== 'aily') continue;
          const replaced = this._replaceAilyStateBlock(list[i].content, idNeedle, newBlock);
          if (replaced !== null) {
            list[i].content = replaced;
            this.toolCallStateIndex.set(toolCallInfo.id, i);
            this.markHistoryDirty();
            return;
          }
        }
      }

      this._doAppendMessage('aily', stateMessage, source);
      this.toolCallStateIndex.set(toolCallInfo.id, list.length - 1);

      if (toolCallInfo.state === ToolCallState.DOING && toolCallStates) {
        toolCallStates[toolCallInfo.id] = toolCallInfo.text;
      }
    });
  }

  /**
   * 标记最后一条 aily 消息为 done
   * ★ 性能优化：flush + 状态更新合并为单次 CD 周期
   */
  markLastMessageDone(): void {
    this._immediateFlushAndRun(() => {
      const list = this.getList();
      if (list.length > 0 && list[list.length - 1].role === 'aily') {
        list[list.length - 1].state = 'done';
      }
    });
  }

  /**
   * 检查并截断 aily-button 块
   *
   * ★ 性能关键：此方法在每个 non-think streaming chunk 上被调用。
   * 不能调用 flushNow()，否则会破坏 rAF 批处理（每 chunk 触发一次 Angular CD）。
   * 改为检查 pending chunks 中是否累积了 aily-button 标记，仅在检测到时才 flush。
   */
  checkAndTruncateAilyButtonBlock(): boolean {
    // ★ 快速路径：先检查 pending chunks 中是否包含 aily-button 标记
    // 绝大多数 chunk 不含此标记，可跳过 flushNow + O(n) regex
    const hasPendingButton = this.pendingChunks.some(c => c.content.includes('aily-button'));
    if (!hasPendingButton) {
      // 也检查已 flush 的内容（极少走到这里，因为 button 通常在 pending 中）
      const list = this.getList();
      if (list.length === 0 || list[list.length - 1].role !== 'aily') return false;
      const tail = list[list.length - 1].content;
      // 只检查尾部一小段即可（aily-button 块不会超过 200 字符）
      const checkLen = Math.min(tail.length, 300);
      if (!tail.substring(tail.length - checkLen).includes('aily-button')) return false;
    }

    // 仅在可能有 aily-button 时才 flush（极少数情况）
    this.flushNow();
    const list = this.getList();
    if (list.length === 0 || list[list.length - 1].role !== 'aily') return false;
    const content = list[list.length - 1].content;
    const lastThinkEnd = content.lastIndexOf('</think>');
    if (lastThinkEnd < 0 && content.includes('<think>')) return false;
    const searchStart = lastThinkEnd >= 0 ? lastThinkEnd : 0;
    const afterThink = content.substring(searchStart);
    const match = afterThink.match(/```aily-button[\s\S]*?```/);
    if (!match) return false;
    const blockEnd = searchStart + match.index! + match[0].length;
    if (blockEnd < content.length) {
      list[list.length - 1].content = content.substring(0, blockEnd);
    }
    return true;
  }

  /**
   * 获取关闭标签（用于异常中断时补全 markdown 块）
   */
  getClosingTagsForOpenBlocks(getClosingTags: (content: string) => string): string {
    const list = this.getList();
    if (list.length === 0) return '';
    const lastMsg = list[list.length - 1];
    if (lastMsg.role !== 'aily') return '';
    return getClosingTags(lastMsg.content || '');
  }

  /**
   * 清空 list 并重置状态
   */
  reset(): void {
    this.cancelPending();
    this.toolCallStateIndex.clear();
  }

  /**
   * 强制 flush 所有 pending chunks（同步）
   * 在需要立即读取 list 最新状态时调用（如 tool_call_request 之前）
   */
  flushNow(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.doFlush();
  }

  /**
   * ★ 轻量 flush：仅将 pending chunks 合并写入 list（数据层），
   * 跳过 NgZone.run / cdCallback / scrollToBottom，避免触发同步 CD。
   *
   * 用于 tool_call_request 入口：
   *   - 数据必须立即提交（后续 buildMessages 依赖 list 完整性）
   *   - 渲染延迟到下一帧 doFlush 自然触发
   */
  flushDataOnly(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    const segments = this._computeMergedChunks();
    if (segments.length === 0) return;
    // 直接写入 list — 不进 zone，不触发 CD
    for (const seg of segments) {
      this._doAppendMessage(seg.role, seg.content, seg.source);
    }
  }

  /**
   * 销毁：取消 pending rAF
   */
  destroy(): void {
    this.cancelPending();
  }

  // ==================== 内部实现 ====================

  /** 确保回调在 Angular Zone 内执行（用于 list 变更触发 CD） */
  private _runInZone(fn: () => void): void {
    if (this.ngZone) {
      this.ngZone.run(fn);
    } else {
      fn();
    }
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return; // 已经 scheduled
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.doFlush();
    });
  }

  /**
   * 核心 flush — 将所有 pending chunks 按 (role, source) 分组合并，一次性写入 list
   * 
   * 在 NgZone.run() 内执行 list 变更，确保 OnPush 模式下 CD 被触发。
   * 合并完成后调用 cdCallback 通知组件标记脏（markForCheck）。
   */
  private doFlush(): void {
    const _s = ChatPerformanceTracer.begin('doFlush');
    const segments = this._computeMergedChunks();
    if (segments.length === 0) { ChatPerformanceTracer.end(_s, 'doFlush', 'empty'); return; }

    // 进入 Angular Zone 执行 list 变更 → 触发 CD
    this._runInZone(() => {
      for (const seg of segments) {
        this._doAppendMessage(seg.role, seg.content, seg.source);
      }
      this.cdCallback?.();
      this.scrollToBottom?.();
      this.onFlushCallback?.();
      ChatPerformanceTracer.end(_s, 'doFlush');
    });
  }

  /**
   * ★ 性能优化：用 indexOf 定位 aily-state 块中的 id 字段，
   * 然后向外扩展找到 ``` 边界并替换。避免正则回溯 O(content_length)。
   * @returns 替换后的字符串，未找到返回 null
   */
  private _replaceAilyStateBlock(content: string, idNeedle: string, newBlock: string): string | null {
    const idPos = content.indexOf(idNeedle);
    if (idPos === -1) return null;
    // 向前找 ```aily-state
    const blockStart = content.lastIndexOf('```aily-state', idPos);
    if (blockStart === -1) return null;
    // 向后找闭合 ```（跳过 aily-state 头部的 ```）
    const afterHeader = content.indexOf('\n', blockStart);
    if (afterHeader === -1) return null;
    const blockEnd = content.indexOf('```', afterHeader + 1);
    if (blockEnd === -1) return null;
    return content.substring(0, blockStart) + newBlock + content.substring(blockEnd + 3);
  }

  /**
   * ★ 合并 flush + 立即操作为单次 CD 周期
   * 旧版 flushNow()→CD + _runInZone()→CD = 2 次 CD，每次都触发 x-dialog preprocess O(n)。
   * 新版将两步合并到同一个 NgZone.run() 内，只触发 1 次 CD。
   */
  private _immediateFlushAndRun(fn: () => void): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    // 在 zone 外完成纯计算
    const segments = this._computeMergedChunks();

    // 单次 zone entry：flush mutations + action → 1 次 CD
    const _imfSpan = ChatPerformanceTracer.begin('_immediateFlushAndRun', `${segments.length}segs`);
    this._runInZone(() => {
      for (const seg of segments) {
        this._doAppendMessage(seg.role, seg.content, seg.source);
      }
      fn();
      this.cdCallback?.();
      this.scrollToBottom?.();
      this.onFlushCallback?.();
    });
    ChatPerformanceTracer.end(_imfSpan, '_immediateFlushAndRun');
  }

  /**
   * 将 pendingChunks 按 (role, source) 分组合并并清空缓冲区
   * 纯计算，无副作用（用于 doFlush 和 _immediateFlushAndRun 复用）
   */
  private _computeMergedChunks(): Array<{ role: string; content: string; source?: string }> {
    if (this.pendingChunks.length === 0) return [];

    const mergedSegments: Array<{ role: string; content: string; source?: string }> = [];
    let current: { role: string; content: string; source?: string } | null = null;

    for (const chunk of this.pendingChunks) {
      const effectiveSource = chunk.source || this.getCurrentSource();
      if (current && current.role === chunk.role && current.source === effectiveSource) {
        current.content += chunk.content;
      } else {
        if (current) mergedSegments.push(current);
        current = { role: chunk.role, content: chunk.content, source: effectiveSource };
      }
    }
    if (current) mergedSegments.push(current);

    this.pendingChunks = [];
    return mergedSegments;
  }

  /**
   * 实际追加消息到 list
   * ★ TERMINATE 检测已移除 — 由 LLM 决断是否停止对话
   * ★ ``` → \n``` 替换已移除 — 由 x-dialog preprocess/fixContent 在渲染侧统一处理
   */
  private _doAppendMessage(role: string, text: string, source?: string): void {
    // ★ 性能优化：仅在文本可能是 JSON 时才尝试解析（绝大多数 streaming chunk 不是）
    const firstChar = text.length > 0 ? text.charCodeAt(0) : 0;
    if (firstChar === 123 /* '{' */ || firstChar === 91 /* '[' */) {
      try {
        const parsedText = JSON.parse(text);
        if (typeof parsedText === 'object') {
          text = parsedText.content || JSON.stringify(parsedText, null, 2);
        }
      } catch (_) { /* not JSON */ }
    }

    this._setLastMsgContent(role, text, source);
  }

  /**
   * 低级 list 操作：追加到最后一条同角色消息或创建新消息
   */
  private _setLastMsgContent(role: string, text: string, source?: string): void {
    const msgSource = source || this.getCurrentSource();
    const list = this.getList();
    if (list.length > 0 &&
        list[list.length - 1].role === role &&
        list[list.length - 1].source === msgSource) {
      list[list.length - 1].content += text;
      if (role === 'aily' && this.getIsWaiting()) {
        list[list.length - 1].state = 'doing';
      }
    } else {
      this.pushToList({
        role, content: text,
        state: (role === 'aily' && this.getIsWaiting()) ? 'doing' : 'done',
        source: msgSource,
        modelName: this.getCurrentModelName(),
      });
    }
    this.markHistoryDirty();
  }

  private cancelPending(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    this.pendingChunks = [];
  }
}
