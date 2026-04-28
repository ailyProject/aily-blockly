/**
 * UI 辅助纯函数：从 AilyChatComponent 提取的无状态工具函数
 */

import { ResourceItem } from '../core/chat-types';

/**
 * 生成一个随机字符串（用于 ID 生成）
 */
export function getRandomString(): string {
  return (
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

/**
 * 将含 ```blockly 代码块的内容分割为交替的文本段和代码段
 */
export function splitContent(content: any): any[] {
  const regex = /```blockly([\s\S]*?)```/g;
  const matches = content.match(regex);

  let segments: any = [];
  let lastIndex = 0;

  if (matches) {
    matches.forEach((match) => {
      const startIndex = content.indexOf(match, lastIndex);

      if (startIndex > 0) {
        segments.push(content.slice(lastIndex, startIndex));
      }

      segments.push(match);
      lastIndex = startIndex + match.length;
    });

    if (lastIndex < content.length) {
      segments.push(content.slice(lastIndex));
    }
  } else {
    segments.push(content);
  }

  return segments;
}

/**
 * 将 ResourceItem[] 转换为 LLM 友好的上下文文本
 */
export function getResourcesText(selectContent: ResourceItem[]): string {
  if (selectContent.length === 0) {
    return '';
  }

  const fileItems = selectContent.filter(item => item.type === 'file');
  const folderItems = selectContent.filter(item => item.type === 'folder');
  const urlItems = selectContent.filter(item => item.type === 'url');
  const blockItems = selectContent.filter(item => item.type === 'block');

  let text = '';

  if (fileItems.length > 0) {
    text += '参考文件:\n';
    text += fileItems.map(item => `- ${item.path}`).join('\n');
    text += '\n\n';
  }

  if (folderItems.length > 0) {
    text += '参考文件夹:\n';
    text += folderItems.map(item => `- ${item.path}`).join('\n');
    text += '\n\n';
  }

  if (urlItems.length > 0) {
    text += '参考URL:\n';
    text += urlItems.map(item => `- ${item.url}`).join('\n');
    text += '\n\n';
  }

  if (blockItems.length > 0) {
    text += blockItems.map(item => item.blockContext || item.name).join('\n');
    text += '\n\n';
  }

  if (text) {
    text = `<attachments>\n${text}</attachments>`;
  }

  return text.trim();
}
