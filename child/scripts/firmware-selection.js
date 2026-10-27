'use strict';

// Shared by the upload child process and BLE/WiFi OTA. This module deliberately
// has no Node dependencies so the renderer bundles the same selection policy.
function selectFirmwareFile(files, pattern = '*.bin', generatedFiles = []) {
    const basename = filename => filename.split(/[\\/]/).pop();
    const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    const matches = new RegExp(`^${escaped}$`, 'i');
    const auxiliaryBin = /(?:^|[._-])(?:bootloader|boot_app0|partitions?|ota_data(?:_initial)?|spiffs|littlefs|filesystem|fatfs|merged|with_bootloader)(?:[._-]|$)/i;
    let candidates = [...new Set(files)].filter(filename => {
        const name = basename(filename);
        if (!matches.test(name)) return false;
        // Explicit auxiliary patterns remain valid (e.g. *.bootloader.bin).
        // A bare wildcard means the application image, never a merged image.
        if (pattern.toLowerCase() === '*.bin' && auxiliaryBin.test(name)) return false;
        if (pattern.toLowerCase() === '*.hex' && /[._-]with_bootloader\.hex$/i.test(name)) return false;
        return true;
    }).sort();

    // A completed build identifies its outputs; names/timestamps cannot.
    const generated = candidates.filter(filename => generatedFiles.includes(filename));
    if (generated.length) candidates = generated;

    if (candidates.length > 1) {
        throw new Error(`FIRMWARE_AMBIGUOUS: ${pattern} 匹配到多个固件，已停止上传。请清理旧构建产物或在板包中指定准确文件名：${candidates.join(', ')}`);
    }
    return candidates[0] || '';
}

module.exports = { selectFirmwareFile };
