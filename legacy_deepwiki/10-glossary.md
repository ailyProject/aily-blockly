# Glossary

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [build/installer.nsh](build/installer.nsh)
- [child/scripts/compile.js](child/scripts/compile.js)
- [child/scripts/preprocess.js](child/scripts/preprocess.js)
- [child/scripts/upload.js](child/scripts/upload.js)
- [docs/subapp-development.md](docs/subapp-development.md)
- [docs/tool-development-spec.md](docs/tool-development-spec.md)
- [electron/main.js](electron/main.js)
- [electron/package-lock.json](electron/package-lock.json)
- [electron/package.json](electron/package.json)
- [electron/preload.js](electron/preload.js)
- [electron/window.js](electron/window.js)
- [package-lock.json](package-lock.json)
- [package.json](package.json)
- [public/i18n/ar/ar.json](public/i18n/ar/ar.json)
- [public/i18n/de/de.json](public/i18n/de/de.json)
- [public/i18n/en/en.json](public/i18n/en/en.json)
- [public/i18n/es/es.json](public/i18n/es/es.json)
- [public/i18n/fr/fr.json](public/i18n/fr/fr.json)
- [public/i18n/ja/ja.json](public/i18n/ja/ja.json)
- [public/i18n/ko/ko.json](public/i18n/ko/ko.json)
- [public/i18n/pt/pt.json](public/i18n/pt/pt.json)
- [public/i18n/ru/ru.json](public/i18n/ru/ru.json)
- [public/i18n/zh_cn/zh_cn.json](public/i18n/zh_cn/zh_cn.json)
- [public/i18n/zh_hk/zh_hk.json](public/i18n/zh_hk/zh_hk.json)
- [src/app/components/sub-window/sub-window.component.html](src/app/components/sub-window/sub-window.component.html)
- [src/app/components/sub-window/sub-window.component.scss](src/app/components/sub-window/sub-window.component.scss)
- [src/app/components/tool-container/tool-container.component.html](src/app/components/tool-container/tool-container.component.html)
- [src/app/components/tool-container/tool-container.component.scss](src/app/components/tool-container/tool-container.component.scss)
- [src/app/configs/tool.config.ts](src/app/configs/tool.config.ts)
- [src/app/editors/blockly-editor/blockly-editor.component.ts](src/app/editors/blockly-editor/blockly-editor.component.ts)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.html](src/app/editors/blockly-editor/components/blockly/blockly.component.html)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.scss](src/app/editors/blockly-editor/components/blockly/blockly.component.scss)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.ts](src/app/editors/blockly-editor/components/blockly/blockly.component.ts)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.html](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.html)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.scss](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.scss)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts)
- [src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts](src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts)
- [src/app/editors/blockly-editor/services/blockly.service.ts](src/app/editors/blockly-editor/services/blockly.service.ts)
- [src/app/editors/blockly-editor/services/builder.service.ts](src/app/editors/blockly-editor/services/builder.service.ts)
- [src/app/editors/blockly-editor/services/project.service.ts](src/app/editors/blockly-editor/services/project.service.ts)
- [src/app/editors/blockly-editor/services/uploader.service.ts](src/app/editors/blockly-editor/services/uploader.service.ts)
- [src/app/services/child-tool-process.service.ts](src/app/services/child-tool-process.service.ts)
- [src/app/services/electron.service.ts](src/app/services/electron.service.ts)
- [src/app/services/project.service.ts](src/app/services/project.service.ts)
- [src/app/services/serial.service.ts](src/app/services/serial.service.ts)
- [src/app/services/uploader-ble.service.ts](src/app/services/uploader-ble.service.ts)
- [src/app/tools/aily-chat/core/skill-registry.ts](src/app/tools/aily-chat/core/skill-registry.ts)
- [src/app/tools/aily-chat/services/abs-auto-sync.service.ts](src/app/tools/aily-chat/services/abs-auto-sync.service.ts)
- [src/app/tools/aily-chat/services/block-definition.service.ts](src/app/tools/aily-chat/services/block-definition.service.ts)
- [src/app/tools/aily-chat/tools/abiAbsConverter.ts](src/app/tools/aily-chat/tools/abiAbsConverter.ts)
- [src/app/tools/aily-chat/tools/absParser.ts](src/app/tools/aily-chat/tools/absParser.ts)
- [src/app/tools/aily-chat/tools/blockConfigFixer.ts](src/app/tools/aily-chat/tools/blockConfigFixer.ts)
- [src/app/tools/aily-chat/tools/editBlockTool.ts](src/app/tools/aily-chat/tools/editBlockTool.ts)
- [src/app/tools/aily-chat/tools/getAbsSyntaxTool.ts](src/app/tools/aily-chat/tools/getAbsSyntaxTool.ts)
- [src/app/tools/aily-chat/tools/syncAbsFileTool.ts](src/app/tools/aily-chat/tools/syncAbsFileTool.ts)
- [src/app/tools/child-tool-host/child-tool-host.component.html](src/app/tools/child-tool-host/child-tool-host.component.html)
- [src/app/tools/child-tool-host/child-tool-host.component.scss](src/app/tools/child-tool-host/child-tool-host.component.scss)
- [src/app/tools/child-tool-host/child-tool-host.component.ts](src/app/tools/child-tool-host/child-tool-host.component.ts)
- [src/app/windows/project-new/project-new.component.html](src/app/windows/project-new/project-new.component.html)
- [src/app/windows/project-new/project-new.component.scss](src/app/windows/project-new/project-new.component.scss)
- [src/app/windows/project-new/project-new.component.ts](src/app/windows/project-new/project-new.component.ts)
- [src/styles/themes/_dark.scss](src/styles/themes/_dark.scss)
- [src/styles/themes/_light.scss](src/styles/themes/_light.scss)

