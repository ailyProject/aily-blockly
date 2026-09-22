# 开发人员须知  

## 软件框架
软件主体使用electron开发，渲染端使用angular开发  

## 开发&&打包  

**依赖安装**
```
git clone https://github.com/ailyProject/aily-blockly.git
cd aily-blockly
npm i
cd electron
npm i
```  

**开发环境配置**

- 支持 Windows x64、macOS ARM64。其他架构在资源补齐前会明确报错。
- 开发启动和 E2E 会按 `electron/child-resources.lock.json` 从 `https://dl.aily.pro/child/` 下载当前平台的 Node、7z、rg、probe-rs，并校验 SHA-256。
- `npm run electron:coder` 还会准备 `child/aily-coder-editor.tgz` 和 `.json`，供编辑器首次安装使用。
- 原始资源缓存于 `.aily/child-cache`；缓存校验通过后无需联网。归档准备到 `child/windows` 或 `child/macos`，7z/rg 同时准备到 `child` 根目录，随后启动时解压组件。
- 可运行 `npm run prepare:child` 提前准备资源；`npm run prepare:child -- --platform darwin --arch arm64 --dry-run` 只查看目标资源。`setup:external-tools` 使用同一入口。


**electron运行**
```
npm run electron
```

**electron打包**
```
npm run build
```
打包需要开启windows的开发者模式
打包后生成的安装包在路径为dist\aily-blockly

所有打包入口共用 `afterPack` hook，按目标平台和架构从同一缓存准备资源到产物的 `resources/child`。下载或校验失败会终止打包，安装包继续内置工具。`npm run build:coder` 额外下载编辑器的 `.tgz` 和 `.json` 配对文件；Coder 开发与打包共用这套编辑器资源。

当前 macOS 仅支持 ARM64；打包可使用 `npm run build -- --mac --arm64`。现有 `build:mac`（同时包含 x64）及 `build:mac:universal` 在缺少对应资源时会失败。


## 相关目录

### /child  
内为程序必须的组件：
1. node：程序使用npm和node进行包管理和执行必要脚本，该npm中添加了npmrc文件，用以指向到aily blockly仓库
2. 7za/7zz：为了减少部分包的大小，我们使用7z极限压缩来降低部分包（如编译器）的大小
3. rg、probe-rs：文本搜索和硬件调试工具

`child/scripts` 源码继续随 Git 和安装包发布；aily-builder、linter、connector 继续通过 npm 管理。

### /build  
该部分是安装/卸载程序的脚本。
在安装应用时，安装程序会将`child\node-v22.19.0-win-x64.7z`解压到`child\node`。  

### /src/app/blockly/plugins
blockly相关插件

### /src/app/blockly/custom-field
自定义的特殊block
