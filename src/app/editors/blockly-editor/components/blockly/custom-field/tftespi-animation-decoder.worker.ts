import { createFile, DataStream } from 'mp4box';

type AnimationFormat = 'rgb565' | 'rgb332';
type AnimationEncoding = 'rgb565-be' | 'rgb332';

interface DecodeRequest {
    type: 'decode';
    requestId: number;
    fileName: string;
    mimeType: string;
    buffer: ArrayBuffer;
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    format?: AnimationFormat;
}

interface DecodeOptions {
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    format: AnimationFormat;
    encoding: AnimationEncoding;
}

interface DecodeResult extends DecodeOptions {
    schemaVersion: 1;
    frames: Uint8Array[];
    sourceName: string;
    sourceType: string;
}

type WorkerMessageParams = Record<string, string | number>;

const MICROSECONDS_PER_SECOND = 1_000_000;
const DEFAULT_MAX_FRAMES = 10;
const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 120;
const DEFAULT_FPS = 10;
const DEFAULT_FORMAT: AnimationFormat = 'rgb565';
const MAX_DIMENSION = 16_384;
const MAX_FPS = 30;
const MAX_FRAMES = 300;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

class LocalizedWorkerError extends Error {
    constructor(
        readonly messageKey: string,
        readonly messageParams: WorkerMessageParams = {},
        fallbackMessage = messageKey,
    ) {
        super(fallbackMessage);
    }
}

function createWorkerError(messageKey: string, messageParams: WorkerMessageParams = {}, fallbackMessage?: string) {
    return new LocalizedWorkerError(messageKey, messageParams, fallbackMessage);
}

function postProgress(requestId: number, messageKey: string, messageParams: WorkerMessageParams = {}, progress?: number) {
    self.postMessage({
        type: 'progress',
        requestId,
        messageKey,
        messageParams,
        progress,
    });
}

function postError(requestId: number, error: unknown) {
    const localizedError = error instanceof LocalizedWorkerError ? error : null;
    self.postMessage({
        type: 'error',
        requestId,
        message: localizedError ? undefined : (error as any)?.message,
        messageKey: localizedError?.messageKey,
        messageParams: localizedError?.messageParams,
    });
}

