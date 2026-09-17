const VERSION = "3.0.1";

const state = {
  clientId: null,
  appVersion: null,
  oauthToken: null,
  oauthTokenAt: 0,
  clientIdAt: 0,
  lastApiAt: 0,
};

const API_GAP_MS = 780;
const CLIENT_ID_TTL = 6 * 60 * 60 * 1000;
const OAUTH_TTL = 5 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, url) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizePart(value, fallback = "Unknown") {
  let s = String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!s) s = fallback;
  return s.slice(0, 120);
}

function sanitizeFilename(value, fallback = "SoundCloud track") {
  return sanitizePart(value, fallback).slice(0, 170);
}

function normalizeSoundCloudUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
    throw new Error("لینک SoundCloud معتبر نیست.");
  }
  url.hash = "";
  return url.toString();
}

function mergeCredentials(creds = {}) {
  if (creds.clientId && /^[A-Za-z0-9_-]{20,80}$/.test(creds.clientId)) {
    state.clientId = creds.clientId;
    state.clientIdAt = Date.now();
  }
  if (creds.appVersion && /^\d{8,20}$/.test(String(creds.appVersion))) {
    state.appVersion = String(creds.appVersion);
  }
  if (creds.oauthToken && String(creds.oauthToken).length > 12) {
    state.oauthToken = String(creds.oauthToken);
    state.oauthTokenAt = Date.now();
  }
}

async function loadOAuthCookie(force = false) {
  if (!force && state.oauthToken && Date.now() - state.oauthTokenAt < OAUTH_TTL) {
    return state.oauthToken;
  }
  try {
    const cookie = await chrome.cookies.get({
      url: "https://soundcloud.com/",
      name: "oauth_token",
    });
    if (cookie?.value && cookie.value.length > 12) {
      state.oauthToken = cookie.value;
      state.oauthTokenAt = Date.now();
      return state.oauthToken;
    }
  } catch (error) {
    console.warn("[SoundCloud Download Manager] oauth cookie read failed", error);
  }
  if (force) {
    state.oauthToken = null;
    state.oauthTokenAt = 0;
  }
  return state.oauthToken;
}

function findClientId(text) {
  if (!text) return null;
  const patterns = [
    /client_id["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,80})["']/g,
    /client_id=([A-Za-z0-9_-]{20,80})/g,
    /clientId["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,80})["']/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

function findAppVersion(text) {
  if (!text) return null;
  const patterns = [
    /window\.__sc_version\s*=\s*["']?(\d{8,20})/i,
    /app_version["']?\s*[:=]\s*["']?(\d{8,20})/i,
    /appVersion["']?\s*[:=]\s*["']?(\d{8,20})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function rawFetchText(url, options = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    credentials: "omit",
    ...options,
  });
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status}`, url);
  }
  return response.text();
}

async function discoverWebCredentials(force = false) {
  if (!force && state.clientId && Date.now() - state.clientIdAt < CLIENT_ID_TTL) {
    return { clientId: state.clientId, appVersion: state.appVersion };
  }

  let html = "";
  try {
    html = await rawFetchText("https://soundcloud.com/");
  } catch (_) {
    if (state.clientId) return { clientId: state.clientId, appVersion: state.appVersion };
    throw new Error("client_id در دسترس نیست. صفحه SoundCloud را Refresh کنید و دوباره امتحان کنید.");
  }

  let clientId = findClientId(html);
  const appVersion = findAppVersion(html) || state.appVersion;

  if (!clientId) {
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi)]
      .map(m => m[1])
      .filter(Boolean)
      .map(src => src.startsWith("//") ? `https:${src}` :
                  src.startsWith("/") ? `https://soundcloud.com${src}` : src);

    for (const src of scripts.slice(-20).reverse()) {
      try {
        const js = await rawFetchText(src);
        clientId = findClientId(js);
        if (clientId) {
          state.appVersion = findAppVersion(js) || appVersion || state.appVersion;
          break;
        }
      } catch (_) {}
    }
  }

  if (!clientId) {
    throw new Error("client_id ساوندکلاد پیدا نشد. صفحه را Refresh کنید.");
  }

  state.clientId = clientId;
  state.clientIdAt = Date.now();
  state.appVersion = appVersion || state.appVersion;
  return { clientId: state.clientId, appVersion: state.appVersion };
}

async function ensureCredentials(creds = {}) {
  mergeCredentials(creds);
  if (!state.clientId || Date.now() - state.clientIdAt >= CLIENT_ID_TTL) {
    await discoverWebCredentials(false);
  }
  // Read the logged-in SoundCloud OAuth cookie directly through the extension API.
  // This also works if the cookie is HttpOnly and therefore invisible to document.cookie.
  await loadOAuthCookie(false);
  return {
    clientId: state.clientId,
    appVersion: state.appVersion,
    oauthToken: state.oauthToken,
  };
}

async function apiRateLimit() {
  const elapsed = Date.now() - state.lastApiAt;
  if (elapsed < API_GAP_MS) {
    await sleep(API_GAP_MS - elapsed);
  }
  state.lastApiAt = Date.now();
}

function addCommonParams(url, creds) {
  const u = new URL(url);
  if (!u.searchParams.has("client_id") && creds.clientId) {
    u.searchParams.set("client_id", creds.clientId);
  }
  if (!u.searchParams.has("app_version") && creds.appVersion) {
    u.searchParams.set("app_version", creds.appVersion);
  }
  if (!u.searchParams.has("app_locale")) {
    u.searchParams.set("app_locale", "en");
  }
  return u;
}

async function apiJson(url, options = {}) {
  const {
    credentials = {},
    allowRefresh = true,
    retry429 = 2,
    addParams = true,
  } = options;

  let creds = await ensureCredentials(credentials);
  let target = addParams ? addCommonParams(url, creds) : new URL(url);

  await apiRateLimit();

  const headers = {
    "Accept": "application/json, text/plain, */*",
  };
  if (creds.oauthToken) {
    headers.Authorization = `OAuth ${creds.oauthToken}`;
  }

  const response = await fetch(target.toString(), {
    method: "GET",
    redirect: "follow",
    credentials: "omit",
    headers,
  });

  if (response.status === 429 && retry429 > 0) {
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 6000) : 1800);
    return apiJson(url, {
      credentials,
      allowRefresh,
      retry429: retry429 - 1,
      addParams,
    });
  }

  if ((response.status === 401 || response.status === 403) && allowRefresh) {
    state.clientId = null;
    state.clientIdAt = 0;
    await Promise.all([
      discoverWebCredentials(true),
      loadOAuthCookie(true),
    ]);
    return apiJson(url, {
      credentials: {
        ...credentials,
        clientId: state.clientId,
        appVersion: state.appVersion,
        oauthToken: state.oauthToken,
      },
      allowRefresh: false,
      retry429,
      addParams,
    });
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      detail = body.slice(0, 180);
    } catch (_) {}
    throw new HttpError(
      response.status,
      `API ${response.status}${detail ? ` — ${detail}` : ""}`,
      target.toString()
    );
  }

  return response.json();
}

function parseHydration(html) {
  const patterns = [
    /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\])\s*;\s*<\/script>/i,
    /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\])\s*;/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try { return JSON.parse(m[1]); } catch (_) {}
  }
  return null;
}

