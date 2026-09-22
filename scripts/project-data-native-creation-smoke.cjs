const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');
const { seedDerivedImages, inspectDerivedImages } = require('./project-data-derived-image-smoke.cjs');

async function testNativeCreation(page, source, root) {
  const libraries = [process.env.AILY_ABS_DHT_LIBRARY, process.env.AILY_ABS_MAX31865_LIBRARY];
  if (process.env.AILY_ABS_MEDIA_LIBRARY) libraries.push(process.env.AILY_ABS_MEDIA_LIBRARY);
  if (process.env.AILY_ABS_DERIVED_LIBRARY) libraries.push(process.env.AILY_ABS_DERIVED_LIBRARY);
  libraries.forEach(library => assert.ok(library && path.isAbsolute(library), 'Supply readonly library sources'));
  const { project, initial } = await openBlankProject(page, source, root, 'Native Creation', libraries);
  // Optional real media fixture: the existing field editor writes its normal
  // Project Data resource; no custom storage writer or candidate-only field.
  const media = process.env.AILY_ABS_MEDIA_LIBRARY ? await page.evaluate(async project => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const block = editor.workspace.newBlock('u8g2_bitmap', 'native_media_sentinel');
    block.initSvg(); block.render(); block.moveBy(500, 50);
    const field = block.getField('CUSTOM_BITMAP');
    const pixels = Array.from({ length: 64 }, (_, y) => Array.from({ length: 128 }, (_, x) => (x + y) % 3 === 0 ? 1 : 0));
    field.commitBitmap(pixels);
    const saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw new Error(saved.error);
    if (!field.getValue().bitmap?.$ailyData) throw new Error('Media must be externalized');
    return { id: block.id, value: field.getValue(), pixels };
  }, project) : null;
  const images = process.env.AILY_ABS_DERIVED_LIBRARY ? await seedDerivedImages(page, project) : [];
  const agent = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'native-creation');
  const inspect = async () => {
    const result = await page.evaluate(async ({ initial, media, imageCount }) => {
      const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
      const editor = component.blocklyService, workspace = editor.workspace;
      const prepared = await editor.runWithPreparedProjectCode(prepared => ({ code: prepared.code, artifacts: prepared.artifacts }));
      const { code, artifacts } = prepared;
      for (const root of initial) if (workspace.getBlockById(root.id)?.isDeletable() !== root.deletable) throw new Error('Protected root changed');
      const dht = workspace.getBlocksByType('dht_init', false), rtd = workspace.getBlocksByType('max31865_init', false);
      if (workspace.getAllBlocks(false).length !== (media ? 6 : 5) + imageCount || dht.length !== 1 || rtd.length !== 1) throw new Error('Unexpected native block inventory');
      if (dht[0].getFieldValue('TYPE') !== 'DHT22' || dht[0].getFieldValue('PIN') !== 'D0'
        || rtd[0].getFieldValue('SPI_MODE') !== 'SW' || rtd[0].getFieldValue('SW_MISO_PIN') !== 'D4') throw new Error('Native configuration not retained');
      let mediaState;
      if (media) {
        const field = workspace.getBlockById(media.id)?.getField('CUSTOM_BITMAP');
        if (!field) throw new Error('Media field is missing after native apply/reopen');
        mediaState = { value: field.getValue(), pixels: await field.ensureBitmapLoaded() };
        const generated = [code, ...(artifacts || []).map(item => item.content)].join('\n');
        const data = /bitmap_nativemediasentinel_data\[\] PROGMEM = \{([\s\S]*?)\}/.exec(generated);
        if (!data) throw new Error('Actual media C++ declaration missing');
        const actual = [...data[1].matchAll(/0x([a-f0-9]{2})/gi)].map(match => parseInt(match[1], 16));
        const expected = media.pixels.flatMap(row => Array.from({ length: 16 }, (_, i) =>
          row.slice(i * 8, i * 8 + 8).reduce((value, bit, offset) => value | (bit << offset), 0)));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Generated C++ media bytes differ');
      }
      return { state: editor.getWorkspaceJson(), ids: workspace.getAllBlocks(false).map(block => block.id).sort(), code, artifacts, mediaState };
    }, { initial, media, imageCount: images.length });
    if (media) {
      assert.deepEqual(result.mediaState.value, media.value, 'Media JSON value must survive native apply/reopen');
      assert.deepEqual(result.mediaState.pixels, media.pixels, 'Every media pixel must survive native apply/reopen');
    }
    return { ...result, derivedImages: images.length ? await inspectDerivedImages(page, images) : [] };
  };
  const before = await inspect(); assert.match(before.code, /DHT native_dht\(D0, DHT22\)/); assert.match(before.code, /Adafruit_MAX31865 native_rtd\(/);
  for (const artifact of before.artifacts || []) assert.equal(fs.readFileSync(path.join(project, 'src', artifact.fileName), 'utf8'), artifact.content);
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'], mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Native project reopen failed');
  }, project);
  await waitForBlankProject(page); assert.deepEqual(await inspect(), before);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(project, file)), mirrors[i]));
  return { agent, project, reopened: true, protectedRoots: initial.length, code: before.code,
    derivedImages: { count: images.length, pixels: before.derivedImages.map(image => image.pixels), preserved: true },
    ...(media ? { media: { id: media.id, value: media.value, pixelCount: media.pixels.flat().length, preserved: true } } : {}) };
}
module.exports = { testNativeCreation };