function normalizeInteger(value: number, fallback: number, min: number, max: number) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeDurationUs(value: unknown, fallback: number) {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

function normalizeAnimationFormat(value: unknown): AnimationFormat {
    return value === 'rgb332' ? 'rgb332' : DEFAULT_FORMAT;
}

function getAnimationEncoding(format: AnimationFormat): AnimationEncoding {
    return format === 'rgb332' ? 'rgb332' : 'rgb565-be';
}

function getFrameByteLength(width: number, height: number, format: AnimationFormat) {
    const pixelCount = width * height;
    const frameByteLength = pixelCount * (format === 'rgb332' ? 1 : 2);
    if (!Number.isSafeInteger(pixelCount) || !Number.isSafeInteger(frameByteLength)) {
        throw createWorkerError(
            'WORKER_ERROR_FRAME_TOO_LARGE',
            { width, height, mode: format.toUpperCase(), size: frameByteLength, maxSize: MAX_OUTPUT_BYTES },
            `The requested ${format.toUpperCase()} frame is too large.`,
        );
    }
    return frameByteLength;
}

function getMaxFramesForOutputBudget(
    width: number,
    height: number,
    format: AnimationFormat,
) {
    const frameByteLength = getFrameByteLength(width, height, format);
    if (frameByteLength > MAX_OUTPUT_BYTES) {
        throw createWorkerError(
            'WORKER_ERROR_FRAME_TOO_LARGE',
            { width, height, mode: format.toUpperCase(), size: frameByteLength, maxSize: MAX_OUTPUT_BYTES },
            `A single ${format.toUpperCase()} frame exceeds the 8 MiB output limit.`,
        );
    }

    return Math.max(1, Math.floor(MAX_OUTPUT_BYTES / frameByteLength));
}

function normalizeDecodeOptions(request: DecodeRequest): DecodeOptions {
    const width = normalizeInteger(request.width, DEFAULT_WIDTH, 1, MAX_DIMENSION);
    const height = normalizeInteger(request.height, DEFAULT_HEIGHT, 1, MAX_DIMENSION);
    const fps = normalizeInteger(request.fps, DEFAULT_FPS, 1, MAX_FPS);
    const format = normalizeAnimationFormat(request.format);
    const requestedMaxFrames = normalizeInteger(
        request.maxFrames,
        DEFAULT_MAX_FRAMES,
        1,
        MAX_FRAMES,
    );
    const outputBudgetFrames = getMaxFramesForOutputBudget(width, height, format);

    return {
        width,
        height,
        fps,
        maxFrames: Math.min(requestedMaxFrames, outputBudgetFrames),
        format,
        encoding: getAnimationEncoding(format),
    };
}

class PackedRgbFrameRenderer {
    private readonly canvas: OffscreenCanvas;
    private readonly context: OffscreenCanvasRenderingContext2D;

    constructor(
        private readonly width: number,
        private readonly height: number,
        private readonly format: AnimationFormat,
    ) {
        this.canvas = new OffscreenCanvas(width, height);
        const context = this.canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            throw createWorkerError('WORKER_ERROR_CREATE_CANVAS');
        }
        this.context = context;
    }

    render(frame: VideoFrame): Uint8Array {
        this.context.globalCompositeOperation = 'source-over';
        this.context.fillStyle = '#000000';
        this.context.fillRect(0, 0, this.width, this.height);
        this.context.drawImage(frame, 0, 0, this.width, this.height);

        const rgba = this.context.getImageData(0, 0, this.width, this.height).data;
        const packed = new Uint8Array(getFrameByteLength(this.width, this.height, this.format));

        for (let sourceIndex = 0, pixelIndex = 0; sourceIndex < rgba.length; sourceIndex += 4, pixelIndex++) {
            const alpha = rgba[sourceIndex + 3];
            const red = alpha === 255 ? rgba[sourceIndex] : Math.round(rgba[sourceIndex] * alpha / 255);
            const green = alpha === 255 ? rgba[sourceIndex + 1] : Math.round(rgba[sourceIndex + 1] * alpha / 255);
            const blue = alpha === 255 ? rgba[sourceIndex + 2] : Math.round(rgba[sourceIndex + 2] * alpha / 255);
            if (this.format === 'rgb332') {
                packed[pixelIndex] = (red & 0xe0) | ((green & 0xe0) >> 3) | (blue >> 6);
            } else {
                const pixel = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
                const targetIndex = pixelIndex * 2;
                packed[targetIndex] = pixel >> 8;
                packed[targetIndex + 1] = pixel & 0xff;
            }
        }

        return packed;
    }
}

function getBoxDescription(box: any): Uint8Array | undefined {
    if (!box || typeof box.write !== 'function') {
        return undefined;
    }

    const stream = new DataStream(undefined, 0, 1 as any) as any;
    box.write(stream);

    const byteLength = Number(stream.byteLength || stream.getPosition?.() || 0);
    if (byteLength <= 8) {
        return undefined;
    }

    return new Uint8Array(stream.buffer.slice(8, byteLength));
}

function getDecoderDescription(sample: any): Uint8Array | undefined {
    const description = sample?.description;
    return getBoxDescription(description?.avcC)
        || getBoxDescription(description?.hvcC)
        || getBoxDescription(description?.av1C)
        || getBoxDescription(description?.vpcC);
}

