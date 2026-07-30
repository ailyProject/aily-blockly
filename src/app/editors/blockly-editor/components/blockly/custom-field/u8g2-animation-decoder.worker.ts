import { createFile, DataStream } from 'mp4box';

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
    dither: boolean;
    threshold: number;
}

interface DecodeResult {
    schemaVersion: 1;
    encoding: 'xbm-lsb-row-v1';
    width: number;
    height: number;
    fps: number;
    maxFrames: number;
    dither: boolean;
    threshold: number;
    frames: Uint8Array[];
    sourceName: string;
    sourceType: string;
}

type WorkerMessageParams = Record<string, string | number>;

const DEFAULT_THRESHOLD = 127;
const MICROSECONDS_PER_SECOND = 1000000;
const DEFAULT_ANIMATION_SECONDS = 60;
const MAX_FPS = 30;
const MAX_FRAMES = 1800;

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

function normalizeDimension(value: number, fallback: number, min: number, max: number) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}

function getMaxFramesLimit() {
    return MAX_FRAMES;
}

function getDefaultMaxFrames(fps: number) {
    return Math.min(getMaxFramesLimit(), Math.max(1, Math.floor(fps) * DEFAULT_ANIMATION_SECONDS));
}

function normalizeDecodeOptions(request: DecodeRequest) {
    const fps = normalizeDimension(request.fps, 10, 1, MAX_FPS);
    const maxFramesLimit = getMaxFramesLimit();

    return {
        width: normalizeDimension(request.width, 128, 1, 256),
        height: normalizeDimension(request.height, 64, 1, 128),
        fps,
        maxFrames: normalizeDimension(request.maxFrames, getDefaultMaxFrames(fps), 1, maxFramesLimit),
        dither: !!request.dither,
        threshold: normalizeDimension(request.threshold, DEFAULT_THRESHOLD, 0, 255),
    };
}

function imageDataToXbm(imageData: ImageData, width: number, height: number, dither: boolean, threshold: number): Uint8Array {
    const bitmap = dither
        ? imageDataToDitheredBitmap(imageData, width, height)
        : imageDataToThresholdBitmap(imageData, width, height, threshold);
    return bitmapToXbm(bitmap, width, height);
}

function bitmapToXbm(bitmap: number[][], width: number, height: number): Uint8Array {
    const bytesPerRow = Math.ceil(width / 8);
    const bytes = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (bitmap[y]?.[x] === 1) {
                bytes[y * bytesPerRow + Math.floor(x / 8)] |= 1 << (x % 8);
            }
        }
    }
    return bytes;
}

function getWeightedGray(red: number, green: number, blue: number): number {
    return (red * 4 + green * 10 + blue * 2) >> 4;
}

function imageDataToThresholdBitmap(imageData: ImageData, width: number, height: number, threshold: number): number[][] {
    const bitmap: number[][] = [];

    for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 4;
            const alpha = imageData.data[index + 3];
            if (alpha < 128) {
                row.push(0);
                continue;
            }

            const red = imageData.data[index];
            const green = imageData.data[index + 1];
            const blue = imageData.data[index + 2];
            const gray = getWeightedGray(red, green, blue);
            row.push(gray < threshold ? 0 : 1);
        }
        bitmap.push(row);
    }

    return bitmap;
}

function imageDataToDitheredBitmap(imageData: ImageData, width: number, height: number): number[][] {
    const luminance = new Float32Array(width * height);
    const opaque = new Uint8Array(width * height);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixelIndex = y * width + x;
            const dataIndex = pixelIndex * 4;
            const alpha = imageData.data[dataIndex + 3];
            opaque[pixelIndex] = alpha >= 128 ? 1 : 0;

            if (!opaque[pixelIndex]) {
                luminance[pixelIndex] = 255;
                continue;
            }

            const red = imageData.data[dataIndex];
            const green = imageData.data[dataIndex + 1];
            const blue = imageData.data[dataIndex + 2];
            luminance[pixelIndex] = getWeightedGray(red, green, blue);
        }
    }

    const addError = (x: number, y: number, error: number, factor: number) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const index = y * width + x;
        if (!opaque[index]) return;
        luminance[index] += error * factor;
    };

    const bitmap: number[][] = [];
    for (let y = 0; y < height; y++) {
        const row: number[] = [];
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (!opaque[index]) {
                row.push(0);
                continue;
            }

            const oldPixel = luminance[index];
            const newPixel = oldPixel < DEFAULT_THRESHOLD ? 0 : 255;
            const quantError = oldPixel - newPixel;
            luminance[index] = newPixel;
            row.push(newPixel === 0 ? 0 : 1);

            addError(x + 1, y, quantError, 7 / 16);
            addError(x - 1, y + 1, quantError, 3 / 16);
            addError(x, y + 1, quantError, 5 / 16);
            addError(x + 1, y + 1, quantError, 1 / 16);
        }
        bitmap.push(row);
    }

    return bitmap;
}

