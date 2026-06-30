interface ConvertOptions {
  endian: boolean;
  invert: boolean;
  dither: boolean;
  threshold: number;
}

interface ConvertRequest {
  type: 'convert';
  requestId: number;
  imageData: ImageData;
  options: ConvertOptions;
}

interface ConvertDoneMessage {
  type: 'done';
  requestId: number;
  imageData: ImageData;
  bitmapArray: number[][];
}

interface ConvertErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
}

const DEFAULT_THRESHOLD = 127;

function normalizeThreshold(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(255, Math.max(1, Math.floor(value)));
}

function getWeightedGray(data: Uint8ClampedArray, index: number) {
  return (data[index] * 4 + data[index + 1] * 10 + data[index + 2] * 2) >> 4;
}

function createOutputImage(width: number, height: number) {
  return new ImageData(width, height);
}

function writePixel(
  output: ImageData,
  pixelIndex: number,
  gray: number,
  alpha: number,
  invert: boolean,
) {
  const value = invert ? 255 - gray : gray;
  const dataIndex = pixelIndex * 4;
  output.data[dataIndex] = value;
  output.data[dataIndex + 1] = value;
  output.data[dataIndex + 2] = value;
  output.data[dataIndex + 3] = alpha;
}

function thresholdImage(imageData: ImageData, options: ConvertOptions) {
  const { width, height, data } = imageData;
  const output = createOutputImage(width, height);
  const threshold = normalizeThreshold(options.threshold);

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const dataIndex = pixelIndex * 4;
    const gray = getWeightedGray(data, dataIndex);
    writePixel(
      output,
      pixelIndex,
      gray < threshold ? 0 : 255,
      data[dataIndex + 3],
      options.invert,
    );
  }

  return output;
}

function ditherImage(imageData: ImageData, options: ConvertOptions) {
  const { width, height, data } = imageData;
  const output = createOutputImage(width, height);
  const luminance = new Float32Array(width * height);
  const opaque = new Uint8Array(width * height);

  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex++) {
    const dataIndex = pixelIndex * 4;
    const alpha = data[dataIndex + 3];
    opaque[pixelIndex] = alpha === 0 ? 0 : 1;
    luminance[pixelIndex] = opaque[pixelIndex]
      ? getWeightedGray(data, dataIndex)
      : 255;
  }

  const addError = (x: number, y: number, error: number, factor: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    if (!opaque[index]) return;
    luminance[index] += error * factor;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const dataIndex = pixelIndex * 4;
      const alpha = data[dataIndex + 3];

      if (!opaque[pixelIndex]) {
        writePixel(output, pixelIndex, 255, alpha, options.invert);
        continue;
      }

      const oldPixel = luminance[pixelIndex];
      const newPixel = oldPixel < 128 ? 0 : 255;
      const quantError = oldPixel - newPixel;
      luminance[pixelIndex] = newPixel;
      writePixel(output, pixelIndex, newPixel, alpha, options.invert);

      addError(x + 1, y, quantError, 7 / 16);
      addError(x - 1, y + 1, quantError, 3 / 16);
      addError(x, y + 1, quantError, 5 / 16);
      addError(x + 1, y + 1, quantError, 1 / 16);
    }
  }

  return output;
}

function imageDataToBitmapArray(imageData: ImageData) {
  const bitmap: number[][] = [];
  const { width, height, data } = imageData;

  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      if (data[index + 3] === 0) {
        row.push(0);
        continue;
      }

      const gray = getWeightedGray(data, index);
      row.push(gray > DEFAULT_THRESHOLD ? 0 : 1);
    }
    bitmap.push(row);
  }

  return bitmap;
}

self.addEventListener('message', (event: MessageEvent<ConvertRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'convert') return;

  try {
    const converted = request.options.dither
      ? ditherImage(request.imageData, request.options)
      : thresholdImage(request.imageData, request.options);
    const bitmapArray = imageDataToBitmapArray(converted);
    const message: ConvertDoneMessage = {
      type: 'done',
      requestId: request.requestId,
      imageData: converted,
      bitmapArray,
    };
    self.postMessage(message, [converted.data.buffer]);
  } catch (error: any) {
    const message: ConvertErrorMessage = {
      type: 'error',
      requestId: request.requestId,
      message: error?.message || 'Bitmap conversion failed',
    };
    self.postMessage(message);
  }
});

export {};
