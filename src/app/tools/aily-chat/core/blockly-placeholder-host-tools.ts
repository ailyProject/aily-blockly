import type { IToolContribution } from 'aily-lex/browser';

import { error, type InvokeHandler } from './blockly-contributed-tool-runtime';

function makeHardwareContribution(): IToolContribution {
  return {
    name: 'hardware',
    description: 'Interact with hardware: list serial ports, upload firmware, and open serial monitor.',
    prompt: `Use this tool for hardware operations. Actions:

- **list_ports**: List available serial ports.
- **upload**: Upload firmware to a board. Requires port and firmware path.
- **serial_monitor**: Open serial monitor on a port. Returns streaming output.

This tool requires a hardware connection (USB/serial).`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_ports', 'upload', 'serial_monitor'],
          description: 'The action to perform.',
        },
        port: { type: 'string', description: 'Serial port name (e.g., "COM3", "/dev/ttyUSB0").' },
        firmwarePath: { type: 'string', description: 'Path to firmware binary for upload.' },
        baudRate: { type: 'number', description: 'Baud rate for serial monitor (default: 115200).' },
        duration: { type: 'number', description: 'Monitoring duration in ms (default: 5000).' },
      },
      required: ['action'],
    },
    annotations: { readOnly: false },
  };
}

function makeCodeEditorContribution(): IToolContribution {
  return {
    name: 'codeEditor',
    description: 'Interact with the IDE code editor. Read/edit active file, navigate to positions, and get diagnostics.',
    prompt: `Use this tool for IDE code editor operations. Actions:

- **get_active_file**: Get the currently active file's content and path.
- **open_file**: Open a file in the editor, optionally at a specific line.
- **apply_edit**: Apply a content edit to a file via the editor API.
- **get_symbols**: Get workspace symbols matching a query.

This tool requires a supported IDE code editor to be active.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_active_file', 'open_file', 'apply_edit', 'get_symbols'],
          description: 'The action to perform.',
        },
        filePath: { type: 'string', description: 'File path for open_file or apply_edit.' },
        line: { type: 'number', description: 'Line number for open_file.' },
        content: { type: 'string', description: 'New content for apply_edit.' },
        query: { type: 'string', description: 'Symbol query for get_symbols.' },
      },
      required: ['action'],
    },
    annotations: { readOnly: false },
  };
}

export function getBlocklyPlaceholderContributions(): IToolContribution[] {
  return [
    makeHardwareContribution(),
    makeCodeEditorContribution(),
  ];
}

export function createBlocklyPlaceholderHandlers(): Record<string, InvokeHandler> {
  return {
    hardware: async (input, _hostAPI) => {
      return error(`Hardware action "${input['action']}" requires direct external tool integration.`);
    },
    codeEditor: async (input, _hostAPI) => {
      return error(`Code editor action "${input['action']}" requires direct external tool integration.`);
    },
  };
}
