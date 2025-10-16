/**
 * 图片工具类
 * 提供图片转换和压缩功能
 */

/**
 * 图片转换配置选项
 */
export interface ImageConvertOptions {
  /** 图片质量 0-1，默认0.9 */
  quality?: number;
  /** 输出格式，默认'webp' */
  format?: 'webp' | 'jpeg' | 'png';
}

/**
 * 图片压缩配置选项
 */
export interface ImageResizeOptions {
  /** 目标宽度 */
  width: number;
  /** 目标高度 */
  height: number;
  /** 图片质量 0-1，默认0.9 */
  quality?: number;
  /** 输出格式，默认'webp' */
  format?: 'webp' | 'jpeg' | 'png';
  /** 是否保持宽高比，默认false */
  maintainAspectRatio?: boolean;
  /** 
   * 缩放模式
   * - 'fit': 适应模式，图片完整显示在目标区域内，可能有空白（默认）
   * - 'fill': 填充模式，图片填满目标区域，可能会裁剪
   * - 'stretch': 拉伸模式，强制拉伸到目标尺寸，不保持宽高比
   */
  resizeMode?: 'fit' | 'fill' | 'stretch';
}

/**
 * 将图片转换为WebP格式
 * @param file 输入的图片文件
 * @param options 转换选项
 * @returns Promise<Blob> 转换后的WebP图片Blob对象
 */
export async function convertImageToWebP(
  file: File | Blob,
  options: ImageConvertOptions = {}
): Promise<Blob> {
  const { quality = 0.9, format = 'webp' } = options;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('无法创建canvas上下文'));
      return;
    }

    img.onload = () => {
      // 设置canvas尺寸为原图尺寸
      canvas.width = img.width;
      canvas.height = img.height;

      // 绘制图片到canvas
      ctx.drawImage(img, 0, 0);

      // 转换为指定格式
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('图片转换失败'));
          }
        },
        `image/${format}`,
        quality
      );
    };

    img.onerror = () => {
      reject(new Error('图片加载失败'));
    };

    // 加载图片
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        img.src = e.target.result as string;
      }
    };
    reader.onerror = () => {
      reject(new Error('文件读取失败'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 压缩图片到指定分辨率
 * @param file 输入的图片文件
 * @param options 压缩选项
 * @returns Promise<Blob> 压缩后的图片Blob对象
 */
export async function resizeImage(
  file: File | Blob,
  options: ImageResizeOptions
): Promise<Blob> {
  const {
    width,
    height,
    quality = 0.9,
    format = 'webp',
    maintainAspectRatio = false,
    resizeMode = 'fit',
  } = options;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('无法创建canvas上下文'));
      return;
    }

    img.onload = () => {
      // 设置canvas尺寸为目标尺寸
      canvas.width = width;
      canvas.height = height;

      // 使用高质量缩放
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // 根据不同的缩放模式处理
      if (resizeMode === 'stretch') {
        // 拉伸模式：强制拉伸到目标尺寸，忽略宽高比
        ctx.drawImage(img, 0, 0, width, height);
      } else if (resizeMode === 'fill') {
        // 填充模式：保持宽高比，填满目标区域，多余部分会被裁剪
        const aspectRatio = img.width / img.height;
        const targetAspectRatio = width / height;

        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = img.width;
        let sourceHeight = img.height;

        if (aspectRatio > targetAspectRatio) {
          // 原图更宽，需要裁剪左右两侧
          sourceWidth = Math.round(img.height * targetAspectRatio);
          sourceX = Math.round((img.width - sourceWidth) / 2);
        } else {
          // 原图更高或相等，需要裁剪上下两侧
          sourceHeight = Math.round(img.width / targetAspectRatio);
          sourceY = Math.round((img.height - sourceHeight) / 2);
        }

        // 使用 drawImage 的9参数版本进行裁剪和缩放
        ctx.drawImage(
          img,
          sourceX, sourceY, sourceWidth, sourceHeight, // 源图裁剪区域
          0, 0, width, height // 目标绘制区域
        );
      } else {
        // fit模式：适应模式（默认）
        let drawX = 0;
        let drawY = 0;
        let drawWidth = width;
        let drawHeight = height;

        if (maintainAspectRatio) {
          const aspectRatio = img.width / img.height;
          const targetAspectRatio = width / height;

          // 如果原图已经比目标尺寸小，保持原尺寸不放大
          if (img.width <= width && img.height <= height) {
            drawWidth = img.width;
            drawHeight = img.height;
            drawX = Math.round((width - drawWidth) / 2);
            drawY = Math.round((height - drawHeight) / 2);
          } else if (aspectRatio > targetAspectRatio) {
            // 原图更宽，以宽度为准
            drawWidth = width;
            drawHeight = Math.round(width / aspectRatio);
            drawY = Math.round((height - drawHeight) / 2);
          } else {
            // 原图更高，以高度为准
            drawHeight = height;
            drawWidth = Math.round(height * aspectRatio);
            drawX = Math.round((width - drawWidth) / 2);
          }

          // 填充白色背景（可以根据需求改成透明或其他颜色）
          if (drawWidth < width || drawHeight < height) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
          }
        }

        // 绘制缩放后的图片
        ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
      }

      // 转换为指定格式
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('图片压缩失败'));
          }
        },
        `image/${format}`,
        quality
      );
    };

    img.onerror = () => {
      reject(new Error('图片加载失败'));
    };

    // 加载图片
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        img.src = e.target.result as string;
      }
    };
    reader.onerror = () => {
      reject(new Error('文件读取失败'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 批量转换图片为WebP格式
 * @param files 输入的图片文件数组
 * @param options 转换选项
 * @returns Promise<Blob[]> 转换后的WebP图片Blob数组
 */
export async function batchConvertToWebP(
  files: File[],
  options: ImageConvertOptions = {}
): Promise<Blob[]> {
  const promises = files.map((file) => convertImageToWebP(file, options));
  return Promise.all(promises);
}

/**
 * 批量压缩图片
 * @param files 输入的图片文件数组
 * @param options 压缩选项
 * @returns Promise<Blob[]> 压缩后的图片Blob数组
 */
export async function batchResizeImages(
  files: File[],
  options: ImageResizeOptions
): Promise<Blob[]> {
  const promises = files.map((file) => resizeImage(file, options));
  return Promise.all(promises);
}

/**
 * 将Blob转换为File对象
 * @param blob Blob对象
 * @param fileName 文件名
 * @returns File对象
 */
export function blobToFile(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: blob.type });
}

/**
 * 下载Blob为文件
 * @param blob Blob对象
 * @param fileName 文件名
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * 获取图片尺寸信息
 * @param file 图片文件
 * @returns Promise<{width: number, height: number}> 图片宽高信息
 */
export async function getImageDimensions(
  file: File | Blob
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      resolve({
        width: img.width,
        height: img.height,
      });
    };

    img.onerror = () => {
      reject(new Error('无法获取图片尺寸'));
    };

    const reader = new FileReader();
    reader.onload = (e) => {
      if (e.target?.result) {
        img.src = e.target.result as string;
      }
    };
    reader.onerror = () => {
      reject(new Error('文件读取失败'));
    };
    reader.readAsDataURL(file);
  });
}
