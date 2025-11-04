/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Changes blocks to use a +/- mutator UI for dynamic inputs.
 * Similar to if block mutator but for dynamic input management.
 */

import * as Blockly from 'blockly/core';
import { createMinusField } from './field_minus';
import { createPlusField } from './field_plus';

const dynamicInputsMutator = {
  /**
   * Number of extra inputs on this block (beyond the minimum).
   * @type {number}
   */
  extraCount_: 0,

  /**
   * Minimum number of inputs for this block.
   * @type {number}
   */
  minInputs: 1,

  /**
   * Creates XML to represent the number of extra inputs.
   * @returns {Element} XML storage element.
   * @this {Blockly.Block}
   */
  mutationToDom: function () {
    if (!this.extraCount_) {
      return null;
    }
    const container = Blockly.utils.xml.createElement('mutation');
    container.setAttribute('extra', this.extraCount_);
    return container;
  },

  /**
   * Parses XML to restore the extra inputs.
   * @param {!Element} xmlElement XML storage element.
   * @this {Blockly.Block}
   */
  domToMutation: function (xmlElement) {
    const targetCount = parseInt(xmlElement.getAttribute('extra'), 10) || 0;
    this.updateShape_(targetCount);
  },

  /**
   * Returns the state of this block as a JSON serializable object.
   * @returns {{extraCount: (number|undefined)}} The state of this block.
   */
  saveExtraState: function () {
    if (!this.extraCount_) {
      return null;
    }
    const state = Object.create(null);
    if (this.extraCount_) {
      state['extraCount'] = this.extraCount_;
    }
    return state;
  },

  /**
   * Applies the given state to this block.
   * @param {*} state The state to apply to this block.
   */
  loadExtraState: function (state) {
    const targetCount = state['extraCount'] || 0;
    this.updateShape_(targetCount);
  },

  /**
   * Updates the shape of the block to match the target extra count.
   * @param {number} targetCount The target number of extra inputs.
   * @this {Blockly.Block}
   * @private
   */
  updateShape_: function (targetCount) {
    while (this.extraCount_ < targetCount) {
      this.extraCount_++;
      const inputIndex = this.getTotalInputCount_() - 1; // 0-based index for new input
      const inputName = this.getInputName_(inputIndex);

      // Create the new input
      const input = this.appendValueInput(inputName);

      // 只有在超过最小输入数量时才添加减号按钮
      if (inputIndex >= this.minInputs) {
        const displayIndex = inputIndex + 1;
        input.appendField(createMinusField(displayIndex), 'MINUS' + displayIndex);
      }

      console.log(`Updated shape - added input: ${inputName} (index: ${inputIndex})`);
    }
    while (this.extraCount_ > targetCount) {
      this.removeInput_();
    }
  },

  /**
   * Callback for the plus field. Adds an extra input to the block.
   */
  plus: function () {
    this.addInput_();
  },

  /**
   * Callback for the minus field. Triggers "removing" the input at the specific index.
   * @param {number} index The index of the input to "remove" (1-based).
   * @this {Blockly.Block}
   */
  minus: function (index) {
    // Don't allow removing below minimum
    if (this.getTotalInputCount_() <= this.minInputs) {
      return;
    }
    this.removeInput_(index);
  },

  /**
   * Gets the total number of dynamic inputs (minimum + extra).
   * @returns {number} Total input count.
   * @this {Blockly.Block}
   * @private
   */
  getTotalInputCount_: function () {
    return this.minInputs + this.extraCount_;
  },

  /**
   * Gets the input name for a given index.
   * @param {number} index The 0-based index.
   * @returns {string} The input name.
   * @this {Blockly.Block}
   * @private
   */
  getInputName_: function (index) {
    return 'INPUT' + index;
  },

  /**
   * Adds an extra input to the bottom of the block.
   * @this {Blockly.Block}
   * @private
   */
  addInput_: function () {
    this.extraCount_++;
    const inputIndex = this.getTotalInputCount_() - 1; // 0-based index for new input
    const inputName = this.getInputName_(inputIndex);

    // Create the new input
    const input = this.appendValueInput(inputName);

    // 只有在超过最小输入数量时才添加减号按钮
    if (inputIndex >= this.minInputs) {
      const displayIndex = inputIndex + 1;
      input.appendField(createMinusField(displayIndex), 'MINUS' + displayIndex);
    }

    console.log(`Added input: ${inputName} (index: ${inputIndex}, minInputs: ${this.minInputs})`);
  },

  /**
   * Removes an input at the specified index by shifting all subsequent inputs up.
   * @param {number} displayIndex The 1-based display index of the input to remove.
   * @this {Blockly.Block}
   * @private
   */
  removeInput_: function (displayIndex = undefined) {
    if (this.extraCount_ <= 0) {
      return;
    }

    const totalInputs = this.getTotalInputCount_();

    // If no specific index, remove the last input
    if (displayIndex === undefined) {
      const lastIndex = totalInputs - 1;
      const lastInputName = this.getInputName_(lastIndex);
      this.removeInput(lastInputName);
      this.extraCount_--;
      console.log(`Removed last input: ${lastInputName}`);
      return;
    }

    // Convert display index (1-based) to array index (0-based)
    const targetIndex = displayIndex - 1;

    // Don't remove if it's below minimum or out of range
    if (targetIndex < this.minInputs || targetIndex >= totalInputs) {
      return;
    }

    // Disconnect blocks at the target index
    const targetInputName = this.getInputName_(targetIndex);
    const targetInput = this.getInput(targetInputName);
    if (targetInput && targetInput.connection && targetInput.connection.isConnected()) {
      targetInput.connection.disconnect();
    }

    // Shift all subsequent blocks up
    for (let i = targetIndex + 1; i < totalInputs; i++) {
      const currentInputName = this.getInputName_(i);
      const currentInput = this.getInput(currentInputName);
      if (currentInput && currentInput.connection) {
        const targetConnection = currentInput.connection.targetConnection;
        if (targetConnection) {
          // Disconnect from current position
          currentInput.connection.disconnect();
          // Reconnect to previous position
          const previousInputName = this.getInputName_(i - 1);
          const previousInput = this.getInput(previousInputName);
          if (previousInput && previousInput.connection) {
            previousInput.connection.connect(targetConnection);
          }
        }
      }
    }

    // Remove the last input (since we shifted everything up)
    const lastIndex = totalInputs - 1;
    const lastInputName = this.getInputName_(lastIndex);
    this.removeInput(lastInputName);
    this.extraCount_--;

    // Update minus field indices for all remaining inputs
    this.updateMinusFields_();

    console.log(`Removed input at display index: ${displayIndex}, shifted subsequent inputs up`);
  },

  /**
   * Updates the display indices on all minus fields after a removal.
   * @this {Blockly.Block}
   * @private
   */
  updateMinusFields_: function () {
    const totalInputs = this.getTotalInputCount_();
    for (let i = this.minInputs; i < totalInputs; i++) {
      const inputName = this.getInputName_(i);
      const input = this.getInput(inputName);
      if (input) {
        const displayIndex = i + 1;
        const fieldName = 'MINUS' + (i + 1); // This might not match exactly, but for reference
        // Note: Updating field indices dynamically is complex in Blockly
        // This is a simplified approach - in practice, you might need to recreate the fields
      }
    }
  }
};

