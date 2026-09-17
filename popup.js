async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function pageKind(urlString) {
  try {
    const u = new URL(urlString);
    const p = u.pathname.split("/").filter(Boolean);
    if (p[0] === "discover" && p[1] === "sets") return "Discover Set";
    if (p.length >= 3 && p[1] === "sets") return "Playlist";
    if (p.length === 1 && p[0]) return "User";
    if (p.length === 2 && ["tracks", "popular-tracks"].includes(p[1])) return "User Tracks";
    return "SoundCloud";
  } catch (_) {
    return "—";
  }
}

function renderToggle(button, enabled) {
  button.classList.toggle("is-on", enabled);
  button.setAttribute("aria-pressed", String(enabled));
}

async function init() {
  const tab = await getActiveTab();
  const status = document.getElementById("pageStatus");
  const badge = document.getElementById("pageBadge");
  const adToggle = document.getElementById("adToggle");
  const fdmToggle = document.getElementById("fdmToggle");

  const stored = await chrome.storage.local.get({
    adAssistEnabled: true,
    adMute: true,
    adAccelerate: true,
    adSpeed: 16,
    adAutoSkip: true,
    useFdm: false,
  });

  let adEnabled = stored.adAssistEnabled !== false;
  let useFdm = stored.useFdm === true;
  renderToggle(adToggle, adEnabled);
  renderToggle(fdmToggle, useFdm);

  adToggle.addEventListener("click", async () => {
    adEnabled = !adEnabled;
    renderToggle(adToggle, adEnabled);
    await chrome.storage.local.set({
      adAssistEnabled: adEnabled,
      adMute: true,
      adAccelerate: true,
      adSpeed: 16,
      adAutoSkip: true,
    });
  });

  fdmToggle.addEventListener("click", async () => {
    useFdm = !useFdm;
    renderToggle(fdmToggle, useFdm);
    await chrome.storage.local.set({ useFdm });
  });

  if (tab?.url?.startsWith("https://soundcloud.com/")) {
    status.textContent = "افزونه روی این صفحه فعال است";
    badge.textContent = pageKind(tab.url);
  } else {
    status.textContent = "یک صفحه SoundCloud باز کنید";
    badge.textContent = "OFF";
  }

  document.getElementById("reload").addEventListener("click", async () => {
    if (tab?.id && tab?.url?.startsWith("https://soundcloud.com/")) {
      await chrome.tabs.reload(tab.id);
      window.close();
    }
  });
}

init();
