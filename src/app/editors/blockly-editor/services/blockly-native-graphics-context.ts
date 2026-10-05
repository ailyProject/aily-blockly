import type * as Blockly from 'blockly';
import { getBlockIconDefinitions } from '../components/blockly/renderer/aily-icon/acon';

/** Data only: never transport a Theme instance, renderer constructor or UI plugin. */
export interface NativeGraphicsContext {
  renderer: string;
  rendererOverrides: Record<string, unknown> | null;
  rtl: boolean;
  oneBasedIndex: boolean;
  blockIcons: Array<[string, unknown]>;
  theme: {
    name: string;
    blockStyles: Blockly.Theme['blockStyles'];
    categoryStyles: Blockly.Theme['categoryStyles'];
    componentStyles: Blockly.Theme['componentStyles'];
    fontStyle: Blockly.Theme['fontStyle'];
    startHats: boolean;
  };
}

/** Headless callers keep the existing native defaults. Each capture is detached. */
export function captureNativeGraphicsContext(workspace: Blockly.Workspace | null): NativeGraphicsContext | undefined {
  if (!workspace?.rendered) return undefined;
  const svg = workspace as Blockly.WorkspaceSvg, theme = svg.getTheme();
  return structuredClone({
    renderer: svg.options.renderer, rendererOverrides: svg.options.rendererOverrides ?? null,
    rtl: svg.RTL, oneBasedIndex: svg.options.oneBasedIndex,
    blockIcons: Array.from(getBlockIconDefinitions() ?? []),
    theme: { name: theme.name, blockStyles: theme.blockStyles, categoryStyles: theme.categoryStyles,
      componentStyles: theme.componentStyles, fontStyle: theme.fontStyle, startHats: theme.startHats ?? false },
  });
}
