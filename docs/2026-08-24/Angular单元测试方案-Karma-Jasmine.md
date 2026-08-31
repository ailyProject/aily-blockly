# Angular 单元测试方案（保留 Karma + Jasmine）

状态：待评审

日期：2026-08-24

范围：`/Users/downey/Projects/OutSource/aily--blockly` 的 Angular 代码（`src/**`）

本文只定义测试方案，不修改依赖、构建配置或业务代码。Node/Electron 测试和 Playwright E2E 保持现有技术栈，不迁入 Karma。

配套文档：[`Angular services 目录重构方案`](./Angular-services目录重构方案.md)。测试基础设施应作为独立 PR 先落地，不与目录移动或 facade 拆分混在一起。

## 1. 结论

当前阶段保留 Karma + Jasmine，不引入 Jest、Vitest 或其他 Angular 单测框架。先修复现有测试链的完整性，再逐步补测试：

1. 恢复一套最小且唯一的 Angular Karma test target；
2. 保留 Jasmine 相关依赖，补齐唯一的 `tsconfig.spec.json`；
3. 单测与源码共置，统一使用 `*.spec.ts`；
4. 修正 `.gitignore`，确保新单测能被 Git 跟踪；
5. 本地默认 watch，提交前和 CI 使用 ChromeHeadless 单次执行；
6. Karma 只测浏览器内的纯逻辑、Angular DI、组件与边界适配；真实 Electron、文件系统、进程、串口、BLE 和端到端流程继续由 Node 测试或 Playwright 覆盖；
7. 覆盖率先报告、后门禁，不用一次性补齐历史代码拖慢当前重构。

不建议恢复多套 feature-specific `tsconfig.*.spec.json`。所有 Angular 单测共用一个 test target 和一个 `tsconfig.spec.json`，局部执行使用 `--include`，避免配置文件和脚本持续膨胀。

### 为什么当前阶段保留 Karma + Jasmine

保留的理由不是“仓库已经有大量 Karma 测试资产”——当前仓库实际没有可提交的 Angular spec。当前选择主要基于：

1. Angular CLI 19.2 已提供原生 Karma builder、TestBed 入口、测试发现和 coverage 集成；
2. 仓库旧基线已经使用这组依赖和 `ng test --include` 命令习惯，恢复闭环的改动面较小；
3. services 目录重构正在进行，此时同时迁移测试 runner 会把目录、业务契约和测试基础设施三类风险混在一起；
4. Karma + Jasmine 足以先保护浏览器内 Angular DI、Zone.js 异步和现有组件行为；
5. 这是当前周期的稳定选择，不排除以后在测试资产稳定后独立评估 runner 迁移。

## 2. 当前现状与问题

### 2.1 已确认现状

| 项目 | 当前状态 |
| --- | --- |
| Angular | `19.x`，本机安装的 build-angular 为 `19.2.24` |
| 单测框架基线 | Git 基线中曾声明 Karma `6.4`、Jasmine `5.4` |
| 当前工作区 | `package.json`、`package-lock.json` 和 `angular.json` 正在移除 Karma/Jasmine 与 test target |
| Angular 单测文件 | `src/**` 下没有可见或被 Git 跟踪的 `*.spec.ts` |
| 测试 TypeScript 配置 | `tsconfig.spec.json` 不存在 |
| 测试入口 | 基线 test target 指向 `src/test.ts`，但该文件不存在 |
| Git 跟踪 | `.gitignore` 全局忽略 `**/*.spec.ts`，只有 `e2e/tests/**/*.spec.ts` 被放行 |
| 代码生成 | component、directive、service 的 schematic 都配置了 `skipTests: true` |
| 测试脚本 | 基线存在若干聚焦 `ng test --include ...` 脚本，但脚本引用的 spec/config 文件没有进入当前仓库 |
| 业务规模 | `src/app` 约有 77 个 `@Injectable`、79 个 `*.service.ts` 和 83 个组件，尚无 Angular 单测基线 |

### 2.2 根因

当前不是简单的“少几个依赖”，而是测试链没有形成可提交、可复现的闭环：

