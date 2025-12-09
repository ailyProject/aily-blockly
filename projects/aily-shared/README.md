# Aily Shared 共享组件库

这是 Aily Blockly 项目的共享组件库，包含可在多个应用（如主应用和 serial-monitor-app）之间共享的组件、服务、管道和工具函数。

## 目录结构

```
projects/aily-shared/
├── src/
│   ├── lib/
│   │   ├── components/     # 共享组件
│   │   │   ├── sub-window/
│   │   │   └── index.ts
│   │   ├── services/       # 共享服务
│   │   ├── pipes/          # 共享管道
│   │   ├── directives/     # 共享指令
│   │   ├── utils/          # 工具函数
│   │   └── types/          # 类型定义
│   └── public-api.ts       # 公共 API 入口
├── ng-package.json
└── package.json
```

## 使用方法

### 在其他项目中导入

```typescript
// 导入组件
import { SubWindowComponent } from 'aily-shared';

// 导入类型
import { WindowOpts, IMenuItem } from 'aily-shared';

@Component({
  imports: [SubWindowComponent],
  // ...
})
export class YourComponent {}
```

### 添加新组件到共享库

1. 在 `src/lib/components/` 下创建组件文件夹
2. 在 `src/lib/components/index.ts` 中导出组件
3. 组件会自动通过 `public-api.ts` 对外暴露

## 开发

### 构建库

```bash
ng build aily-shared
```

### 监听模式构建

```bash
ng build aily-shared --watch
```

## 代码生成

使用 Angular CLI 生成新组件：

```bash
ng generate component component-name --project=aily-shared
```


## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
