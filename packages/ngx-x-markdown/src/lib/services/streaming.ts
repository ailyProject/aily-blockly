import { StreamCacheTokenType, ComponentMap, StreamingOption } from '../interfaces';

// ===================== Types =====================

export interface StreamCache {
  pending: string;
  token: StreamCacheTokenType;
  processedLength: number;
  completeMarkdown: string;
}

interface Recognizer {
  tokenType: StreamCacheTokenType;
  isStartOfToken: (markdown: string) => boolean;
  isStreamingValid: (markdown: string) => boolean;
  getCommitPrefix?: (pending: string) => string | null;
}

// ===================== Constants =====================

const STREAM_INCOMPLETE_REGEX = {
  image: [/^!\[[^\]\r\n]{0,1000}$/, /^!\[[^\r\n]{0,1000}\]\(*[^)\r\n]{0,1000}$/],
  link: [/^\[[^\]\r\n]{0,1000}$/, /^\[[^\r\n]{0,1000}\]\(*[^)\r\n]{0,1000}$/],
  html: [/^<\/$/, /^<\/?[a-zA-Z][a-zA-Z0-9-]{0,100}[^>\r\n]{0,1000}$/],
  commonEmphasis: [/^(\*{1,3}|_{1,3})(?!\s)(?!.*\1$)[^\r\n]{0,1000}$/],
  list: [/^[-+*]\s{0,3}$/, /^[-+*]\s{1,3}(\*{1,3}|_{1,3})(?!\s)(?!.*\1$)[^\r\n]{0,1000}$/],
  'inline-code': [/^`[^`\r\n]{0,300}$/],
} as const;

const isTableInComplete = (markdown: string) => {
  if (markdown.includes('\n\n')) return false;
  const lines = markdown.split('\n');
  if (lines.length <= 1) return true;
  const [header, separator] = lines;
  const trimmedHeader = header.trim();
  if (!/^\|.*\|$/.test(trimmedHeader)) return false;
  const trimmedSeparator = separator.trim();
  const columns = trimmedSeparator
    .split('|')
    .map((col) => col.trim())
    .filter(Boolean);
  const separatorRegex = /^:?-+:?$/;
  return columns.every((col, index) =>
    index === columns.length - 1
      ? col === ':' || separatorRegex.test(col)
      : separatorRegex.test(col),
  );
};

const tokenRecognizerMap: Partial<Record<StreamCacheTokenType, Recognizer>> = {
  [StreamCacheTokenType.Link]: {
    tokenType: StreamCacheTokenType.Link,
    isStartOfToken: (markdown: string) => markdown.startsWith('['),
    isStreamingValid: (markdown: string) =>
      STREAM_INCOMPLETE_REGEX.link.some((re) => re.test(markdown)),
  },
  [StreamCacheTokenType.Image]: {
    tokenType: StreamCacheTokenType.Image,
    isStartOfToken: (markdown: string) => markdown.startsWith('!'),
    isStreamingValid: (markdown: string) =>
      STREAM_INCOMPLETE_REGEX.image.some((re) => re.test(markdown)),
  },
  [StreamCacheTokenType.Html]: {
    tokenType: StreamCacheTokenType.Html,
    isStartOfToken: (markdown: string) => markdown.startsWith('<'),
    isStreamingValid: (markdown: string) =>
      STREAM_INCOMPLETE_REGEX.html.some((re) => re.test(markdown)),
  },
  [StreamCacheTokenType.Emphasis]: {
    tokenType: StreamCacheTokenType.Emphasis,
    isStartOfToken: (markdown: string) => markdown.startsWith('*') || markdown.startsWith('_'),
    isStreamingValid: (markdown: string) =>
      STREAM_INCOMPLETE_REGEX.commonEmphasis.some((re) => re.test(markdown)),
  },
  [StreamCacheTokenType.List]: {
    tokenType: StreamCacheTokenType.List,
    isStartOfToken: (markdown: string) => /^[-+*]/.test(markdown),
    isStreamingValid: (markdown: string) =>
      STREAM_INCOMPLETE_REGEX.list.some((re) => re.test(markdown)),
    getCommitPrefix: (pending: string) => {
      const listPrefix = pending.match(/^([-+*]\s{0,3})/)?.[1];
      const rest = listPrefix ? pending.slice(listPrefix.length) : '';
      return listPrefix && rest.startsWith('`') ? listPrefix : null;
    },
  },
  [StreamCacheTokenType.Table]: {
    tokenType: StreamCacheTokenType.Table,
    isStartOfToken: (markdown: string) => markdown.startsWith('|'),
    isStreamingValid: isTableInComplete,
  },
  [StreamCacheTokenType.InlineCode]: {
    tokenType: StreamCacheTokenType.InlineCode,
    isStartOfToken: (markdown: string) => markdown.startsWith('`'),
    isStreamingValid: (markdown: string) =>
      STREAM_INCOMPLETE_REGEX['inline-code'].some((re) => re.test(markdown)),
  },
};

