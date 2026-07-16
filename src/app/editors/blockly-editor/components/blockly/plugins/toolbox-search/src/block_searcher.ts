/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from 'blockly/core';
import { create, insert, search, type AnyOrama } from '@orama/orama';
import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';

/**
 * A class that provides methods for indexing and searching blocks using Orama.
 */
export class BlockSearcher {
  private blockCreationWorkspace = new Blockly.Workspace();
  private db: AnyOrama;
  private blockTextMap = new Map<string, Set<string>>();

  constructor() {
    this.db = create({
      schema: {
        blockType: 'string',
        text: 'string',
      },
      components: { tokenizer: createMandarinTokenizer() },
    });
  }

  /**
   * Populates the Orama index with block types and their human-readable text.
   *
   * This method must be called before blockTypesMatching(). Behind the
   * scenes, it creates a workspace, loads the specified block types on it,
   * indexes their types and human-readable text, and cleans up after
   * itself.
   *
   * @param blockTypes A list of block types to index.
   */
  indexBlocks(blockTypes: string[]) {
    let blockCreationWorkspace = new Blockly.Workspace();

    try {
      blockTypes.forEach((blockType) => {
        const textParts = [blockType.replaceAll('_', ' ')];

        try {
          const block = blockCreationWorkspace.newBlock(blockType);
          block.inputList.forEach((input) => {
            input.fieldRow.forEach((field) => {
              this.collectDropdownText(field, textParts);
              if (field.getText()) {
                textParts.push(field.getText());
              }
            });
          });
        } catch (error) {
          console.warn(
            `[ToolboxSearch] Failed to collect searchable text for block "${blockType}".`,
            error,
          );
        }

        try {
          // 即使积木初始化失败，也保留类型名作为降级索引。
          const fullText = textParts.join(' ');
          this.blockTextMap.set(blockType, new Set(textParts));

          insert(this.db, {
            blockType,
            text: fullText,
          });
        } catch (error) {
          console.warn(
            `[ToolboxSearch] Failed to index block "${blockType}".`,
            error,
          );
        }

        try {
          // 失败的积木初始化可能会留下不完整积木，避免影响后续索引。
          blockCreationWorkspace.clear();
        } catch (error) {
          console.warn(
            `[ToolboxSearch] Failed to clear the indexing workspace after block "${blockType}".`,
            error,
          );
          try {
            blockCreationWorkspace.dispose();
          } catch {
            // The workspace is already unusable; replace it below.
          }
          blockCreationWorkspace = new Blockly.Workspace();
        }
      });
    } finally {
      blockCreationWorkspace.dispose();
    }
  }

  /**
   * Collect dropdown option text into the text parts array.
   *
   * @param field The field to check for dropdown options.
   * @param textParts The array to collect text into.
   */
  private collectDropdownText(field: Blockly.Field, textParts: string[]) {
    if (field instanceof Blockly.FieldDropdown) {
      field.getOptions(true).forEach((option) => {
        if (typeof option[0] === 'string') {
          textParts.push(option[0]);
        } else if ('alt' in option[0]) {
          textParts.push(option[0].alt);
        }
      });
    }
  }

  /**
   * Filters the available blocks based on the current query string.
   *
   * @param query The text to use to match blocks against.
   * @returns A list of block types matching the query.
   */
  blockTypesMatching(query: string): string[] {
    if (!query) return [];

    const results = search(this.db, {
      term: query,
      properties: ['blockType', 'text'],
      tolerance: 1,
      boost: {
        blockType: 2,
        text: 1,
      },
      limit: 50,
    }) as any;

    return results.hits.map((hit: any) => hit.document.blockType as string);
  }
}
