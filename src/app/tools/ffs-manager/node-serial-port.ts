/**
 * Node SerialPort -> WebSerial 适配层
 *
 * esptool-js 的 Transport 直接依赖 Web Serial API（readable/writable 流、
 * open/close、setSignals、getInfo）。这里通过 preload 暴露的
 * `window.electronAPI.SerialPort.createRaw` 拿到 Node serialport 的包装对象，
 * 再补一层 WebSerial 形状的接口给 Transport 使用。
 */

export interface NodeSerialOpenOptions {
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

export interface NodeSerialPortAdapterOptions {
  /** 串口路径，例如 Windows 上的 COM3、macOS 上的 /dev/cu.usbserial-xxx */
  path: string;
  /** 透传给底层 SerialPort 构造函数的额外选项 */
  extra?: Record<string, unknown>;
}

declare const window: any;

type RawSerialPort = any;

export class NodeSerialPortAdapter {
  readonly path: string;
  private readonly extraOptions: Record<string, unknown>;
  private port: RawSerialPort | null = null;
  private dataHandler: ((data: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;

  // 共享的接收队列：data 事件直接 push，ReadableStream 从中 pull。
  private rxQueue: Uint8Array[] = [];
  private rxPending: (() => void) | null = null;
  private rxClosed = false;
  private rxError: Error | null = null;
  private currentReadable: ReadableStream<Uint8Array> | null = null;

  // “停放”的底层 SerialPort：close() 调用并不会立即关闭 OS 句柄，
  // 而是延迟一小段时间，给 esptool-js 的 changeBaud（close → open）
  // 一个机会复用同一个 OS 句柄并通过 port.update() 改波特率。
  // Windows 的 node-serialport 在 close→open 之间常常返回
  // ACCESS DENIED，原生 WebSerial 因为不真正释放 OS 句柄所以没有该问题。
  private parkedPort: RawSerialPort | null = null;
  private parkTimer: any = null;
  private static readonly PARK_DURATION_MS = 800;

  writable: WritableStream<Uint8Array> | null = null;

  /**
   * WebSerial 的语义：`port.readable` 在上一条流被 cancel/close 后会自动返回新的流。
   * esptool-js 的 `flushInput()` 依赖这一点（cancel 老 reader 后再 `device.readable?.getReader()`）。
   * 这里用 getter 在需要时按需重建一条新的流，复用同一份接收队列。
   */
  get readable(): ReadableStream<Uint8Array> | null {
    if (!this.port) return null;
    const existing = this.currentReadable;
    if (existing && !this.isReadableDead(existing)) {
      return existing;
    }
    return this.createReadable();
  }

  constructor(options: NodeSerialPortAdapterOptions) {
    this.path = options.path;
    this.extraOptions = options.extra ?? {};
  }

  /** WebSerial.open() 的兼容实现：每次调用都新建一个底层 SerialPort 并打开。 */
  async open(options: NodeSerialOpenOptions): Promise<void> {
    if (this.port) {
      throw new Error('串口已打开');
    }

    // 注意：早期实现会在 park 窗口内通过 port.update({baudRate}) 复用同一句柄。
    // 这对原生 USB-CDC（ESP32-S3 0x303a）没问题——波特率本来就是占位值——但是对
    // CH340 之类的硬件 UART 在 Windows 上不可靠：node-serialport 的 update 返回
    // 成功，CH340 驱动却没有真正切到新波特率，host 仍以旧速率读取，esptool 在
    // changeBaud 之后所有命令必然超时。
    // 因此这里改为：始终把 parked 句柄真正关闭，再 createRaw + open 一次。
    // Windows close→open 之间的 ACCESS DENIED 由下面的指数退避重试覆盖。
    if (this.parkedPort) {
      const parked = this.parkedPort;
      this.parkedPort = null;
      if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = null; }
      await this.forceCloseRaw(parked);
    }

    const factory = window?.electronAPI?.SerialPort?.createRaw;
    if (typeof factory !== 'function') {
      throw new Error('当前环境未暴露 Node SerialPort（electronAPI.SerialPort.createRaw 不可用）');
    }

    const ctorOptions: Record<string, unknown> = {
      ...this.extraOptions,
      path: this.path,
      baudRate: options.baudRate ?? 115200,
      autoOpen: false,
    };
    if (options.dataBits !== undefined) ctorOptions['dataBits'] = options.dataBits;
    if (options.stopBits !== undefined) ctorOptions['stopBits'] = options.stopBits;
    if (options.parity !== undefined) ctorOptions['parity'] = options.parity;
    if (options.flowControl === 'hardware') {
      ctorOptions['rtscts'] = true;
    }

    // Windows 上 COM 句柄被释放后操作系统需要一点时间才能再次打开；
    // 同进程内的 changeBaud / 外部工具刚释放串口的瞬间都可能撞上
    // ACCESS DENIED / RESOURCE BUSY，这里做指数退避重试。每次重试都
    // 重新 createRaw —— 避免 node-serialport 在同一实例上残留失败状态。
    const maxAttempts = 6;
    let lastErr: any = null;
    let openedPort: RawSerialPort | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidate: RawSerialPort = factory(ctorOptions);
      if (typeof candidate?.open !== 'function') {
        throw new Error('Node SerialPort 桥接对象缺少 open 方法');
      }
      try {
        await new Promise<void>((resolve, reject) => {
          candidate.open((err: Error | null | undefined) => (err ? reject(err) : resolve()));
        });
        openedPort = candidate;
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[NodeSerialPortAdapter] open ${this.path} 失败 (attempt ${attempt + 1}/${maxAttempts})`, err);
        // 主动 close 一下，确保 node-serialport 内部状态被清理。
        try {
          if (candidate?.isOpen) {
            await new Promise<void>((resolve) => candidate.close(() => resolve()));
          }
        } catch { /* ignore */ }
        if (!this.isPortBusyError(err) || attempt === maxAttempts - 1) {
          break;
        }
        const delay = 200 * Math.pow(2, attempt); // 200 / 400 / 800 / 1600 / 3200 ms
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    if (!openedPort || lastErr) {
      throw lastErr ?? new Error('未知串口打开失败');
    }

    this.port = openedPort;
    this.attachStreams(openedPort);
  }

  private isPortBusyError(err: any): boolean {
    if (!err) return false;
    const code = String(err.code || '').toUpperCase();
    const msg = String(err.message || err).toLowerCase();
    return (
      code === 'EACCES' ||
      code === 'EBUSY' ||
      code === 'ERR_ACCESS_DENIED' ||
      msg.includes('access denied') ||
      msg.includes('access is denied') ||
      msg.includes('resource busy')
    );
  }

  /**
   * WebSerial.close() 的兼容实现。
   *
   * 不会立刻关闭 OS 句柄：先把 SerialPort “停放”一段时间（PARK_DURATION_MS）。
   * 如果在停放窗口内 open() 被再次调用（典型场景：esptool-js changeBaud），
   * 则复用同一个句柄、只通过 port.update() 改波特率，彻底避开 Windows
   * close→open 之间的 ACCESS DENIED 竞争。否则停放超时后才真正 close。
   */
  async close(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.port = null;
    this.detachListeners(port);
    this.rxClosed = true;
    const cb = this.rxPending;
    this.rxPending = null;
    if (cb) cb();
    this.currentReadable = null;
    this.writable = null;
    this.rxQueue = [];

    if (this.parkedPort && this.parkedPort !== port) {
      // 罕见：尚有未释放的旧停放端口（理论上不会发生），先强行真关闭。
      await this.forceCloseRaw(this.parkedPort);
      this.parkedPort = null;
      if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = null; }
    }

    if (!port.isOpen) {
      return;
    }

    this.parkedPort = port;
    this.parkTimer = setTimeout(() => {
      const stale = this.parkedPort;
      this.parkedPort = null;
      this.parkTimer = null;
      if (stale) {
        this.forceCloseRaw(stale).catch(() => { /* ignore */ });
      }
    }, NodeSerialPortAdapter.PARK_DURATION_MS);
  }

  /** 立刻关闭一个已停放的底层端口。 */
  private async forceCloseRaw(port: RawSerialPort): Promise<void> {
    await new Promise<void>((resolve) => {
      try {
        if (!port.isOpen) { resolve(); return; }
        port.close((err: Error | null | undefined) => {
          if (err) console.warn('[NodeSerialPortAdapter] forceCloseRaw 失败:', err);
          resolve();
        });
      } catch (err) {
        console.warn('[NodeSerialPortAdapter] forceCloseRaw 抛异常:', err);
        resolve();
      }
    });
  }

  /** 调用方真正不再使用本适配器时调用：立即放掉停放的底层端口。 */
  async dispose(): Promise<void> {
    await this.close();
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = null; }
    const parked = this.parkedPort;
    this.parkedPort = null;
    if (parked) await this.forceCloseRaw(parked);
  }

  /** WebSerial.setSignals() 的兼容实现：透传到 SerialPort.set。 */
  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean; break?: boolean }): Promise<void> {
    const port = this.port;
    if (!port) throw new Error('串口未打开');
    const payload: Record<string, boolean> = {};
    if (signals.dataTerminalReady !== undefined) payload['dtr'] = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) payload['rts'] = signals.requestToSend;
    if (signals.break !== undefined) payload['brk'] = signals.break;
    await new Promise<void>((resolve, reject) => {
      port.set(payload, (err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }

  /** WebSerial.getInfo() 的兼容实现。Node serialport 打开后无法直接拿 VID/PID，留空即可。 */
  getInfo(): { usbVendorId?: number; usbProductId?: number } {
    return {};
  }

  private attachStreams(port: RawSerialPort): void {
    this.rxQueue = [];
    this.rxPending = null;
    this.rxClosed = false;
    this.rxError = null;
    this.currentReadable = null;

    this.dataHandler = (data: Uint8Array) => {
      const view = data instanceof Uint8Array
        ? new Uint8Array(data)
        : new Uint8Array((data as any).buffer ?? data);
      this.rxQueue.push(view);
      const cb = this.rxPending;
      this.rxPending = null;
      if (cb) cb();
    };
    this.closeHandler = () => {
      this.rxClosed = true;
      const cb = this.rxPending;
      this.rxPending = null;
      if (cb) cb();
    };
    this.errorHandler = (err: Error) => {
      this.rxError = err;
      const cb = this.rxPending;
      this.rxPending = null;
      if (cb) cb();
    };

    port.on('data', this.dataHandler);
    port.on('close', this.closeHandler);
    port.on('error', this.errorHandler);

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => new Promise<void>((resolve, reject) => {
        if (!this.port) {
          reject(new Error('串口已关闭'));
          return;
        }
        const payload = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        this.port.write(payload, (err: Error | null | undefined) => (err ? reject(err) : resolve()));
      }),
      close: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    });
  }

  /**
   * 创建一条新的 ReadableStream，背靠共享的 rxQueue。
   * 之前的流被 cancel 后再次访问 `readable` 时会触发新建，
   * 这样和 WebSerial 的 `port.readable` 语义保持一致
   * （esptool-js 的 `flushInput()` 依赖这一点）。
   */
  private createReadable(): ReadableStream<Uint8Array> {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let localClosed = false;

    const flush = () => {
      if (!controller || localClosed) return;
      while (this.rxQueue.length > 0) {
        try {
          controller.enqueue(this.rxQueue.shift()!);
        } catch {
          return;
        }
      }
      if (this.rxError) {
        try { controller.error(this.rxError); } catch { /* ignore */ }
        this.rxError = null;
        localClosed = true;
      } else if (this.rxClosed) {
        try { controller.close(); } catch { /* ignore */ }
        localClosed = true;
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        controller = ctrl;
        flush();
      },
      pull: async () => {
        if (this.rxQueue.length > 0 || this.rxClosed || this.rxError) {
          flush();
          return;
        }
        await new Promise<void>((resolve) => {
          this.rxPending = resolve;
        });
        flush();
      },
      cancel: () => {
        // 只标记自身失效，保留接收队列；下一次 `readable` 访问会得到新流。
        localClosed = true;
        if (this.currentReadable === stream) {
          this.currentReadable = null;
        }
      },
    });

    this.currentReadable = stream;
    return stream;
  }

  private isReadableDead(stream: ReadableStream<Uint8Array>): boolean {
    return this.currentReadable !== stream;
  }


  private detachListeners(port: RawSerialPort): void {
    if (this.dataHandler) {
      try { port.off('data', this.dataHandler); } catch { /* ignore */ }
      this.dataHandler = null;
    }
    if (this.closeHandler) {
      try { port.off('close', this.closeHandler); } catch { /* ignore */ }
      this.closeHandler = null;
    }
    if (this.errorHandler) {
      try { port.off('error', this.errorHandler); } catch { /* ignore */ }
      this.errorHandler = null;
    }
  }
}
