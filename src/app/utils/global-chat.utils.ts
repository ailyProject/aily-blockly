import { ChatCommunicationService, ChatTextOptions } from '../services/chat-communication.service';

/**
 * 全局方法：发送文本到聊天组件
 * 这个方法会被挂载到 window 对象上，可以在任何地方调用
 * 
 * @param text 要发送的文本内容
 * @param options 发送选项，包含 sender、type、cover 等参数
 *                cover 默认为 true（覆盖模式），设置为 false 则追加内容
 * 
 * @example
 * // 基础调用 - 默认覆盖模式
 * window.sendToAilyChat('帮我生成Arduino代码');
 * 
 * // 明确指定覆盖模式
 * window.sendToAilyChat('新的内容', { cover: true });
 * 
 * // 追加模式 - 不覆盖现有内容
 * window.sendToAilyChat('追加的内容', { cover: false });
 * 
 * // 完整选项
 * window.sendToAilyChat('帮我生成Arduino代码', { 
 *   sender: 'MyScript', 
 *   type: 'help',
 *   cover: true  // 默认值，可以省略
 * });
 */
declare global {
  interface Window {
    sendToAilyChat: (text: string, options?: ChatTextOptions) => void;
  }
}

// 全局函数
window.sendToAilyChat = function(text: string, options?: ChatTextOptions): void {
  ChatCommunicationService.sendToChat(text, options);
};

// 导出全局函数，也可以直接导入使用
export const sendToAilyChat = window.sendToAilyChat;

export default {
  sendToAilyChat
};
