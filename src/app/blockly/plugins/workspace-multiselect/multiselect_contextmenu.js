/**
 * @license
 * Copyright 2022 MIT
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Multiple selection context menu.
 */

import * as Blockly from 'blockly/core';
import {
  dragSelectionWeakMap, hasSelectedParent, copyData,
  connectionDBList, dataCopyToStorage, dataCopyFromStorage,
  blockNumGetFromStorage, registeredContextMenu, multiDraggableWeakMap, getByID,
} from './global';
import {MultiselectDraggable} from './multiselect_draggable';

/**
 * Copy multiple selected blocks to clipboard.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use
 *     cross tab copy paste.
 */
const registerCopy = function(useCopyPasteCrossTab) {
  const id = 'blockCopyToStorage';
  const copyOptions = {
    displayText: function(scope) {
      let workableBlocksLength = 0;
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block && copyOptions.check(block)) {
          workableBlocksLength++;
        }
      });
      if (workableBlocksLength <= 1) {
        return Blockly.Msg['CROSS_TAB_COPY']?
        Blockly.Msg['CROSS_TAB_COPY'] : 'Copy';
      } else {
        return Blockly.Msg['CROSS_TAB_COPY_X_BLOCKS']?
            Blockly.Msg['CROSS_TAB_COPY_X_BLOCKS'].replace(
                '%1', workableBlocksLength) :
            (Blockly.Msg['CROSS_TAB_COPY']?
            Blockly.Msg['CROSS_TAB_COPY'] : 'Copy'
            ) + ' (' +
            workableBlocksLength + ')';
      }
    },
    preconditionFn: function(scope) {
      const workspace = scope.block.workspace;
      if (workspace.options.readOnly && !useCopyPasteCrossTab) {
        return 'hidden';
      }
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);

      // Fix the context menu error for backpack plugin
      if (dragSelection === undefined) {
        return 'hidden';
      }

      if (!dragSelection.size) {
        if (copyOptions.check(selected)) {
          return 'enabled';
        } else {
          return 'disabled';
        }
      }
      for (const id of dragSelection) {
        const block = workspace.getBlockById(id);
        if (block && copyOptions.check(block)) {
          return 'enabled';
        }
      }
      return 'disabled';
    },
    check: function(block) {
      return block && block.isDeletable() && block.isMovable() &&
             !hasSelectedParent(block);
    },
    callback: function(scope) {
      const workspace = scope.block.workspace;
      copyData.clear();
      workspace.hideChaff();
      const blockList = [];
      const apply = function(block) {
        if (copyOptions.check(block)) {
          copyData.add(JSON.stringify(block.toCopyData()));
          blockList.push(block.id);
        }
      };
      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          if (element[0] instanceof Blockly.BlockSvg) {
            apply(element[0]);
          }
        }
      } else if (!dragSelection.size) {
        apply(selected);
      }

      connectionDBList.length = 0;
      blockList.forEach(function(id) {
        const block = workspace.getBlockById(id);
        const parentBlock = block.getParent();
        if (parentBlock && blockList.indexOf(parentBlock.id) !== -1 &&
          parentBlock.getNextBlock() === block) {
          connectionDBList.push([
            blockList.indexOf(parentBlock.id),
            blockList.indexOf(block.id)]);
        }
      });
      if (useCopyPasteCrossTab) {
        dataCopyToStorage();
      }
      Blockly.Events.setGroup(false);
      return true;
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 0,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(copyOptions);
};

/**
 * Modification for context menu 'Duplicate' to be available for
 * multiple blocks.
 */
