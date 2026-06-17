# Build and Deployment

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [child/scripts/compile.js](child/scripts/compile.js)
- [child/scripts/preprocess.js](child/scripts/preprocess.js)
- [child/scripts/upload.js](child/scripts/upload.js)
- [electron/terminal.js](electron/terminal.js)
- [src/app/editors/blockly-editor/services/builder.service.ts](src/app/editors/blockly-editor/services/builder.service.ts)
- [src/app/editors/blockly-editor/services/uploader.service.ts](src/app/editors/blockly-editor/services/uploader.service.ts)
- [src/app/services/builder.service.ts](src/app/services/builder.service.ts)
- [src/app/services/serial.service.ts](src/app/services/serial.service.ts)
- [src/app/services/uploader-ble.service.ts](src/app/services/uploader-ble.service.ts)
- [src/app/services/uploader.service.ts](src/app/services/uploader.service.ts)
- [src/app/tools/terminal/terminal.service.ts](src/app/tools/terminal/terminal.service.ts)

</details>



This document covers the build and deployment pipeline in Aily Blockly, which transforms visual blocks into executable Arduino code and deploys it to hardware devices. The system handles code generation, background preprocessing, compilation via the `aily-builder` toolchain, and hardware flashing through an integrated terminal system.

For detailed implementation of specific components, see [Compilation Process](#5.1), [Hardware Upload](#5.2), and [Terminal Integration](#5.3).

## System Architecture

The build and deployment system consists of three primary services that work together to transform visual blocks into running hardware code. The logic is split between high-level management in `BuilderService` and `UploaderService`, and low-level execution via the terminal layer.

```mermaid
graph TB
    subgraph \"Frontend Services\"
        BS[\"BuilderService (src/app/services/builder.service.ts)\"]
        US[\"_UploaderService (src/app/editors/blockly-editor/services/uploader.service.ts)\"] 
        CS[\"CmdService\"]
    end
    
    subgraph \"Terminal Layer\"
        TS[\"TerminalService (src/app/tools/terminal/terminal.service.ts)\"]
        TJS[\"terminal.js (electron/terminal.js)\"]
        PTY[\"node-pty\"]
    end
    
    subgraph \"External Toolchain\"
        AB[\"aily-builder (index.js)\"]
        CP[\"compile.js (child/scripts/compile.js)\"]
        PP[\"preprocess.js (child/scripts/preprocess.js)\"]
        UP[\"upload.js (child/scripts/upload.js)\"]
    end
    
    BS --> CS
    US --> BS
    US --> CS
    CS --> TS
    TS --> TJS
    TJS --> PTY
    PTY --> CP
    PTY --> PP
    PTY --> UP
    CP --> AB
    
    style BS fill:#e8f5e8
    style US fill:#fff3e0
    style CS fill:#e1f5fe
    style AB fill:#ffebee
```

Sources: [src/app/services/builder.service.ts:17-27](), [src/app/editors/blockly-editor/services/uploader.service.ts:22-41](), [electron/terminal.js:1-112]()

## Build and Deployment Workflow

The complete build and deployment process follows a structured pipeline from visual blocks to running code:

```mermaid
graph TB
    subgraph \"Code Generation\"
        BLOCKS[\"Blockly Workspace\"]
        GEN[\"arduinoGenerator.workspaceToCode()\"]
        SKETCH[\"sketch.ino\"]
    end
    
    subgraph \"Preprocessing (preprocess.js)\"
        DEPS[\"Parse package.json\"]
        LIBS[\"Extract Libraries to .temp/libraries/\"]
        PRE_JSON[\"Generate preprocess.json\"]
    end
    
    subgraph \"Compilation (compile.js)\"
        CMD[\"Build aily-builder Command\"]
        COMPILE[\"Execute Compilation\"]
        BIN[\"Generate Binary Files\"]
    end
    
    subgraph \"Upload (upload.js / uploader-ble.service)\"
        PORT[\"Select Serial/BLE/Probe Port\"]
        UPLOAD_CMD[\"Build esptool/probe-rs Command\"]
        FLASH[\"Flash to Hardware\"]
    end
    
    BLOCKS --> GEN
    GEN --> SKETCH
    SKETCH --> DEPS
    
    DEPS --> LIBS
    LIBS --> PRE_JSON
    
    PRE_JSON --> CMD
    CMD --> COMPILE
    COMPILE --> BIN
    
    BIN --> PORT
    PORT --> UPLOAD_CMD
    UPLOAD_CMD --> FLASH
    
    style GEN fill:#e8f5e8
    style DEPS fill:#fff3e0
    style COMPILE fill:#e1f5fe
    style FLASH fill:#ffebee
```

Sources: [src/app/editors/blockly-editor/services/builder.service.ts:107-138](), [child/scripts/preprocess.js:60-107](), [child/scripts/compile.js:110-125](), [src/app/editors/blockly-editor/services/uploader.service.ts:154-189]()

## Project Structure and Dependencies

The build system creates a temporary directory structure for compilation and manages dependencies through npm packages. Preprocessing logic in `preprocess.js` maps these dependencies to the local filesystem for the compiler.

| Directory | Purpose | Managed By |
|-----------|---------|------------|
| `.temp/` | Temporary build workspace | `BuilderService` [src/app/services/builder.service.ts:118]() |
| `.temp/sketch/` | Generated Arduino sketch (`sketch.ino`) | `compile.js` [child/scripts/compile.js:65-72]() |
| `.temp/libraries/` | Extracted library sources | `preprocess.js` [child/scripts/preprocess.js:64]() |
| `.temp/preprocess.json` | Mapping of board/SDK/tools paths | `preprocess.js` [child/scripts/preprocess.js:67]() |

The system processes three types of dependencies from `package.json`:
- **Board Dependencies**: `@aily-project/board-*` packages [child/scripts/preprocess.js:82]().
- **Library Dependencies**: `@aily-project/lib-*` packages extracted to `.temp/libraries/` [child/scripts/preprocess.js:119-126]().
- **Toolchain Dependencies**: Compilers (`@aily-project/compiler-*`) and SDKs (`@aily-project/sdk-*`) [child/scripts/preprocess.js:165-180]().

## Hardware Communication

The deployment layer supports multiple communication protocols and hardware interfaces:

1.  **Serial Upload**: Uses `upload.js` to execute tools like `esptool` for ESP32 or `arduino-cli` for standard boards. It handles the \"1200bps touch\" reset trick [child/scripts/upload.js:82-115]().
2.  **BLE OTA**: The `UploaderBleService` handles over-the-air firmware updates via Bluetooth Low Energy, managing sector-based transfer and CRC verification [src/app/services/uploader-ble.service.ts:6-154]().
3.  **Debugger/Probe**: Support for flashing via CMSIS-DAP or other probes using `probe-rs`.
4.  **SoftDevice**: Specialized workflow for flashing nRF5 SoftDevice stacks [src/app/services/uploader.service.ts:107-131]().

Sources: [child/scripts/upload.js:82-115](), [src/app/services/uploader-ble.service.ts:114-154](), [src/app/services/uploader.service.ts:107-131]()

## Command Execution Architecture

The terminal system provides the foundation for executing build scripts with streaming output and process control:

| Component | Purpose | Location |
|-----------|---------|----------|
| `CmdService` | High-level command interface | `src/app/services/cmd.service.ts` |
| `TerminalService` | Terminal management and stream handling | `src/app/tools/terminal/terminal.service.ts` |
| `terminal.js` | Electron main process handlers using `node-pty` | `electron/terminal.js` |
| `upload.js` / `compile.js` | Child process scripts for specific tasks | `child/scripts/` |

The system supports cross-platform shells (PowerShell on Windows, zsh on macOS, bash on Linux) [electron/terminal.js:17-21]() and manages process trees to ensure clean termination of build tools [electron/terminal.js:51-84]().

Sources: [src/app/tools/terminal/terminal.service.ts:5-210](), [electron/terminal.js:11-37](), [electron/terminal.js:112-187]()
