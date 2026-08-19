import { Mp3Encoder } from '@breezystack/lamejs';

interface AudioEncodeRequest {
  type: 'encode';
  requestId: number;
  sourceSampleRate: number;
  channelData: Float32Array[];
  startTime: number;
  endTime: number;
  sampleRate: number;
  channels: 1 | 2;
  bitRate: number;
}

interface AudioEncodeResult {
  mp3: Uint8Array;
  duration: number;
  sampleCount: number;
}

const MP3_BLOCK_SIZE = 1152;
const RESAMPLER_TAPS = 24;
const RESAMPLER_PHASES = 512;
const MAX_SOURCE_DURATION_SECONDS = 30 * 60;
const MIN_SELECTION_SECONDS = 0.01;

class AudioWorkerError extends Error {
  constructor(readonly messageKey: string, message = messageKey) {
    super(message);
  }
}

function postProgress(requestId: number, progress: number) {
  self.postMessage({
    type: 'progress',
    requestId,
    progress: Math.min(1, Math.max(0, progress)),
  });
}

function postError(requestId: number, error: unknown) {
  const localized = error instanceof AudioWorkerError ? error : null;
  self.postMessage({
    type: 'error',
    requestId,
    messageKey: localized?.messageKey,
    message: localized ? undefined : (error as Error)?.message || String(error),
  });
}

function validateRequest(request: AudioEncodeRequest) {
  if (!Number.isFinite(request.sourceSampleRate) || request.sourceSampleRate < 1) {
    throw new AudioWorkerError('WORKER_ERROR_INVALID_PCM');
  }
  if (!Array.isArray(request.channelData) || request.channelData.length === 0) {
    throw new AudioWorkerError('WORKER_ERROR_INVALID_PCM');
  }
  const sampleCount = request.channelData[0]?.length || 0;
  if (sampleCount === 0 || request.channelData.some((channel) => (
    !(channel instanceof Float32Array) || channel.length !== sampleCount
  ))) {
    throw new AudioWorkerError('WORKER_ERROR_INVALID_PCM');
  }
  if (sampleCount / request.sourceSampleRate > MAX_SOURCE_DURATION_SECONDS) {
    throw new AudioWorkerError('WORKER_ERROR_DURATION_EXCEEDED');
  }
  if (request.channels !== 1 && request.channels !== 2) {
    throw new AudioWorkerError('WORKER_ERROR_INVALID_SETTINGS');
  }
  const validSampleRates: readonly number[] = [8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000];
  const lowRates: readonly number[] = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const highRates: readonly number[] = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const validBitRates = request.sampleRate <= 24_000 ? lowRates : highRates;
  if (!validSampleRates.includes(request.sampleRate) || !validBitRates.includes(request.bitRate)) {
    throw new AudioWorkerError('WORKER_ERROR_INVALID_SETTINGS');
  }
}

function sinc(value: number) {
  if (Math.abs(value) < 1e-8) return 1;
  const radians = Math.PI * value;
  return Math.sin(radians) / radians;
}

/**
 * Precompute a compact, windowed-sinc polyphase filter. This avoids the
 * aliasing that linear interpolation introduces when speech is reduced from
 * 44.1/48 kHz to the field's 16 kHz default.
 */
function createResamplerKernel(sourceRate: number, targetRate: number) {
  const cutoff = targetRate < sourceRate ? targetRate / sourceRate * 0.94 : 1;
  const half = RESAMPLER_TAPS / 2;
  const phases = Array.from({ length: RESAMPLER_PHASES }, () => new Float64Array(RESAMPLER_TAPS));
  for (let phase = 0; phase < RESAMPLER_PHASES; phase++) {
    const fraction = phase / RESAMPLER_PHASES;
    let sum = 0;
    for (let tap = 0; tap < RESAMPLER_TAPS; tap++) {
      const distance = tap - half + 1 - fraction;
      const lanczos = Math.abs(distance) < half ? sinc(distance / half) : 0;
      const weight = cutoff * sinc(distance * cutoff) * lanczos;
      phases[phase][tap] = weight;
      sum += weight;
    }
    if (Math.abs(sum) > 1e-12) {
      for (let tap = 0; tap < RESAMPLER_TAPS; tap++) phases[phase][tap] /= sum;
    }
  }
  return phases;
}

