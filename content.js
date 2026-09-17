(() => {
  const VERSION = "3.0.1";
  const TRACK_BTN = "scdm-inline-download";
  const TRACK_CHECK = "scdm-inline-check";
  const PANEL_ID = "scdm-panel";
  const TOAST_ID = "scdm-toast";
  const MARK_ATTR = "data-scdm-marked";

  const RESERVED_FIRST = new Set([
    "discover","stream","you","charts","search","upload","settings","messages",
    "notifications","people","stations","popular","terms","pages","jobs","mobile",
    "company","premium","artist","creators","signin","logout","tags","playlists"
  ]);
  const RESERVED_SECOND = new Set([
    "sets","tracks","likes","reposts","albums","comments","followers","following"
  ]);

  const tracks = new Map();
  const pendingRoots = new Set();
  const requestTrackMap = new Map();
  let activeDownloadRequest = null;
  let bulkProgressContext = null;
  let progressRenderTimer = null;
  let currentUrl = location.href;
  let loadingCollection = false;
  let downloading = false;
  let credentialsCache = null;
  let credentialsAt = 0;
  let mutationTimer = null;
  let countTimer = null;
  let routeTimer = null;

  const settings = {
    adAssistEnabled: true,
    adMute: true,
    adAccelerate: true,
    adSpeed: 16,
    adAutoSkip: true,
    useFdm: false,
  };

  const adEngineState = {
    ready: false,
    active: false,
    reason: "",
  };

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function absUrl(href) {
    try { return new URL(href, location.origin); }
    catch (_) { return null; }
  }

  function canonicalTrackUrl(href) {
    const u = absUrl(href);
    if (!u || u.hostname !== "soundcloud.com") return null;
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  }

  function isTrackPermalink(href) {
    const u = absUrl(href);
    if (!u || u.hostname !== "soundcloud.com") return false;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return false;

    const first = decodeURIComponent(parts[0]).toLowerCase();
    const second = decodeURIComponent(parts[1]).toLowerCase();
    if (!first || !second) return false;
    if (RESERVED_FIRST.has(first) || RESERVED_SECOND.has(second)) return false;
    return true;
  }

  function isTrackAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;

    const href = anchor.getAttribute("href") || "";
    if (!isTrackPermalink(href)) return false;

    const url = absUrl(href);
    if (!url) return false;

    // Never treat hashtags/tags or tag UI as tracks.
    if (url.pathname === "/tags" || url.pathname.startsWith("/tags/")) return false;
    if (anchor.matches(".sc-tag, [class*='tagLink'], [data-testid*='tag']")) return false;
    if (anchor.closest(".soundTags, .sc-tag-group, .sc-tag, [class*='soundTags'], [class*='tagGroup']")) return false;

    // Utility/navigation links are not track titles even if their route happens to be two segments.
    if (anchor.closest("nav, header, footer, [role='navigation']")) return false;

    return true;
  }

  function cleanText(text, max = 160) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
  }

  function sanitizePart(value, fallback = "Collection") {
    let s = cleanText(value, 120)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
    return s || fallback;
  }

  function getCredentials() {
    if (credentialsCache && Date.now() - credentialsAt < 60000) return credentialsCache;

    let clientId = null;
    let appVersion = null;

    // Only inspect inline scripts once per minute. This is intentionally not run during DOM scans.
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!clientId) {
        const m =
          text.match(/client_id["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,80})["']/) ||
          text.match(/clientId["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,80})["']/);
        if (m?.[1]) clientId = m[1];
      }
      if (!appVersion) {
        const m =
          text.match(/window\.__sc_version\s*=\s*["']?(\d{8,20})/) ||
          text.match(/app_version["']?\s*[:=]\s*["']?(\d{8,20})/);
        if (m?.[1]) appVersion = m[1];
      }
      if (clientId && appVersion) break;
    }

    let oauthToken = null;
    const cookieMatch = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
    if (cookieMatch?.[1]) {
      try { oauthToken = decodeURIComponent(cookieMatch[1]); }
      catch (_) { oauthToken = cookieMatch[1]; }
    }

    credentialsCache = { clientId, appVersion, oauthToken };
    credentialsAt = Date.now();
    return credentialsCache;
  }

  function send(message) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "پاسخی دریافت نشد." });
      });
    });
  }


  function progressStageLabel(stage) {
    const labels = {
      "resolving": "در حال شناسایی ترک",
      "resolved": "ترک شناسایی شد",
      "preparing": "آماده‌سازی لینک صوتی",
      "fetching": "دریافت فایل",
      "parsing-hls": "تحلیل Stream",
      "fetching-hls": "دریافت بخش‌های صوتی",
      "assembling": "ساخت فایل نهایی",
      "verifying": "بررسی سلامت فایل",
      "tagging": "ثبت Title و Details فایل",
      "saving": "ذخیره در مرورگر",
      "complete": "ذخیره شد",
      "fdm": "ارسال به Free Download Manager",
      "browser-fallback": "بازگشت به دانلود مرورگر",
    };
    return labels[stage] || "در حال دانلود";
  }

  function scheduleProgressRender() {
    if (progressRenderTimer) return;
    progressRenderTimer = setTimeout(() => {
      progressRenderTimer = null;
      renderPanelList();
    }, 120);
  }

  function syncDownloadModeUi() {
    const stateEl = document.getElementById("scdm-download-mode-state");
    const pill = document.getElementById("scdm-download-mode-pill");
    if (stateEl) {
      stateEl.textContent = settings.useFdm
        ? "FDM برای لینک مستقیم فعال است؛ HLS با مرورگر ذخیره می‌شود."
        : "حالت پیش‌فرض: دریافت کامل + ذخیره مرتب توسط مرورگر";
    }
    if (pill) {
      pill.textContent = settings.useFdm ? "FDM" : "BROWSER";
      pill.dataset.mode = settings.useFdm ? "fdm" : "browser";
    }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== "DOWNLOAD_PROGRESS" || !message.requestId) return false;
    const url = requestTrackMap.get(message.requestId);
    if (!url) return false;
    const track = tracks.get(url);
    if (!track) return false;

    const percent = Math.max(0, Math.min(100, Number(message.percent) || 0));
    track.progress = percent;
    track.stage = String(message.stage || "");
    if (percent > 0 && percent < 100) track.status = "loading";

    if (bulkProgressContext?.requestId === message.requestId) {
      const overall = ((bulkProgressContext.index + percent / 100) / bulkProgressContext.total) * 100;
      setProgress(overall);
      setPanelStatus(
        `دانلود ${bulkProgressContext.index + 1}/${bulkProgressContext.total} — ${Math.round(percent)}٪ — ${progressStageLabel(track.stage)}`
      );
    } else if (activeDownloadRequest === message.requestId) {
      setProgress(percent);
      setPanelStatus(`${Math.round(percent)}٪ — ${progressStageLabel(track.stage)}`);
    }

    scheduleProgressRender();
    return false;
  });

  function findArtistNear(anchor) {
    const card = anchor.closest(
      'li, article, [role="listitem"], .sound, .trackItem, .playableTile, .stream__list > div'
    ) || anchor.parentElement?.parentElement || anchor.parentElement;
    if (!card) return "";

    for (const a of card.querySelectorAll("a[href]")) {
      const u = absUrl(a.getAttribute("href"));
      if (!u || u.hostname !== "soundcloud.com") continue;
      const p = u.pathname.split("/").filter(Boolean);
      const t = cleanText(a.textContent);
      if (p.length === 1 && t) return t;
    }
    return "";
  }

  function chooseTitleAnchor(trackAnchor) {
    if (cleanText(trackAnchor.textContent)) return trackAnchor;

    const href = trackAnchor.getAttribute("href");
    const scope = trackAnchor.closest(
      'li, article, [role="listitem"], .sound, .trackItem, .playableTile'
    ) || trackAnchor.parentElement?.parentElement;

    if (!scope || !href) return trackAnchor;
    return [...scope.querySelectorAll("a[href]")]
      .find(a => a.getAttribute("href") === href && cleanText(a.textContent)) || trackAnchor;
  }

  function upsertTrack(info) {
    if (!info?.url) return null;
    const url = canonicalTrackUrl(info.url);
    if (!url || !isTrackPermalink(url)) return null;

    const existing = tracks.get(url) || {};
    const next = {
      url,
      title: cleanText(info.title || existing.title || url.split("/").pop()),
      artist: cleanText(info.artist || existing.artist || ""),
      duration: info.duration || existing.duration || 0,
      selected: info.selected ?? existing.selected ?? false,
      status: existing.status || "",
      error: existing.error || "",
      progress: Number.isFinite(existing.progress) ? existing.progress : 0,
      stage: existing.stage || "",
      index: info.index || existing.index || tracks.size + 1,
    };
    tracks.set(url, next);
    return next;
  }

  function showToast(message, kind = "info", ms = 3200) {
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => el.classList.remove("show"), ms);
  }

  function pageKind() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] === "discover" && parts[1] === "sets") return "playlist";
    if (parts.length >= 3 && parts[1] === "sets") return "playlist";
    if (parts.length === 1 && !RESERVED_FIRST.has(parts[0])) return "user";
    if (parts.length === 2 && ["tracks","popular-tracks"].includes(parts[1])) return "user";
    return "collection";
  }

  function visibleCollectionTitle() {
    const h1 =
      document.querySelector("h1")?.textContent ||
      document.querySelector(".soundTitle__title")?.textContent ||
      "";
    const title = cleanText(h1) ||
      cleanText(document.title.replace(/\s*on SoundCloud.*$/i, "").replace(/\|\s*SoundCloud.*$/i, ""));
    return sanitizePart(title || location.pathname.split("/").filter(Boolean).pop() || "Collection");
  }

  function folderForPage() {
    const parts = location.pathname.split("/").filter(Boolean);
    const kind = pageKind();

    if (kind === "user") {
      return `soundcloud/Users/${sanitizePart(parts[0], "User")}`;
    }
    if (kind === "playlist") {
      return `soundcloud/Playlists/${visibleCollectionTitle()}`;
    }
    return `soundcloud/Collections/${visibleCollectionTitle()}`;
  }

  function folderForSingle() {
    const kind = pageKind();
    if (kind === "playlist" || kind === "user") return folderForPage();
    return "soundcloud/Singles";
  }

  function syncInlineControls(url) {
    for (const input of document.querySelectorAll(`.${TRACK_CHECK}`)) {
      if (input.dataset.trackUrl === url) input.checked = Boolean(tracks.get(url)?.selected);
    }
  }

  function selectTrack(url, value) {
    const track = tracks.get(url);
    if (!track) return;
    track.selected = Boolean(value);
    syncInlineControls(url);
    renderPanelList();
    updatePanelCounts();
  }

  async function downloadOne(track, options = {}) {
    const folder = options.folder || folderForSingle();
    const index = options.index || 1;
    const total = options.total || 1;
    const requestId = crypto.randomUUID();

    requestTrackMap.set(requestId, track.url);
    track.status = "loading";
    track.error = "";
    track.progress = 0;
    track.stage = "resolving";

    if (options.bulk) {
      bulkProgressContext = {
        requestId,
        index: options.bulkIndex || 0,
        total: options.bulkTotal || total,
      };
    } else {
      activeDownloadRequest = requestId;
      setProgress(0);
    }
    renderPanelList();

    const result = await send({
      type: "DOWNLOAD_TRACK",
      requestId,
      url: track.url,
      title: track.title || "SoundCloud Track",
      artist: track.artist || "",
      folder,
      index,
      total,
      credentials: getCredentials(),
    });

    requestTrackMap.delete(requestId);
    if (activeDownloadRequest === requestId) activeDownloadRequest = null;
    if (bulkProgressContext?.requestId === requestId) bulkProgressContext = null;

    if (result.ok) {
      track.status = "done";
      track.progress = 100;
      track.stage = result.externalFirst ? "fdm" : "complete";
      track.error = "";
      if (!options.bulk) {
        setProgress(100);
        setPanelStatus(
          result.externalFirst
            ? `${result.filename || track.title} به FDM ارسال شد.`
            : `${result.filename || track.title} با موفقیت ذخیره شد.`,
          "success"
        );
      }
      renderPanelList();
      return result;
    }

    track.status = "error";
    track.error = result.error || "خطای دانلود";
    track.stage = "";
    if (!options.bulk) setPanelStatus(track.error, "error");
    renderPanelList();
    return result;
  }

  function addInlineControls(trackAnchor) {
    if (!(trackAnchor instanceof Element)) return;
    if (trackAnchor.closest(`#${PANEL_ID}, .scdm-inline-wrap`)) return;
    if (trackAnchor.hasAttribute(MARK_ATTR)) return;
    if (!isTrackAnchor(trackAnchor)) return;

    const anchor = chooseTitleAnchor(trackAnchor);
    if (!anchor || anchor.hasAttribute(MARK_ATTR)) return;

    const url = canonicalTrackUrl(anchor.getAttribute("href"));
    if (!url) return;

    const title = cleanText(anchor.textContent);
    const artist = findArtistNear(anchor);
    const track = upsertTrack({ url, title, artist });
    if (!track) return;

    const parent = anchor.parentElement;
    if (!parent) return;

    if ([...parent.querySelectorAll(`:scope > .scdm-inline-wrap > .${TRACK_BTN}`)].some(b => b.dataset.trackUrl === url)) {
      anchor.setAttribute(MARK_ATTR, "1");
      return;
    }

    const wrap = document.createElement("span");
    wrap.className = "scdm-inline-wrap";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = TRACK_CHECK;
    check.dataset.trackUrl = url;
    check.title = "انتخاب برای دانلود گروهی";
    check.checked = Boolean(track.selected);
    check.addEventListener("click", e => e.stopPropagation());
    check.addEventListener("change", e => {
      e.stopPropagation();
      selectTrack(url, check.checked);
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = TRACK_BTN;
    btn.dataset.trackUrl = url;
    btn.title = "Download";
    btn.setAttribute("aria-label", "دانلود این آهنگ");
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"></path>
      </svg>
    `;

    btn.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.state === "loading") return;

      btn.dataset.state = "loading";
      btn.disabled = true;
      showToast(`در حال دانلود: ${track.title}`);

      const result = await downloadOne(track, {
        folder: folderForSingle(),
        index: 1,
        total: 1,
      });

      if (result.ok) {
        btn.dataset.state = "done";
        showToast(`ذخیره شد: ${track.title}`, "success");
      } else {
        btn.dataset.state = "error";
        showToast(result.error || "خطا در دانلود", "error", 5200);
      }

      setTimeout(() => {
        btn.dataset.state = "";
        btn.disabled = false;
      }, 1800);
    }, true);

    wrap.append(check, btn);
    anchor.setAttribute(MARK_ATTR, "1");
    anchor.insertAdjacentElement("afterend", wrap);
    scheduleCountUpdate();
  }

  function anchorsFromRoot(root) {
    const out = [];
    if (!(root instanceof Element) && root !== document) return out;

    if (root instanceof Element && root.matches("a[href]")) out.push(root);
    if (root.querySelectorAll) {
      for (const a of root.querySelectorAll("a[href]")) out.push(a);
    }
    return out;
  }

  function scanRoot(root) {
    if (root instanceof Element && root.closest(`#${PANEL_ID}, .scdm-inline-wrap, #${TOAST_ID}`)) return;

    for (const a of anchorsFromRoot(root)) {
      if (a.hasAttribute(MARK_ATTR)) continue;
      if (isTrackAnchor(a)) addInlineControls(a);
    }
  }

  function scheduleRootScan(root) {
    if (!(root instanceof Element)) return;
    if (root.closest(`#${PANEL_ID}, .scdm-inline-wrap, #${TOAST_ID}`)) return;
    pendingRoots.add(root);

    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      const roots = [...pendingRoots];
      pendingRoots.clear();

      // Scan only newly-added subtrees. Never rescan the whole page here.
      for (const node of roots) scanRoot(node);
      scheduleCountUpdate();
    }, 180);
  }

  function scheduleCountUpdate() {
    if (countTimer) return;
    countTimer = setTimeout(() => {
      countTimer = null;
      updatePanelCounts();
    }, 220);
  }

  function sendAdConfigToMain() {
    window.postMessage({
      source: "SCDM_EXTENSION",
      type: "SCDM_AD_CONFIG",
      enabled: settings.adAssistEnabled,
      mute: settings.adMute,
      accelerate: settings.adAccelerate,
      speed: settings.adSpeed,
      autoSkip: settings.adAutoSkip,
    }, "*");
  }

  function syncAdAssistUi() {
    const button = document.getElementById("scdm-ad-toggle");
    const label = document.getElementById("scdm-ad-state");

    if (button) {
      button.classList.toggle("is-on", settings.adAssistEnabled);
      button.setAttribute("aria-pressed", String(settings.adAssistEnabled));
    }

    if (label) {
      if (!settings.adAssistEnabled) {
        label.textContent = "خاموش";
        label.dataset.kind = "off";
      } else if (adEngineState.active) {
        label.textContent = "تبلیغ بی‌صدا / سریع";
        label.dataset.kind = "active";
      } else if (adEngineState.ready) {
        label.textContent = "Engine فعال";
        label.dataset.kind = "on";
      } else {
        label.textContent = "در حال اتصال…";
        label.dataset.kind = "off";
      }
    }
  }

  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get({
        adAssistEnabled: true,
        adMute: true,
        adAccelerate: true,
        adSpeed: 16,
        adAutoSkip: true,
        useFdm: false,
      });

      settings.adAssistEnabled = stored.adAssistEnabled !== false;
      settings.adMute = stored.adMute !== false;
      settings.adAccelerate = stored.adAccelerate !== false;
      settings.adSpeed = Math.max(1, Math.min(16, Number(stored.adSpeed) || 16));
      settings.adAutoSkip = stored.adAutoSkip !== false;
      settings.useFdm = stored.useFdm === true;
    } catch (_) {}

    syncAdAssistUi();
    syncDownloadModeUi();
    sendAdConfigToMain();

    // The MAIN-world script starts at document_start and may have posted
    // "engine-ready" before this isolated script attached its listener.
    // Sending config also causes it to post status again.
    setTimeout(sendAdConfigToMain, 250);
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "SCDM_MAIN_AD_ENGINE" || data.type !== "SCDM_AD_STATUS") return;

    adEngineState.ready = true;
    adEngineState.active = Boolean(data.active);
    adEngineState.reason = String(data.reason || "");

    syncAdAssistUi();

    if (data.reason === "auto-skip") {
      showToast("Ad Engine: Skip خودکار اجرا شد.", "success", 1600);
    }
  }, false);

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="scdm-head">
        <div class="scdm-head-brand">
          <span class="scdm-brand-mark" aria-hidden="true">SC</span>
          <div>
            <div class="scdm-eyebrow">SOUNDCLOUD PRO</div>
            <div class="scdm-title">Download Manager <small>v${VERSION}</small></div>
          </div>
        </div>
        <button class="scdm-collapse" type="button" title="جمع کردن">—</button>
      </div>

      <div class="scdm-body">
        <div class="scdm-stats">
          <span><b id="scdm-found">0</b> ترک</span>
          <span><b id="scdm-selected">0</b> انتخاب</span>
        </div>

        <div class="scdm-mode-card">
          <div class="scdm-mode-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg>
          </div>
          <div class="scdm-mode-copy">
            <strong>Download Pipeline</strong>
            <span id="scdm-download-mode-state">حالت پیش‌فرض مرورگر</span>
          </div>
          <b id="scdm-download-mode-pill" class="scdm-mode-pill" data-mode="browser">BROWSER</b>
        </div>

        <div class="scdm-ad-card">
          <div class="scdm-ad-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M4 9v6m4-8v10m4-13v16m4-11v6m4-4v2"/></svg>
          </div>
          <div class="scdm-ad-copy">
            <strong>Ad Silence + Auto Skip</strong>
            <span id="scdm-ad-state" data-kind="on">فعال</span>
          </div>
          <button id="scdm-ad-toggle" class="scdm-switch is-on" type="button" aria-pressed="true" title="فعال/غیرفعال کردن Ad Assist">
            <span></span>
          </button>
        </div>

        <button id="scdm-load-all" class="scdm-btn scdm-primary scdm-load" type="button">
          <span>بارگذاری کامل مجموعه</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>
        </button>

        <div class="scdm-grid">
          <button id="scdm-select-all" class="scdm-btn" type="button">انتخاب همه</button>
          <button id="scdm-clear-all" class="scdm-btn" type="button">پاک کردن انتخاب</button>
        </div>

        <div class="scdm-grid scdm-download-grid">
          <button id="scdm-download-selected" class="scdm-btn scdm-accent" type="button">دانلود انتخاب‌شده</button>
          <button id="scdm-download-all" class="scdm-btn scdm-primary" type="button">دانلود همه</button>
        </div>

        <div id="scdm-track-list" class="scdm-list"></div>

        <div id="scdm-status" class="scdm-status">آماده</div>
        <div class="scdm-progress-shell">
          <div class="scdm-progress-meta"><span>Download progress</span><b id="scdm-progress-number">0%</b></div>
          <div class="scdm-progress"><div id="scdm-progress-fill"></div></div>
        </div>
        <div class="scdm-folder">Downloads/<b>soundcloud</b>/...</div>
        <div class="scdm-credit">Designed &amp; Developed by <b>Reza Zarnegar</b></div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    panel.querySelector(".scdm-collapse").addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });

    panel.querySelector("#scdm-ad-toggle").addEventListener("click", async () => {
      settings.adAssistEnabled = !settings.adAssistEnabled;
      try {
        await chrome.storage.local.set({
          adAssistEnabled: settings.adAssistEnabled,
          adMute: settings.adMute,
          adAccelerate: settings.adAccelerate,
          adSpeed: settings.adSpeed,
          adAutoSkip: settings.adAutoSkip,
        });
      } catch (_) {}
      syncAdAssistUi();
      sendAdConfigToMain();
    });

    panel.querySelector("#scdm-load-all").addEventListener("click", loadFullCollection);

    panel.querySelector("#scdm-select-all").addEventListener("click", () => {
      tracks.forEach(t => t.selected = true);
      for (const c of document.querySelectorAll(`.${TRACK_CHECK}`)) c.checked = true;
      renderPanelList();
      updatePanelCounts();
    });

    panel.querySelector("#scdm-clear-all").addEventListener("click", () => {
      tracks.forEach(t => t.selected = false);
      for (const c of document.querySelectorAll(`.${TRACK_CHECK}`)) c.checked = false;
      renderPanelList();
      updatePanelCounts();
    });

    panel.querySelector("#scdm-download-selected").addEventListener("click", () => {
      bulkDownload([...tracks.values()].filter(t => t.selected));
    });

    panel.querySelector("#scdm-download-all").addEventListener("click", () => {
      bulkDownload([...tracks.values()]);
    });

    syncDownloadModeUi();
  }

  function setPanelStatus(text, kind = "info") {
    const el = document.getElementById("scdm-status");
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
  }

  function setProgress(percent) {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    const el = document.getElementById("scdm-progress-fill");
    const number = document.getElementById("scdm-progress-number");
    if (el) el.style.width = `${value}%`;
    if (number) number.textContent = `${Math.round(value)}%`;
  }

  function updatePanelCounts() {
    const found = tracks.size;
    let selected = 0;
    for (const t of tracks.values()) if (t.selected) selected += 1;

    const f = document.getElementById("scdm-found");
    const s = document.getElementById("scdm-selected");
    if (f) f.textContent = String(found);
    if (s) s.textContent = String(selected);

    const selectedBtn = document.getElementById("scdm-download-selected");
    const allBtn = document.getElementById("scdm-download-all");
    if (selectedBtn) {
      selectedBtn.textContent = selected > 0 ? `دانلود ${selected} انتخاب‌شده` : "دانلود انتخاب‌شده";
      selectedBtn.disabled = selected === 0 || downloading;
    }
    if (allBtn) {
      allBtn.textContent = found > 0 ? `دانلود همه (${found})` : "دانلود همه";
      allBtn.disabled = found === 0 || downloading;
    }
  }

  function statusIcon(track) {
    if (track.status === "done") return "✓";
    if (track.status === "error") return "!";
    if (track.status === "loading") return "…";
    return "";
  }

  function renderPanelList() {
    const list = document.getElementById("scdm-track-list");
    if (!list) return;

    const items = [...tracks.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
    const scrollTop = list.scrollTop;
    const frag = document.createDocumentFragment();
    const shown = items.slice(0, 300);

    for (const track of shown) {
      const row = document.createElement("div");
      row.className = "scdm-row";
      if (track.status === "error") row.classList.add("is-error");
      if (track.status === "done") row.classList.add("is-done");
      if (track.status === "loading") row.classList.add("is-loading");

      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = Boolean(track.selected);
      check.addEventListener("change", () => selectTrack(track.url, check.checked));

      const text = document.createElement("div");
      text.className = "scdm-row-text";

      const title = document.createElement("div");
      title.className = "scdm-row-title";
      title.textContent = track.title || "Untitled";

      const artist = document.createElement("div");
      artist.className = "scdm-row-artist";
      artist.textContent = track.error || track.artist || "";

      const meter = document.createElement("div");
      meter.className = "scdm-row-meter";
      const meterBar = document.createElement("span");
      meterBar.style.width = `${Math.max(0, Math.min(100, Number(track.progress) || 0))}%`;
      const meterLabel = document.createElement("small");
      if (track.status === "loading") {
        meterLabel.textContent = `${Math.round(track.progress || 0)}% · ${progressStageLabel(track.stage)}`;
      } else if (track.status === "done") {
        meterLabel.textContent = settings.useFdm && track.stage === "fdm" ? "Sent to FDM" : "Saved";
      } else if (track.status === "error") {
        meterLabel.textContent = "Failed";
      } else {
        meterLabel.textContent = "Ready";
      }
      const meterTrack = document.createElement("div");
      meterTrack.className = "scdm-row-meter-track";
      meterTrack.appendChild(meterBar);
      meter.append(meterTrack, meterLabel);

      text.append(title, artist, meter);

      const dl = document.createElement("button");
      dl.type = "button";
      dl.className = "scdm-row-download";
      dl.title = "دانلود همین ترک";
      dl.textContent = statusIcon(track) || "↓";
      dl.addEventListener("click", async () => {
        if (downloading) return;
        dl.textContent = "…";
        const result = await downloadOne(track, {
          folder: folderForSingle(),
          index: 1,
          total: 1,
        });
        dl.textContent = result.ok ? "✓" : "!";
        setTimeout(() => renderPanelList(), 1200);
      });

      row.append(check, text, dl);
      frag.appendChild(row);
    }

    if (items.length > shown.length) {
      const note = document.createElement("div");
      note.className = "scdm-list-note";
      note.textContent = `نمایش ${shown.length} مورد اول از ${items.length}`;
      frag.appendChild(note);
    }

    list.replaceChildren(frag);
    list.scrollTop = scrollTop;
  }

  async function autoScrollLoad() {
    const startY = window.scrollY;
    let stable = 0;
    let lastCount = tracks.size;
    let lastHeight = document.documentElement.scrollHeight;

    setPanelStatus("در حال Auto-load کردن ترک‌های صفحه…");

    for (let round = 0; round < 90; round++) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      await sleep(780);

      // MutationObserver collects only newly inserted rows; do not rescan the full document here.
      const count = tracks.size;
      const height = document.documentElement.scrollHeight;

      if (count === lastCount && height === lastHeight) stable += 1;
      else stable = 0;

      lastCount = count;
      lastHeight = height;
      setPanelStatus(`Auto-load: ${count} ترک پیدا شده…`);

      if (stable >= 5 || count >= 2000) break;
    }

    window.scrollTo({ top: startY, behavior: "instant" });
    await sleep(250);
    scheduleCountUpdate();
    return tracks.size;
  }

  async function loadFullCollection() {
    if (loadingCollection || downloading) return;
    loadingCollection = true;

    const btn = document.getElementById("scdm-load-all");
    if (btn) btn.disabled = true;

    setProgress(8);
    setPanelStatus("در حال دریافت لیست کامل از SoundCloud…");

    const response = await send({
      type: "GET_COLLECTION_TRACKS",
      url: location.href,
      credentials: getCredentials(),
    });

    if (response?.ok && Array.isArray(response.tracks) && response.tracks.length) {
      response.tracks.forEach((t, i) => upsertTrack({ ...t, index: t.index || i + 1 }));
      setProgress(100);
      setPanelStatus(
        `${response.tracks.length} ترک از ${response.source || "API"} دریافت شد.`,
        "success"
      );
      renderPanelList();
      updatePanelCounts();
    } else {
      setProgress(25);
      setPanelStatus(
        `API کامل در دسترس نبود؛ در حال جمع‌آوری از خود صفحه…${response?.error ? " (" + response.error.slice(0, 90) + ")" : ""}`,
        "warning"
      );
      const count = await autoScrollLoad();
      setProgress(100);
      renderPanelList();
      updatePanelCounts();
      setPanelStatus(`${count} ترک از صفحه جمع‌آوری شد.`, count ? "success" : "error");
    }

    if (btn) btn.disabled = false;
    loadingCollection = false;
  }

  async function bulkDownload(inputTracks) {
    if (downloading) {
      showToast("یک دانلود گروهی در حال اجراست.", "warning");
      return;
    }

    const list = [...new Map(inputTracks.filter(Boolean).map(t => [t.url, t])).values()];
    if (!list.length) {
      showToast("هیچ آهنگی برای دانلود انتخاب نشده.", "warning");
      return;
    }

    downloading = true;
    const panel = document.getElementById(PANEL_ID);
    panel?.classList.add("busy");

    const folder = folderForPage();
    let ok = 0;
    let failed = 0;

    setProgress(0);
    setPanelStatus(`شروع دانلود ${list.length} ترک در ${folder}…`);

    for (let i = 0; i < list.length; i++) {
      const track = list[i];
      setPanelStatus(`دانلود ${i + 1}/${list.length}: ${track.artist ? track.artist + " - " : ""}${track.title}`);

      let result = await downloadOne(track, {
        folder,
        index: i + 1,
        total: list.length,
        bulk: true,
        bulkIndex: i,
        bulkTotal: list.length,
      });

      if (!result.ok && /API (401|403|429|5\d\d)|client_id|Stream URL/i.test(result.error || "")) {
        await sleep(1700);
        credentialsCache = null;
        result = await downloadOne(track, {
          folder,
          index: i + 1,
          total: list.length,
          bulk: true,
          bulkIndex: i,
          bulkTotal: list.length,
        });
      }

      if (result.ok) ok += 1;
      else failed += 1;

      setProgress(((i + 1) / list.length) * 100);
      updatePanelCounts();
      await sleep(500);
    }

    downloading = false;
    bulkProgressContext = null;
    panel?.classList.remove("busy");

    setPanelStatus(
      failed
        ? `پایان: ${ok} موفق، ${failed} ناموفق. فایل‌ها داخل Downloads/${folder}/ هستند.`
        : `تمام شد: ${ok} ترک داخل Downloads/${folder}/ ذخیره شد.`,
      failed ? "warning" : "success"
    );

    showToast(
      failed ? `${ok} دانلود موفق / ${failed} ناموفق` : `${ok} آهنگ با موفقیت پردازش شد.`,
      failed ? "warning" : "success",
      5000
    );
  }

  function resetForNavigation() {
    currentUrl = location.href;
    credentialsCache = null;
    tracks.clear();

    // SPA navigation usually replaces rows itself. Remove only our injected wrappers.
    for (const el of document.querySelectorAll(".scdm-inline-wrap")) el.remove();
    for (const el of document.querySelectorAll(`[${MARK_ATTR}]`)) el.removeAttribute(MARK_ATTR);

    setProgress(0);
    activeDownloadRequest = null;
    bulkProgressContext = null;
    requestTrackMap.clear();
    setPanelStatus("صفحه تغییر کرد؛ در حال اسکن اولیه…");
    renderPanelList();
    updatePanelCounts();
    initialScan();
  }

  function initialScan() {
    // One full scan only at startup/navigation, scheduled during an idle period when possible.
    const run = () => {
      scanRoot(document);
      scheduleCountUpdate();
    };
    if ("requestIdleCallback" in window) {
      requestIdleCallback(run, { timeout: 1200 });
    } else {
      setTimeout(run, 250);
    }
  }

  ensurePanel();
  initialScan();

  const observer = new MutationObserver(mutations => {
    // Ignore attribute/text mutations entirely; only new SoundCloud nodes matter.
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node;
        if (el.id === PANEL_ID || el.id === TOAST_ID || el.classList?.contains("scdm-inline-wrap")) continue;
        scheduleRootScan(el);

      }
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Lightweight route watcher only. No periodic DOM scan.
  routeTimer = setInterval(() => {
    if (location.href !== currentUrl) resetForNavigation();
  }, 1200);

  loadSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.adAssistEnabled) settings.adAssistEnabled = changes.adAssistEnabled.newValue !== false;
    if (changes.adMute) settings.adMute = changes.adMute.newValue !== false;
    if (changes.adAccelerate) settings.adAccelerate = changes.adAccelerate.newValue !== false;
    if (changes.adAutoSkip) settings.adAutoSkip = changes.adAutoSkip.newValue !== false;
    if (changes.useFdm) settings.useFdm = changes.useFdm.newValue === true;
    if (changes.adSpeed) {
      settings.adSpeed = Math.max(1, Math.min(16, Number(changes.adSpeed.newValue) || 16));
    }

    syncAdAssistUi();
    syncDownloadModeUi();
    sendAdConfigToMain();
  });

  window.addEventListener("pagehide", () => {
    observer.disconnect();
    if (routeTimer) clearInterval(routeTimer);
    if (mutationTimer) clearTimeout(mutationTimer);
    if (countTimer) clearTimeout(countTimer);
  }, { once: true });

  send({
    type: "UPDATE_CREDENTIALS",
    credentials: getCredentials(),
  });

  console.log(`[SoundCloud Pro Download Manager] v${VERSION} active; MAIN ad engine bridge connected`);
})();
