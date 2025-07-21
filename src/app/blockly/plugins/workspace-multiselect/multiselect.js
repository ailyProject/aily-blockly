/**
 * @license
 * Copyright 2022 MIT
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Plugin main class.
 */

import * as Blockly from 'blockly/core';

import * as ContextMenu from './multiselect_contextmenu';
import * as Shortcut from './multiselect_shortcut';
import {
  dragSelectionWeakMap, inMultipleSelectionModeWeakMap,
  hasSelectedParent,
  multiselectControlsList, multiDraggableWeakMap,
} from './global';
import {MultiselectControls} from './multiselect_controls';
import {MultiselectDraggable} from './multiselect_draggable';

/**
 * Class for using multiple select blocks on workspace.
 */
export class Multiselect {
  /**
   * Initialize the class data structure.
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to sit in.
   */
  constructor(workspace) {
    this.workspace_ = workspace;
    this.origHandleWsStart_ = Blockly.Gesture.prototype.handleWsStart;

    dragSelectionWeakMap.set(this.workspace_, new Set());
    multiDraggableWeakMap.set(this.workspace_,
        new MultiselectDraggable(this.workspace_));
    this.dragSelection_ = dragSelectionWeakMap.get(this.workspace_);
    inMultipleSelectionModeWeakMap.set(this.workspace_, false);
    this.useCopyPasteCrossTab_ = true;
    this.useCopyPasteMenu_ = true;
    this.multiFieldUpdate_ = true;
    this.multiSelectKeys_ = ['shift'];
    this.registeredShortcut_ = true;
  }

  /**
   * Bind the events and replace registration.
   * @param {Object} options
   * to set.
   */
  init(options) {
    if (options.multiSelectKeys && options.multiSelectKeys.length > 0) {
      this.multiSelectKeys_ = options.multiSelectKeys.map((key) => {
        return key.toLocaleLowerCase();
      });
    }
    const injectionDiv = this.workspace_.getInjectionDiv();
    this.onKeyDownWrapper_ = Blockly.browserEvents.conditionalBind(
        injectionDiv, 'keydown', this, this.onKeyDown_);
    this.onKeyUpWrapper_ = Blockly.browserEvents.conditionalBind(
        injectionDiv, 'keyup', this, this.onKeyUp_);
    this.onFocusOutWrapper_ = Blockly.browserEvents.conditionalBind(
        injectionDiv, 'focusout', this, this.onBlur_);
    injectionDiv.addEventListener('mouseenter', () => {
      if (options.workspaceAutoFocus === false ||
          document.activeElement === this.workspace_.svgGroup_.parentElement ||
          document.activeElement.nodeName.toLowerCase() === 'input' ||
          document.activeElement.nodeName.toLowerCase() === 'textarea') {
        return;
      }
      this.workspace_.svgGroup_.parentElement.focus();
    });
    this.eventListenerWrapper_ = this.eventListener_.bind(this);
    this.workspace_.addChangeListener(this.eventListenerWrapper_);

    this.eventListenerAllWrapper_ = this.eventListenerAll_.bind(this);
    Blockly.Workspace.getAll().forEach((ws) => {
      ws.addChangeListener(this.eventListenerAllWrapper_);
    });

    if (options.multiselectCopyPaste &&
        options.multiselectCopyPaste.crossTab === false) {
      this.useCopyPasteCrossTab_ = false;
    }

    if (options.multiselectCopyPaste &&
        options.multiselectCopyPaste.menu === false) {
      this.useCopyPasteMenu_ = false;
    }

    if (!Blockly.ContextMenuRegistry.registry.getItem('workspaceSelectAll')) {
      ContextMenu.unregisterContextMenu();
      ContextMenu.registerOurContextMenu(this.useCopyPasteMenu_,
          this.useCopyPasteCrossTab_);
      Shortcut.unregisterOrigShortcut();
      Shortcut.registerOurShortcut(this.useCopyPasteCrossTab_);
    }

    this.controls_ = new MultiselectControls(
        this.workspace_, options.multiselectIcon, this.multiSelectKeys_);
    multiselectControlsList.add(this.controls_);
    if (!options.multiselectIcon || !options.multiselectIcon.hideIcon) {
      const svgControls = this.controls_.createDom();
      this.workspace_.getParentSvg().appendChild(svgControls);
    }
    this.controls_.init(options.multiselectIcon.hideIcon,
        options.multiselectIcon.weight);

    if (options.useDoubleClick) {
      this.useDoubleClick_(true);
    }

    if (options.multiFieldUpdate === false) {
      this.multiFieldUpdate_ = false;
    }

    if (!options.bumpNeighbours) {
      this.origBumpNeighbours = Blockly.BlockSvg.prototype.bumpNeighbours;
      Blockly.BlockSvg.prototype.bumpNeighbours = function() {};
    }

    Blockly.browserEvents.conditionalBind(
        injectionDiv, 'keydown', this, this.unbindMultiselectCopyPaste_
    );

    // This is for the keyboard navigation plugin and checks whether it puts
    // the workspace into keyboard accessibility mode by default.
    if (this.workspace_.keyboardAccessibilityMode) {
      Shortcut.unregisterOurShortcut();
      this.registeredShortcut_ = false;
    }
  }

