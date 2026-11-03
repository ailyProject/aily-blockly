const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { selectFirmwareFile } = require('../child/scripts/firmware-selection');
const { processUploadParams } = require('../child/scripts/upload');

function fixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-firmware 空格-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const put = (name, contents = 'firmware') => {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), {recursive: true});
        fs.writeFileSync(filename, contents);
        return filename;
    };
    files.forEach(name => put(name));
    const parse = (command = "esptool write_flash 0x10000 ${'*.bin'}", platform = 'darwin') =>
        processUploadParams(command, root, root, root, '921600', {}, 'TEST_PORT', platform, undefined, true);
    return {root, put, parse};
}

const auxiliary = ['boot_app0.bin', 'sketch.bootloader.bin', 'sketch.partitions.bin', 'sketch.merged.bin',
    'ota_data_initial.bin', 'spiffs.bin', 'littlefs.bin', 'filesystem.bin', 'fatfs.bin', 'sketch.with_bootloader.bin'];

for (const app of ['sketch.bin', 'Blink.ino.bin', '应用.v2.bin']) {
    test(`old board wildcard selects ${app} with normal ESP32 auxiliary images`, async t => {
        const f = fixture(t, [...auxiliary, app]);
        const command = await f.parse("esptool --port ${serial} write_flash 0x0 ${bootloader} 0x8000 ${partitions} 0xe000 ${boot_app0} 0x10000 ${'*.bin'}");
        for (const [offset, file] of [['0x0','sketch.bootloader.bin'],['0x8000','sketch.partitions.bin'],['0x10000',app]]) {
            assert.equal(command.args[command.args.indexOf(offset) + 1], `"${path.join(f.root,file)}"`);
        }
        assert(command.args.includes('TEST_PORT'));
    });
}

for (const extra of ['000-ai-output.bin', 'backup/old.bin', 'Blink.ino.bin', 'backup/sketch.bin']) {
    test(`stale or AI output ${extra} blocks instead of picking first/newest/preferred name`, async t => {
        const f = fixture(t, ['sketch.bin', extra, ...auxiliary]);
        const future = new Date(Date.now() + 3600000);
        fs.utimesSync(path.join(f.root, extra), future, future);
        await assert.rejects(f.parse(), error => /FIRMWARE_AMBIGUOUS/.test(error.message)
            && error.message.includes(extra) && error.message.includes('sketch.bin'));
    });
}

test('auxiliary-only directory and empty application cannot be uploaded', async t => {
    const f = fixture(t, auxiliary);
    await assert.rejects(f.parse(), /FIRMWARE_NOT_FOUND/);
    f.put('sketch.bin', '');
    await assert.rejects(f.parse(), /FIRMWARE_EMPTY/);
});

test('multiple bootloaders/partitions also fail before mixing firmware sets', async t => {
    const f = fixture(t, ['sketch.bin','sketch.bootloader.bin','old.bootloader.bin','sketch.partitions.bin','old.partitions.bin']);
    await assert.rejects(f.parse('esptool 0x0 ${bootloader}'), /FIRMWARE_AMBIGUOUS/);
    await assert.rejects(f.parse('esptool 0x8000 ${partitions}'), /FIRMWARE_AMBIGUOUS/);
});

test('explicit auxiliary filenames remain usable and dots are literal', async t => {
    const f = fixture(t, ['sketch.bin','sketch.merged.bin','sketch.partitions.bin','sketchXpartitions.bin']);
    assert.equal(selectFirmwareFile(['a+b.bin','aaab.bin'], 'a+b.bin'),'a+b.bin');
    const command = await f.parse("esptool 0x0 ${'sketch.merged.bin'} 0x8000 ${'sketch.partitions.bin'}");
    assert(command.args.includes(`"${path.join(f.root,'sketch.merged.bin')}"`));
    assert(command.args.includes(`"${path.join(f.root,'sketch.partitions.bin')}"`));
});

test('native AVR hex excludes the with-bootloader variant and preserves embedded args', async t => {
    const f = fixture(t, ['Blink.v2.hex','Blink.v2.with_bootloader.hex']);
    const command = await f.parse("avrdude -Uflash:w:${'*.hex'}:i", 'win32');
    assert.deepEqual(command.args,[`-Uflash:w:"${path.join(f.root,'Blink.v2.hex')}":i`]);
    f.put('other.hex');
    await assert.rejects(f.parse("avrdude -Uflash:w:${'*.hex'}:i"), /FIRMWARE_AMBIGUOUS/);
});

for (const ext of ['elf','uf2','img','eep']) {
    test(`${ext} discovery preserves unique files and rejects ambiguity`, async t => {
        const f = fixture(t, [`app.${ext}`]);
        const recipe = `flash \${'*.${ext}'}`;
        assert((await f.parse(recipe)).args.includes(`"${path.join(f.root,`app.${ext}`)}"`));
        f.put(`old.${ext}`);
        await assert.rejects(f.parse(recipe), /FIRMWARE_AMBIGUOUS/);
    });
}

test('discovery ignores symlink directories and files instead of following backups or loops', async t => {
    const f = fixture(t, ['sketch.bin']);
    fs.symlinkSync(f.root,path.join(f.root,'loop'),'dir');
    fs.symlinkSync(path.join(f.root,'sketch.bin'),path.join(f.root,'other.bin'));
    assert((await f.parse()).args.includes(`"${path.join(f.root,'sketch.bin')}"`));
});

test('SDK explicit recipe remains unchanged with extra arbitrary binaries present', async t => {
    const f = fixture(t, ['sketch.bin','000-ai-output.bin',...auxiliary]);
    const recipe = `esptool --port "\${serial}" 0x10000 "${path.join(f.root,'sketch.bin')}"`;
    const command = await f.parse(recipe);
    assert.deepEqual(command.args,['--port','"TEST_PORT"','0x10000',`"${path.join(f.root,'sketch.bin')}"`]);
});

test('selection understands Windows filenames and rejects multiple distinct paths', () => {
    assert.equal(selectFirmwareFile(['C:\\build\\sketch.merged.bin','C:\\build\\sketch.bin']), 'C:\\build\\sketch.bin');
    assert.throws(()=>selectFirmwareFile(['C:\\build\\sketch.bin','C:\\build\\backup\\sketch.bin']), /FIRMWARE_AMBIGUOUS/);
});