const registerDuplicate = function() {
  const id = 'blockDuplicate';
  const duplicateOption = {
    displayText: function(scope) {
      let workableBlocksLength = 0;
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (duplicateOption.check(block)) {
          workableBlocksLength++;
        }
      });
      if (workableBlocksLength <= 1) {
        return Blockly.Msg['DUPLICATE_BLOCK'];
      } else {
        return Blockly.Msg['DUPLICATE_X_BLOCKS']?
            Blockly.Msg['DUPLICATE_X_BLOCKS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['DUPLICATE_BLOCK'] + ' (' +
            workableBlocksLength + ')';
      }
    },
    preconditionFn: function(scope) {
      const block = scope.block;
      if (!block.isInFlyout && block.isDeletable() && block.isMovable()) {
        if (block.isDuplicatable()) {
          return 'enabled';
        }
        return 'disabled';
      }
      return 'hidden';
    },
    // Only duplicate-able blocks will be duplicated.
    check: function(block) {
      return block &&
             duplicateOption.preconditionFn({block: block}) === 'enabled' &&
             !hasSelectedParent(block);
    },
    callback: function(scope) {
      const duplicatedBlocks = {};
      const connectionDBList = [];
      const workspace = scope.block.workspace;
      const multiDraggable = multiDraggableWeakMap.get(workspace);
      const apply = function(block) {
        if (duplicateOption.check(block)) {
          // Generate a new unique ID
          const newId = Blockly.utils.idGenerator.genUid();
          // Get the copy data of the block
          const blockCopyData = block.toCopyData();
          // Set the new ID in the copy data
          blockCopyData.blockState.id = newId;
          // Paste the block with the modified copy data
          duplicatedBlocks[block.id] =
              Blockly.clipboard.paste(blockCopyData, workspace);
        }
      };
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // We want to update the dragSelection and the multiDraggable object to
      // remove subdraggables from the current selection prior to duplicating.
      if (dragSelection.size) {
        dragSelection.forEach(function(id) {
          const block = workspace.getBlockById(id);
          if (block) {
            block.unselect();
            if (!hasSelectedParent(block)) {
              apply(block);
            }
          }
        });
        dragSelection.clear();
        multiDraggable.clearAll_();
        Blockly.common.setSelected(null);
      } else {
        apply(scope.block);
      }

      for (const [id, block] of Object.entries(duplicatedBlocks)) {
        const origBlock = workspace.getBlockById(id);
        const origParentBlock = origBlock.getParent();
        if (block.id) {
          if (origParentBlock && origParentBlock.id in duplicatedBlocks &&
            origParentBlock.getNextBlock() === origBlock) {
            connectionDBList.push([
              duplicatedBlocks[origParentBlock.id].nextConnection,
              block.previousConnection]);
          }
          if (block.type !== 'drag_to_dupe') {
            dragSelection.add(block.id);
            multiDraggable.addSubDraggable_(block);
          }
        }
      }
      connectionDBList.forEach(function(connectionDB) {
        connectionDB[0].connect(connectionDB[1]);
      });
      Blockly.common.setSelected(multiDraggable);
      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 1,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(duplicateOption);
};

/**
 * Modification for context menu 'Comment' to be available for multiple blocks.
 */
const registerBlockComment = function() {
  const id = 'blockComment';
  const commentOption = {
    displayText: function(scope) {
      let workableBlocksLength = 0;
      const state = scope.block.hasIcon(Blockly.icons.CommentIcon.TYPE);
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (commentOption.check(block) && state === block.hasIcon(
            Blockly.icons.CommentIcon.TYPE)) {
          workableBlocksLength++;
        }
      });
      if (state) {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['REMOVE_COMMENT'];
        } else {
          return Blockly.Msg['REMOVE_X_COMMENTS']?
            Blockly.Msg['REMOVE_X_COMMENTS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['REMOVE_COMMENT'] + ' (' +
            workableBlocksLength + ')';
        }
      } else {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['ADD_COMMENT'];
        } else {
          return Blockly.Msg['ADD_X_COMMENTS']?
            Blockly.Msg['ADD_X_COMMENTS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['ADD_COMMENT'] + ' (' +
            workableBlocksLength + ')';
        }
      }
    },
    preconditionFn: function(scope) {
      const block = scope.block;
      if (!Blockly.utils.userAgent.IE && !block.isInFlyout &&
        block.workspace.options.comments && !block.isCollapsed() &&
        block.isEditable()) {
        return 'enabled';
      }
      return 'hidden';
    },
    check: function(block) {
      return block &&
             commentOption.preconditionFn({block: block}) === 'enabled';
    },
    callback: function(scope) {
      const hasCommentIcon = scope.block.hasIcon(
          Blockly.icons.CommentIcon.TYPE);
      const apply = function(block) {
        if (commentOption.check(block)) {
          if (hasCommentIcon) {
            block.setCommentText(null);
          } else {
            block.setCommentText('');
          }
        }
      };
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);
      if (!dragSelection.size) {
        apply(scope.block);
      }
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block) {
          apply(block);
        }
      });
      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 2,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(commentOption);
};

/**
 * Modification for context menu 'Inline' to be available for multiple blocks.
 */
