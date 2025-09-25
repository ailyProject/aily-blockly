import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// 导入全局聊天工具，注册全局方法
import './app/utils/global-chat.utils';

// Monaco Editor configuration
// 完全禁用WebWorker以避免加载和通信错误
// 提供一个假的Worker对象来避免null引用错误
(self as any).MonacoEnvironment = {
  getWorker: function (workerId: string, label: string) {
    // 返回一个假的Worker对象，避免null引用错误
    return {
      postMessage: () => {}, // 空函数
      onmessage: null,
      onerror: null,
      terminate: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    };
  }
};

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