```text
开发者编写 *.spec.ts
        ↓
.gitignore 默认忽略
        ↓
测试文件留在个人机器，其他开发者和 CI 不可见
        ↓
package scripts / angular.json 引用不存在的入口或配置
        ↓
ng test 无法成为稳定的团队命令
```

因此，只恢复 Karma/Jasmine 依赖不能解决问题。依赖、Angular target、TypeScript 配置、Git 跟踪规则、命令和首批示例测试必须在同一个基础设施 PR 中一起落地。

## 3. 目标与非目标

### 3.1 目标

- 新开发者执行一次依赖安装后即可运行单测；
- IDE 能识别 `describe`、`it`、`expect` 和 Jasmine 类型；
- 本地可以 watch 全量或聚焦单文件；
- CI 可以无交互、无 Electron、无开发服务器地稳定执行；
- 测试文件随源码移动，不建立另一棵容易失同步的镜像目录；
- 服务目录重构前能先补特征测试，移动后原测试继续通过；
- 测试生成物、缓存和报告不进入 Git；
- 不要求首个 PR 为全部历史服务补测试。

### 3.2 非目标

- 本阶段不迁移到 Jest/Vitest；
- 不用 Karma 启动真实 Electron 或访问宿主 IPC；
- 不用单测替代 Playwright E2E、真实编译/烧录、登录或子进程验收；
- 不在基础设施 PR 中重构现有服务；
- 不为每个业务域创建一套 Karma 配置或 TypeScript 配置；
- 不在测试中读取开发者的真实配置、凭据、工程文件或本地设备。

## 4. 测试分层与技术边界

| 层级 | 运行器 | 适合内容 | 禁止或转移内容 |
| --- | --- | --- | --- |
| U0 纯逻辑单测 | Karma + Jasmine | policy、parser、normalizer、状态转换、路径/参数映射、兼容转换 | 不使用 `TestBed`，不访问 DOM/网络/磁盘 |
| U1 Angular DI 单测 | Karma + Jasmine + `TestBed` | service、guard、pipe、provider、Observable 状态 | Electron、真实 HTTP、真实 localStorage 用户数据必须替换 |
| U2 轻量组件单测 | Karma + Jasmine | 输入输出、事件、条件渲染、表单/交互状态 | 不做像素级视觉验收，不启动完整应用 |
| C 边界契约测试 | Karma 或现有 Node test | IPC payload、host snapshot、序列化/反序列化、超时/错误映射 | 浏览器端只测 adapter；真实进程由 Node/E2E 测 |
| E2E 运行态验收 | Playwright / 现有脚本 | Electron、子应用、工程、编译、登录、设备流程 | 不计入 Angular unit coverage |

判定规则：如果测试必须启动 Electron、子进程、真实服务器、文件系统、串口、BLE 或登录账号，它就不是 Karma 单元测试。

## 5. 目录与命名规范

### 5.1 单测与源码共置

推荐：

```text
src/app/services/domains/project/
├── project.service.ts
├── project.service.spec.ts
├── project-activation.ts
└── project-activation.spec.ts
```

不推荐：

```text
tests/unit/app/domains/project/project.service.spec.ts
```

共置可以让测试跟随当前 services 目录重构一起移动，减少路径镜像失配和大范围 import 修改。

### 5.2 共享测试工具

只在出现至少两个真实复用方后，才放入统一目录：

```text
src/testing/
├── fakes/          # Electron、host bridge、storage 等稳定 fake
├── fixtures/       # 小型、脱敏、确定性的测试数据
├── harnesses/      # 组件测试 harness
└── helpers/        # 与业务无关的测试辅助函数
```

约束：

- 生产代码禁止 import `src/testing/**`；
- feature 私有 fixture 优先与 spec 同目录，不先进入全局目录；
- fixture 不复制真实用户配置、token、工程目录或大体积 ABI；
- Angular 单测只使用 `*.spec.ts`，不要与 Node 侧的 `*.test.ts` 混用。

## 6. 推荐基础配置

以下为实施 PR 的配置草案，不在本方案文档中直接应用。

### 6.1 开发依赖