const registerInline = function() {
  const id = 'blockInline';
  const inlineOption = {
    displayText: function(scope) {
      let workableBlocksLength = 0;
      const state = scope.block.getInputsInline();
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (inlineOption.check(block) &&
            block.getInputsInline() === state) {
          workableBlocksLength++;
        }
      });
      if (state) {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['EXTERNAL_INPUTS'];
        } else {
          return Blockly.Msg['EXTERNAL_X_INPUTS']?
            Blockly.Msg['EXTERNAL_X_INPUTS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['EXTERNAL_INPUTS'] + ' (' +
            workableBlocksLength + ')';
        }
      } else {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['INLINE_INPUTS'];
        } else {
          return Blockly.Msg['INLINE_X_INPUTS']?
            Blockly.Msg['INLINE_X_INPUTS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['INLINE_INPUTS'] + ' (' +
            workableBlocksLength + ')';
        }
      }
    },
    preconditionFn: function(scope) {
      const block = scope.block;
      if (!block.isInFlyout && block.isMovable() && !block.isCollapsed()) {
        for (let i = 1; i < block.inputList.length; i++) {
          // Only display this option if there are two value or dummy inputs
          // next to each other.
          if (block.inputList[i - 1].type !==
              Blockly.inputs.inputTypes.STATEMENT &&
            block.inputList[i].type !== Blockly.inputs.inputTypes.STATEMENT) {
            return 'enabled';
          }
        }
      }
      return 'hidden';
    },
    check: function(block) {
      return block &&
             inlineOption.preconditionFn({block: block}) === 'enabled';
    },
    callback: function(scope) {
      const state = !scope.block.getInputsInline();
      const apply = function(block) {
        if (inlineOption.check(block)) {
          block.setInputsInline(state);
        }
      };
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);
      if (!dragSelection.size) {
        apply(scope.block);
      }
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block) {
          apply(block);
        }
      });
      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 3,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(inlineOption);
};

/**
 * Modification for context menu 'Collapse/Expand' to be available for
 * multiple blocks.
 */
const registerCollapseExpandBlock = function() {
  const id = 'blockCollapseExpand';
  const collapseExpandOption = {
    displayText: function(scope) {
      let workableBlocksLength = 0;
      const state = scope.block.isCollapsed();
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (collapseExpandOption.check(block) &&
            block.isCollapsed() === state) {
          workableBlocksLength++;
        }
      });
      if (state) {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['EXPAND_BLOCK'];
        } else {
          return Blockly.Msg['EXPAND_X_BLOCKS']?
            Blockly.Msg['EXPAND_X_BLOCKS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['EXPAND_BLOCK'] + ' (' +
            workableBlocksLength + ')';
        }
      } else {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['COLLAPSE_BLOCK'];
        } else {
          return Blockly.Msg['COLLAPSE_X_BLOCKS']?
            Blockly.Msg['COLLAPSE_X_BLOCKS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['COLLAPSE_BLOCK'] + ' (' +
            workableBlocksLength + ')';
        }
      }
    },
    preconditionFn: function(scope) {
      const block = scope.block;
      if (!block.isInFlyout && block.isMovable() &&
        block.workspace.options.collapse) {
        return 'enabled';
      }
      return 'hidden';
    },
    check: function(block) {
      return block &&
             collapseExpandOption.preconditionFn({block: block}) ===
             'enabled' && (!hasSelectedParent(block) ||
             block.isCollapsed());
    },
    callback: function(scope) {
      const state = !scope.block.isCollapsed();
      const apply = function(block) {
        if (collapseExpandOption.check(block)) {
          block.setCollapsed(state);
        }
      };
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);
      if (!dragSelection.size) {
        apply(scope.block);
      }
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block) {
          apply(block);
        }
      });
      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 4,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(collapseExpandOption);
};

/**
 * Modification for context menu 'Disable' to be available for multiple blocks.
 */
