# Overview

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [README.md](README.md)
- [README_ZH.md](README_ZH.md)
- [angular.json](angular.json)
- [build/installer.nsh](build/installer.nsh)
- [develop.md](develop.md)
- [electron/main.js](electron/main.js)
- [electron/package-lock.json](electron/package-lock.json)
- [electron/package.json](electron/package.json)
- [electron/preload.js](electron/preload.js)
- [electron/window.js](electron/window.js)
- [img/home.webp](img/home.webp)
- [package-lock.json](package-lock.json)
- [package.json](package.json)
- [src/app/app.component.html](src/app/app.component.html)
- [src/app/app.component.scss](src/app/app.component.scss)
- [src/app/app.component.ts](src/app/app.component.ts)
- [src/app/app.config.ts](src/app/app.config.ts)
- [src/app/components/inner-window/inner-window.component.html](src/app/components/inner-window/inner-window.component.html)
- [src/app/components/inner-window/inner-window.component.ts](src/app/components/inner-window/inner-window.component.ts)
- [src/app/services/electron.service.ts](src/app/services/electron.service.ts)
- [src/app/services/iwindow.service.ts](src/app/services/iwindow.service.ts)
- [src/app/tools/ffs-manager/components/\_summary-panel.scss](src/app/tools/ffs-manager/components/_summary-panel.scss)
- [src/index.html](src/index.html)
- [src/styles.scss](src/styles.scss)

</details>

## Purpose and Scope

Aily Blockly is an AI-enhanced visual programming IDE designed specifically for hardware development. It provides a comprehensive development environment that combines visual programming through Google Blockly with traditional hardware development workflows including compilation, device flashing, and debugging [README.md:5-12](). The system serves as a bridge between visual programming and professional embedded development, targeting both educational users and professional developers working with microcontrollers and development boards [README.md:13-15]().

## High-Level Architecture

Aily Blockly follows a desktop application architecture built on Electron, providing cross-platform compatibility while maintaining native system access for hardware development tools [package.json:232-233]().

### Application Architecture Overview

The following diagram illustrates the interaction between the Electron Main process and the Angular Renderer process, mediated by the Preload bridge.

```mermaid
graph TB
    subgraph \"Desktop Application (Electron)\"
        subgraph \"Main Process [electron/main.js]\"
            MAIN[\"main.js\"]
            IPC_HANDLERS[\"IPC Handlers\"]
            WIN_POOL[\"subWindowPool\"]
            PROJ_LOCK[\"project-lock.js\"]
        end

        subgraph \"Renderer Process (Angular)\"
            APP_COMP[\"AppComponent\"]
            ELEC_SERV[\"ElectronService\"]
            CONFIG_SERV[\"ConfigService\"]
            THEME_SERV[\"ThemeService\"]
        end

        subgraph \"Preload Bridge [electron/preload.js]\"
            PRELOAD[\"preload.js\"]
            ELECTRON_API[\"window.electronAPI\"]
        end
    end

    subgraph \"Native Layer\"
        SERIAL[\"SerialPort\"]
        PTY[\"node-pty\"]
        FS[\"File System\"]
    end

    MAIN --> IPC_HANDLERS
    IPC_HANDLERS --> WIN_POOL
    IPC_HANDLERS --> PROJ_LOCK

    PRELOAD --> ELECTRON_API
    ELECTRON_API -.->|\"IPC Bridge\"| ELEC_SERV

    APP_COMP --> ELEC_SERV
    ELEC_SERV --> FS
    ELEC_SERV --> SERIAL
    ELEC_SERV --> PTY
```

Sources: [electron/main.js:5-9](), [electron/preload.js:12-17](), [src/app/services/electron.service.ts:6-25](), [src/app/app.component.ts:40-58]()

### Technology Stack and Dependencies

The application leverages a modern web technology stack combined with native desktop capabilities:

