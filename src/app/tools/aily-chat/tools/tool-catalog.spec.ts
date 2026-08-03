import { TOOL_CATALOG, getDeferredToolsListing, searchDeferredTools } from './tool-catalog';
import { convertAbiToAbs, convertAbsToAbi } from './abiAbsConverter';
import { prepareBlockFieldValue } from './blockFieldValue';
import {
  getGlobalBlockMetas,
  setGlobalBlockMetas,
  type BlockMeta,
} from '../services/block-definition.service';

describe('prepareBlockFieldValue', () => {
  it('keeps structured custom-field state intact', () => {
    const value = {
      $ailyData: { id: 'image-1', codec: 'rgb565' },
      width: 16,
      height: 16,
    };

    expect(prepareBlockFieldValue({}, value)).toBe(value);
  });

  it('maps variable descriptors to id first and then name', () => {
    const variableField = { getVariable: () => ({}) };

    expect(prepareBlockFieldValue(variableField, { id: 'variable-id', name: 'counter' }))
      .toBe('variable-id');
    expect(prepareBlockFieldValue(variableField, { name: 'counter' }))
      .toBe('counter');
  });

  it('normalizes scalar Blockly field values to strings', () => {
    expect(prepareBlockFieldValue({}, 42)).toBe('42');
    expect(prepareBlockFieldValue({}, true)).toBe('true');
  });
});

describe('ABS Project Data header boundary', () => {
  it('keeps generic conversion headerless while file import can require the header', () => {
    const headerlessAbs = 'dynamic_value()';

    expect(convertAbsToAbi(headerlessAbs).success).toBeTrue();
    const strictResult = convertAbsToAbi(headerlessAbs, {
      requireProjectDataHeader: true,
    });
    expect(strictResult.success).toBeFalse();
    expect(strictResult.errors?.[0].message).toContain('Missing Project Data Schema');
  });
});

describe('tool-catalog', () => {
  it('filters deferred listing by excluded tools', () => {
    const listing = getDeferredToolsListing('mainAgent', new Set(['create_project']));

    expect(listing).toContain('search_available_tools');
    expect(listing).not.toContain('create_project');
  });

  it('returns exact deferred tool matches', () => {
    const matches = searchDeferredTools('create_project', TOOL_CATALOG, 'mainAgent');

    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('create_project');
  });

  it('filters out agent-incompatible deferred tools', () => {
    const matches = searchDeferredTools('create_project', TOOL_CATALOG, 'schematicAgent');

    expect(matches).toEqual([]);
  });

  it('expands deferred group searches', () => {
    const matches = searchDeferredTools('项目管理', TOOL_CATALOG, 'mainAgent');
    const names = matches.map(tool => tool.name);

    expect(names).toContain('create_project');
    expect(names).toContain('reload_project');
    expect(names).toContain('switch_board');
  });

  it('keeps Blockly catalog aligned to the operation surface', () => {
    const names = new Set(TOOL_CATALOG.map(tool => tool.name));

    expect(names.has('syncAbs')).toBeTrue();
    expect(names.has('lint')).toBeTrue();
    expect(names.has('analyzeLibrary')).toBeTrue();

    expect(names.has('get_workspace_overview_tool')).toBeFalse();
    expect(names.has('analyze_library_blocks')).toBeFalse();
    expect(names.has('delete_folder')).toBeFalse();
  });
});

function createAbsBlockMeta(
  type: string,
  argsOrder: BlockMeta['argsOrder'],
  fieldTypes: Array<[string, string]> = [],
): BlockMeta {
  return {
    type,
    fieldNames: argsOrder.filter(arg => arg.kind === 'field').map(arg => arg.name),
    fieldTypes: new Map(fieldTypes),
    valueInputNames: argsOrder.filter(arg => arg.kind === 'valueInput').map(arg => arg.name),
    statementInputNames: argsOrder.filter(arg => arg.kind === 'statementInput').map(arg => arg.name),
    argsOrder,
    hasOutput: true,
    hasPrevious: false,
    hasNext: false,
    isRootBlock: true,
    library: 'test',
  };
}

