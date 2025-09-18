import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// 导入全局聊天工具，注册全局方法
import './app/utils/global-chat.utils';

// Monaco Editor configuration
self.MonacoEnvironment = {
  getWorkerUrl: function (moduleId, label) {
    if (label === 'json') {
      return './assets/vs/language/json/json.worker.js';
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      return './assets/vs/language/css/css.worker.js';
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return './assets/vs/language/html/html.worker.js';
    }
    if (label === 'typescript' || label === 'javascript') {
      return './assets/vs/language/typescript/ts.worker.js';
    }
    return './assets/vs/editor/editor.worker.js';
  }
};

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
