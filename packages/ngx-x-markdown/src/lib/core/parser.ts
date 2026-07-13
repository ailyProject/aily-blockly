import { Marked, Renderer, Tokens } from 'marked';
import type { Token, TokensList } from 'marked';
import type { XMarkdownConfig, ComponentMap } from '../interfaces';

type ParserOptions = {
  markedConfig?: XMarkdownConfig['config'];
  paragraphTag?: string;
  openLinksInNewTab?: boolean;
  components?: ComponentMap;
  protectCustomTagNewlines?: boolean;
  fillIncompleteTokens?: boolean;
};

type ParseOptions = {
  fillIncompleteTokens?: boolean;
};

export const other = {
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeTest: /[&<>"']/,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  escapeReplace: /[&<>"']/g,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  completeFencedCode: /^ {0,3}(`{3,}|~{3,})([\s\S]*?)\n {0,3}\1[ \n\t]*$/,
};

const escapeReplacements: { [index: string]: string } = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const getEscapeReplacement = (ch: string) => escapeReplacements[ch];

export function escapeHtml(html: string, encode?: boolean) {
  if (encode) {
    if (other.escapeTest.test(html)) {
      return html.replace(other.escapeReplace, getEscapeReplacement);
    }
  } else {
    if (other.escapeTestNoEncode.test(html)) {
      return html.replace(other.escapeReplaceNoEncode, getEscapeReplacement);
    }
  }
  return html;
}

function mergeRawTokenText(tokens: Token[]): string {
  return tokens.map((token) => token.raw).join('');
}

function completeWithString(
  markedInstance: Marked,
  tokenOrTokens: Token | Token[],
  closingString: string,
  shouldTrim = true,
): Token | undefined {
  const mergedRawText = mergeRawTokenText(Array.isArray(tokenOrTokens) ? tokenOrTokens : [tokenOrTokens]);
  const rawText = shouldTrim ? mergedRawText.trimEnd() : mergedRawText;
  return markedInstance.lexer(rawText + closingString)[0];
}

function hasLinkTextAndStartOfLinkTarget(text: string): boolean {
  return /(^|\s)\[.*\]\(\w*/.test(text);
}

function hasStartOfLinkTargetAndNoLinkText(text: string): boolean {
  return /^[^\[]*\]\([^\)]*$/.test(text);
}

function completeSingleLinePattern(
  markedInstance: Marked,
  token: Tokens.Text | Tokens.Paragraph,
): Token | undefined {
  if (!token.tokens) {
    return undefined;
  }

  for (let i = token.tokens.length - 1; i >= 0; i--) {
    const subtoken = token.tokens[i];
    if (subtoken.type !== 'text') {
      continue;
    }

    const lines = subtoken.raw.split('\n');
    const lastLine = lines[lines.length - 1];
    if (lastLine.includes('`')) {
      return completeWithString(markedInstance, token, '`');
    }
    if (lastLine.includes('**')) {
      return completeWithString(markedInstance, token, '**');
    }
    if (/\*\w/.test(lastLine)) {
      return completeWithString(markedInstance, token, '*');
    }
    if (/(^|\s)__\w/.test(lastLine)) {
      return completeWithString(markedInstance, token, '__');
    }
    if (/(^|\s)_\w/.test(lastLine)) {
      return completeWithString(markedInstance, token, '_');
    }
    if (
      hasLinkTextAndStartOfLinkTarget(lastLine) ||
      (
        hasStartOfLinkTargetAndNoLinkText(lastLine) &&
        token.tokens.slice(0, i).some((candidate) => candidate.type === 'text' && /\[[^\]]*$/.test(candidate.raw))
      )
    ) {
      const nextTwoSubTokens = token.tokens.slice(i + 1);
      if (
        (
          nextTwoSubTokens[0]?.type === 'link' &&
          nextTwoSubTokens[1]?.type === 'text' &&
          /^ *"[^"]*$/.test(nextTwoSubTokens[1].raw)
        ) ||
        /^[^"]* +"[^"]*$/.test(lastLine)
      ) {
        return completeWithString(markedInstance, token, '")', false);
      }
      return completeWithString(markedInstance, token, ')', false);
    }
    if (/(^|\s)\[\w*[^\]]*$/.test(lastLine)) {
      return completeWithString(markedInstance, token, '](https://microsoft.com)', false);
    }
  }

  return undefined;
}

function completeListItemPattern(markedInstance: Marked, list: Tokens.List): Tokens.List | undefined {
  const lastListItem = list.items[list.items.length - 1];
  const lastListSubToken = lastListItem.tokens ? lastListItem.tokens[lastListItem.tokens.length - 1] : undefined;

  const listEndsInHeading = (candidate: Tokens.List): boolean => {
    const lastItem = candidate.items.at(-1);
    const lastToken = lastItem?.tokens.at(-1);
    return lastToken?.type === 'heading' ||
      (lastToken?.type === 'list' && listEndsInHeading(lastToken as Tokens.List));
  };

  let newToken: Token | undefined;
  if (lastListSubToken?.type === 'text' && !('inRawBlock' in lastListItem)) {
    newToken = completeSingleLinePattern(markedInstance, lastListSubToken as Tokens.Text);
  } else if (listEndsInHeading(list)) {
    const newList = markedInstance.lexer(list.raw.trim() + ' &nbsp;')[0] as Tokens.List;
    return newList.type === 'list' ? newList : undefined;
  }

  if (!newToken || newToken.type !== 'paragraph') {
    return undefined;
  }

  const previousListItemsText = mergeRawTokenText(list.items.slice(0, -1));
  const lastListItemLead = lastListItem.raw.match(/^(\s*(-|\d+\.|\*) +)/)?.[0];
  if (!lastListItemLead) {
    return undefined;
  }

  const newListItemText =
    lastListItemLead +
    mergeRawTokenText(lastListItem.tokens.slice(0, -1)) +
    newToken.raw;

  const newList = markedInstance.lexer(previousListItemsText + newListItemText)[0] as Tokens.List;
  return newList.type === 'list' ? newList : undefined;
}

function completeTable(markedInstance: Marked, tokens: Token[]): Token[] | undefined {
  const mergedRawText = mergeRawTokenText(tokens);
  const lines = mergedRawText.split('\n');

  let numCols: number | undefined;
  let hasSeparatorRow = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (typeof numCols === 'undefined' && /^\s*\|/.test(line)) {
      const line1Matches = line.match(/(\|[^\|]+)(?=\||$)/g);
      if (line1Matches) {
        numCols = line1Matches.length;
      }
    } else if (typeof numCols === 'number') {
      if (!/^\s*\|/.test(line)) {
        return undefined;
      }
      if (i !== lines.length - 1) {
        return undefined;
      }
      hasSeparatorRow = true;
    }
  }

  if (typeof numCols === 'number' && numCols > 0) {
    const prefixText = hasSeparatorRow ? lines.slice(0, -1).join('\n') : mergedRawText;
    const line1EndsInPipe = /\|\s*$/.test(prefixText);
    const newRawText = prefixText + (line1EndsInPipe ? '' : '|') + `\n|${' --- |'.repeat(numCols)}`;
    return markedInstance.lexer(newRawText);
  }

  return undefined;
}

function completeHeading(markedInstance: Marked, token: Tokens.Heading, fullRawText: string): TokensList | undefined {
  if (/-\s*$/.test(token.raw)) {
    return markedInstance.lexer(fullRawText + ' &nbsp;');
  }
  return undefined;
}

const maxIncompleteTokensFixRounds = 3;

function fillInIncompleteTokens(markedInstance: Marked, inputTokens: TokensList): TokensList {
  let tokens = inputTokens;
  for (let i = 0; i < maxIncompleteTokensFixRounds; i++) {
    const nextTokens = fillInIncompleteTokensOnce(markedInstance, tokens);
    if (!nextTokens) {
      break;
    }
    tokens = nextTokens;
  }
  return tokens;
}

function fillInIncompleteTokensOnce(markedInstance: Marked, tokens: TokensList): TokensList | null {
  let replaceAt = 0;
  let newTokens: Token[] | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'paragraph' && /(\n|^)\|/.test(token.raw)) {
      newTokens = completeTable(markedInstance, tokens.slice(i));
      replaceAt = i;
      break;
    }
  }

  let lastInterestingIdx = tokens.length - 1;
  while (
    lastInterestingIdx >= 0 &&
    (tokens[lastInterestingIdx].type === 'space' || tokens[lastInterestingIdx].type === 'html')
  ) {
    lastInterestingIdx--;
  }
  const lastInterestingToken = lastInterestingIdx >= 0 ? tokens[lastInterestingIdx] : undefined;
  const trailingTokens = tokens.slice(lastInterestingIdx + 1);

  if (!newTokens && lastInterestingToken?.type === 'list') {
    const newListToken = completeListItemPattern(markedInstance, lastInterestingToken as Tokens.List);
    if (newListToken) {
      newTokens = [newListToken, ...trailingTokens];
      replaceAt = lastInterestingIdx;
    }
  }

  if (!newTokens && lastInterestingToken?.type === 'paragraph') {
    const newToken = completeSingleLinePattern(markedInstance, lastInterestingToken as Tokens.Paragraph);
    if (newToken) {
      newTokens = [newToken, ...trailingTokens];
      replaceAt = lastInterestingIdx;
    }
  }

  if (newTokens) {
    const newTokensList = [...tokens.slice(0, replaceAt), ...newTokens] as TokensList;
    newTokensList.links = tokens.links;
    return newTokensList;
  }

  const lastToken = tokens.at(-1);
  if (lastToken?.type === 'heading') {
    return completeHeading(markedInstance, lastToken as Tokens.Heading, mergeRawTokenText(tokens));
  }

  return null;
}

