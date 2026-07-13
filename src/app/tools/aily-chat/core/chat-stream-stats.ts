export interface ChatStreamStats {
  readonly impliedWordLoadRate: number;
  readonly lastWordCount: number;
}

interface ChatStreamStatsInternal extends ChatStreamStats {
  readonly totalTime: number;
  readonly lastUpdateTime: number;
  readonly firstMarkdownTime: number | undefined;
  readonly bootstrapActive: boolean;
  readonly wordCountAtBootstrapExit: number | undefined;
  readonly updatesWithNewWords: number;
}

const MIN_BOOTSTRAP_TOTAL_TIME = 250;
const LARGE_BOOTSTRAP_MIN_TOTAL_TIME = 500;
const MAX_INTERVAL_TIME = 250;
const LARGE_UPDATE_MAX_INTERVAL_TIME = 1000;
const WORDS_FOR_LARGE_CHUNK = 10;
const MIN_UPDATES_FOR_STABLE_RATE = 2;

/**
 * Response-model-owned stream rate estimator. This is the same bootstrap and
 * pause-capping model used by VS Code's ChatStreamStatsTracker.
 */
export class ChatStreamStatsTracker {
  private state: ChatStreamStatsInternal;
  private publicState: ChatStreamStats;

  constructor(private readonly now: () => number = Date.now) {
    const start = this.now();
    this.state = {
      totalTime: 0,
      lastUpdateTime: start,
      impliedWordLoadRate: 0,
      lastWordCount: 0,
      firstMarkdownTime: undefined,
      bootstrapActive: true,
      wordCountAtBootstrapExit: undefined,
      updatesWithNewWords: 0,
    };
    this.publicState = { impliedWordLoadRate: 0, lastWordCount: 0 };
  }

  get data(): ChatStreamStats {
    return this.publicState;
  }

  update(totalWordCount: number): ChatStreamStats | undefined {
    if (totalWordCount === this.state.lastWordCount) {
      return undefined;
    }

    const now = this.now();
    const newWords = totalWordCount - this.state.lastWordCount;
    const hadNoWordsBeforeUpdate = this.state.lastWordCount === 0;
    let firstMarkdownTime = this.state.firstMarkdownTime;
    let wordCountAtBootstrapExit = this.state.wordCountAtBootstrapExit;
    if (typeof firstMarkdownTime !== 'number' && totalWordCount > 0) {
      firstMarkdownTime = now;
    }
    const updatesWithNewWords = this.state.updatesWithNewWords + 1;

    if (hadNoWordsBeforeUpdate) {
      this.state = { ...this.state, lastUpdateTime: now };
    }

    const intervalCap = newWords > WORDS_FOR_LARGE_CHUNK
      ? LARGE_UPDATE_MAX_INTERVAL_TIME
      : MAX_INTERVAL_TIME;
    const timeDiff = Math.min(now - this.state.lastUpdateTime, intervalCap);
    let totalTime = this.state.totalTime + timeDiff;
    const minBootstrapTotalTime = hadNoWordsBeforeUpdate && totalWordCount > WORDS_FOR_LARGE_CHUNK
      ? LARGE_BOOTSTRAP_MIN_TOTAL_TIME
      : MIN_BOOTSTRAP_TOTAL_TIME;

    let bootstrapActive = this.state.bootstrapActive;
    if (bootstrapActive) {
      const hasStableData = typeof firstMarkdownTime === 'number'
        && updatesWithNewWords >= MIN_UPDATES_FOR_STABLE_RATE
        && totalWordCount >= WORDS_FOR_LARGE_CHUNK;
      if (hasStableData) {
        bootstrapActive = false;
        totalTime = Math.max(now - firstMarkdownTime!, timeDiff);
        wordCountAtBootstrapExit = this.state.lastWordCount;
      } else {
        totalTime = Math.max(totalTime, minBootstrapTotalTime);
      }
    }

    const wordsSinceBootstrap = typeof wordCountAtBootstrapExit === 'number'
      ? Math.max(totalWordCount - wordCountAtBootstrapExit, 0)
      : totalWordCount;
    const effectiveWordCount = bootstrapActive ? totalWordCount : wordsSinceBootstrap;
    const impliedWordLoadRate = totalTime > 0
      ? effectiveWordCount / (totalTime / 1000)
      : 0;

    this.state = {
      totalTime,
      lastUpdateTime: now,
      impliedWordLoadRate,
      lastWordCount: totalWordCount,
      firstMarkdownTime,
      bootstrapActive,
      wordCountAtBootstrapExit,
      updatesWithNewWords,
    };
    this.publicState = { impliedWordLoadRate, lastWordCount: totalWordCount };
    return this.publicState;
  }
}

const raw = String.raw;
const linkPattern =
  raw`(?<!\\)` +
  raw`(!?\[` +
  raw`(?:` +
  raw`[^\[\]\\]|` +
  raw`\\.|` +
  raw`\[[^\[\]]*\]` +
  raw`)*` +
  raw`\])` +
  raw`(\(\s*)` +
  raw`(` +
  raw`[^\s\(\)<](?:[^\s\(\)]|\([^\s\(\)]*?\))*|` +
  raw`<(?:\\[<>]|[^<>])+>` +
  raw`)` +
  raw`\s*(?:"[^"]*"|'[^']*'|\([^\(\)]*\))?\s*` +
  raw`\)`;
const inlineMathPattern = raw`(?:\${1,2}[^$]{1,10000}?\${1,2}|\\\([\s\S]{1,10000}?\\\)|\\\[[\s\S]{1,10000}?\\\])`;
const markdownWordPattern = new RegExp(
  `(?:${linkPattern})|(?:${inlineMathPattern})|\\p{sc=Han}|=+|\\++|-+|[^\\s\\|\\p{sc=Han}|=|\\+|\\-|\`]+`,
  'gu',
);

/** Count markdown words with the same token boundaries as VS Code chat. */
export function countChatMarkdownWords(markdown: string): number {
  return Array.from(markdown.matchAll(markdownWordPattern)).length;
}