  /**
   * Ignore multi-field updates within the given function.
   * @param {Function} func The function to call.
   */
  static withoutMultiFieldUpdates(func) {
    const oldGroup = Blockly.Events.getGroup();
    // Note that this depends on the fact that
    // eventListener_ will ignore events with a group ID.
    if (!oldGroup) {
      Blockly.Events.setGroup(true);
    }
    try {
      func();
    } finally {
      Blockly.Events.setGroup(oldGroup);
    }
  }

  /**
   * Update the multiselect icon in runtime.
   * @param {string} enabledIcon The icon for enabled state.
   * @param {string} disabledIcon The icon for disabled state.
   */
  setMultiselectIcon(enabledIcon, disabledIcon) {
    if (!this.controls_) {
      return;
    }
    this.controls_.enabled_img = enabledIcon;
    this.controls_.disabled_img = disabledIcon;
    this.controls_.updateMultiselectIcon(this.controls_.enabled);
  }

  /**
   * Unbind the events and replace with original registration.
   * @param {boolean} keepRegistry Keep the context menu and shortcut registry.
   */
  dispose(keepRegistry = false) {
    if (this.onKeyDownWrapper_) {
      Blockly.browserEvents.unbind(this.onKeyDownWrapper_);
      this.onKeyDownWrapper_ = null;
    }
    if (this.onKeyUpWrapper_) {
      Blockly.browserEvents.unbind(this.onKeyUpWrapper_);
      this.onKeyUpWrapper_ = null;
    }
    if (this.onFocusOutWrapper_) {
      Blockly.browserEvents.unbind(this.onFocusOutWrapper_);
      this.onFocusOutWrapper_ = null;
    }
    if (this.eventListenerWrapper_) {
      this.workspace_.removeChangeListener(this.eventListenerWrapper_);
      this.eventListenerWrapper_ = null;
    }
    if (this.eventListenerAllWrapper_) {
      Blockly.Workspace.getAll().forEach((ws) => {
        ws.removeChangeListener(this.eventListenerAllWrapper_);
      });
      this.eventListenerAllWrapper_ = null;
    }
    if (!keepRegistry) {
      ContextMenu.unregisterContextMenu();
      if (this.useCopyPasteMenu_) {
        Blockly.ContextMenuRegistry.registry.unregister('blockCopyToStorage');
        Blockly.ContextMenuRegistry.registry
            .unregister('blockPasteFromStorage');
      }
      Blockly.ContextMenuRegistry.registry.unregister('workspaceSelectAll');
      Blockly.ContextMenuRegistry.registry.unregister('copy_to_backpack');
      ContextMenu.registerOrigContextMenu();

      Shortcut.unregisterOrigShortcut();
      Blockly.ShortcutRegistry.registry.unregister('selectall');
      Shortcut.registerOrigShortcut();
    }

    if (this.controls_) {
      multiselectControlsList.delete(this.controls_);
      this.controls_.dispose();
      this.controls_ = null;
    }

    this.useDoubleClick_(false);

    if (this.origBumpNeighbours) {
      Blockly.BlockSvg.prototype.bumpNeighbours = this.origBumpNeighbours;
    }
  }