function findResourceInHydration(hydration) {
  if (!Array.isArray(hydration)) return null;
  for (const item of hydration) {
    if (item?.data?.kind) return item.data;
  }
  return null;
}

async function resolveResource(resourceUrl, credentials = {}) {
  const url = normalizeSoundCloudUrl(resourceUrl);
  const endpoint = new URL("https://api-v2.soundcloud.com/resolve");
  endpoint.searchParams.set("url", url);

  try {
    return await apiJson(endpoint.toString(), { credentials });
  } catch (apiError) {
    // Last-resort page hydration fallback. SoundCloud may block direct page fetches,
    // so this is intentionally secondary to api-v2.
    try {
      const html = await rawFetchText(url, { credentials: "omit" });
      const resource = findResourceInHydration(parseHydration(html));
      if (resource) return resource;
    } catch (_) {}
    throw apiError;
  }
}

async function fetchFreshTrack(track, credentials = {}) {
  if (!track?.id) return track;
  try {
    const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${track.id}`);
    const fresh = await apiJson(endpoint.toString(), { credentials });
    if (fresh?.id) {
      return { ...track, ...fresh };
    }
  } catch (error) {
    console.warn("[SoundCloud Download Manager] fresh track fetch failed", error);
  }
  return track;
}

async function tryOriginalDownload(track, credentials = {}) {
  if (!track?.id || !track?.downloadable || track?.has_downloads_left === false) return null;
  try {
    const endpoint = new URL(`https://api-v2.soundcloud.com/tracks/${track.id}/download`);
    const data = await apiJson(endpoint.toString(), { credentials });
    const url = data?.redirectUri || data?.redirect_uri || data?.url || null;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    return {
      url,
      extension: sanitizePart(track.original_format || "mp3", "mp3").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp3",
      protocol: "original",
    };
  } catch (error) {
    // The original download endpoint is optional; silently fall back to streaming.
    console.info("[SoundCloud Download Manager] original download unavailable", error?.status || error?.message);
    return null;
  }
}

function absolutePermalink(track) {
  if (track?.permalink_url?.startsWith("http")) return track.permalink_url;
  if (track?.permalink_url?.startsWith("/")) return `https://soundcloud.com${track.permalink_url}`;
  if (track?.user?.permalink && track?.permalink) {
    return `https://soundcloud.com/${track.user.permalink}/${track.permalink}`;
  }
  return null;
}

function lightTrack(track, index = 0) {
  return {
    id: track?.id ?? null,
    title: track?.title || "Untitled",
    artist: track?.user?.username || track?.publisher_metadata?.artist || "Unknown",
    url: absolutePermalink(track),
    duration: track?.duration || 0,
    index,
  };
}

function isTrackObject(track) {
  return Boolean(track && (track.kind === "track" || track.title) && (track.id || absolutePermalink(track)));
}

async function expandTrackIds(ids, credentials = {}) {
  const result = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).filter(Boolean);
    if (!chunk.length) continue;
    const endpoint = new URL("https://api-v2.soundcloud.com/tracks");
    endpoint.searchParams.set("ids", chunk.join(","));
    const data = await apiJson(endpoint.toString(), { credentials });
    if (Array.isArray(data)) result.push(...data);
    else if (Array.isArray(data?.collection)) result.push(...data.collection);
  }
  return result;
}

