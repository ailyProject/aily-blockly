import type { ChatPart, MarkdownPart } from './chat-parts';
import { AGENT_NAMES } from './agent-names';
import { stripHistoricalThinkingPrefix } from '../services/content-sanitizer.service';

export interface MarkdownPartPatch {
  readonly partIndex: number;
  readonly nextPart: MarkdownPart;
}

export function sanitizePartTextDelta(text: string): string {
  text = stripHistoricalThinkingPrefix(text);
  text = text
    .replace(/<final_answer[^>]*>\n?/g, '')
    .replace(/\n?<\/final_answer>/g, '');
  text = text.replace(/<toolResult>[\s\S]*?<\/toolResult>/g, '');
  text = text.replace(/<info>[\s\S]*?<\/info>/g, '');

  return text.replace(/\[to_[^\]]+\]/g, (match) => AGENT_NAMES.get(match) ?? match);
}

export function collectMarkdownPostProcessPatches(parts: readonly ChatPart[]): MarkdownPartPatch[] {
  const patches: MarkdownPartPatch[] = [];

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    if (part.type !== 'markdown') {
      continue;
    }

    const nextContent = normalizeMarkdownCompatibilityContent(part.content);
    if (nextContent === part.content) {
      continue;
    }

    patches.push({
      partIndex,
      nextPart: {
        ...part,
        content: nextContent,
      },
    });
  }

  return patches;
}

function normalizeMarkdownCompatibilityContent(content: string): string {
  let nextContent = content;

  const ctxRegex = /<(?:attachments|context)>\n?([\s\S]*?)\n?<\/(?:attachments|context)>/g;
  if (ctxRegex.test(nextContent)) {
    ctxRegex.lastIndex = 0;
    nextContent = nextContent.replace(ctxRegex, (_match, inner: string) => {
      const trimmed = inner.trim();
      if (!trimmed) {
        return '';
      }
      const label = extractContextLabel(trimmed);
      const encoded = btoa(encodeURIComponent(trimmed));
      return '\n```aily-context\n' + JSON.stringify({ label, content: encoded, encoded: true }) + '\n```\n';
    });
  }

  const mermaidRegex = /```aily-mermaid\n([\s\S]*?)```/g;
  if (mermaidRegex.test(nextContent)) {
    mermaidRegex.lastIndex = 0;
    nextContent = nextContent.replace(mermaidRegex, (match, inner) => {
      const trimmed = inner.trim();
      if (!trimmed) {
        return match;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.code) {
          return match;
        }
      } catch {
        // not JSON
      }
      return '```aily-mermaid\n' + JSON.stringify({ code: trimmed }) + '\n```';
    });
  }

  return nextContent;
}

function extractContextLabel(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() || '';
  if (firstLine.length < 60) {
    return firstLine;
  }
  return firstLine.substring(0, 57) + '...';
}