  /**
   * Add double click to expand/collapse blocks (MIT App Inventor Supported).
   * @param {!boolean} on Whether to turn on the mode.
   * @private
   */
  useDoubleClick_(on) {
    if (!on) {
      Blockly.Gesture.prototype.handleWsStart = this.origHandleWsStart_;
      return;
    }

    Blockly.Gesture.prototype.handleWsStart = (function(func) {
      if (func.isWrapped) {
        return func;
      }

      const wrappedFunc = function(e, ws) {
        func.call(this, e, ws);
        if (this.targetBlock && e.buttons === 1 &&
            !inMultipleSelectionModeWeakMap.get(ws)) {
          const preCondition = function(block) {
            return !block.isInFlyout && block.isMovable() &&
                block.workspace.options.collapse;
          };

          const selected = Blockly.getSelected();
          const maybeCollapse = function(block, blockState) {
            if (block && preCondition(block) &&
                !hasSelectedParent(block)) {
              block.setCollapsed(blockState);
            }
          };
          if (ws.doubleClickPid_) {
            clearTimeout(ws.doubleClickPid_);
            ws.doubleClickPid_ = undefined;
            // Case where selected is a
            // block (not a multidraggable)
            if (selected && selected instanceof Blockly.BlockSvg &&
                preCondition(selected)) {
              if (selected.id === ws.doubleClickBlock_) {
                const state = !selected.isCollapsed();
                Blockly.Events.setGroup(true);
                if (selected) {
                  maybeCollapse(selected, state);
                }
                Blockly.Events.setGroup(false);
                return;
              }
            } else if (selected && selected instanceof MultiselectDraggable) {
              // Case where the selected is a multidraggable instance
              const dragSelection = dragSelectionWeakMap.get(ws);
              if (dragSelection.size) {
                // Checking whether any of the blocks in
                // the dragSelection is not collapsed.
                // If there are not collapsed blocks,
                // set the maybeCollapse function to collapse
                // those uncollapsed blocks.
                // Otherwise, uncollapse all the collapsed blocks.
                let notCollapsed = 0;
                dragSelection.forEach((id) => {
                  if (ws.getBlockById(id)) {
                    if (!ws.getBlockById(id).isCollapsed() &&
                        !hasSelectedParent(ws.getBlockById(id))) {
                      notCollapsed += 1;
                    }
                  }
                });
                let state = false;
                if (notCollapsed > 0) {
                  state = true;
                }

                Blockly.Events.setGroup(true);
                dragSelection.forEach(function(id) {
                  const block = ws.getBlockById(id);
                  if (block) {
                    maybeCollapse(block, state);
                  }
                });
                Blockly.Events.setGroup(false);
                return;
              }
            }
          }
          if (!ws.doubleClickPid_) {
            ws.doubleClickBlock_ = selected.id;
            ws.doubleClickPid_ = setTimeout(function() {
              ws.doubleClickPid_ = undefined;
            }, 500);
          }
        }
      };
      wrappedFunc.isWrapped = true;
      return wrappedFunc;
    })(Blockly.Gesture.prototype.handleWsStart);
  }