const registerDisable = function() {
  const id = 'blockDisable';
  const disableOption = {
    displayText: function(scope) {
      let workableBlocksLength = 0;
      const state = scope.block.isEnabled();
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (disableOption.check(block) &&
            block.isEnabled() === state) {
          workableBlocksLength++;
        }
      });
      if (state) {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['DISABLE_BLOCK'];
        } else {
          return Blockly.Msg['DISABLE_X_BLOCKS']?
            Blockly.Msg['DISABLE_X_BLOCKS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['DISABLE_BLOCK'] + ' (' +
            workableBlocksLength + ')';
        }
      } else {
        if (workableBlocksLength <= 1) {
          return Blockly.Msg['ENABLE_BLOCK'];
        } else {
          return Blockly.Msg['ENABLE_X_BLOCKS']?
            Blockly.Msg['ENABLE_X_BLOCKS'].replace(
                '%1', workableBlocksLength) :
            Blockly.Msg['ENABLE_BLOCK'] + ' (' +
            workableBlocksLength + ')';
        }
      }
    },
    preconditionFn: function(scope) {
      const block = scope.block;
      if (!block.isInFlyout && block.workspace.options.disable &&
          block.isEditable()) {
        if (block.getInheritedDisabled()) {
          return 'disabled';
        }
        return 'enabled';
      }
      return 'hidden';
    },
    check: function(block) {
      return block &&
             disableOption.preconditionFn({block: block}) === 'enabled' &&
             (!hasSelectedParent(block) || !block.isEnabled());
    },
    callback: function(scope) {
      const state = !scope.block.isEnabled();
      const apply = function(block) {
        if (disableOption.check(block)) {
          block.setEnabled(state);
        }
      };
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);
      if (!dragSelection.size) {
        apply(scope.block);
      }
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block) {
          apply(block);
        }
      });
      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 5,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(disableOption);
};

/**
 * Modification for context menu 'Delete' to be available for multiple blocks.
 */
const registerDelete = function() {
  const id = 'blockDelete';
  const deleteOption = {
    displayText: function(scope) {
      let descendantCount = 0;
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const block = workspace.getBlockById(id);
        if (block && !hasSelectedParent(block)) {
          // Count the number of blocks that are nested in this block.
          descendantCount += block.getDescendants(false).length;
          for (const subBlocks of block.getDescendants(false)) {
            if (subBlocks.isShadow()) {
              descendantCount -= 1;
            }
          }
          const nextBlock = block.getNextBlock();
          if (nextBlock) {
            // Blocks in the current stack would survive this block's deletion.
            descendantCount -= nextBlock.getDescendants(false).length;
          }
        }
      });
      return (descendantCount <= 1) ?
        Blockly.Msg['DELETE_BLOCK'] :
        Blockly.Msg['DELETE_X_BLOCKS'].replace('%1', String(descendantCount));
    },
    preconditionFn: function(scope) {
      if (!scope.block.isInFlyout && scope.block.isDeletable()) {
        return 'enabled';
      }
      return 'hidden';
    },
    check: function(block) {
      return block && !block.workspace.isFlyout &&
             deleteOption.preconditionFn({block: block}) === 'enabled' &&
             !hasSelectedParent(block);
    },
    callback: function(scope) {
      const apply = function(block) {
        if (deleteOption.check(block)) {
          block.workspace.hideChaff();
          if (block.outputConnection) {
            block.dispose(false, true);
          } else {
            block.dispose(true, true);
          }
        }
      };
      const workspace = scope.block.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      const selected = Blockly.common.getSelected();
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          element[0].unselect();
          if (element[0] instanceof Blockly.BlockSvg) {
            apply(element[0]);
          }
        }
        dragSelection.clear();
        selected.clearAll_();
      } else if (!dragSelection.size) {
        apply(selected);
      }

      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
    id,
    weight: 6,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(deleteOption);
};

/**
 * Paste multiple selected draggables from clipboard.
 * @param {boolean} useCopyPasteCrossTab Whether to use cross tab copy paste.
 */
