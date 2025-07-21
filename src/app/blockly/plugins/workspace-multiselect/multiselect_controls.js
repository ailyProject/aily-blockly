/**
 * @license
 * Copyright 2022 MIT
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * @fileoverview Multiple selection svg switch.
 */

import * as Blockly from 'blockly/core';

import DragSelect from 'dragselect';
import {
  dragSelectionWeakMap,
  getByID,
  inMultipleSelectionModeWeakMap,
  inPasteShortcut,
  multiDraggableWeakMap,
} from './global';
import {MultiselectDraggable} from './multiselect_draggable';

/**
 * Width of the multi select controls.
 * @type {number}
 * @const
 */
const WIDTH = 32;

/**
 * Height of the multi select control.
 * @type {number}
 * @const
 */
const HEIGHT = 32;

/**
 * Distance between multi select controls and bottom or top edge of workspace.
 * @type {number}
 * @const
 */
const MARGIN_VERTICAL = 20;

/**
 * Distance between multi select controls and right or left edge of workspace.
 * @type {number}
 */
const MARGIN_HORIZONTAL = 20;

/**
 * Class for a multi select controls.
 * @implements {Blockly.IPositionable}
 */
export class MultiselectControls {
  /**
   * @param {!Blockly.WorkspaceSvg} workspace The workspace to sit in.
   * @param {Object} options The icons configuration.
   * @param {!Array<string>} multiSelectKeys The key codes for
   *                         switching between multi select mode.
   */
  constructor(workspace, options, multiSelectKeys) {
    /**
     * Icon path of the multi select controls when enabled.
     * @type {string}
     */
    this.enabled_img =
        'https://github.com/mit-cml/workspace-multiselect' +
        '/raw/main/test/media/select.svg';

    /**
     * Icon path of the multi select controls when disabled.
     * @type {string}
     */
    this.disabled_img =
        'https://github.com/mit-cml/workspace-multiselect' +
        '/raw/main/test/media/unselect.svg';

    /**
     * @type {!Blockly.WorkspaceSvg} The workspace to sit in.
     * @private
     */
    this.workspace_ = workspace;

    /**
     * State of the multi select controls.
     * @type {boolean}
     */
    this.enabled = false;

    /**
     * The unique id for this component that is used to register with the
     * ComponentManager.
     * @type {string}
     */
    this.id = 'multiselectControls';

    /**
     * The key codes for switching between multi select.
     * @type {!Array<string>}
     * @private
     */
    this.multiSelectKeys_ = multiSelectKeys;

    /**
     * A handle to use to unbind the mouse down event handler for multi select
     *    button. Opaque data returned from browserEvents.conditionalBind.
     * @type {?Blockly.browserEvents.Data}
     * @private
     */
    this.onMultiselectWrapper_ = null;

    /**
     * The multi select svg <g> element.
     * @type {SVGGElement}
     * @private
     */
    this.multiselectGroup_ = null;

    /**
     * Whether this has been initialized.
     * @type {boolean}
     * @private
     */
    this.initialized_ = false;

    /**
     * Store the status of workspace dragging
     * before entering multi select mode.
     * @type {boolean}
     * @private
     */
    this.hasDisableWorkspaceDrag_ = false;

    /**
     * Store the block that just got unselected.
     * @type {!Blockly.BlockSvg}
     * @private
     */
    this.justUnselectedBlock_ = null;

    /**
     * Store the block that was last selected.
     * @type {!Blockly.BlockSvg}
     * @private
     */
    this.lastSelectedElement_ = null;

    if (options && options.enabledIcon) {
      this.enabled_img = options.enabledIcon;
    }

    if (options && options.disabledIcon) {
      this.disabled_img = options.disabledIcon;
    }

    // Set containing currently select blockSvg ids.
    this.dragSelection = dragSelectionWeakMap.get(workspace);

    // MultiDraggable object that holds subdraggables
    this.multiDraggable = multiDraggableWeakMap.get(workspace);

    // Original settings for handling the start block
    this.origHandleBlockStart = Blockly.Gesture.prototype.handleBlockStart;
  }

  /**
   * Create the multi select controls.
   * @returns {!SVGElement} The multi select controls SVG group.
   */
  createDom() {
    this.svgGroup_ = Blockly.utils.dom.createSvgElement(
        Blockly.utils.Svg.G, {}, null);
    this.createMultiselectSvg_();
    return this.svgGroup_;
  }

  /**
   * Initializes the multi select controls.
   */
  init(hideIcon, weight) {
    if (!hideIcon) {
      let weightValue = 3;
      if (typeof weight === 'number') {
        weightValue = weight;
      }
      this.workspace_.getComponentManager().addComponent({
        component: this,
        weight: weightValue,
        capabilities: [Blockly.ComponentManager.Capability.POSITIONABLE],
      });
    }
    this.initialized_ = true;
    this.workspace_.resize();
    this.multiDraggable.clearAll_();
  }

