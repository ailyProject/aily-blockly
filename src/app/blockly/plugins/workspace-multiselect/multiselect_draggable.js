/**
 * @license
 * Copyright 2024 MIT
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Multiple selection draggable class.
 */
import * as Blockly from 'blockly/core';
import {dragSelectionWeakMap, hasSelectedParent, inMultipleSelectionModeWeakMap} from './global';


/**
 * A draggable object that adds the functionality for multiple blocks to
 * be moved while someone is dragging it.
 * It implements the IDraggable interface in Blockly v11.
 */
export class MultiselectDraggable {
  /**
   * A constructor for the MultiselectDraggable class
   * @param {Blockly.Workspace} workspace The workspace the
   * multiselectDraggable object is located in.
   */
  constructor(workspace) {
    this.workspace = workspace;
    this.id = Blockly.utils.idGenerator.genUid();
    this.subDraggables = new Map();
    this.topSubDraggables = [];
    this.loc = new Blockly.utils.Coordinate(0, 0);
    this.connectionDBList = [];
    this.dragSelection = dragSelectionWeakMap.get(workspace);
  }

  /**
   * Clears everything in the subDraggables
   * map of the MultiselectDraggable object.
   */
  clearAll_() {
    for (const [subDraggable] of this.subDraggables) {
      subDraggable.unselect();
      this.removeSubDraggable_(subDraggable);
    }
  }

  /**
   * Adds a subDraggable to the multiselectDraggable object
   * @param {Blockly.IDraggable} subDraggable A draggable object that
   * is to be added to the multiselectDraggable object.
   * @private
   */
  addSubDraggable_(subDraggable) {
    if (!(subDraggable instanceof MultiselectDraggable)) {
      this.addPointerDownEventListener_(subDraggable);
    }
    this.subDraggables.set(subDraggable, subDraggable.getRelativeToSurfaceXY());
  }

  /**
   * Removes a subDraggable to the multiselectDraggable object
   * @param {Blockly.IDraggable} subDraggable A draggable object that
   * is to be removed from the multiselectDraggable object.
   * @private
   */
  removeSubDraggable_(subDraggable) {
    if (!(subDraggable instanceof MultiselectDraggable)) {
      this.removePointerDownEventListener_(subDraggable);
    }
    this.subDraggables.delete(subDraggable);
  }

  // This is the feature where we added a pointer down event listener.
  // This was added to mitigate the issue of setStart[draggable] overwriting
  // the call that passes the multidraggable to Blockly.common.SetSelected().
  // This should be updated/fixed when a more flexible gesture handling
  // system is implemented.
  // TODO: Look into these after gestures have been updated
  /**
   * Adds a pointer down event listener to a subdraggable to mitigate issue
   * of setStart[draggable] overwriting the call that passes the
   * multidraggable to Blockly.common.SetSelected().
   * @param {Blockly.IDraggable} subDraggable A draggable object that will
   * have an event listener added to
   * @private
   */
  addPointerDownEventListener_(subDraggable) {
    // Bind the handler to the correct context (class instance)
    // i.e. it creates a new function where the 'this' of the new function
    // is set to whatever is passed into the bind method argument.
    // In this case, it is the multiselectDraggable class/object.
    const handler = this.pointerDownEventHandler_.bind(this);

    // Store the handler function in the subDraggable object
    subDraggable.pointerDownHandler = handler;

    // When adding/removing an event listener, we must pass in named functions
    // as anonymous functions are different function instances in memory
    subDraggable.getSvgRoot().addEventListener('pointerdown', handler);
  }

  /**
   * Removes a pointer down event listener from a subdraggable to
   * mitigate issue of setStart[draggable] overwriting the call that
   *  passes the multidraggable to Blockly.common.SetSelected().
   * @param {Blockly.IDraggable} subDraggable A draggable object
   * that will have an event listener removed from
   * @private
   */
  removePointerDownEventListener_(subDraggable) {
    if (subDraggable) {
      // Retrieve the stored handler function
      const handler = subDraggable.pointerDownHandler;
      if (handler) {
        subDraggable.getSvgRoot().removeEventListener('pointerdown', handler);

        // Clean up the stored handler reference
        delete subDraggable.pointerDownHandler;
      }
    }
  }

