import type { Tool } from '../core/chat-types';

export const SAVE_ARCH_TOOL: Tool = {
  name: 'save_arch',
  description: `Save or replace arch.md in the active project with a Mermaid architecture diagram.

Pass raw Mermaid DSL in code (without a fenced code block). Prefer flowchart TD or flowchart LR, stable ASCII node identifiers, and explicit data/physical connection labels.`,
  input_schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Raw Mermaid DSL without a Markdown code fence.',
      },
    },
    required: ['code'],
  },
  agents: ['mainAgent'],
};

export const HOST_EXTERNAL_TOOLS: Tool[] = [SAVE_ARCH_TOOL];