async function collectionTracksFromResource(resource, credentials = {}) {
  if (!Array.isArray(resource?.tracks)) return [];

  let tracks = resource.tracks.filter(isTrackObject);
  const incompleteIds = resource.tracks
    .filter(t => t?.id && !absolutePermalink(t))
    .map(t => t.id);

  if (incompleteIds.length) {
    try {
      const expanded = await expandTrackIds(incompleteIds, credentials);
      const byId = new Map(expanded.map(t => [String(t.id), t]));
      tracks = resource.tracks
        .map(t => byId.get(String(t.id)) || t)
        .filter(isTrackObject);
    } catch (_) {}
  }

  return tracks
    .map((t, i) => lightTrack(t, i + 1))
    .filter(t => Boolean(t.url));
}

async function getUserTracks(userUrl, credentials = {}) {
  const profileUrl = normalizeSoundCloudUrl(userUrl);
  const parts = new URL(profileUrl).pathname.split("/").filter(Boolean);
  const base = `https://soundcloud.com/${parts[0]}`;

  const user = await resolveResource(base, credentials);
  if (!user?.id || user.kind !== "user") {
    throw new Error("پروفایل کاربر شناسایی نشد.");
  }

  const tracks = [];
  let next = new URL(`https://api-v2.soundcloud.com/users/${user.id}/tracks`);
  next.searchParams.set("limit", "100");
  next.searchParams.set("linked_partitioning", "1");

  let pages = 0;
  while (next && pages < 30 && tracks.length < 2000) {
    const data = await apiJson(next.toString(), { credentials });
    const collection = Array.isArray(data) ? data : (data?.collection || []);
    tracks.push(...collection.filter(isTrackObject));

    if (data?.next_href) {
      next = new URL(data.next_href);
    } else {
      next = null;
    }
    pages += 1;
  }

  return {
    title: user.username || parts[0],
    tracks: tracks
      .map((t, i) => lightTrack(t, i + 1))
      .filter(t => Boolean(t.url)),
  };
}

async function getCollectionTracks(pageUrl, credentials = {}) {
  const url = normalizeSoundCloudUrl(pageUrl);
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean);

  // User root or /tracks page: fetch all uploaded tracks with pagination.
  if (
    parts.length === 1 ||
    (parts.length === 2 && ["tracks", "popular-tracks"].includes(parts[1]))
  ) {
    if (!["discover", "stream", "you", "search", "charts"].includes(parts[0])) {
      try {
        const result = await getUserTracks(url, credentials);
        return {
          ok: true,
          source: "user-api",
          title: result.title,
          tracks: result.tracks,
        };
      } catch (error) {
        return {
          ok: false,
          fallbackDom: true,
          error: error.message,
          source: "user-api",
        };
      }
    }
  }

  // Normal playlists and some Discover/system playlists can resolve directly.
  try {
    const resource = await resolveResource(url, credentials);

    if (resource?.kind === "track") {
      return {
        ok: true,
        source: "resolve",
        title: resource.title || "Track",
        tracks: [lightTrack(resource, 1)].filter(t => t.url),
      };
    }

    if (Array.isArray(resource?.tracks)) {
      const tracks = await collectionTracksFromResource(resource, credentials);
      if (tracks.length) {
        return {
          ok: true,
          source: "playlist-api",
          title: resource.title || resource.name || "Playlist",
          tracks,
        };
      }
    }
  } catch (error) {
    // Discover/system URLs may intentionally fail resolve. DOM fallback handles those.
    return {
      ok: false,
      fallbackDom: true,
      error: error.message,
      source: "resolve",
    };
  }

  return {
    ok: false,
    fallbackDom: true,
    error: "این صفحه از API به‌عنوان Playlist شناسایی نشد.",
    source: "dom",
  };
}

function isEncryptedTranscoding(t) {
  const protocol = String(t?.format?.protocol || "").toLowerCase();
  const preset = String(t?.preset || "").toLowerCase();
  return protocol.includes("encrypted") ||
    protocol.startsWith("cbc") ||
    protocol.startsWith("ctr") ||
    preset.includes("encrypted");
}

