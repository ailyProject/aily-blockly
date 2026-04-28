// 确保文件被识别为模块，以支持 declare global
export {};

/**
 * 全局方法：打开 aily-chat 面板并发送消息（推荐用于按钮触发场景）
 *
 * 标准接口：当用户点击某处，需代为向大模型发送消息时，统一使用此方法。
 * 它会确保 aily-chat 面板已打开，再注入消息文本（可选自动发送）。
 * 此方法由 UiService.init() 注册，使用前需确保主窗口已初始化。
 *
 * @param text 要发送的文本内容
 * @param options 发送选项。建议传 { autoSend: true } 以自动触发发送
 *
 * @example
 * // 最常见用法：打开对话框并自动触发发送
 * window.openAndSendToAilyChat('生成项目连线图', { autoSend: true });
 *
 * // 只填入输入框，让用户手动确认
 * window.openAndSendToAilyChat('帮我分析这段代码');
 */
declare global {
  interface Window {
    openAndSendToAilyChat: (text: string, options?: Record<string, any>) => void;
  }
}

// openAndSendToAilyChat 由 UiService.init() 注册（确保可用时机正确）
// 这里提供一个占位，避免在 UiService 初始化前调用时报错
if (!window.openAndSendToAilyChat) {
  window.openAndSendToAilyChat = function (text: string, options?: Record<string, any>): void {
    console.warn('openAndSendToAilyChat: UiService 尚未初始化');
  };
}
