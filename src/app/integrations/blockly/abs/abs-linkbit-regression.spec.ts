import { captureAbsBlockCapabilities } from './abs-block-capabilities';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { createAbsProjection, hashAbsText, indexAbsAbi } from './abs-identity-map';
import type { AbsAuthoringContracts } from './abs-precheck';
import { reconcileAbsDraft, type AbsReconcileOptions } from './abs-reconciler';
import type { AbsAbiWorkspace } from './abs-state';
import { AbsWorkspaceSyncService } from './abs-workspace-sync.service';

const roots = ['arduino_global', 'arduino_setup', 'arduino_loop'];
const rootSlot = (type: string) => type.toUpperCase();
const statement = (name: string) => ({ type: 'input_statement', name });
const value = (name: string) => ({ type: 'input_value', name });
const dropdown = (name: string, ...keys: string[]) => ({ type: 'field_dropdown', name, options: keys.map(key => [key, key]) });
const epdVariable = { type: 'field_variable', name: 'VAR', variableTypes: ['LinkbitEPD'] };
const stack = { previousStatement: null, nextStatement: null };
const bitmapType = 'linkbit_epd_image_portrait';
const bitmapField = { type: 'field_bitmap_u8g2', name: 'CUSTOM_BITMAP', width: 104, height: 212 };

