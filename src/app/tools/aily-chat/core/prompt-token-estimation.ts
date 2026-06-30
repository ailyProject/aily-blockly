/**
 * Fast prompt/message token estimation helpers.
 *
 * These heuristics stay on the active path because budget trimming still
 * needs cheap O(1) estimates, but they are no longer tied to any blockly
 * prompt assembly pipeline.
 */

/**
 * 用 O(1) 字符长度估算单条消息 token 数。
 *
 * 这是预算/裁剪启发式，不承担最终 prompt 组装语义。
 */
export function fastEstimateMessageTokens(msg: any): number {
  let chars = 4;
  if (msg.content) chars += msg.content.length;
  if (msg.name) chars += msg.name.length;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      chars += 4;
      if (tc.id) chars += tc.id.length;
      if (tc.function?.name) chars += tc.function.name.length;
      if (tc.function?.arguments) {
        chars += typeof tc.function.arguments === 'string'
          ? tc.function.arguments.length
          : JSON.stringify(tc.function.arguments).length;
      }
    }
  }
  return Math.ceil(chars * 0.4);
}

/**
 * 用 O(1) 字符长度估算消息数组 token 数。
 */
export function fastEstimateMessagesTokens(messages: any[]): number {
  if (!messages || messages.length === 0) return 0;
  let total = 2;
  for (const msg of messages) total += fastEstimateMessageTokens(msg);
  return total;
}