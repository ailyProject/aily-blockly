import { ChatPartStore } from './chat-part-store';
import { RenderEventPartAdapter } from './render-event-part-adapter';
import { turnResponsePartsToDisplayChatParts } from './turn-response-part-mapper';
import { buildActivityGroupPresentation, buildToolActivityDisplayItem } from '../components/x-dialog/chat-activity-group-projection';
import { buildChatRenderItems } from '../components/x-dialog/chat-subagent-group-projection';
import type { RenderEvent } from 'aily-lex/browser';

describe('RenderEventPartAdapter', () => {
  let store: ChatPartStore;
  let adapter: RenderEventPartAdapter;
  let currentHandle: any;

  beforeEach(() => {
    store = new ChatPartStore();
    adapter = new RenderEventPartAdapter(store);
    currentHandle = store.createDetachedHandle();
  });

  afterEach(() => {
    adapter.dispose();
    store.destroy();
  });

  it('should append markdown deltas to MarkdownPart', () => {
    processCurrent({ type: 'markdown_delta', text: 'Hello ', timestamp: 1 });
    processCurrent({ type: 'markdown_delta', text: 'world', timestamp: 2 });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('markdown');
    expect((parts[0] as any).content).toBe('Hello world');
  });

  it('streams proposed plan blocks as a dedicated plan part instead of markdown', () => {
    processCurrent({ type: 'markdown_delta', text: 'Intro\n<proposed_', timestamp: 1 });
    processCurrent({ type: 'markdown_delta', text: 'plan>\n1. Inspect', timestamp: 2 });

    let parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(2);
    expect(parts[0]).toEqual(jasmine.objectContaining({ type: 'markdown', content: 'Intro\n' }));
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'plan',
      status: 'streaming',
      text: '\n1. Inspect',
      source: 'proposed_plan',
    }));

    processCurrent({ type: 'markdown_delta', text: '\n2. Implement</proposed_', timestamp: 3 });
    processCurrent({ type: 'markdown_delta', text: 'plan>\nAfter', timestamp: 4 });

    parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(3);
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'plan',
      status: 'completed',
      text: '1. Inspect\n2. Implement',
    }));
    expect(parts[2]).toEqual(jasmine.objectContaining({ type: 'markdown', content: '\nAfter' }));
  });

  it('finalizes an unterminated proposed plan block at turn end', () => {
    processCurrent({ type: 'markdown_delta', text: '<proposed_plan>\n1. Inspect', timestamp: 1 });

    adapter.finalize(currentHandle);

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts).toEqual([
      jasmine.objectContaining({
        type: 'plan',
        status: 'completed',
        text: '1. Inspect',
      }),
    ]);
  });

  it('does not materialize final plan-mode markdown as a plan part when the model omits proposed_plan tags', () => {
    processCurrent({ type: 'markdown_delta', text: 'Intro\n', timestamp: 1 });
    processCurrent({ type: 'markdown_delta', text: '## Plan\n1. Wire DHT11\n2. Verify OLED', timestamp: 2 });

    adapter.finalize(currentHandle);

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts).toEqual([
      jasmine.objectContaining({
        type: 'markdown',
        content: 'Intro\n## Plan\n1. Wire DHT11\n2. Verify OLED',
      }),
    ]);
  });

  it('should append thinking deltas and complete', () => {
    processCurrent({ type: 'thinking_delta', text: 'Let me think...', timestamp: 1 });
    processCurrent({ type: 'thinking_complete', timestamp: 2 });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('thinking');
    expect((parts[0] as any).content).toBe('Let me think...');
    expect((parts[0] as any).isComplete).toBe(true);
  });

  it('should handle tool call lifecycle', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc1',
      toolName: 'readFile',
      input: { path: '/test.ts' },
      timestamp: 1,
    });

    let parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('tool_call');
    expect((parts[0] as any).state).toBe('doing');

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc1',
      toolName: 'readFile',
      resultText: 'File read successfully',
      durationMs: 100,
      state: 'done',
      isError: false,
      timestamp: 2,
    });

    parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).state).toBe('done');
    expect((parts[0] as any).text).toBe('File read successfully');
  });

  it('patches duplicate tool ids only within the current response handle', () => {
    const staleHandle = store.createDetachedHandle();
    adapter.process({
      type: 'tool_call_begin',
      toolCallId: 'duplicate-tool',
      toolName: 'readFile',
      input: { path: '/old.ts' },
      timestamp: 1,
    }, staleHandle);

    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'duplicate-tool',
      toolName: 'readFile',
      input: { path: '/new.ts' },
      timestamp: 2,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'duplicate-tool',
      toolName: 'readFile',
      resultText: 'current response done',
      durationMs: 12,
      state: 'done',
      isError: false,
      timestamp: 3,
    });

    const stalePart = store.getPartsForHandle(staleHandle)[0] as any;
    const currentPart = store.getPartsForHandle(currentHandle)[0] as any;
    expect(stalePart.state).toBe('doing');
    expect(stalePart.text).toBe('readFile…');
    expect(currentPart.state).toBe('done');
    expect(currentPart.text).toBe('current response done');
  });

  it('should handle error tool call', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc2',
      toolName: 'writeFile',
      input: {},
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc2',
      toolName: 'writeFile',
      resultText: 'Permission denied',
      durationMs: 50,
      state: 'error',
      isError: true,
      timestamp: 2,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).state).toBe('error');
  });

  it('maps retryable service stream errors to structured retry actions', () => {
    processCurrent({
      type: 'error_notice',
      message: '对话流处理异常，请稍后重试',
      code: '29001',
      timestamp: 1,
    });

    const part = store.getPartsForHandle(currentHandle)[0] as any;
    expect(part.type).toBe('error');
    expect(part.metadata?.errorDetails?.code).toBe('29001');
    expect(part.metadata?.errorDetails?.confirmationButtons).toEqual([
      {
        data: { ailyContinueOnError: true },
        label: '重试',
      },
    ]);
  });

  it('maps prefixed 29001 service errors without a code field to retry actions', () => {
    processCurrent({
      type: 'error_notice',
      message: 'aily-services [29001]: 对话流处理异常，请稍后重试',
      timestamp: 1,
    });

    const part = store.getPartsForHandle(currentHandle)[0] as any;
    expect(part.type).toBe('error');
    expect(part.message).toBe('模型服务当前访问量较高，请稍后重试。');
    expect(part.metadata?.code).toBe('29001');
    expect(part.metadata?.errorDetails).toEqual(jasmine.objectContaining({
      code: '29001',
      originalMessage: '对话流处理异常，请稍后重试',
      confirmationButtons: jasmine.arrayContaining([
        jasmine.objectContaining({
          data: { ailyContinueOnError: true },
          label: '重试',
        }),
      ]),
    }));
  });

  it('prefers provider pressure messages from service error details', () => {
    processCurrent({
      type: 'error_notice',
      message: 'aily-services [29001]: 对话流处理异常，请稍后重试',
      details: {
        error: {
          code: '1305',
          message: '该模型当前访问量过大，请您稍后再试',
        },
      },
      timestamp: 1,
    } as any);

    const part = store.getPartsForHandle(currentHandle)[0] as any;
    expect(part.message).toBe('该模型当前访问量过大，请您稍后再试');
    expect(part.metadata?.errorDetails).toEqual(jasmine.objectContaining({
      code: '29001',
      providerMessage: '该模型当前访问量过大，请您稍后再试',
      confirmationButtons: jasmine.arrayContaining([
        jasmine.objectContaining({ label: '重试' }),
      ]),
    }));
  });

  it('preserves structured read_file metadata from lex tool results through the displayed tool header', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-read-file',
      toolName: 'read_file',
      input: { filePath: '/workspace/readme_ai.md', startLine: 1, endLine: 2000 },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-read-file',
      toolName: 'read_file',
      resultText: '1\talpha\n2\tbeta',
      result: {
        content: [{ type: 'text', text: '1\talpha\n2\tbeta' }],
        metadata: {
          readFile: {
            filePath: '/workspace/readme_ai.md',
            requestedStartLine: 1,
            requestedEndLine: 2000,
            returnedStartLine: 1,
            returnedEndLine: 120,
            lineCount: 120,
            totalLines: 4000,
            readBytes: 4096,
            totalBytes: 16384,
            truncatedByBytes: true,
            continueWith: {
              startLine: 121,
              endLine: 2120,
            },
          },
        },
      },
      durationMs: 100,
      state: 'done',
      isError: false,
      timestamp: 2,
    });

    const part = store.getPartsForHandle(currentHandle)[0] as any;
    expect(part.metadata?.readFile).toEqual(jasmine.objectContaining({
      returnedStartLine: 1,
      returnedEndLine: 120,
      totalBytes: 16384,
      readBytes: 4096,
      truncatedByBytes: true,
      continueWith: jasmine.objectContaining({ startLine: 121, endLine: 2120 }),
    }));

    const display = buildToolActivityDisplayItem(part);
    expect(display.toolHeader).toEqual(jasmine.objectContaining({
      title: 'Read readme_ai.md',
      subtitle: 'lines 1 to 120, 4,096 bytes of 16,384 bytes, byte-capped, continue with lines 121 to 2120',
    }));
  });

  it('should append a terminal part for run_in_terminal tool results', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-terminal',
      toolName: 'run_in_terminal',
      input: { command: 'npm test' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-terminal',
      toolName: 'run_in_terminal',
      resultText: 'status: success',
      result: {
        content: [{
          type: 'text',
          text: 'status: success\nterminalId: term-1\nexitCode: 0\ncwd: /workspace\ncommand: npm test\n\nstdout:\ndone\n\nstderr:\n(terminal stderr completed with no output)',
        }],
      },
      durationMs: 50,
      state: 'done',
      isError: false,
      timestamp: 2,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts).toEqual([
      jasmine.objectContaining({ type: 'terminal', command: 'npm test', output: 'done', exitCode: 0 }),
    ]);
  });

  it('should stream command_exec output into one terminal part before completion', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command',
      toolName: 'command_exec',
      input: { command: 'npm test' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'npm test',
        stream: 'stdout',
        text: 'line 1\n',
        bytesTotal: 7,
      },
      timestamp: 2,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'npm test',
        stream: 'stderr',
        text: 'warn\n',
        bytesTotal: 12,
      },
      timestamp: 3,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts).toEqual([
      jasmine.objectContaining({
        type: 'terminal',
        command: 'npm test',
        output: 'line 1\n',
        stderr: 'warn\n',
        isRunning: true,
      }),
    ]);
  });

  it('should stop a streamed command terminal when progress reports a killed process', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-stop',
      toolName: 'command_exec',
      input: { command: 'npm test' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command-stop',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'npm test',
        stream: 'stderr',
        text: '[Process stopped by user]',
        processId: 'process-1',
        outputSessionId: 'process-1',
        status: 'killed',
        running: false,
        bytesTotal: 25,
      },
      timestamp: 2,
    });

    const terminal = store.getPartsForHandle(currentHandle).find(part => part.type === 'terminal') as any;
    expect(terminal).toEqual(jasmine.objectContaining({
      type: 'terminal',
      command: 'npm test',
      stderr: '[Process stopped by user]',
      isRunning: false,
      status: 'killed',
      processId: 'process-1',
      outputSessionId: 'process-1',
    }));
  });

  it('should keep the invocation command when worker progress omits a valid terminal command', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-undefined',
      toolName: 'command_exec',
      input: { command: 'Get-Location' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command-undefined',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'undefined',
        stream: 'stdout',
        text: 'C:\\workspace\n',
        outputSessionId: 'out-command-undefined',
        status: 'running',
        running: true,
      },
      timestamp: 2,
    });

    expect(store.getPartsForHandle(currentHandle)).toEqual([
      jasmine.objectContaining({
        type: 'terminal',
        command: 'Get-Location',
        output: 'C:\\workspace\n',
        outputSessionId: 'out-command-undefined',
        isRunning: true,
      }),
    ]);
  });

  it('should keep the approval command when worker progress arrives without a prior visible tool part', () => {
    processCurrent({
      type: 'approval_request',
      toolCallId: 'tc-approval-command-only',
      requestId: 'approval-command-only',
      toolName: 'command_exec',
      input: { command: 'Write-Output ok' },
      message: 'Allow terminal command?',
      timestamp: 1,
    } as RenderEvent);

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-approval-command-only',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'undefined',
        stream: 'stdout',
        text: 'ok\n',
        outputSessionId: 'out-approval-command-only',
        status: 'running',
        running: true,
      },
      timestamp: 2,
    });

    expect(store.getPartsForHandle(currentHandle)).toEqual([
      jasmine.objectContaining({
        type: 'terminal',
        command: 'Write-Output ok',
        output: 'ok\n',
        outputSessionId: 'out-approval-command-only',
        isRunning: true,
      }),
    ]);
  });

  it('should keep the invocation command when final terminal result has an invalid command', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-final-undefined',
      toolName: 'command_exec',
      input: { command: 'echo "Command line tool works!" && ver' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-command-final-undefined',
      toolName: 'command_exec',
      input: { command: 'echo "Command line tool works!" && ver' },
      resultText: 'status: completed\ncommand: undefined\nexitCode: 0\n\nstdout:\nCommand line tool works!',
      result: {
        content: [{
          type: 'text',
          text: 'status: completed\ncommand: undefined\nexitCode: 0\n\nstdout:\nCommand line tool works!',
        }],
      },
      state: 'done',
      isError: false,
      durationMs: 74,
      timestamp: 2,
    } as RenderEvent);

    expect(store.getPartsForHandle(currentHandle)).toEqual([
      jasmine.objectContaining({
        type: 'terminal',
        command: 'echo "Command line tool works!" && ver',
        output: 'Command line tool works!',
        exitCode: 0,
        isRunning: false,
      }),
    ]);
  });

  it('should merge structured command session updates into the same terminal session without duplicating live output', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-exec',
      toolName: 'command_exec',
      input: { command: 'npm test' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command-exec',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'npm test',
        stream: 'stdout',
        text: 'line 1\n',
        processId: 'process-1',
        outputSessionId: 'output-1',
        bytesTotal: 7,
      },
      timestamp: 2,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command-exec',
      data: {
        kind: 'command_session_update',
        toolName: 'command_exec',
        command: 'npm test',
        stdout: 'line 1\n',
        stderr: '',
        processId: 'process-1',
        outputSessionId: 'output-1',
        outputFilePath: '/tmp/output-1.log',
        cwd: '/workspace',
        status: 'running',
        running: true,
        bytesTotal: 7,
      },
      timestamp: 3,
    });

    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-status',
      toolName: 'command_status',
      input: { processId: 'process-1' },
      timestamp: 4,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command-status',
      data: {
        kind: 'command_session_update',
        toolName: 'command_status',
        command: 'npm test',
        stdout: 'line 1\ndone\n',
        stderr: '',
        processId: 'process-1',
        outputSessionId: 'output-1',
        outputFilePath: '/tmp/output-1.log',
        cwd: '/workspace',
        status: 'completed',
        running: false,
        exitCode: 0,
        bytesTotal: 12,
        lastOutputAt: 1770998400000,
      },
      timestamp: 5,
    });

    const terminals = store.getPartsForHandle(currentHandle).filter(part => part.type === 'terminal') as any[];
    expect(terminals.length).toBe(1);
    expect(terminals[0]).toEqual(jasmine.objectContaining({
      type: 'terminal',
      command: 'npm test',
      output: 'line 1\ndone\n',
      stderr: '',
      exitCode: 0,
      isRunning: false,
      status: 'completed',
      processId: 'process-1',
      outputSessionId: 'output-1',
      outputFilePath: '/tmp/output-1.log',
      cwd: '/workspace',
      bytesTotal: 12,
      lastOutputAt: new Date(1770998400000).toISOString(),
      sourceToolCallIds: ['tc-command-exec', 'tc-command-status'],
    }));
  });

  it('should project terminal status begin/end into the existing terminal invocation', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-exec',
      toolName: 'command_exec',
      input: { command: 'Get-ChildItem' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-command-exec',
      toolName: 'command_exec',
      resultText: 'status: running\nprocessId: terminal-1\noutputSessionId: terminal-1\ncommand: Get-ChildItem',
      result: {
        content: [
          {
            type: 'text',
            text: 'status: running\nprocessId: terminal-1\noutputSessionId: terminal-1\ncommand: Get-ChildItem',
          },
        ],
      },
      state: 'done',
      isError: false,
      durationMs: 1,
      timestamp: 2,
    });

    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-status',
      toolName: 'command_status',
      input: { processId: 'terminal-1', yieldTimeMs: 3000 },
      timestamp: 3,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-command-status',
      toolName: 'command_status',
      resultText: 'status: completed\nprocessId: terminal-1\noutputSessionId: terminal-1\nexitCode: 0\n\nstdout:\ndone',
      result: {
        content: [
          {
            type: 'text',
            text: 'status: completed\nprocessId: terminal-1\noutputSessionId: terminal-1\nexitCode: 0\n\nstdout:\ndone',
          },
        ],
      },
      state: 'done',
      isError: false,
      durationMs: 1,
      timestamp: 4,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.map(part => part.type)).toEqual(['terminal']);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'terminal',
      toolCallId: 'tc-command-exec',
      sourceToolCallIds: ['tc-command-exec', 'tc-command-status'],
      processId: 'terminal-1',
      outputSessionId: 'terminal-1',
      output: 'done',
      isRunning: false,
      status: 'completed',
      exitCode: 0,
    }));
  });

  it('should preserve structured image and resource tool results in metadata timeline', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-structured',
      toolName: 'mcp_read_resource',
      input: { uri: 'file:///workspace/report.json' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-structured',
      toolName: 'mcp_read_resource',
      resultText: '读取资源结果',
      result: {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X2HFNwAAAABJRU5ErkJggg==',
          },
          {
            type: 'resource',
            uri: 'file:///workspace/report.json',
            mimeType: 'application/json',
            text: '结构化诊断结果',
          },
        ],
      },
      durationMs: 20,
      state: 'done',
      isError: false,
      timestamp: 2,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata?.timeline?.[0]?.resultContent).toEqual([
      jasmine.objectContaining({ type: 'output_image', mimeType: 'image/png' }),
      jasmine.objectContaining({
        type: 'output_resource',
        uri: 'file:///workspace/report.json',
        mimeType: 'application/json',
        text: '结构化诊断结果',
      }),
    ]);
  });

  it('should upsert state updates', () => {
    processCurrent({
      type: 'state_update',
      stateId: 'mcp-1',
      kind: 'mcp',
      text: 'Connecting...',
      state: 'doing',
      timestamp: 1,
    });

    processCurrent({
      type: 'state_update',
      stateId: 'mcp-1',
      kind: 'mcp',
      text: 'Connected',
      state: 'done',
      timestamp: 2,
    });

    const parts = store.getPartsForHandle(currentHandle);
    // Should still be 1 part (upsert, not add)
    expect(parts.filter(p => p.type === 'state').length).toBe(1);
    expect((parts[0] as any).text).toBe('Connected');
    expect((parts[0] as any).state).toBe('done');
  });

  it('should handle question request', () => {
    processCurrent({
      type: 'question_request',
      requestId: 'q1',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }],
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('question');
    expect((parts[0] as any).partId).toBe('question:q1');
    expect((parts[0] as any).questions.length).toBe(1);
  });

  it('should handle approval request and resolve', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'a1',
      toolName: 'writeFile',
      input: { path: '/demo.ts' },
      timestamp: 0,
    });

    processCurrent({
      type: 'approval_request',
      toolCallId: 'a1',
      toolName: 'writeFile',
      input: {},
      message: 'Allow file write?',
      timestamp: 1,
    });

    let parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'a1',
      state: 'pending_approval',
      text: 'Allow file write?',
      metadata: jasmine.objectContaining({
        approval: jasmine.objectContaining({
          toolCallId: 'a1',
          toolName: 'writeFile',
          resolved: false,
        }),
      }),
    }));

    processCurrent({
      type: 'approval_resolve',
      toolCallId: 'a1',
      result: 'approved',
      scope: 'session',
      timestamp: 2,
    });

    parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'a1',
      state: 'doing',
      text: 'writeFile…',
      metadata: jasmine.objectContaining({
        approval: jasmine.objectContaining({
          toolCallId: 'a1',
          toolName: 'writeFile',
          message: 'Allow file write?',
          previousText: 'writeFile…',
          resolved: true,
          result: 'approved',
          scope: 'session',
        }),
      }),
    }));
  });

  it('should replace an approved terminal tool call with one terminal invocation and preserve approval metadata', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'terminal-approval-call',
      toolName: 'command_exec',
      input: { command: 'Get-Location' },
      timestamp: 0,
    });

    processCurrent({
      type: 'approval_request',
      toolCallId: 'terminal-approval-call',
      toolName: 'command_exec',
      input: { command: 'Get-Location' },
      message: 'Allow terminal command?',
      title: 'Run terminal command',
      actions: [
        { scope: 'once', label: 'Allow once' },
        { scope: 'session-all-terminal', label: 'Allow all terminal commands in this chat' },
      ],
      primaryScope: 'once',
      timestamp: 1,
    });

    processCurrent({
      type: 'approval_resolve',
      toolCallId: 'terminal-approval-call',
      result: 'approved',
      scope: 'session-all-terminal',
      timestamp: 2,
    });

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'terminal-approval-call',
      toolName: 'command_exec',
      resultText: 'status: completed\nprocessId: terminal-approved-1\noutputSessionId: terminal-approved-1\nexitCode: 0\ncommand: Get-Location\n\nstdout:\ndone',
      result: {
        content: [
          {
            type: 'text',
            text: 'status: completed\nprocessId: terminal-approved-1\noutputSessionId: terminal-approved-1\nexitCode: 0\ncommand: Get-Location\n\nstdout:\ndone',
          },
        ],
      },
      state: 'done',
      isError: false,
      durationMs: 10,
      timestamp: 3,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.map(part => part.type)).toEqual(['terminal']);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'terminal',
      toolCallId: 'terminal-approval-call',
      command: 'Get-Location',
      output: 'done',
      isRunning: false,
      status: 'completed',
      processId: 'terminal-approved-1',
      metadata: jasmine.objectContaining({
        approval: jasmine.objectContaining({
          toolCallId: 'terminal-approval-call',
          toolName: 'command_exec',
          message: 'Allow terminal command?',
          title: 'Run terminal command',
          resolved: true,
          result: 'approved',
          scope: 'session-all-terminal',
        }),
      }),
    }));
  });

  it('should replace a generic terminal confirmation with one terminal invocation and preserve approval metadata', () => {
    processCurrent({
      type: 'approval_request',
      requestId: 'generic-terminal-approval',
      toolName: 'run_in_terminal',
      input: { command: 'Get-ChildItem' },
      message: 'Allow terminal command?',
      title: 'Run terminal command',
      actions: [
        { scope: 'once', label: 'Allow once' },
        { scope: 'session-all-terminal', label: 'Allow all terminal commands in this chat' },
      ],
      primaryScope: 'once',
      timestamp: 1,
    } as any);

    processCurrent({
      type: 'approval_resolve',
      requestId: 'generic-terminal-approval',
      result: 'approved',
      scope: 'session-all-terminal',
      timestamp: 2,
    } as any);

    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'terminal-run-call',
      toolName: 'run_in_terminal',
      resultText: 'status: success\nterminalId: term-generic-1\nexitCode: 0\ncwd: /workspace\ncommand: Get-ChildItem\n\nstdout:\ndone',
      result: {
        content: [
          {
            type: 'text',
            text: 'status: success\nterminalId: term-generic-1\nexitCode: 0\ncwd: /workspace\ncommand: Get-ChildItem\n\nstdout:\ndone',
          },
        ],
      },
      state: 'done',
      isError: false,
      durationMs: 10,
      timestamp: 3,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.map(part => part.type)).toEqual(['terminal']);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'terminal',
      toolCallId: 'terminal-run-call',
      command: 'Get-ChildItem',
      output: 'done',
      isRunning: false,
      status: 'success',
      terminalId: 'term-generic-1',
      metadata: jasmine.objectContaining({
        approval: jasmine.objectContaining({
          toolCallId: 'terminal-run-call',
          toolName: 'run_in_terminal',
          message: 'Allow terminal command?',
          title: 'Run terminal command',
          resolved: true,
          result: 'approved',
          scope: 'session-all-terminal',
        }),
      }),
    }));
  });

  it('should display an approved terminal invocation as one terminal part when raw host stream keeps the approval tool call', () => {
    const visibleParts = turnResponsePartsToDisplayChatParts([
      {
        type: 'tool_call',
        toolCallId: 'call-command-exec',
        toolName: 'command_exec',
        text: 'Run terminal command',
        state: 'done',
        args: { command: 'Get-Location' },
        metadata: {
          approval: {
            args: { command: 'Get-Location' },
            resolved: true,
            result: 'approved',
          },
        },
      },
      {
        type: 'terminal',
        partId: 'terminal-session:terminal-1',
        toolCallId: 'call-command-status',
        sourceToolCallIds: ['call-command-exec', 'call-command-status'],
        command: 'Get-Location',
        output: 'done',
        isRunning: false,
        processId: 'terminal-1',
        outputSessionId: 'terminal-1',
        status: 'completed',
      },
    ] as any);

    expect(visibleParts.map(part => part.type)).toEqual(['terminal']);
    expect(visibleParts[0]).toEqual(jasmine.objectContaining({
      type: 'terminal',
      command: 'Get-Location',
      output: 'done',
    }));
  });

  it('should display a generic terminal confirmation and terminal result as one terminal part by command ownership', () => {
    const visibleParts = turnResponsePartsToDisplayChatParts([
      {
        type: 'confirmation',
        partId: 'confirmation:generic-terminal-approval',
        askId: 'generic-terminal-approval',
        toolName: 'run_in_terminal',
        title: 'Run terminal command',
        message: 'Allow terminal command?',
        args: { command: 'Get-ChildItem' },
        resolved: true,
        result: 'approved',
      },
      {
        type: 'terminal',
        partId: 'terminal-session:terminal-2',
        toolCallId: 'terminal-run-call',
        command: 'Get-ChildItem',
        output: 'done',
        isRunning: false,
        terminalId: 'terminal-2',
        status: 'success',
        metadata: {
          approval: {
            args: { command: 'Get-ChildItem' },
            resolved: true,
            result: 'approved',
          },
        },
      },
    ] as any);

    expect(visibleParts.map(part => part.type)).toEqual(['terminal']);
    expect(visibleParts[0]).toEqual(jasmine.objectContaining({
      type: 'terminal',
      command: 'Get-ChildItem',
      output: 'done',
    }));
  });

  it('should keep standalone confirmation parts when no matching tool call exists', () => {
    processCurrent({
      type: 'approval_request',
      requestId: 'standalone-approval',
      toolName: 'writeFile',
      input: { path: '/demo.ts' },
      message: 'Allow file write?',
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(1);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'confirmation',
      askId: 'standalone-approval',
      title: 'Confirm Action: writeFile',
      resolved: false,
    }));
  });

  it('should preserve structured approval presentation data from render events', () => {
    processCurrent({
      type: 'approval_request',
      requestId: 'a2',
      toolName: 'run_in_terminal',
      input: { command: 'npm test' },
      message: 'lex 下发的审批消息',
      description: '```diff\n- old\n+ new\n```',
      title: '运行终端命令',
      subtitle: 'run_in_terminal · lex',
      actions: [
        { scope: 'workspace', label: '在当前工作区中自动运行此命令', tooltip: '写入工作区规则' },
      ],
      primaryScope: 'workspace',
      timestamp: 3,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'confirmation',
      askId: 'a2',
      title: '运行终端命令',
      subtitle: 'run_in_terminal · lex',
      description: '```diff\n- old\n+ new\n```',
      args: jasmine.objectContaining({ command: 'npm test' }),
      primaryScope: 'workspace',
      actions: [
        jasmine.objectContaining({ scope: 'workspace', label: '在当前工作区中自动运行此命令' }),
      ],
    }));
  });

  it('should not synthesize standalone confirmation parts for tool-linked approval events without a matching tool call', () => {
    processCurrent({
      type: 'approval_request',
      toolCallId: 'missing-tool-call',
      toolName: 'writeFile',
      input: { path: '/demo.ts' },
      message: 'Allow file write?',
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(0);
  });

  it('should project auto-review lifecycle onto tool-call approval metadata', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'review-1',
      toolName: 'write_file',
      input: { filePath: '/workspace/src/app.ts' },
      timestamp: 0,
    });

    processCurrent({
      type: 'approval_auto_review_start',
      reviewId: 'review-review-1',
      toolCallId: 'review-1',
      toolName: 'write_file',
      reason: 'strict auto-review required: default: safe write auto-allowed',
      source: 'approval',
      timestamp: 1,
    });

    let parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata?.approval).toEqual(jasmine.objectContaining({
      toolCallId: 'review-1',
      reviewer: 'auto_review',
      reviewStatus: 'reviewing',
      title: '自动审查中',
    }));

    processCurrent({
      type: 'approval_auto_review_complete',
      reviewId: 'review-review-1',
      toolCallId: 'review-1',
      toolName: 'write_file',
      status: 'approved',
      riskLevel: 'medium',
      rationale: 'Patch only updates existing workspace files.',
      decisionSource: 'user_override',
      source: 'approval',
      timestamp: 2,
    } as any);

    parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata?.approval).toEqual(jasmine.objectContaining({
      toolCallId: 'review-1',
      reviewer: 'auto_review',
      reviewStatus: 'approved',
      reviewRiskLevel: 'medium',
      decisionSource: 'user_override',
      resolved: true,
      result: 'approved',
    }));
  });

  it('should handle error notice', () => {
    processCurrent({
      type: 'error_notice',
      message: 'Something went wrong',
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0].type).toBe('error');
    expect((parts[0] as any).message).toBe('Something went wrong');
  });

  it('should handle info notice', () => {
    processCurrent({
      type: 'info_notice',
      message: 'Index complete',
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0].type).toBe('error');
    expect((parts[0] as any).message).toBe('Index complete');
    expect((parts[0] as any).severity).toBe('info');
  });

  it('should preserve scoped subagent metadata on notice parts', () => {
    processCurrent({
      type: 'warning_notice',
      message: 'Child agent needs more context.',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0].type).toBe('error');
    expect((parts[0] as any).severity).toBe('warning');
    expect((parts[0] as any).metadata).toEqual(jasmine.objectContaining({
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
  });

  it('should preserve scoped subagent metadata on interaction parts', () => {
    processCurrent({
      type: 'question_request',
      requestId: 'question-1',
      questions: [{ question: 'Which file?' }],
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
      timestamp: 1,
    });
    processCurrent({
      type: 'approval_request',
      requestId: 'approval-standalone',
      toolName: 'ask_user',
      input: { reason: 'Need confirmation' },
      message: 'Continue?',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
      timestamp: 2,
    });

    const parts = store.getPartsForHandle(currentHandle) as any[];
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'question',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
    expect(parts[0].metadata).toEqual(jasmine.objectContaining({
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'confirmation',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
    expect(parts[1].metadata).toEqual(jasmine.objectContaining({
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
  });

  it('should preserve scoped subagent metadata on tool approval patches', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'child-tool',
      toolName: 'write_file',
      input: { path: 'a.ts' },
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
      timestamp: 1,
    });
    processCurrent({
      type: 'approval_request',
      toolCallId: 'child-tool',
      toolName: 'write_file',
      input: { path: 'a.ts' },
      message: 'Allow write?',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
      timestamp: 2,
    });

    const parts = store.getPartsForHandle(currentHandle) as any[];
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      state: 'pending_approval',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
    expect(parts[0].metadata).toEqual(jasmine.objectContaining({
      approval: jasmine.any(Object),
      subAgentInvocationId: 'call-agent',
      parentToolCallId: 'call-agent',
    }));
  });

  it('should handle subagent lifecycle', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa1',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    });

    let parts = store.getPartsForHandle(currentHandle);
    expect(parts[0].type).toBe('tool_call');
    expect((parts[0] as any).state).toBe('doing');
    expect((parts[0] as any).toolName).toBe('agent');
    expect((parts[0] as any).metadata).toEqual(jasmine.objectContaining({
      toolName: 'agent',
      subAgentInvocationId: 'sa1',
      invocationMessage: 'Searching codebase',
      toolSpecificData: jasmine.objectContaining({
        description: 'Searching codebase',
        agentName: 'Explore',
        result: '',
      }),
    }));

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa1',
      activityKind: 'tool_started',
      toolName: 'grep',
      childToolCallId: 'child1',
      content: 'Searching...',
      timestamp: 2,
    });

    parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata.toolSpecificData.childItems).toBeUndefined();
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'child1',
      toolName: 'grep',
      text: 'Searching...',
      state: 'doing',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    }));

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa1',
      activityKind: 'tool_progress',
      toolName: 'grep',
      childToolCallId: 'child1',
      content: 'Still searching...',
      timestamp: 2.5,
    });

    parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata.toolSpecificData.childItems).toBeUndefined();
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'child1',
      text: 'Still searching...',
      state: 'doing',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    }));

    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa1',
      agentName: 'Explore',
      resultText: 'Found 3 matches',
      state: 'done',
      durationMs: 500,
      timestamp: 3,
    });

    parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).state).toBe('done');
    expect((parts[0] as any).metadata).toEqual(jasmine.objectContaining({
      subAgentInvocationId: 'sa1',
      toolSpecificData: jasmine.objectContaining({
        description: 'Searching codebase',
        agentName: 'Explore',
        result: 'Found 3 matches',
      }),
    }));
  });

  it('normalizes host subagent terminal aliases before updating the response model', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-completed',
      agentName: 'Explore',
      description: 'Search files',
      timestamp: 1,
    });

    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa-completed',
      agentName: 'Explore',
      resultText: 'Found files',
      state: 'completed',
      durationMs: 50,
      timestamp: 2,
    } as any);

    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-failed',
      agentName: 'Explore',
      description: 'Search failed',
      timestamp: 3,
    });

    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa-failed',
      agentName: 'Explore',
      resultText: 'Search failed',
      state: 'failed',
      durationMs: 60,
      timestamp: 4,
    } as any);

    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-end-without-state',
      agentName: 'Explore',
      description: 'Search without explicit state',
      timestamp: 5,
    });

    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa-end-without-state',
      agentName: 'Explore',
      resultText: 'Ended',
      durationMs: 70,
      timestamp: 6,
    } as any);

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'sa-completed',
      state: 'done',
      metadata: jasmine.objectContaining({ phase: 'completed' }),
    }));
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'sa-failed',
      state: 'error',
      metadata: jasmine.objectContaining({ phase: 'failed' }),
    }));
    expect(parts[2]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'sa-end-without-state',
      state: 'done',
      metadata: jasmine.objectContaining({ phase: 'completed' }),
    }));
  });

  it('finalizes scoped subagent child parts when the parent subagent ends', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-parent',
      subAgentInvocationId: 'sa-parent',
      agentName: 'SchematicAgent',
      description: 'Generate wiring diagram',
      timestamp: 1,
    } as any);

    processCurrent({
      type: 'thinking_delta',
      text: 'Let me analyze the project context.',
      timestamp: 2,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa-parent',
      parentToolCallId: 'sa-parent',
    } as any);

    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'child-context',
      toolName: 'checked_project_context',
      input: {},
      timestamp: 3,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa-parent',
      parentToolCallId: 'sa-parent',
    } as any);

    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa-parent',
      subAgentInvocationId: 'sa-parent',
      agentName: 'SchematicAgent',
      resultText: 'Wiring diagram generated.',
      state: 'done',
      timestamp: 4,
    } as any);

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts).toEqual([
      jasmine.objectContaining({ type: 'tool_call', toolCallId: 'sa-parent', state: 'done' }),
      jasmine.objectContaining({ type: 'thinking', isComplete: true }),
      jasmine.objectContaining({ type: 'tool_call', toolCallId: 'child-context', state: 'done' }),
    ]);

    const renderItems = buildChatRenderItems(parts, false);
    expect(renderItems.length).toBe(1);
    expect(renderItems[0].kind).toBe('group');
    const presentation = buildActivityGroupPresentation(renderItems[0].kind === 'group' ? renderItems[0].parts : []);
    expect(presentation.state).toBe('done');
  });

  it('canonicalizes subagent state updates as parent subagent tool calls', () => {
    processCurrent({
      type: 'state_update',
      stateId: 'subagent:sa-state',
      text: 'Analyzing project',
      state: 'doing',
      kind: 'agent_team',
      metadata: {
        toolCallId: 'sa-state',
        subAgentInvocationId: 'sa-state',
        agentName: 'Explore',
        description: 'Analyzing project',
      },
      timestamp: 1,
    } as any);

    const parts = store.getPartsForHandle(currentHandle) as any[];
    expect(parts.length).toBe(1);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'sa-state',
      toolName: 'agent',
      state: 'doing',
      text: 'Analyzing project',
    }));
    expect(parts[0].metadata).toEqual(jasmine.objectContaining({
      subAgentInvocationId: 'sa-state',
      toolSpecificData: jasmine.objectContaining({
        kind: 'subagent',
        agentName: 'Explore',
        description: 'Analyzing project',
      }),
    }));
  });

  it('maps scoped subagent child stream to first-class scoped parts without mutating childItems', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa1',
      subAgentInvocationId: 'sa1',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    } as any);

    processCurrent({
      type: 'thinking_delta',
      text: 'Inspecting ',
      timestamp: 2,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);
    processCurrent({
      type: 'thinking_delta',
      text: 'files',
      timestamp: 3,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);
    processCurrent({
      type: 'thinking_complete',
      timestamp: 4,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);
    processCurrent({
      type: 'markdown_delta',
      text: 'Found ',
      timestamp: 5,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);
    processCurrent({
      type: 'markdown_delta',
      text: 'candidate paths',
      timestamp: 6,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'child1',
      toolName: 'search_files',
      input: { query: 'generator' },
      timestamp: 7,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);
    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'child1',
      toolName: 'search_files',
      resultText: '3 matches',
      durationMs: 12,
      state: 'done',
      isError: false,
      timestamp: 8,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    } as any);

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(4);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'sa1',
      metadata: jasmine.objectContaining({
        subAgentInvocationId: 'sa1',
      }),
    }));
    expect((parts[0] as any).metadata.toolSpecificData.childItems).toBeUndefined();
    expect(parts[1]).toEqual(jasmine.objectContaining({
      type: 'thinking',
      content: 'Inspecting files',
      isComplete: true,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    }));
    expect(parts[2]).toEqual(jasmine.objectContaining({
      type: 'markdown',
      content: 'Found candidate paths',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
    }));
    expect(parts[3]).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'child1',
      state: 'done',
      text: '3 matches',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa1',
      parentToolCallId: 'sa1',
      metadata: jasmine.objectContaining({
        subAgentInvocationId: 'sa1',
        parentToolCallId: 'sa1',
      }),
    }));
  });

  it('should handle background task update', () => {
    processCurrent({
      type: 'background_task_update',
      taskId: 'task-1',
      stateId: 'bg-task-1',
      description: 'Building project',
      state: 'doing',
      progress: 50,
      timestamp: 1,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0].type).toBe('state');
    expect((parts[0] as any).kind).toBe('background_task');
    expect((parts[0] as any).progress).toBe(50);
  });

  it('projects todo updates as dedicated todo activity state', () => {
    processCurrent({
      type: 'todo_update',
      sessionId: 'sess-1',
      summary: 'Todo list updated: 2 items (0 completed, 2 remaining). Current: "收口 input part band"',
      items: [
        { id: 1, title: '收口 input part band', status: 'in-progress' },
        { id: 2, title: '对齐 todo transcript 标题', status: 'not-started' },
      ],
      timestamp: 1,
    } as any);

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0].type).toBe('state');
    expect((parts[0] as any).kind).toBe('todo');
    expect((parts[0] as any).state).toBe('doing');
    expect((parts[0] as any).text).toContain('Todo list updated');
    expect((parts[0] as any).metadata.timeline.length).toBe(1);
    expect((parts[0] as any).metadata.timeline[0].phaseLabel).toBe('开始 收口 input part band');

    processCurrent({
      type: 'todo_update',
      sessionId: 'sess-1',
      summary: 'Todo list updated: 2 items (1 completed, 1 remaining). Current: "对齐 todo transcript 标题"',
      items: [
        { id: 1, title: '收口 input part band', status: 'completed' },
        { id: 2, title: '对齐 todo transcript 标题', status: 'in-progress' },
      ],
      timestamp: 2,
    } as any);

    const nextParts = store.getPartsForHandle(currentHandle);
    expect((nextParts[0] as any).metadata.timeline.length).toBe(2);
    expect((nextParts[0] as any).metadata.timeline[1].activeTitle).toBe('对齐 todo transcript 标题');
    expect((nextParts[0] as any).metadata.timeline[1].phaseLabel).toBe('完成 收口 input part band');
    expect((nextParts[0] as any).metadata.timeline[1].phaseDetail).toBe('切换到 对齐 todo transcript 标题');
  });

  it('projects todo updates with missing items as an empty canonical todo state', () => {
    expect(() => processCurrent({
      type: 'todo_update',
      sessionId: 'sess-empty',
      summary: 'Todo list updated',
      timestamp: 1,
    } as any)).not.toThrow();

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts[0]).toEqual(jasmine.objectContaining({
      type: 'state',
      kind: 'todo',
      state: 'info',
      text: 'Todo list updated',
    }));
    expect((parts[0] as any).metadata).toEqual(jasmine.objectContaining({
      totalCount: 0,
      completedCount: 0,
      currentStep: 0,
      items: [],
    }));
  });

  it('patches the latest todo tool call with todoList-style toolSpecificData on todo updates', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'todo-tool-1',
      toolName: 'todo_write_tool',
      input: { operation: 'add' },
      timestamp: 1,
    } as any);

    processCurrent({
      type: 'todo_update',
      sessionId: 'sess-tools',
      summary: 'Todo list updated: 1 items (0 completed, 1 remaining). Current: "补齐 toolSpecificData"',
      items: [
        { id: 1, title: '补齐 toolSpecificData', status: 'in-progress' },
      ],
      timestamp: 2,
    } as any);

    const parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata.toolSpecificData).toEqual(jasmine.objectContaining({
      kind: 'todoList',
      summary: 'Todo list updated: 1 items (0 completed, 1 remaining). Current: "补齐 toolSpecificData"',
      currentTask: '补齐 toolSpecificData',
      todoList: [
        jasmine.objectContaining({ id: '1', title: '补齐 toolSpecificData', status: 'in-progress' }),
      ],
    }));
  });

  it('should return false for lifecycle events', () => {
    expect(processCurrent({ type: 'turn_begin', turnId: 't1', timestamp: 1 } as RenderEvent)).toBe(false);
    expect(processCurrent({ type: 'turn_end', turnId: 't1', reason: 'end_turn', timestamp: 2 } as RenderEvent)).toBe(false);
    expect(store.getPartsForHandle(currentHandle).length).toBe(0);
  });

  it('should ignore events when msgIndex not set', () => {
    const adapter2 = new RenderEventPartAdapter(store);
    // no current handle configured
    const result = adapter2.process({ type: 'markdown_delta', text: 'Hello', timestamp: 1 }, null);
    expect(result).toBe(false);
    adapter2.dispose();
  });

  it('should handle interleaved markdown and thinking', () => {
    processCurrent({ type: 'thinking_delta', text: 'Analyzing...', timestamp: 1 });
    processCurrent({ type: 'thinking_complete', timestamp: 2 });
    processCurrent({ type: 'markdown_delta', text: 'Here is the result', timestamp: 3 });

    const parts = store.getPartsForHandle(currentHandle);
    expect(parts.length).toBe(2);
    expect(parts[0].type).toBe('thinking');
    expect(parts[1].type).toBe('markdown');
  });

  it('keeps tool call updates on the originating handle after current handle advances', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-shift',
      toolName: 'readFile',
      input: { path: '/test.ts' },
      timestamp: 1,
    });

    const originalHandle = currentHandle;
    const advancedHandle = store.createDetachedHandle('shift-1');
    currentHandle = advancedHandle;

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-shift',
      data: 'still running',
      timestamp: 2,
    } as RenderEvent);
    processCurrent({
      type: 'tool_call_end',
      toolCallId: 'tc-shift',
      toolName: 'readFile',
      resultText: 'File read successfully',
      durationMs: 100,
      state: 'done',
      isError: false,
      timestamp: 3,
    });

    expect(store.getPartsForHandle(originalHandle)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'tc-shift',
        state: 'done',
        text: 'File read successfully',
      }),
    ]);
    expect(store.getPartsForHandle(advancedHandle)).toEqual([]);
  });

  it('projects structured tool progress updates onto the live tool_call part', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-progress',
      toolName: 'read_file',
      input: { filePath: 'src/app/main.ts' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-progress',
      data: {
        message: 'Reading file',
        detail: 'src/app/main.ts',
        statusText: 'running',
        progress: 42,
      },
      timestamp: 2,
    } as RenderEvent);

    expect(store.getPartsForHandle(currentHandle)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'tc-progress',
        toolName: 'read_file',
        state: 'doing',
        text: 'Reading file',
        metadata: jasmine.objectContaining({
          toolName: 'read_file',
          phase: 'progress',
          progress: 42,
          timeline: [jasmine.objectContaining({
            recordId: 'tc-progress:progress',
            phase: 'progress',
            summary: 'Reading file',
            progress: 42,
            progressDetails: jasmine.objectContaining({
              message: 'Reading file',
              detail: 'src/app/main.ts',
              statusText: 'running',
              progress: 42,
            }),
            timestamp: 2,
          })],
        }),
      }),
    ]);
  });

  it('preserves editor operation phases as bounded tool invocation progress state', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-editor-op',
      toolName: 'syncAbs',
      input: { action: 'import' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-editor-op',
      data: {
        kind: 'editor_operation',
        operationId: 'op-1',
        operationKind: 'blockly.syncAbs.import',
        phase: 'queued',
        label: 'Import ABS',
        summary: 'Import ABS queued',
        queueSize: 2,
        running: true,
      },
      timestamp: 2,
    } as RenderEvent);

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-editor-op',
      data: {
        kind: 'editor_operation',
        operationId: 'op-1',
        operationKind: 'blockly.syncAbs.import',
        phase: 'completed',
        label: 'Import ABS',
        summary: 'Import ABS completed',
        durationMs: 1250,
        running: false,
      },
      timestamp: 3,
    } as RenderEvent);

    expect(store.getPartsForHandle(currentHandle)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'tc-editor-op',
        state: 'done',
        text: 'Import ABS completed',
        metadata: jasmine.objectContaining({
          toolName: 'syncAbs',
          phase: 'completed',
          progressKind: 'editor_operation',
          operationId: 'op-1',
          operationKind: 'blockly.syncAbs.import',
          operationLabel: 'Import ABS',
          durationMs: 1250,
          running: false,
        }),
      }),
    ]);
    const metadata = (store.getPartsForHandle(currentHandle)[0] as any).metadata;
    expect(metadata.toolSpecificData).toBeUndefined();
    expect(metadata.timeline).toBeUndefined();
    expect(metadata.queueSize).toBeUndefined();
  });

  it('maps cancelled editor operations to a terminal warn state', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-editor-op-cancel',
      toolName: 'syncAbs',
      input: { action: 'import' },
      timestamp: 1,
    });

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-editor-op-cancel',
      data: {
        kind: 'editor_operation',
        operationId: 'op-cancel',
        operationKind: 'blockly.syncAbs.import',
        phase: 'started',
        label: 'Import ABS',
        summary: 'Import ABS started',
        running: true,
      },
      timestamp: 2,
    } as RenderEvent);

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-editor-op-cancel',
      data: {
        kind: 'editor_operation',
        operationId: 'op-cancel',
        operationKind: 'blockly.syncAbs.import',
        phase: 'cancelled',
        label: 'Import ABS',
        summary: 'Import ABS cancelled',
        running: false,
      },
      timestamp: 3,
    } as RenderEvent);

    expect(store.getPartsForHandle(currentHandle)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'tc-editor-op-cancel',
        state: 'warn',
        text: 'Import ABS cancelled',
        metadata: jasmine.objectContaining({
          toolName: 'syncAbs',
          phase: 'cancelled',
          progressKind: 'editor_operation',
          operationId: 'op-cancel',
          operationKind: 'blockly.syncAbs.import',
          operationLabel: 'Import ABS',
          running: false,
        }),
      }),
    ]);
    const metadata = (store.getPartsForHandle(currentHandle)[0] as any).metadata;
    expect(metadata.toolSpecificData).toBeUndefined();
    expect(metadata.timeline).toBeUndefined();
  });

  it('keeps command output progress on the originating tool handle after current handle advances', () => {
    processCurrent({
      type: 'tool_call_begin',
      toolCallId: 'tc-command-shift',
      toolName: 'command_exec',
      input: { command: 'npm test' },
      timestamp: 1,
    });

    const originalHandle = currentHandle;
    const advancedHandle = store.createDetachedHandle('shift-command');
    currentHandle = advancedHandle;

    processCurrent({
      type: 'tool_call_progress',
      toolCallId: 'tc-command-shift',
      data: {
        kind: 'command_output',
        toolName: 'command_exec',
        command: 'npm test',
        stream: 'stdout',
        text: 'line 1\n',
        processId: 'process-1',
        outputSessionId: 'output-1',
        bytesTotal: 7,
      },
      timestamp: 2,
    } as RenderEvent);

    expect(store.getPartsForHandle(originalHandle)).toEqual([
      jasmine.objectContaining({
        type: 'terminal',
        command: 'npm test',
        output: 'line 1\n',
        processId: 'process-1',
        outputSessionId: 'output-1',
        isRunning: true,
      }),
    ]);
    expect(store.getPartsForHandle(advancedHandle)).toEqual([]);
  });

  it('keeps subagent activity and completion on the originating handle after current handle advances', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-shift',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    });

    const originalHandle = currentHandle;
    const advancedHandle = store.createDetachedHandle('shift-2');
    currentHandle = advancedHandle;

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-shift',
      activityKind: 'tool_started',
      toolName: 'grep',
      childToolCallId: 'child-shift',
      content: 'Searching...',
      timestamp: 2,
    });
    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa-shift',
      agentName: 'Explore',
      resultText: 'Found matches',
      state: 'done',
      durationMs: 500,
      timestamp: 3,
    });

    expect(store.getPartsForHandle(originalHandle)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'sa-shift',
        state: 'done',
        metadata: jasmine.objectContaining({
          toolSpecificData: jasmine.objectContaining({
            result: 'Found matches',
          }),
        }),
      }),
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'child-shift',
        state: 'done',
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-shift',
        parentToolCallId: 'sa-shift',
      }),
    ]);
    expect(store.getPartsForHandle(advancedHandle)).toEqual([]);
  });

  it('keeps subagent child-item updates on the originating handle after current handle advances', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-child-shift',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    });

    const originalHandle = currentHandle;
    const advancedHandle = store.createDetachedHandle('shift-3');
    currentHandle = advancedHandle;

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-child-shift',
      activityKind: 'tool_started',
      toolName: 'grep',
      childToolCallId: 'child-keep',
      content: 'Searching...',
      timestamp: 2,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-child-shift',
      activityKind: 'tool_completed',
      toolName: 'grep',
      childToolCallId: 'child-keep',
      content: 'Done',
      durationMs: 1500,
      timestamp: 3,
    });

    expect(store.getPartsForHandle(originalHandle)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'sa-child-shift',
        metadata: jasmine.objectContaining({
          toolSpecificData: jasmine.objectContaining({}),
        }),
      }),
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'child-keep',
        text: 'Done',
        state: 'done',
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-child-shift',
        parentToolCallId: 'sa-child-shift',
      }),
    ]);
    expect(store.getPartsForHandle(advancedHandle)).toEqual([]);
  });

  it('keeps a completed child tool result when the next child tool starts', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-multi-child',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    });

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-multi-child',
      activityKind: 'tool_started',
      toolName: 'read_file',
      childToolCallId: 'child-first',
      content: '',
      argsSummary: 'src/app/main.ts',
      timestamp: 2,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-multi-child',
      activityKind: 'tool_completed',
      toolName: 'read_file',
      childToolCallId: 'child-first',
      content: 'file contents',
      durationMs: 200,
      timestamp: 3,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-multi-child',
      activityKind: 'tool_started',
      toolName: 'grep_search',
      childToolCallId: 'child-second',
      content: '',
      argsSummary: 'ToolDisplayRegistry',
      timestamp: 4,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata.toolSpecificData.childItems).toBeUndefined();
    expect(parts.slice(1)).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'child-first',
        toolName: 'read_file',
        args: 'src/app/main.ts',
        text: 'file contents',
        state: 'done',
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-multi-child',
        parentToolCallId: 'sa-multi-child',
      }),
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'child-second',
        toolName: 'grep_search',
        args: 'ToolDisplayRegistry',
        text: 'grep_search',
        state: 'doing',
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-multi-child',
        parentToolCallId: 'sa-multi-child',
      }),
    ]);
  });

  it('projects subagent activity child tools into the parent subagent render group', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-render-group',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    });

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-render-group',
      activityKind: 'tool_started',
      toolName: 'read_file',
      childToolCallId: 'child-render-read',
      content: '',
      argsSummary: 'src/app/main.ts',
      timestamp: 2,
    });

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-render-group',
      activityKind: 'tool_completed',
      toolName: 'read_file',
      childToolCallId: 'child-render-read',
      content: 'file contents',
      durationMs: 200,
      timestamp: 3,
    });

    processCurrent({
      type: 'subagent_end',
      toolCallId: 'sa-render-group',
      agentName: 'Explore',
      resultText: 'Found files',
      state: 'done',
      durationMs: 300,
      timestamp: 4,
    });

    const renderItems = buildChatRenderItems(store.getPartsForHandle(currentHandle), false);

    expect(renderItems.length).toBe(1);
    expect(renderItems[0].kind).toBe('group');
    expect(renderItems[0].kind === 'group' ? renderItems[0].parts.map(part => part.type) : []).toEqual([
      'tool_call',
      'tool_call',
    ]);
    expect(renderItems[0].kind === 'group' ? renderItems[0].parts[0] : null).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'sa-render-group',
      toolName: 'agent',
    }));
    expect(renderItems[0].kind === 'group' ? renderItems[0].parts[1] : null).toEqual(jasmine.objectContaining({
      type: 'tool_call',
      toolCallId: 'child-render-read',
      sourceAgentRole: 'subagent',
      subAgentInvocationId: 'sa-render-group',
      parentToolCallId: 'sa-render-group',
    }));
  });

  it('ensures a parent subagent response item before projecting child activity', () => {
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-child-first',
      activityKind: 'tool_started',
      toolName: 'read_file',
      childToolCallId: 'child-before-parent',
      content: '',
      argsSummary: 'src/app/main.ts',
      timestamp: 1,
    });

    let parts = store.getPartsForHandle(currentHandle);
    expect(parts).toEqual([
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'sa-child-first',
        toolName: 'agent',
        state: 'doing',
        metadata: jasmine.objectContaining({
          toolSpecificData: jasmine.objectContaining({ kind: 'subagent' }),
        }),
      }),
      jasmine.objectContaining({
        type: 'tool_call',
        toolCallId: 'child-before-parent',
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-child-first',
        parentToolCallId: 'sa-child-first',
      }),
    ]);

    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-child-first',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 2,
    });

    parts = store.getPartsForHandle(currentHandle);
    expect(parts.filter(part => part.type === 'tool_call' && part.toolCallId === 'sa-child-first').length).toBe(1);

    const renderItems = buildChatRenderItems(parts, true);
    expect(renderItems.length).toBe(1);
    expect(renderItems[0].kind).toBe('group');
    expect(renderItems[0].kind === 'group' ? renderItems[0].parts : []).toEqual(parts);
  });

  it('coalesces consecutive subagent thinking and text chunks into single child items', () => {
    processCurrent({
      type: 'subagent_begin',
      toolCallId: 'sa-coalesce',
      agentName: 'Explore',
      description: 'Searching codebase',
      timestamp: 1,
    });

    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-coalesce',
      activityKind: 'thinking',
      content: 'Let',
      timestamp: 2,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-coalesce',
      activityKind: 'thinking',
      content: ' me think',
      timestamp: 3,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-coalesce',
      activityKind: 'text',
      content: 'Hello',
      timestamp: 4,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-coalesce',
      activityKind: 'text',
      content: ' world',
      timestamp: 5,
    });
    processCurrent({
      type: 'subagent_activity',
      toolCallId: 'sa-coalesce',
      activityKind: 'text',
      content: '',
      timestamp: 6,
    });

    const parts = store.getPartsForHandle(currentHandle);
    expect((parts[0] as any).metadata.toolSpecificData.childItems).toBeUndefined();
    expect(parts.slice(1)).toEqual([
      jasmine.objectContaining({
        type: 'thinking',
        content: 'Let me think',
        isComplete: true,
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-coalesce',
        parentToolCallId: 'sa-coalesce',
      }),
      jasmine.objectContaining({
        type: 'markdown',
        content: 'Hello world',
        sourceAgentRole: 'subagent',
        subAgentInvocationId: 'sa-coalesce',
        parentToolCallId: 'sa-coalesce',
      }),
    ]);
  });

  function processCurrent(event: RenderEvent): boolean {
    return adapter.process(event, currentHandle);
  }
});