</details>



This glossary defines technical terms, domain-specific jargon, and architectural concepts used within the Aily Blockly codebase. It serves as a reference for onboarding engineers to understand the relationships between the visual programming environment, the Electron/Angular framework, and hardware interaction logic.

## Architecture & Framework Terms

| Term | Definition | Key Code Entity |
| :--- | :--- | :--- |
| **Main Process** | The primary Electron process responsible for window management, system-level APIs, and hardware access (Serial, PTY). | [electron/main.js:1-7]() |
| **Renderer Process** | The Chromium process running the Angular application (UI and business logic). | [package.json:56-58]() |
| **Preload Bridge** | The secure communication layer that exposes specific Node.js/Electron features to the Angular frontend via `contextBridge`. | [electron/preload.js:12-168]() |
| **electronAPI** | The namespace on the global `window` object used by Angular to call Electron-native functions. | [electron/preload.js:12-12]() |
| **Pooled User Data** | A multi-instance strategy where the application rotates through a set of `instance-N` directories to allow concurrent IDE windows while maintaining separate Chromium caches. | [electron/main.js:194-245]() |
| **Sub-Window Pool** | A performance optimization that pre-creates hidden Electron windows to be reused for tools like the Serial Monitor or AI Assistant, reducing startup latency. | [electron/window.js:1-50]() |

### Diagram: Electron-Angular Communication
The following diagram illustrates how the `electronAPI` bridges the gap between the Angular UI and the system-level Main Process.

```mermaid
graph LR
    subgraph \"Renderer Space (Angular)\"
        [Component] --> |\"Invoke\"| [ElectronService]
        [ElectronService] --> |\"Call\"| [window.electronAPI]
    end

    subgraph \"Preload Space (preload.js)\"
        [window.electronAPI] --> |\"ipcRenderer.invoke\"| [IPCBridge]
    end

    subgraph \"Main Space (main.js)\"
        [IPCBridge] --> |\"Handle\"| [ipcMain.handle]
        [ipcMain.handle] --> |\"System Access\"| [SerialPort/PTY/FS]
    end
```
**Sources:** [electron/preload.js:12-159](), [src/app/services/electron.service.ts:1-50]()

## Project & Domain Concepts

