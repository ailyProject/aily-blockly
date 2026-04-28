/**
 * 具体 PromptElementProvider 实现
 *
 * 每个 Provider 对应管线中的一个逻辑槽位：
 *   - ContextInjectionProvider    → 瞬态上下文（skills/memory/deferred tools）
 *   - ConversationHistoryProvider → 历史对话消息（从 TurnManager 构建）
 *   - ToolContinuationProvider    → 工具续写提示（P6）
 *
 * 参考 Copilot prompt-tsx 的 TSX 组件模式：
 *   <ContextInjection priority={750} />
 *   <ConversationHistory priority={700} flexGrow={1} />
 *   <ToolContinuation priority={690} />
 */

import {
  PromptElement,
  PromptElementProvider,
  PromptBuildContext,
  PromptPriority,
  ChatMessage,
} from './prompt-elements';
// (estimateTokenCount removed — prompt pipeline uses fast O(1) estimation)
import { SkillRegistry } from '../core/skill-registry';
import { getDeferredToolsListing } from '../tools/tools';
import { getMemoryPromptSnippet } from '../tools/memoryTool';
import { ASK_MODE_ROLE_TEXT } from '../services/stream-constants';

// ==================== 工具续写提示常量 ====================

const TOOL_CONTINUATION_PROMPT =
  'Above are the results of calling one or more tools. The user cannot see these results, so you should explain them clearly if needed. Continue your task based on these tool results.';

/** ★ P0-perf: prompt pipeline 裁剪只需要相对大小对比，不需要精确 token 数。
 *  用 O(1) 的字符长度估算代替 O(n) 逐字符遍历，避免多轮后同步阻塞主线程。
 *  精确计算已在 startChatTurn → updateBudgetAsync 中通过 Worker 异步完成。
 */
export function fastEstimateMessageTokens(msg: any): number {
  let chars = 4; // overhead
  if (msg.content) chars += msg.content.length;
  if (msg.name) chars += msg.name.length;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      chars += 4;
      if (tc.id) chars += tc.id.length;
      if (tc.function?.name) chars += tc.function.name.length;
      if (tc.function?.arguments) {
        chars += typeof tc.function.arguments === 'string'
          ? tc.function.arguments.length
          : JSON.stringify(tc.function.arguments).length;
      }
    }
  }
  // 混合中英文平均 ~0.4 token/char（CJK ~0.67, ASCII ~0.25）
  return Math.ceil(chars * 0.4);
}

export function fastEstimateMessagesTokens(messages: any[]): number {
  if (!messages || messages.length === 0) return 0;
  let total = 2;
  for (const msg of messages) total += fastEstimateMessageTokens(msg);
  return total;
}

// ==================== ContextInjectionProvider ====================

/**
 * 瞬态上下文注入 — 对应 Copilot CustomInstructions 组件
 *
 * 将 skills / deferred tools listing / memory snippet 组装为
 * `<aily-context>` 消息，以 priority 750 注入。
 *
 * 注册顺序：第 1 个（消息数组开头，历史之前）
 */
export class ContextInjectionProvider implements PromptElementProvider {
  id = 'context-injection';

  /**
   * @param getAgentExcludedTools 获取被禁用工具名称集合的回调
   */
  constructor(
    private getAgentExcludedTools: (agentName: string) => Set<string>
  ) {}

  build(context: PromptBuildContext): PromptElement | null {
    const { mode, messageSource } = context;
    if (messageSource !== 'mainAgent') return null;

    const parts: string[] = [];

    if (mode === 'agent') {
      const skillsContent = SkillRegistry.getActiveSkillsContent(messageSource);
      if (skillsContent) parts.push(skillsContent);
    } else {
      parts.push(`<rules>${ASK_MODE_ROLE_TEXT}</rules>`);
    }

    const deferredListing = getDeferredToolsListing(
      messageSource,
      this.getAgentExcludedTools(messageSource)
    );
    if (deferredListing) parts.push(deferredListing);

    const skillsListing = SkillRegistry.getSkillsListing(messageSource);
    if (skillsListing) parts.push(skillsListing);

    const memorySnippet = getMemoryPromptSnippet();
    if (memorySnippet) parts.push(memorySnippet);

    if (parts.length === 0) return null;

    const content = `<aily-context>\n${parts.join('\n')}\n</aily-context>`;
    const message: ChatMessage = { role: 'user', content };
    const tokens = Math.ceil(content.length * 0.4);

    return {
      id: this.id,
      priority: PromptPriority.CONTEXT_INJECTION,
      messages: [message],
      tokens,
      evictable: false, // 上下文指令永远保留
    };
  }
}

