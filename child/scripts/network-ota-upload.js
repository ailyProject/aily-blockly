const fs = require('fs');
const http = require('http');
const https = require('https');

function logProgress(progress, text) {
  const value = Math.max(0, Math.min(100, Math.floor(progress || 0)));
  console.log(`[network-ota:progress] ${value} ${text || ''}`.trim());
}

function fail(message) {
  console.error(`[network-ota:error] ${message}`);
  process.exit(1);
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || '/sketch').trim() || '/sketch';
  return value.startsWith('/') ? value : `/${value}`;
}

function encodePathSegment(value) {
  return String(value || '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function buildRequestOptions(config, firmwareSize) {
  const host = String(config.host || '').trim();
  if (!host) {
    fail('WiFi OTA target address is empty');
  }

  const port = Number(config.port || 65280);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`Invalid WiFi OTA port: ${config.port}`);
  }

  const endpoint = normalizeEndpoint(config.uploadPath);
  const path = endpoint
    .split('/')
    .map((part, index) => (index === 0 ? '' : encodePathSegment(part)))
    .join('/');

  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': firmwareSize,
  };

  const username = String(config.username || '');
  const password = String(config.password || '');
  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  return {
    protocol: config.ssl ? 'https:' : 'http:',
    hostname: host,
    port,
    path,
    method: 'POST',
    headers,
  };
}

async function upload(config) {
  const firmwarePath = String(config.firmwarePath || '').trim();
  if (!firmwarePath || !fs.existsSync(firmwarePath)) {
    fail(`Firmware file not found: ${firmwarePath || '(empty)'}`);
  }

  const firmware = fs.readFileSync(firmwarePath);
  if (firmware.length === 0) {
    fail('Firmware file is empty');
  }

  const timeoutMs = Math.max(1000, Number(config.timeoutMs || 60000));
  const options = buildRequestOptions(config, firmware.length);
  const transport = options.protocol === 'https:' ? https : http;
  const targetUrl = `${options.protocol}//${options.hostname}:${options.port}${options.path}`;

  console.log(`WiFi OTA target: ${targetUrl}`);
  console.log(`Firmware: ${firmwarePath}`);
  console.log(`Firmware size: ${firmware.length} bytes`);
  logProgress(3, 'Preparing firmware');
  logProgress(8, 'Connecting to board');

  await new Promise((resolve, reject) => {
    let settled = false;
    let sentBytes = 0;

    const request = transport.request(options, (response) => {
      logProgress(90, 'Flashing firmware');
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').trim();
        if (body) {
          console.log(body);
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${body || response.statusMessage || 'WiFi OTA failed'}`));
          return;
        }

        logProgress(100, 'Upload completed');
        console.log('[network-ota:done]');
        resolve();
      });
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`WiFi OTA timed out after ${Math.round(timeoutMs / 1000)}s`));
    });

    request.on('socket', (socket) => {
      socket.on('connect', () => {
        console.log('Connected to WiFi OTA target');
      });
      socket.on('secureConnect', () => {
        console.log('Connected to WiFi OTA target');
      });
    });

    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    const chunkSize = 16 * 1024;
    const writeNextChunk = () => {
      if (sentBytes >= firmware.length) {
        request.end();
        return;
      }

      const end = Math.min(sentBytes + chunkSize, firmware.length);
      const chunk = firmware.subarray(sentBytes, end);
      sentBytes = end;
      const progress = 10 + (sentBytes / firmware.length) * 75;
      logProgress(progress, `Uploading ${Math.floor((sentBytes / firmware.length) * 100)}%`);

      if (request.write(chunk)) {
        setImmediate(writeNextChunk);
      } else {
        request.once('drain', writeNextChunk);
      }
    };

    writeNextChunk();
  });
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    fail('Usage: node network-ota-upload.js <config-path>');
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`Failed to read config: ${error.message}`);
  }

  try {
    await upload(config);
  } catch (error) {
    fail(error.message || String(error));
  }
}

main();
