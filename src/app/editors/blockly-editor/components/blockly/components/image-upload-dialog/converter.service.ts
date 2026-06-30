import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ConverterService {
  context: CanvasRenderingContext2D;
  image: ImageData;
  private worker: Worker | null = null;
  private requestId = 0;
  private cancelActiveConversion: (() => void) | null = null;

  convert(context: CanvasRenderingContext2D, image: ImageData, options: convertOptions) {
    this.terminateWorker(true);

    return new Promise<string>((resolve, reject) => {
      this.context = context;
      this.image = image;
      this.bitmap2DArray = [];
      const requestId = ++this.requestId;
      const worker = new Worker(
        new URL('./bitmap-converter.worker.ts', import.meta.url),
        { type: 'module' },
      );

      this.worker = worker;
      this.cancelActiveConversion = () => {
        const error = new Error('Bitmap conversion canceled');
        error.name = 'AbortError';
        reject(error);
      };

      worker.onmessage = (event: MessageEvent<ConvertWorkerMessage>) => {
        const message = event.data;
        if (!message || message.requestId !== requestId) return;

        if (message.type === 'done') {
          this.image = message.imageData;
          this.context.putImageData(message.imageData, 0, 0);
          this.bitmap2DArray = message.bitmapArray;
          this.terminateWorker();
          resolve('');
          return;
        }

        this.terminateWorker();
        reject(new Error(message.message || 'Bitmap conversion failed'));
      };

      worker.onerror = (error) => {
        this.terminateWorker();
        reject(new Error(error.message || 'Worker conversion failed'));
      };

      const transferableImage = new ImageData(
        new Uint8ClampedArray(image.data),
        image.width,
        image.height,
      );
      worker.postMessage({
        type: 'convert',
        requestId,
        imageData: transferableImage,
        options: { ...options },
      }, [transferableImage.data.buffer]);
    });
  }

  private bitmap2DArray: number[][] = [];

  cancel() {
    this.terminateWorker(true);
  }

  private terminateWorker(cancel = false) {
    if (cancel && this.cancelActiveConversion) {
      this.cancelActiveConversion();
    }
    this.cancelActiveConversion = null;

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
  /**
   * 将当前图像转换为二维bitmap数组
   * @returns 二维数组，0表示空白，1表示填充
   */
  getBitmap2DArray(): number[][] {
    if (this.bitmap2DArray.length) {
      return this.bitmap2DArray.map(row => [...row]);
    }

    const bitmap: number[][] = [];
    for (let y = 0; y < this.image.height; y++) {
      const row: number[] = [];
      for (let x = 0; x < this.image.width; x++) {
        const index = (y * this.image.width + x) * 4;
        // 获取像素的alpha值
        const alpha = this.image.data[index + 3];

        // 如果像素是透明的，直接设为0（空白）
        if (alpha === 0) {
          row.push(0);
          continue;
        }

        // 获取像素的灰度值
        const gray = (this.image.data[index] * 0.299 +
          this.image.data[index + 1] * 0.587 +
          this.image.data[index + 2] * 0.114);
        // 根据灰度值决定是0还是1
        row.push(gray > 127 ? 0 : 1); // 白色为0，黑色为1
      }
      bitmap.push(row);
    }

    this.bitmap2DArray = bitmap.map(row => [...row]);
    return bitmap;
  }

  dither() {
    let newImageData = this.context.createImageData(this.image.width, this.image.height)
    let imageArray = newImageData.data
    // convert to grayscale
    for (let i = 0; i < this.image.data.length; i += 4) {
      let gray = (this.image.data[i] * 4 + this.image.data[i + 1] * 10 + this.image.data[i + 2] * 2) >> 4;
      imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = gray;
      imageArray[i + 3] = this.image.data[i + 3];
    }
    for (let i = 0; i < this.image.data.length; i += 4) {
      if (imageArray[i + (this.image.width * 4)] === -1 || imageArray[i + 4] === -1) {
        break;
      } else {
        let oldPixel = imageArray[i];
        let newPixel = this.findClosestPalCol(imageArray[i]);
        imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = newPixel;
        let quantError = oldPixel - newPixel;
        imageArray[i + 4] = imageArray[i + 4] + quantError * (7 / 16);
        imageArray[i + (this.image.width * 4)] = imageArray[i + (this.image.width * 4)] + quantError * (5 / 16);
        imageArray[i + (this.image.width * 4 - 4)] = imageArray[i + (this.image.width * 4 - 4)] + quantError * (3 / 16);
        imageArray[i + (this.image.width * 4 + 4)] = imageArray[i + (this.image.width * 4 + 4)] + quantError * (1 / 16);
      }
    }
    this.context.putImageData(newImageData, 0, 0);
    this.image = newImageData;
  }

  findClosestPalCol(srcPx: any) {
    if (256 - srcPx < 256 / 2) {
      return 255;
    } else {
      return 0;
    }
  }

  pickColor(options) {
    let newImageData = this.context.createImageData(this.image.width, this.image.height)
    let imageArray = newImageData.data
    // convert to grayscale
    for (let i = 0; i < this.image.data.length; i += 4) {
      let gray = (this.image.data[i] * 4 + this.image.data[i + 1] * 10 + this.image.data[i + 2] * 2) >> 4;
      if (gray < options.threshold) {
        imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = 0
      } else {
        imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = 255
      }
      imageArray[i + 3] = this.image.data[i + 3];
    }
    this.context.putImageData(newImageData, 0, 0);
    this.image = newImageData;
  }

  invertColor() {
    let newImageData = this.context.createImageData(this.image.width, this.image.height)
    let imageArray = newImageData.data
    for (let i = 0; i < imageArray.length; i += 4) {
      imageArray[i] = 255 - this.image.data[i];
      imageArray[i + 1] = 255 - this.image.data[i + 1];
      imageArray[i + 2] = 255 - this.image.data[i + 2];
      imageArray[i + 3] = this.image.data[i + 3];
    }
    this.context.putImageData(newImageData, 0, 0);
    this.image = newImageData;
  }

  getBitmapArray(options: convertOptions) {
    let result = '';
    for (var y = 0; y < this.image.height; y++) {
      let next_value = 0
      for (var x = 0; x < this.image.width; x++) {
        let n = (y * this.image.width + x) * 4
        let gray = (this.image.data[n] * 4 + this.image.data[n + 1] * 10 + this.image.data[n + 2] * 2) >> 4;
        if (gray == 255) next_value += Math.pow(2, (7 - (x % 8)));

        if (((x + 1) % 8 == 0 || x == this.image.width - 1) && (x > 0)) {
          if (options.endian) {
            next_value = this.reverseBit(next_value);
          }
          result += '0x' + ('00' + next_value.toString(16)).substr(-2) + ',';
          next_value = 0;
        }
      }
    }
    result = result.slice(0, result.length - 1);
    return result
  }

  reverseBit(data: any) {
    let res = 0;
    for (var x = 0; x < 8; x++) {
      res = res << 1
      res = res | (data & 1)
      data = data >> 1
    }
    return res
  }


}

export interface convertOptions {
  endian: boolean,
  invert: boolean,
  dither: boolean,
  threshold: number,
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

type ConvertWorkerMessage = ConvertDoneMessage | ConvertErrorMessage;