// Persistence-relevant shape from the project library and core blocks, without
// UI strings, styles or the user-provided bitmap bytes.
const definitions = [
  ...roots.map(type => ({ type, message0: '%1', args0: [statement(rootSlot(type))] })),
  { type: 'linkbit_epd_init', message0: '%1', args0: [{ type: 'field_input', name: 'VAR', text: 'epd' }], ...stack },
  { type: 'linkbit_epd_set_rotation', message0: '%1 %2', args0: [epdVariable, dropdown('ROTATION', '0', '1', '2', '3')], ...stack },
  { type: 'linkbit_epd_frame', message0: '%1 %2', args0: [epdVariable, dropdown('BG', 'WHITE', 'KEEP')],
    message1: '%1', args1: [statement('DRAW')], ...stack },
  { type: 'linkbit_epd_draw_image', message0: '%1 %2 %3 %4 %5',
    args0: [epdVariable, value('X'), value('Y'), value('IMAGE'), value('COLOR')], ...stack },
  { type: bitmapType, message0: '%1', args0: [bitmapField], output: 'LinkbitEPDBitmap' },
  { type: 'linkbit_epd_color', message0: '%1',
    args0: [dropdown('COLOR', 'LINKBIT_EPD_BLACK', 'LINKBIT_EPD_DARKGREY', 'LINKBIT_EPD_LIGHTGREY', 'LINKBIT_EPD_WHITE')],
    output: 'Number' },
  { type: 'time_delay', message0: '%1', args0: [value('DELAY_TIME')], ...stack },
  { type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' },
];
const jsonByType = new Map(definitions.map(definition => [definition.type, definition]));
const shapes = new Map(definitions.map(definition => [definition.type, compileAbsDeclarativeContract(definition)]));
const captureCatalog = () => ({
  types: [...jsonByType.keys()], get: (type: string) => jsonByType.get(type),
  registered: (type: string) => jsonByType.has(type), assertCurrent: () => undefined,
});
const contracts: AbsAuthoringContracts = {
  blockContract: type => shapes.get(type),
  knownType: type => shapes.has(type),
  argumentOrder: type => shapes.get(type)?.argumentOrder,
};

const bitmap = { encoding: 'xbm-lsb-row-v1', height: 98, schemaVersion: 1, width: 104 };
const asset = {
  codec: 'u8g2-xbm-v1', id: 'sha256:' + 'a'.repeat(64), logicalType: 'binary', rawLength: 1274,
  schemaVersion: 1, storage: 'raw-v1', storedLength: 1274,
};
const structuredBitmap = { ...bitmap, $ailyData: asset };

// Linkbit treatment tool calls 26, 32, 36 and 38. Only the asset hash is replaced.
const initialAttempt = { blocks: [
  { fields: { VAR: { variable: 'epd' } }, statements: {}, type: 'linkbit_epd_init', values: {} },
  { extraState: null, fields: {}, type: bitmapType, values: {
    CUSTOM_BITMAP: { fields: { bitmap_field: structuredBitmap }, type: 'field_bitmap_u8g2' },
  } },
] };
function rootedAttempt(setup: string, loop: string, background: 'fields' | 'values') {
  return { blocks: [
    { type: 'arduino_setup', statements: { [setup]: [
      { type: 'linkbit_epd_init', fields: { VAR: 'epd' } },
      { type: 'linkbit_epd_set_rotation', fields: { ROTATION: '0', VAR: '$epd' } },
      { type: 'linkbit_epd_frame', [background]: { BG: 'WHITE' }, statements: { DRAW: [
        { type: 'linkbit_epd_draw_image', fields: { COLOR: 'LINKBIT_EPD_BLACK', VAR: '$epd', X: 0, Y: 57 },
          values: { IMAGE: { type: bitmapType, fields: { CUSTOM_BITMAP: structuredBitmap } } } },
      ] } },
    ] } },
    { type: 'arduino_loop', statements: { [loop]: [
      { fields: {}, type: 'time_delay', values: { DELAY: { fields: {}, type: 'math_number', values: {} } } },
    ] } },
  ] };
}

function authoring(program: unknown) {
  const editor = {
    workspace: {}, getActivePageId: () => 'page-1',
    captureDeclarativeBlockDefinitions: captureCatalog,
  } as unknown as ConstructorParameters<typeof AbsWorkspaceSyncService>[0];
  const project = { currentProjectPath: 'linkbit' } as ConstructorParameters<typeof AbsWorkspaceSyncService>[1];
  return new AbsGenerationToolsService(new AbsWorkspaceSyncService(editor, project))
    .authoring('abs_compose', { version: 1, program });
}

function composeIssues(program: unknown) {
  const reply = authoring(program);
  expect(reply).toEqual(jasmine.objectContaining({ ok: false, operation: 'abs_compose', code: 'ABS_COMPOSE_INVALID' }));
  expect(Object.hasOwn(reply, 'abs')).toBeFalse();
  expect(Object.hasOwn(reply, 'receipt')).toBeFalse();
  if (!('composeDiagnostics' in reply) || !reply.composeDiagnostics) throw new Error('Expected structured authoring diagnostics.');
  expect(reply.composeDiagnostics.truncated).toBeFalse();
  expect(JSON.stringify(reply.composeDiagnostics)).not.toContain(asset.id);
  return reply.composeDiagnostics.issues;
}

const frame = '/blocks/0/statements/ARDUINO_SETUP/2';
const draw = frame + '/statements/DRAW/0';

describe('Linkbit archived ABS failures', () => {
  it('identifies the initial literal field used as a variable reference', () => {
    const issues = composeIssues(initialAttempt);
    expect(issues).toContain(jasmine.objectContaining({
      path: '/blocks/0/fields/VAR', blockType: 'linkbit_epd_init', expected: 'field_input', actual: 'variable-reference',
    }));
  });

  it('reports the incorrect statement owners for both roots in one response', () => {
    const issues = composeIssues(rootedAttempt('DO', 'DO', 'values'));
    expect(issues).toContain(jasmine.objectContaining({
      path: '/blocks/0/statements/DO', expected: 'statement', allowed: ['ARDUINO_SETUP'],
    }));
    expect(issues).toContain(jasmine.objectContaining({
      path: '/blocks/1/statements/DO', expected: 'statement', allowed: ['ARDUINO_LOOP'],
    }));
    expect(issues).toContain(jasmine.objectContaining({
      path: '/blocks/0/statements/DO/2/values/BG', expected: 'field_dropdown',
    }));
  });

  it('locates the misplaced dropdown and reports its legal values after root slots are corrected', () => {
    const issues = composeIssues(rootedAttempt('ARDUINO_SETUP', 'ARDUINO_LOOP', 'values'));
    expect(issues.filter(issue => issue.path === frame + '/values/BG')).toEqual([jasmine.objectContaining({
      path: frame + '/values/BG', blockType: 'linkbit_epd_frame', expected: 'field_dropdown', allowed: ['WHITE', 'KEEP'],
    })]);
    expect(issues).toContain(jasmine.objectContaining({
      path: '/blocks/1/statements/ARDUINO_LOOP/0/values/DELAY', blockType: 'time_delay', allowed: ['DELAY_TIME'],
    }));
  });

  it('locates native-only bitmap JSON and misplaced draw inputs in the final structured retry', () => {
    const issues = composeIssues(rootedAttempt('ARDUINO_SETUP', 'ARDUINO_LOOP', 'fields'));
    expect(issues).toContain(jasmine.objectContaining({
      path: draw + '/values/IMAGE/fields/CUSTOM_BITMAP', blockType: bitmapType, fallback: 'text-abs',
      message: jasmine.stringMatching(/original serialized value unchanged as one JSON field argument in text ABS/),
    }));
    for (const input of ['X', 'Y', 'COLOR']) {
      expect(issues).toContain(jasmine.objectContaining({
        path: draw + '/fields/' + input, blockType: 'linkbit_epd_draw_image', expected: 'value',
      }));
    }
  });

  it('reports the same slot mismatch for an unrelated core number block', () => {
    const describeBlock = captureAbsBlockCapabilities(captureCatalog());
    expect(describeBlock('math_number')).toEqual(jasmine.objectContaining({
      level: 'create', shape: jasmine.objectContaining({
        argumentOrder: [{ name: 'NUM', kind: 'field' }],
        fields: { NUM: { type: 'field_number' } },
        inputs: {},
      }),
    }));
    const issues = composeIssues({ blocks: [{ type: 'math_number', values: { NUM: 7 } }] });
    expect(issues).toEqual([jasmine.objectContaining({
      path: '/blocks/0/values/NUM', blockType: 'math_number', expected: 'field_number',
    })]);
    expect(issues.some(issue => issue.fallback === 'text-abs')).toBeFalse();
    const corrected = authoring({ blocks: [{ type: 'math_number', fields: { NUM: 7 } }] });
    expect(corrected).toEqual(jasmine.objectContaining({
      ok: true, abs: jasmine.stringMatching(/math_number\(NUM=7\)/),
      precheck: jasmine.objectContaining({ ok: true, scope: 'static-precheck', nativeValidationRequired: true }),
    }));
    expect(Object.hasOwn(corrected, 'receipt')).toBeFalse();
  });

  it('rejects the archived handwritten candidate without the existing protected global root', async () => {
    const rootBlocks = roots.map((type, index) => ({
      type, id: type + '_id0', deletable: false, x: 30, y: 60 + index * 120,
    }));
    const workspace: AbsAbiWorkspace = { blocks: { blocks: rootBlocks, languageVersion: 0 } };
    const document = {
      $ailyProjectData: { mode: 'external-only', schemaVersion: 1 },
      activePageId: 'page-1', openedPageIds: ['page-1'], schemaVersion: 3,
      pages: [{ id: 'page-1', title: '页面 1', viewState: { scale: 1, scrollX: 0, scrollY: 0 }, content: workspace }],
      sharedModel: { procedureBlocks: [] },
    };
    const projection = await createAbsProjection(workspace, {
      document, generation: 'linkbit-read', baselineRef: 'linkbit-saved',
      savedAbiHash: await hashAbsText(JSON.stringify(document)), scope: { projectKey: 'linkbit', pageId: 'page-1' },
      contracts: {
        fields: Object.fromEntries(rootBlocks.map(block => [block.id, {}])),
        syntax: Object.fromEntries(rootBlocks.map(block => [block.id, shapes.get(block.type)!.argumentOrder!])),
      },
    });
    const exportedRead = projection.abs;
    expect(exportedRead).toContain('arduino_global() @protect:{"deletable":false}');
    expect(exportedRead).toContain('# @project-state:');
    const bitmapJson = JSON.stringify({ ...bitmap, bitmap: { $ailyData: asset } });
    // The archived replacement supplied both nonempty roots, but no global root
    // or project-state footer. Retained IDs and protection come from the read.
    const header = '# ABS Schema: 2\n# Project Data Schema: 1 (external-only)\n\n';
    const program = 'arduino_setup()\n'
      + '    linkbit_epd_init(VAR="epd")\n'
      + '    linkbit_epd_set_rotation($epd, 0)\n'
      + '    linkbit_epd_frame($epd, WHITE)\n'
      + '        @DRAW:\n'
      + '            linkbit_epd_draw_image($epd, math_number(0), math_number(57), '
      + 'linkbit_epd_image_portrait(' + bitmapJson + '), linkbit_epd_color(LINKBIT_EPD_BLACK))\n\n'
      + 'arduino_loop()\n'
      + '    time_delay(math_number(1000))\n';
    const reconcile: AbsReconcileOptions = {
      ...contracts,
      requireDeletionEvidence: true,
      argumentOrder: type => type === bitmapType ? [{ name: 'CUSTOM_BITMAP', kind: 'field' }] : contracts.argumentOrder?.(type),
      fieldDefinition: (type, field) => type === bitmapType && field === 'CUSTOM_BITMAP'
        ? { type: bitmapField.type, valueType: 'json' } : shapes.get(type)?.fields[field],
      // Stand in for the native preparation of the library's LinkbitEPD model.
      variableCreation: { requestId: 'linkbit-read-candidate', variables: [{ name: 'epd', type: 'LinkbitEPD' }] },
    };
    await expectAsync(reconcileAbsDraft(projection, header + program, reconcile)).toBeRejectedWith(jasmine.objectContaining({
      code: 'ABS_PROTECTED_BLOCK_MISSING', blockIds: ['arduino_global_id0'],
      diagnostic: jasmine.objectContaining({ blockType: 'arduino_global' }),
    }));
    const restoredRoot = 'arduino_global() @protect:{"deletable":false}\n\n';
    const corrected = await reconcileAbsDraft(projection, header + restoredRoot + program, reconcile);
    expect(corrected.removed).toEqual([]);
    expect(corrected.retained).toEqual(rootBlocks.map(block => block.id));
    expect(corrected.workspace.blocks.blocks[0]).toEqual(rootBlocks[0]);
    const restoredBitmap = [...indexAbsAbi(corrected.workspace).values()].find(block => block.type === bitmapType);
    expect(restoredBitmap?.fields?.['CUSTOM_BITMAP']).toEqual(JSON.parse(bitmapJson));
    expect(projection.abs).toBe(exportedRead);
    expect(projection.workspace.blocks.blocks).toEqual(rootBlocks);
  });
});
