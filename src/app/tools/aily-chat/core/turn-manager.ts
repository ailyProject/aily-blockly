/**
 * TurnManager — Turn 结构化存储管理器（Primary Source of Truth）
 *
 * 参考 Copilot 的 ConversationHistory：
 * - Turn[] 作为 source of truth，engine.conversationMessages 是只读 getter
 * - 每次 API 调用前通过 buildMessages() 从 Turn[] 重建消息数组
 * - 上下文注入（skills/tools listing/memory）在 API 调用时瞬态插入，不存储
 * - 普通裁剪可通过瞬态 prepared messages 传递，摘要结果必须回写 Turn[]
 * - 回滚/截断使用 Turn-native 操作（removeFromTurn / truncateToTurn）
 * - 工具结果去重在 buildMessages() 中执行，不修改原始 Turn 数据
 *
 * 不可变快照契约（Copilot 对齐）：
 * - 已提交到 _turns 的 turn/round 不做就地字段修改
 * - 状态更新通过 copy-on-write 生成新对象并替换数组槽位
 * - deserialize/rebuild 等恢复路径也遵循“先构建后替换”
 */

import type {
  Turn,
  TurnRequest,
  TurnResponse,
  ToolCallRound,
  ToolCallEntry,
  ToolCallResult,
  TurnSpan,
  SerializedTurns,
} from '../core/turn-types';
import {
  sanitizeToolContent,
  truncateToolResult,
  sanitizeAssistantContent,
} from '../services/content-sanitizer.service';

export class TurnManager {
  /** 不可变 Turn 列表（source of truth） */
  private _turns: Turn[] = [];

  /** Turn 历史版本号：每次 Turn[] 发生变更时递增，用于摘要写回防竞态 */
  private _revision = 0;

  /** 缓存的消息数组（buildMessages() 的输出） */
  private _cachedMessages: any[] | null = null;
  /** 缓存的 Turn 边界跨度（与 _cachedMessages 同步更新） */
  private _cachedTurnSpans: TurnSpan[] = [];
  /** 缓存失效标记 */
  private _dirty = true;

  /**
   * 信息类工具名称集合（与 ContextBudgetService.INFO_TOOLS 保持同步）
   * 用于标记 TurnSpan.hasInfoTools，帮助 prioritizedTrim 做 Turn 级价值评估
   */
  private static readonly INFO_TOOLS = new Set([
    'read_file', 'fetch', 'web_search', 'grep', 'grep_tool', 'glob_tool',
    'get_directory_tree', 'list_directory', 'search_boards_libraries',
    'get_workspace_overview_tool',
  ]);