function transcodingCandidates(track) {
  const all = (track?.media?.transcodings || []).filter(t => !t?.snipped && t?.url);
  const safe = all.filter(t => !isEncryptedTranscoding(t));

  const score = t => {
    const protocol = String(t?.format?.protocol || "").toLowerCase();
    const mime = String(t?.format?.mime_type || "").toLowerCase();
    const preset = String(t?.preset || "").toLowerCase();
    const quality = String(t?.quality || "").toLowerCase();

    // Avoid premium/high-quality candidates first on free accounts because
    // SoundCloud often intentionally returns 404 for them.
    const premiumPenalty = quality === "hq" || /abr_sq|aac_160|opus_0_0/i.test(preset) ? 10 : 0;
    if (protocol === "progressive" && (mime.includes("audio/mpeg") || preset.startsWith("mp3"))) return 0 + premiumPenalty;
    if (protocol === "hls" && (mime.includes("audio/mpeg") || preset.startsWith("mp3"))) return 1 + premiumPenalty;
    if (protocol === "hls" && (preset.startsWith("aac") || mime.includes("audio/mp4"))) return 3 + premiumPenalty;
    if (protocol === "progressive") return 5 + premiumPenalty;
    if (protocol === "hls") return 6 + premiumPenalty;
    return 50 + premiumPenalty;
  };

  // SoundCloud can expose the same preset twice. Do not hit the same resolver twice.
  const seen = new Set();
  return safe
    .sort((a, b) => score(a) - score(b))
    .filter(t => {
      const key = `${t.url}|${t?.format?.protocol || ""}|${t?.preset || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function extensionForTranscoding(t) {
  const mime = String(t?.format?.mime_type || "").toLowerCase();
  const preset = String(t?.preset || "").toLowerCase();

  if (mime.includes("audio/mpeg") || preset.startsWith("mp3")) return "mp3";
  if (mime.includes("audio/mp4") || preset.startsWith("aac")) return "m4a";
  if (mime.includes("opus") || preset.includes("opus")) return "ogg";
  return "mp3";
}

function mimeForTranscoding(t) {
  const mime = String(t?.format?.mime_type || "").toLowerCase();
  if (mime.includes("audio/mpeg")) return "audio/mpeg";
  if (mime.includes("audio/mp4")) return "audio/mp4";
  if (mime.includes("opus")) return "audio/ogg";
  return "application/octet-stream";
}

async function resolveTrackForDownload(trackUrl, credentials = {}) {
  const resource = await resolveResource(trackUrl, credentials);
  if (resource?.kind !== "track" && !Array.isArray(resource?.media?.transcodings)) {
    throw new Error("لینک به Track قابل دانلود تبدیل نشد.");
  }
  // Get a fresh track object so track_authorization and transcoding URLs are current.
  return fetchFreshTrack(resource, credentials);
}

async function resolveStream(track, transcoding, credentials = {}) {
  const creds = await ensureCredentials(credentials);
  const endpoint = new URL(transcoding.url);

  if (!endpoint.searchParams.has("client_id") && creds.clientId) {
    endpoint.searchParams.set("client_id", creds.clientId);
  }

  const trackAuth =
    track?.track_authorization ||
    track?.track_authorisation ||
    track?.track_auth ||
    null;

  if (trackAuth && !endpoint.searchParams.has("track_authorization")) {
    endpoint.searchParams.set("track_authorization", trackAuth);
  }

  const data = await apiJson(endpoint.toString(), {
    credentials,
    addParams: false,
  });

  if (!data?.url) {
    throw new Error("Stream URL دریافت نشد.");
  }
  return data.url;
}


function chromeDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, id => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(id);
    });
  });
}

// Chrome can derive a UUID filename from blob: URLs before/around the download call.
// Keep an explicit filename reservation and override that derived name during
// onDeterminingFilename. This is intentionally limited to downloads created by
// this extension, so normal browser/FDM downloads are not touched.
const forcedFilenameByUrl = new Map();
const forcedFilenameById = new Map();

function normalizeDownloadPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function reserveDownloadFilename(url, path) {
  const normalized = normalizeDownloadPath(path);
  if (!url || !normalized) return;
  forcedFilenameByUrl.set(String(url), normalized);
}

function releaseDownloadFilename(id, url) {
  if (id != null) forcedFilenameById.delete(Number(id));
  if (url) forcedFilenameByUrl.delete(String(url));
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const forced =
    forcedFilenameById.get(Number(item.id)) ||
    forcedFilenameByUrl.get(String(item.url || "")) ||
    forcedFilenameByUrl.get(String(item.finalUrl || ""));

  if (!forced) return;

  suggest({
    filename: forced,
    conflictAction: "overwrite",
  });
});

// ---------------------------------------------------------------------------
// Naming: canonical SoundCloud Artist + Track Title, Persian -> Finglish.
// No counters, IDs or server filenames are ever appended.
// ---------------------------------------------------------------------------
const FINGLISH_WORDS = Object.freeze({
  "آهنگ":"Ahang","اهنگ":"Ahang","ترانه":"Tarane","موزیک":"Music","موسیقی":"Musighi",
  "جدید":"Jadid","قدیمی":"Ghadimi","اصلی":"Asli","نسخه":"Noskhe","ورژن":"Version",
  "ریمیکس":"Remix","میکس":"Mix","زنده":"Zende","اجرای":"Ejraye","اجرا":"Ejra",
  "بی کلام":"Bikalam","بیکلام":"Bikalam","کلام":"Kalam","متن":"Matn","ویدیو":"Video",
  "عشق":"Eshgh","عاشق":"Ashegh","عاشقانه":"Asheghane","دوست":"Doost","دوستت":"Dooset",
  "دوستم":"Doostam","دل":"Del","دلم":"Delam","قلب":"Ghalb","جان":"Jan","جون":"Joon",
  "من":"Man","تو":"To","ما":"Ma","شما":"Shoma","او":"Oo","اون":"Oon","این":"In",
  "بیا":"Bia","برو":"Boro","بمون":"Bemoon","برگرد":"Bargard","نگو":"Nagoo","بگو":"Begoo",
  "سلام":"Salam","خداحافظ":"Khodahafez","تنهایی":"Tanhaei","تنها":"Tanha","دلتنگ":"Deltang",
  "دلتنگی":"Deltangi","خاطره":"Khatere","خاطرات":"Khaterat","رویا":"Roya","خواب":"Khab",
  "زندگی":"Zendegi","مرگ":"Marg","دنیا":"Donya","آسمان":"Aseman","آسمون":"Asemoon",
  "زمین":"Zamin","دریا":"Darya","باران":"Baran","بارون":"Baroon","برف":"Barf","باد":"Bad",
  "شب":"Shab","روز":"Rooz","صبح":"Sobh","ظهر":"Zohr","عصر":"Asr","امشب":"Emshab",
  "امروز":"Emrooz","فردا":"Farda","دیروز":"Dirooz","همیشه":"Hamishe","هرگز":"Hargez",
  "بهار":"Bahar","تابستان":"Tabestan","پاییز":"Paeiz","زمستان":"Zemestan","ماه":"Mah",
  "خورشید":"Khorshid","ستاره":"Setare","ستاره ها":"Setareha","نور":"Noor","تاریک":"Tarik",
  "آرام":"Aram","آروم":"Aroom","سکوت":"Sokoot","صدا":"Seda","حس":"Hes","حال":"Hal",
  "غم":"Gham","غمگین":"Ghamgin","خوشحال":"Khoshhal","خوشگل":"Khoshgel","زیبا":"Ziba",
  "دیوانه":"Divane","دیوونه":"Divoone","مجنون":"Majnoon","آزاد":"Azad","پرواز":"Parvaz",
  "راه":"Rah","جاده":"Jade","خانه":"Khane","خونه":"Khoone","شهر":"Shahr","کوچه":"Kooche",
  "تهران":"Tehran","ایران":"Iran","شمال":"Shomal","جنوب":"Jonoob","شرق":"Shargh","غرب":"Gharb",
  "مادر":"Madar","پدر":"Pedar","خواهر":"Khahar","برادر":"Baradar","بچه":"Bache","کودک":"Koodak",
  "زن":"Zan","مرد":"Mard","دختر":"Dokhtar","پسر":"Pesar","رفیق":"Refigh","یار":"Yar",
  "خدا":"Khoda","خدایا":"Khodaya","فرشته":"Fereshte","بهشت":"Behesht","جهنم":"Jahannam",
  "چشم":"Cheshm","چشمان":"Cheshman","دست":"Dast","دستات":"Dastat","مو":"Moo","لب":"Lab",
  "خنده":"Khande","گریه":"Gerye","اشک":"Ashk","بوسه":"Boose","بغل":"Baghal","نفس":"Nafas",
  "محمد":"Mohammad","علی":"Ali","رضا":"Reza","حسین":"Hossein","حسن":"Hasan","مهدی":"Mehdi",
  "امیر":"Amir","سعید":"Saeid","مجید":"Majid","حمید":"Hamid","وحید":"Vahid","فرهاد":"Farhad",
  "فرزاد":"Farzad","میلاد":"Milad","نیما":"Nima","آرش":"Arash","آرین":"Arian","سامان":"Saman",
  "سینا":"Sina","شهاب":"Shahab","محسن":"Mohsen","مصطفی":"Mostafa","یاسر":"Yaser","بهنام":"Behnam",
  "ندا":"Neda","نگار":"Negar","سارا":"Sara","مریم":"Maryam","مهسا":"Mahsa","نازنین":"Nazanin",
  "نسترن":"Nastaran","لیلا":"Leila","الهام":"Elham","شبنم":"Shabnam","پرستو":"Parastoo","غزل":"Ghazal"
});

const PERSIAN_CHAR_MAP = Object.freeze({
  "آ":"a","ا":"a","أ":"a","إ":"e","ب":"b","پ":"p","ت":"t","ث":"s","ج":"j","چ":"ch",
  "ح":"h","خ":"kh","د":"d","ذ":"z","ر":"r","ز":"z","ژ":"zh","س":"s","ش":"sh","ص":"s",
  "ض":"z","ط":"t","ظ":"z","ع":"a","غ":"gh","ف":"f","ق":"gh","ک":"k","ك":"k","گ":"g",
  "ل":"l","م":"m","ن":"n","و":"v","ه":"h","ة":"h","ۀ":"e","ی":"y","ي":"y","ئ":"y",
  "ء":"","ؤ":"v","‌":""
});

function normalizePersianText(value) {
  return String(value ?? "")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ۀة]/g, "ه")
    .replace(/[َُِّْٰٔ]/g, "")
    .replace(/[۰-۹]/g, ch => String("۰۱۲۳۴۵۶۷۸۹".indexOf(ch)))
    .replace(/[٠-٩]/g, ch => String("٠١٢٣٤٥٦٧٨٩".indexOf(ch)));
}

function romanizePersianToken(raw) {
  const token = normalizePersianText(raw).replace(/\u200c/g, "‌");
  if (!token) return "";
  if (FINGLISH_WORDS[token]) return FINGLISH_WORDS[token];

  // Common compounds/suffixes before generic letter conversion.
  if (token.startsWith("می‌") && token.length > 3) {
    return `Mi ${romanizePersianToken(token.slice(3))}`.trim();
  }
  if (token.endsWith("های") && token.length > 3) {
    return `${romanizePersianToken(token.slice(0, -3))}haye`;
  }
  if (token.endsWith("ها") && token.length > 2) {
    return `${romanizePersianToken(token.slice(0, -2))}ha`;
  }

  let out = "";
  const chars = [...token];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "ی") {
      out += i === chars.length - 1 ? "i" : "y";
      continue;
    }
    if (ch === "و") {
      if (i === chars.length - 1) out += "o";
      else if (i > 0 && /[ااآ]/.test(chars[i - 1])) out += "v";
      else out += "o";
      continue;
    }
    if (ch === "ه" && i === chars.length - 1) {
      out += "e";
      continue;
    }
    out += PERSIAN_CHAR_MAP[ch] ?? ch;
  }
  out = out.replace(/aa+/g, "a").replace(/oo+/g, "oo").trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : "";
}

function toFinglish(value) {
  const normalized = normalizePersianText(value);
  // Replace only Persian/Arabic script runs; keep existing Latin text and punctuation.
  return normalized
    .replace(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u200c]+/g, run => romanizePersianToken(run))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanFilenamePart(value, fallback) {
  let s = toFinglish(value || fallback || "");
  s = s
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return s || fallback || "Unknown";
}

function buildCanonicalName(track, message) {
  // Canonical API values first; DOM values are fallback only.
  const artistSource = track?.user?.username || track?.publisher_metadata?.artist || message?.artist || "Unknown Artist";
  const titleSource = track?.title || message?.title || "SoundCloud Track";
  const artist = cleanFilenamePart(artistSource, "Unknown Artist");
  const title = cleanFilenamePart(titleSource, "SoundCloud Track");
  return { artist, title, filename: `${artist} - ${title}` };
}


function metadataForTrack(track, message, naming) {
  const albumSource =
    track?.publisher_metadata?.album_title ||
    track?.publisher_metadata?.album ||
    "";
  const releaseDate = track?.release_date || track?.display_date || track?.created_at || "";
  const artworkUrl = track?.artwork_url || track?.user?.avatar_url || "";

  return {
    title: naming.title,
    artist: naming.artist,
    album: albumSource ? toFinglish(albumSource) : "",
    genre: track?.genre ? toFinglish(track.genre) : "",
    releaseDate: String(releaseDate || "").slice(0, 10),
    trackNumber: "",
    isrc: track?.publisher_metadata?.isrc || "",
    copyright: track?.publisher_metadata?.p_line || track?.publisher_metadata?.c_line || "",
    description: track?.description ? toFinglish(track.description) : "",
    url: absolutePermalink(track) || message?.url || "",
    artworkUrl,
    trackId: track?.id ? String(track.id) : "",
    publisher: track?.publisher_metadata?.publisher ? toFinglish(track.publisher_metadata.publisher) : "",
  };
}

function cleanFolderPart(value, fallback = "Collection") {
  return cleanFilenamePart(value, fallback).slice(0, 120);
}

// ---------------------------------------------------------------------------
// Progress bridge: offscreen fetch -> background -> exact SoundCloud tab.
// ---------------------------------------------------------------------------
const buildContexts = new Map();

function emitProgress(tabId, requestId, percent, stage, extra = {}) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  if (!tabId || !requestId) return;
  chrome.tabs.sendMessage(tabId, {
    type: "DOWNLOAD_PROGRESS",
    requestId,
    percent: p,
    stage,
    ...extra,
  }).catch(() => {});
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Fetch requested audio with progress, assemble non-encrypted HLS and create a verified Blob before browser save.",
  });
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function buildDirectBlob(streamUrl, extension, mimeType, metadata, tabId, requestId) {
  await ensureOffscreen();
  const buildId = crypto.randomUUID();
  buildContexts.set(buildId, { tabId, requestId });
  try {
    const result = await runtimeMessage({
      type: "OFFSCREEN_BUILD_DIRECT",
      buildId,
      streamUrl,
      extension,
      mimeType,
      metadata,
    });
    if (!result?.ok) throw new Error(result?.error || "دریافت فایل مستقیم ناموفق بود.");
    return result;
  } finally {
    buildContexts.delete(buildId);
  }
}

async function buildHlsBlob(streamUrl, extension, mimeType, metadata, tabId, requestId) {
  await ensureOffscreen();
  const buildId = crypto.randomUUID();
  buildContexts.set(buildId, { tabId, requestId });
  try {
    const result = await runtimeMessage({
      type: "OFFSCREEN_BUILD_HLS",
      buildId,
      streamUrl,
      extension,
      mimeType,
      metadata,
    });
    if (!result?.ok) throw new Error(result?.error || "ساخت فایل HLS ناموفق بود.");
    return result;
  } finally {
    buildContexts.delete(buildId);
  }
}

async function revokeBlob(blobUrl) {
  if (!blobUrl) return;
  try { await runtimeMessage({ type: "OFFSCREEN_REVOKE", blobUrl }); } catch (_) {}
}

function buildDownloadPath({ folder, filename, extension }) {
  const safeFolder = String(folder || "soundcloud/Singles")
    .split("/")
    .filter(Boolean)
    .map(p => cleanFolderPart(p))
    .join("/");
  return `${safeFolder}/${filename}.${extension}`;
}

async function waitForBrowserSave(downloadId, tabId, requestId) {
  emitProgress(tabId, requestId, 97, "saving");
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearInterval(poller);
    };
    const onChanged = delta => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        cleanup();
        emitProgress(tabId, requestId, 100, "complete");
        resolve();
      } else if (delta.state?.current === "interrupted") {
        cleanup();
        reject(new Error(`ذخیره فایل در مرورگر قطع شد${delta.error?.current ? `: ${delta.error.current}` : ""}`));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);

    const poller = setInterval(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return;
        if (item.state === "complete") {
          cleanup();
          emitProgress(tabId, requestId, 100, "complete");
          resolve();
          return;
        }
        if (item.state === "interrupted") {
          cleanup();
          reject(new Error(`ذخیره فایل در مرورگر قطع شد${item.error ? `: ${item.error}` : ""}`));
          return;
        }
        if (item.totalBytes > 0 && item.bytesReceived >= 0) {
          const localPct = Math.min(1, item.bytesReceived / item.totalBytes);
          emitProgress(tabId, requestId, 97 + localPct * 2.5, "saving");
        }
      } catch (_) {}
    }, 250);
  });
}

async function saveBlobToBrowser(blobUrl, path, tabId, requestId) {
  const forcedPath = normalizeDownloadPath(path);
  reserveDownloadFilename(blobUrl, forcedPath);

  let id = null;
  try {
    id = await chromeDownload({
      url: blobUrl,
      filename: forcedPath,
      conflictAction: "overwrite",
      saveAs: false,
    });

    // Keep an ID-based reservation too. Depending on Chrome timing,
    // onDeterminingFilename may happen before or just after the callback.
    forcedFilenameById.set(Number(id), forcedPath);

    await waitForBrowserSave(id, tabId, requestId);

    // Sanity-check what Chrome actually wrote. This does not rename after the
    // fact; the filename listener above must have already enforced it.
    try {
      const [item] = await chrome.downloads.search({ id });
      if (item?.filename) {
        const actualBase = item.filename.replace(/\\/g, "/").split("/").pop();
        const expectedBase = forcedPath.split("/").pop();
        if (actualBase !== expectedBase) {
          console.warn("[SoundCloud Download Manager] filename mismatch", {
            expected: expectedBase,
            actual: actualBase,
            fullPath: item.filename,
          });
        }
      }
    } catch (_) {}

    return id;
  } finally {
    // Delay URL cleanup slightly because Chrome may dispatch the filename event
    // very close to the downloads.download callback on some builds.
    setTimeout(() => releaseDownloadFilename(id, blobUrl), 5000);
  }
}

// ---------------------------------------------------------------------------
// Optional Free Download Manager hand-off. Default is OFF.
// Direct/Progressive only; HLS always uses the verified browser pipeline.
// ---------------------------------------------------------------------------
let nextExternalRuleId = 820000;

function contentDispositionForFilename(filename) {
  const ascii = String(filename || "SoundCloud Track")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_") || "SoundCloud Track";
  const encoded = encodeURIComponent(String(filename || "SoundCloud Track")).replace(/'/g, "%27");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function externalManagerFirstDownload(url, filenameWithExt, tabId, requestId) {
  if (!chrome.declarativeNetRequest?.updateSessionRules || !chrome.tabs?.create) {
    return { ok: false, reason: "fdm-browser-integration-unavailable" };
  }

  emitProgress(tabId, requestId, 15, "fdm");
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  if (!tab?.id) return { ok: false, reason: "tab-create-failed" };

  const ruleId = nextExternalRuleId++;
  if (nextExternalRuleId > 899999) nextExternalRuleId = 820000;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 10000,
        action: {
          type: "modifyHeaders",
          responseHeaders: [{
            header: "content-disposition",
            operation: "set",
            value: contentDispositionForFilename(filenameWithExt),
          }],
        },
        condition: { tabIds: [tab.id], resourceTypes: ["main_frame"] },
      }],
    });

    await chrome.tabs.update(tab.id, { url });
    emitProgress(tabId, requestId, 100, "fdm");

    setTimeout(() => {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
      chrome.tabs.remove(tab.id).catch(() => {});
    }, 6500);

    return { ok: true, mode: "fdm-browser-integration" };
  } catch (error) {
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); } catch (_) {}
    try { await chrome.tabs.remove(tab.id); } catch (_) {}
    return { ok: false, reason: error?.message || "fdm-dispatch-failed" };
  }
}

async function downloadTrack(message, tabId) {
  mergeCredentials(message.credentials || {});
  const credentials = message.credentials || {};
  const requestId = message.requestId || crypto.randomUUID();

  emitProgress(tabId, requestId, 2, "resolving");
  let track = await resolveTrackForDownload(message.url, credentials);
  emitProgress(tabId, requestId, 6, "resolved");

  const naming = buildCanonicalName(track, message);
  const artist = naming.artist;
  const title = naming.title;
  const filename = naming.filename;
  const metadata = metadataForTrack(track, message, naming);

  const settings = await chrome.storage.local.get({ useFdm: false });
  const useFdm = settings.useFdm === true;

  // 1) Prefer the creator-enabled original file when available.
  // If the original signed URL cannot be fetched in the extension context,
  // continue to SoundCloud's normal transcoding candidates instead of failing the track.
  const original = await tryOriginalDownload(track, credentials);
  if (original) {
    const path = buildDownloadPath({
      folder: message.folder || "soundcloud/Singles",
      filename,
      extension: original.extension,
    });

    try {
      if (useFdm) {
        const external = await externalManagerFirstDownload(
          original.url,
          `${filename}.${original.extension}`,
          tabId,
          requestId
        );
        if (external.ok) {
          return { ok: true, externalFirst: true, title, artist, filename, path, format: original.extension.toUpperCase(), protocol: "original" };
        }
        emitProgress(tabId, requestId, 8, "browser-fallback");
      }

      const built = await buildDirectBlob(original.url, original.extension, "application/octet-stream", metadata, tabId, requestId);
      try {
        const id = await saveBlobToBrowser(built.blobUrl, path, tabId, requestId);
        return { ok: true, downloadId: id, title, artist, filename, path, bytes: built.bytes || 0, format: original.extension.toUpperCase(), protocol: "original" };
      } finally {
        await revokeBlob(built.blobUrl);
      }
    } catch (error) {
      console.info("[SoundCloud Download Manager] original file pipeline failed; falling back to stream", error?.message || error);
      emitProgress(tabId, requestId, 8, "preparing");
    }
  }

  let candidates = transcodingCandidates(track);
  const allTranscodings = track?.media?.transcodings || [];
  const hasEncrypted = allTranscodings.some(isEncryptedTranscoding);

  if (!candidates.length) {
    if (hasEncrypted) throw new Error("این Track فقط Stream رمزگذاری‌شده/DRM دارد؛ افزونه DRM را دور نمی‌زند.");
    throw new Error("هیچ Stream قابل دانلود برای این Track پیدا نشد.");
  }

  const errors = [];
  let refreshedAfter404 = false;

  for (let i = 0; i < candidates.length; i++) {
    let candidate = candidates[i];
    try {
      emitProgress(tabId, requestId, 8, "preparing");
      const streamUrl = await resolveStream(track, candidate, credentials);
      const protocol = String(candidate?.format?.protocol || "").toLowerCase();
      const extension = extensionForTranscoding(candidate);
      const mimeType = mimeForTranscoding(candidate);
      const path = buildDownloadPath({
        folder: message.folder || "soundcloud/Singles",
        filename,
        extension,
      });

      if (protocol === "progressive") {
        if (useFdm) {
          const external = await externalManagerFirstDownload(streamUrl, `${filename}.${extension}`, tabId, requestId);
          if (external.ok) {
            return { ok: true, externalFirst: true, title, artist, filename, path, format: extension.toUpperCase(), protocol };
          }
          emitProgress(tabId, requestId, 8, "browser-fallback");
        }

        const built = await buildDirectBlob(streamUrl, extension, mimeType, metadata, tabId, requestId);
        try {
          const id = await saveBlobToBrowser(built.blobUrl, path, tabId, requestId);
          return { ok: true, downloadId: id, title, artist, filename, path, bytes: built.bytes || 0, format: extension.toUpperCase(), protocol };
        } finally {
          await revokeBlob(built.blobUrl);
        }
      }

      if (protocol === "hls") {
        // HLS is assembled locally first, so FDM cannot receive a durable HTTP URL.
        const built = await buildHlsBlob(streamUrl, extension, mimeType, metadata, tabId, requestId);
        try {
          const id = await saveBlobToBrowser(built.blobUrl, path, tabId, requestId);
          return {
            ok: true,
            downloadId: id,
            title,
            artist,
            filename,
            path,
            bytes: built.bytes || 0,
            format: extension.toUpperCase(),
            protocol: "hls",
            parts: built.parts || 0,
            fdmFallback: useFdm,
          };
        } finally {
          await revokeBlob(built.blobUrl);
        }
      }

      errors.push({ preset: candidate?.preset || protocol, status: null, message: "protocol unsupported" });
    } catch (error) {
      errors.push({
        preset: candidate?.preset || candidate?.format?.protocol || "stream",
        status: error?.status || null,
        message: error?.message || "unknown error",
      });

      if (error?.status === 404 && !refreshedAfter404 && track?.id) {
        refreshedAfter404 = true;
        track = await fetchFreshTrack(track, { ...credentials, oauthToken: state.oauthToken });
        candidates = transcodingCandidates(track);
        i = -1;
        continue;
      }
    }
  }

  const all404 = errors.length > 0 && errors.every(e => e.status === 404);
  if (all404 && hasEncrypted) {
    throw new Error("SoundCloud برای Streamهای معمولی این Track پاسخ 404 می‌دهد و نسخه قابل پخش آن رمزگذاری‌شده/DRM است. این مورد قابل دانلود مستقیم نیست.");
  }
  if (all404) {
    throw new Error("SoundCloud برای Streamهای این Track پاسخ 404 می‌دهد. اگر وارد حساب SoundCloud هستید صفحه را Refresh کنید؛ در غیر این صورت این Track احتمالاً محدودیت حساب/اشتراک دارد.");
  }

  const summary = errors.slice(-4).map(e => `${e.preset}: ${e.status ? `API ${e.status}` : e.message}`).join(" | ");
  throw new Error(`همه Streamها ناموفق بودند. ${summary}`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Progress messages originate in offscreen.js and are forwarded to the initiating SoundCloud tab.
  if (message?.type === "OFFSCREEN_PROGRESS") {
    const ctx = buildContexts.get(message.buildId);
    if (ctx) {
      emitProgress(ctx.tabId, ctx.requestId, message.percent, message.stage, {
        loaded: message.loaded || 0,
        total: message.total || 0,
        partsDone: message.partsDone || 0,
        partsTotal: message.partsTotal || 0,
      });
    }
    sendResponse({ ok: true });
    return false;
  }

  // Other OFFSCREEN_* messages are handled by offscreen.js.
  if (String(message?.type || "").startsWith("OFFSCREEN_")) return false;

  (async () => {
    switch (message?.type) {
      case "PING":
        sendResponse({ ok: true, version: VERSION });
        return;

      case "UPDATE_CREDENTIALS":
        mergeCredentials(message.credentials || {});
        sendResponse({ ok: true });
        return;

      case "GET_COLLECTION_TRACKS": {
        mergeCredentials(message.credentials || {});
        const result = await getCollectionTracks(message.url, message.credentials || {});
        sendResponse(result);
        return;
      }

      case "DOWNLOAD_TRACK": {
        const result = await downloadTrack(message, sender?.tab?.id || null);
        sendResponse(result);
        return;
      }

      case "PREVIEW_FILENAME": {
        const artist = cleanFilenamePart(message.artist || "Artist", "Artist");
        const title = cleanFilenamePart(message.title || "Track Title", "Track Title");
        sendResponse({ ok: true, filename: `${artist} - ${title}` });
        return;
      }

      default:
        sendResponse({ ok: false, error: "پیام ناشناخته است." });
    }
  })().catch(error => {
    console.error("[SoundCloud Download Manager]", error);
    sendResponse({
      ok: false,
      error: error?.message || "خطای ناشناخته",
      status: error?.status || null,
    });
  });

  return true;
});