  /**
   * Disposes of this multi select controls.
   * Unlink from all DOM elements to prevent memory leaks.
   */
  dispose() {
    this.disableMultiselect();
    this.workspace_.getComponentManager().removeComponent(this.id);
    if (this.svgGroup_) {
      Blockly.utils.dom.removeNode(this.svgGroup_);
    }
    if (this.onMultiselectWrapper_) {
      Blockly.browserEvents.unbind(this.onMultiselectWrapper_);
    }
  }

  /**
   * Returns the bounding rectangle of the UI element in pixel units relative to
   * the Blockly injection div.
   * @returns {?Blockly.utils.Rect} The UI elements's bounding box. Null if
   *   bounding box should be ignored by other UI elements.
   */
  getBoundingRectangle() {
    const bottom = this.top_ + HEIGHT;
    const right = this.left_ + WIDTH;
    return new Blockly.utils.Rect(this.top_, bottom, this.left_, right);
  }

  /**
   * Positions the multi select controls.
   * It is positioned in the opposite corner to the corner the
   * categories/toolbox starts at.
   * @param {!Blockly.MetricsManager.UiMetrics} metrics The workspace metrics.
   * @param {!Array<!Blockly.utils.Rect>} savedPositions List of rectangles that
   *     are already on the workspace.
   */
  position(metrics, savedPositions) {
    // Not yet initialized.
    if (!this.initialized_) {
      return;
    }

    const cornerPosition =
      Blockly.uiPosition.getCornerOppositeToolbox(this.workspace_, metrics);
    const startRect = Blockly.uiPosition.getStartPositionRect(
        cornerPosition, new Blockly.utils.Size(WIDTH, HEIGHT),
        MARGIN_HORIZONTAL,
        MARGIN_VERTICAL, metrics, this.workspace_);

    const verticalPosition = cornerPosition.vertical;
    const bumpDirection = verticalPosition ===
      Blockly.uiPosition.verticalPosition.TOP ?
      Blockly.uiPosition.bumpDirection.DOWN :
      Blockly.uiPosition.bumpDirection.UP;
    const positionRect = Blockly.uiPosition.bumpPositionRect(
        startRect, MARGIN_VERTICAL, bumpDirection, savedPositions);

    this.top_ = positionRect.top;
    this.left_ = positionRect.left;
    if (this.svgGroup_) {
      this.svgGroup_.setAttribute(
          'transform', 'translate(' + this.left_ + ',' + this.top_ + ')');
    }
  }

  /**
   * Revert the last unselected block.
   */
  revertLastUnselectedBlock() {
    this.updateDraggables_(this.justUnselectedBlock_);
  }

  /**
   * Create the multi-select icon and its event handler.
   * @private
   */
  createMultiselectSvg_() {
    /* This markup will be generated and added to the .svgGroup_:
    <g class="blocklyMultiselect">
      <image width="32" height="32" xlink:href="media/unselect.svg"></image>
    </g>
    */
    this.multiselectGroup_ =
      Blockly.utils.dom.createSvgElement(Blockly.utils.Svg.G, {
        'class': 'blocklyMultiselect',
      }, this.svgGroup_);
    const MultiselectSvg = Blockly.utils.dom.createSvgElement(
        Blockly.utils.Svg.IMAGE, {
          'width': WIDTH,
          'height': HEIGHT,
        },
        this.multiselectGroup_);
    MultiselectSvg.setAttributeNS(
        Blockly.utils.dom.XLINK_NS, 'xlink:href', this.disabled_img);

    // Attach event listeners.
    this.onMultiselectWrapper_ = Blockly.browserEvents.conditionalBind(
        this.multiselectGroup_, 'mousedown', null,
        this.switchMultiselect_.bind(this));
  }

  /**
   * Handles a mouse down event on the multi-select button on the workspace.
   * @param {!Event} e A mouse down event.
   * @private
   */
  switchMultiselect_(e) {
    this.workspace_.markFocused();
    this.enabled = !this.enabled;
    // Multiple selection switch.
    if (this.enabled) {
      this.enableMultiselect(true);
    } else {
      this.disableMultiselect(true);
    }
    Blockly.Touch.clearTouchIdentifier(); // Don't block future drags.
    e.stopPropagation(); // Don't start a workspace scroll.
    e.preventDefault(); // Stop double-clicking from selecting text.
  }