function frameToXbm(frame: VideoFrame, width: number, height: number, dither: boolean, threshold: number): Uint8Array {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
        throw createWorkerError('WORKER_ERROR_CREATE_CANVAS');
    }

    context.clearRect(0, 0, width, height);
    context.drawImage(frame, 0, 0, width, height);

    const imageData = context.getImageData(0, 0, width, height);
    return imageDataToXbm(imageData, width, height, dither, threshold);
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
        const samples: any[] = [];

        mp4boxFile.onError = (module: string, message: string) => {
            reject(message || module
                ? new Error(message || module)
                : createWorkerError('WORKER_ERROR_MP4_PARSE_FAILED'));
        };

        mp4boxFile.onReady = (info: any) => {
            videoTrack = info.tracks?.find((track: any) => track.video);
            if (!videoTrack) {
                reject(createWorkerError('WORKER_ERROR_MP4_NO_VIDEO_TRACK'));
                return;
            }

            mp4boxFile.setExtractionOptions(videoTrack.id, null, {
                nbSamples: Math.max(1, Number(videoTrack.nb_samples || 1)),
            });
            mp4boxFile.start();
        };

        mp4boxFile.onSamples = (_id: number, _user: unknown, extractedSamples: any[]) => {
            samples.push(...extractedSamples);
        };

        const mp4Buffer = buffer.slice(0) as ArrayBuffer & { fileStart?: number };
        mp4Buffer.fileStart = 0;
        mp4boxFile.appendBuffer(mp4Buffer);
        mp4boxFile.flush();

        setTimeout(() => {
            if (!videoTrack) {
                reject(createWorkerError('WORKER_ERROR_MP4_METADATA_FAILED'));
                return;
            }
            if (samples.length === 0) {
                reject(createWorkerError('WORKER_ERROR_MP4_FRAME_EXTRACTION_FAILED'));
                return;
            }
            resolve({ track: videoTrack, samples });
        }, 0);
    });
}

async function decodeMp4(request: DecodeRequest): Promise<DecodeResult> {
    const VideoDecoderCtor = (self as any).VideoDecoder;
    const EncodedVideoChunkCtor = (self as any).EncodedVideoChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
        throw createWorkerError('WORKER_ERROR_WEB_CODECS_UNSUPPORTED');
    }

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

    const frames: Uint8Array[] = [];
    const intervalUs = MICROSECONDS_PER_SECOND / options.fps;
    let firstTimestamp: number | null = null;
    let nextCaptureAt = 0;

    const decoder = new VideoDecoderCtor({
        output: (frame: VideoFrame) => {
            try {
                const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : 0;
                if (firstTimestamp === null) {
                    firstTimestamp = timestamp;
                    nextCaptureAt = timestamp;
                }

                if (frames.length < options.maxFrames && timestamp + 1 >= nextCaptureAt) {
                    frames.push(frameToXbm(frame, options.width, options.height, options.dither, options.threshold));
                    nextCaptureAt += intervalUs;
                    postProgress(
                        request.requestId,
                        'WORKER_STATUS_DECODE_MP4_FRAME',
                        { current: frames.length, total: options.maxFrames },
                        Math.min(0.95, frames.length / options.maxFrames),
                    );
                }
            } finally {
                frame.close();
            }
        },
        error: (error: Error) => {
            throw error;
        },
    });

    decoder.configure(config);

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const timestamp = Math.round((sample.cts ?? sample.dts ?? 0) * MICROSECONDS_PER_SECOND / track.timescale);
        const duration = Math.max(1, Math.round((sample.duration || 1) * MICROSECONDS_PER_SECOND / track.timescale));

        decoder.decode(new EncodedVideoChunkCtor({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp,
            duration,
            data: sample.data,
        }));
    }

    await decoder.flush();
    decoder.close();

    if (frames.length === 0) {
        throw createWorkerError('WORKER_ERROR_MP4_NO_VALID_FRAMES');
    }

    return {
        schemaVersion: 1,
        encoding: 'xbm-lsb-row-v1',
        ...options,
        frames,
        sourceName: request.fileName,
        sourceType: request.mimeType || 'video/mp4',
    };
}