// ===================== Utils =====================

const recognize = (cache: StreamCache, tokenType: StreamCacheTokenType): void => {
  const recognizer = tokenRecognizerMap[tokenType];
  if (!recognizer) return;

  const { token, pending } = cache;
  if (token === StreamCacheTokenType.Text && recognizer.isStartOfToken(pending)) {
    cache.token = tokenType;
    return;
  }

  if (token === tokenType && !recognizer.isStreamingValid(pending)) {
    const prefix = recognizer.getCommitPrefix?.(pending);
    if (prefix) {
      cache.completeMarkdown += prefix;
      cache.pending = pending.slice(prefix.length);
      cache.token = StreamCacheTokenType.Text;
      return;
    }
    commitCache(cache);
  }
};

const recognizeHandlers = Object.values(tokenRecognizerMap).map((rec) => ({
  tokenType: rec!.tokenType,
  recognize: (cache: StreamCache) => recognize(cache, rec!.tokenType),
}));

export const getInitialCache = (): StreamCache => ({
  pending: '',
  token: StreamCacheTokenType.Text,
  processedLength: 0,
  completeMarkdown: '',
});

export const commitCache = (cache: StreamCache): void => {
  if (cache.pending) {
    cache.completeMarkdown += cache.pending;
    cache.pending = '';
  }
  cache.token = StreamCacheTokenType.Text;
};

export const isInCodeBlock = (text: string, isFinalChunk = false): boolean => {
  const lines = text.split('\n');
  let inFenced = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (match) {
      const fence = match[1];
      const after = match[2];
      const char = fence[0];
      const len = fence.length;
      if (!inFenced) {
        inFenced = true;
        fenceChar = char;
        fenceLen = len;
      } else {
        const isValidEnd = char === fenceChar && len >= fenceLen && /^\s*$/.test(after);
        if (isValidEnd) {
          if (isFinalChunk || i < lines.length - 1) {
            inFenced = false;
            fenceChar = '';
            fenceLen = 0;
          }
        }
      }
    }
  }
  return inFenced;
};

const sanitizeForURIComponent = (input: string): string => {
  let result = '';
  for (let i = 0; i < input.length; i++) {
    const charCode = input.charCodeAt(i);
    if (charCode >= 0xd800 && charCode <= 0xdbff) {
      if (
        i + 1 < input.length &&
        input.charCodeAt(i + 1) >= 0xdc00 &&
        input.charCodeAt(i + 1) <= 0xdfff
      ) {
        result += input[i] + input[i + 1];
        i++;
      }
    } else if (charCode < 0xdc00 || charCode > 0xdfff) {
      result += input[i];
    }
  }
  return result;
};

const safeEncodeURIComponent = (str: string): string => {
  try {
    return encodeURIComponent(str);
  } catch (e) {
    if (e instanceof URIError) {
      return encodeURIComponent(sanitizeForURIComponent(str));
    }
    return '';
  }
};

const MAX_PARAGRAPH_BUFFERED_CHARS = 4000;

export function lastBlockBoundary(text: string): number {
  let lastValid = -1;
  let inFence = false;

  for (let i = 0; i < text.length; i++) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    const isFence = atLineStart
      && ((text[i] === '`' && text[i + 1] === '`' && text[i + 2] === '`')
        || (text[i] === '~' && text[i + 1] === '~' && text[i + 2] === '~'));
    if (isFence) {
      inFence = !inFence;
      i += 2;
      continue;
    }

    if (!inFence && text[i] === '\n' && text[i + 1] === '\n') {
      lastValid = i;
    }
  }

  return lastValid;
}

