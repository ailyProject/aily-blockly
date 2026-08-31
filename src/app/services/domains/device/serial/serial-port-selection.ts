export interface SerialPortSelectionCandidate {
  name?: string;
  text?: string;
  type?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  manufacturer?: string;
  pnpId?: string;
}

export interface SerialPortSelectionResult<T extends SerialPortSelectionCandidate> {
  selected: T | null;
  reason: 'explicit_port' | 'current_port' | 'board_usb_match' | 'single_port' | 'device_score' | 'none' | 'ambiguous';
  confidence: 'high' | 'medium' | 'none';
  candidates: Array<{
    port: T;
    score: number;
    reasons: string[];
  }>;
  message: string;
}

const SERIAL_DEVICE_HINTS = [
  'arduino',
  'usb',
  'uart',
  'serial',
  'wch',
  'ch340',
  'ch341',
  'cp210',
  'ftdi',
  'slab',
  'usbmodem',
  'usbserial',
  'acm',
];

const NON_FLASH_PORT_HINTS = [
  'bluetooth',
  'incoming-port',
  'debug-console',
  'wireless',
];

function normalizeUsbId(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase()
    .padStart(4, '0');
}

function normalizePortName(value: unknown): string {
  return String(value || '').trim();
}

function normalizedSearchText(port: SerialPortSelectionCandidate): string {
  return [
    port.name,
    port.text,
    port.manufacturer,
    port.pnpId,
    port.vendorId,
    port.productId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function configuredUsbIds(
  boardConfig: Record<string, unknown> | null | undefined,
  kind: 'vendor' | 'product',
): Set<string> {
  const ids = new Set<string>();
  if (!boardConfig) return ids;

  const keyPattern = kind === 'vendor'
    ? /^(vendorid|vendorids|usbvendorid|usbvendorids|usbvid|usbvids|vid|vids)$/i
    : /^(productid|productids|usbproductid|usbproductids|usbpid|usbpids|pid|pids)$/i;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: boardConfig, depth: 0 }];
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== 'object' || depth > 3) continue;

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object') {
          pending.push({ value: entry, depth: depth + 1 });
        }
      }
      continue;
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (keyPattern.test(key)) {
        const rawValues = Array.isArray(entry) ? entry : [entry];
        for (const rawValue of rawValues) {
          const normalized = normalizeUsbId(rawValue);
          if (normalized && normalized !== '0000') ids.add(normalized);
        }
      }
      if (entry && typeof entry === 'object') {
        pending.push({ value: entry, depth: depth + 1 });
      }
    }
  }
  return ids;
}

