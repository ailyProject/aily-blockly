# Project Management

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

- [public/brands/microbit.webp](public/brands/microbit.webp)
- [public/brands/nordic.webp](public/brands/nordic.webp)
- [src/app/configs/board.config.ts](src/app/configs/board.config.ts)
- [src/app/editors/blockly-editor/blockly-editor.component.ts](src/app/editors/blockly-editor/blockly-editor.component.ts)
- [src/app/editors/blockly-editor/services/project.service.ts](src/app/editors/blockly-editor/services/project.service.ts)
- [src/app/pages/project-new/components/brand-list/brand-list.component.html](src/app/pages/project-new/components/brand-list/brand-list.component.html)
- [src/app/pages/project-new/components/brand-list/brand-list.component.scss](src/app/pages/project-new/components/brand-list/brand-list.component.scss)
- [src/app/pages/project-new/components/brand-list/brand-list.component.ts](src/app/pages/project-new/components/brand-list/brand-list.component.ts)
- [src/app/pages/project-new/project-new.component.html](src/app/pages/project-new/project-new.component.html)
- [src/app/pages/project-new/project-new.component.scss](src/app/pages/project-new/project-new.component.scss)
- [src/app/pages/project-new/project-new.component.ts](src/app/pages/project-new/project-new.component.ts)
- [src/app/services/project.service.ts](src/app/services/project.service.ts)
- [src/app/windows/project-new/project-new.component.html](src/app/windows/project-new/project-new.component.html)
- [src/app/windows/project-new/project-new.component.scss](src/app/windows/project-new/project-new.component.scss)
- [src/app/windows/project-new/project-new.component.ts](src/app/windows/project-new/project-new.component.ts)

</details>



The Project Management system handles the complete lifecycle of Aily Blockly projects, from creation to dependency management. This system provides isolated project environments with npm-based dependency resolution, ensuring each project maintains its own board and library versions to avoid compatibility conflicts.