  /**
   * Handle binded workspace events.
   * @param {!Event} e Blockly event.
   * @private
   */
  eventListener_(e) {
    // on Block field changed
    if (this.multiFieldUpdate_ &&
        this.dragSelection_.has(e.blockId) &&
        (e.type === Blockly.Events.CHANGE &&
            e.element === 'field' && e.recordUndo && e.group === '' ||
            e.type === Blockly.Events.BLOCK_FIELD_INTERMEDIATE_CHANGE)) {
      const currentGroup = Blockly.Events.getGroup();
      if (!currentGroup) {
        Blockly.Events.setGroup(true);
        e.group = Blockly.Events.getGroup();
      }
      try {
        const blockType = this.workspace_.getBlockById(e.blockId).type;
        // Update the fields to the same value for
        // the selected blocks with same type.
        this.dragSelection_.forEach((id) => {
          if (id === e.blockId) {
            return;
          }
          const block = this.workspace_.getBlockById(id);
          if (block && block.type === blockType) {
            block.setFieldValue(e.newValue, e.name);
          }
        });
      } catch (err) {
        // Avoid errors when changing a block if it is
        // no longer in the workspace.
        // https://github.com/mit-cml/workspace-multiselect/issues/33
        console.warn(err);
      } finally {
        Blockly.Events.setGroup(currentGroup);
      }
    }
  }

  /**
   * Handle all workspaces events.
   * @param {!Event} e Blockly event.
   * @private
   */
  eventListenerAll_(e) {
    // on Block Selected (must listen events of all workspaces
    // to cover all possible selection changes)
    if (e.type === Blockly.Events.SELECTED) {
      multiselectControlsList.forEach((controls) => {
        controls.updateMultiselect();
      });
    }
  }

  /**
   * Handle a key-down on the workspace.
   * @param {KeyboardEvent} e The keyboard event.
   * @private
   */
  onKeyDown_(e) {
    if (this.multiSelectKeys_.indexOf(e.key.toLocaleLowerCase()) > -1 &&
        !inMultipleSelectionModeWeakMap.get(this.workspace_)) {
      this.controls_.enableMultiselect();
    }
  }

  /**
   * Handle a keyboard navigation key-down on the workspace.
   * @param {KeyboardEvent} e The keyboard event.
   * @private
   */
  unbindMultiselectCopyPaste_(e) {
    // TODO: Update this to re-register/unregister the original shortcuts after
    //  Blockly/keyboard navigation plugin update
    // This is to unregister the multiselect plugin's shortcuts
    // when the user is in the keyboard navigation mode. Currently,
    // when the user is in keyboard accessibility mode, they cannot
    // use the normal copy/cut/paste functionalities.
    // This is because the original (Blockly core) copy/cut/paste
    // functions do not allow for collisions. This can be fixed
    // either by allowing for collisions in the Blockly core
    // copy/cut/paste functions or allowing for unregister/re-registering
    // of the keyboard navigation plugin's copy/cut/paste functions.
    if (this.workspace_.keyboardAccessibilityMode &&
        this.registeredShortcut_) {
      Shortcut.unregisterOurShortcut();
      this.registeredShortcut_ = false;
    } else if (!this.workspace_.keyboardAccessibilityMode &&
        !this.registeredShortcut_) {
      Shortcut.registerOurShortcut();
      this.registeredShortcut_ = true;
    }
  }

  /**
   * Handle a key-up on the workspace.
   * @param {KeyboardEvent} e The keyboard event.
   * @private
   */
  onKeyUp_(e) {
    if (this.multiSelectKeys_.indexOf(e.key.toLocaleLowerCase()) > -1) {
      this.controls_.disableMultiselect();
    }
  }

  /**
   * Handle a blur on the workspace.
   * @param {Event} e The blur event.
   * @private
   */
  onBlur_(e) {
    if (inMultipleSelectionModeWeakMap.get(this.workspace_)) {
      // Revert last unselected block if the related target
      // is a field related element, for accomodating field update
      // directly while the multi-selection mode is on.
      if (e.relatedTarget && (e.relatedTarget.tagName === 'INPUT' ||
          e.relatedTarget.tagName === 'TEXTAREA' ||
          e.relatedTarget.tagName === 'DIV' &&
          e.relatedTarget.classList.value.indexOf(
              'blocklyDropdownMenu') > -1)) {
        this.controls_.revertLastUnselectedBlock();
      }
      this.controls_.disableMultiselect();
    }
  }
}
