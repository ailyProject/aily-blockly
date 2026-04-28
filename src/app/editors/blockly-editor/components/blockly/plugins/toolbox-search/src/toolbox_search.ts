/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A toolbox category that provides a search field and displays matching blocks
 * in its flyout.
 */
import * as Blockly from 'blockly/core';
import { BlockSearcher } from './block_searcher';

/* eslint-disable @typescript-eslint/naming-convention */

/**
 * A toolbox category that provides a search field and displays matching blocks
 * in its flyout.
 */
export class ToolboxSearchCategory extends Blockly.ToolboxCategory {
  private static readonly START_SEARCH_SHORTCUT = 'startSearch';
  static readonly SEARCH_CATEGORY_KIND = 'search';
  private searchField?: HTMLInputElement;
  private blockSearcher = new BlockSearcher();

  /**
   * Initializes a ToolboxSearchCategory.
   *
   * @param categoryDef The information needed to create a category in the
   *     toolbox.
   * @param parentToolbox The parent toolbox for the category.
   * @param opt_parent The parent category or null if the category does not have
   *     a parent.
   */
  constructor(
    categoryDef: Blockly.utils.toolbox.CategoryInfo,
    parentToolbox: Blockly.IToolbox,
    opt_parent?: Blockly.ICollapsibleToolboxItem,
  ) {
    super(categoryDef, parentToolbox, opt_parent);
    try {
      this.initBlockSearcher();
      this.registerShortcut();
    } catch (error) {
      console.error('Error initializing ToolboxSearchCategory:', error);
    }
  }

  /**
   * Initializes the search field toolbox category.
   *
   * @returns The <div> that will be displayed in the toolbox.
   */
  protected override createDom_(): HTMLDivElement {
    const dom = super.createDom_();
    this.searchField = document.createElement('input');
    this.searchField.type = 'search';
    this.searchField.placeholder = 'Search';
    this.searchField.spellcheck = false;
    this.searchField.classList.add("search-box");
    this.searchField.addEventListener('keyup', (event) => {
      if (event.key === 'Escape') {
        this.parentToolbox_.clearSelection();
        return true;
      }

      this.matchBlocks();
    });
    this.rowContents_?.replaceChildren(this.searchField);
    return dom;
  }

  /**
   * Returns the numerical position of this category in its parent toolbox.
   *
   * @returns The zero-based index of this category in its parent toolbox, or -1
   *    if it cannot be determined, e.g. if this is a nested category.
   */
  private getPosition() {
    const categories = this.workspace_.options.languageTree?.contents || [];
    for (let i = 0; i < categories.length; i++) {
      if (categories[i].kind === ToolboxSearchCategory.SEARCH_CATEGORY_KIND) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Registers a shortcut for displaying the toolbox search category.
   */
  private registerShortcut() {
    const shortcut = Blockly.ShortcutRegistry.registry.createSerializedKey(
      Blockly.utils.KeyCodes.B,
      [Blockly.utils.KeyCodes.CTRL],
    );
    Blockly.ShortcutRegistry.registry.register({
      name: ToolboxSearchCategory.START_SEARCH_SHORTCUT,
      callback: () => {
        const position = this.getPosition();
        if (position < 0) return false;
        this.parentToolbox_.selectItemByPosition(position);
        return true;
      },
      keyCodes: [shortcut],
    });
  }

  /**
   * Returns a list of block types that are present in the toolbox definition.
   *
   * @param schema A toolbox item definition.
   * @param allBlocks The set of all available blocks that have been encountered
   *     so far.
   */
  private getAvailableBlocks(
    schema: Blockly.utils.toolbox.ToolboxItemInfo,
    allBlocks: Set<string>,
  ) {
    if ('contents' in schema) {
      schema.contents.forEach((contents) => {
        this.getAvailableBlocks(contents, allBlocks);
      });
    } else if (schema.kind.toLowerCase() === 'block') {
      if ('type' in schema && schema.type) {
        allBlocks.add(schema.type);
      }
    }
  }

  /**
   * Builds the BlockSearcher index based on the available blocks.
   */
  private initBlockSearcher() {
    const availableBlocks = new Set<string>();
    this.workspace_.options.languageTree?.contents?.forEach((item) =>
      this.getAvailableBlocks(item, availableBlocks),
    );
    this.blockSearcher.indexBlocks([...availableBlocks]);
  }

  /**
   * Handles a click on this toolbox category.
   *
   * @param e The click event.
   */
  override onClick(e: Event) {
    super.onClick(e);
    e.preventDefault();
    e.stopPropagation();
    this.setSelected(this.parentToolbox_.getSelectedItem() === this);
  }

  /**
   * Handles changes in the selection state of this category.
   *
   * @param isSelected Whether or not the category is now selected.
   */
  override setSelected(isSelected: boolean) {
    super.setSelected(isSelected);
    if (!this.searchField) return;
    if (isSelected) {
      this.searchField.focus();
      this.matchBlocks();
    } else {
      this.searchField.value = '';
      this.searchField.blur();
    }
  }

  /**
   * Filters the available blocks based on the current query string.
   */
  private matchBlocks() {
    const query = this.searchField?.value.trim() || '';

    if (!query) {
      this.flyoutItems_ = [];
      (this.workspace_ as Blockly.WorkspaceSvg).getFlyout()?.hide();
      return;
    }

    this.flyoutItems_ = this.blockSearcher.blockTypesMatching(query).map((blockType) => {
      return {
        kind: 'block',
        type: blockType,
      };
    });

    if (!this.flyoutItems_.length) {
      this.flyoutItems_.push({
        kind: 'label',
        text: 'No matching blocks found',
      });
    }
    this.parentToolbox_.refreshSelection();
  }

  /**
   * Disposes of this category.
   */
  override dispose() {
    super.dispose();
    Blockly.ShortcutRegistry.registry.unregister(
      ToolboxSearchCategory.START_SEARCH_SHORTCUT,
    );
  }
}

Blockly.registry.register(
  Blockly.registry.Type.TOOLBOX_ITEM,
  ToolboxSearchCategory.SEARCH_CATEGORY_KIND,
  ToolboxSearchCategory,
);
