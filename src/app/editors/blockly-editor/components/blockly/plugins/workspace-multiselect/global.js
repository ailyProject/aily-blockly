/**
 * @license
 * Copyright 2022 MIT
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Global data structure.
 */

import * as Blockly from 'blockly/core';

/**
 * Weakmap for storing multidraggable objects for a given workspace (as a key).
 */
export const multiDraggableWeakMap = new WeakMap();

/**
 * Set for storing the current selected blockSvg ids.
 */
export const dragSelectionWeakMap = new WeakMap();

/**
 * Store the current selection mode.
 */
export const inMultipleSelectionModeWeakMap = new WeakMap();

/**
 * Store the multi-select controls instances.
 */
export const multiselectControlsList = new Set();

/**
 * Store the copy data.
 */
export const copyData = new Set();

/**
 * Store the paste shortcut mode.
 */
export const inPasteShortcut = new WeakMap();

/**
 * Store the copied connections list.
 */
export const connectionDBList = [];

/**
 * Store the registered context menu list.
 */
export const registeredContextMenu = [];

/**
 * Store the registered shortcut list.
 */
export const registeredShortcut = [];

/**
 * Store the copy time.
 */
let timestamp = 0;

// TODO: Update custom enum below into actual enum
//  if plugin is updated to TypeScript.
/**
 * Object holding the names of the default shortcut items.
 */
export const shortcutNames = Object.freeze({
  MULTIDELETE: 'multiselectDelete',
  MULTICOPY: 'multiselectCopy',
  MULTICUT: 'multiselectCut',
  MULTIPASTE: 'multiselectPaste',
});

/**
 * Check if the current selected blockSvg set already contains the parents.
 * @param {!Blockly.BlockSvg} block to check.
 * @param {boolean} move Whether or not in moving.
 * @returns {boolean} true if the block's parents are selected.
 */
export const hasSelectedParent = function(block, move = false) {
  while (block) {
    if (move) {
      block = block.getParent();
    } else {
      block = block.getSurroundParent();
    }

    if (block && dragSelectionWeakMap.get(block.workspace).has(block.id)) {
      return true;
    }
  }
  return false;
};

/**
 * Returns the corresponding object related to the id in the workspace.
 * Currently only supports blocks and workspace comments
 * @param {!Blockly.Workspace} workspace to check.
 * @param {string} id The ID of the object
 * @returns {Blockly.IDraggable} The object that is draggable
 */
export const getByID = function(workspace, id) {
  // TODO: Need to figure our if there is a way to determine
  // type of draggable just from ID, or if we have to pass into
  // getById functions for each type
  if (workspace.getBlockById(id)) {
    return workspace.getBlockById(id);
  } else if (workspace.getCommentById(id)) {
    return workspace.getCommentById(id);
  }
  return null;
};

/**
 * Recursively collect all block types from a blockState object.
 * @param {Object} blockState The block state object.
 * @param {Set<string>} types Set to collect types into.
 */
const collectBlockTypes = function(blockState, types) {
  if (!blockState) return;
  if (blockState.type) types.add(blockState.type);
  // Traverse inputs (object keys with block and shadow values)
  if (blockState.inputs) {
    for (const key of Object.keys(blockState.inputs)) {
      const input = blockState.inputs[key];
      if (input && input.block) collectBlockTypes(input.block, types);
      if (input && input.shadow) collectBlockTypes(input.shadow, types);
    }
  }
  // Traverse next connection
  if (blockState.next && blockState.next.block) {
    collectBlockTypes(blockState.next.block, types);
  }
};

/**
 * Metadata about libraries from the last clipboard read.
 * Used by paste callback to determine which libraries need to be installed.
 */
export let clipboardLibraries = {};

/**
 * Store copy information for blocks in localStorage and system clipboard.
 */
export const dataCopyToStorage = function() {
  const storage = [];
  copyData.forEach((data) => {
    delete data['source'];
    storage.push(data);
  });
  timestamp = Date.now();
  localStorage.setItem('blocklyStashMulti', JSON.stringify(storage));
  localStorage.setItem('blocklyStashConnection',
      JSON.stringify(connectionDBList));
  localStorage.setItem('blocklyStashTime', timestamp);

  // Write enriched data to system clipboard for cross-instance paste
  try {
    const ailyClipboard = window.__ailyClipboard;
    if (ailyClipboard) {
      // Collect all block types and their library info
      const allTypes = new Set();
      storage.forEach((data) => {
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        if (parsed.blockState) collectBlockTypes(parsed.blockState, allTypes);
      });
      const libMap = window.__ailyBlockTypeToLibMap;
      const libraries = {};
      if (libMap) {
        allTypes.forEach((type) => {
          const info = libMap.get(type);
          if (info) libraries[type] = { name: info.name, version: info.version, localPath: info.localPath || '' };
        });
      }
      const enriched = {
        format: 'aily-blockly-clipboard',
        version: 1,
        blocks: storage,
        connections: connectionDBList.slice(),
        libraries,
        timestamp,
      };
      ailyClipboard.writeText(JSON.stringify(enriched));
    }
  } catch (e) {
    console.warn('[multiselect] Failed to write to system clipboard:', e);
  }
};