function boardNameTokens(boardConfig: Record<string, unknown> | null | undefined): string[] {
  const raw = [
    boardConfig?.['name'],
    boardConfig?.['description'],
    boardConfig?.['type'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return [...new Set(raw.split(/[^a-z0-9]+/).filter(token => token.length >= 4))];
}

function scorePort(
  port: SerialPortSelectionCandidate,
  boardConfig: Record<string, unknown> | null | undefined,
): { score: number; reasons: string[]; boardUsbMatch: boolean } {
  const text = normalizedSearchText(port);
  const reasons: string[] = [];
  let score = 0;
  let boardUsbMatch = false;

  if (NON_FLASH_PORT_HINTS.some(hint => text.includes(hint))) {
    score -= 100;
    reasons.push('疑似非烧录用蓝牙/系统串口');
  }
  if (SERIAL_DEVICE_HINTS.some(hint => text.includes(hint))) {
    score += 20;
    reasons.push('名称或路径符合 USB 串口特征');
  }

  const vendorIds = configuredUsbIds(boardConfig, 'vendor');
  const productIds = configuredUsbIds(boardConfig, 'product');
  const vendorId = normalizeUsbId(port.vendorId);
  const productId = normalizeUsbId(port.productId);
  const vendorMatch = !!vendorId && vendorIds.has(vendorId);
  const productMatch = !!productId && productIds.has(productId);
  if (vendorMatch && productMatch) {
    score += 160;
    boardUsbMatch = true;
    reasons.push(`VID:PID 与当前开发板匹配 (${vendorId}:${productId})`);
  } else {
    if (vendorMatch) {
      score += 50;
      boardUsbMatch = true;
      reasons.push(`VID 与当前开发板匹配 (${vendorId})`);
    }
    if (productMatch) {
      score += 80;
      boardUsbMatch = true;
      reasons.push(`PID 与当前开发板匹配 (${productId})`);
    }
  }

  const matchedBoardTokens = boardNameTokens(boardConfig).filter(token => text.includes(token));
  if (matchedBoardTokens.length > 0) {
    score += Math.min(60, matchedBoardTokens.length * 20);
    reasons.push(`设备描述匹配开发板关键词: ${matchedBoardTokens.join(', ')}`);
  }

  return { score, reasons, boardUsbMatch };
}

export function selectSerialPort<T extends SerialPortSelectionCandidate>(
  ports: T[],
  options: {
    requestedPort?: string;
    currentPort?: string;
    boardConfig?: Record<string, unknown> | null;
  } = {},
): SerialPortSelectionResult<T> {
  const candidates = ports
    .filter(port => (port.type || 'serial') === 'serial' && !!normalizePortName(port.name))
    .map(port => ({ port, ...scorePort(port, options.boardConfig) }))
    .sort((a, b) => b.score - a.score || normalizePortName(a.port.name).localeCompare(normalizePortName(b.port.name)));

  const requestedPort = normalizePortName(options.requestedPort);
  if (requestedPort) {
    const explicit = candidates.find(candidate => normalizePortName(candidate.port.name) === requestedPort);
    if (explicit) {
      return {
        selected: explicit.port,
        reason: 'explicit_port',
        confidence: 'high',
        candidates,
        message: `使用调用方指定串口: ${requestedPort}`,
      };
    }
    return {
      selected: null,
      reason: 'none',
      confidence: 'none',
      candidates,
      message: candidates.length > 0
        ? `指定串口 ${requestedPort} 当前不可用。`
        : `指定串口 ${requestedPort} 当前不可用，且未检测到串口。`,
    };
  }

  const currentPort = normalizePortName(options.currentPort);
  if (currentPort) {
    const current = candidates.find(candidate => normalizePortName(candidate.port.name) === currentPort);
    if (current) {
      return {
        selected: current.port,
        reason: 'current_port',
        confidence: 'high',
        candidates,
        message: `沿用主软件当前已选择串口: ${currentPort}`,
      };
    }
  }

  const boardMatches = candidates.filter(candidate => candidate.boardUsbMatch);
  if (boardMatches.length === 1) {
    return {
      selected: boardMatches[0].port,
      reason: 'board_usb_match',
      confidence: 'high',
      candidates,
      message: `根据当前开发板 USB 标识自动选择串口: ${normalizePortName(boardMatches[0].port.name)}`,
    };
  }

  const usableCandidates = candidates.filter(candidate => candidate.score >= 0);
  if (usableCandidates.length === 1) {
    return {
      selected: usableCandidates[0].port,
      reason: candidates.length === 1 ? 'single_port' : 'device_score',
      confidence: candidates.length === 1 ? 'high' : 'medium',
      candidates,
      message: candidates.length === 1
        ? `仅检测到一个可用串口，自动选择: ${normalizePortName(usableCandidates[0].port.name)}`
        : `排除疑似非烧录端口后自动选择: ${normalizePortName(usableCandidates[0].port.name)}`,
    };
  }

  if (usableCandidates.length > 1) {
    const [best, second] = usableCandidates;
    if (best.score > 0 && best.score - second.score >= 20) {
      return {
        selected: best.port,
        reason: best.boardUsbMatch ? 'board_usb_match' : 'device_score',
        confidence: best.boardUsbMatch ? 'high' : 'medium',
        candidates,
        message: `根据开发板和设备信息自动选择串口: ${normalizePortName(best.port.name)}`,
      };
    }
    return {
      selected: null,
      reason: 'ambiguous',
      confidence: 'none',
      candidates,
      message: `检测到多个无法可靠区分的烧录串口: ${usableCandidates.map(candidate => normalizePortName(candidate.port.name)).join(', ')}。请显式指定 port。`,
    };
  }

  return {
    selected: null,
    reason: 'none',
    confidence: 'none',
    candidates,
    message: candidates.length > 0 ? '未检测到可用于烧录的串口。' : '未检测到串口。',
  };
}
