import type { ResourceItem } from '../core/chat-types';

export function parseUserTurnTextAndResources(content: string | undefined | null): { text: string; resources: ResourceItem[] } {
  const source = content ?? '';
  const resources = extractUserTurnResources(source);
  let text = source;

  const attachMatch = source.match(/<(?:attachments|context)>\n?([\s\S]*?)\n?<\/(?:attachments|context)>/);
  if (attachMatch) {
    text = source.replace(attachMatch[0], '').trim();
  } else if (resources.length > 0) {
    text = stripUserTurnResourceContext(source);
  }

  return { text, resources };
}

export function extractUserTurnResources(content: string | undefined | null): ResourceItem[] {
  const source = content ?? '';
  const attachMatch = source.match(/<(?:attachments|context)>\n?([\s\S]*?)\n?<\/(?:attachments|context)>/);
  const contextText = (attachMatch ? attachMatch[1] : source).trim();
  const resources: ResourceItem[] = [];

  pushSectionResources(contextText, '参考文件', 'file', resources);
  pushSectionResources(contextText, '参考文件夹', 'folder', resources);
  pushUrlResources(contextText, resources);

  return dedupeResources(resources);
}

export function mergeUserTurnResources(
  primary: readonly ResourceItem[],
  secondary: readonly ResourceItem[],
): ResourceItem[] {
  return dedupeResources([...primary, ...secondary]);
}

function stripUserTurnResourceContext(content: string): string {
  return content
    .replace(/参考文件:\n(?:- .+\n?)+(?:\n)?/g, '')
    .replace(/参考文件夹:\n(?:- .+\n?)+(?:\n)?/g, '')
    .replace(/参考URL:\n(?:- .+\n?)+(?:\n)?/g, '')
    .trim();
}

function pushSectionResources(
  content: string,
  heading: '参考文件' | '参考文件夹',
  type: 'file' | 'folder',
  resources: ResourceItem[],
): void {
  const section = content.match(new RegExp(`${heading}:\\n((?:- .+\\n?)+)`));
  if (!section) {
    return;
  }

  const lines = section[1].trim().split('\n');
  for (const line of lines) {
    const path = line.replace(/^- /, '').trim();
    if (!path) {
      continue;
    }

    const name = path.split(/[/\\]/).pop() || path;
    resources.push({ type, path, name });
  }
}

function pushUrlResources(content: string, resources: ResourceItem[]): void {
  const section = content.match(/参考URL:\n((?:- .+\n?)+)/);
  if (!section) {
    return;
  }

  const lines = section[1].trim().split('\n');
  for (const line of lines) {
    const url = line.replace(/^- /, '').trim();
    if (!url) {
      continue;
    }

    try {
      const urlObj = new URL(url);
      resources.push({ type: 'url', url, name: urlObj.hostname + urlObj.pathname });
    } catch {
      // ignore invalid urls
    }
  }
}

function dedupeResources(resources: readonly ResourceItem[]): ResourceItem[] {
  const merged: ResourceItem[] = [];

  for (const item of resources) {
    const exists = merged.some(resource =>
      resource.type === item.type && (resource.path === item.path || resource.url === item.url)
    );
    if (!exists) {
      merged.push(item);
    }
  }

  return merged;
}