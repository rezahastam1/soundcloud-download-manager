(() => {
  "use strict";

  const VERSION = "3.0.1";
  const MSG_CONFIG = "SCDM_AD_CONFIG";
  const MSG_STATUS = "SCDM_AD_STATUS";

  if (window.__SCDM_AD_ENGINE_V300__) return;
  window.__SCDM_AD_ENGINE_V300__ = true;

  const config = {
    enabled: true,
    mute: true,
    accelerate: true,
    speed: 16,
    autoSkip: true,
  };

  const mediaSet = new Set();
  const saved = new Map();

  let active = false;
  let positiveTicks = 0;
  let negativeTicks = 0;
  let timer = null;
  let lastSkipClickAt = 0;
  let lastStatus = "";

  // SoundCloud audio ads commonly come through ad-serving infrastructure.
  // Keep this detector intentionally narrow to avoid false positives on normal tracks.
  const AD_SRC_RE =
    /(?:^|[/.])(adswizz|doubleclick|googlesyndication|googleadservices|adnxs|adsystem)(?:[./]|$)/i;

  const AD_CLASS_RE = /\bm-ad\b|advertisement/i;
  const AD_TEXT_RE = /^(?:ad|advertisement|sponsored)$/i;

  function postStatus(reason = "") {
    const payload = {
      source: "SCDM_MAIN_AD_ENGINE",
      type: MSG_STATUS,
      version: VERSION,
      enabled: config.enabled,
      active,
      reason,
      mediaCount: mediaSet.size,
    };

    const key = JSON.stringify(payload);
    if (key === lastStatus) return;
    lastStatus = key;

    window.postMessage(payload, "*");
  }

  function addMedia(el) {
    if (!(el instanceof HTMLMediaElement) || mediaSet.has(el)) return el;

    mediaSet.add(el);

    // Do not aggressively delete reusable SoundCloud media elements.
    // Only prune truly dead detached elements later.
    const onError = () => pruneMedia();
    el.addEventListener("error", onError, { passive: true });

    if (active && config.enabled) applyAdStateTo(el);

    return el;
  }

  function pruneMedia() {
    for (const el of mediaSet) {
      // Audio() objects often have no parent by design. Keep active/current media.
      const hasSource = Boolean(el.currentSrc || el.src);
      const alive = hasSource || !el.paused || el.readyState > 0;
      if (!alive && !el.isConnected) {
        mediaSet.delete(el);
        saved.delete(el);
      }
    }
  }

  function remember(el) {
    if (saved.has(el)) return;
    saved.set(el, {
      muted: el.muted,
      volume: el.volume,
      playbackRate: el.playbackRate,
      defaultPlaybackRate: el.defaultPlaybackRate,
      preservesPitch:
        "preservesPitch" in el ? el.preservesPitch : undefined,
    });
  }

  function applyAdStateTo(el) {
    try {
      remember(el);

      if (config.mute) {
        el.muted = true;
        el.volume = 0;
      }

      if (config.accelerate) {
        const speed = Math.max(1, Math.min(16, Number(config.speed) || 16));
        try { el.playbackRate = speed; } catch (_) {}
        try { el.defaultPlaybackRate = speed; } catch (_) {}
        try {
          if ("preservesPitch" in el) el.preservesPitch = false;
        } catch (_) {}
      }
    } catch (_) {}
  }

  function applyAdState() {
    for (const el of mediaSet) {
      if (!el.paused || el.readyState > 0 || el.currentSrc) {
        applyAdStateTo(el);
      }
    }
  }

  function restoreAll() {
    for (const [el, old] of saved.entries()) {
      try {
        el.muted = old.muted;
        el.volume = old.volume;
        el.playbackRate = old.playbackRate || 1;
        el.defaultPlaybackRate = old.defaultPlaybackRate || 1;
        if (old.preservesPitch !== undefined && "preservesPitch" in el) {
          el.preservesPitch = old.preservesPitch;
        }
      } catch (_) {}
    }
    saved.clear();
  }

  function sourceLooksLikeAd() {
    for (const el of mediaSet) {
      if (el.paused) continue;
      const src = String(el.currentSrc || el.src || "");
      if (src && AD_SRC_RE.test(src)) return src;
    }
    return "";
  }

  function playerClassLooksLikeAd() {
    const pc = document.querySelector(".playControls");
    if (!pc) return false;
    return AD_CLASS_RE.test(String(pc.className || ""));
  }

  function panelTextLooksLikeAd() {
    // Fallback only. SoundCloud changes UI frequently, so do not make this
    // the primary detector.
    const selectors = [
      ".playControlsPanel__header",
      ".playbackSoundBadge__title",
      ".playbackSoundBadge__lightLink",
      ".playControlsPanel",
    ];

    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = String(node.textContent || "")
          .replace(/\s+/g, " ")
          .trim();

        if (!text) continue;

        if (selector === ".playControlsPanel__header") {
          if (/\bAdvertisement\b/i.test(text) || AD_TEXT_RE.test(text)) return true;
        } else {
          // Only use exact/small-text matches in generic playback UI
          // to avoid matching words in normal titles/descriptions.
          if (text.length <= 40 && /\bAdvertisement\b/i.test(text)) return true;
        }
      }
    }
    return false;
  }

  function detectAd() {
    const source = sourceLooksLikeAd();
    if (source) return { ad: true, reason: "media-source" };

    if (playerClassLooksLikeAd()) {
      return { ad: true, reason: "playControls-class" };
    }

    if (panelTextLooksLikeAd()) {
      return { ad: true, reason: "player-text" };
    }

    return { ad: false, reason: "" };
  }

  function findSkipButton() {
    const candidates = [
      ".playControlsPanel__skipButton",
      "button[class*='skipButton']",
      "button[title*='Skip' i]",
      "button[aria-label*='Skip' i]",
    ];

    for (const selector of candidates) {
      const btn = document.querySelector(selector);
      if (btn instanceof HTMLButtonElement) return btn;
    }
    return null;
  }

  function skipAvailable(btn) {
    if (!(btn instanceof HTMLButtonElement)) return false;
    if (!btn.isConnected || btn.disabled) return false;
    if (btn.classList.contains("m-disabled")) return false;
    if (btn.getAttribute("aria-disabled") === "true") return false;
    return true;
  }

  function tryAutoSkip() {
    if (!config.autoSkip || !active) return;

    const btn = findSkipButton();
    if (!skipAvailable(btn)) return;

    const now = Date.now();
    if (now - lastSkipClickAt < 1000) return;
    lastSkipClickAt = now;

    try {
      btn.click();
      postStatus("auto-skip");
    } catch (_) {}
  }

  function enterAd(reason) {
    if (!active) {
      active = true;
      postStatus(reason || "detected");
    }
    applyAdState();
    tryAutoSkip();
  }

  function leaveAd() {
    if (!active) return;
    active = false;
    restoreAll();
    postStatus("ended");
  }

  function tick() {
    if (!config.enabled) {
      positiveTicks = 0;
      negativeTicks = 0;
      leaveAd();
      return;
    }

    // Pick up any DOM media too; this is cheap (usually zero/one element).
    document.querySelectorAll("audio,video").forEach(addMedia);

    const result = detectAd();

    if (result.ad) {
      positiveTicks++;
      negativeTicks = 0;

      // Fast response: one strong signal is enough.
      if (positiveTicks >= 1) enterAd(result.reason);
    } else {
      positiveTicks = 0;
      negativeTicks++;

      // Small hysteresis prevents restoring music state during a transient DOM update.
      if (negativeTicks >= 3) leaveAd();
    }

    if (active) {
      applyAdState();
      tryAutoSkip();
    }

    if ((performance.now() % 5000) < 320) pruneMedia();
  }

  // Capture Audio() objects that never enter the DOM.
  try {
    const NativeAudio = window.Audio;
    if (typeof NativeAudio === "function") {
      window.Audio = new Proxy(NativeAudio, {
        construct(target, args, newTarget) {
          const el = Reflect.construct(target, args, newTarget);
          addMedia(el);
          return el;
        },
      });
    }
  } catch (_) {}

  // Capture every media element at play-time, including hidden/detached Audio objects.
  try {
    const proto = HTMLMediaElement.prototype;
    if (!proto.__scdmAdPlayPatched) {
      const nativePlay = proto.play;
      Object.defineProperty(proto, "__scdmAdPlayPatched", {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });

      proto.play = function(...args) {
        addMedia(this);
        if (active && config.enabled) applyAdStateTo(this);
        return nativePlay.apply(this, args);
      };
    }
  } catch (_) {}

  // Optional extra capture for src changes through load().
  try {
    const proto = HTMLMediaElement.prototype;
    if (!proto.__scdmAdLoadPatched) {
      const nativeLoad = proto.load;
      Object.defineProperty(proto, "__scdmAdLoadPatched", {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });

      proto.load = function(...args) {
        addMedia(this);
        return nativeLoad.apply(this, args);
      };
    }
  } catch (_) {}

  // Receive settings from the isolated extension content script.
  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "SCDM_EXTENSION" || data.type !== MSG_CONFIG) return;

    if (typeof data.enabled === "boolean") config.enabled = data.enabled;
    if (typeof data.mute === "boolean") config.mute = data.mute;
    if (typeof data.accelerate === "boolean") config.accelerate = data.accelerate;
    if (typeof data.autoSkip === "boolean") config.autoSkip = data.autoSkip;

    const speed = Number(data.speed);
    if (Number.isFinite(speed)) config.speed = Math.max(1, Math.min(16, speed));

    if (!config.enabled) leaveAd();
    postStatus("config");
  }, false);

  // Start early enough to catch SoundCloud's first Audio object.
  timer = window.setInterval(tick, 300);

  // Initial DOM pickup when parser has created anything.
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("audio,video").forEach(addMedia);
  }, { once: true });

  window.addEventListener("pagehide", () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    leaveAd();
    mediaSet.clear();
    saved.clear();
  }, { once: true });

  postStatus("engine-ready");
})();
