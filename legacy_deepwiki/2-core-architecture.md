# Core Architecture

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [build/installer.nsh](build/installer.nsh)
- [electron/config/config.json](electron/config/config.json)
- [electron/main.js](electron/main.js)
- [electron/package-lock.json](electron/package-lock.json)
- [electron/package.json](electron/package.json)
- [electron/preload.js](electron/preload.js)
- [electron/updater.js](electron/updater.js)
- [electron/window.js](electron/window.js)
- [package-lock.json](package-lock.json)
- [package.json](package.json)
- [src/app/app.component.html](src/app/app.component.html)
- [src/app/app.component.scss](src/app/app.component.scss)
- [src/app/app.component.ts](src/app/app.component.ts)
- [src/app/components/inner-window/inner-window.component.html](src/app/components/inner-window/inner-window.component.html)
- [src/app/components/inner-window/inner-window.component.ts](src/app/components/inner-window/inner-window.component.ts)
- [src/app/services/config.service.ts](src/app/services/config.service.ts)
- [src/app/services/electron.service.ts](src/app/services/electron.service.ts)
- [src/app/services/iwindow.service.ts](src/app/services/iwindow.service.ts)
- [src/app/windows/settings/settings.component.html](src/app/windows/settings/settings.component.html)
- [src/app/windows/settings/settings.component.scss](src/app/windows/settings/settings.component.scss)
- [src/app/windows/settings/settings.component.ts](src/app/windows/settings/settings.component.ts)

</details>



This document explains the fundamental architecture of the Aily Blockly desktop application, focusing on the Electron-based process model, Angular frontend integration, and inter-process communication systems.

## Overview

Aily Blockly is built as a hybrid desktop application using Electron as the runtime platform with Angular as the frontend framework. The architecture follows Electron's multi-process model, separating concerns between system-level operations and user interface rendering while maintaining secure communication channels between processes.

```mermaid
graph TB
    subgraph \"Desktop Application\"
        subgraph \"Main Process (Node.js)\"
            MAIN[\"main.js\"]
            PRELOAD[\"preload.js\"]
            IPC_HANDLERS[\"IPC Handlers\"]
            SYSTEM_ACCESS[\"System APIs\"]
        end
        
        subgraph \"Renderer Process (Angular)\"
            APP_COMPONENT[\"AppComponent\"]
            SERVICES[\"Angular Services\"]
            COMPONENTS[\"UI Components\"]
            BLOCKLY_INTEGRATION[\"Blockly Integration\"]
        end
    end
    
    MAIN --> PRELOAD
    PRELOAD --> APP_COMPONENT
    SERVICES --> IPC_HANDLERS
    IPC_HANDLERS --> SYSTEM_ACCESS
    
    APP_COMPONENT --> SERVICES
    SERVICES --> COMPONENTS
    COMPONENTS --> BLOCKLY_INTEGRATION
```

**Sources:** [package.json:1-132](), [electron/main.js:1-100](), [src/app/app.component.ts:1-29]()

## Process Architecture

The application implements Electron's recommended security model with clear separation between the main process (Node.js runtime) and renderer process (web content).

### Electron Main Process
The main process (`electron/main.js`) handles system-level operations including file system access, terminal management, and hardware communication. It manages the application lifecycle and window creation. To optimize performance and multi-instance usage, it implements a **Pooled User Data Path** system that reuses instance directories while clearing slow caches like `GPUCache`.

For details, see [Electron Main Process](#2.1).

**Sources:** [electron/main.js:1-204](), [electron/main.js:194-245]()

### Angular Frontend
The renderer process is an Angular application that handles the UI logic. It is bootstrapped in `src/app/app.component.ts` and interacts with the main process through a secure bridge. It uses a three-pane architecture for the main IDE layout.

For details, see [Angular Frontend](#2.2).

**Sources:** [src/app/app.component.ts:40-58](), [package.json:161-222]()

```mermaid
graph LR
    subgraph \"Main Process Space\"
        MAIN_JS[\"main.js\"]
        WINDOW_JS[\"window.js\"]
        POOL[\"setupPooledUserDataPath()\"]
        IPC_REG[\"registerWindowHandlers()\"]
        
        MAIN_JS --> POOL
        MAIN_JS --> WINDOW_JS
        WINDOW_JS --> IPC_REG
    end
    
    subgraph \"Renderer Process Space\"
        ANGULAR_APP[\"AppComponent\"]
        ELECTRON_SVC[\"ElectronService\"]
        CONFIG_SVC[\"ConfigService\"]
        
        ANGULAR_APP --> ELECTRON_SVC
        ANGULAR_APP --> CONFIG_SVC
    end
    
    subgraph \"Preload Bridge\"
        BRIDGE[\"contextBridge.exposeInMainWorld\"]
        E_API[\"electronAPI\"]
        
        BRIDGE --> E_API
    end
    
    IPC_REG -.->|IPC Channel| E_API
    E_API -.->|window.electronAPI| ELECTRON_SVC
```

## IPC Communication System

Inter-process communication is implemented through Electron's IPC mechanism with a secure preload script (`electron/preload.js`) acting as the communication bridge. The preload script exposes a controlled API surface via `window.electronAPI`.

| Domain | Purpose | Key Code Entity |
|--------|---------|-----------------|
| **Terminal** | PTY shell management | `electronAPI.terminal` |
| **Serial** | Hardware communication | `electronAPI.SerialPort` |
| **Window** | Multi-window control | `electronAPI.subWindow` |
| **Filesystem** | Secure file access | `electronAPI.path` |

**Sources:** [electron/preload.js:12-168](), [electron/window.js:174-210]()

## Configuration and Update System

The `ConfigService` manages application settings, regional flavors (CN vs. Global), and hardware metadata. It merges default settings from `electron/config/config.json` with user-specific overrides in the AppData directory. The system supports dynamic mirror switching for resource downloads to ensure reliability across different geographic regions.

For details, see [Configuration and Update System](#2.3).

**Sources:** [src/app/services/config.service.ts:12-194](), [electron/config/config.json:1-84]()

## CI/CD Pipeline and Build System

The project uses a complex build pipeline to handle multi-platform distribution. This includes GitHub Actions for automated builds, `electron-builder` for packaging, and regional flavoring logic to produce distinct binaries for different markets.

For details, see [CI/CD Pipeline and Build System](#2.4).

**Sources:** [package.json:149-159](), [build/installer.nsh:1-106]()

## Security Model

The architecture implements Electron's security best practices:
- **Context Isolation**: Enabled to prevent renderer access to Node.js globals.
- **Preload Bridge**: `contextBridge.exposeInMainWorld` is used to limit exposed functionality.
- **Instance Isolation**: `setupPooledUserDataPath` ensures that multiple instances of the app don't corrupt each other's data while maintaining a cache pool for performance.

**Sources:** [electron/main.js:194-200](), [electron/preload.js:12-15]()