  /**
   * Maintain the selected draggable set list when updating.
   * @param {!Blockly.IDraggable} draggable The draggable to update.
   * @private
   */
  updateDraggables_(draggable) {
    if (!draggable) {
      return;
    }
    if (draggable instanceof Blockly.BlockSvg) {
      // The case where the draggable is a block
      if (!((draggable.isDeletable() || draggable.isMovable()) &&
          !draggable.isShadow()) || draggable.type === 'drag_to_dupe') {
        return;
      }
      if (this.dragSelection.has(draggable.id)) {
        this.dragSelection.delete(draggable.id);
        this.justUnselectedBlock_ = draggable;
        this.multiDraggable.removeSubDraggable_(draggable);
        draggable.pathObject.updateSelected(false);
      } else {
        this.dragSelection.add(draggable.id);
        this.justUnselectedBlock_ = null;
        this.multiDraggable.addSubDraggable_(draggable);
        draggable.pathObject.updateSelected(true);
        draggable.bringToFront();
      }
    } else {
      // The case where the draggable is not a block (e.g. ws comment)
      if (!(draggable.isMovable() || draggable.isDeletable())) {
        return;
      }
      if (this.dragSelection.has(draggable.id)) {
        this.dragSelection.delete(draggable.id);
        this.multiDraggable.removeSubDraggable_(draggable);
        draggable.unselect();
      } else {
        this.dragSelection.add(draggable.id);
        this.multiDraggable.addSubDraggable_(draggable);
        draggable.select();
      }
    }
  }


  /**
   * Update the multiple selection blocks status.
   */
  updateMultiselect() {
    // Not in multiselect mode
    if (!inMultipleSelectionModeWeakMap.get(this.workspace_)) {
      // If clicking on different workspace, clear selected set
      if (this.workspace_.id !== Blockly.getMainWorkspace().id) {
        this.multiDraggable.clearAll_();
        this.dragSelection.clear();
      }

      // If unselecting/clicking on workspace,
      // clear selected set
      if (!Blockly.getSelected()) {
        this.lastSelectedElement_ = null;
        // This is a workaround for a bug where holding shift
        // selecting and going to another workspace without letting go of
        // shift and selecting new blocks will still leave the original
        // blocks highlighted. This can be removed if we figure out how
        // to solve the real-time highlighting issue in the updateDraggables_
        // function. However, a frame-delay related to events may be causing
        // this issue (Blockly-side).
        for (const draggable of this.multiDraggable.subDraggables) {
          draggable[0].unselect();
        }
        this.multiDraggable.clearAll_();
        this.dragSelection.clear();
        Blockly.common.setSelected(null);
      } else if (Blockly.getSelected() &&
          !(Blockly.getSelected() instanceof MultiselectDraggable)) {
        // Blockly.getSelected() is not a multiselectDraggable
        // and selected block is not in dragSelection
        for (const draggable of this.multiDraggable.subDraggables) {
          draggable[0].unselect();
        }
        this.multiDraggable.clearAll_();
        this.dragSelection.clear();
        this.lastSelectedElement_ = Blockly.getSelected();
        inPasteShortcut.set(this.workspace_, false);
      }
    } else {
      // In multiselect mode
      // Set selected to multiDraggable if dragSelection not empty
      if (this.dragSelection.size && !(Blockly.getSelected() instanceof
          MultiselectDraggable)) {
        Blockly.common.setSelected(this.multiDraggable);
      } else if (this.lastSelectedElement_ &&
          !inPasteShortcut.get(this.workspace_)) {
        this.updateDraggables_(this.lastSelectedElement_);
        this.lastSelectedElement_ = null;
        inPasteShortcut.set(this.workspace_, false);
      } else if (!this.dragSelection.size && !(Blockly.getSelected() instanceof
          MultiselectDraggable)) {
        if (Blockly.getSelected() instanceof Blockly.BlockSvg &&
            !Blockly.getSelected().isShadow()) {
          Blockly.common.setSelected(null);
        }
        // TODO: Look into this after gesture has been updated at Blockly
        // Currently, the setSelected is called twice even with selection of
        // one block. This is most likely because of the handleBlockStart
        // gesture. That is why it is separated from the if statement above.
        if (Blockly.getSelected() instanceof Blockly.BlockSvg) {
          this.justUnselectedBlock_ = Blockly.getSelected();
        }
      }
    }
  }

