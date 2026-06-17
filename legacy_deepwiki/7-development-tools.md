# Development Tools

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [docs/subapp-development.md](docs/subapp-development.md)
- [docs/tool-development-spec.md](docs/tool-development-spec.md)
- [src/app/components/sub-window/sub-window.component.html](src/app/components/sub-window/sub-window.component.html)
- [src/app/components/sub-window/sub-window.component.scss](src/app/components/sub-window/sub-window.component.scss)
- [src/app/components/tool-container/tool-container.component.html](src/app/components/tool-container/tool-container.component.html)
- [src/app/components/tool-container/tool-container.component.scss](src/app/components/tool-container/tool-container.component.scss)
- [src/app/configs/tool.config.ts](src/app/configs/tool.config.ts)
- [src/app/services/child-tool-process.service.ts](src/app/services/child-tool-process.service.ts)
- [src/app/tools/aily-chat/aily-chat.component.html](src/app/tools/aily-chat/aily-chat.component.html)
- [src/app/tools/aily-chat/aily-chat.component.scss](src/app/tools/aily-chat/aily-chat.component.scss)
- [src/app/tools/aily-chat/aily-chat.component.ts](src/app/tools/aily-chat/aily-chat.component.ts)
- [src/app/tools/aily-chat/components/dialog/dialog.component.html](src/app/tools/aily-chat/components/dialog/dialog.component.html)
- [src/app/tools/aily-chat/components/dialog/dialog.component.scss](src/app/tools/aily-chat/components/dialog/dialog.component.scss)
- [src/app/tools/aily-chat/components/dialog/dialog.component.ts](src/app/tools/aily-chat/components/dialog/dialog.component.ts)
- [src/app/tools/aily-chat/core/skill-registry.ts](src/app/tools/aily-chat/core/skill-registry.ts)
- [src/app/tools/aily-chat/directives/aily-dynamic-component.directive.ts](src/app/tools/aily-chat/directives/aily-dynamic-component.directive.ts)
- [src/app/tools/aily-chat/pipes/markdown.pipe.ts](src/app/tools/aily-chat/pipes/markdown.pipe.ts)
- [src/app/tools/aily-chat/services/chat.service.ts](src/app/tools/aily-chat/services/chat.service.ts)
- [src/app/tools/child-tool-host/child-tool-host.component.html](src/app/tools/child-tool-host/child-tool-host.component.html)
- [src/app/tools/child-tool-host/child-tool-host.component.scss](src/app/tools/child-tool-host/child-tool-host.component.scss)
- [src/app/tools/child-tool-host/child-tool-host.component.ts](src/app/tools/child-tool-host/child-tool-host.component.ts)
- [src/app/tools/serial-monitor/components/data-item/data-item.component.html](src/app/tools/serial-monitor/components/data-item/data-item.component.html)
- [src/app/tools/serial-monitor/components/data-item/data-item.component.scss](src/app/tools/serial-monitor/components/data-item/data-item.component.scss)
- [src/app/tools/serial-monitor/components/data-item/data-item.component.ts](src/app/tools/serial-monitor/components/data-item/data-item.component.ts)
- [src/app/tools/serial-monitor/components/data-item/show-hex.pipe.ts](src/app/tools/serial-monitor/components/data-item/show-hex.pipe.ts)
- [src/app/tools/serial-monitor/components/data-item/show-nr.pipe.ts](src/app/tools/serial-monitor/components/data-item/show-nr.pipe.ts)
- [src/app/tools/serial-monitor/right-menu.config.ts](src/app/tools/serial-monitor/right-menu.config.ts)
- [src/app/tools/serial-monitor/serial-monitor.component.html](src/app/tools/serial-monitor/serial-monitor.component.html)
- [src/app/tools/serial-monitor/serial-monitor.component.scss](src/app/tools/serial-monitor/serial-monitor.component.scss)
- [src/app/tools/serial-monitor/serial-monitor.component.ts](src/app/tools/serial-monitor/serial-monitor.component.ts)
- [src/app/tools/serial-monitor/serial-monitor.service.ts](src/app/tools/serial-monitor/serial-monitor.service.ts)

</details>



## Purpose and Scope

The Development Tools system provides integrated hardware interaction and debugging capabilities within the Aily Blockly IDE. This includes high-throughput serial communication monitoring, AI-powered development assistance (Agent and QA modes), and an extensible framework for specialized hardware utilities like flash filesystem managers and network debuggers.

This document covers the high-level architecture and integration of these tools. Detailed implementation details are located in the child pages linked below.

## Development Tools Architecture

The development tools system uses a two-tier architecture: **Built-in Angular Tools** (integrated directly into the renderer process) and **Extensible Child Tools** (independent sub-apps).

### Tool Hosting and Lifecycle

