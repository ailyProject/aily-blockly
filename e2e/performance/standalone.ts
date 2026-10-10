import * as Blockly from 'blockly';
import 'blockly/blocks';
import * as zh from 'blockly/msg/zh-hans';
import {DarkTheme} from '../../src/app/editors/blockly-editor/components/blockly/theme.config';
import {loadBlocklyWorkspace} from '../../src/app/editors/blockly-editor/utils/blockly-performance';
import '../../src/app/editors/blockly-editor/components/blockly/renderer/aily-thrasos/renderer';
declare const AILY_RENDERER: boolean;

async function start() {
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(zh)) if (typeof value === 'string') messages[key] = value;
  Blockly.setLocale(messages);
  const definitions = await (await fetch('definitions.json')).json();
  (window as any).__ailyBlockDefinitionsMap = new Map(definitions.map(definition => [definition.type, definition.icon]));
  for (const definition of definitions) {
    delete Blockly.Blocks[definition.type];
    Blockly.defineBlocksWithJsonArray([definition]);
  }
  const topology = new URLSearchParams(location.search).get('topology') || 'spread';
  const state = await (await fetch(`${topology}.json`)).json();
  const workspace = Blockly.inject('workspace', {renderer: AILY_RENDERER ? 'aily-thrasos' : 'thrasos', theme: DarkTheme,
    trashcan: true, media: '/media/', grid: {spacing: 20, length: 2, colour: '#393939', snap: true},
    zoom: {controls: false, wheel: true, startScale: 1, maxScale: 1.5, minScale: 0.5, scaleSpeed: 1.05},
    move: {scrollbars: true, drag: true, wheel: false}, sounds: false});
  Object.assign(window, {Blockly, blocklyWorkspace: workspace});
  const started = performance.now();
  Blockly.Events.disable();
  try { loadBlocklyWorkspace(workspace, state); } finally {Blockly.Events.enable();}
  await Blockly.renderManagement.finishQueuedRenders();
  const loadMs = performance.now() - started;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  Object.assign(window, {benchmarkLoaded: {loadMs, readyMs: performance.now() - started,
    count: workspace.getAllBlocks(false).length, version: Blockly.VERSION}});
  document.querySelector('#status')!.textContent = `${workspace.getAllBlocks(false).length} 块 · ${Math.round(loadMs)} ms`;
}
void start().catch(error => {document.querySelector('#status')!.textContent = String(error); throw error;});
