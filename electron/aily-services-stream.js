const { ipcMain } = require("electron");

const START_CHANNEL = "aily-services-stream-start";
const CANCEL_CHANNEL = "aily-services-stream-cancel";
const EVENT_CHANNEL_PREFIX = "aily-services-stream-event-";

const activeStreams = new Map();

function safeSend(webContents, streamId, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }
  webContents.send(`${EVENT_CHANNEL_PREFIX}${streamId}`, payload);
}

function headersToRecord(headers) {
  const record = {};
  if (!headers || typeof headers.forEach !== "function") {
    return record;
  }
  headers.forEach((value, key) => {
    record[String(key).toLowerCase()] = String(value);
  });
  return record;
}

function buildErrorMessage(error) {
  if (!error) {
    return "Unknown stream error";
  }
  if (error.name === "AbortError") {
    return "Stream aborted";
  }
  return error.message || String(error);
}

function summarizeHeaders(headers) {
  const record = headersToRecord(headers);
  const interesting = {};
  for (const key of Object.keys(record)) {
    if (
      key.startsWith("x-aily-")
      || key === "retry-after"
      || key === "content-type"
      || key === "content-length"
    ) {
      interesting[key] = record[key];
    }
  }
  return interesting;
}

function parseJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractSseDataPayload(block) {
  const dataLines = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith("data:")) {
      continue;
    }
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return dataLines.join("\n");
}

function parseSseBlocksFromText(state, text, onEvent) {
  state.buffer += text.replace(/\r\n/g, "\n");

  while (true) {
    const boundaryIndex = state.buffer.indexOf("\n\n");
    if (boundaryIndex < 0) {
      break;
    }

    const block = state.buffer.slice(0, boundaryIndex);
    state.buffer = state.buffer.slice(boundaryIndex + 2);
    const data = extractSseDataPayload(block);
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      onEvent(JSON.parse(data));
    } catch (error) {
      onEvent({
        type: "error",
        code: "invalid_sse_payload",
        message: buildErrorMessage(error),
      });
    }
  }
}

async function readSseBody(response, entry) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parserState = { buffer: "" };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    parseSseBlocksFromText(parserState, decoder.decode(value, { stream: true }), event => {
      safeSend(entry.webContents, entry.streamId, { type: "event", event });
    });
  }

  const tail = decoder.decode();
  if (tail) {
    parseSseBlocksFromText(parserState, tail, event => {
      safeSend(entry.webContents, entry.streamId, { type: "event", event });
    });
  }

  const remaining = parserState.buffer.trim();
  if (remaining) {
    const data = extractSseDataPayload(remaining);
    if (data && data !== "[DONE]") {
      try {
        safeSend(entry.webContents, entry.streamId, { type: "event", event: JSON.parse(data) });
      } catch (error) {
        safeSend(entry.webContents, entry.streamId, {
          type: "event",
          event: {
            type: "error",
            code: "invalid_sse_payload",
            message: buildErrorMessage(error),
          },
        });
      }
    }
  }
}

async function runStream(entry, request) {
  try {
    if (typeof fetch !== "function") {
      throw new Error("Electron main process fetch is not available");
    }

    const response = await fetch(request.url, {
      method: request.method || "POST",
      headers: request.headers || {},
      body: request.body,
      signal: entry.controller.signal,
    });

    safeSend(entry.webContents, entry.streamId, {
      type: "headers",
      ok: response.ok,
      status: response.status,
      headers: headersToRecord(response.headers),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const bodyJson = parseJsonObject(bodyText);
      console.warn("[AilyServicesStream] non-ok response", {
        streamId: entry.streamId,
        requestId: entry.requestId,
        status: response.status,
        headers: summarizeHeaders(response.headers),
        error: typeof bodyJson?.error === "string" ? bodyJson.error : undefined,
        message: typeof bodyJson?.message === "string" ? bodyJson.message : undefined,
        quotaKind: typeof bodyJson?.quotaKind === "string" ? bodyJson.quotaKind : undefined,
        quotaResetBucket: typeof bodyJson?.quotaResetBucket === "string" ? bodyJson.quotaResetBucket : undefined,
        quotaSnapshot: bodyJson?.quota_snapshot && typeof bodyJson.quota_snapshot === "object"
          ? bodyJson.quota_snapshot
          : undefined,
        quotaDiagnostics: bodyJson?.quotaDiagnostics && typeof bodyJson.quotaDiagnostics === "object"
          ? bodyJson.quotaDiagnostics
          : undefined,
        bodyPreview: bodyText.slice(0, 4096),
      });
      safeSend(entry.webContents, entry.streamId, {
        type: "error",
        status: response.status,
        bodyText,
        message: bodyText || `aily-services error ${response.status}`,
      });
      return;
    }

    if (!response.body) {
      throw new Error("aily-services returned no response body");
    }

    await readSseBody(response, entry);
  } catch (error) {
    if (entry.controller.signal.aborted) {
      safeSend(entry.webContents, entry.streamId, {
        type: "cancelled",
        message: "Stream cancelled",
      });
      return;
    }
    safeSend(entry.webContents, entry.streamId, {
      type: "error",
      message: buildErrorMessage(error),
      code: error && error.code ? String(error.code) : undefined,
    });
  } finally {
    activeStreams.delete(entry.streamId);
    safeSend(entry.webContents, entry.streamId, { type: "done" });
  }
}

function normalizeStreamId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : `aily_stream_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function registerAilyServicesStreamHandlers() {
  ipcMain.removeHandler(START_CHANNEL);
  ipcMain.removeHandler(CANCEL_CHANNEL);

  ipcMain.handle(START_CHANNEL, (event, request = {}) => {
    const streamId = normalizeStreamId(request.streamId);
    const previous = activeStreams.get(streamId);
    if (previous) {
      previous.controller.abort();
      activeStreams.delete(streamId);
    }

    const entry = {
      streamId,
      webContents: event.sender,
      controller: new AbortController(),
      startedAt: Date.now(),
      requestId: request.requestId,
    };
    activeStreams.set(streamId, entry);

    event.sender.once("destroyed", () => {
      const current = activeStreams.get(streamId);
      if (current) {
        current.controller.abort();
        activeStreams.delete(streamId);
      }
    });

    void runStream(entry, request);
    return { ok: true, streamId };
  });

  ipcMain.handle(CANCEL_CHANNEL, (_event, payload = {}) => {
    const streamId = normalizeStreamId(payload.streamId);
    const entry = activeStreams.get(streamId);
    if (!entry) {
      return { ok: false };
    }
    entry.controller.abort();
    activeStreams.delete(streamId);
    return { ok: true };
  });
}

function cancelAllAilyServicesStreams() {
  for (const entry of activeStreams.values()) {
    entry.controller.abort();
  }
  activeStreams.clear();
  return Promise.resolve();
}

function getActiveAilyServicesStreams() {
  return Array.from(activeStreams.values()).map(entry => ({
    streamId: entry.streamId,
    requestId: entry.requestId,
    durationMs: Date.now() - entry.startedAt,
  }));
}

module.exports = {
  registerAilyServicesStreamHandlers,
  cancelAllAilyServicesStreams,
  getActiveAilyServicesStreams,
};
