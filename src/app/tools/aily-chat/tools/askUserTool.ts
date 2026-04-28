/**
 * ask_user 工具 — 向用户提问并等待回答
 *
 * 参考 VS Code Copilot 的 vscode_askQuestions 工具设计：
 * - 统一使用 questions 数组，单问题即长度为 1 的数组
 * - 每个问题可有选项列表（含描述、推荐标记）
 * - 支持多选 / 自由输入
 *
 * 工具执行时会暂停 LLM 对话，等待用户在聊天界面中回答后再继续。
 */

import { ToolUseResult } from './tools';

// ============================
// 类型定义
// ============================

/** 单个选项（富信息） */
export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

/** 问题定义 */
export interface AskUserQuestion {
  question: string;
  options?: AskUserOption[];
  allow_freeform?: boolean;
  multi_select?: boolean;
}

/** 工具入参 */
export interface AskUserArgs {
  questions: AskUserQuestion[];
}

/** 单个问题的回答 */
export interface AskUserAnswer {
  selected: string[];
  freeText: string | null;
  skipped: boolean;
}

/** 全部问题的回答 */
export interface AskUserFullResponse {
  answers: Record<string, AskUserAnswer>;
}

/** 兼容旧回调的单问题应答 */
export interface AskUserResponse {
  answer: string;
  wasFreeform: boolean;
}

// ============================
// 全局回调注册
// ============================

type AskUserFullCallback = (questions: AskUserQuestion[]) => Promise<AskUserFullResponse | undefined>;

let _registeredCallback: AskUserFullCallback | null = null;

/**
 * 注册用户交互回调。由 UI 层（ChatEngineService）初始化时调用。
 * 回调负责在聊天界面显示全部问题和选项，等待用户逐题回答后返回完整结果。
 */
export function registerAskUserCallback(cb: AskUserFullCallback): void {
  _registeredCallback = cb;
}

/**
 * 取消注册回调（组件销毁时调用）
 */
export function unregisterAskUserCallback(): void {
  _registeredCallback = null;
}

// ============================
// 工具执行函数
// ============================

export async function askUserTool(args: AskUserArgs): Promise<ToolUseResult> {
  try {
    const { questions } = args;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return {
        is_error: true,
        content: '参数错误：questions 数组不能为空',
      };
    }

    const validQuestions = questions.filter(
      q => q.question && typeof q.question === 'string' && q.question.trim().length > 0,
    );
    if (validQuestions.length === 0) {
      return { is_error: true, content: '参数错误：无有效问题' };
    }

    let fullResponse: AskUserFullResponse | undefined;

    if (_registeredCallback) {
      fullResponse = await _registeredCallback(validQuestions);
    } else {
      fullResponse = await fallbackPromptAll(validQuestions);
    }

    if (!fullResponse || Object.keys(fullResponse.answers).length === 0) {
      return {
        is_error: false,
        content: '用户未提供任何回答（全部跳过或取消）。',
        metadata: { skipped: true },
      };
    }

    const allSkipped = Object.values(fullResponse.answers).every(a => a.skipped);
    if (allSkipped) {
      return {
        is_error: false,
        content: '用户未提供任何回答（全部跳过或取消）。',
        metadata: { skipped: true },
      };
    }

    if (validQuestions.length === 1) {
      const key = Object.keys(fullResponse.answers)[0];
      const ans = fullResponse.answers[key];
      const answerText = ans.freeText || ans.selected.join(', ');
      return {
        is_error: false,
        content: answerText,
        metadata: { originalQuestion: key, wasFreeform: !!ans.freeText },
      };
    }

    return {
      is_error: false,
      content: JSON.stringify({ answers: fullResponse.answers }, null, 2),
      metadata: { questionCount: validQuestions.length },
    };
  } catch (error: any) {
    return {
      is_error: true,
      content: `向用户提问时出错: ${error.message || '未知错误'}`,
    };
  }
}

// ============================
// 降级实现（逐题 window.prompt）
// ============================

async function fallbackPromptAll(questions: AskUserQuestion[]): Promise<AskUserFullResponse | undefined> {
  if (typeof window === 'undefined') return undefined;

  const answers: Record<string, AskUserAnswer> = {};

  for (const q of questions) {
    const choiceLabels = q.options?.map(o => o.description ? `${o.label} — ${o.description}` : o.label);
    const allowFreeform = choiceLabels && choiceLabels.length > 0 ? (q.allow_freeform ?? false) : true;

    let promptText = q.question;
    if (choiceLabels && choiceLabels.length > 0) {
      const choiceText = choiceLabels.map((c, i) => `${i + 1}. ${c}`).join('\n');
      promptText = allowFreeform
        ? `${q.question}\n\n可选：\n${choiceText}\n\n也可以直接输入:`
        : `${q.question}\n\n${choiceText}\n\n请输入选项编号 (1-${choiceLabels.length}):`;
    }

    const input = window.prompt(promptText);
    if (input === null) {
      answers[q.question] = { selected: [], freeText: null, skipped: true };
      continue;
    }

    if (choiceLabels && choiceLabels.length > 0) {
      const idx = parseInt(input.trim(), 10);
      if (idx >= 1 && idx <= choiceLabels.length) {
        const label = q.options![idx - 1].label;
        answers[q.question] = { selected: [label], freeText: null, skipped: false };
        continue;
      }
    }

    answers[q.question] = { selected: [], freeText: input.trim(), skipped: !input.trim() };
  }

  return { answers };
}