  private createToolCallRoundId(): string {
    return `round_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private createSummaryMessage(summary: string): any {
    return {
      role: 'system',
      content: `<conversation-summary>\n${summary}\n</conversation-summary>`
    };
  }

  private clearSummaryState(turns: Turn[]): Turn[] {
    let changed = false;

    const nextTurns = turns.map(turn => {
      const originalRounds = turn.response?.toolCallRounds;
      let roundsChanged = false;

      const nextRounds = originalRounds?.map(round => {
        if (!round.summary) {
          return round;
        }
        roundsChanged = true;
        changed = true;
        const { summary: _summary, ...rest } = round;
        return rest;
      });

      const hasTurnSummary = !!turn.metadata?.summary;
      const nextMetadata = hasTurnSummary
        ? (() => {
            const { summary: _summary, ...rest } = turn.metadata!;
            return Object.keys(rest).length > 0 ? rest : undefined;
          })()
        : turn.metadata;

      if (hasTurnSummary) {
        changed = true;
      }

      if (!roundsChanged && nextMetadata === turn.metadata) {
        return turn;
      }

      return {
        ...turn,
        metadata: nextMetadata,
        response: turn.response
          ? {
              ...turn.response,
              toolCallRounds: roundsChanged ? (nextRounds ?? []) : turn.response.toolCallRounds,
            }
          : turn.response,
      };
    });

    return changed ? nextTurns : turns;
  }

  private findSummaryAnchor(): { turnIndex: number; roundIndex: number; summary: string } | null {
    for (let turnIndex = this._turns.length - 1; turnIndex >= 0; turnIndex--) {
      const turn = this._turns[turnIndex];
      const rounds = turn.response?.toolCallRounds ?? [];

      for (let roundIndex = rounds.length - 1; roundIndex >= 0; roundIndex--) {
        const summary = rounds[roundIndex].summary?.trim();
        if (summary) {
          return { turnIndex, roundIndex, summary };
        }
      }

      const turnSummary = turn.metadata?.summary?.trim();
      if (turnSummary) {
        return { turnIndex, roundIndex: -1, summary: turnSummary };
      }
    }

    return null;
  }



  // ==================== 读取 ====================

  /** 获取所有 Turn（只读视图） */
  get turns(): readonly Turn[] {
    return this._turns;
  }

  /** 获取 Turn 快照（结构化拷贝，避免外部误修改内部引用） */
  get turnsSnapshot(): readonly Turn[] {
    return structuredClone(this._turns);
  }

  get length(): number {
    return this._turns.length;
  }

  /** 当前 Turn 历史版本号 */
  get revision(): number {
    return this._revision;
  }

  /** 获取最后一个 Turn */
  get lastTurn(): Turn | undefined {
    return this._turns[this._turns.length - 1];
  }

  /**
   * 获取 Turn 边界跨度（与 buildMessages() 的输出对应）
   *
   * 供 ContextBudgetService.prioritizedTrim() 使用，
   * 保证裁剪以 Turn 为最小单元，不拆散 tool_call ↔ tool_result 配对。
   */
  get turnSpans(): readonly TurnSpan[] {
    // 确保 messages 已构建（spans 随 buildMessages 一起生成）
    this.buildMessages();
    return this._cachedTurnSpans;
  }

  /** 获取最后一个 Turn 的 ID（用于 checkpoint 关联） */
  get currentTurnId(): string | undefined {
    return this._turns[this._turns.length - 1]?.id;
  }

  // ==================== Turn 生命周期 ====================

  /**
   * 开启新 Turn（用户发送消息时调用）
   * @returns 新 Turn 的 id
   */
  startTurn(userContent: string): string {
    const id = this.generateTurnId();
    const turn: Turn = {
      id,
      request: {
        content: userContent,
        timestamp: Date.now(),
      },
    };
    this._turns = [...this._turns, turn];
    this.invalidateCache();
    return id;
  }

  /**
   * 记录当前 Turn 中一轮 LLM 响应和工具调用
   *
   * 每次 SSE 流完成（含 tool_calls）后调用，
   * 将 assistant 文本 + tool_calls 收集为一个 ToolCallRound。
   *
   * @param assistantContent 本轮 LLM 输出的文本
   * @param toolCalls 本轮 LLM 请求的工具调用列表
   */
  addToolCallRound(assistantContent: string, toolCalls: ToolCallEntry[]): void {
    const lastIdx = this._turns.length - 1;
    if (lastIdx < 0) return;

    const turn = this._turns[lastIdx];
    const response = turn.response ?? { content: '', toolCallRounds: [] };

    const round: ToolCallRound = {
      id: this.createToolCallRoundId(),
      assistantContent: assistantContent || '',
      toolCalls,
      results: {},
    };

    const nextTurn: Turn = {
      ...turn,
      response: {
        ...response,
        toolCallRounds: [...response.toolCallRounds, round],
      },
    };

    const nextTurns = [...this._turns];
    nextTurns[lastIdx] = nextTurn;
    this._turns = nextTurns;
    this.invalidateCache();
  }

  /**
   * 记录工具执行结果
   *
   * 在工具执行完成时调用，将结果关联到对应的 ToolCallRound。
   */
  addToolResult(toolCallId: string, result: ToolCallResult): void {
    const lastIdx = this._turns.length - 1;
    if (lastIdx < 0) return;

    const turn = this._turns[lastIdx];
    if (!turn.response) return;

    const rounds = turn.response.toolCallRounds;
    if (rounds.length === 0) return;

    let targetRoundIdx = -1;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (rounds[i].toolCalls.some(tc => tc.id === toolCallId)) {
        targetRoundIdx = i;
        break;
      }
    }

    if (targetRoundIdx < 0) {
      targetRoundIdx = rounds.length - 1;
    }

    const nextRounds = rounds.map((round, idx) => {
      if (idx !== targetRoundIdx) {
        return round;
      }
      return {
        ...round,
        results: {
          ...round.results,
          [toolCallId]: result,
        },
      };
    });

    const nextTurn: Turn = {
      ...turn,
      response: {
        ...turn.response,
        toolCallRounds: nextRounds,
      },
    };

    const nextTurns = [...this._turns];
    nextTurns[lastIdx] = nextTurn;
    this._turns = nextTurns;
    this.invalidateCache();
  }

  /**
   * 完成当前 Turn 的最终 assistant 响应（无工具调用的最终文本）
   *
   * 在 finalizeStatelessTurn() 中调用（SSE 流完成且无 pending tool results）。
   */
  finalizeTurn(assistantContent: string): void {
    const lastIdx = this._turns.length - 1;
    if (lastIdx < 0) return;

    const turn = this._turns[lastIdx];
    const nextResponse = turn.response
      ? { ...turn.response, content: assistantContent }
      : { content: assistantContent, toolCallRounds: [] };

    const nextTurn: Turn = {
      ...turn,
      response: nextResponse,
    };

    const nextTurns = [...this._turns];
    nextTurns[lastIdx] = nextTurn;
    this._turns = nextTurns;
    this.invalidateCache();
  }

  // ==================== 消息构建（Copilot 风格：每次 fresh render） ====================

  /**
   * 从 Turn[] 构建 LLM 消息数组
   *
   * 参考 Copilot 的 PromptRenderer — 每次调用都重新构建，
   * 不依赖上次的结果。上下文注入（skills/tools/memory）由调用方在
   * 返回数组上追加。
   *
   * @returns 标准 LLM messages 数组 [{ role, content, tool_calls?, tool_call_id?, name? }]
   */
  buildMessages(): any[] {
    if (!this._dirty && this._cachedMessages) {
      return this._cachedMessages;
    }

    const messages: any[] = [];
    const turnSpans: TurnSpan[] = [];
    const summaryAnchor = this.findSummaryAnchor();

    for (let turnIdx = 0; turnIdx < this._turns.length; turnIdx++) {
      if (summaryAnchor && turnIdx < summaryAnchor.turnIndex) {
        continue;
      }

      const turn = this._turns[turnIdx];
      const spanStart = messages.length;
      let hasInfoTools = false;

      const isAnchorTurn = !!summaryAnchor && summaryAnchor.turnIndex === turnIdx;
      const renderTurnLevelSummary = isAnchorTurn && summaryAnchor!.roundIndex === -1;
      const renderRoundLevelSummary = isAnchorTurn && summaryAnchor!.roundIndex >= 0;

      if (renderTurnLevelSummary) {
        messages.push(this.createSummaryMessage(summaryAnchor!.summary));
      } else {
        // User message
        messages.push({
          role: 'user',
          content: turn.request.content,
        });
      }

      if (!turn.response) {
        turnSpans.push({
          turnId: turn.id,
          turnIndex: turnIdx,
          startIdx: spanStart,
          endIdx: messages.length,
          hasInfoTools: false,
        });
        continue;
      }

      const rounds = turn.response.toolCallRounds;

      if (rounds.length === 0) {
        // 无工具调用的简单响应
        if (turn.response.content) {
          messages.push({
            role: 'assistant',
            content: sanitizeAssistantContent(turn.response.content),
          });
        }
        turnSpans.push({
          turnId: turn.id,
          turnIndex: turnIdx,
          startIdx: spanStart,
          endIdx: messages.length,
          hasInfoTools: false,
        });
        continue;
      }

      const firstRoundIndex = renderRoundLevelSummary ? summaryAnchor!.roundIndex + 1 : 0;
      if (renderRoundLevelSummary) {
        messages.push(this.createSummaryMessage(summaryAnchor!.summary));
      }

      for (let roundIndex = firstRoundIndex; roundIndex < rounds.length; roundIndex++) {
        const round = rounds[roundIndex];
        // 清理中间轮内容：移除 <think>、aily-state 等 UI 标记，保留有意义的输出文本
        const content = sanitizeAssistantContent(round.assistantContent || '');

        const assistantMsg: any = {
          role: 'assistant',
          content,
        };

        // 工具调用格式
        if (round.toolCalls.length > 0) {
          assistantMsg.tool_calls = round.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }

        messages.push(assistantMsg);

        // Tool results — 同时检测是否包含信息类工具
        for (const tc of round.toolCalls) {
          const result = round.results[tc.id];
          if (result) {
            if (TurnManager.INFO_TOOLS.has(result.toolName)) {
              hasInfoTools = true;
            }
            messages.push({
              role: 'tool',
              tool_call_id: tc.id,
              name: result.toolName,
              content: truncateToolResult(sanitizeToolContent(result.content), result.toolName),
            });
          }
        }
      }

      // 最终 assistant 文本（tool loop 结束后 LLM 返回的最终回答）
      if (turn.response.content) {
        // 检查最后一条是不是 assistant 消息，如果是的话可以合并
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'assistant' && !lastMsg.tool_calls) {
          lastMsg.content = sanitizeAssistantContent(turn.response.content);
        } else {
          messages.push({
            role: 'assistant',
            content: sanitizeAssistantContent(turn.response.content),
          });
        }
      }

      turnSpans.push({
        turnId: turn.id,
        turnIndex: turnIdx,
        startIdx: spanStart,
        endIdx: messages.length,
        hasInfoTools,
      });
    }

    // 工具结果去重：同名工具的重复结果折叠以节省 token
    this.deduplicateToolResults(messages);

    this._cachedMessages = messages;
    this._cachedTurnSpans = turnSpans;
    this._dirty = false;
    return messages;
  }



  // ==================== 回滚 / 截断 ====================

  /**
   * 回滚到指定 Turn（包含该 Turn）
   * 用于 restoreToCheckpoint / regenerateTurn
   */
  truncateToTurn(turnId: string): void {
    const idx = this._turns.findIndex(t => t.id === turnId);
    if (idx >= 0) {
      const targetTurn = this._turns[idx];
      const { response: _response, ...rest } = targetTurn;
      this._turns = [...this._turns.slice(0, idx), rest];
      this.invalidateCache();
    }
  }

  /**
   * 删除指定 Turn 及之后的所有 Turn
   * 用于 restoreToCheckpoint（恢复到某 turn 之前的状态）
   */
  removeFromTurn(turnId: string): void {
    const idx = this._turns.findIndex(t => t.id === turnId);
    if (idx >= 0) {
      this._turns = this._turns.slice(0, idx);
      this.invalidateCache();
    }
  }

  /**
   * 移除最后一个 Turn（如果它没有 response）
   */
  removeIncompleteLast(): void {
    if (this._turns.length > 0 && !this._turns[this._turns.length - 1].response) {
      this._turns = this._turns.slice(0, -1);
      this.invalidateCache();
    }
  }

  // ==================== 压缩标记 ====================

  /**
   * 标记指定范围的 Turn 为已摘要化
   */
  applySummary(
    turnIds: string[],
    anchorTurnId: string,
    summary: string,
    _source: 'background' | 'foreground',
    anchorRoundId?: string,
    expectedRevision?: number
  ): boolean {
    if (!turnIds.length || !summary.trim()) {
      return false;
    }

    if (typeof expectedRevision === 'number' && expectedRevision !== this._revision) {
      // revision 不匹配仅做日志警告，不阻断写入。
      // 后续的 turn 前缀校验 + round ID 校验已足够防止过期写回；
      // revision 在任何 invalidateCache() 时递增（包括新 turn 追加），
      // 后台摘要期间用户继续对话会导致 revision 漂移，但被覆盖的旧 turn 并未变化。
      console.warn(`[TurnManager] 摘要写回 revision 不匹配（expected=${expectedRevision}, current=${this._revision}），继续校验 turn 前缀`);
    }

    // stale guard: 仅在“待覆盖 turn 列表”与当前历史前缀一致时应用摘要。
    // 防止后台摘要在历史已变更后错误写回。
    const anchorIdxInCurrent = this._turns.findIndex(turn => turn.id === anchorTurnId);
    if (anchorIdxInCurrent < 0) {
      return false;
    }
    const expectedCoveredIds = this._turns.slice(0, anchorIdxInCurrent + 1).map(turn => turn.id);
    if (
      turnIds.length !== expectedCoveredIds.length ||
      !turnIds.every((id, idx) => id === expectedCoveredIds[idx])
    ) {
      console.warn('[TurnManager] 跳过过期摘要写回：covered turn 列表与当前历史前缀不一致');
      return false;
    }

    const baseTurns = this.clearSummaryState(this._turns);
    const anchorTurnIdx = baseTurns.findIndex(turn => turn.id === anchorTurnId);
    if (anchorTurnIdx < 0) {
      return false;
    }

    const anchorTurn = baseTurns[anchorTurnIdx];

    if (anchorRoundId) {
      const rounds = anchorTurn.response?.toolCallRounds ?? [];
      const anchorRoundIdx = rounds.findIndex(round => round.id === anchorRoundId);
      if (anchorRoundIdx >= 0 && anchorTurn.response) {
        const nextRounds = rounds.map((round, idx) =>
          idx === anchorRoundIdx ? { ...round, summary } : round
        );
        const nextTurn: Turn = {
          ...anchorTurn,
          response: {
            ...anchorTurn.response,
            toolCallRounds: nextRounds,
          },
        };
        const nextTurns = [...baseTurns];
        nextTurns[anchorTurnIdx] = nextTurn;
        this._turns = nextTurns;
        this.invalidateCache();
        return true;
      }

      // 若调用方明确指定了 round 锚点，但当前 turn 中已不存在该 round，
      // 说明摘要结果与当前历史快照不一致（过期/竞态），直接跳过写回。
      console.warn('[TurnManager] 跳过过期摘要写回：anchorRoundId 在当前 turn 中不存在');
      return false;
    }

    const nextTurn: Turn = {
      ...anchorTurn,
      metadata: {
        ...(anchorTurn.metadata ?? {}),
        summary,
      },
    };
    const nextTurns = [...baseTurns];
    nextTurns[anchorTurnIdx] = nextTurn;
    this._turns = nextTurns;

    this.invalidateCache();
    return true;
  }

  // ==================== 序列化 ====================

  /**
   * 序列化为可持久化格式
   */
  serialize(): SerializedTurns {
    const turns = structuredClone(this._turns);

    // turn.metadata.summary 仅用于兼容旧数据或无 rounds 场景。
    // 若已有 round.summary，则不再冗余持久化 turn 级摘要。
    for (const turn of turns) {
      const rounds = turn.response?.toolCallRounds ?? [];
      const hasRoundSummary = rounds.some(round => !!round.summary?.trim());
      if (hasRoundSummary && turn.metadata) {
        delete turn.metadata.summary;
        if (Object.keys(turn.metadata).length === 0) {
          delete turn.metadata;
        }
      }
    }

    return {
      version: 1,
      turns,
    };
  }

  /**
   * 从序列化数据恢复
   */
  deserialize(data: SerializedTurns): void {
    if (data?.version === 1 && Array.isArray(data.turns)) {
      const clonedTurns = structuredClone(data.turns as Turn[]);
      this._turns = clonedTurns.map(turn => {
        const rounds = turn.response?.toolCallRounds ?? [];
        const hadMissingRoundId = rounds.some(round => !round.id);
        const normalizedRounds = rounds.map(round =>
          round.id ? round : { ...round, id: this.createToolCallRoundId() }
        );

        let migratedRounds = normalizedRounds;
        let migratedSummary = false;
        if (turn.metadata?.summary && normalizedRounds.length > 0 && !normalizedRounds.some(round => !!round.summary)) {
          const lastRoundIdx = normalizedRounds.length - 1;
          migratedRounds = normalizedRounds.map((round, idx) =>
            idx === lastRoundIdx ? { ...round, summary: turn.metadata!.summary } : round
          );
          migratedSummary = true;
        }

        if (!turn.response) {
          return turn;
        }

        if (!hadMissingRoundId && !migratedSummary) {
          return turn;
        }

        return {
          ...turn,
          response: {
            ...turn.response,
            toolCallRounds: migratedRounds,
          },
        };
      });
      this.invalidateCache();
    }
  }

  /**
   * @deprecated 仅用于旧快照兼容（无 turnId 的历史检查点）。
   * 新代码应使用 removeFromTurn() / truncateToTurn() 进行 Turn-native 截断。
   *
   * 从消息数组重建 Turn[]
   */
  rebuildFromMessages(messages: any[]): void {
    const rebuiltTurns: Turn[] = [];
    if (!messages || messages.length === 0) {
      this._turns = [];
      this.invalidateCache();
      return;
    }

    let currentTurn: Turn | null = null;
    let currentRound: ToolCallRound | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // 跳过 <aily-context> 注入消息
      if (msg.role === 'user' && msg.content?.startsWith('<aily-context>')) {
        continue;
      }

      if (msg.role === 'user') {
        // 新 Turn 开始
        if (currentTurn) {
          rebuiltTurns.push(currentTurn);
        }
        currentTurn = {
          id: this.generateTurnId(),
          request: { content: msg.content || '', timestamp: Date.now() },
        };
        currentRound = null;
      } else if (msg.role === 'assistant' && currentTurn) {
        if (!currentTurn.response) {
          currentTurn.response = { content: '', toolCallRounds: [] };
        }

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // 有 tool_calls 的 assistant 消息 → 新建一个 ToolCallRound
          currentRound = {
            id: this.createToolCallRoundId(),
            assistantContent: msg.content || '',
            toolCalls: msg.tool_calls.map((tc: any) => ({
              id: tc.id,
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '{}',
            })),
            results: {},
          };
          currentTurn.response.toolCallRounds.push(currentRound);
        } else {
          // 纯文本 assistant 消息
          currentTurn.response.content += (msg.content || '');
        }
      } else if (msg.role === 'tool' && currentRound) {
        // 工具结果 → 关联到当前 round
        const toolCallId = msg.tool_call_id;
        if (toolCallId) {
          currentRound.results[toolCallId] = {
            content: msg.content || '',
            isError: false,
            toolName: msg.name || '',
          };
        }
      }
    }

    // 推入最后一个 turn
    if (currentTurn) {
      rebuiltTurns.push(currentTurn);
    }

    this._turns = rebuiltTurns;
    this.invalidateCache();
  }

  // ==================== 重置 ====================

  clear(): void {
    this._turns = [];
    this.invalidateCache();
  }

  // ==================== 工具结果去重 ====================

  /**
   * 折叠同名工具的重复结果以节省 token（在 buildMessages 输出上执行）。
   * 仅修改 built messages 数组，不影响原始 Turn 数据。
   */
  private deduplicateToolResults(messages: any[]): void {
    const toolsByName = new Map<string, number[]>();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool' && messages[i].name) {
        const indices = toolsByName.get(messages[i].name) || [];
        indices.push(i);
        toolsByName.set(messages[i].name, indices);
      }
    }

    let foldedCount = 0;
    for (const [name, indices] of toolsByName) {
      if (indices.length <= 1) continue;
      for (let i = indices.length - 1; i > 0; i--) {
        const newerContent = messages[indices[i]].content || '';
        for (let j = 0; j < i; j++) {
          const olderContent = messages[indices[j]].content || '';
          if (olderContent && newerContent && olderContent.length >= 80 && olderContent === newerContent) {
            messages[indices[j]].content = `[与后续 ${name} 调用结果相同，已折叠]`;
            foldedCount++;
          }
        }
      }
    }
    if (foldedCount > 0) {
      console.log(`[TurnManager] 折叠了 ${foldedCount} 条重复工具结果`);
    }
  }

  // ==================== 内部方法 ====================

  private invalidateCache(): void {
    this._revision += 1;
    this._dirty = true;
    this._cachedMessages = null;
    this._cachedTurnSpans = [];
  }

  private generateTurnId(): string {
    return `turn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}