  /**
   * The handler for the pointer down event that mitigates
   * the issue of setStart[draggable] overwriting the call that
   * passes the multidraggable to Blockly.common.SetSelected().
   * @param {PointerEvent} event A pointer down event
   * @private
   */
  pointerDownEventHandler_(event) {
    if (!inMultipleSelectionModeWeakMap.get(this.workspace)) {
      Blockly.common.setSelected(this);
    }
  }

  /**
   * A method that determines whether the object is movable or not.
   * @returns {boolean} Returns true as it is always movable
   */
  isMovable() {
    if (inMultipleSelectionModeWeakMap.get(this.workspace)) {
      return false;
    }
    return true;
  }

  /**
   * Returns the current location of the multiselectDraggable
   * in workspace coordinates.
   * @returns {Blockly.utils.Coordinate} The coordinate of the current location
   * on workspace (top left corner of multiselect-draggable)
   */
  getRelativeToSurfaceXY() {
    return this.loc;
  }

  /**
   * Starts a drag on the multiselectDraggable object if there
   * are no other plugins that overwrite this method.
   * It delegates the startDrag methods to the topmost subdraggables.
   * @param {Blockly.Events.BLOCK_DRAG} e A drag event
   */
  startDrag(e) {
    this.inGroup = !!Blockly.Events.getGroup();
    if (!this.inGroup) {
      Blockly.Events.setGroup(true);
    }
    for (const draggable of this.subDraggables) {
      if (draggable[0] instanceof
          Blockly.BlockSvg) {
        // Save only the topmost subdraggables to do the drag on
        // or if it is not any other draggable with parents/child
        // relationships like workspace comments
        if (!(hasSelectedParent(draggable[0], true))) {
          this.topSubDraggables.push(draggable[0]);
        }

        // Save any connections between blocks of the same level
        // (next statement)
        if (!draggable[0].isShadow()) {
          const parentBlock = draggable[0].getParent();
          if (parentBlock && this.subDraggables.has(parentBlock) &&
              parentBlock.getNextBlock() === draggable[0]) {
            this.connectionDBList.push([parentBlock.nextConnection,
              draggable[0].previousConnection]);
          }
        }
      } else {
        // If the draggable is not a block (e.g. ws comment)
        this.topSubDraggables.push(draggable[0]);
      }

      this.subDraggables.set(draggable[0],
          draggable[0].getRelativeToSurfaceXY());
    }
    for (const draggable of this.topSubDraggables) {
      draggable.startDrag();
    }
  }

  /**
   * Drags the subdraggables of the multiselectDraggable object if
   * there are no other plugins that overwrite this method.
   * It delegates the drag methods to the topmost subdraggables.
   * @param {Blockly.utils.Coordinate} newLoc The new location the object
   * is being moved to (in Blockly coordinates)
   * @param {Blockly.Events.BLOCK_DRAG} e A drag event
   */
  drag(newLoc, e) {
    for (const draggable of this.topSubDraggables) {
      if (this.subDraggables.get(draggable) &&
          this.subDraggables.get(draggable) instanceof
          Blockly.utils.Coordinate) {
        draggable.drag(Blockly.utils.Coordinate.sum(newLoc,
            this.subDraggables.get(draggable)), e);
      }
    }
  }

  /**
   * Ends the drag of the subdraggables of the multiselectDraggable
   * object if there are no other plugins that overwrite this method.
   * It delegates the endDrag methods to the topmost subdraggables.
   * @param {Blockly.Events.BLOCK_DRAG} e A drag event
   */
  endDrag(e) {
    for (const draggable of this.topSubDraggables) {
      draggable.endDrag(e);
    }

    for (const draggable of this.subDraggables) {
      // Update location of subdraggables
      draggable[1] = draggable[0].getRelativeToSurfaceXY();
    }

    // Reconnect any connections between blocks that are
    // on the same level (not child/parent)
    this.connectionDBList.forEach(function(connectionDB) {
      connectionDB[0].connect(connectionDB[1]);
    });

    this.topSubDraggables.length = 0;
    this.connectionDBList.length = 0;
    if (!this.inGroup) {
      Blockly.Events.setGroup(false);
    }
  }