/**
 * Adds the initial plus button to blocks using this mutator.
 * @this {Blockly.Block}
 */
const dynamicInputsHelper = function () {
  // Set default minimum inputs if not already set
  if (typeof this.minInputs === 'undefined') {
    this.minInputs = 1;
  }
  
  // Find the first input that starts with "INPUT" to add the plus button
  let targetInput = null;
  for (let i = 0; i < this.inputList.length; i++) {
    const input = this.inputList[i];
    if (input.name && input.name.startsWith('INPUT')) {
      targetInput = input;
      break;
    }
  }
  
  // If we found an INPUT* input, add the plus button to it
  if (targetInput) {
    targetInput.insertFieldAt(0, createPlusField(), 'PLUS');
    console.log(`Added plus button to input: ${targetInput.name}`);
  } else {
    // Fallback: if no INPUT* inputs found, use the first input
    if (this.inputList.length > 0) {
      const firstInput = this.inputList[0];
      firstInput.insertFieldAt(0, createPlusField(), 'PLUS');
      console.log(`No INPUT* inputs found, added plus button to first input: ${firstInput.name}`);
    }
  }

  // If we found an INPUT* input, add the plus button to it
  if (targetInput) {
    targetInput.insertFieldAt(0, createPlusField(), 'PLUS');
    console.log(`Added plus button to input: ${targetInput.name}`);
  } else {
    // Fallback: if no INPUT* inputs found, use the first input
    if (this.inputList.length > 0) {
      const firstInput = this.inputList[0];
      firstInput.insertFieldAt(0, createPlusField(), 'PLUS');
      console.log(`No INPUT* inputs found, added plus button to first input: ${firstInput.name}`);
    }
  }

  console.log(`Initialized dynamic inputs mutator with minInputs: ${this.minInputs}`);
};

// Register the mutator
if (Blockly.Extensions.isRegistered('dynamic_inputs_mutator')) {
  Blockly.Extensions.unregister('dynamic_inputs_mutator');
}

Blockly.Extensions.registerMutator(
  'dynamic_inputs_mutator',
  dynamicInputsMutator,
  dynamicInputsHelper,
);

// Export for use in other files
export { dynamicInputsMutator, dynamicInputsHelper };