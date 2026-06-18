## Goal

1. 在 UI 中彻底禁用 `@desktop/*`，统一通过 `packages/desktop/index.ts` 收口 desktop 类型入口。
2. 将 `packages/core` 源码迁移到 `packages/core/src/` 下，统一目录规范。

## Constraints

- 保持现有功能与构建通过。
- 优先最小化 API 变化，不扩大 UI / desktop 对 core 的耦合面。
- `core/index.ts` 继续作为 UI 侧统一类型入口。

## Current findings

- UI 代码中已无 `@desktop/*` 实际 import；剩余问题仅是 `packages/ui/tsconfig.json` 仍保留该 path alias。
- UI 当前通过 `@core` 获取：
  - `Router`
  - `BoardIndexItem`
  - `LegacyBoardItem`
  - `LegacyLibraryItem`
- `packages/core` 当前无 `src/` 目录，源码直接位于包根下的 `agent/`, `api/`, `rpc/`, `hardware/`, `project/`, `metadata/`, `document/`, `abi/`, `abs/`, `build/`。
- `packages/core/rslib.config.ts` 的 entry 目前全部指向包根源码目录。
- `packages/core/tsconfig.json` 的 `include` 也直接指向这些包根源码目录。

## Planned steps

1. 删除 UI 中 `@desktop/*` path alias，保留 `@desktop` 根入口。
2. 将 `packages/core` 现有源码目录整体迁移到 `packages/core/src/`。
3. 调整 `packages/core/index.ts` 到 `src/index.ts`，并更新内部相对路径。
4. 更新 `packages/core/rslib.config.ts` entry 到 `src/*`。
5. 更新 `packages/core/tsconfig.json` 的 `include` / `rootDir` 相关配置。
6. 更新依赖方 path alias：
   - `packages/ui/tsconfig.json`
   - `packages/desktop/tsconfig.json`
7. 构建验证：
   - `pnpm --filter core build`
   - `pnpm --filter desktop build`
   - `pnpm --filter ui build`
8. 若声明输出路径因 `src/` 变化而改变，再同步修正 `packages/core/package.json` 的 `exports.types`。

## Status

- 进行中：准备先删除 UI 中的 `@desktop/*` alias，再执行 core 目录迁移。
