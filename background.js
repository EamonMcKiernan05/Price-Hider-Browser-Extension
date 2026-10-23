// Price Hider - service worker.
// Seeds defaults, and sets a per-tab badge showing how many prices were masked.

const DEFAULTS = {
  enabled: true,
  mode: "blur",
  peek: true,
  siteOnly: false,
  extraSelectors: [],
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (current) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...current });
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "pb:count" && sender.tab && sender.tab.id != null) {
    chrome.action.setBadgeText({
      tabId: sender.tab.id,
      text: msg.count ? String(msg.count) : "",
    });
    chrome.action.setBadgeBackgroundColor({ color: "#1b1b1f" });
  }
});