- **Core Frameworks**: Electron 35 [package.json:232]() and Angular 19 [package.json:162-170]().
- **Visual Programming**: Blockly 11.2 [package.json:190]() with advanced plugins like `workspace-minimap` [package.json:173]() and `block-dynamic-connection` [package.json:171]().
- **Hardware Interaction**: `serialport` [electron/package-lock.json:19]() and `esptool-js` [package.json:194]().
- **System Integration**: `@lydell/node-pty` for terminal emulation [package.json:175]() and `electron-win-state` for window management [electron/main.js:4]().
- **UI Components**: `ng-zorro-antd` [package.json:208]() and `mermaid` for AI-generated diagrams [package.json:206]().

Sources: [package.json:161-222](), [electron/package-lock.json:12-20]()

## Core System Components

### Multi-Instance and User Data Management

Aily Blockly implements a sophisticated user data management system to support multiple instances while maintaining performance. It uses an **Instance Directory Reuse Pool** to recycle `userData` paths [electron/main.js:194-201]().

| Component          | Function                                                   | Implementation                                           |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| **Instance Pool**  | Manages `instance-N` directories under `instances/`        | `setupPooledUserDataPath()` [electron/main.js:194-250]() |
| **Cache Cleaning** | Removes `GPUCache` and `Code Cache` to prevent slow starts | `clearSlowCaches()` [electron/main.js:176-188]()         |
| **OAuth Routing**  | Routes OAuth callbacks to the correct initiating instance  | `findOAuthInstance()` [electron/main.js:107-145]()       |

Sources: [electron/main.js:176-250]()

### Sub-Window Pool System

To improve UI responsiveness, the application maintains a background pool of pre-initialized hidden windows.

```mermaid
graph LR
    subgraph \"Sub-Window Management [electron/window.js]\"
        POOL[\"subWindowPool (Array)\"]
        SIZE[\"SUB_WINDOW_POOL_SIZE = 2\"]
        REPLENISH[\"replenishSubWindowPool()\"]
        POP[\"removePoolHandlersFromWin()\"]
    end

    subgraph \"Renderer Requests\"
        INVOKE[\"ipcRenderer.invoke('open-new-instance')\"]
    end

    INVOKE --> POP
    POP --> REPLENISH
    REPLENISH --> POOL
```

Sources: [electron/window.js:11-13]() [electron/window.js:52-128]()

## Visual Programming Integration

The Blockly integration is highly customized for hardware logic. It uses a custom SCSS-based styling system that integrates with the application's global themes [src/styles.scss:172-272]().

- **Z-Index Management**: Blockly's `blocklyWidgetDiv` and `blocklyDropDownDiv` are forced to `9999` to ensure they appear below Angular overlays (CDK containers) [src/styles.scss:172-188]().
- **UI Customization**: Custom CSS variables like `--aily-blockly-text-primary` are used to sync blockly colors with the IDE theme [src/styles.scss:177]().

Sources: [src/styles.scss:172-272]()

## Hardware Development Pipeline

The system provides a complete hardware development pipeline from visual blocks to deployed firmware:

1.  **Project Initialization**: Projects are managed as npm packages, ensuring isolated versions of boards and libraries [README.md:14-16]().
2.  **Code Generation**: Visual blocks are converted to native code (C++/MicroPython) [README.md:26-30]().
3.  **Compilation**: Uses a \"Lightning Compilation Tool\" (Edge-cloud collaboration) to reduce build times [README.md:35-37]().
4.  **Deployment**: Supports serial flashing via `esptool-js` [package.json:194]() and debugger interaction via `probe-rs` [README.md:68]().

Sources: [README.md:13-43](), [package.json:194]()

## Build and Deployment System

The application uses `electron-builder` for multi-platform distribution [package.json:154]().

| Feature             | Implementation                                                                  |
| ------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| **Installer**       | NSIS-based with custom macros for cleaning old instances and extracting tools   | [build/installer.nsh:6-30]()  |
| **Tool Extraction** | Extracts `node`, `aily-builder`, and `probe-rs` from 7z archives during install | [build/installer.nsh:32-67]() |
| **Signatures**      | Windows code signing provided via SignPath                                      | [README_ZH.md:100-103]()      |

Sources: [package.json:83-147](), [build/installer.nsh:1-106]()