PR-UT0 先恢复仓库旧 lockfile 基线中的直接开发依赖，避免在“恢复测试链”的同时升级 runner：

```json
{
  "devDependencies": {
    "@types/jasmine": "~5.1.0",
    "jasmine-core": "~5.4.0",
    "karma": "~6.4.0",
    "karma-chrome-launcher": "~3.2.0",
    "karma-coverage": "~2.2.0",
    "karma-jasmine": "~5.1.0",
    "karma-jasmine-html-reporter": "~2.1.0"
  }
}
```

其中 `jasmine-core ~5.4.0` 是仓库旧基线，不是 Angular CLI 19.2.24 当前 schematic 的推荐值；本机 19.2.24 schematic 使用 `~5.6.0`。恢复后如需对齐 5.6，应另开依赖升级 PR。PR-UT0 必须同步提交 `package.json` 和 `package-lock.json`，不手改 lockfile，使用项目约定的 npm 命令生成。

### 6.2 `tsconfig.spec.json`

仓库只保留一份 Angular 单测 TypeScript 配置：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./out-tsc/spec",
    "types": ["jasmine", "node"]
  },
  "include": [
    "src/**/*.spec.ts",
    "src/**/*.d.ts"
  ],
  "exclude": []
}
```

这里显式覆盖根 `tsconfig.json` 中对 `**/*.spec.ts` 的排除。保留 `node` 类型是迁移期兼容措施，因为当前 Angular 源码已经依赖 Node 类型；它不表示 Karma 可以访问真实 Node/Electron 能力。后续若能消除浏览器代码中的 Node 全局，再单独收紧。

### 6.3 `angular.json` test target

建议使用 Angular 19 自带的 Karma 配置，不新增 `karma.conf.js`，先减少配置面：

```json
{
  "test": {
    "builder": "@angular-devkit/build-angular:karma",
    "options": {
      "tsConfig": "tsconfig.spec.json",
      "polyfills": [
        "zone.js",
        "zone.js/testing"
      ],
      "inlineStyleLanguage": "scss",
      "preserveSymlinks": true,
      "builderMode": "application",
      "include": [
        "**/*.spec.ts"
      ],
      "assets": [],
      "styles": [],
      "scripts": []
    }
  }
}
```

说明：

- 不配置 `main: src/test.ts`。当前 Angular 19 builder 在没有 `main` 时会生成内置测试入口，避免维护一个空的全局 bootstrap；
- 不重复写 `main`，也不引用不存在的 `src/test.ts`；
- `builderMode: application` 与当前项目的 application builder 对齐；
- `preserveSymlinks: true` 与应用构建一致，降低本地链接 child package 时出现重复依赖解析的风险；
- 默认不加载 `public`、工具 i18n 或完整全局样式。单测应注入 fake loader，组件视觉效果交给 E2E；
- 如果后续确实需要全局初始化，再新增唯一的 `src/testing/setup.ts` 并由明确入口导入，不在多个 spec 重复打补丁。

### 6.4 `.gitignore`

保留现有全局忽略规则：

```gitignore
**/*.spec.ts
```

紧接着增加唯一、明确的 Angular 单测放行规则：

```gitignore
!/src/**/*.spec.ts
```

同时保留生成物忽略：

```gitignore
/coverage
/out-tsc
/.angular/cache
/test-results
/playwright-report
```

这样只允许 `src/**/*.spec.ts` 被跟踪，不会意外放行其他临时 spec。E2E 的 `*.spec.ts` 继续由现有例外规则管理。

### 6.5 Angular schematic

当前 `angular.json` 对 component、directive、service 都设置了 `skipTests: true`。PR-UT0 先保持该默认值，避免自动产生只有 `should be created` 的空壳 spec。需要为新 service 同时创建单测时显式执行：

```bash
npx ng generate service services/domains/example/example --skip-tests=false
```

生成的模板必须在提交前替换为有行为价值的断言；如果该文件没有可测试逻辑，则删除空壳 spec。待团队形成稳定的 service/component 测试模板后，再单独评审是否改变 schematic 默认值。

## 7. 统一命令

`package.json` 建议只提供少量稳定入口：

```json
{
  "scripts": {
    "test": "ng test",
    "test:unit": "ng test",
    "test:unit:ci": "ng test --watch=false --browsers=ChromeHeadless",
    "test:unit:coverage": "ng test --watch=false --browsers=ChromeHeadless --code-coverage"
  }
}
```

日常使用：

```bash
# 开发时 watch 全量单测
npm run test:unit

