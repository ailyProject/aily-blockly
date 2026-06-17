# Visual Programming

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [src/app/editors/blockly-editor/blockly-editor.component.html](src/app/editors/blockly-editor/blockly-editor.component.html)
- [src/app/editors/blockly-editor/blockly-editor.component.scss](src/app/editors/blockly-editor/blockly-editor.component.scss)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.html](src/app/editors/blockly-editor/components/blockly/blockly.component.html)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.scss](src/app/editors/blockly-editor/components/blockly/blockly.component.scss)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.ts](src/app/editors/blockly-editor/components/blockly/blockly.component.ts)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.html](src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.html)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.scss](src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.scss)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.ts](src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.ts)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.html](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.html)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.scss](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.scss)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts)
- [src/app/editors/blockly-editor/components/blockly/theme.config.ts](src/app/editors/blockly-editor/components/blockly/theme.config.ts)
- [src/app/editors/blockly-editor/services/blockly.service.ts](src/app/editors/blockly-editor/services/blockly.service.ts)
- [src/styles/themes/_dark.scss](src/styles/themes/_dark.scss)
- [src/styles/themes/_light.scss](src/styles/themes/_light.scss)

</details>



This document provides a high-level overview of the visual programming capabilities within the Aily Blockly IDE. The system integrates Google's Blockly to provide a robust, AI-enhanced environment for hardware development, allowing users to compose logic through blocks that translate into executable code.

For information about the build and compilation process that occurs after code generation, see [Build and Deployment](#5). For details about project structure and library dependencies, see [Project Management](#3).

## Blockly Integration Architecture

The visual programming system is centered around the `BlocklyComponent` and managed by the `BlocklyService`. It supports a multi-page workspace environment where users can organize logic across different tabs, all sharing a common data model.

### Core Integration Architecture

```mermaid
graph TB
    subgraph \"Angular Frontend Space\"
        BC[\"BlocklyComponent\"]
        BTP[\"BlocklyToolboxPaneComponent\"]
        BWP[\"BlocklyWorkspacePagesComponent\"]
        BS[\"BlocklyService\"]
    end
    
    subgraph \"Blockly Code Entity Space\"
        WS[\"Blockly.WorkspaceSvg\"]
        BT[\"Blockly.Toolbox\"]
        AG[\"arduinoGenerator\"]
        MG[\"micropythonGenerator\"]
    end
    
    subgraph \"Data & State\"
        BPD[\"BlocklyProjectDocument\"]
        BPS[\"BlocklyPageSnapshot\"]
        BSM[\"BlocklySharedModel\"]
    end
    
    BC --> BS
    BTP --> BS
    BWP --> BS
    BS --> WS
    BS --> BT
    
    WS --> AG
    WS --> MG
    
    BS --> BPD
    BPD --> BPS
    BPD --> BSM
```
**Sources:** [src/app/editors/blockly-editor/services/blockly.service.ts:106-168](), [src/app/editors/blockly-editor/components/blockly/blockly.component.ts:47-49]()

### Workspace and Multi-page Management
Unlike standard Blockly implementations, Aily Blockly supports multiple pages within a single project. Each page is represented by a `BlocklyPageSnapshot` containing the block XML/JSON and view state (scale, scroll position). A `BlocklySharedModel` ensures that variables and procedures remain consistent across all pages.

For details on workspace management, library loading pipelines, and dynamic theming, see [Blockly Integration](#4.1).

**Sources:** [src/app/editors/blockly-editor/services/blockly.service.ts:19-43](), [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts:1-20]()

## Code Generation

The system features a real-time code generation engine that converts visual blocks into C++ (Arduino) or MicroPython. 

### Block-to-Code Mapping
A key feature is the traceability between the visual and textual representations. The `BlockCodeMapping` system tracks which lines of generated code correspond to specific block IDs, enabling features like error highlighting and block-to-code navigation.

| Generator | Target Language | Implementation |
|-----------|-----------------|----------------|
| `arduinoGenerator` | C++ (Arduino) | [src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts]() |
| `micropythonGenerator` | Python | [src/app/editors/blockly-editor/components/blockly/generators/micropython/micropython.ts]() |

For details on the generation logic, mapping system, and traceability, see [Code Generation](#4.2).

**Sources:** [src/app/editors/blockly-editor/services/blockly.service.ts:8-9](), [src/app/editors/blockly-editor/services/blockly.service.ts:151-160]()

## Block Plugins and Extensions

To support complex hardware interactions, the IDE includes a suite of custom Blockly plugins and specialized field types.

*   **Specialized Fields:** Custom inputs for LED matrices (`field-led-matrix`), bitmaps (`field-bitmap`), and colors.
*   **Aily-Thrasos Renderer:** A custom SVG renderer that provides a modern, high-contrast visual style for blocks.
*   **Workspace Search:** An integrated search tool (`BlockSearcher`) that allows users to find blocks by type, field content, or generated code.

For a full list of custom fields and workspace enhancements, see [Block Plugins and Extensions](#4.3).

**Sources:** [src/app/editors/blockly-editor/components/blockly/blockly.component.ts:52-70](), [src/app/editors/blockly-editor/services/blockly.service.ts:177-178]()

## ABS/ABI AI Editing System

Aily Blockly features a sophisticated bidirectional system that allows AI agents to read and modify the visual workspace.

### AI Interaction Pipeline

```mermaid
graph LR
    subgraph \"Natural Language Space\"
        User[\"User Intent\"]
        Agent[\"AI Assistant\"]
    end
    
    subgraph \"DSL Translation\"
        ABS[\"Aily Block Syntax (.abs)\"]
        ABI[\"Aily Block Interface (.abi)\"]
    end
    
    subgraph \"Blockly Workspace\"
        WS[\"Blockly.WorkspaceSvg\"]
        BCM[\"BlockCodeMapping\"]
    end
    
    User --> Agent
    Agent -- \"Reads/Writes\" --> ABS
    ABS -- \"Converter\" --> ABI
    ABI -- \"Sync\" --> WS
    WS -- \"Mapping\" --> BCM
```

*   **ABS (Aily Block Syntax):** A human-readable, Python-like DSL that represents blocks, making it easy for LLMs to process.
*   **ABI (Aily Block Interface):** The JSON serialization format used for persistence and internal communication.

For details on the incremental workspace sync and the block repair pipeline, see [ABS/ABI AI Editing System](#4.4).

**Sources:** [src/app/editors/blockly-editor/services/blockly.service.ts:9-10](), [src/app/editors/blockly-editor/services/blockly.service.ts:158-159]()