export function getParagraphBufferedMarkdown(fullMarkdown: string, isFinalChunk: boolean): string {
  if (isFinalChunk || !fullMarkdown) {
    return fullMarkdown;
  }

  const lastBlock = lastBlockBoundary(fullMarkdown);
  let renderable = lastBlock === -1
    ? fullMarkdown
    : fullMarkdown.slice(0, lastBlock + 2);

  if (fullMarkdown.length - renderable.length > MAX_PARAGRAPH_BUFFERED_CHARS) {
    renderable = fullMarkdown;
  }

  return renderable;
}

export interface WordCountResult {
  value: string;
  returnedWordCount: number;
  totalWordCount: number;
  isFullString: boolean;
}

const r = String.raw;
const linkPattern =
  r`(?<!\\)` +
  r`(!?\[` +
  r`(?:` +
  r`[^\[\]\\]|` +
  r`\\.|` +
  r`\[[^\[\]]*\]` +
  r`)*` +
  r`\])` +
  r`(\(\s*)` +
  r`(` +
  r`[^\s\(\)<](?:[^\s\(\)]|\([^\s\(\)]*?\))*|` +
  r`<(?:\\[<>]|[^<>])+>` +
  r`)` +
  r`\s*(?:"[^"]*"|'[^']*'|\([^\(\)]*\))?\s*` +
  r`\)`;
const inlineMathPattern = r`(?:\${1,2}[^$]{1,10000}?\${1,2}|\\\([\s\S]{1,10000}?\\\)|\\\[[\s\S]{1,10000}?\\\])`;

export function getNWords(str: string, numWordsToCount: number): WordCountResult {
  const backtick = '`';
  const wordRegExp = new RegExp(
    `(?:${linkPattern})|(?:${inlineMathPattern})|\\p{sc=Han}|=+|\\++|-+|[^\\s\\|\\p{sc=Han}|=|\\+|\\-|${backtick}]+`,
    'gu',
  );
  const allWordMatches = Array.from(str.matchAll(wordRegExp));
  const targetWords = allWordMatches.slice(0, numWordsToCount);
  const lastTarget = targetWords.at(-1);
  const endIndex = numWordsToCount >= allWordMatches.length
    ? str.length
    : lastTarget
      ? lastTarget.index + lastTarget[0].length
      : 0;
  const value = str.substring(0, endIndex);

  return {
    value,
    returnedWordCount: targetWords.length === 0 ? (value.length ? 1 : 0) : targetWords.length,
    totalWordCount: allWordMatches.length,
    isFullString: endIndex >= str.length,
  };
}

const WORD_BUFFER_MIN_RATE = 40;
const WORD_BUFFER_MAX_RATE = 2000;
const WORD_BUFFER_MIN_RATE_AFTER_COMPLETE = 80;
const WORD_BUFFER_DEFAULT_RATE = 8;

export class WordBuffer {
  private fullMarkdown = '';
  private revealedWordCount = 0;
  private lastCommittedMarkdown = '';
  private needsFrame = false;
  private lastCommitTime = 0;
  private rate = WORD_BUFFER_DEFAULT_RATE;

  get needsNextFrame(): boolean {
    return this.needsFrame;
  }

  setRate(rate: number | undefined, isComplete: boolean): void {
    if (isComplete) {
      this.rate = typeof rate === 'number'
        ? Math.min(Math.max(rate, WORD_BUFFER_MIN_RATE_AFTER_COMPLETE), WORD_BUFFER_MAX_RATE)
        : WORD_BUFFER_MIN_RATE_AFTER_COMPLETE;
      return;
    }

    this.rate = typeof rate === 'number'
      ? Math.min(Math.max(rate, WORD_BUFFER_MIN_RATE), WORD_BUFFER_MAX_RATE)
      : WORD_BUFFER_DEFAULT_RATE;
  }

