# Vendor 目录说明

此目录包含应用所需的第三方二进制文件。

## Ripgrep

`ripgrep/` 目录包含各平台的 ripgrep 二进制文件,用于高性能文件搜索。

### 目录结构

```
ripgrep/
  ├── x64-win32/        # Windows 64位 (rg.exe)
  ├── ia32-win32/       # Windows 32位 (rg.exe)
  ├── x64-darwin/       # macOS Intel (rg)
  ├── arm64-darwin/     # macOS Apple Silicon (rg)
  └── x64-linux/        # Linux 64位 (rg)
```

### 下载二进制文件

开发者首次设置项目或需要更新 ripgrep 版本时,运行:

```bash
# 下载当前平台
node electron/download-ripgrep.js 1

# 下载所有平台(用于发布)
node electron/download-ripgrep.js 5

# 下载特定平台
node electron/download-ripgrep.js 2  # Windows 平台
node electron/download-ripgrep.js 3  # macOS 平台
node electron/download-ripgrep.js 4  # Linux 平台
```

### 版本信息

- **Ripgrep 版本**: 14.1.0
- **下载源**: https://github.com/BurntSushi/ripgrep

### Git 忽略规则

二进制文件被 `.gitignore` 排除,以减小仓库大小:
- `ripgrep/*/rg` (Unix/macOS)
- `ripgrep/*/rg.exe` (Windows)

目录结构通过 `.gitkeep` 文件保留。

### 应用集成

应用启动时会自动检测并使用对应平台的 ripgrep:

1. 优先使用 bundled 版本 (`electron/vendor/ripgrep/{arch}-{platform}/rg`)
2. 如果 bundled 版本不存在,回退到系统 PATH 中的 ripgrep
3. 如果都不可用,使用纯 TypeScript 搜索(较慢)

### 打包配置

在打包应用时,需确保将对应平台的二进制文件包含在发布包中:

**electron-builder.yml 示例:**
```yaml
files:
  - electron/**/*
  - electron/vendor/ripgrep/**/*

# 特定平台配置
win:
  extraResources:
    - from: electron/vendor/ripgrep/x64-win32
      to: electron/vendor/ripgrep/x64-win32
      filter: ["rg.exe"]

mac:
  extraResources:
    - from: electron/vendor/ripgrep/x64-darwin
      to: electron/vendor/ripgrep/x64-darwin
      filter: ["rg"]
    - from: electron/vendor/ripgrep/arm64-darwin
      to: electron/vendor/ripgrep/arm64-darwin
      filter: ["rg"]

linux:
  extraResources:
    - from: electron/vendor/ripgrep/x64-linux
      to: electron/vendor/ripgrep/x64-linux
      filter: ["rg"]
```

### 许可证

Ripgrep 遵循 MIT/Unlicense 双重许可,与本项目兼容。
详见: https://github.com/BurntSushi/ripgrep/blob/master/UNLICENSE
