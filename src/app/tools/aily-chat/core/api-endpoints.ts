/**
 * Aily Chat 内部 API 端点定义
 *
 * 替代对外部 `../../../configs/api.config` 的直接 import。
 * 所有端点通过 AilyHost.get().config.apiEndpoint 动态获取基地址。
 */

import { AilyHost } from './host';

function base(): string {
  return AilyHost.get().config.apiEndpoint;
}

export const ChatAPI = {
  get startSession()  { return `${base()}/api/v1/start_session`; },
  get closeSession()  { return `${base()}/api/v1/close_session`; },
  get streamConnect() { return `${base()}/api/v1/stream`; },
  get sendMessage()   { return `${base()}/api/v1/send_message`; },
  get chatRequest()   { return `${base()}/api/v1/chat`; },
  get contextInfo()   { return `${base()}/api/v1/context_info`; },
  get getHistory()    { return `${base()}/api/v1/conversation_history`; },
  get stopSession()   { return `${base()}/api/v1/stop_session`; },
  get cancelTask()    { return `${base()}/api/v1/cancel_task`; },
  get generateTitle() { return `${base()}/api/v1/generate_title`; },
  get conversationFeedback() { return `${base()}/api/v1/conversation_feedback`; },
};