function getImageDecoderType(request: DecodeRequest): string {
    const mimeType = (request.mimeType || '').toLowerCase();
    const fileName = request.fileName.toLowerCase();

    if (mimeType.includes('png') || fileName.endsWith('.png')) {
        return 'image/png';
    }

    return 'image/gif';
}

function getImageFormatLabel(imageType: string): string {
    return imageType === 'image/png' ? 'PNG' : 'GIF';
}

async function decodeImageAnimation(request: DecodeRequest): Promise<DecodeResult> {
    const ImageDecoderCtor = (self as any).ImageDecoder;
    if (!ImageDecoderCtor) {
        throw createWorkerError('WORKER_ERROR_IMAGE_DECODER_UNSUPPORTED');
    }

    const options = normalizeDecodeOptions(request);
    const imageType = getImageDecoderType(request);
    const imageLabel = getImageFormatLabel(imageType);
    const imageData = new Uint8Array(request.buffer);
    const decoder = new ImageDecoderCtor({
        data: imageData,
        type: imageType,
    });

    postProgress(request.requestId, 'WORKER_STATUS_PARSE_IMAGE', { format: imageLabel }, 0.08);
    await decoder.tracks.ready;

    const selectedTrack = decoder.tracks.selectedTrack;
    const trackFrameCount = Number(selectedTrack?.frameCount || 0);
    const sourceFrameCount = Number.isFinite(trackFrameCount) && trackFrameCount > 0
        ? trackFrameCount
        : options.maxFrames;
    const intervalUs = MICROSECONDS_PER_SECOND / options.fps;
    const frames: Uint8Array[] = [];
    let nextCaptureAt = 0;
    let currentTimestamp = 0;

    for (let frameIndex = 0; frameIndex < sourceFrameCount && frames.length < options.maxFrames; frameIndex++) {
        let result: any;
        try {
            result = await decoder.decode({ frameIndex });
        } catch (error) {
            if (frames.length > 0) {
                break;
            }
            throw error;
        }

        const image = result.image as VideoFrame;

        if (frames.length === 0 || currentTimestamp + 1 >= nextCaptureAt) {
            frames.push(frameToXbm(image, options.width, options.height, options.dither, options.threshold));
            nextCaptureAt += intervalUs;
            postProgress(
                request.requestId,
                'WORKER_STATUS_DECODE_IMAGE_FRAME',
                { format: imageLabel, current: frames.length, total: options.maxFrames },
                Math.min(0.95, frames.length / options.maxFrames),
            );
        }

        currentTimestamp += Number(image.duration || intervalUs);
        image.close();
    }

    decoder.close();

    if (frames.length === 0) {
        throw createWorkerError('WORKER_ERROR_IMAGE_NO_VALID_FRAMES', { format: imageLabel });
    }

    return {
        schemaVersion: 1,
        encoding: 'xbm-lsb-row-v1',
        ...options,
        frames,
        sourceName: request.fileName,
        sourceType: request.mimeType || imageType,
    };
}

self.addEventListener('message', async (event: MessageEvent<DecodeRequest>) => {
    const request = event.data;
    if (!request || request.type !== 'decode') return;

    try {
        const fileName = request.fileName.toLowerCase();
        const mimeType = (request.mimeType || '').toLowerCase();
        const isGif = mimeType.includes('gif') || fileName.endsWith('.gif');
        const isPng = mimeType.includes('png') || fileName.endsWith('.png');
        const isMp4 = mimeType.includes('mp4') || fileName.endsWith('.mp4') || mimeType.includes('quicktime');

        if (!isGif && !isPng && !isMp4) {
            throw createWorkerError('WORKER_ERROR_UNSUPPORTED_FILE_TYPE');
        }

        const result = isMp4 ? await decodeMp4(request) : await decodeImageAnimation(request);
        self.postMessage({
            type: 'done',
            requestId: request.requestId,
            result,
        });
    } catch (error: any) {
        postError(request.requestId, error);
    }
});