function floatToInt16(value: number) {
  const clamped = Math.min(1, Math.max(-1, value));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

function sampleChannel(
  channel: Float32Array,
  position: number,
  kernels: Float64Array[],
) {
  const base = Math.floor(position);
  const phase = Math.min(
    RESAMPLER_PHASES - 1,
    Math.max(0, Math.round((position - base) * RESAMPLER_PHASES)),
  );
  const weights = kernels[phase];
  const first = base - RESAMPLER_TAPS / 2 + 1;
  let value = 0;
  for (let tap = 0; tap < RESAMPLER_TAPS; tap++) {
    const index = Math.min(channel.length - 1, Math.max(0, first + tap));
    value += channel[index] * weights[tap];
  }
  return value;
}

function sampleOutputChannel(
  source: Float32Array[],
  outputChannel: 0 | 1,
  outputChannels: 1 | 2,
  position: number,
  kernels: Float64Array[],
) {
  if (outputChannels === 1) {
    let value = 0;
    for (const channel of source) value += sampleChannel(channel, position, kernels);
    return value / source.length;
  }
  if (source.length === 1) return sampleChannel(source[0], position, kernels);
  return sampleChannel(source[outputChannel], position, kernels);
}

function joinChunks(chunks: Uint8Array[]) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function encode(request: AudioEncodeRequest): AudioEncodeResult {
  validateRequest(request);
  const sourceDuration = request.channelData[0].length / request.sourceSampleRate;
  const startTime = Math.min(sourceDuration, Math.max(0, request.startTime));
  const endTime = Math.min(sourceDuration, Math.max(startTime + MIN_SELECTION_SECONDS, request.endTime));
  if (endTime <= startTime) throw new AudioWorkerError('WORKER_ERROR_EMPTY_SELECTION');

  const outputSamples = Math.max(1, Math.round((endTime - startTime) * request.sampleRate));
  const sourceStart = startTime * request.sourceSampleRate;
  const sourceStep = request.sourceSampleRate / request.sampleRate;
  const kernels = createResamplerKernel(request.sourceSampleRate, request.sampleRate);
  const encoder = new Mp3Encoder(request.channels, request.sampleRate, request.bitRate);
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < outputSamples; offset += MP3_BLOCK_SIZE) {
    const length = Math.min(MP3_BLOCK_SIZE, outputSamples - offset);
    const left = new Int16Array(length);
    const right = request.channels === 2 ? new Int16Array(length) : undefined;
    for (let index = 0; index < length; index++) {
      const sourcePosition = sourceStart + (offset + index) * sourceStep;
      left[index] = floatToInt16(sampleOutputChannel(
        request.channelData,
        0,
        request.channels,
        sourcePosition,
        kernels,
      ));
      if (right) {
        right[index] = floatToInt16(sampleOutputChannel(
          request.channelData,
          1,
          request.channels,
          sourcePosition,
          kernels,
        ));
      }
    }
    const encoded = encoder.encodeBuffer(left, right);
    if (encoded.byteLength > 0) chunks.push(encoded.slice());
    if (offset === 0 || offset + length === outputSamples || offset % (MP3_BLOCK_SIZE * 16) === 0) {
      postProgress(request.requestId, (offset + length) / outputSamples);
    }
  }

  const finalChunk = encoder.flush();
  if (finalChunk.byteLength > 0) chunks.push(finalChunk.slice());
  const mp3 = joinChunks(chunks);
  if (mp3.byteLength === 0) throw new AudioWorkerError('WORKER_ERROR_ENCODE_FAILED');
  return {
    mp3,
    duration: outputSamples / request.sampleRate,
    sampleCount: outputSamples,
  };
}

self.onmessage = (event: MessageEvent<AudioEncodeRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'encode') return;
  try {
    const result = encode(request);
    self.postMessage({
      type: 'done',
      requestId: request.requestId,
      result,
    }, [result.mp3.buffer]);
  } catch (error) {
    postError(request.requestId, error);
  }
};
