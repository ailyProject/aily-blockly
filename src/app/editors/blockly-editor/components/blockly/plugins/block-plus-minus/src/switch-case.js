/**
 * @license
 * Copyright 2020 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Changes blocks to use a +/- mutator UI for dynamic switch case inputs.
 * Similar to if block mutator but for switch case management.
 */

import * as Blockly from 'blockly/core';
import { createMinusField } from './field_minus';
import { createPlusField } from './field_plus';

const switchCaseMutator = {
  /**
   * Number of case inputs on this block.
   * @type {number}
   */
  caseCount_: 0,

  /**
   * Whether this block has a default case input or not.
   * @type {boolean}
   */
  hasDefault_: true,

  /**
   * Creates XML to represent the number of case and default inputs.
   * @returns {Element} XML storage element.
   * @this {Blockly.Block}
   */
  mutationToDom: function () {
    if (!this.caseCount_ && !this.hasDefault_) {
      return null;
    }
    const container = Blockly.utils.xml.createElement('mutation');
    if (this.caseCount_) {
      container.setAttribute('case', this.caseCount_);
    }
    if (this.hasDefault_) {
      container.setAttribute('default', 1);
    }
    return container;
  },

  /**
   * Parses XML to restore the case and default inputs.
   * @param {!Element} xmlElement XML storage element.
   * @this {Blockly.Block}
   */
  domToMutation: function (xmlElement) {
    const targetCaseCount = parseInt(xmlElement.getAttribute('case'), 10) || 0;
    const hasDefault = xmlElement.getAttribute('default') == 1;
    this.hasDefault_ = hasDefault;
    if (this.hasDefault_ && !this.getInput('DEFAULT')) {
      this.appendStatementInput('DEFAULT')
        .appendField(createMinusField('default'), 'MINUS_DEFAULT')
        .appendField('默认执行');
    }
    this.updateShape_(targetCaseCount);
  },

  /**
   * Returns the state of this block as a JSON serializable object.
   * @returns {{caseCount: number, hasDefault: boolean}} The state of this block.
   */
  saveExtraState: function () {
    if (!this.caseCount_ && this.hasDefault_) {
      return null;
    }
    return {
      'caseCount': this.caseCount_,
      'hasDefault': this.hasDefault_,
    };
  },

  /**
   * Applies the given state to this block.
   * @param {*} state The state to apply to this block.
   */
  loadExtraState: function (state) {
    const targetCount = state['caseCount'] || 0;
    this.hasDefault_ = state['hasDefault'] !== undefined ? state['hasDefault'] : true;
    if (this.hasDefault_ && !this.getInput('DEFAULT')) {
      this.appendStatementInput('DEFAULT')
        .appendField(createMinusField('default'), 'MINUS_DEFAULT')
        .appendField('默认执行');
    }
    this.updateShape_(targetCount);
  },

  /**
   * Updates the shape of the block to match the target case count and default.
   * @param {number} targetCaseCount The target number of case inputs.
   * @this {Blockly.Block}
   * @private
   */
  updateShape_: function (targetCaseCount) {
    // Add or remove case inputs
    while (this.caseCount_ < targetCaseCount) {
      this.addCaseInput_();
    }
    while (this.caseCount_ > targetCaseCount) {
      this.removeCaseInput_();
    }
  },

  /**
   * Callback for the plus field. Adds a case input.
   */
  plus: function () {
    this.addCaseInput_();
  },

  /**
   * Callback for the minus field. Removes a case or default input.
   * @param {string|number} arg Either 'default' string or case index number.
   */
  minus: function (arg) {
    if (arg === 'default') {
      if (this.getInput('DEFAULT')) {
        this.removeInput('DEFAULT');
        this.hasDefault_ = false;
      }
    } else {
      // arg is the case index (1-based)
      if (this.caseCount_ == 0) {
        return;
      }
      this.removeCaseAtIndex_(arg);
    }
  },

  /**
   * Adds a case input to the block.
   * @this {Blockly.Block}
   * @private
   */
  addCaseInput_: function () {
    this.caseCount_++;
    const caseIndex = this.caseCount_;
    
    // Add case value input
    this.appendValueInput('CASE' + caseIndex)
      .appendField(createMinusField(caseIndex), 'MINUS' + caseIndex)
      .appendField('情况');
    
    // Add case statement input
    this.appendStatementInput('DO' + caseIndex)
      .appendField('执行');
    
    // Move DEFAULT to the end if it exists
    if (this.getInput('DEFAULT')) {
      this.moveInputBefore('DEFAULT', null);
    }
  },

  /**
   * Removes the last case input from the block.
   * @this {Blockly.Block}
   * @private
   */
  removeCaseInput_: function () {
    if (this.caseCount_ <= 0) {
      return;
    }
    
    const caseIndex = this.caseCount_;
    
    this.removeInput('CASE' + caseIndex);
    this.removeInput('DO' + caseIndex);
    this.caseCount_--;
  },

  /**
   * Removes a case at the specified index by shifting all subsequent cases up.
   * @param {number} index The 1-based index of the case to remove.
   * @this {Blockly.Block}
   * @private
   */
  removeCaseAtIndex_: function (index) {
    if (this.caseCount_ <= 0) {
      return;
    }
    
    // If removing a specific index (not the last one)
    if (index !== undefined && index != this.caseCount_) {
      // Each case has two inputs: CASE and DO
      // Find the input indices
      const inputs = this.inputList;
      let caseInputIndex = -1;
      let doInputIndex = -1;
      
      for (let i = 0; i < inputs.length; i++) {
        if (inputs[i].name === 'CASE' + index) {
          caseInputIndex = i;
        } else if (inputs[i].name === 'DO' + index) {
          doInputIndex = i;
          break;
        }
      }
      
      if (caseInputIndex === -1 || doInputIndex === -1) {
        return;
      }
      
      // Disconnect blocks at the target index
      let connection = inputs[caseInputIndex].connection;
      if (connection && connection.isConnected()) {
        connection.disconnect();
      }
      connection = inputs[doInputIndex].connection;
      if (connection && connection.isConnected()) {
        connection.disconnect();
      }
      
      this.bumpNeighbours();
      
      // Shift all subsequent cases up
      for (let i = doInputIndex + 1; i < inputs.length; i++) {
        const input = inputs[i];
        if (input.name === 'DEFAULT') {
          break;
        }
        const targetConnection = input.connection ? input.connection.targetConnection : null;
        if (targetConnection && inputs[i - 2]) {
          inputs[i - 2].connection.connect(targetConnection);
        }
      }
    }
    
    // Remove the last case
    this.removeCaseInput_();
  },
};

/**
 * Adds the initial plus button to blocks using this mutator.
 * @this {Blockly.Block}
 */
const switchCaseHelper = function () {
  // Add plus button for adding case to the first CASE input (CASE0)
  this.getInput('CASE0').insertFieldAt(0, createPlusField(), 'PLUS');
};

// Register the mutator
if (Blockly.Extensions.isRegistered('switch_case_mutator')) {
  Blockly.Extensions.unregister('switch_case_mutator');
}

Blockly.Extensions.registerMutator(
  'switch_case_mutator',
  switchCaseMutator,
  switchCaseHelper,
);

// Export for use in other files
export { switchCaseMutator, switchCaseHelper };
