/**
 * 跨领域通知数据契约。
 *
 * 这里只描述数据，不包含展示、日志或 Angular 生命周期；具体渲染仍由
 * core/app-shell 的 NoticeService 负责。
 */
export interface NoticeOptions {
  title?: string;
  text?: string;
  state?: string;
  showProgress?: boolean;
  progress?: number;
  setTimeout?: number;
  stop?: Function;
  detail?: string;
  showDetail?: boolean;
  timestamp?: number;
  sendToLog?: boolean;
  closable?: boolean;
  icon?: string;
  isCancellationNotice?: boolean;
  /** 错误通知上的“重试”动作，例如 Aily Code npm install 失败后再执行一次。 */
  onRetry?: () => void;
}
