// Read the real tool envelope, never infer a result from assistant prose.
export function collectFirmwareReports(messages) {
  return messages.filter(message => message.role === 'toolResult').flatMap(message => {
    const value = message.details?.data || message.details;
    if (value?.result?.kind === 'aily-firmware-debug-report') return [value.result];
    for (const block of message.content || []) {
      if (block.type !== 'text') continue;
      try {
        const parsed = JSON.parse(block.text);
        if (parsed?.result?.kind === 'aily-firmware-debug-report') return [parsed.result];
      } catch { /* Not all tool responses are JSON. */ }
    }
    return [];
  });
}
