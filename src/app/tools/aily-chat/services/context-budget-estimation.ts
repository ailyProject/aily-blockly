import type { TiktokenService } from './tiktoken.service';

let tiktokenServiceRef: TiktokenService | null = null;

export function setContextBudgetTiktokenService(service: TiktokenService): void {
  tiktokenServiceRef = service;
}

export function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }

  if (tiktokenServiceRef) {
    return tiktokenServiceRef.countTokens(text);
  }

  return estimateTokensFallback(text);
}

function estimateTokensFallback(text: string): number {
  let tokenCount = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x4E00 && code < 0x9FFF) {
      tokenCount += 0.67;
    } else if (code > 0x7F) {
      tokenCount += 0.5;
    } else {
      tokenCount += 0.25;
    }
  }

  return Math.ceil(tokenCount);
}

export function estimateMessageTokens(message: any): number {
  const overhead = 4;
  let tokens = overhead;

  if (message.role) {
    tokens += estimateTokenCount(message.role);
  }
  if (message.content) {
    tokens += estimateTokenCount(message.content);
  }
  if (message.name) {
    tokens += estimateTokenCount(message.name);
  }

  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      tokens += 4;
      if (toolCall.id) {
        tokens += estimateTokenCount(toolCall.id);
      }
      if (toolCall.function?.name) {
        tokens += estimateTokenCount(toolCall.function.name);
      }
      if (toolCall.function?.arguments) {
        const args = typeof toolCall.function.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function.arguments);
        tokens += estimateTokenCount(args);
      }
    }
  }

  return tokens;
}

export function estimateMessagesTokens(messages: any[]): number {
  if (!messages || messages.length === 0) {
    return 0;
  }

  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) + 2;
}

export function estimateToolsTokens(tools: any[]): number {
  if (!tools || tools.length === 0) {
    return 0;
  }

  let tokens = 16;
  for (const tool of tools) {
    tokens += 8;
    if (tool.name) {
      tokens += estimateTokenCount(tool.name);
    }
    if (tool.description) {
      tokens += estimateTokenCount(tool.description);
    }
    if (tool.input_schema) {
      tokens += estimateTokenCount(JSON.stringify(tool.input_schema));
    } else if (tool.parameters) {
      tokens += estimateTokenCount(JSON.stringify(tool.parameters));
    }
  }

  return tokens;
}