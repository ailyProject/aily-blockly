import {
  extractHistoricalDialogCopyText,
  preprocessHistoricalDialogContent,
} from './x-dialog-compat-content';

describe('x-dialog historical compatibility helpers', () => {
  it('preprocesses historical markdown-first content outside the component', () => {
    const processed = preprocessHistoricalDialogContent(
      '[thinking...]<final_answer>\n[to_fileOperationAgent] 已处理<toolResult>secret</toolResult><info>debug</info>\n</final_answer>',
    );

    expect(processed).toContain('😁 已处理');
    expect(processed).not.toContain('[thinking...]');
    expect(processed).not.toContain('<toolResult>');
    expect(processed).not.toContain('<info>');
    expect(processed).not.toContain('<final_answer>');
  });

  it('extracts copy text without leaking historical thinking placeholders', () => {
    const text = extractHistoricalDialogCopyText(
      '[thinking...]<think>分析\n步骤</think>\n'
      + '{"type":"tool_call_request","tool_id":"tool-1","tool_name":"run_in_terminal","tool_args":"{\\"command\\":\\"npm test --watch false\\"}"}\n'
      + '{"type":"ToolCallExecutionEvent","content":[{"call_id":"tool-1","is_error":false}]}\n'
      + '最终答案',
    );

    expect(text).toContain('> [思考]');
    expect(text).toContain('✓ run_in_terminal  npm test --watch');
    expect(text).toContain('最终答案');
    expect(text).not.toContain('[thinking...]');
  });
});