  /**
   * Reverts any drags done on the multiselectDraggable object.
   */
  revertDrag() {
    for (const draggable of this.subDraggables) {
      draggable[0].revertDrag();
    }
  }

  // ISelectable methods
  /**
   * A function that updates the highlight selection
   * of the subdraggables. Currently, this only updates
   * the highlighting after multiselect mode is turned
   * off. Look at updateDraggables_ method in
   * multiselect_controls.js
   */
  select() {
    // This needs to be worked on to see if we can make the
    // highlighting of the subdraggables in real time.
    for (const draggable of this.subDraggables) {
      if (draggable[0] instanceof Blockly.BlockSvg &&
          !draggable[0].isShadow()) {
        draggable[0].select();
      } else {
        draggable[0].select();
      }
    }
  }

  /**
   * A function that turns off the highlight selection
   * of the subdraggables. Currently not used as it
   * causes a bug when selecting a block by clicking
   * while in multiselect mode.
   */
  unselect() {
    // TODO: Look into this after gestures have been updated
    // for (const draggable of this.subDraggables) {
    //   draggable[0].unselect();
    // }
  }


  // IDeletable methods
  /**
   * A function that is required for the
   * multiselectDraggable object to be deletable.
   * @returns {boolean} Always true
   */
  isDeletable() {
    return true;
  }

  /**
   * Disposes all subdraggables in the multiselectDraggable object.
   */
  dispose() {
    for (const draggable of this.subDraggables) {
      if (!draggable[0].isDeletable()) {
        continue;
      }
      this.removeSubDraggable_(draggable[0]);
      this.dragSelection.delete(draggable[0].id);
      if (draggable[0] instanceof Blockly.BlockSvg) {
        draggable[0].dispose(true, true);
      } else {
        draggable[0].dispose();
      }
    }
  }

  /**
   * Sets the delete style when we drag the multidraggable over a delete
   * area.
   * @param {boolean} enable A boolean that determines whether to set the
   * delete style of the blocks.
   */
  setDeleteStyle(enable) {
    // TODO: Check this after ws comment's setDeleteStyle is fixed
    for (const draggable of this.subDraggables) {
      if (draggable[0].isDeletable()) {
        draggable[0].setDeleteStyle(enable);
      }
    }
  }

  /**
   * Returns a rectangular bound for the multiselectDraggable
   * object needed to be compatible with the Scroll Options plugin.
   * @returns {Blockly.utils.Rect} A Blockly Rect that represents
   * the bounds of the multiselectDraggable object.
   */
  getBoundingRectangle() {
    if (this.subDraggables.size === 0) {
      return new Blockly.utils.Rect(0, 0, 0, 0);
    }

    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;

    this.subDraggables.forEach((coord, subDraggable) => {
      const boundingBox = subDraggable.getBoundingRectangle();
      top = Math.min(top, boundingBox.top);
      bottom = Math.max(bottom, boundingBox.bottom);
      left = Math.min(left, boundingBox.left);
      right = Math.max(right, boundingBox.right);
    });

    return new Blockly.utils.Rect(top, bottom, left, right);
  }

  // Backpack plugin support
  /**
   * Converts the subdraggables into flyout information for the
   * backpack plugin.
   * @returns {Blockly.utils.toolbox.FlyoutItemInfoArray} Returns an
   * array of flyout info of subdraggables that can be placed
   * in a flyout (i.e. blocks).
   * Otherwise, it does not convert them into flyout info (i.e.
   * ws comments).
   */
  toFlyoutInfo() {
    const flyoutList = [];
    for (const draggable of this.subDraggables) {
      if (draggable[0].toFlyoutInfo !== undefined) {
        const draggableFlyoutInfo = draggable[0].toFlyoutInfo();
        flyoutList.push(...draggableFlyoutInfo);
      }
    }
    return flyoutList;
  }
}