const registerPaste = function(useCopyPasteCrossTab) {
  const id = 'blockPasteFromStorage';
  const pasteOption = {
    displayText: function() {
      const workableDraggableLength =
          blockNumGetFromStorage(useCopyPasteCrossTab);
      if (workableDraggableLength <= 1) {
        return Blockly.Msg['CROSS_TAB_PASTE']?
          Blockly.Msg['CROSS_TAB_PASTE'] : 'Paste';
      } else {
        return Blockly.Msg['CROSS_TAB_PASTE_X_ELEMENTS']?
            Blockly.Msg['CROSS_TAB_PASTE_X_ELEMENTS'].replace(
                '%1', workableDraggableLength) :
            (Blockly.Msg['CROSS_TAB_PASTE']?
            Blockly.Msg['CROSS_TAB_PASTE'] : 'Paste'
            ) + ' (' +
            workableDraggableLength + ')';
      }
    },
    preconditionFn: function(scope) {
      return scope.workspace.options.readOnly?
        'hidden': (blockNumGetFromStorage(useCopyPasteCrossTab) < 1?
          'disabled': 'enabled');
    },
    callback: function(scope) {
      let workspace = scope.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);
      const multiDraggable = multiDraggableWeakMap.get(workspace);

      // Update the dragSelection and multiDraggable object
      // to remove current selection prior to pasting.
      if (dragSelection.size) {
        dragSelection.forEach(function(id) {
          const element = getByID(workspace, id);
          element.unselect();
        });
        dragSelection.clear();
        multiDraggable.clearAll_();
      }

      const blockList = [];
      if (useCopyPasteCrossTab) {
        dataCopyFromStorage();
      }
      copyData.forEach(function(stringData) {
        // Pasting always pastes to the main workspace, even if the copy
        // started in a flyout workspace.
        const data = JSON.parse(stringData);

        // Set unique id for data to prevent bug where
        // blocks on multiple workspaces are highlighted.
        if (workspace.id !== Blockly.getMainWorkspace().id) {
          if (data.blockState) {
            data.blockState.id = Blockly.utils.idGenerator.genUid();
          } else if (data.commentState) {
            data.commentState.id = Blockly.utils.idGenerator.genUid();
          }
        }

        if (data.source) {
          workspace = data.source;
        }
        if (workspace.isFlyout) {
          workspace = workspace.targetWorkspace;
        }
        if (data.typeCounts &&
            workspace.isCapacityAvailable(data.typeCounts)) {
          const element = Blockly.clipboard.paste(data, workspace);
          if (element) {
            blockList.push(element);
          }
          if (element.type !== 'drag_to_dupe') {
            dragSelectionWeakMap.get(workspace).add(element.id);
            multiDraggableWeakMap.get(workspace).addSubDraggable_(element);
          }
        } else if (data.commentState) {
          const element = Blockly.clipboard.paste(data, workspace);
          if (element) {
            element.select();
          }
          dragSelectionWeakMap.get(workspace).add(element.id);
          multiDraggableWeakMap.get(workspace).addSubDraggable_(element);
        }
      });
      connectionDBList.forEach(function(connectionDB) {
        blockList[connectionDB[0]].nextConnection.connect(
            blockList[connectionDB[1]].previousConnection);
      });
      Blockly.Events.setGroup(false);
      Blockly.common.setSelected(multiDraggable);
      return true;
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    id,
    weight: 0,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(pasteOption);
};

/**
 * Add context menu 'Select all Blocks' for workspace.
 */
const registerSelectAll = function() {
  const id = 'workspaceSelectAll';
  const selectAllOption = {
    displayText: function() {
      return 'Select all Blocks';
    },
    preconditionFn: function(scope) {
      return scope.workspace.getTopBlocks().some(
          (b) => selectAllOption.check(b)) ? 'enabled' : 'disabled';
    },
    check: function(block) {
      return block &&
             (block.isDeletable() || block.isMovable()) &&
             !block.isInsertionMarker();
    },
    callback: function(scope) {
      const multiDraggable = multiDraggableWeakMap.get(scope.workspace);

      // Make sure that there is nothing in the multiDraggable (clearing)
      // prior to selecting all blocks in workspace.
      if (Blockly.getSelected()) {
        if (Blockly.getSelected() instanceof MultiselectDraggable) {
          for (const [subDraggable] of Blockly.getSelected().subDraggables) {
            subDraggable.unselect();
          }
        } else {
          Blockly.getSelected().unselect();
        }
        Blockly.common.setSelected(null);
        multiDraggable.clearAll_();
        dragSelectionWeakMap.get(scope.workspace).clear();
      }

      const blockList = [];
      scope.workspace.getTopBlocks().forEach(function(block) {
        if (selectAllOption.check(block)) {
          blockList.push(block);
          let nextBlock = block.getNextBlock();
          while (nextBlock) {
            blockList.push(nextBlock);
            nextBlock = nextBlock.getNextBlock();
          }
        }
      });
      blockList.forEach(function(block) {
        if (block.type !== 'drag_to_dupe') {
          dragSelectionWeakMap.get(block.workspace).add(block.id);
          multiDraggable.addSubDraggable_(block);
        }
      });

      Blockly.common.setSelected(multiDraggable);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.WORKSPACE,
    id,
    weight: 5,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(selectAllOption);
};

/**
 * Registers copy to back pack context menu item in back pack.
 * @param {boolean} disablePreconditionContainsCheck Option for
 *                  the back pack plugin, default is false.
 */
const updateToMultiCopyToBackpack =
    function(disablePreconditionContainsCheck = false) {
      const id = 'copy_to_backpack';
      const copyToBackpack = {
        getBackPack: function(ws) {
          return ws
              .getComponentManager()
              .getComponent('backpack');
        },
        check: function(block) {
          if (!block) return false;
          const ws = block.workspace;
          const backpack = copyToBackpack.getBackPack(ws);
          return backpack &&
             !backpack.containsBlock(block) &&
             !hasSelectedParent(block);
        },
        displayText: function(scope) {
          if (!scope.block) {
            return '';
          }
          const ws = scope.block.workspace;
          const backpack = copyToBackpack.getBackPack(ws);
          if (!backpack) {
            return '';
          }
          const backpackCount = backpack.getCount();
          let workableBlocksLength = 0;
          const dragSelection = dragSelectionWeakMap.get(ws);
          if (!dragSelection.size) {
            if (copyToBackpack.check(scope.block)) {
              workableBlocksLength++;
            }
          }
          for (const id of dragSelection) {
            if (copyToBackpack.check(ws.getBlockById(id))) {
              workableBlocksLength++;
            }
          }
          return `(${workableBlocksLength}) ` +
             `${Blockly.Msg['COPY_TO_BACKPACK']} (${backpackCount})`;
        },
        preconditionFn: function(scope) {
          if (!scope.block) return 'hidden';
          const ws = scope.block.workspace;
          if (!ws.isFlyout) {
            if (!copyToBackpack.getBackPack(ws)) {
              return 'hidden';
            }
            if (disablePreconditionContainsCheck) {
              return 'enabled';
            }
            const dragSelection = dragSelectionWeakMap.get(ws);
            if (!dragSelection.size) {
              if (copyToBackpack.check(scope.block)) {
                return 'enabled';
              }
            }
            for (const id of dragSelection) {
              if (copyToBackpack.check(ws.getBlockById(id))) {
                return 'enabled';
              }
            }
            return 'disabled';
          }
          return 'hidden';
        },
        callback: function(scope) {
          if (!scope.block) return;
          const ws = scope.block.workspace;
          const backpack = copyToBackpack.getBackPack(ws);
          const dragSelection = dragSelectionWeakMap.get(ws);
          if (!dragSelection.size) {
            if (copyToBackpack.check(scope.block)) {
              backpack.addBlock(scope.block);
            }
          }
          dragSelection.forEach(function(id) {
            const block = ws.getBlockById(id);
            if (copyToBackpack.check(block)) {
              backpack.addBlock(block);
            }
          });
        },
        scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
        id,
        // Use a larger weight to push the option lower on the context menu.
        weight: 200,
      };
      if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
        Blockly.ContextMenuRegistry.registry.unregister(id);
      }
      Blockly.ContextMenuRegistry.registry.register(copyToBackpack);
    };

/**
 * Modification for context menu 'commentDelete' to
 * be available for multiple comments.
 */
const registerCommentDelete = function() {
  const id = 'commentDelete';
  const deleteOption = {
    displayText: function(scope) {
      let count = 0;
      const workspace = scope.comment.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const comment = workspace.getCommentById(id);
        if (comment) {
          // Count the number of blocks that are nested in this block.
          count += 1;
        }
      });
      if (count <= 1) {
        return Blockly.Msg['REMOVE_COMMENT'];
      } else {
        return Blockly.Msg['REMOVE_X_COMMENTS']?
            Blockly.Msg['REMOVE_X_COMMENTS'].replace(
                '%1', count) :
            Blockly.Msg['REMOVE_COMMENT'] + ' (' +
            count + ')';
      }
    },
    preconditionFn: function(scope) {
      if (scope.comment.isDeletable()) {
        return 'enabled';
      }
      return 'hidden';
    },
    check: function(comment) {
      return comment &&
          deleteOption.preconditionFn({comment: comment}) === 'enabled';
    },
    callback: function(scope) {
      const apply = function(comment) {
        if (deleteOption.check(comment)) {
          comment.workspace.hideChaff();
          comment.dispose();
        }
      };
      const workspace = scope.comment.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      const selected = Blockly.common.getSelected();
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          element[0].unselect();
          if (element[0] instanceof
              Blockly.comments.RenderedWorkspaceComment) {
            apply(element[0]);
          }
        }
        dragSelection.clear();
        selected.clearAll_();
      } else if (!dragSelection.size) {
        apply(scope.comment);
      }

      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.COMMENT,
    id,
    weight: 6,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(deleteOption);
};

