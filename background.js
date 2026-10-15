// Background worker: keyboard shortcuts (next/prev channel) + badge upkeep.
importScripts("shared.js");

async function claudeTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && active.url && active.url.includes("claude.ai")) return active;
  const tabs = await chrome.tabs.query({ url: "*://*.claude.ai/*" });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0];
  }
  return null;
}

async function cycle(dir) {
  const profiles = await getProfiles();
  const keys = sortedKeys(profiles);
  if (keys.length === 0) return;
  const { lastActive } = await chrome.storage.local.get("lastActive");
  let i = keys.indexOf(lastActive);
  i = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : (i + dir + keys.length) % keys.length;
  const tab = await claudeTab();
  await coreSwitchTo(keys[i], tab);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "next-account") cycle(1).catch(() => {});
  else if (command === "prev-account") cycle(-1).catch(() => {});
});

let badgeT = 0;
function refreshBadge() {
  const now = Date.now();
  if (now - badgeT < 2000) return;
  badgeT = now;
  (async () => {
    try {
      const { key } = await detectLiveKey();
      if (key) { await setBadge(key); return; }
      const { lastActive } = await chrome.storage.local.get("lastActive");
      await setBadge(lastActive || null);
    } catch (e) {}
  })();
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.tabs.onActivated.addListener(refreshBadge);
chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie && isRelevant(info.cookie.domain)) refreshBadge();
});
