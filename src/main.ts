import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// 导入全局聊天工具，注册全局方法
import './app/utils/global-chat.utils';

// Monaco Editor configuration
// 不提供worker配置，让Monaco Editor使用fallback模式（主线程模式）
// 这避免了web worker的模块加载问题
(self as any).MonacoEnvironment = {};

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