/**
 * Get copy information for blocks from system clipboard or localStorage.
 */
export const dataCopyFromStorage = function() {
  // Try system clipboard first (cross-instance)
  try {
    const ailyClipboard = window.__ailyClipboard;
    if (ailyClipboard) {
      const text = ailyClipboard.readText();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.format === 'aily-blockly-clipboard' && parsed.timestamp > timestamp) {
          timestamp = parsed.timestamp;
          copyData.clear();
          (parsed.blocks || []).forEach((data) => {
            copyData.add(data);
          });
          connectionDBList.length = 0;
          (parsed.connections || []).forEach((data) => {
            connectionDBList.push(data);
          });
          clipboardLibraries = parsed.libraries || {};
          try {
            const main = Blockly.getMainWorkspace && Blockly.getMainWorkspace();
            if (main) resetConsecutivePasteStagger(main);
          } catch (e2) {}
          return;
        }
      }
    }
  } catch (e) {
    // Not aily-blockly data or parse error, fall through to localStorage
  }

  // Fallback: localStorage (same-instance cross-tab)
  const storage = JSON.parse(localStorage.getItem('blocklyStashMulti'));
  const connection = JSON.parse(localStorage.getItem('blocklyStashConnection'));
  const time = localStorage.getItem('blocklyStashTime');
  if (storage && parseInt(time) > timestamp) {
    timestamp = time;
    copyData.clear();
    storage.forEach((data) => {
      copyData.add(data);
    });
    connectionDBList.length = 0;
    connection.forEach((data) => {
      connectionDBList.push(data);
    });
    clipboardLibraries = {};
    try {
      const main = Blockly.getMainWorkspace && Blockly.getMainWorkspace();
      if (main) resetConsecutivePasteStagger(main);
    } catch (e2) {}
  }
};

/**
 * Check for missing block types in the current clipboard data.
 * Returns an array of { blockType, name, version, localPath } for blocks whose
 * definitions are not registered yet and have library info in clipboard.
 * Also returns entries without library info (name='') so paste is blocked.
 */
export const checkMissingBlockTypes = function() {
  const allTypes = new Set();
  copyData.forEach((data) => {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (parsed.blockState) collectBlockTypes(parsed.blockState, allTypes);
  });
  const missing = [];
  const seenLibs = new Set();
  const libMap = typeof window !== 'undefined' ? window.__ailyBlockTypeToLibMap : null;
  allTypes.forEach((type) => {
    const libInfo = clipboardLibraries[type];
    const hasBlocklyDefn = !!Blockly.Blocks[type];
    const loadedForCurrentProject = libMap && typeof libMap.has === 'function' &&
        libMap.has(type);

    if (!hasBlocklyDefn) {
      if (libInfo && !seenLibs.has(libInfo.name)) {
        seenLibs.add(libInfo.name);
        missing.push({ blockType: type, name: libInfo.name, version: libInfo.version, localPath: libInfo.localPath || '' });
      } else if (!libInfo) {
        // Block type is missing and no library info available
        missing.push({ blockType: type, name: '', version: '', localPath: '' });
      }
      return;
    }
    // 定义仍在 Blockly.Blocks 中（例如粘贴安装后会话内残留），但当前项目未通过 loadLibrary 挂载到 blockTypeToLibMap
    if (libInfo && !loadedForCurrentProject && !seenLibs.has(libInfo.name)) {
      seenLibs.add(libInfo.name);
      missing.push({ blockType: type, name: libInfo.name, version: libInfo.version, localPath: libInfo.localPath || '' });
    }
  });
  return missing;
};

/**
 * Get blocks number in the clipboard from system clipboard or localStorage.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use
 *     cross tab copy/paste.
 * @returns {number} The number of blocks in the clipboard.
 */