/**
 * Modification for context menu 'commentDuplicate' to be available for
 * multiple comments.
 */
const registerCommentDuplicate = function() {
  const id = 'commentDuplicate';
  const duplicateOption = {
    displayText: function(scope) {
      let count = 0;
      const workspace = scope.comment.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const comment = workspace.getCommentById(id);
        if (comment) {
          count += 1;
        }
      });
      if (count <= 1) {
        return Blockly.Msg['DUPLICATE_COMMENT'];
      } else {
        return Blockly.Msg['DUPLICATE_X_COMMENTS']?
            Blockly.Msg['DUPLICATE_X_COMMENTS'].replace(
                '%1', count) :
            Blockly.Msg['DUPLICATE_COMMENT'] + ' (' +
            count + ')';
      }
    },
    preconditionFn: function(scope) {
      const comment = scope.comment;
      if (comment.isDeletable() && comment.isMovable()) {
        return 'enabled';
      }
      return 'hidden';
    },
    check: function(comment) {
      return comment && duplicateOption.preconditionFn({comment: comment}) ===
          'enabled';
    },
    callback: function(scope) {
      const duplicatedComments = {};
      const workspace = scope.comment.workspace;
      const multiDraggable = multiDraggableWeakMap.get(workspace);
      const apply = function(comment) {
        if (duplicateOption.check(comment)) {
          // Generate a new unique ID
          const newId = Blockly.utils.idGenerator.genUid();
          // Get the copy data of the block
          const commentCopyData = comment.toCopyData();
          // Set the new ID in the copy data
          commentCopyData.commentState.id = newId;
          // Paste the block with the modified copy data
          duplicatedComments[comment.id] =
              Blockly.clipboard.paste(commentCopyData, workspace);
        }
      };
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // We want to update the dragSelection and the multiDraggable object to
      // remove subdraggables from the current selection prior to duplicating.
      if (dragSelection.size) {
        dragSelection.forEach(function(id) {
          const comment = workspace.getCommentById(id);
          if (comment) {
            comment.unselect();
            apply(comment);
          }
        });
        dragSelection.clear();
        multiDraggable.clearAll_();
        Blockly.common.setSelected(null);
      } else {
        apply(scope.comment);
      }

      for (const [, comment] of Object.entries(duplicatedComments)) {
        if (comment.id) {
          dragSelection.add(comment.id);
          multiDraggable.addSubDraggable_(comment);
          comment.select();
        }
      }
      Blockly.common.setSelected(multiDraggable);
      Blockly.Events.setGroup(false);
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.COMMENT,
    id,
    weight: 1,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(duplicateOption);
};