For information about the visual programming workspace, see [Visual Programming](#4). For build and deployment processes, see [Build and Deployment](#5).

## Overview

The project management architecture centers around the `ProjectService` which orchestrates project operations and maintains project state. Projects in Aily Blockly are structured as npm-based packages with isolated dependencies, board configurations, and Blockly workspace definitions.

### Core Project Structure

```mermaid
graph TB
    subgraph \"Aily Project Directory\"
        PKG[\"package.json\"]
        ABI[\"project.abi\"]
        BOARD[\"board.json\"]
        MODULES[\"node_modules/\"]
    end
    
    subgraph \"Dependencies\"
        BOARD_PKG[\"@aily-project/board-*\"]
        LIB_PKG[\"@aily-project/lib-*\"]
        TOOLS_PKG[\"Development Tools\"]
    end
    
    subgraph \"Templates\"
        TEMPLATE[\"Board Template\"]
        BLOCKS[\"Block Definitions\"]
        CONFIG[\"Default Config\"]
    end
    
    PKG --> MODULES
    MODULES --> BOARD_PKG
    MODULES --> LIB_PKG
    MODULES --> TOOLS_PKG
    
    TEMPLATE --> PKG
    TEMPLATE --> ABI
    TEMPLATE --> BOARD
```

**Sources:** [src/app/services/project.service.ts:24-36](), [src/app/windows/project-new/project-new.component.ts:45-53](), [src/app/editors/blockly-editor/services/project.service.ts:72-83]()

### Project Service Architecture

The `ProjectService` manages project state through reactive streams and coordinates with multiple system services. It handles project activation events and tracks the current board configuration.

```mermaid
graph TB
    subgraph \"ProjectService Core\"
        STATE[\"stateSubject: BehaviorSubject\"]
        PACKAGE[\"currentPackageData: ProjectPackageData\"]
        PATH[\"currentProjectPath: string\"]
        BOARD[\"currentBoardConfig: any\"]
    end
    
    subgraph \"Service Dependencies\"
        UI[\"UiService\"]
        ELECTRON[\"ElectronService\"]
        CMD[\"CmdService\"]
        CONFIG[\"ConfigService\"]
        NPM[\"NpmService\"]
    end
    
    subgraph \"File Operations\"
        FS[\"window.fs\"]
        PATH_UTIL[\"window.path\"]
        ENV[\"window.env\"]
    end
    
    STATE --> UI
    PATH --> FS
    BOARD --> CONFIG
    PACKAGE --> FS
    
    UI --> ELECTRON
    CMD --> FS
    NPM --> CMD
```

**Sources:** [src/app/services/project.service.ts:54-112](), [src/app/editors/blockly-editor/services/project.service.ts:8-21]()

## Project Creation Workflow

The project creation process follows a multi-step wizard pattern implemented in `ProjectNewComponent`.

### Step 1: Board Selection

The board selection interface processes available boards and provides fuzzy search functionality using the Orama engine.

```mermaid
flowchart TD
    START[\"Load Board List\"] 
    PROCESS[\"process(): Add fulltext search index\"]
    DISPLAY[\"Display Board Grid\"]
    SEARCH[\"doSearch(): Orama fuzzy search\"]
    SELECT[\"selectBoard(): Update newProjectData\"]
    
    START --> PROCESS
    PROCESS --> DISPLAY
    DISPLAY --> SEARCH
    SEARCH --> DISPLAY
    DISPLAY --> SELECT
    
    subgraph \"Board Search Pipeline\"
        CONFIG[\"ConfigService.boardList\"]
        ORAMA[\"createBoardSearchIndex()\"]
        MATCH[\"searchBoards()\"]
    end
    
    CONFIG --> ORAMA
    ORAMA --> MATCH
    MATCH --> DISPLAY
```

**Sources:** [src/app/pages/project-new/project-new.component.ts:130-146](), [src/app/pages/project-new/project-new.component.ts:163-193](), [src/app/utils/fuzzy-search.utils:24-24]()

### Step 2: Project Configuration

The configuration step handles project metadata, directory selection, and template retrieval from the cloud.

| Field | Description | Validation |
|-------|-------------|------------|
| `board.name` | npm package name for board | Selected from `boardList` [src/app/pages/project-new/project-new.component.ts:213-220]() |
| `board.version` | Board package version | Retrieved via `NpmService.getPackageVersionList()` [src/app/pages/project-new/project-new.component.ts:251-255]() |
| `name` | Project directory name | Checked for uniqueness via `checkPathIsExist()` [src/app/pages/project-new/project-new.component.ts:285-296]() |
| `path` | Parent directory path | Selected via `selectFolder()` IPC [src/app/pages/project-new/project-new.component.ts:269-278]() |
| `template` | Optional cloud template | Fetched via `CloudService.getMyTemplates()` [src/app/pages/project-new/project-new.component.ts:223-247]() |

**Sources:** [src/app/pages/project-new/project-new.component.ts:56-65](), [src/app/pages/project-new/project-new.component.ts:213-267]()

### Step 3: Project Generation

The generation process creates the physical directory structure and initializes the `package.json` with project-specific metadata.

**Sources:** [src/app/services/project.service.ts:158-162](), [src/app/services/project.service.ts:178-204]()

## Project Lifecycle Management

For deep technical details on these operations, see [Project Lifecycle](#3.1).

### Opening and Locking
Projects are opened via `projectOpen()`, which handles routing to the appropriate editor (Blockly vs. Code). The system uses `AppDataResourceLockService` to prevent concurrent access to project resources.

**Sources:** [src/app/services/project.service.ts:115-150](), [src/app/services/project.service.ts:316-353]()

### Saving and Synchronization
The `_ProjectService` in the editor context handles the actual saving of `project.abi`. It also triggers a `codeHash` update in `package.json` to track changes for AI and cloud synchronization.

**Sources:** [src/app/editors/blockly-editor/services/project.service.ts:72-83](), [src/app/editors/blockly-editor/services/project.service.ts:108-141]()

## Dependency and Library Management

### Library Management
The system tracks used libraries in `package.json` under the `aily-blockly-used-libraries` field. The Library Manager handles discovery and installation of npm-based library packages. For details, see [Library Management](#3.2).

**Sources:** [src/app/editors/blockly-editor/services/project.service.ts:85-106](), [src/app/editors/blockly-editor/services/blockly.service.ts:14-18]()

### Library Editor
Developers can modify block definitions and generators using the integrated Library Editor. This tool allows for real-time updates to the Blockly toolbox and block behavior. For details, see [Library Editor](#3.3).

**Sources:** [src/app/editors/blockly-editor/blockly-editor.component.ts:50-51](), [src/app/editors/blockly-editor/blockly-editor.component.ts:167-168]()

## Unsaved Changes Detection

The system tracks workspace modifications by comparing the current memory-resident Blockly JSON against the `project.abi` file on disk.

```typescript
// Comparison logic in _ProjectService
const currentProjectAbi = this.blocklyService.getProjectAbiForSave();
const savedJsonStr = window['fs'].readFileSync(`${this.currentProjectPath}/project.abi`, 'utf8');
const savedJson = this.blocklyService.normalizeProjectAbi(JSON.parse(savedJsonStr));
return JSON.stringify(currentProjectAbi) !== JSON.stringify(savedJson);
```

**Sources:** [src/app/editors/blockly-editor/services/project.service.ts:50-70]()