export const blockNumGetFromStorage = function(useCopyPasteCrossTab) {
  if (!useCopyPasteCrossTab) {
    return copyData.size;
  }
  // Try system clipboard first
  try {
    const ailyClipboard = window.__ailyClipboard;
    if (ailyClipboard) {
      const text = ailyClipboard.readText();
      if (text) {
        const parsed = JSON.parse(text);
        if (parsed && parsed.format === 'aily-blockly-clipboard' && parsed.timestamp > timestamp) {
          return (parsed.blocks || []).length;
        }
      }
    }
  } catch (e) {
    // fall through
  }
  // Fallback: localStorage
  const storage = JSON.parse(localStorage.getItem('blocklyStashMulti'));
  const time = localStorage.getItem('blocklyStashTime');
  if (storage && parseInt(time) > timestamp) {
    return storage.length;
  }
  return copyData.size;
};

/**
 * Last right-click position in client coordinates (for context menu paste).
 */
export let lastContextMenuClientPosition = { x: 0, y: 0 };

// Capture right-click position for context menu paste positioning
document.addEventListener('contextmenu', function(e) {
  lastContextMenuClientPosition = { x: e.clientX, y: e.clientY };
});

/**
 * Collect all top-level blocks and bounding box from a list of pasted blocks.
 * @param {Array<Blockly.BlockSvg>} blockList The pasted blocks.
 * @returns {{topBlocks: Set, minX: number, minY: number, maxX: number, maxY: number}}
 */
const collectPastedBlockInfo = function(blockList) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const topBlocks = new Set();
  blockList.forEach(function(block) {
    if (!block || typeof block.getBoundingRectangle !== 'function') return;
    const rect = block.getBoundingRectangle();
    if (rect.left < minX) minX = rect.left;
    if (rect.top < minY) minY = rect.top;
    if (rect.right > maxX) maxX = rect.right;
    if (rect.bottom > maxY) maxY = rect.bottom;
    // Track top-level blocks (no parent) for moving
    let b = block;
    while (b.getParent()) b = b.getParent();
    topBlocks.add(b);
  });
  return { topBlocks, minX, minY, maxX, maxY };
};

/**
 * Per-workspace index for consecutive paste: each paste after the first is shifted
 * by index × (dx, dy) in workspace coordinates. Reset on copy/cut / new clipboard.
 */
const consecutivePasteStaggerIndexWeakMap = new WeakMap();

/** Workspace units. */
const CONSECUTIVE_PASTE_OFFSET_X = 24;
const CONSECUTIVE_PASTE_OFFSET_Y = 24;

/**
 * Reset stagger so the next paste is not shifted (until further pastes).
 * @param {!Blockly.WorkspaceSvg} workspace
 */
export const resetConsecutivePasteStagger = function(workspace) {
  if (!workspace) return;
  consecutivePasteStaggerIndexWeakMap.set(workspace, 0);
};

/**
 * Shift pasted top-level blocks by (n×dx, n×dy) for the n-th paste in a row; then n++.
 * @param {Array<Blockly.BlockSvg>} blockList
 * @param {!Blockly.WorkspaceSvg} workspace
 */
export const applyConsecutivePasteStagger = function(blockList, workspace) {
  if (!blockList || blockList.length === 0 || !workspace) return;
  const idx = consecutivePasteStaggerIndexWeakMap.get(workspace) || 0;
  consecutivePasteStaggerIndexWeakMap.set(workspace, idx + 1);
  const ox = idx * CONSECUTIVE_PASTE_OFFSET_X;
  const oy = idx * CONSECUTIVE_PASTE_OFFSET_Y;
  if (ox === 0 && oy === 0) return;
  const info = collectPastedBlockInfo(blockList);
  info.topBlocks.forEach(function(block) {
    block.moveBy(ox, oy);
  });
};

/**
 * Move pasted blocks so the bounding box top-left aligns with the
 * last right-click (context menu) position in workspace coordinates.
 * @param {Array<Blockly.BlockSvg>} blockList The pasted blocks.
 * @param {Blockly.WorkspaceSvg} workspace The target workspace.
 */
export const moveBlocksToMousePosition = function(blockList, workspace) {
  if (!blockList || blockList.length === 0) return;
  try {
    // Convert client coordinates to workspace coordinates via SVG CTM
    const matrix = workspace.getCanvas().getScreenCTM().inverse();
    const wsPoint = new DOMPoint(
        lastContextMenuClientPosition.x,
        lastContextMenuClientPosition.y).matrixTransform(matrix);

    const info = collectPastedBlockInfo(blockList);
    if (!isFinite(info.minX)) return;

    // Move so top-left of bounding box aligns with mouse position
    const dx = wsPoint.x - info.minX;
    const dy = wsPoint.y - info.minY;
    info.topBlocks.forEach(function(block) {
      block.moveBy(dx, dy);
    });
  } catch (e) {
    // Fallback to center if coordinate conversion fails
    centerBlocksInViewport(blockList, workspace);
  }
};