/**
 * Copy multiple selected comments to clipboard.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use
 *     cross tab copy paste.
 */
const registerCommentCopy = function(useCopyPasteCrossTab) {
  const id = 'commentCopyToStorage';
  const copyOptions = {
    displayText: function(scope) {
      let workableCommentsLength = 0;
      const workspace = scope.comment.workspace;
      const dragSelection = dragSelectionWeakMap.get(workspace);
      dragSelection.forEach(function(id) {
        const comment = workspace.getCommentById(id);
        if (comment) {
          if (copyOptions.check(comment)) {
            workableCommentsLength++;
          }
        }
      });
      if (workableCommentsLength <= 1) {
        return Blockly.Msg['CROSS_TAB_COPY']?
            Blockly.Msg['CROSS_TAB_COPY'] : 'Copy';
      } else {
        return Blockly.Msg['CROSS_TAB_COPY_X_COMMENTS']?
            Blockly.Msg['CROSS_TAB_COMMENTS'].replace(
                '%1', workableCommentsLength) :
            (Blockly.Msg['CROSS_TAB_COPY']?
                    Blockly.Msg['CROSS_TAB_COPY'] : 'Copy'
            ) + ' (' +
            workableCommentsLength + ')';
      }
    },
    preconditionFn: function(scope) {
      const workspace = scope.comment.workspace;
      if (workspace.options.readOnly && !useCopyPasteCrossTab) {
        return 'hidden';
      }

      const dragSelection = dragSelectionWeakMap.get(workspace);

      // Fix the context menu error for backpack plugin
      if (dragSelection === undefined) {
        return 'hidden';
      }

      if (!dragSelection.size) {
        if (copyOptions.check(scope.comment)) {
          return 'enabled';
        } else {
          return 'disabled';
        }
      }
      for (const id of dragSelection) {
        const comment = workspace.getCommentById(id);
        if (comment) {
          if (copyOptions.check(comment)) {
            return 'enabled';
          }
        }
      }
      return 'disabled';
    },
    check: function(comment) {
      return comment && comment.isDeletable() &&
          comment.isMovable();
    },
    callback: function(scope) {
      const workspace = scope.comment.workspace;
      copyData.clear();
      workspace.hideChaff();

      const apply = function(comm) {
        if (copyOptions.check(comm)) {
          copyData.add(JSON.stringify(comm.toCopyData()));
        }
      };

      const selected = Blockly.common.getSelected();
      const dragSelection = dragSelectionWeakMap.get(workspace);
      Blockly.Events.setGroup(true);

      // Handle the case where MultiselectDraggable is in use
      if (selected && selected instanceof MultiselectDraggable) {
        for (const element of selected.subDraggables) {
          if (element[0] instanceof Blockly.comments.RenderedWorkspaceComment) {
            apply(element[0]);
          }
        }
      } else if (!dragSelection.size) {
        apply(scope.comment);
      }

      if (useCopyPasteCrossTab) {
        dataCopyToStorage();
      }
      Blockly.Events.setGroup(false);
      return true;
    },
    scopeType: Blockly.ContextMenuRegistry.ScopeType.COMMENT,
    id,
    weight: 0,
  };
  if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
    Blockly.ContextMenuRegistry.registry.unregister(id);
  }
  Blockly.ContextMenuRegistry.registry.register(copyOptions);
};