async function getMp4VideoSamples(buffer: ArrayBuffer): Promise<{ track: any; samples: any[] }> {
    return new Promise((resolve, reject) => {
        const mp4boxFile = createFile() as any;
        let videoTrack: any = null;
        let settled = false;
        let finishTimer: ReturnType<typeof setTimeout> | undefined;
        const samples: any[] = [];

        const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            if (finishTimer !== undefined) clearTimeout(finishTimer);
            reject(error);
        };

        const scheduleFinish = () => {
            if (settled) return;
            if (finishTimer !== undefined) clearTimeout(finishTimer);
            finishTimer = setTimeout(() => {
                if (settled) return;
                if (!videoTrack) {
                    fail(createWorkerError('WORKER_ERROR_MP4_METADATA_FAILED'));
                    return;
                }
                if (samples.length === 0) {
                    fail(createWorkerError('WORKER_ERROR_MP4_FRAME_EXTRACTION_FAILED'));
                    return;
                }
                settled = true;
                resolve({ track: videoTrack, samples });
            }, 0);
        };

        mp4boxFile.onError = (module: string, message: string) => {
            const detail = message || module;
            fail(createWorkerError(
                'WORKER_ERROR_MP4_PARSE_FAILED',
                detail ? { detail } : {},
                detail || 'MP4 parsing failed.',
            ));
        };

        mp4boxFile.onReady = (info: any) => {
            videoTrack = info.tracks?.find((track: any) => track.video);
            if (!videoTrack) {
                fail(createWorkerError('WORKER_ERROR_MP4_NO_VIDEO_TRACK'));
                return;
            }

            mp4boxFile.setExtractionOptions(videoTrack.id, null, {
                nbSamples: Math.max(1, Number(videoTrack.nb_samples || 1)),
            });
            mp4boxFile.start();
            scheduleFinish();
        };

        mp4boxFile.onSamples = (_id: number, _user: unknown, extractedSamples: any[]) => {
            samples.push(...extractedSamples);
            scheduleFinish();
        };

        try {
            const mp4Buffer = buffer.slice(0) as ArrayBuffer & { fileStart?: number };
            mp4Buffer.fileStart = 0;
            mp4boxFile.appendBuffer(mp4Buffer);
            mp4boxFile.flush();
            scheduleFinish();
        } catch (error) {
            fail(error);
        }
    });
}

function createDecodeResult(
    options: DecodeOptions,
    frames: Uint8Array[],
    sourceName: string,
    sourceType: string,
): DecodeResult {
    return {
        schemaVersion: 1,
        ...options,
        frames,
        sourceName,
        sourceType,
    };
}