# 聚焦单个文件；参数继续传给 ng test
npm run test:unit -- --include src/app/services/example.service.spec.ts

# 聚焦一个目录
npm run test:unit -- --include src/app/services/domains/project

# 提交前无交互执行
npm run test:unit:ci

# 生成覆盖率报告
npm run test:unit:coverage
```

不要为每个临时 feature 增加一个 `test:xxx` 脚本或 `tsconfig.xxx.spec.json`。只有稳定、长期用于 CI 的契约套件才允许增加别名，而且底层仍调用同一 test target。

## 8. 编写规范

### 8.1 测试结构

每个测试聚焦一个可观察行为：

```ts
describe('resolveUploadDispatch', () => {
  it('routes a BLE board to the BLE uploader', () => {
    const result = resolveUploadDispatch({ transport: 'ble' });

    expect(result).toEqual({ uploader: 'ble' });
  });
});
```

优先使用 Given / When / Then 的内容结构，不强制注释。测试名描述行为和结果，不复述方法名。

### 8.2 测试替身

- 纯函数直接调用，不启动 `TestBed`；
- Angular service 使用最小 provider 集合，不导入完整 `AppModule`；
- HTTP 使用 Angular testing provider，不发真实请求；
- Electron、host bridge、child process、storage、clipboard、serial、BLE 使用显式 fake/spy；
- 时间逻辑使用 `fakeAsync/tick` 或 Jasmine clock，并在用例后恢复；
- 每个 spec 自己创建状态，不依赖上一个 spec 的执行顺序；
- 不使用开发者本地 `localStorage`、`~/Library`、环境变量或登录态；
- 不用 `NO_ERRORS_SCHEMA` 大面积吞掉模板错误，优先导入必要 standalone 依赖或提供小型 stub。

### 8.3 提交约束

禁止提交：

- `fdescribe`、`fit`；
- 无说明的 `xdescribe`、`xit`、`pending()`；
- 只断言“能创建”的空壳测试；
- 真实 token、账号、用户路径、工程内容和设备标识；
- 超大 snapshot 或从生产数据直接复制的 fixture；
- 为了通过测试而在生产代码中加入仅测试使用的分支。

建议增加轻量 guard，在 CI 中扫描 focused/pending Jasmine API；这类 guard 不启动浏览器，失败信息也更直接。

## 9. 首批覆盖范围

不要按文件数量平均补测试。结合现有 services 重构，优先覆盖“纯逻辑、高风险契约、即将移动”的代码。

### P0：基础设施验收样例（固定 5 个 spec）

PR-UT0 使用当前真实源码路径：

1. `src/app/services/domains/device/policies/upload-dispatch-policy.spec.ts`；
2. `src/app/services/domains/device/policies/upload-recovery-policy.spec.ts`；
3. `src/app/services/core/auth/operations/service-region-switch.spec.ts`；
4. `src/app/services/domains/project/coder/coder-board-resolution.spec.ts`；
5. `src/app/services/core/preferences/theme.service.spec.ts`。

前四个覆盖纯函数和异步调用顺序；`theme.service.spec.ts` 使用最小 `TestBed`、fake `ConfigService`、DOM 和 IPC 边界替身，验证 Angular DI、signal/Observable 和边界 fake。目的不是提高总覆盖率，而是证明基础链和两种主要测试形态能稳定执行。

### P1：目录迁移特征测试

每个 services 迁移 PR：

- 移动前先为关键公开行为补特征测试；
- spec 与源码在同一个 commit 中移动；
- 只改 import 路径，不顺手重写断言；
- 目录移动前后使用同一命令通过；
- 对高扇入 facade 保留原 public contract 测试。

优先对象：

- `ProjectService` 的工程生命周期和旧数据兼容；
- `AuthService` 的 token-free snapshot、失效和 fail-closed 投影；
- `ConfigService` 的区域/配置解析；
- `ChildToolProcessService` 的 acquire/release 引用计数和恢复策略；
- `ConnectionGraphService` 的持久化格式和校验；
- compile/upload policy 的取消与错误映射。

### P2：新功能与缺陷修复

- 新增纯逻辑必须有 U0；
- 新增 service 分支必须有 U1；
- 缺陷修复先添加能复现问题的 spec，再修实现；
- 涉及 Electron/真实运行态时，单测保护 adapter 契约，同时保留对应 Node/E2E 验收。

## 10. CI 与覆盖率策略

### 阶段 A：先保证可执行

基础设施 PR 的必过项：

```bash
npm ci
npm run test:unit:ci
npm run test:unit:ci -- --include src/app/services/domains/device/policies/upload-dispatch-policy.spec.ts
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development
git diff --check
```

单测不依赖 `npm start`、`npm run electron`、端口 4200 或个人 Chrome 会话。CI 使用 Karma 启动自己的 ChromeHeadless。

执行环境需要可用的 Chrome/Chromium。macOS 开发机使用正常安装的 Chrome；CI 镜像应显式提供浏览器，并在路径非标准时设置 `CHROME_BIN`。如果 CI 容器确实无法使用 Chrome sandbox，只把 CI 命令切换为 Angular 内置的 `ChromeHeadlessNoSandbox`，不要因此复制一套本地 Karma 配置。

当前仓库没有发现承载 Angular unit job 的 CI workflow。若团队使用 GitHub Actions，PR-UT0 新增 `.github/workflows/angular-unit.yml`，至少在 pull request 和目标分支 push 时使用 Node 22.x、`npm ci` 和 `npm run test:unit:ci`；如果实际使用外部 CI，PR 描述必须给出对应 pipeline 配置路径和 job 名，不能只新增 npm script 就宣称 CI 已接入。

### 阶段 B：报告覆盖率，不阻塞

首批测试落地后生成：

- 控制台 text summary；
- `coverage/aily-blockly` HTML；
- CI artifact（若 CI 平台支持）。

历史项目初始覆盖率低时，不直接设置 80% 全局门禁，否则团队会通过排除文件或空壳测试绕过规则。

### 阶段 C：增量门禁

稳定运行一段时间后再引入唯一的 `karma.conf` 或覆盖率检查脚本：

1. 基线不得下降；
2. 新增的纯逻辑和 bugfix 必须有对应 spec；
3. 先对新目录/已重构目录设阈值，再逐步扩大；
4. 阈值只上调，不因单次 PR 临时下调；
5. E2E 覆盖不冒充 unit coverage。

## 11. 实施 PR 切分

### PR-UT0：恢复测试基础设施

#### 落地前置条件

当前工作树同时存在 Aily Chat 旧代码清理、services alias/architecture 等未提交改动。PR-UT0 不直接从这个 dirty tree 混合提交：

1. 先让现有清理/重构改动独立提交、暂存或移出工作树；
2. 从团队确认的干净 commit 创建 UT0 分支，并在 PR 描述记录 base SHA；
3. 旧的 feature-specific `test:aily-chat-*` 脚本和缺失 spec/config 由前置清理决定去留；UT0 不复活指向已删除代码的脚本；
4. 提交前用 `git diff --name-only <base-sha>...HEAD` 对照下面的文件白名单。

#### 文件白名单

PR-UT0 只允许修改或新增：

- `.gitignore`；
- `angular.json`；
- `package.json`；
- `package-lock.json`；
- `tsconfig.spec.json`；
- `develop.md`（增加安装、watch、聚焦和提交前命令）；
- `.github/workflows/angular-unit.yml`（使用 GitHub Actions 时）；
- 本文 P0 列出的 5 个 `*.spec.ts`。

除非独立评审确认，PR-UT0 不修改 `tsconfig.json`、任何生产 `*.ts`、Electron 脚本、services architecture guard 或 E2E 配置。

只做：

- 保留/恢复 Karma + Jasmine 依赖并同步 lockfile；
- 恢复最小 test target；
- 新增唯一 `tsconfig.spec.json`；
- 修正 `.gitignore`；
- 增加统一 npm scripts；
- 添加固定 5 个无业务修改的示例/特征 spec；
- 更新 `develop.md`；
- 接入或明确真实 CI unit job。

不做：

- services 目录迁移；
- 业务逻辑重构；
- 全项目覆盖率补齐；
- 新测试框架迁移；
- Electron/E2E 改造。

### PR-UT1：测试辅助层

只有在首批 spec 出现真实重复后才做：

- 提取稳定 fakes；
- 增加 focused test guard；
- 统一少量 fixture builders；
- 清理 feature-specific 测试配置和失效脚本。

### 后续 PR：随业务渐进补齐

- 目录重构 PR 带对应特征测试；
- bugfix PR 带回归测试；
- 新功能 PR 带新增分支测试；
- 覆盖率基线在稳定后独立启用，不混入大规模目录迁移。

## 12. 验收标准

### 基础设施

- 全新 checkout 执行 `npm ci` 后可直接运行 `npm run test:unit:ci`；
- 不需要手工创建 `src/test.ts`、私有 tsconfig 或本地 spec；
- 按需使用 `--skip-tests=false` 生成同目录 spec，现有 service 不批量生成空壳文件；
- `git status` 能显示新建的 `src/**/*.spec.ts`；
- IDE 无 Jasmine 全局类型报错；
- macOS 开发环境和 CI 的 ChromeHeadless 都能退出且返回正确 exit code；
- `coverage/`、`out-tsc/`、`.angular/cache` 不进入 Git。

### 开发体验

- watch 模式修改源码或 spec 后能自动重跑；
- `--include` 能聚焦单文件或目录；
- 单元测试失败不要求启动 Electron 或本地开发服务；
- 测试错误能定位到 spec/源码，而不是缺入口、缺类型或配置文件；
- 不再新增 feature-specific `tsconfig.*.spec.json`。

### 项目整洁度

- 源码旁只保留有行为价值的 spec；
- 共享 fake/fixture 有真实复用方，不形成新的“大杂烩 testing 目录”；
- Karma、Node test、Playwright 的职责清楚，命名不混用；
- 方案实施与 services 目录重构分 PR，便于 review 和回退；
- 当前 Electron、构建、E2E 脚本不因恢复单测而改变执行语义。

## 13. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 恢复依赖后 lockfile 变化较大 | 使用当前 npm 版本重建，仅提交与依赖恢复相关的 lockfile diff |
| 单测意外加载真实 Electron/Node API | 把边界放在 provider/adapter，Karma 中注入 fake；真实侧留给 Node/E2E |
| 全局样式/资产拖慢测试 | test target 默认不加载，按具体 spec 提供最小依赖 |
| services 重构导致大量 spec import 变化 | spec 与源码共置并一起移动，跨领域只测 public facade |
| 初始覆盖率太低 | 先报告后门禁，优先高风险和将重构代码 |
| focused test 被提交 | 增加 `fdescribe`/`fit`/pending guard |
| watch 与 CI 行为不同 | 两者使用同一 target；CI 只增加 `--watch=false --browsers=ChromeHeadless` |
| CI 找不到或无法启动 Chrome | CI 镜像显式安装浏览器并按需设置 `CHROME_BIN`；只有受限容器使用 `ChromeHeadlessNoSandbox` |
| Karma 配置逐渐分裂 | 只允许一个 test target、一个 `tsconfig.spec.json`，局部测试统一用 `--include` |

## 14. 建议决策

建议批准以下决定后再开 PR-UT0：

1. 当前周期继续使用 Karma + Jasmine；
2. Angular 单测统一与源码共置并允许 Git 跟踪；
3. 使用 Angular 19 内置 Karma 配置，不先新增 `karma.conf.js`；
4. 所有 Angular 单测共用一个 `tsconfig.spec.json`；
5. 真实 Electron/Node/设备流程不进入 Karma；
6. 覆盖率先报告，待基础设施稳定后再设增量门禁；
7. PR-UT0 与 services 目录重构、业务修改分开提交。
