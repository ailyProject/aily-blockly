import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NotificationComponent } from '../../components/notification/notification.component';

/**
 * 模型部署路由容器
 * 职责：作为路由出口，根据 URL 加载对应的子组件
 * 
 * 路由结构：
 * - /model-deploy/:modelType/deploy - 部署页面
 * - /model-deploy/:modelType/test - 测试页面
 * 
 * 支持的 modelType:
 * - sscma: SenseCraft AI / Seeed Studio 模型
 * - 未来可扩展: chipintelli, 等
 */
@Component({
  selector: 'app-model-deploy',
  standalone: true,
  imports: [
    RouterOutlet,
    NotificationComponent
  ],
  template: `
    <app-notification></app-notification>
    <router-outlet></router-outlet>
  `,
  styles: []
})
export class ModelDeployComponent { }
