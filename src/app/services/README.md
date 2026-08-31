# Angular Services 目录说明

`src/app/services` 是主软件 Angular 应用的服务总边界，用来集中放置跨页面复用、具有应用级生命周期，或代表明确业务领域和外部集成的服务。

页面、组件、editor、tool 不应再建立与本目录平级的全局服务集合；但只服务于单一功能且与其 UI 生命周期绑定的私有服务，仍应与该功能放在一起，例如 `src/app/editors/blockly-editor/services`。

## 目录结构

```text
services/
├── README.md
├── core/                         # 应用运行所需的基础能力
│   ├── app-shell/                # 主窗口、工作流、通知、更新和 UI 编排
│   │   └── public-api.ts
│   ├── auth/                     # 登录会话、鉴权快照和鉴权策略
│   │   ├── bridges/              # 鉴权边界适配
│   │   ├── models/               # 鉴权数据契约
│   │   ├── operations/           # 鉴权用例操作
│   │   ├── policies/             # 鉴权判断规则
│   │   └── public-api.ts
│   ├── platform/                 # Electron、操作系统、命令、日志和资源锁
│   │   ├── observability/        # 性能和可观测能力
│   │   └── public-api.ts
│   └── preferences/              # 配置、设置、主题、语言和区域
│       ├── models/
│       └── public-api.ts
├── domains/                      # 产品业务领域
│   ├── build/                    # 构建、编译、探测和编译前校验
│   │   ├── ports/                # 构建域所需的上层事件接口
│   │   └── public-api.ts
│   ├── dependencies/             # npm、Blockly 库和本地依赖同步
│   │   ├── ports/                # 安装工作流和通知的应用端口
│   │   └── public-api.ts
│   ├── device/                   # 串口、上传、BLE 和设备选择
│   │   ├── policies/             # 上传与恢复策略
│   │   │   └── public-api.ts     # 供集成层使用的窄策略入口
│   │   ├── ports/                # 上传所需 UI/editor/子应用端口
│   │   ├── serial/               # 串口相关纯逻辑
│   │   └── public-api.ts
│   ├── project/                  # 项目生命周期、项目数据和板卡配置
│   │   ├── coder/                # Coder 项目创建和模板适配
│   │   ├── ports/                # 项目所需 UI/editor/依赖端口
│   │   ├── project-data/         # 项目数据读写、迁移和格式契约
│   │   └── public-api.ts
│   └── schematic/                # 原理图连接图、引脚映射和云端连接
│       ├── connection-aws/
│       └── public-api.ts
├── integrations/                 # 外部进程、协议和子应用集成
│   ├── automation/               # AI/MCP/UI 自动化和 Coder Diff 桥接
│   │   ├── coder-diff/
│   │   ├── policies/
│   │   ├── ports/                # UI 和宿主能力的反向依赖接口
│   │   └── public-api.ts
│   ├── simulator/                # 模拟器 iframe 和后台 Agent
│   │   └── public-api.ts
│   └── subapps/                  # 子应用目录、进程租约、宿主桥接和资源生命周期
│       ├── adapters/
│       ├── bootstrap/
│       ├── host-provider/
│       ├── models/
│       ├── operations/
│       ├── policies/
│       ├── ports/                # 子应用所需自动化端口
│       └── public-api.ts
└── shared/                       # 跨两个以上领域复用的无业务归属纯契约和纯逻辑
    ├── models/                   # 跨领域数据契约
    └── public-api.ts
```

`shared` 只接收已经被两个以上领域共同使用、且没有单一业务归属的纯契约或纯逻辑，例如通知数据结构。不要为了“可能复用”提前放入；能明确归属某个领域的类型、策略和工具函数，仍应留在其所属目录。

## 新服务放在哪里

| 服务职责 | 放置位置 | 示例 |
| --- | --- | --- |
| 启动期、应用壳、鉴权、系统环境、全局偏好 | `core/<area>` | 登录会话、Electron、主题 |
| 产品自身的业务规则和数据生命周期 | `domains/<domain>` | 项目、编译、设备、依赖 |
| 外部进程、子应用、iframe、Agent 或协议桥接 | `integrations/<integration>` | 子应用、模拟器、MCP |
| 只被一个页面、editor 或 tool 使用，并依赖其 UI 生命周期 | 跟随对应功能目录 | `editors/blockly-editor/services` |
| domain/integration 需要调用 UI 或 editor 能力 | 在服务所属目录定义 `ports/`，在应用层提供 adapter | Blockly editor、Mermaid 弹窗 |
| 被多个领域复用且确实没有业务归属的纯类型或纯函数 | `shared` | 通用且无状态的契约或工具 |