/**
 * Move pasted blocks into the visible viewport: horizontally centered; vertically
 * centered for short stacks, or top-aligned when the stack is taller than half
 * the viewport (workspace metrics via getViewMetrics(true)).
 * @param {Array<Blockly.BlockSvg>} blockList The pasted blocks.
 * @param {Blockly.WorkspaceSvg} workspace The target workspace.
 */
export const centerBlocksInViewport = function(blockList, workspace) {
  if (!blockList || blockList.length === 0) return;
  const info = collectPastedBlockInfo(blockList);
  if (!isFinite(info.minX)) return;
  const scale = workspace.scale || 1;
  const metrics = workspace.getMetrics();
  /** Viewport in workspace units (matches block coords / getBoundingRectangle). */
  let viewCenterX;
  let viewCenterY;
  let viewTop;
  let viewHeightWs;
  const metricsManager = workspace.getMetricsManager &&
      workspace.getMetricsManager();
  if (metricsManager && typeof metricsManager.getViewMetrics === 'function') {
    const vm = metricsManager.getViewMetrics(true);
    viewCenterX = vm.left + vm.width / 2;
    viewCenterY = vm.top + vm.height / 2;
    viewTop = vm.top;
    viewHeightWs = vm.height;
  } else {
    const vcX = metrics.viewLeft + metrics.viewWidth / 2;
    const vcY = metrics.viewTop + metrics.viewHeight / 2;
    viewCenterX = vcX / scale;
    viewCenterY = vcY / scale;
    viewTop = metrics.viewTop / scale;
    viewHeightWs = metrics.viewHeight / scale;
  }
  const blocksCenterX = (info.minX + info.maxX) / 2;
  const blocksCenterY = (info.minY + info.maxY) / 2;
  const bboxH = info.maxY - info.minY;
  const tallStack = bboxH > viewHeightWs * 0.5;
  const marginY = Math.min(48, viewHeightWs * 0.08);
  const dx = viewCenterX - blocksCenterX;
  const dy = tallStack ?
      (viewTop + marginY) - info.minY :
      viewCenterY - blocksCenterY;
  // Move only top-level blocks (children move with parent)
  info.topBlocks.forEach(function(block) {
    block.moveBy(dx, dy);
  });
};

/**
 * Get the next available name by incrementing trailing number.
 * @param {string} name The current field value.
 * @param {!Blockly.Workspace} workspace The workspace to check against.
 * @param {string} fieldName The field name to check.
 * @returns {string} The next available name.
 */
const getNextAvailableName = function(name, workspace, fieldName) {
  const match = name.match(/^(.*?)(\d+)$/);
  let baseName, num;
  if (match) {
    baseName = match[1];
    num = parseInt(match[2], 10);
  } else {
    baseName = name;
    num = 1;
  }

  // Collect existing field_input values with the same field name
  const existingValues = new Set();
  const allBlocks = workspace.getAllBlocks(false);
  for (const block of allBlocks) {
    for (const input of block.inputList || []) {
      for (const field of input.fieldRow || []) {
        if (field instanceof Blockly.FieldTextInput &&
            field.name === fieldName) {
          existingValues.add(field.getValue());
        }
      }
    }
  }

  if (!existingValues.has(name)) {
    return name;
  }

  let nextNum = num + 1;
  let candidate = baseName + nextNum;
  while (existingValues.has(candidate)) {
    nextNum++;
    candidate = baseName + nextNum;
  }
  return candidate;
};

/**
 * Increment field_input (FieldTextInput) values on a pasted/duplicated block
 * to generate unique names and avoid duplicates.
 * @param {!Blockly.Block} block The newly pasted/duplicated block.
 * @param {!Blockly.Workspace} workspace The target workspace.
 */
export const incrementFieldInputValues = function(block, workspace) {
  if (!block || !workspace) return;

  const descendants = block.getDescendants ?
      block.getDescendants(false) : [block];

  for (const b of descendants) {
    for (const input of b.inputList || []) {
      for (const field of input.fieldRow || []) {
        if (field instanceof Blockly.FieldTextInput) {
          const currentValue = field.getValue();
          const newValue = getNextAvailableName(
              currentValue, workspace, field.name);
          if (newValue !== currentValue) {
            field.setValue(newValue);
          }
        }
      }
    }
  }
};
