const DEFAULTS = {
  enabled: true,
  mode: "blur",
  peek: true,
  siteOnly: false,
  extraSelectors: [],
};

const $ = (id) => document.getElementById(id);

let activeTab = null;

const setActiveTab = () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    activeTab = tabs[0] || null;
    refreshStats();
  });
};

const refreshStats = () => {
  if (!activeTab || activeTab.id == null) return;
  chrome.tabs.sendMessage(activeTab.id, { type: "pb:stats" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      // No content script: not loaded yet, or a restricted page
      $("count").textContent = "–";
      $("site").textContent = "reload tab";
      $("hint").textContent =
        "This page can't be read (chrome:// page, web store, or the extension was just installed). Reload the tab.";
      return;
    }
    $("count").textContent = String(res.masked);
    $("site").textContent = res.site || "—";

    const on = $("enabled").checked;
    $("dot").classList.toggle("on", on && !res.siteOnlySkip);
    $("stateText").textContent = !on
      ? "Off for now"
      : res.siteOnlySkip
        ? "Not a shopping site — skipped"
        : `Masking prices on ${res.site}`;

    $("hint").textContent = on
      ? "Hold Shift on the page to compare prices."
      : "Turn it on and reload if prices still show.";
  });
};

const render = (s) => {
  $("enabled").checked = !!s.enabled;
  $("peek").checked = !!s.peek;
  $("siteOnly").checked = !!s.siteOnly;
  $("modeBlur").setAttribute("aria-pressed", String(s.mode !== "hide"));
  $("modeHide").setAttribute("aria-pressed", String(s.mode === "hide"));
  $("selectorCount").textContent = String((s.extraSelectors || []).length);
  $("dot").classList.toggle("on", !!s.enabled);
};

const save = (patch) => {
  chrome.storage.sync.get(DEFAULTS, (cur) => {
    const next = { ...cur, ...patch };
    chrome.storage.sync.set(next, () => {
      render(next);
      // Give the content script a beat to react, then re-read the count
      setTimeout(refreshStats, 220);
    });
  });
};

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(DEFAULTS, (s) => {
    render(s);
    setActiveTab();
  });

  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("peek").addEventListener("change", (e) => save({ peek: e.target.checked }));
  $("siteOnly").addEventListener("change", (e) => save({ siteOnly: e.target.checked }));

  $("modeBlur").addEventListener("click", () => save({ mode: "blur" }));
  $("modeHide").addEventListener("click", () => save({ mode: "hide" }));

  $("rescan").addEventListener("click", () => {
    if (!activeTab || activeTab.id == null) return;
    chrome.tabs.sendMessage(activeTab.id, { type: "pb:rescan" }, () => {
      setTimeout(refreshStats, 350);
    });
  });

  $("extra").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const value = e.target.value.trim();
    if (!value) return;

    // Validate the selector before saving it
    try {
      document.createDocumentFragment().querySelector(value);
    } catch {
      $("warn").classList.add("show");
      setTimeout(() => $("warn").classList.remove("show"), 2600);
      return;
    }

    chrome.storage.sync.get(DEFAULTS, (cur) => {
      const list = Array.from(new Set([...(cur.extraSelectors || []), value]));
      save({ extraSelectors: list });
      e.target.value = "";
    });
  });
});