// ==================== ConversationHistoryProvider ====================

/**
 * 历史对话 — 对应 Copilot HistoryMessages 组件
 *
 * 从 TurnManager.buildMessages() 获取所有历史消息，
 * 按 TurnSpan 生成子 Element：
 *   - 当前 Turn → priority 899，不可淘汰
 *   - 含信息类工具的 Turn → priority 750，flexGrow=1
 *   - 普通历史 Turn → priority 700
 *   - 最旧历史 → priority 100
 *
 * 注册顺序：第 2 个（context 之后）
 */
export class ConversationHistoryProvider implements PromptElementProvider {
  id = 'conversation-history';

  build(context: PromptBuildContext): PromptElement | null {
    const { engine } = context;
    const { turnManager, turnLoop } = engine;

    // 优先使用预裁剪过的消息，否则从 Turn 构建
    const messages: any[] = turnLoop._preparedMessages
      ?? turnManager.buildMessages();
    turnLoop._preparedMessages = null;

    if (!messages || messages.length === 0) return null;

    // 获取 TurnSpan 元数据
    const turnSpans: any[] = turnManager.turnSpans ? [...turnManager.turnSpans] : [];
    const totalTurns = turnSpans.length;

    if (turnSpans.length === 0) {
      // 没有 TurnSpan 信息：整体作为一个 Element
      const tokens = fastEstimateMessagesTokens(messages);
      return {
        id: this.id,
        priority: PromptPriority.HISTORY_BASE,
        flexGrow: 1,
        messages,
        tokens,
      };
    }

    // 有 TurnSpan：按 Turn 生成子 Element，每个 Turn 独立参与淘汰
    const children: PromptElement[] = [];

    for (let i = 0; i < turnSpans.length; i++) {
      const span = turnSpans[i];
      const isCurrentTurn = (i === totalTurns - 1);
      const isOldest = (i === 0 && totalTurns > 3);
      const turnMessages = messages.slice(span.startIdx, span.endIdx);
      const tokens = fastEstimateMessagesTokens(turnMessages);

      let priority: number;
      let evictable = true;
      let flexGrow: number | undefined;

      if (isCurrentTurn) {
        priority = PromptPriority.CURRENT_TURN;
        evictable = false;
      } else if (span.hasInfoTools) {
        priority = PromptPriority.HISTORY_INFO;
        flexGrow = 1;
      } else if (isOldest) {
        priority = PromptPriority.HISTORY_OLDEST;
      } else {
        priority = PromptPriority.HISTORY_BASE;
      }

      children.push({
        id: `turn-${span.turnId ?? i}`,
        priority,
        messages: turnMessages,
        tokens,
        evictable,
        flexGrow,
      });
    }

    // 父 Element：空消息容器，子 Element 承载实际内容
    const totalTokens = children.reduce((sum, c) => sum + c.tokens, 0);
    return {
      id: this.id,
      priority: PromptPriority.HISTORY_BASE,
      messages: [],
      tokens: totalTokens,
      children,
    };
  }
}

// ==================== ToolContinuationProvider ====================

/**
 * 工具续写提示 — P6 特性
 *
 * 当 toolCallingIteration > 0 时（本轮有工具结果），
 * 在消息末尾追加续写提示。
 *
 * 参考 Copilot toolCallingLoop 的 "Please continue" 注入。
 *
 * 注册顺序：最后一个（消息数组末尾）
 */
export class ToolContinuationProvider implements PromptElementProvider {
  id = 'tool-continuation';

  build(context: PromptBuildContext): PromptElement | null {
    if (context.toolCallingIteration <= 0) return null;

    const message: ChatMessage = {
      role: 'user',
      content: TOOL_CONTINUATION_PROMPT,
    };
    const tokens = 50; // 固定常量字符串 ~170 chars ≈ 50 tokens

    return {
      id: this.id,
      priority: PromptPriority.TOOL_CONTINUATION,
      messages: [message],
      tokens,
      evictable: true,
    };
  }
}
