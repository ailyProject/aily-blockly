import { Injectable } from '@angular/core';

export interface convertOptions {
  endian: boolean;
  invert: boolean;
  dither: boolean;
  threshold: number;
}

export class convertImage {
  base64: string;
  bitmapArray: string;
}

@Injectable({
  providedIn: 'root',
})
export class ConverterService {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  image: ImageData;
  options: convertOptions;

  convert(imageBase64: string, options: convertOptions) {
    return new Promise<convertImage>((resolve, reject) => {
      const canvas = document.createElement('canvas');
      const img = new Image();

      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;

        const context = canvas.getContext('2d');
        if (!context) {
          reject('Could not get canvas context');
          return;
        }

        context.drawImage(img, 0, 0);

        const image = context.getImageData(0, 0, canvas.width, canvas.height);

        this.canvas = canvas;
        this.context = context;
        this.image = image;
        this.options = options;

        if (this.options.dither) {
          this.dither();
        } else {
          this.pickColor();
        }
        if (this.options.invert) {
          this.invertColor();
        }

        resolve({
          base64: canvas.toDataURL('image/png'),
          bitmapArray: this.getBitmapArray(),
        });
      };

      img.onerror = () => {
        reject('Error loading image from base64 string');
      };

      img.src = imageBase64;
    });
  }

  dither() {
    let newImageData = this.context.createImageData(
      this.image.width,
      this.image.height,
    );
    let imageArray = newImageData.data;
    for (let i = 0; i < this.image.data.length; i += 4) {
      let gray =
        (this.image.data[i] * 4 +
          this.image.data[i + 1] * 10 +
          this.image.data[i + 2] * 2) >>
        4;
      imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = gray;
      imageArray[i + 3] = this.image.data[i + 3];
    }
    for (let i = 0; i < this.image.data.length; i += 4) {
      if (
        imageArray[i + this.image.width * 4] === -1 ||
        imageArray[i + 4] === -1
      ) {
        break;
      } else {
        let oldPixel = imageArray[i];
        let newPixel = this.findClosestPalCol(imageArray[i]);
        imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = newPixel;
        let quantError = oldPixel - newPixel;
        imageArray[i + 4] = imageArray[i + 4] + quantError * (7 / 16);
        imageArray[i + this.image.width * 4] =
          imageArray[i + this.image.width * 4] + quantError * (5 / 16);
        imageArray[i + (this.image.width * 4 - 4)] =
          imageArray[i + (this.image.width * 4 - 4)] + quantError * (3 / 16);
        imageArray[i + (this.image.width * 4 + 4)] =
          imageArray[i + (this.image.width * 4 + 4)] + quantError * (1 / 16);
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

  pickColor() {
    let newImageData = this.context.createImageData(
      this.image.width,
      this.image.height,
    );
    let imageArray = newImageData.data;

    for (let i = 0; i < this.image.data.length; i += 4) {
      let gray =
        (this.image.data[i] * 4 +
          this.image.data[i + 1] * 10 +
          this.image.data[i + 2] * 2) >>
        4;
      if (gray < this.options.threshold) {
        imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = 0;
      } else {
        imageArray[i] = imageArray[i + 1] = imageArray[i + 2] = 255;
      }
      imageArray[i + 3] = this.image.data[i + 3];
    }
    this.context.putImageData(newImageData, 0, 0);
    this.image = newImageData;
  }

  invertColor() {
    let newImageData = this.context.createImageData(
      this.image.width,
      this.image.height,
    );
    let imageArray = newImageData.data;
    for (let i = 0; i < imageArray.length; i += 4) {
      imageArray[i] = 255 - this.image.data[i];
      imageArray[i + 1] = 255 - this.image.data[i + 1];
      imageArray[i + 2] = 255 - this.image.data[i + 2];
      imageArray[i + 3] = this.image.data[i + 3];
    }
    this.context.putImageData(newImageData, 0, 0);
    this.image = newImageData;
  }

  getBitmapArray() {
    let result = '';
    for (let y = 0; y < this.image.height; y++) {
      let next_value = 0;
      for (let x = 0; x < this.image.width; x++) {
        let n = (y * this.image.width + x) * 4;
        let gray =
          (this.image.data[n] * 4 +
            this.image.data[n + 1] * 10 +
            this.image.data[n + 2] * 2) >>
          4;
        if (gray == 255) next_value += Math.pow(2, 7 - (x % 8));

        if (((x + 1) % 8 == 0 || x == this.image.width - 1) && x > 0) {
          if (this.options.endian) {
            next_value = this.reverseBit(next_value);
          }
          result += '0x' + ('00' + next_value.toString(16)).substr(-2) + ',';
          next_value = 0;
        }
      }
    }
    result = result.slice(0, result.length - 1);
    return result;
  }

  reverseBit(data: any) {
    let res = 0;
    for (let x = 0; x < 8; x++) {
      res = res << 1;
      res = res | (data & 1);
      data = data >> 1;
    }
    return res;
  }
}
