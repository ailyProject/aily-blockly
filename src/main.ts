import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// 导入全局聊天工具，注册全局方法
import './app/utils/global-chat.utils';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