export class MarkdownParser {
  options: ParserOptions;
  markdownInstance: Marked;

  constructor(options: ParserOptions = {}) {
    const { markedConfig = {} } = options;
    this.options = options;
    this.markdownInstance = new Marked();

    this.configureLinkRenderer();
    this.configureParagraphRenderer();
    this.configureCodeRenderer();
    // user config at last
    this.markdownInstance.use(markedConfig);
  }

  private configureLinkRenderer() {
    if (!this.options.openLinksInNewTab) return;

    const renderer = {
      link(this: Renderer, { href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    };
    this.markdownInstance.use({ renderer });
  }

  public configureParagraphRenderer() {
    const { paragraphTag } = this.options;
    if (!paragraphTag) return;

    const renderer = {
      paragraph(this: Renderer, { tokens }: Tokens.Paragraph) {
        return `<${paragraphTag}>${this.parser.parseInline(tokens)}</${paragraphTag}>\n`;
      },
    };
    this.markdownInstance.use({ renderer });
  }

  public configureCodeRenderer() {
    const renderer = {
      code({ text, raw, lang, escaped, codeBlockStyle }: Tokens.Code): string {
        const infoString = (lang || '').trim();
        const langString = infoString.match(other.notSpaceStart)?.[0];
        const code = `${text.replace(other.endingNewline, '')}\n`;
        const isIndentedCode = codeBlockStyle === 'indented';
        const streamStatus =
          isIndentedCode || other.completeFencedCode.test(raw) ? 'done' : 'loading';
        const escapedCode = escaped ? code : escapeHtml(code, true);

        const classAttr = langString ? ` class="language-${escapeHtml(langString)}"` : '';
        const dataAttrs =
          ` data-block="true" data-state="${streamStatus}"` +
          (infoString ? ` data-lang="${escapeHtml(infoString)}"` : '');

        return `<pre><code${dataAttrs}${classAttr}>${escapedCode}</code></pre>\n`;
      },
    };
    this.markdownInstance.use({ renderer });
  }

  private protectCustomTags(content: string): {
    protected: string;
    placeholders: Map<string, string>;
  } {
    const placeholders = new Map<string, string>();
    const customTagNames = Object.keys(this.options.components || {});

    if (customTagNames.length === 0) {
      return { protected: content, placeholders };
    }

    let placeholderIndex = 0;

    const tagNamePattern = customTagNames
      .map((name) => name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');

    const openTagRegex = new RegExp(`<(${tagNamePattern})(?:\\s[^>]*)?>`, 'gi');
    const closeTagRegex = new RegExp(`</(${tagNamePattern})>`, 'gi');

    const positions: Array<{
      index: number;
      type: 'open' | 'close';
      tagName: string;
      match: string;
    }> = [];

    let match;
    openTagRegex.lastIndex = 0;
    match = openTagRegex.exec(content);
    while (match !== null) {
      positions.push({
        index: match.index,
        type: 'open',
        tagName: match[1].toLowerCase(),
        match: match[0],
      });
      match = openTagRegex.exec(content);
    }

    closeTagRegex.lastIndex = 0;
    match = closeTagRegex.exec(content);
    while (match !== null) {
      positions.push({
        index: match.index,
        type: 'close',
        tagName: match[1].toLowerCase(),
        match: match[0],
      });
      match = closeTagRegex.exec(content);
    }

    positions.sort((a, b) => a.index - b.index);

    const stack: Array<{ tagName: string; start: number; openTag: string }> = [];
    const result: string[] = [];
    let lastIndex = 0;

    positions.forEach((pos) => {
      if (pos.type === 'open') {
        if (!pos.match.endsWith('/>')) {
          stack.push({ tagName: pos.tagName, start: pos.index, openTag: pos.match });
        }
      } else if (
        pos.type === 'close' &&
        stack.length > 0 &&
        stack[stack.length - 1].tagName === pos.tagName
      ) {
        const open = stack.pop()!;
        if (stack.length === 0) {
          const startPos = open.start;
          const endPos = pos.index + pos.match.length;
          const openTag = open.openTag;
          const closeTag = pos.match;
          const innerContent = content.slice(startPos + openTag.length, pos.index);

          if (lastIndex < startPos) {
            result.push(content.slice(lastIndex, startPos));
          }

          if (innerContent.includes('\n\n')) {
            const protectedInner = innerContent.replace(/\n\n/g, () => {
              const ph = `__X_MD_PLACEHOLDER_${placeholderIndex++}__`;
              placeholders.set(ph, '\n\n');
              return ph;
            });
            result.push(openTag + protectedInner + closeTag);
          } else {
            result.push(openTag + innerContent + closeTag);
          }

          lastIndex = endPos;
        }
      }
    });

    if (lastIndex < content.length) {
      result.push(content.slice(lastIndex));
    }

    return { protected: result.join(''), placeholders };
  }

  private restorePlaceholders(content: string, placeholders: Map<string, string>): string {
    if (placeholders.size === 0) {
      return content;
    }
    return content.replace(
      /__X_MD_PLACEHOLDER_\d+__/g,
      (match) => placeholders.get(match) ?? match,
    );
  }

  public parse(content: string, options: ParseOptions = {}): string {
    if (this.options.protectCustomTagNewlines) {
      const { protected: protectedContent, placeholders } = this.protectCustomTags(content);
      const parsed = this.parseMarkdown(protectedContent, options);
      return this.restorePlaceholders(parsed, placeholders);
    }
    return this.parseMarkdown(content, options);
  }

  private parseMarkdown(content: string, options: ParseOptions): string {
    if (!(options.fillIncompleteTokens ?? this.options.fillIncompleteTokens)) {
      return this.markdownInstance.parse(content) as string;
    }

    const tokens = this.markdownInstance.lexer(content);
    const completedTokens = fillInIncompleteTokens(this.markdownInstance, tokens);
    return this.markdownInstance.parser(completedTokens);
  }
}
