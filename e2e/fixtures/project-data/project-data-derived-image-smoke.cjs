const assert = require('node:assert/strict');

// Use the real field's normal write path and actual library generator. Identical
// display filenames must not alias distinct content-addressed image resources.
async function seedDerivedImages(page, project) {
  return page.evaluate(async project => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const result = [];
    for (const [name, color, rgb565, height] of [['red', '#ff0000', 0xf800, 8], ['blue', '#0000ff', 0x001f, 16]]) {
      const block = editor.workspace.newBlock('tft_image_file', `derived_${name}`);
      block.initSvg(); block.render(); block.moveBy(600, name === 'red' ? 200 : 400);
      block.setFieldValue('8', 'WIDTH'); block.setFieldValue(String(height), 'HEIGHT');
      const field = block.getField('IMAGE_PREVIEW');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      field.updateValueWithImageData(canvas.toDataURL());
      let saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw Error(saved.error);
      field.setValue({ ...field.getValue(), filePath: 'same.png', width: 8, height });
      saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw Error(saved.error);
      if (!field.getValue().image?.$ailyData) throw Error('Derived image must be externalized');
      result.push({ id: block.id, value: field.getValue(), rgb565, width: 8, height });
    }
    return result;
  }, project);
}

async function inspectDerivedImages(page, images) {
  const result = await page.evaluate(async images => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const prepared = await editor.runWithPreparedProjectCode(prepared => ({ code: prepared.code, artifacts: prepared.artifacts }));
    const generated = [prepared.code, ...(prepared.artifacts || []).map(item => item.content)].join('\n');
    return images.map(image => {
      const field = editor.workspace.getBlockById(image.id)?.getField('IMAGE_PREVIEW');
      if (!field) throw Error('Derived image field disappeared');
      const name = `imageFile_${image.id.replace(/[^a-zA-Z0-9]/g, '')}`;
      const declaration = new RegExp(name + '\\[\\] PROGMEM = \\{([\\s\\S]*?)\\}').exec(generated);
      if (!declaration) throw Error('Actual derived image C++ declaration missing: ' + name);
      return { value: field.getValue(), pixels: [...declaration[1].matchAll(/0x([a-f0-9]{4})/gi)].map(match => parseInt(match[1], 16)) };
    });
  }, images);
  result.forEach((image, i) => {
    assert.deepEqual(image.value, images[i].value, 'Image envelope and original filename must survive apply/reopen');
    assert.deepEqual(image.pixels, Array(images[i].width * images[i].height).fill(images[i].rgb565), 'Every generated pixel must match the original resource, never a placeholder');
  });
  return result;
}
module.exports = { seedDerivedImages, inspectDerivedImages };
