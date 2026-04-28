import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';

export interface ProbeRsProbe {
  index: number | null;
  name?: string;
  vidPid?: string;
  serial?: string | null;
  shortSerial?: string | null;
  type?: string;
  raw?: string;
}

export interface ProbeRsDownloadOptions {
  firmwarePath: string;
  chip?: string;
  probe?: string;           // vid:pid[:serial]
  protocol?: string;        // "swd" | "jtag"
  speed?: number;
  format?: string;          // "elf" | "hex" | "bin"
  baseAddress?: number;
  skipBytes?: number;
  verify?: boolean;
}

export interface ProbeRsListResult {
  success: boolean;
  count?: number;
  probes?: ProbeRsProbe[];
  error?: string;
  detail?: string | null;
}

export interface ProbeRsDownloadResult {
  success: boolean;
  firmware?: string;
  chip?: string;
  message?: string;
  error?: string;
  detail?: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class ProbeRsService {

  constructor(
    private electronService: ElectronService
  ) { }

  private get api() {
    return window['probeRs'];
  }

  async listProbes(): Promise<ProbeRsListResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    return await this.api.list();
  }

  async download(options: ProbeRsDownloadOptions): Promise<ProbeRsDownloadResult> {
    if (!this.electronService.isElectron) {
      return { success: false, error: 'Not running in Electron' };
    }
    return await this.api.download(options);
  }
}