```mermaid
graph TB
    subgraph \"Main Renderer (Angular)\"
        TC[\"ToolContainerComponent\"]
        SW[\"SubWindowComponent\"]
        CH[\"ChildToolHostComponent\"]
    end
    
    subgraph \"Built-in Tools\"
        SM[\"SerialMonitorComponent\"]
        AI[\"AilyChatComponent\"]
    end
    
    subgraph \"Child Sub-Apps (Iframe/WebWorker)\"
        FFS[\"FFS Manager\"]
        BLE[\"BLE Debugger\"]
    end
    
    TC --> SM
    TC --> AI
    SW --> SM
    CH -- \"Penpal IPC\" --> FFS
    CH -- \"Penpal IPC\" --> BLE
```

Tools can be launched as integrated panels within the `ToolContainerComponent` or as standalone desktop windows via `SubWindowComponent` [src/app/tools/serial-monitor/serial-monitor.component.html:1-9](). Built-in tools like the **AI Assistant** [src/app/tools/aily-chat/aily-chat.component.ts:112]() and **Serial Monitor** [src/app/tools/serial-monitor/serial-monitor.component.ts:70]() are registered in the application's routing and configuration system.

Sources: [src/app/tools/serial-monitor/serial-monitor.component.html:1-9](), [src/app/configs/tool.config.ts:100-126](), [src/app/tools/child-tool-host/child-tool-host.component.ts]()

## Core Development Tools

### Serial Monitor
The Serial Monitor is a high-performance debugging tool designed for embedded development. It utilizes **TanStack Virtual** for virtualized scrolling, allowing it to handle up to 100,000 log entries without UI degradation [src/app/tools/serial-monitor/serial-monitor.service.ts:25-28](). It features a 50ms throttle on data updates to prevent UI freezing during high-baudrate transmission [src/app/tools/serial-monitor/serial-monitor.service.ts:55-57]().

For details, see [Serial Monitor](#7.1).

### AI Assistant (Aily Chat)
The AI Assistant provides a sophisticated chat interface with two primary modes: **Agent** (capable of executing tools) and **QA** (standard question-answering) [src/app/tools/aily-chat/services/chat.service.ts:36](). It uses a `ChatKernelProxy` to handle streaming SSE (Server-Sent Events) in a Web Worker, ensuring the UI remains responsive during long AI generations [src/app/tools/aily-chat/services/chat.service.ts:48]().

For details, see [AI Assistant](#7.2).

### AI Agent Tools
The AI Agent is equipped with a suite of \"Skills\" registered in the `SkillRegistry`. These tools allow the AI to read/write project files, search documentation, analyze the Blockly workspace using **ABS (Aily Block Syntax)**, and even trigger hardware builds.

For details, see [AI Agent Tools](#7.3).

### Extensible Tool Framework
Aily supports an extensible \"Child Tool\" system. These are independent applications located in `child/tools/` that communicate with the main IDE via a secure **Penpal**-based IPC bridge [src/app/configs/tool.config.ts:109-112](). This allows Seeed and the community to develop specialized debuggers (MQTT, Network, BLE) that run in isolated environments.

For details, see [Extensible Tool Framework](#7.4).

## Hardware Management Tools

### Flash File System (FFS) Manager
The FFS Manager provides a visual interface for managing files stored on an embedded device's flash memory (e.g., LittleFS or SPIFFS). It supports partition visualization and file transfer via serial protocols.

For details, see [Flash File System Manager](#7.5).

### AI Model Store and Deployment
The Model Store allows users to browse pre-trained AI models and deploy them to edge devices using the **SSCMA (Seeed SenseCraft Model Assistant)** pipeline. It manages model quantization, format conversion, and flashing.

For details, see [AI Model Store and Deployment](#7.6).

## Tool Integration Logic

Development tools integrate with the main IDE state via the `UiService` and `SerialService`. A critical integration point is the **Upload Synchronization**: the Serial Monitor and FFS Manager automatically pause their serial connections when a hardware upload starts to prevent resource contention [src/app/tools/serial-monitor/serial-monitor.component.ts:174-200]().

```mermaid
graph LR
    subgraph \"IDE State\"
        US[\"UiService\"]
        SS[\"SerialService\"]
    end
    
    subgraph \"Tools\"
        MON[\"Serial Monitor\"]
        FFS[\"FFS Manager\"]
    end
    
    SS -- \"Port Lock\" --> MON
    SS -- \"Port Lock\" --> FFS
    US -- \"Theme/Layout\" --> MON
    US -- \"Theme/Layout\" --> FFS
```

Sources: [src/app/tools/serial-monitor/serial-monitor.component.ts:174-200](), [src/app/tools/serial-monitor/serial-monitor.service.ts:65-67](), [src/app/services/ui.service.ts]()
