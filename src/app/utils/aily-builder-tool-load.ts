const PREFIX = '[AILY_TOOL_LOAD_FAILURE] ';

export function parseToolLoadFailure(line: string): 'TOOL_LOAD_PYTHON_DLL' | 'TOOL_LOAD_XTENSA_CONFIG' | undefined {
  if (!line.startsWith(PREFIX) || line.length > 4096) return undefined;

  try {
    const value = JSON.parse(line.slice(PREFIX.length));
    if (value?.version === 1 && (value.code === 'TOOL_LOAD_PYTHON_DLL' || value.code === 'TOOL_LOAD_XTENSA_CONFIG')) {
      return value.code;
    }
  } catch { /* Keep unrecognized diagnostics in the ordinary output. */ }
  return undefined;
}