describe('ABI ↔ ABS structured state conversion', () => {
  let previousMetas: Map<string, BlockMeta> | null;

  beforeEach(() => {
    previousMetas = getGlobalBlockMetas();
    setGlobalBlockMetas(new Map([
      [
        'u8g2_animation',
        createAbsBlockMeta(
          'u8g2_animation',
          [{ name: 'CUSTOM_ANIMATION', kind: 'field' }],
          [['CUSTOM_ANIMATION', 'field_u8g2_animation']],
        ),
      ],
      [
        'dynamic_demo',
        createAbsBlockMeta(
          'dynamic_demo',
          [{ name: 'LABEL', kind: 'field' }],
          [['LABEL', 'field_input']],
        ),
      ],
      [
        'value_parent',
        createAbsBlockMeta('value_parent', [{ name: 'VALUE', kind: 'valueInput' }]),
      ],
      [
        'dynamic_value',
        createAbsBlockMeta('dynamic_value', []),
      ],
    ]));
  });

  afterEach(() => {
    setGlobalBlockMetas(previousMetas ?? new Map());
  });

  it('round-trips animation frame arrays stored in custom object fields', () => {
    const animation = {
      width: 4,
      height: 2,
      fps: 10,
      maxFrames: 30,
      dither: false,
      threshold: 127,
      sourceName: 'demo, frame.gif',
      frames: [
        [[0, 1, 0, 1], [1, 0, 1, 0]],
        [[1, 1, 0, 0], [0, 0, 1, 1]],
      ],
    };
    const abi = {
      blocks: {
        languageVersion: 0,
        blocks: [{
          type: 'u8g2_animation', id: 'animation-block', x: 30, y: 30,
          fields: { CUSTOM_ANIMATION: animation },
        }],
      },
      variables: [],
    };

    const abs = convertAbiToAbs(abi, { includeHeader: false });
    expect(abs).toContain(`u8g2_animation(${JSON.stringify(animation)})`);

    const imported = convertAbsToAbi(abs);
    expect(imported.success).toBeTrue();
    expect(imported.abiJson.blocks.blocks[0].fields.CUSTOM_ANIMATION).toEqual(animation);
  });

  it('round-trips portable extraState and removes workspace-only IDs', () => {
    const abi = {
      blocks: {
        languageVersion: 0,
        blocks: [{
          type: 'dynamic_demo', id: 'dynamic-block', x: 30, y: 30,
          fields: { LABEL: 'demo' },
          extraState: {
            itemCount: 3,
            customFlag: true,
            params: [{ type: 'int', name: 'count' }],
            funcVarId: 'workspace::FUNC',
            paramVarIds: ['workspace::PARAM::0'],
          },
        }],
      },
      variables: [],
    };

    const abs = convertAbiToAbs(abi, { includeHeader: false });
    expect(abs).toContain('@extra:{"itemCount":3,"customFlag":true,"params":[{"type":"int","name":"count"}]}');
    expect(abs).not.toContain('workspace::');

    const imported = convertAbsToAbi(abs);
    expect(imported.success).toBeTrue();
    expect(imported.abiJson.blocks.blocks[0].extraState).toEqual({
      itemCount: 3,
      customFlag: true,
      params: [{ type: 'int', name: 'count' }],
    });
  });

  it('round-trips extraState on inline value blocks', () => {
    const abi = {
      blocks: {
        languageVersion: 0,
        blocks: [{
          type: 'value_parent', id: 'parent-block', x: 30, y: 30,
          inputs: {
            VALUE: {
              block: {
                type: 'dynamic_value',
                id: 'dynamic-value-block',
                extraState: { mode: 'expanded', itemCount: 2 },
              },
            },
          },
        }],
      },
      variables: [],
    };

    const abs = convertAbiToAbs(abi, { includeHeader: false });
    expect(abs).toContain('value_parent(dynamic_value() @extra:{"mode":"expanded","itemCount":2})');

    const imported = convertAbsToAbi(abs);
    expect(imported.success).toBeTrue();
    expect(imported.abiJson.blocks.blocks[0].inputs.VALUE.block.extraState).toEqual({
      mode: 'expanded',
      itemCount: 2,
    });
  });
});
