export interface AppendOnlyContentBuffer {
  materialized: string;
  pendingChunks: string[];
  length: number;
}

export function createAppendOnlyContentBuffer(content: string): AppendOnlyContentBuffer {
  return {
    materialized: content,
    pendingChunks: [],
    length: content.length,
  };
}

export function appendToContentBuffer(buffer: AppendOnlyContentBuffer, delta: string): void {
  if (!delta) {
    return;
  }
  buffer.pendingChunks.push(delta);
  buffer.length += delta.length;
}

export function materializeContentBuffer(buffer: AppendOnlyContentBuffer): string {
  if (buffer.pendingChunks.length === 0) {
    return buffer.materialized;
  }

  const appended = buffer.pendingChunks.length === 1
    ? buffer.pendingChunks[0]
    : buffer.pendingChunks.join('');
  buffer.materialized += appended;
  buffer.pendingChunks.length = 0;
  return buffer.materialized;
}

export function readContentBufferWindow(
  buffer: AppendOnlyContentBuffer,
  maxChars: number,
  omittedMarker = '',
): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || buffer.length <= maxChars) {
    return materializeContentBuffer(buffer);
  }

  const tailLength = Math.max(0, Math.floor(maxChars) - omittedMarker.length);
  if (tailLength <= 0) {
    return omittedMarker;
  }

  const segments: string[] = [];
  let remaining = tailLength;
  for (let index = buffer.pendingChunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = buffer.pendingChunks[index] || '';
    if (chunk.length <= remaining) {
      segments.push(chunk);
      remaining -= chunk.length;
    } else {
      segments.push(chunk.slice(chunk.length - remaining));
      remaining = 0;
    }
  }
  if (remaining > 0) {
    const start = Math.max(0, buffer.materialized.length - remaining);
    segments.push(buffer.materialized.slice(start));
  }
  segments.reverse();
  return `${omittedMarker}${segments.join('')}`;
}
