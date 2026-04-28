/**
 * MessageDisplayHelper — 消息显示与操作辅助类
 *
 * 负责聊天消息的追加、工具调用状态显示、历史解析、
 * TERMINATE 前缀检测、aily-button 截断等逻辑。
 */

import type { ChatEngineService } from '../services/chat-engine.service';
import { ChatMessage, ToolCallState, ToolCallInfo } from '../core/chat-types';
import {
  makeJsonSafe as _makeJsonSafe,
  markContentAsHistory as _markContentAsHistory,
  getClosingTagsForOpenBlocks as _getClosingTagsForOpenBlocks,
  sanitizeAssistantContent as _sanitizeAssistantContent,
  sanitizeToolContent as _sanitizeToolContent,
  truncateToolResult as _truncateToolResult,
} from '../services/content-sanitizer.service';
import {
  generateToolStartText as _generateToolStartText,
  generateToolResultText as _generateToolResultText,
} from '../services/tool-display.service';

export class MessageDisplayHelper {
  constructor(private engine: ChatEngineService) {}

  // ==================== 纯函数包装 ====================

  makeJsonSafe(str: string): string { return _makeJsonSafe(str); }
  sanitizeAssistantContent(content: string): string { return _sanitizeAssistantContent(content); }
  sanitizeToolContent(content: string): string { return _sanitizeToolContent(content); }
  truncateToolResult(content: string, toolName?: string, maxChars?: number): string { return _truncateToolResult(content, toolName, maxChars); }

  getClosingTagsForOpenBlocks(): string {
    return this.engine.viewAdapter.getClosingTagsForOpenBlocks(_getClosingTagsForOpenBlocks);
  }

  cleanupLastAiMessage(): void {
    // no-op: cleanup logic removed to prevent aily-state block corruption
  }

  checkAndTruncateAilyButtonBlock(): boolean {
    return this.engine.viewAdapter.checkAndTruncateAilyButtonBlock();
  }

  // ==================== 工具调用状态显示 ====================

  displayToolCallState(toolCallInfo: ToolCallInfo, source?: string): void {
    this.engine.viewAdapter.displayToolCallState(toolCallInfo, source, this.engine.toolCallStates);
  }

  startToolCall(toolId: string, toolName: string, text: string, args?: any, source?: string): void {
    text = this.makeJsonSafe(text);
    const toolCallInfo: ToolCallInfo = { id: toolId, name: toolName, state: ToolCallState.DOING, text, args };
    this.displayToolCallState(toolCallInfo, source);
  }

  completeToolCall(toolId: string, toolName: string, state: ToolCallState, text: string, source?: string): void {
    const displayText = text || this.engine.toolCallStates[toolId] || '';
    const toolCallInfo: ToolCallInfo = { id: toolId, name: toolName, state, text: displayText };
    this.displayToolCallState(toolCallInfo, source);
    delete this.engine.toolCallStates[toolId];
  }

  // ==================== 历史解析 ====================

  parseHistory(historyData: any[]): void {
    const toolCallMap = new Map<string, { name: string, args?: any }>();
    historyData.forEach(item => {
      if (item.type === 'ToolCallRequestEvent' && Array.isArray(item.content)) {
        item.content.forEach(call => {
          if (call.id && call.name) {
            let args = null;
            try { args = call.arguments ? JSON.parse(call.arguments) : null; } catch (e) { console.warn('解析工具参数失败:', e); }
            toolCallMap.set(call.id, { name: call.name, args });
            const startText = _generateToolStartText(call.name, args);
            this.displayToolCallState({ id: call.id, name: call.name, state: ToolCallState.DOING, text: startText, args });
          }
        });
      } else if (item.type === 'ToolCallExecutionEvent' && Array.isArray(item.content)) {
        item.content.forEach(result => {
          if (result.call_id && toolCallMap.has(result.call_id)) {
            const toolInfo = toolCallMap.get(result.call_id)!;
            const resultState = result?.is_error ? ToolCallState.ERROR : ToolCallState.DONE;
            const resultText = _generateToolResultText(toolInfo.name, toolInfo.args, result);
            this.displayToolCallState({ id: result.call_id, name: toolInfo.name, state: resultState, text: resultText, args: toolInfo.args });
            toolCallMap.delete(result.call_id);
          }
        });
      } else {
        this.appendMessage(item.role, _markContentAsHistory(item.content));
      }
    });
    toolCallMap.forEach((toolInfo, callId) => {
      this.displayToolCallState({
        id: callId, name: toolInfo.name, state: ToolCallState.ERROR,
        text: `${_generateToolStartText(toolInfo.name, toolInfo.args)} (会话中断)`, args: toolInfo.args
      });
    });
  }

  // ==================== 消息追加 ====================

  /**
   * 追加流式文本 — 走 rAF 批处理（每帧合并一次，而非每 token 触发 Angular CD）
   *
   * 仅用于 SSE ModelClientStreamingChunkEvent 的 data.content。
   * 所有非流式内容（aily-state/error/button 块、工具结果等）走 appendMessage()。
   */
  appendStreaming(role: string, text: string, source?: string): void {
    this.engine.viewAdapter.appendStreaming(role, text, source);
  }

  setLastMsgContent(role: string, text: string, source?: string): void {
    // 立即路径：先 flush 所有 pending streaming
    this.engine.viewAdapter.appendImmediate(role, text, source);
  }

  appendMessage(role: string, text: string, source?: string): void {
    // 非流式追加：先 flush pending，再立即写入
    this.engine.viewAdapter.appendImmediate(role, text, source);
  }
}
