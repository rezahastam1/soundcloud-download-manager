const activeBuilds = new Map();
const lastProgressAt = new Map();
const encoder = new TextEncoder();

function resolveUrl(base, line) {
  if (/^https?:\/\//i.test(line)) return line;
  return new URL(line, base).toString();
}

function sendProgress(buildId, percent, stage, extra = {}, force = false) {
  const now = Date.now();
  const last = lastProgressAt.get(buildId) || 0;
  if (!force && now - last < 120) return;
  lastProgressAt.set(buildId, now);
  try {
    chrome.runtime.sendMessage({
      type: "OFFSCREEN_PROGRESS",
      buildId,
      percent: Math.max(0, Math.min(100, Number(percent) || 0)),
      stage,
      ...extra,
    }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

async function fetchText(url, signal) {
  const r = await fetch(url, { signal, redirect: "follow", cache: "no-store" });
  if (!r.ok) throw new Error(`HLS playlist HTTP ${r.status}`);
  return r.text();
}

async function fetchBuffer(url, signal) {
  const r = await fetch(url, { signal, redirect: "follow", cache: "no-store" });
  if (!r.ok) throw new Error(`HLS segment HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function parsePlaylist(baseUrl, text) {
  if (/#EXT-X-KEY:/i.test(text)) {
    throw new Error("HLS رمزگذاری‌شده است و پردازش نمی‌شود.");
  }

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let init = null;
  const urls = [];

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const m = line.match(/URI="([^"]+)"/i);
      if (m?.[1]) init = resolveUrl(baseUrl, m[1]);
      continue;
    }
    if (!line.startsWith("#")) urls.push(resolveUrl(baseUrl, line));
  }
  return { init, urls };
}

async function mediaPlaylist(url, signal, depth = 0) {
  if (depth > 4) throw new Error("HLS playlist nesting too deep.");
  const text = await fetchText(url, signal);
  if (text.includes("#EXT-X-STREAM-INF")) {
    const parsed = parsePlaylist(url, text);
    if (!parsed.urls.length) throw new Error("HLS master playlist empty.");
    return mediaPlaylist(parsed.urls[0], signal, depth + 1);
  }
  return { url, text };
}

async function fetchConcurrent(urls, signal, buildId, concurrency = 4) {
  const chunks = new Array(urls.length);
  let next = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (next < urls.length) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const i = next++;
      const chunk = await fetchBuffer(urls[i], signal);
      chunks[i] = chunk;
      bytes += chunk.byteLength;
      done += 1;
      const percent = 10 + (done / Math.max(1, urls.length)) * 84;
      sendProgress(buildId, percent, "fetching-hls", {
        loaded: bytes,
        total: 0,
        partsDone: done,
        partsTotal: urls.length,
      });
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, urls.length)) },
    () => worker()
  );
  await Promise.all(workers);
  return { chunks, bytes };
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}


function syncSafe32(value) {
  const n = Math.max(0, Number(value) || 0);
  return new Uint8Array([
    (n >> 21) & 0x7f,
    (n >> 14) & 0x7f,
    (n >> 7) & 0x7f,
    n & 0x7f,
  ]);
}

function ascii4(id) {
  return new Uint8Array([...id].slice(0, 4).map(c => c.charCodeAt(0)));
}

function frame(id, payload) {
  if (!payload?.byteLength) return new Uint8Array();
  return concat([
    ascii4(id),
    syncSafe32(payload.byteLength),
    new Uint8Array([0, 0]),
    payload,
  ]);
}

function utf8(value, max = 8192) {
  const text = String(value ?? "").replace(/\u0000/g, "").slice(0, max);
  return encoder.encode(text);
}

function textFrame(id, value) {
  if (value === null || value === undefined || String(value).trim() === "") return new Uint8Array();
  return frame(id, concat([new Uint8Array([3]), utf8(value)]));
}

function commentFrame(value) {
  if (!value) return new Uint8Array();
  return frame("COMM", concat([
    new Uint8Array([3]), encoder.encode("eng"), new Uint8Array([0]), utf8(value, 5000),
  ]));
}

function userTextFrame(description, value) {
  if (!value) return new Uint8Array();
  return frame("TXXX", concat([
    new Uint8Array([3]), utf8(description, 120), new Uint8Array([0]), utf8(value, 3000),
  ]));
}

function webFrame(id, value) {
  if (!value) return new Uint8Array();
  return frame(id, utf8(value, 4000));
}

async function artworkFrame(url, signal) {
  if (!url || !/^https?:\/\//i.test(url)) return new Uint8Array();
  try {
    const r = await fetch(url, { signal, redirect: "follow", cache: "no-store" });
    if (!r.ok) return new Uint8Array();
    const mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!/^image\//i.test(mime)) return new Uint8Array();
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) return new Uint8Array();
    return frame("APIC", concat([
      new Uint8Array([3]), utf8(mime, 80), new Uint8Array([0]), new Uint8Array([3]), new Uint8Array([0]), bytes,
    ]));
  } catch (_) {
    return new Uint8Array();
  }
}

function stripLeadingId3(bytes) {
  if (bytes?.byteLength >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const footer = (bytes[5] & 0x10) ? 10 : 0;
    return bytes.slice(Math.min(bytes.byteLength, 10 + size + footer));
  }
  return bytes;
}

async function addMp3Metadata(bytes, metadata = {}, signal) {
  if (!String(metadata.title || "").trim()) return bytes;
  const frames = [
    textFrame("TIT2", metadata.title),
    textFrame("TPE1", metadata.artist),
    textFrame("TALB", metadata.album),
    textFrame("TCON", metadata.genre),
    textFrame("TDRC", metadata.releaseDate),
    textFrame("TRCK", metadata.trackNumber),
    textFrame("TSRC", metadata.isrc),
    textFrame("TCOP", metadata.copyright),
    textFrame("TENC", "SoundCloud Pro Download Manager v3.0.1"),
    commentFrame(metadata.description),
    webFrame("WOAS", metadata.url),
    userTextFrame("SoundCloud URL", metadata.url),
    userTextFrame("SoundCloud Track ID", metadata.trackId),
    userTextFrame("Publisher", metadata.publisher),
  ].filter(x => x.byteLength);

  const art = await artworkFrame(metadata.artworkUrl, signal);
  if (art.byteLength) frames.push(art);
  const body = concat(frames);
  const header = concat([encoder.encode("ID3"), new Uint8Array([4, 0, 0]), syncSafe32(body.byteLength)]);
  return concat([header, body, stripLeadingId3(bytes)]);
}

async function maybeTag(bytes, extension, metadata, signal, buildId) {
  if (String(extension || "").toLowerCase() !== "mp3") return { bytes, tagged: false };
  sendProgress(buildId, 95, "tagging", { loaded: bytes.byteLength, total: bytes.byteLength }, true);
  const tagged = await addMp3Metadata(bytes, metadata, signal);
  return { bytes: tagged, tagged: true };
}

async function buildDirect(message) {
  const controller = new AbortController();
  activeBuilds.set(message.buildId, controller);
  sendProgress(message.buildId, 10, "fetching", {}, true);

  try {
    const r = await fetch(message.streamUrl, {
      signal: controller.signal,
      redirect: "follow",
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Direct audio HTTP ${r.status}`);

    const totalHeader = Number(r.headers.get("content-length"));
    const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;
    const mimeType = message.mimeType || r.headers.get("content-type") || "application/octet-stream";

    if (!r.body?.getReader) {
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.byteLength < 1024) throw new Error("فایل دریافت‌شده خالی یا بسیار کوچک است.");
      sendProgress(message.buildId, 94, "verifying", { loaded: bytes.byteLength, total: total || bytes.byteLength }, true);
      const tagged = await maybeTag(bytes, message.extension, message.metadata || {}, controller.signal, message.buildId);
      const blob = new Blob([tagged.bytes], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      return { ok: true, blobUrl, bytes: tagged.bytes.byteLength, total: total || bytes.byteLength, mimeType, tagged: tagged.tagged };
    }

    const reader = r.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(value);
      loaded += value.byteLength;

      let percent;
      if (total > 0) {
        percent = 10 + Math.min(1, loaded / total) * 84;
      } else {
        // Unknown Content-Length: progress remains meaningful as a loading state,
        // then jumps to verified completion once EOF is reached.
        percent = Math.min(88, 10 + Math.log2(1 + loaded / 65536) * 8);
      }
      sendProgress(message.buildId, percent, "fetching", { loaded, total });
    }

    if (loaded < 1024) throw new Error("فایل دریافت‌شده خالی یا بسیار کوچک است.");

    sendProgress(message.buildId, 94, "verifying", { loaded, total: total || loaded }, true);
    const rawBytes = concat(chunks.map(c => c instanceof Uint8Array ? c : new Uint8Array(c)));
    const tagged = await maybeTag(rawBytes, message.extension, message.metadata || {}, controller.signal, message.buildId);
    const blob = new Blob([tagged.bytes], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    return { ok: true, blobUrl, bytes: tagged.bytes.byteLength, total: total || loaded, mimeType, tagged: tagged.tagged };
  } finally {
    activeBuilds.delete(message.buildId);
    lastProgressAt.delete(message.buildId);
  }
}

async function buildHls(message) {
  const controller = new AbortController();
  activeBuilds.set(message.buildId, controller);
  sendProgress(message.buildId, 8, "parsing-hls", {}, true);

  try {
    const media = await mediaPlaylist(message.streamUrl, controller.signal);
    const parsed = parsePlaylist(media.url, media.text);
    if (!parsed.urls.length) throw new Error("هیچ Segment صوتی در HLS پیدا نشد.");

    const urls = parsed.init ? [parsed.init, ...parsed.urls] : parsed.urls;
    sendProgress(message.buildId, 10, "fetching-hls", {
      partsDone: 0,
      partsTotal: urls.length,
    }, true);

    const result = await fetchConcurrent(urls, controller.signal, message.buildId, 4);
    sendProgress(message.buildId, 95, "assembling", {
      loaded: result.bytes,
      partsDone: urls.length,
      partsTotal: urls.length,
    }, true);

    const bytes = concat(result.chunks);
    if (bytes.byteLength < 1024) throw new Error("فایل صوتی HLS خالی یا بسیار کوچک است.");
    const tagged = await maybeTag(bytes, message.extension, message.metadata || {}, controller.signal, message.buildId);

    const blob = new Blob([tagged.bytes], {
      type: message.mimeType || "application/octet-stream",
    });
    const blobUrl = URL.createObjectURL(blob);

    return {
      ok: true,
      blobUrl,
      parts: urls.length,
      bytes: tagged.bytes.byteLength,
      tagged: tagged.tagged,
    };
  } finally {
    activeBuilds.delete(message.buildId);
    lastProgressAt.delete(message.buildId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_BUILD_DIRECT") {
    buildDirect(message)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OFFSCREEN_BUILD_HLS") {
    buildHls(message)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OFFSCREEN_REVOKE") {
    try {
      if (message.blobUrl) URL.revokeObjectURL(message.blobUrl);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  }

  if (message?.type === "OFFSCREEN_ABORT") {
    activeBuilds.get(message.buildId)?.abort();
    activeBuilds.delete(message.buildId);
    lastProgressAt.delete(message.buildId);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