  /**
   * Enable the multiple select mode.
   * @param {!boolean} byIcon Whether to simulate a keyboard event.
   */
  enableMultiselect(byIcon = false) {
    // Ensure that we only restore drag to move the workspace behavior
    // when it is enabled.
    if (!this.hasDisableWorkspaceDrag_ &&
      this.workspace_.options.moveOptions &&
      this.workspace_.options.moveOptions.drag) {
      this.workspace_.options.moveOptions.drag = false;
      this.hasDisableWorkspaceDrag_ = true;
    }
    this.dragSelect_ = new DragSelect({
      // TODO: Find a way to capture/query all types of draggables
      selectables: this.workspace_.getInjectionDiv()
          .querySelectorAll('g.blocklyDraggable:not(.blocklyInsertionMarker)' +
              '> path.blocklyPath' + ', g.blocklyDraggable ' +
              '> rect.blocklyCommentHighlight'
          ),
      area: this.workspace_.svgGroup_,
      multiselectMode: true,
      draggability: false,
      usePointerEvents: true,
      multiSelectKeys: this.multiSelectKeys_,
    });
    // Filter out the parent block when selecting child blocks
    // to mitigate the invisible rectangles issue.
    const filterParent = (list, rect) => {
      const toRemove = [];
      for (const [parent, parentRect] of list.entries()) {
        for (const [child, childRect] of list.entries()) {
          if (parent === child ||
            !DragSelect.isCollision(childRect, parentRect, 0) ||
                  parent.parentNode === null || child.parentNode === null ||
                  parent.parentNode === child.parentNode) continue;
          else if (parent.parentNode.contains(child.parentNode) &&
                  // Continue to select if user draws a rectangle that
                  // covers more than the child itself
                  DragSelect.isCollision(rect, childRect, 1)) {
            toRemove.push(parent);
            break;
          }
        }
      }
      return toRemove;
    };
    this.dragSelect_.Selection.filterSelected = (
        {selectorRect, select: _select, unselect: _unselect}) => {
      const select = _select; const unselect = _unselect;
      const toRemove = filterParent(select, selectorRect);
      toRemove.forEach((el) => {
        const rect = select.get(el);
        select.delete(el);
        unselect.set(el, rect);
      });
      return {select, unselect};
    };

    this.dragSelect_.subscribe('elementselect', (info) => {
      const element = info.item.parentElement;
      if (inMultipleSelectionModeWeakMap.get(this.workspace_) &&
          element && element.dataset && element.dataset.id) {
        this.updateDraggables_(
            getByID(this.workspace_, element.dataset.id));
      }
    });
    this.dragSelect_.subscribe('elementunselect', (info) => {
      const element = info.item.parentElement;
      if (inMultipleSelectionModeWeakMap.get(this.workspace_) &&
          element && element.dataset && element.dataset.id) {
        this.updateDraggables_(
            getByID(this.workspace_, element.dataset.id));
      }
    });
    if (byIcon) {
      document.dispatchEvent(
          new KeyboardEvent('keydown', {'key': this.multiSelectKeys_[0]}));
    }
    this.updateMultiselectIcon(true);
    inMultipleSelectionModeWeakMap.set(this.workspace_, true);
  }

  /**
   * Disable the multiple select mode.
   * @param {!boolean} byIcon Whether to simulate a keyboard event.
   */
  disableMultiselect(byIcon = false) {
    inMultipleSelectionModeWeakMap.set(this.workspace_, false);
    if (this.dragSelect_) {
      if (byIcon) {
        document.dispatchEvent(
            new KeyboardEvent('keyup', {'key': this.multiSelectKeys_[0]}));
      }
      this.dragSelect_.stop();
      this.dragSelect_ = null;
    }
    // Ensure that Blockly selects multidraggable if
    // our set is not empty.
    if (this.dragSelection.size && !Blockly.getSelected()) {
      Blockly.common.setSelected(this.multiDraggable);
    }
    if (this.hasDisableWorkspaceDrag_) {
      this.workspace_.options.moveOptions.drag = true;
      this.hasDisableWorkspaceDrag_ = false;
    }
    this.updateMultiselectIcon(false);
  }

  /**
   * Updates the multi select icon.
   * @param {boolean} enable Whether the multi select is enabled.
   */
  updateMultiselectIcon(enable) {
    if (!this.multiselectGroup_) {
      return;
    }
    this.enabled = enable;
    if (enable) {
      this.multiselectGroup_.firstElementChild.setAttributeNS(
          Blockly.utils.dom.XLINK_NS, 'xlink:href', this.enabled_img);
    } else {
      this.multiselectGroup_.firstElementChild.setAttributeNS(
          Blockly.utils.dom.XLINK_NS, 'xlink:href', this.disabled_img);
    }
  }
}

/**
 * CSS for multi select controls.  See css.js for use.
 */
Blockly.Css.register(`
.blocklyMultiselect>image, .blocklyMultiselect>svg>image {
  opacity: .4;
}

.blocklyMultiselect>image:hover, .blocklyMultiselect>svg>image:hover {
  opacity: .6;
}

.blocklyMultiselect>image:active, .blocklyMultiselect>svg>image:active {
  opacity: .8;
}
`);
