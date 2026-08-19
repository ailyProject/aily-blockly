# `field_audio`

`field_audio` is a Blockly media field that imports browser-decodable audio, displays its waveform, trims a selection with two draggable handles, and encodes the selection to MP3 in a Web Worker.

The defaults match this FFmpeg intent:

```text
-map_metadata -1 -ar 16000 -ac 1 -c:a libmp3lame -b:a 16k -write_xing 0 -id3v2_version 0
```

The JavaScript LAME encoder emits raw constant-bit-rate MP3 frames without ID3 metadata or a Xing seek header. Output is semantically equivalent, but is not expected to be byte-for-byte identical to an FFmpeg build because resampling and encoder implementations differ.

## Block JSON

```json
{
  "type": "field_audio",
  "name": "AUDIO",
  "sampleRate": 16000,
  "channels": 1,
  "bitRate": 16,
  "fieldWidth": 100,
  "fieldHeight": 21
}
```

The popup lets the user change sample rate, mono/stereo output, bit rate, trim start, and trim end. Valid MP3 bit rates are adjusted automatically for the selected MPEG sample-rate family. Playback reads `audioPath`, so it previews the actual trimmed and compressed MP3 output. Playback is disabled while settings or trim points are waiting to be re-encoded.

Imported source files and encoded MP3 files are immutable and content-addressed. Identical output can therefore be shared safely by copied Blocks without duplicating files:

```text
<project>/assets/audio/<source-md5>.<source-extension>
<project>/audio/<mp3-content-md5>.mp3
```

The field registers generated outputs with the [shared project resource collector](project-resource-gc.md) in `.aily/project-resource-manifest.json`. After a persisted project is opened and all pages have been loaded, the collector scans the complete Project Document and deletes only registered files whose project-relative paths have no remaining references. Cleanup is intentionally performed on the next project open instead of directly on Block deletion, preserving shared files and Blockly undo safety. Existing `audio/.field-audio-manifest.json` files are migrated automatically.

## Serialized value

The field JSON contains only the two project-relative paths and audio settings. Waveform samples and audio bytes are runtime-only and are never serialized.

```ts
interface AudioFieldValue {
  schemaVersion: 1;
  encoding: 'mp3-cbr-v1';
  sampleRate: number;
  channels: 1 | 2;
  bitRate: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  outputDuration: number;
  sourcePath?: string; // assets/audio/...
  audioPath?: string;  // audio/...mp3
}
```

The Block preview waveform is generated on demand by reading and decoding `audioPath`. The popup's full-range editing waveform is generated on demand from `sourcePath`, allowing the trim range to be expanded again without generation loss.
