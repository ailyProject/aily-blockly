import type { QuestionItem, QuestionPart, ToolCallPart } from './chat-parts';
import { normalizeReadSideToolName } from './tool-name-normalizer';

export interface AskUserToolDecisionData {
  readonly questions: readonly QuestionItem[];
  readonly answers: NonNullable<QuestionPart['answers']>;
}

/**
 * Projects the durable result of the built-in Ask Questions invocation.
 * The tool call remains the canonical owner; this data is renderer-only.
 */
export function projectAskUserToolDecisionData(
  part: ToolCallPart,
): AskUserToolDecisionData | null {
  if (!isAskUserToolCall(part)) {
    return null;
  }

  const questions = readQuestions(part.args);
  const answers = readAnswers(part.metadata);
  if (questions.length === 0 || !answers) {
    return null;
  }

  return { questions, answers };
}

export function isAskUserToolCall(part: Pick<ToolCallPart, 'toolName'>): boolean {
  const toolName = normalizeReadSideToolName(part.toolName);
  return toolName === 'ask_questions' || toolName === 'ask_user';
}

function readQuestions(value: unknown): QuestionItem[] {
  const args = asRecord(value);
  if (!args) {
    return [];
  }

  const rawQuestions = Array.isArray(args['questions'])
    ? args['questions']
    : typeof args['question'] === 'string'
      ? [args]
      : [];
  return rawQuestions
    .map(readQuestion)
    .filter((question): question is QuestionItem => !!question);
}

function readQuestion(value: unknown): QuestionItem | null {
  const record = asRecord(value);
  const question = asNonEmptyString(record?.['question']);
  if (!record || !question) {
    return null;
  }

  const options = Array.isArray(record['options'])
    ? record['options']
      .map(readOption)
      .filter((option): option is NonNullable<QuestionItem['options']>[number] => !!option)
    : undefined;
  return {
    ...(asNonEmptyString(record['id']) ? { id: asNonEmptyString(record['id']) } : {}),
    ...(asNonEmptyString(record['header']) ? { header: asNonEmptyString(record['header']) } : {}),
    question,
    ...(options?.length ? { options } : {}),
    allow_freeform: readBoolean(record, 'allow_freeform', 'allowFreeformInput', 'allowFreeform'),
    multi_select: readBoolean(record, 'multi_select', 'multiSelect'),
  };
}

function readOption(value: unknown): NonNullable<QuestionItem['options']>[number] | null {
  if (typeof value === 'string') {
    const label = value.trim();
    return label ? { label } : null;
  }
  const record = asRecord(value);
  const label = asNonEmptyString(record?.['label']);
  if (!record || !label) {
    return null;
  }
  return {
    label,
    ...(asNonEmptyString(record['description']) ? { description: asNonEmptyString(record['description']) } : {}),
    ...(record['recommended'] === true ? { recommended: true } : {}),
  };
}

function readAnswers(metadata: ToolCallPart['metadata']): NonNullable<QuestionPart['answers']> | null {
  const result = asRecord(metadata?.['result']);
  const resultMetadata = asRecord(result?.['metadata']);
  const answerEnvelope = asRecord(resultMetadata?.['askUserQuestionAnswer']);
  const rawAnswers = asRecord(answerEnvelope?.['answers']);
  if (!rawAnswers) {
    return null;
  }

  const answers: NonNullable<QuestionPart['answers']> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    const answer = asRecord(value);
    const normalizedKey = key.trim();
    if (!normalizedKey || !answer) {
      continue;
    }
    const selected = Array.isArray(answer['selected'])
      ? answer['selected'].filter((item): item is string => typeof item === 'string')
      : [];
    const freeText = typeof answer['freeText'] === 'string' ? answer['freeText'] : null;
    answers[normalizedKey] = {
      selected,
      freeText,
      skipped: answer['skipped'] === true,
    };
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function readBoolean(record: Record<string, unknown>, ...keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') {
      return record[key] as boolean;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}
