import { IAilyHostAPI } from './host-api';

let instance: IAilyHostAPI | null = null;

export const AilyHost = {
  init(host: IAilyHostAPI): void {
    instance = host;
  },

  get(): IAilyHostAPI {
    if (!instance) {
      throw new Error('[AilyHost] Host API has not been initialized.');
    }
    return instance;
  },

  isInitialized(): boolean {
    return instance !== null;
  },
};