/**
 * Unregister context menu item, should be called before registering.
 */
export const unregisterContextMenu = function() {
  registeredContextMenu.length = 0;
  for (const id of ['blockDuplicate', 'blockComment', 'blockInline',
    'blockCollapseExpand', 'blockDisable', 'blockDelete', 'commentDelete',
    'commentDuplicate']) {
    if (Blockly.ContextMenuRegistry.registry.getItem(id) !== null) {
      Blockly.ContextMenuRegistry.registry.unregister(id);
    }
    registeredContextMenu.push(id);
  }
};

/**
 * Register default context menu item.
 */
export const registerOrigContextMenu = function() {
  const map = {
    blockDuplicate: Blockly.ContextMenuItems.registerDuplicate,
    blockComment: Blockly.ContextMenuItems.registerComment,
    blockInline: Blockly.ContextMenuItems.registerInline,
    blockCollapseExpand: Blockly.ContextMenuItems.registerCollapseExpandBlock,
    blockDisable: Blockly.ContextMenuItems.registerDisable,
    blockDelete: Blockly.ContextMenuItems.registerDelete,
    commentDelete: Blockly.ContextMenuItems.registerCommentDelete,
    commentDuplicate: Blockly.ContextMenuItems.registerCommentDuplicate,
  };
  for (const id of registeredContextMenu) {
    map[id]();
  }
};

/**
 * Registers all modified context menu item.
 * @param {boolean} useCopyPasteMenu Whether to use copy/paste menu.
 * @param {boolean} useCopyPasteCrossTab Whether to use cross tab copy/paste.
 */
export const registerOurContextMenu = function(useCopyPasteMenu, useCopyPasteCrossTab) {
  if (useCopyPasteMenu) {
    registerCopy(useCopyPasteCrossTab);
    registerPaste(useCopyPasteCrossTab);
    registerCommentCopy(useCopyPasteCrossTab);
  }
  const map = {
    blockDuplicate: registerDuplicate,
    blockComment: registerBlockComment,
    blockInline: registerInline,
    blockCollapseExpand: registerCollapseExpandBlock,
    blockDisable: registerDisable,
    blockDelete: registerDelete,
    commentDelete: registerCommentDelete,
    commentDuplicate: registerCommentDuplicate,
  };
  for (const id of registeredContextMenu) {
    map[id]();
  }
  registerSelectAll();
  updateToMultiCopyToBackpack();
};