  reset(): void {
    this.fullMarkdown = '';
    this.revealedWordCount = 0;
    this.lastCommittedMarkdown = '';
    this.needsFrame = false;
    this.lastCommitTime = 0;
    this.rate = WORD_BUFFER_DEFAULT_RATE;
  }

  filterFlush(markdown: string): string | undefined {
    this.fullMarkdown = markdown;

    const now = Date.now();
    if (this.lastCommitTime === 0) {
      this.lastCommitTime = now;
      this.revealedWordCount = 1;
    } else {
      const elapsed = now - this.lastCommitTime;
      const newWords = Math.floor(elapsed / 1000 * this.rate);
      if (newWords > 0) {
        this.revealedWordCount += newWords;
        this.lastCommitTime = now;
      }
    }

    const result = getNWords(this.fullMarkdown, this.revealedWordCount);
    if (result.isFullString) {
      this.needsFrame = false;
      this.revealedWordCount = result.returnedWordCount;
      this.lastCommittedMarkdown = this.fullMarkdown;
      return this.fullMarkdown;
    }

    this.needsFrame = true;
    if (result.value.length <= this.lastCommittedMarkdown.length) {
      return undefined;
    }

    this.lastCommittedMarkdown = result.value;
    return result.value;
  }
}

// ===================== Main Streaming Processor =====================

/**
 * 纯函数版本的流式处理器，不依赖 React/Angular 框架
 * Angular 组件/服务通过调用此函数来处理流式内容
 */
export function processStreamingContent(
  text: string,
  cache: StreamCache,
  config?: {
    streaming?: StreamingOption;
    components?: ComponentMap;
  },
): { output: string; cache: StreamCache } {
  const { streaming, components = {} } = config || {};
  const { hasNextChunk: enableCache = false, incompleteMarkdownComponentMap } = streaming || {};

  if (!enableCache) {
    return { output: text, cache: getInitialCache() };
  }

  if (!text) {
    return { output: '', cache: getInitialCache() };
  }

  const expectedPrefix = cache.completeMarkdown + cache.pending;
  if (!text.startsWith(expectedPrefix)) {
    cache = getInitialCache();
  }

  const chunk = text.slice(cache.processedLength);
  if (!chunk) {
    // Generate output from current cache state
    const incompletePlaceholder = handleIncompleteMarkdown(cache, incompleteMarkdownComponentMap, components);
    return { output: cache.completeMarkdown + (incompletePlaceholder || ''), cache };
  }

  cache.processedLength += chunk.length;

  for (const char of chunk) {
    cache.pending += char;
    const isContentInCodeBlock = isInCodeBlock(cache.completeMarkdown + cache.pending);
    if (isContentInCodeBlock) {
      commitCache(cache);
      continue;
    }
    if (cache.token === StreamCacheTokenType.Text) {
      for (const handler of recognizeHandlers) handler.recognize(cache);
    } else {
      const handler = recognizeHandlers.find((h) => h.tokenType === cache.token);
      handler?.recognize(cache);
      const tokenAfterRecognize = cache.token as StreamCacheTokenType;
      if (tokenAfterRecognize === StreamCacheTokenType.Text) {
        for (const h of recognizeHandlers) h.recognize(cache);
      }
    }
    if (cache.token === StreamCacheTokenType.Text) {
      commitCache(cache);
    }
  }

  const incompletePlaceholder = handleIncompleteMarkdown(cache, incompleteMarkdownComponentMap, components);
  return { output: cache.completeMarkdown + (incompletePlaceholder || ''), cache };
}

function handleIncompleteMarkdown(
  cache: StreamCache,
  incompleteMarkdownComponentMap?: StreamingOption['incompleteMarkdownComponentMap'],
  components?: ComponentMap,
): string | undefined {
  const { token, pending } = cache;
  if (token === StreamCacheTokenType.Text) return;

  const componentMap = incompleteMarkdownComponentMap || {};
  const componentName = componentMap[token as keyof typeof componentMap] || `incomplete-${token}`;
  const encodedPending = safeEncodeURIComponent(pending);

  return components?.[componentName]
    ? `<${componentName} data-raw="${encodedPending}" />`
    : pending;
}