async function decodeMp4(request: DecodeRequest): Promise<DecodeResult> {
    const VideoDecoderCtor = (self as any).VideoDecoder;
    const EncodedVideoChunkCtor = (self as any).EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
        throw createWorkerError('WORKER_ERROR_WEB_CODECS_UNSUPPORTED');
    }

    const sourceType = request.mimeType || 'video/mp4';
    const options = normalizeDecodeOptions(request);
    postProgress(request.requestId, 'WORKER_STATUS_PARSE_MP4', {}, 0.08);
    const { track, samples } = await getMp4VideoSamples(request.buffer);
    const firstSample = samples[0];
    const decoderDescription = getDecoderDescription(firstSample);
    const config: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.video?.width || track.track_width || options.width,
        codedHeight: track.video?.height || track.track_height || options.height,
    };

    if (decoderDescription) {
        config.description = decoderDescription;
    }

    if (typeof VideoDecoderCtor.isConfigSupported === 'function') {
        const support = await VideoDecoderCtor.isConfigSupported(config);
        if (!support.supported) {
            throw createWorkerError('WORKER_ERROR_CODEC_UNSUPPORTED', { codec: track.codec });
        }
    }

    const renderer = new PackedRgbFrameRenderer(options.width, options.height, options.format);
    const frames: Uint8Array[] = [];
    const intervalUs = MICROSECONDS_PER_SECOND / options.fps;
    const sampleDurations = new Map<number, number>();
    let outputTimelineOrigin: number | null = null;
    let lastEncodedFrame: Uint8Array | null = null;
    let outputError: unknown;
    let decoderError: unknown;

    const decoder = new VideoDecoderCtor({
        output: (frame: VideoFrame) => {
            try {
                if (outputError || frames.length >= options.maxFrames) return;

                const initialFrameCount = frames.length;
                const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : 0;
                const duration = normalizeDurationUs(
                    frame.duration,
                    normalizeDurationUs(sampleDurations.get(timestamp), intervalUs),
                );
                const frameEnd = timestamp + duration;
                if (outputTimelineOrigin === null) outputTimelineOrigin = timestamp;
                const nextCaptureTime = () => (
                    outputTimelineOrigin! + frames.length * MICROSECONDS_PER_SECOND / options.fps
                );

                // Hold the most recently sampled frame across timestamp gaps so the
                // fixed output timeline keeps the same duration as the source.
                while (
                    lastEncodedFrame
                    && nextCaptureTime() < timestamp
                    && frames.length < options.maxFrames
                ) {
                    frames.push(lastEncodedFrame);
                }

                if (nextCaptureTime() < frameEnd && frames.length < options.maxFrames) {
                    const encodedFrame = renderer.render(frame);
                    lastEncodedFrame = encodedFrame;
                    while (nextCaptureTime() < frameEnd && frames.length < options.maxFrames) {
                        frames.push(encodedFrame);
                    }
                }

                if (frames.length > initialFrameCount) {
                    postProgress(
                        request.requestId,
                        'WORKER_STATUS_DECODE_MP4_FRAME',
                        { current: frames.length, total: options.maxFrames },
                        Math.min(0.95, 0.08 + 0.87 * frames.length / options.maxFrames),
                    );
                }
            } catch (error) {
                outputError = error;
            } finally {
                frame.close();
            }
        },
        error: (error: Error) => {
            decoderError = error;
        },
    });

    try {
        decoder.configure(config);
        const timescale = Number(track.timescale) > 0 ? Number(track.timescale) : MICROSECONDS_PER_SECOND;
        let decodeStartDts: number | null = null;
        const decodeWindowUs = intervalUs * options.maxFrames;
        const decodeWindowPaddingUs = Math.max(intervalUs, MICROSECONDS_PER_SECOND);

        for (const sample of samples) {
            const sampleTimescale = Number(sample.timescale) > 0 ? Number(sample.timescale) : timescale;
            const timestamp = Math.round((sample.cts ?? sample.dts ?? 0) * MICROSECONDS_PER_SECOND / sampleTimescale);
            const decodeTimestamp = Math.round((sample.dts ?? sample.cts ?? 0) * MICROSECONDS_PER_SECOND / sampleTimescale);
            const duration = Math.max(1, Math.round((sample.duration || 1) * MICROSECONDS_PER_SECOND / sampleTimescale));
            if (decodeStartDts === null) decodeStartDts = decodeTimestamp;
            if (decodeTimestamp - decodeStartDts > decodeWindowUs + decodeWindowPaddingUs) break;

            sampleDurations.set(timestamp, duration);
            decoder.decode(new EncodedVideoChunkCtor({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp,
                duration,
                data: sample.data,
            }));
        }

        await decoder.flush();
        if (outputError) throw outputError;
        if (decoderError) throw decoderError;
    } finally {
        if (decoder.state !== 'closed') {
            decoder.close();
        }
    }

    if (frames.length === 0) {
        throw createWorkerError('WORKER_ERROR_MP4_NO_VALID_FRAMES');
    }

    return createDecodeResult(options, frames, request.fileName || '', sourceType);
}

