const dgram = require('dgram');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_arduino._tcp.local';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;
const CLASS_IN = 1;
const CLASS_QU = 0x8000;

function logProgress(text) {
  console.log(`[network-ota-mdns:progress] ${text}`);
}

function logError(message) {
  console.error(`[network-ota-mdns:error] ${message}`);
}

function normalizeName(value) {
  return String(value || '').replace(/\.$/, '').toLowerCase();
}

function stripTrailingDot(value) {
  return String(value || '').replace(/\.$/, '');
}

function isServiceInstance(name) {
  return normalizeName(name).endsWith(`.${SERVICE_TYPE}`);
}

function getInstanceName(serviceFqdn) {
  const suffix = `.${SERVICE_TYPE}`;
  const normalized = stripTrailingDot(serviceFqdn);
  if (!normalizeName(normalized).endsWith(suffix)) {
    return normalized;
  }
  return normalized.slice(0, normalized.length - suffix.length);
}

function encodeName(name) {
  const parts = String(name || '').replace(/\.$/, '').split('.');
  const chunks = [];
  for (const part of parts) {
    const data = Buffer.from(part, 'utf8');
    if (data.length > 63) {
      throw new Error(`mDNS label is too long: ${part}`);
    }
    chunks.push(Buffer.from([data.length]), data);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function buildQuery(useUnicastResponse) {
  const questionName = encodeName(SERVICE_TYPE);
  const packet = Buffer.alloc(12 + questionName.length + 4);
  packet.writeUInt16BE(0, 0);
  packet.writeUInt16BE(0, 2);
  packet.writeUInt16BE(1, 4);
  packet.writeUInt16BE(0, 6);
  packet.writeUInt16BE(0, 8);
  packet.writeUInt16BE(0, 10);
  questionName.copy(packet, 12);
  const questionOffset = 12 + questionName.length;
  packet.writeUInt16BE(TYPE_PTR, questionOffset);
  packet.writeUInt16BE(CLASS_IN | (useUnicastResponse ? CLASS_QU : 0), questionOffset + 2);
  return packet;
}

function readName(buffer, offset, depth = 0) {
  if (depth > 12) {
    throw new Error('DNS name compression loop detected');
  }

  const labels = [];
  let currentOffset = offset;
  let jumped = false;
  let nextOffset = offset;

  while (currentOffset < buffer.length) {
    const length = buffer[currentOffset];

    if (length === 0) {
      currentOffset += 1;
      if (!jumped) {
        nextOffset = currentOffset;
      }
      break;
    }

    if ((length & 0xc0) === 0xc0) {
      if (currentOffset + 1 >= buffer.length) {
        throw new Error('Truncated DNS compression pointer');
      }
      const pointer = ((length & 0x3f) << 8) | buffer[currentOffset + 1];
      if (!jumped) {
        nextOffset = currentOffset + 2;
      }
      const pointed = readName(buffer, pointer, depth + 1);
      labels.push(...pointed.name.split('.').filter(Boolean));
      jumped = true;
      break;
    }

    if ((length & 0xc0) !== 0) {
      throw new Error(`Unsupported DNS label type: ${length}`);
    }

    const start = currentOffset + 1;
    const end = start + length;
    if (end > buffer.length) {
      throw new Error('Truncated DNS label');
    }
    labels.push(buffer.subarray(start, end).toString('utf8'));
    currentOffset = end;
  }

  return {
    name: labels.join('.'),
    offset: nextOffset,
  };
}

function parseTxt(buffer, offset, length) {
  const end = offset + length;
  const txt = {};
  let currentOffset = offset;

  while (currentOffset < end) {
    const size = buffer[currentOffset];
    currentOffset += 1;
    if (size === 0) continue;

    const itemEnd = Math.min(currentOffset + size, end);
    const raw = buffer.subarray(currentOffset, itemEnd).toString('utf8');
    currentOffset = itemEnd;

    const equalIndex = raw.indexOf('=');
    if (equalIndex >= 0) {
      txt[raw.slice(0, equalIndex)] = raw.slice(equalIndex + 1);
    } else {
      txt[raw] = true;
    }
  }

  return txt;
}

function parseRecord(buffer, offset) {
  const recordName = readName(buffer, offset);
  let currentOffset = recordName.offset;
  if (currentOffset + 10 > buffer.length) {
    throw new Error('Truncated DNS record header');
  }

  const type = buffer.readUInt16BE(currentOffset);
  const klass = buffer.readUInt16BE(currentOffset + 2) & 0x7fff;
  const ttl = buffer.readUInt32BE(currentOffset + 4);
  const dataLength = buffer.readUInt16BE(currentOffset + 8);
  currentOffset += 10;
  const dataOffset = currentOffset;
  const nextOffset = dataOffset + dataLength;
  if (nextOffset > buffer.length) {
    throw new Error('Truncated DNS record data');
  }

  let data = null;
  if (type === TYPE_PTR) {
    data = readName(buffer, dataOffset).name;
  } else if (type === TYPE_SRV) {
    if (dataLength >= 6) {
      const target = readName(buffer, dataOffset + 6).name;
      data = {
        priority: buffer.readUInt16BE(dataOffset),
        weight: buffer.readUInt16BE(dataOffset + 2),
        port: buffer.readUInt16BE(dataOffset + 4),
        target,
      };
    }
  } else if (type === TYPE_TXT) {
    data = parseTxt(buffer, dataOffset, dataLength);
  } else if (type === TYPE_A && dataLength === 4) {
    data = Array.from(buffer.subarray(dataOffset, dataOffset + 4)).join('.');
  } else if (type === TYPE_AAAA && dataLength === 16) {
    const parts = [];
    for (let index = 0; index < 16; index += 2) {
      parts.push(buffer.readUInt16BE(dataOffset + index).toString(16));
    }
    data = parts.join(':');
  }

  return {
    name: recordName.name,
    type,
    klass,
    ttl,
    data,
    offset: nextOffset,
  };
}

function parsePacket(buffer) {
  if (buffer.length < 12) return [];

  const qdcount = buffer.readUInt16BE(4);
  const ancount = buffer.readUInt16BE(6);
  const nscount = buffer.readUInt16BE(8);
  const arcount = buffer.readUInt16BE(10);
  let offset = 12;

  for (let index = 0; index < qdcount; index += 1) {
    const questionName = readName(buffer, offset);
    offset = questionName.offset + 4;
    if (offset > buffer.length) return [];
  }

  const records = [];
  const recordCount = ancount + nscount + arcount;
  for (let index = 0; index < recordCount; index += 1) {
    const record = parseRecord(buffer, offset);
    offset = record.offset;
    records.push(record);
  }

  return records;
}

function getTxtValue(txt, keys, fallback) {
  if (!txt || typeof txt !== 'object') return fallback;
  for (const key of keys) {
    const value = txt[key];
    if (value !== undefined && value !== null && value !== true && String(value).trim()) {
      return String(value).trim();
    }
  }
  return fallback;
}

function selectAddress(addresses, fallbackAddress) {
  const values = Array.from(addresses || []);
  const ipv4 = values.find((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address));
  return ipv4 || values[0] || fallbackAddress || '';
}

function makeTarget(service) {
  const host = selectAddress(service.addresses, service.refererAddress) || stripTrailingDot(service.host);
  if (!host) return null;

  const port = Number(service.port || 65280);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const instanceName = getInstanceName(service.fqdn);
  const displayName = instanceName || service.host || `${host}:${port}`;
  const txt = service.txt || {};
  const uploadPath = getTxtValue(txt, ['upload_path', 'uploadPath', 'path'], '/sketch');
  const username = getTxtValue(txt, ['username', 'user'], 'arduino');
  const password = getTxtValue(txt, ['password', 'pass'], 'password');

  return {
    id: `network-ota-mdns:${host}:${port}:${uploadPath}`,
    name: displayName,
    host,
    port,
    username,
    password,
    uploadPath: uploadPath.startsWith('/') ? uploadPath : `/${uploadPath}`,
    ssl: false,
    timeoutMs: 60000,
    mdnsName: service.fqdn,
    txt,
  };
}

function createDiscoveryState() {
  const services = new Map();
  const hostAddresses = new Map();

  const ensureService = (fqdn) => {
    const key = normalizeName(fqdn);
    if (!services.has(key)) {
      services.set(key, {
        fqdn: stripTrailingDot(fqdn),
        host: '',
        port: 65280,
        addresses: new Set(),
        refererAddress: '',
        txt: {},
      });
    }
    return services.get(key);
  };

  const applyAddress = (host, address) => {
    if (!host || !address) return;
    const key = normalizeName(host);
    if (!hostAddresses.has(key)) {
      hostAddresses.set(key, new Set());
    }
    hostAddresses.get(key).add(address);

    for (const service of services.values()) {
      if (normalizeName(service.host) === key) {
        service.addresses.add(address);
      }
    }
  };

  return {
    applyRecords(records, refererAddress) {
      for (const record of records) {
        if (record.klass !== CLASS_IN || record.ttl === 0) continue;

        if (record.type === TYPE_PTR && normalizeName(record.name) === SERVICE_TYPE && record.data) {
          const service = ensureService(record.data);
          service.refererAddress = service.refererAddress || refererAddress;
        } else if (record.type === TYPE_SRV && isServiceInstance(record.name) && record.data) {
          const service = ensureService(record.name);
          service.host = stripTrailingDot(record.data.target);
          service.port = record.data.port || service.port;
          service.refererAddress = service.refererAddress || refererAddress;

          const addresses = hostAddresses.get(normalizeName(service.host));
          if (addresses) {
            for (const address of addresses) {
              service.addresses.add(address);
            }
          }
        } else if (record.type === TYPE_TXT && isServiceInstance(record.name) && record.data) {
          const service = ensureService(record.name);
          service.txt = { ...service.txt, ...record.data };
          service.refererAddress = service.refererAddress || refererAddress;
        } else if ((record.type === TYPE_A || record.type === TYPE_AAAA) && record.data) {
          applyAddress(record.name, record.data);
        }
      }
    },

    targets() {
      const seen = new Set();
      return Array.from(services.values())
        .map(makeTarget)
        .filter(Boolean)
        .filter((target) => {
          const key = `${target.host}:${target.port}:${target.uploadPath}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((left, right) => {
          const byName = String(left.name || '').localeCompare(String(right.name || ''));
          if (byName !== 0) return byName;
          return String(left.host || '').localeCompare(String(right.host || ''));
        });
    },
  };
}

function parseArgs(argv) {
  const args = {
    timeoutMs: 3500,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout' && argv[index + 1]) {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--timeout=')) {
      args.timeoutMs = Number(arg.slice('--timeout='.length));
    }
  }

  args.timeoutMs = Math.max(1000, Math.min(15000, Number(args.timeoutMs || 3500)));
  return args;
}

async function bindSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const onError = (error) => {
      socket.removeListener('listening', onListening);
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      reject(error);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      resolve(socket);
    };

    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind(port);
  });
}

async function createSocket() {
  try {
    return { socket: await bindSocket(MDNS_PORT), useUnicastResponse: false };
  } catch (error) {
    logError(`Failed to bind mDNS port 5353, falling back to unicast response mode: ${error.message}`);
    return { socket: await bindSocket(0), useUnicastResponse: true };
  }
}

async function discover(timeoutMs) {
  const state = createDiscoveryState();
  const { socket, useUnicastResponse } = await createSocket();

  try {
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(false);
    try {
      socket.addMembership(MDNS_ADDRESS);
    } catch (error) {
      logError(`Failed to join mDNS multicast group: ${error.message}`);
    }

    socket.on('message', (message, referer) => {
      try {
        const records = parsePacket(message);
        state.applyRecords(records, referer.address);
      } catch (error) {
        logError(`Failed to parse mDNS response: ${error.message}`);
      }
    });

    const query = buildQuery(useUnicastResponse);
    const sendQuery = () => {
      socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS, (error) => {
        if (error) {
          logError(`Failed to send mDNS query: ${error.message}`);
        }
      });
    };

    logProgress(`Searching ${SERVICE_TYPE}`);
    sendQuery();
    const interval = setInterval(sendQuery, 900);

    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    clearInterval(interval);
  } finally {
    await new Promise((resolve) => socket.close(resolve));
  }

  return state.targets();
}

async function main() {
  const args = parseArgs(process.argv);
  try {
    const targets = await discover(args.timeoutMs);
    console.log(`[network-ota-mdns:result] ${JSON.stringify(targets)}`);
  } catch (error) {
    logError(error.message || String(error));
    process.exit(1);
  }
}

main();
