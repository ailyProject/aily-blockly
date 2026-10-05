# Blockly 编译与上传变更检测修复

## 行为

- 成功编译后，生成代码、项目宏、生成头文件、项目 `src`、组件库、npm 库源码、板卡配置、分区以及实际固件均一致时，上传不再执行预处理或编译。
- 上述输入变化、固件变化或缺失、没有成功编译记录时，上传先进入原编译流程；`compile.js` 仍对当前请求执行预处理。
- 上传等待已启动的后台预处理完成，并阻止新的后台预处理插入。变更判断只读，不发布头文件或创建 `.build`。
- 生成器先发布其宏配置，再冻结完整编译配置。其他配置变化仍会使请求失效；宏配置在请求写入期间变化也会被拒绝。
- 失败或取消的编译不能沿用此前成功标志。成功样式的输出不能覆盖非零退出码。编译期间再次修改输入时停止上传。
- Coder 继续使用现有磁盘编译与上传路由。

## 实现边界

`compile.js` 在预处理完成后记录项目输入指纹，编译成功且输入未变化时，在 `.build/aily-upload-state.json` 保存输入与固件指纹。预处理完成后的捕获可避免首次解压库源码导致缓存自我失效。新编译开始时删除旧记录。

该记录只服务于普通上传复用，不替代仿真、交付或完整 SDK/工具链来源验证。文件内容使用现有流式指纹实现；构建结果元数据和派生缓存不算项目输入。库发现与预处理共用 `library-packages.js`，保留 Blockly 本地链接库和 Coder 路径隔离规则。

Electron preload 新增只读检查入口，需要完整重启宿主以加载。旧构建没有该记录时会重新编译一次，不依赖空构建目录或内存中的旧成功标志。

## 验证

- Node 定向测试：94/94，通过输入/产物指纹、编译请求、预处理、目录发布、交付以及 Coder/Blockly 工具链和库处理测试。
- Angular 服务测试：34/34，通过预处理等待、取消、切项目、无变化直传、变化后编译、宏首次落盘、配置竞态、失败退出与 Coder 路由测试。
- TypeScript 应用检查、修改文件的 JavaScript 语法检查与 `git diff --check` 通过。
- 使用当前仓库 `compile.js`、已安装 aily-builder 和 AVR 工具链，在隔离临时 Arduino UNO 工程完成三次实际编译：首次 8.9 秒、源码变化后 3.8 秒、宏变化后 1.9 秒。每次成功后只读检查均允许复用；输入变化和删除构建目录均拒绝复用。
- 未执行设备烧录、完整 Electron 按钮交互或 Windows/Linux 实机验收。

服务测试命令：

```sh
node scripts/run-angular.cjs test --watch=false --browsers=ChromeHeadless \
  --ts-config=tsconfig.blockly-interaction.spec.json \
  --include=src/app/editors/blockly-editor/services/builder.service.spec.ts \
  --include=src/app/editors/blockly-editor/services/build-upload-flow.spec.ts --progress=false
```
