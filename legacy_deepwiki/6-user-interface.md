# User Interface

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [src/app/app.routes.ts](src/app/app.routes.ts)
- [src/app/components/menu/menu.component.html](src/app/components/menu/menu.component.html)
- [src/app/components/menu/menu.component.scss](src/app/components/menu/menu.component.scss)
- [src/app/components/menu/menu.component.ts](src/app/components/menu/menu.component.ts)
- [src/app/configs/menu.config.ts](src/app/configs/menu.config.ts)
- [src/app/main-window/components/header/header.component.html](src/app/main-window/components/header/header.component.html)
- [src/app/main-window/components/header/header.component.scss](src/app/main-window/components/header/header.component.scss)
- [src/app/main-window/components/header/header.component.ts](src/app/main-window/components/header/header.component.ts)
- [src/app/main-window/main-window.component.html](src/app/main-window/main-window.component.html)
- [src/app/main-window/main-window.component.scss](src/app/main-window/main-window.component.scss)
- [src/app/main-window/main-window.component.ts](src/app/main-window/main-window.component.ts)
- [src/app/tools/log/log.component.html](src/app/tools/log/log.component.html)
- [src/app/tools/log/log.component.scss](src/app/tools/log/log.component.scss)
- [src/app/tools/log/log.component.ts](src/app/tools/log/log.component.ts)

</details>



This document describes the main user interface components and layout system of the Aily Blockly IDE. It covers the Angular-based UI architecture, the three-pane layout system, and how the UI integrates with hardware services and the AI assistant.

For detailed information about the main window layout implementation, see [Main Window Layout](#6.1). For header-specific functionality and controls, see [Header and Controls](#6.2). For authentication and user management, see [Authentication and User Management](#6.3).

## UI Architecture Overview

The Aily Blockly user interface is built using Angular components within an Electron renderer process. The UI follows a hierarchical structure where the `MainWindowComponent` [src/app/main-window/main-window.component.ts:36-67]() coordinates high-level layout, while specialized services manage state for tools, projects, and hardware communication.

**Component Architecture Diagram**
```mermaid
graph TB
    subgraph \"Main Application\"
        MW[\"MainWindowComponent\"]
        H[\"HeaderComponent\"] 
        F[\"FooterComponent\"]
        RO[\"router-outlet\"]
    end
    
    subgraph \"Content Views\"
        BE[\"BlocklyEditorComponent\"]
        G[\"GuideComponent\"]
    end
    
    subgraph \"Tool Components\"
        CV[\"CodeViewerComponent\"]
        SM[\"SerialMonitorComponent\"]
        AC[\"AilyChatComponent\"]
        AS[\"AppStoreComponent\"]
        LOG[\"LogComponent\"]
        TERM[\"TerminalComponent\"]
    end
    
    subgraph \"Services\"
        US[\"UiService\"]
        PS[\"ProjectService\"]
        CS[\"ConfigService\"]
        SER[\"SerialService\"]
    end
    
    MW --> H
    MW --> F
    MW --> RO
    MW --> LOG
    MW --> TERM
    
    RO --> BE
    RO --> G
    
    MW --> US
    MW --> PS
    MW --> CS
    
    H --> SER
    H --> PS
```
Sources: [src/app/main-window/main-window.component.ts:1-67](), [src/app/main-window/components/header/header.component.ts:104-125]()

## Main Window Structure

The `MainWindowComponent` implements a responsive layout using `nz-layout` [src/app/main-window/main-window.component.html:4-109](). It consists of a fixed header, a flexible middle section for the primary editor, a resizable bottom panel for diagnostics, and a resizable right sidebar for secondary tools.

**Main Window Layout Mapping**
```mermaid
graph TB
    subgraph \"MainWindowComponent [src/app/main-window/main-window.component.html]\"
        H[\"app-header\"]
        
        subgraph \"nz-layout\"
            subgraph \"nz-content\"
                MB[\"middle-box (Editor Area)\"]
                BB[\"bottom-box (Diagnostics)\"]
                subgraph \"Tabs\"
                    LOG[\"app-log\"]
                    TERM[\"app-terminal\"]
                end
            end
            
            subgraph \"nz-sider (Sidebar)\"
                RB[\"right-box (Tools)\"]
                subgraph \"Tool Mapping\"
                    CV[\"app-code-viewer\"]
                    SM[\"app-serial-monitor\"]
                    FFS[\"app-ffs-manager\"]
                    CHAT[\"app-aily-chat\"]
                    CTH[\"app-child-tool-host\"]
                end
            end
        end
        
        F[\"app-footer\"]
    end
```
Sources: [src/app/main-window/main-window.component.html:1-111](), [src/app/main-window/main-window.component.ts:69-100]()

## Core UI Components

### Header and Global Controls
The `HeaderComponent` manages project-level actions, board selection, and port configuration. It uses a dynamic menu system defined in `menu.config.ts` [src/app/configs/menu.config.ts:59-165]().
*   **Action Buttons**: Build (F5) and Run (F6) buttons with state tracking [src/app/configs/menu.config.ts:26-56]().
*   **Hardware Selection**: Aggregated view for Serial, BLE, and Probe-rs connections [src/app/main-window/components/header/header.component.ts:83-96]().
*   **App Store**: Dynamic integration of tools via `AppStoreService` [src/app/main-window/components/header/header.component.ts:130-135]().

For details, see [Header and Controls](#6.2).

### Diagnostics and Logging
The bottom panel houses the `LogComponent` and `TerminalComponent`. 
*   **Log Panel**: Features ANSI color parsing via `AnsiPipe` [src/app/tools/log/log.component.ts:6](), virtualized scrolling for performance [src/app/tools/log/log.component.ts:48-53](), and a search/filter toolbar [src/app/tools/log/log.component.html:1-25]().
*   **Terminal**: Integrated shell access via `node-pty`.

For details, see [Main Window Layout](#6.1).

### Extensible Sidebar Tools
The right sidebar (`nz-sider`) acts as a host for various utilities. It supports both built-in Angular components and independent \"Child Tools\" loaded via `ChildToolHostComponent` [src/app/main-window/main-window.component.html:70-72]().

| Component | Tool ID | Description |
| :--- | :--- | :--- |
| `CodeViewerComponent` | `code-viewer` | Read-only view of generated C++/Python code. |
| `SerialMonitorComponent` | `serial-monitor` | High-performance serial data visualization. |
| `AilyChatComponent` | `aily-chat` | AI assistant interface with SSE streaming. |
| `ChildToolHostComponent` | *Dynamic* | Sandboxed iframe host for external tools. |

Sources: [src/app/main-window/main-window.component.html:61-107](), [src/app/app.routes.ts:95-97]()

## UI State and Navigation

The application state is synchronized across components using the `UiService`. It manages the visibility of panels (`showRbox`, `showBbox`) and the lifecycle of open tools [src/app/main-window/main-window.component.ts:152-193]().

Navigation is handled by Angular's `RouterModule`, with primary routes including:
*   `/main/guide`: The onboarding and project selection screen [src/app/app.routes.ts:19-21]().
*   `/main/blockly-editor`: The primary visual programming environment [src/app/app.routes.ts:46-48]().
*   `/main/code-editor`: A text-based code editor [src/app/app.routes.ts:50-52]().

Sources: [src/app/main-window/main-window.component.ts:114-149](), [src/app/app.routes.ts:1-54]()