如果一个服务同时符合多个位置，先确定谁拥有它的数据和生命周期，再由拥有者对外提供契约；不要按“调用它的页面”或文件名来分类。

## Import 规则

页面、组件、editor 和 tool 应通过目标领域的 `public-api.ts` 使用服务：

```ts
import { AuthService } from '@core/auth/public-api';
import { ProjectService } from '@domain/project/public-api';
import { SubappManagerService } from '@integration/subapps/public-api';
```

同一领域内部使用相对路径。新增跨领域引用时，也只能使用目标领域的 `public-api.ts`，不要引用目标领域内部文件：

```ts
// 当前领域内部
import { ProjectDataRuntime } from './project-data/project-data-runtime';

// 跨领域
import { ConfigService } from '@core/preferences/public-api';

// 只需要一个稳定子领域时，可以使用窄入口，避免加载整个领域 barrel
import { UploadRecoveryPolicy } from '@domain/device/policies/public-api';
```

业务领域或集成层需要 UI/editor 能力时，依赖所属目录中定义的 `InjectionToken` port，由 `app.config.ts` 将应用层 adapter 映射进去。不要为了消掉检查结果，把深层引用机械替换成会扩大循环依赖的根 `public-api.ts`。

应用层 adapter 位于 `src/app/integrations/`，不放回 `services` 领域实现中。当前 project、build、dependencies、device、automation 和 subapps 均按该方式完成组合。

禁止新增以下写法：

```ts
// 跨领域深层引用
import { ProjectService } from '@domain/project/project.service';

// 从业务服务反向依赖页面或组件
import { SomeComponent } from '../../../components/some/some.component';
```

每个 `public-api.ts` 只导出其他领域或 UI 真正需要的稳定契约。不要增加全局 `services/index.ts`，也不要通过旧路径 re-export 保留兼容层。

## 新增或调整服务的检查清单

1. 先确定服务的数据、规则和生命周期由哪个目录负责。
2. 只有确实需要应用级单例时才使用 `providedIn: 'root'`；功能私有服务由对应功能提供。
3. 纯类型、纯策略和纯函数不应包装成 Angular Service。
4. 只有出现目录外消费者时，才从所属领域的 `public-api.ts` 导出。
5. domain/integration 需要 UI 能力时，定义窄 port，并在应用组合层实现 adapter。
6. 不新增跨领域深层引用、业务服务到 UI 的反向依赖或循环依赖。
7. 提交前运行架构检查和 TypeScript 检查。

```bash
npm run architecture:services
npx tsc -p tsconfig.app.json --noEmit
```

涉及目录调整时，再生成并检查服务清单：

```bash
npm run architecture:services:inventory
node scripts/check-angular-service-architecture.mjs --write-inventory
```

涉及 Angular 构建链路时，再运行：

```bash
npx ng build --configuration development
```

## 当前架构状态

架构守卫当前记录为 0 条违规、0 个循环依赖组：

| 类型 | 数量 | 含义 |
| --- | ---: | --- |
| `cross-domain-deep-import` | 0 | 跨领域引用均通过公开入口 |
| `domain-ui-import` | 0 | 业务领域不再反向依赖 app-shell、页面或 editor |
| `integration-ui-import` | 0 | 集成层通过 port 使用宿主 UI/editor 能力 |
| 循环依赖组 | 0 | `services` 静态 import 图无强连通循环 |

初始基线为 123 条违规和 1 个循环依赖组，现已全部清零；基线文件因此保存为空数组，不再豁免历史问题。架构检查会直接阻止任何新增的深层跨域引用、UI 反向依赖、根目录散落服务或循环依赖。

这里的“清零”特指目录和静态依赖边界，不代表所有超大 facade 都已经完成业务拆分。`ProjectService`、`AuthService` 等后续如继续按职责拆小，仍需独立契约测试和 Electron 业务回归。

大服务拆分顺序、风险和验收要求见 [Angular services 目录重构方案](../../../docs/2026-08-24/Angular-services目录重构方案.md)。当前服务清单见 [angular-service-inventory.json](../../../docs/2026-08-24/angular-service-inventory.json)。
