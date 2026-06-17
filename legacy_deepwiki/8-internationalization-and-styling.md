# Internationalization and Styling

<details>
<summary>Relevant source files</summary>

The following files were used as context for generating this wiki page:

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
- [src/app/editors/blockly-editor/components/blockly/blockly.component.html](src/app/editors/blockly-editor/components/blockly/blockly.component.html)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.scss](src/app/editors/blockly-editor/components/blockly/blockly.component.scss)
- [src/app/editors/blockly-editor/components/blockly/blockly.component.ts](src/app/editors/blockly-editor/components/blockly/blockly.component.ts)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.html](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.html)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.scss](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.scss)
- [src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts](src/app/editors/blockly-editor/components/blockly/components/blockly-workspace-pages/blockly-workspace-pages.component.ts)
- [src/app/editors/blockly-editor/services/blockly.service.ts](src/app/editors/blockly-editor/services/blockly.service.ts)
- [src/styles/themes/_dark.scss](src/styles/themes/_dark.scss)
- [src/styles/themes/_light.scss](src/styles/themes/_light.scss)

</details>



This document provides an overview of the multi-language support system and styling architecture of the Aily Blockly IDE. The system is designed to support a global audience with localized interfaces and a flexible, themeable visual environment.

For details on the implementation of these systems, see:
- [Multi-language Support](#8.1) — Detailed JSON schema, locale loading, and Blockly translation mapping.
- [Themes and Styling](#8.2) — SCSS architecture, dynamic theme switching, and the `aily-thrasos` renderer.

## Multi-language Support

The Aily Blockly IDE implements internationalization (i18n) using a hierarchical JSON-based system. It supports 11 distinct locales, providing comprehensive coverage for menus, project settings, hardware-specific parameters, and Blockly workspace elements.

### Locale Architecture
The translation system is categorized into namespaces to manage the complexity of a hardware IDE. These namespaces include `MENU` for UI actions, `BLOCKLY` for visual programming elements, and hardware-specific keys for platforms like `ESP32`, `STM32`, and `NRF5`.

```mermaid
graph TD
    subgraph \"I18n Data Flow\"
        JSON[\"public/i18n/{locale}/{locale}.json\"]
        BLOCKLY_JSON[\"Blockly.setLocale()\"]
        ANGULAR_TRANS[\"TranslateService\"]
    end

    subgraph \"Namespaces (Code Entities)\"
        MENU[\"MENU (Actions & UI)\"]
        PROJ[\"PROJECT (Lifecycle)\"]
        HARDWARE[\"ESP32 / STM32 / NRF5\"]
        BLOCKS[\"BLOCKLY (Workspace UI)\"]
    end

    JSON --> ANGULAR_TRANS
    JSON --> BLOCKLY_JSON
    ANGULAR_TRANS --> MENU
    ANGULAR_TRANS --> PROJ
    ANGULAR_TRANS --> HARDWARE
    BLOCKLY_JSON --> BLOCKS
```
Sources: [public/i18n/zh_cn/zh_cn.json:1-83](), [public/i18n/en/en.json:1-88](), [src/app/editors/blockly-editor/services/blockly.service.ts:4-5]()

### Supported Languages
The IDE currently supports:
- **East Asian:** Simplified Chinese (`zh_cn`), Traditional Chinese (`zh_hk`), Japanese (`ja`), Korean (`ko`).
- **European:** English (`en`), German (`de`), Spanish (`es`), French (`fr`), Portuguese (`pt`), Russian (`ru`).
- **Middle Eastern:** Arabic (`ar`).

For implementation details, see [Multi-language Support](#8.1).

## Themes and Styling

The styling system is built on a modular SCSS architecture that supports both light and dark themes. It extends beyond standard CSS to include specialized styling for the Blockly SVG workspace and the integrated code editors.

### Styling Components
The system manages three distinct layers of styling:
1.  **Global UI Styling:** SCSS variables for background colors, borders, and typography using `MiSans` and `FiraCode`.
2.  **Blockly Renderer:** Custom theming for the `aily-thrasos` renderer, controlling block colors and connection shapes.
3.  **Dynamic Workspace Elements:** Real-time updates to SVG grid patterns and component colors during theme switching.

```mermaid
graph LR
    subgraph \"Styling Space\"
        SCSS[\"src/styles/themes/\"]
        DARK[\"_dark.scss\"]
        LIGHT[\"_light.scss\"]
    end

    subgraph \"Code Entity Space\"
        COMP[\"blockly.component.scss\"]
        SERVICE[\"BlocklyService\"]
        RENDERER[\"aily-thrasos renderer\"]
    end

    DARK --> COMP
    LIGHT --> COMP
    SERVICE -- \"Dynamic Update\" --> RENDERER
    COMP -- \"Host Binding\" --> SERVICE
```
Sources: [src/styles/themes/_dark.scss:1-10](), [src/styles/themes/_light.scss:1-10](), [src/app/editors/blockly-editor/components/blockly/blockly.component.scss:1-50](), [src/app/editors/blockly-editor/services/blockly.service.ts:111-121]()

### Theme Configuration
Themes are defined as CSS classes (e.g., `.ddark`) applied to the application root. The `BlocklyService` coordinates the transition between themes to ensure that the Blockly canvas and the Angular UI remain synchronized in appearance.

For implementation details, see [Themes and Styling](#8.2).

## Relationship to Other Systems

| System | Interaction |
| :--- | :--- |
| **Project Management** | Localized project templates and board descriptions are pulled from i18n files. |
| **Blockly Integration** | The `BlocklyService` uses `processI18n` and `processToolboxI18n` to localize the toolbox. |
| **AI Assistant** | The AI uses localized ABS (Aily Block Syntax) metadata to explain blocks in the user's language. |

Sources: [src/app/editors/blockly-editor/services/blockly.service.ts:4-9](), [public/i18n/zh_cn/zh_cn.json:175-180]()
