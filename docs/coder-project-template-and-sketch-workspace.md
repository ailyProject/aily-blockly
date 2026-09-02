# Coder 项目创建与 sketch 工作区契约

> 当前实现基线：2026-08-26。

## 1. 新建项目

Blockly 与 Coder 共用 `boards.json`、主板搜索、版本选择和使用次数排序。只有当配置显式包含 `"coder": { "enabled": true }` 时，新建表单才显示 Blockly / Coder 项目类型选择；`coder` 配置缺失、`enabled` 缺失或值不为 `true` 时隐藏该选择并默认创建 Blockly 项目。两种类型都不再选择 Coder 专用硬件平台。

- Blockly：复制所选 `@aily-project/board-*` 包的 `template/`。
- Coder：优先复制同一主板包 `template_arduino/` 下的 `package.json`，并将源码模板 `project.aci` 复制为 `sketch/src/main.cpp`。如果主板包没有 `template_arduino/`，则以其 `template/package.json` 为配置基线，并生成最基础的 Arduino `sketch/src/main.cpp`。

主板包可提供专用 Coder 模板：

```text
@aily-project/board-xxx/
├── template/
└── template_arduino/
    ├── package.json
    └── project.aci          # Arduino 源码模板，不是 JSON 配置
```

`template_arduino/package.json` 是 Coder 工程配置模板，工程类型、入口、框架、主板及依赖信息都保存在复制后的根 `package.json`。`template_arduino/project.aci` 只作为 Arduino 源码模板，保持原始内容并复制为 `sketch/src/main.cpp`，不会生成根 `.aci` 文件。若 `template_arduino/` 整体不存在，宿主会回退读取同一主板的 `template/package.json`，并写入仅含 `Arduino.h`、空 `setup()` 和空 `loop()` 的基础源码；若专用目录存在但文件不完整，仍按无效模板报错。为兼容已发布的旧主板包，宿主仍可识别历史误拼写目录 `template_arrduino/`，新包统一使用 `template_arduino/`。

## 2. 创建后的目录

```text
project-root/
├── package.json
├── sketch/                  # 持久化编译工作区
│   ├── src/                 # 直接编辑的源码
│   │   └── main.cpp
│   ├── libraries/           # 项目本地 Arduino 库及库物化结果
│   ├── build-config.json    # 构建时生成，可重建
│   ├── preprocess.json      # 预处理结果，可重建
│   ├── library-cache.json   # 库指纹缓存，可重建
│   └── upload-config.json   # 上传时生成，可重建
├── node_modules/
└── .build/                  # 编译产物
```

`package.json.entry` 相对 `sketch/`，默认值为 `src/main.cpp`；磁盘文件因此是 `sketch/src/main.cpp`。

## 3. 编译与清理边界

Coder 的 preprocess、compile 和 upload 直接使用 `sketch/`，不再把根目录源码复制到 `.temp/sketch`。`sketch/src` 与 `sketch/libraries` 是项目内容，清缓存时必须保留；只清理 `.build` 和 `sketch` 下可重建的 JSON 配置/缓存。

Blockly 的 `.temp/sketch`、`.temp/libraries` 和 package 快照保持原行为。

## 4. 旧项目迁移

旧 Coder 项目需在打开新版前完成一次目录迁移：

1. 将根 `src/` 移到 `sketch/src/`。
2. 将根 `components/` 移到 `sketch/libraries/`。
3. 将旧 `project.aci` 的工程配置迁入 `package.json`，并保持 `package.json.entry` 为相对 `sketch/` 的值，例如 `src/main.cpp`。
4. 删除旧 Coder `.temp/` 后重新构建。

宿主不会自动删除或覆盖旧目录，避免在无法判断用户自有文件时做破坏性迁移。