| Term | Definition | Key Code Entity |
| :--- | :--- | :--- |
| **ABI** | **Aily Blockly Interface**. The JSON format used to save project state, board configurations, and block positions. | [package.json:91-91]() |
| **ABS** | **Aily Block Syntax**. A human-readable/LLM-friendly DSL used by the AI Agent to manipulate Blockly workspaces. | [src/app/tools/aily-chat/tools/absParser.ts:1-100]() |
| **Board Config** | Metadata describing hardware capabilities (ESP32, STM32, nRF5) used for compilation and pin mapping. | [src/app/services/project.service.ts:12-14]() |
| **Project Lock** | A file-based locking mechanism (`.lock`) to prevent multiple instances from writing to the same project directory simultaneously. | [electron/project-lock.js:1-50]() |
| **Library Manager** | The subsystem responsible for installing npm-based C++ libraries into the project's `libraries` folder. | [src/app/editors/blockly-editor/components/lib-manager/lib-manager.component.ts:1-100]() |

### Diagram: Project Data Flow
This diagram shows how project files are associated with specific services and logic handlers.

```mermaid
graph TD
    [ABI_File] --> |\"Parse\"| [_ProjectService]
    [_ProjectService] --> |\"Initialize\"| [BlocklyComponent]
    [BlocklyComponent] --> |\"Generate C++\"| [arduinoGenerator]
    [arduinoGenerator] --> |\"Compile\"| [_BuilderService]
    
    subgraph \"File Entities\"
        [ABI_File] -- \".abi\" --> [ABI_JSON]
        [ABS_File] -- \".abs\" --> [DSL_Syntax]
    end

    subgraph \"Code Entities\"
        [_ProjectService] -- \"src/app/editors/blockly-editor/services/project.service.ts\" --> [Logic]
        [arduinoGenerator] -- \"src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts\" --> [Gen]
    end
```
**Sources:** [src/app/services/project.service.ts:57-112](), [src/app/editors/blockly-editor/services/builder.service.ts:11-24]()

## Hardware & Build Terms

| Term | Definition | Key Code Entity |
| :--- | :--- | :--- |
| **aily-builder** | The external toolchain used to compile visual blocks into binary firmware. | [electron/preload.js:22-22]() |
| **Preprocess** | A background task that analyzes project dependencies and generates `preprocess.json` to speed up compilation. | [src/app/editors/blockly-editor/services/builder.service.ts:141-188]() |
| **Serial Upload** | The process of flashing firmware over a USB-to-Serial bridge (e.g., using `esptool-js`). | [src/app/editors/blockly-editor/services/uploader.service.ts:154-200]() |
| **BLE OTA** | **Over-the-Air** firmware updates performed via Bluetooth Low Energy. | [src/app/services/uploader-ble.service.ts:1-100]() |
| **SoftDevice** | A pre-compiled binary stack (usually for nRF5 chips) required for Bluetooth functionality. | [public/i18n/zh_cn/zh_cn.json:89-91]() |
| **FFS Manager** | **Flash File System Manager**. A tool to manage files stored on the device's internal flash (SPIFFS/LittleFS). | [public/i18n/en/en.json:22-22]() |

## AI Integration Jargon

| Term | Definition | Key Code Entity |
| :--- | :--- | :--- |
| **Agent Mode** | An interactive mode where the AI can autonomously execute tools (e.g., creating blocks, searching files). | [src/app/tools/aily-chat/tools/editBlockTool.ts:1-50]() |
| **QA Mode** | A restricted mode where the AI provides answers without direct workspace manipulation. | [src/app/services/ui.service.ts:1-50]() |
| **Block Repair** | An AI-driven process that fixes invalid block connections or missing parameters in a workspace. | [src/app/tools/aily-chat/tools/blockConfigFixer.ts:1-50]() |
| **Context Budget** | The token limit for AI interactions, monitored to ensure stable performance. | [package.json:199-199]() |

**Sources:**
- [electron/main.js:194-245]() (Pooled User Data)
- [electron/preload.js:12-168]() (electronAPI / Preload Bridge)
- [src/app/services/project.service.ts:57-112]() (Project Logic)
- [src/app/editors/blockly-editor/services/builder.service.ts:141-188]() (Preprocess / Build)
- [src/app/editors/blockly-editor/services/uploader.service.ts:154-200]() (Upload)
- [package.json:199-199]() (Tiktoken / AI context)
- [public/i18n/en/en.json:2-78]() (General terminology)
