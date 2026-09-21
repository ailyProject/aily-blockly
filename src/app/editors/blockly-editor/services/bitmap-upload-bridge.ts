import type { BitmapUploadService } from './bitmap-upload.service';

/** Per-JavaScript-realm UI service bridge; importing a field does not bootstrap Angular. */
export class GlobalServiceManager {
  private static instance: GlobalServiceManager;
  private bitmapUploadService: BitmapUploadService | null = null;

  private constructor() {}

  static getInstance(): GlobalServiceManager {
    return GlobalServiceManager.instance ??= new GlobalServiceManager();
  }

  setBitmapUploadService(service: BitmapUploadService): void { this.bitmapUploadService = service; }
  getBitmapUploadService(): BitmapUploadService | null { return this.bitmapUploadService; }
}
