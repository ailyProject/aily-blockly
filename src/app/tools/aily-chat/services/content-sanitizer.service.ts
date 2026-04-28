/**
 * 内容清洗与截断服务
 *
 * 从 AilyChatComponent 提取的纯函数/静态方法集合，用于：
 * - 清理 assistant 文本中的 UI-only 标记
 * - 清理工具结果中的临时元素
 * - 截断过长工具结果
 * - 解析 TERMINATE 前缀
 * - JSON 安全化
 * - 历史标记
 */

/** 单条工具结果的默认最大字符数（约 2000 tokens） */
const TOOL_RESULT_MAX_CHARS = 8000;

/** 已内置截断的工具名称（跳过二次截断） */
const SELF_TRUNCATING_TOOLS = new Set(['fetch', 'web_search', 'read_file', 'grep']);

/**
 * 确保字符串在 JSON 中安全（转义特殊字符）
 */
export function makeJsonSafe(str: string): string {
  if (!str) return str;
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * 清理 assistant 内容，移除仅供 UI 渲染的元素（think/aily-state/aily-button/aily-mermaid）
 */
export function sanitizeAssistantContent(content: string): string {
  if (!content) return '';

  let cleaned = content;
  cleaned = cleaned.replace(/\[thinking\.\.\.?\]/g, '');
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '');

  const openThinkIdx = cleaned.lastIndexOf('<think>');
  if (openThinkIdx >= 0 && !cleaned.substring(openThinkIdx).includes('</think>')) {
    cleaned = cleaned.substring(0, openThinkIdx);
  }

  cleaned = cleaned.replace(/```aily-state[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/```aily-mermaid[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * 清理工具结果，移除 rules/info/reminder 标签和 toolResult 包装
 */
export function sanitizeToolContent(content: string): string {
  if (!content) return '';

  let cleaned = content;
  cleaned = cleaned.replace(/<rules>[\s\S]*?<\/rules>/g, '');
  cleaned = cleaned.replace(/<info>[\s\S]*?<\/info>/g, '');
  cleaned = cleaned.replace(/<reminder>[\s\S]*?<\/reminder>/g, '');
  cleaned = cleaned.replace(/<toolResult>([\s\S]*?)<\/toolResult>/g, '$1');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim();
}

/**
 * 截断过长工具结果（Copilot 风格 40/60 头尾分割）
 */
export function truncateToolResult(content: string, toolName?: string, maxChars?: number): string {
  if (toolName && SELF_TRUNCATING_TOOLS.has(toolName)) {
    return content;
  }

  const limit = maxChars ?? TOOL_RESULT_MAX_CHARS;
  if (!content || content.length <= limit) return content;

  const markerText = '\n\n[... 工具返回内容过长，已截断 ...]\n\n';
  const available = limit - markerText.length;
  const headSize = Math.floor(available * 0.4);
  const tailSize = available - headSize;

  const head = content.substring(0, headSize);
  const tail = content.substring(content.length - tailSize);

  return head + markerText + tail;
}

/**
 * 在 text 中查找 TERMINATE 前缀的起始位置
 *
 * ★ 优化：只需检查 text 尾部是否是 target 的前缀。
 * 原实现 O(n²)（对每个位置 slice + startsWith），现在 O(target_len)。
 * 例如 text="...TER", target="TERMINATE" → 返回 text.length-3
 */
export function findTerminatePrefixStart(text: string, target: string): number {
  // 只需要检查 text 尾部最多 target.length-1 个字符是否是 target 的前缀
  // （完整的 target 在文本中间由 _doAppendMessage 的 terminateTemp 机制处理）
  const maxCheck = Math.min(text.length, target.length - 1);
  for (let suffixLen = maxCheck; suffixLen >= 1; suffixLen--) {
    const start = text.length - suffixLen;
    const suffix = text.substring(start);
    if (target.startsWith(suffix)) {
      return start;
    }
  }
  return -1;
}

/**
 * 标记内容为历史（将 doing 状态的 aily-state 块替换为 done）
 */
export function markContentAsHistory(content: string): string {
  if (!content || typeof content !== 'string') {
    return content;
  }
  // aily-state: 将 doing → done
  content = content.replace(
    /```aily-state\n([\s\S]*?)```/g,
    (match, json) => {
      try {
        const trimmedContent = json.trim();
        if (!trimmedContent) {
          return match;
        }
        const data = JSON.parse(trimmedContent);
        if (data.state === 'doing') {
          data.state = 'done';
          return '```aily-state\n' + JSON.stringify(data) + '\n```';
        }
      } catch {
        // JSON 解析失败保持原样
      }
      return match;
    }
  );

  // aily-question: 标记为 isHistory 以便组件以只读模式展示
  content = content.replace(
    /```aily-question\n([\s\S]*?)```/g,
    (match, json) => {
      try {
        const data = JSON.parse(json.trim());
        if (data && typeof data === 'object') {
          data.isHistory = true;
          return '```aily-question\n' + JSON.stringify(data) + '\n```';
        }
      } catch {}
      return match;
    }
  );

  // aily-approval: 标记为已解决状态以便历史恢复时以只读模式展示
  content = content.replace(
    /```aily-approval\n([\s\S]*?)```/g,
    (match, json) => {
      try {
        const data = JSON.parse(json.trim());
        if (data && typeof data === 'object') {
          data.resolved = true;
          return '```aily-approval\n' + JSON.stringify(data) + '\n```';
        }
      } catch {}
      return match;
    }
  );

  return content;
}

/**
 * 检查最后一条消息中未闭合的 markdown 结构，返回需要插入的闭合标签。
 * 使用栈结构按正确顺序闭合嵌套块（内层先闭合）。
 *
 * 支持检测：
 * - `<think>` / `</think>` 标签
 * - ``` 代码块（含代码块内部的 <think> 被视为字面文本）
 * - `<details>` / `</details>` 标签
 */
export function getClosingTagsForOpenBlocks(content: string): string {
  if (!content) return '';

  // 使用栈追踪嵌套结构，每个元素代表一个开放的块类型
  const stack: ('think' | 'codeblock' | 'details')[] = [];
  let i = 0;

  while (i < content.length) {
    const inCodeBlock = stack.length > 0 && stack[stack.length - 1] === 'codeblock';

    // 代码块内只识别 ``` 关闭，不解析 HTML 标签
    if (inCodeBlock) {
      if (content.startsWith('```', i)) {
        stack.pop();
        i += 3;
        // 跳过 ``` 后直到行尾的语言标识符（不会出现，因为是关闭）
        continue;
      }
      i++;
      continue;
    }

    // 非代码块：检测各种开/闭标签
    if (content.startsWith('```', i)) {
      stack.push('codeblock');
      i += 3;
      // 跳过 ``` 后同行的语言标识符
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }

    if (content.startsWith('<think>', i)) {
      stack.push('think');
      i += 7;
      continue;
    }

    if (content.startsWith('</think>', i)) {
      // 向上找最近的 think 弹出
      const idx = stack.lastIndexOf('think');
      if (idx >= 0) stack.splice(idx, 1);
      i += 8;
      continue;
    }

    if (content.startsWith('<details', i)) {
      // <details> 或 <details ...>
      const closeAngle = content.indexOf('>', i + 8);
      if (closeAngle >= 0) {
        stack.push('details');
        i = closeAngle + 1;
        continue;
      }
    }

    if (content.startsWith('</details>', i)) {
      const idx = stack.lastIndexOf('details');
      if (idx >= 0) stack.splice(idx, 1);
      i += 10;
      continue;
    }

    i++;
  }

  // 从栈顶到栈底依次闭合（内层先闭合）
  let closingTags = '';
  for (let j = stack.length - 1; j >= 0; j--) {
    switch (stack[j]) {
      case 'codeblock': closingTags += '\n```\n'; break;
      case 'think': closingTags += '\n</think>\n'; break;
      case 'details': closingTags += '\n</details>\n'; break;
    }
  }

  return closingTags;
}
