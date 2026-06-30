/**
 * aily-chat 模块对外公共 API
 *
 * 外部模块（如 background-agent、blockly-editor、global-chat.utils、float-sider）
 * 应统一从此入口导入，而 ** 不要 ** 直接引用 aily-chat 内部子路径。
 */

// ===== Services =====
export { ChatService } from './services/chat.service';
export type { ChatTextOptions } from './services/chat.service';
export { AilyChatConfigService } from './services/aily-chat-config.service';

// ===== ABI ↔ ABS converter (used by blockly-editor) =====
export {
  convertAbiToAbs,
  convertAbiToAbsWithLineMap,
  convertBlockTreeToAbs,
  convertAbsToAbi,
  validateAbs,
  formatAbs,
} from './tools/abiAbsConverter';
export type { AbiToAbsOptions, AbsToAbiResult } from './tools/abiAbsConverter';