async function decodeImage(
    request: DecodeRequest,
    sourceType: string,
    formatLabel: string,
): Promise<DecodeResult> {
    const ImageDecoderCtor = (self as any).ImageDecoder;
    if (!ImageDecoderCtor) {
        throw createWorkerError('WORKER_ERROR_IMAGE_DECODER_UNSUPPORTED');
    }

    const options = normalizeDecodeOptions(request);
    const renderer = new PackedRgbFrameRenderer(options.width, options.height, options.format);
    const decoder = new ImageDecoderCtor({
        data: new Uint8Array(request.buffer),
        type: sourceType,
    });
    const frames: Uint8Array[] = [];

    try {
        postProgress(request.requestId, 'WORKER_STATUS_PARSE_IMAGE', { format: formatLabel }, 0.08);
        await decoder.tracks.ready;

        const trackFrameCount = Number(decoder.tracks.selectedTrack?.frameCount || 0);
        const sourceFrameCount = Number.isFinite(trackFrameCount) && trackFrameCount > 0
            ? trackFrameCount
            : Number.POSITIVE_INFINITY;
        const intervalUs = MICROSECONDS_PER_SECOND / options.fps;
        let currentTimestamp = 0;

        for (let frameIndex = 0; frameIndex < sourceFrameCount && frames.length < options.maxFrames; frameIndex++) {
            let decoded: any;
            try {
                decoded = await decoder.decode({ frameIndex });
            } catch (error) {
                if (frames.length > 0) break;
                throw error;
            }

            const image = decoded.image as VideoFrame;
            try {
                const duration = normalizeDurationUs(image.duration, intervalUs);
                const frameEnd = currentTimestamp + duration;
                const nextCaptureTime = () => (
                    frames.length * MICROSECONDS_PER_SECOND / options.fps
                );
                if (nextCaptureTime() < frameEnd && frames.length < options.maxFrames) {
                    const encodedFrame = renderer.render(image);
                    while (nextCaptureTime() < frameEnd && frames.length < options.maxFrames) {
                        frames.push(encodedFrame);
                    }
                    postProgress(
                        request.requestId,
                        'WORKER_STATUS_DECODE_IMAGE_FRAME',
                        { format: formatLabel, current: frames.length, total: options.maxFrames },
                        Math.min(0.95, 0.08 + 0.87 * frames.length / options.maxFrames),
                    );
                }

                currentTimestamp = frameEnd;
            } finally {
                image.close();
            }
        }
    } finally {
        decoder.close();
    }

    if (frames.length === 0) {
        throw createWorkerError('WORKER_ERROR_IMAGE_NO_VALID_FRAMES', { format: formatLabel });
    }

    return createDecodeResult(options, frames, request.fileName || '', sourceType);
}

function resolveImageSource(fileName: string, mimeType: string) {
    if (mimeType.includes('gif') || fileName.endsWith('.gif')) {
        return { sourceType: 'image/gif', formatLabel: 'GIF' };
    }
    if (mimeType.includes('png') || fileName.endsWith('.png')) {
        return { sourceType: 'image/png', formatLabel: 'PNG' };
    }
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')
        || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
        return { sourceType: 'image/jpeg', formatLabel: 'JPEG' };
    }
    if (mimeType.includes('webp') || fileName.endsWith('.webp')) {
        return { sourceType: 'image/webp', formatLabel: 'WebP' };
    }
    return null;
}

self.addEventListener('message', async (event: MessageEvent<DecodeRequest>) => {
    const request = event.data;
    if (!request || request.type !== 'decode') return;

    try {
        const fileName = (request.fileName || '').toLowerCase();
        const mimeType = (request.mimeType || '').toLowerCase();
        const isMp4 = mimeType.includes('mp4') || fileName.endsWith('.mp4');
        const imageSource = resolveImageSource(fileName, mimeType);

        if (!imageSource && !isMp4) {
            throw createWorkerError('WORKER_ERROR_UNSUPPORTED_FILE_TYPE');
        }

        const result = isMp4
            ? await decodeMp4(request)
            : await decodeImage(request, imageSource!.sourceType, imageSource!.formatLabel);
        self.postMessage({
            type: 'done',
            requestId: request.requestId,
            result,
        });
    } catch (error) {
        postError(request.requestId, error);
    }
});
