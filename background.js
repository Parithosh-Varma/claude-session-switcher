// Background worker: keyboard shortcuts (next/prev channel) + badge upkeep.
importScripts("shared.js");

async function activeSite() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { tab: active || null, site: siteOfUrl(active && active.url) };
}

async function siteTab(site) {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && siteOfUrl(active.url) === site) return active;
  const patterns = SITES[site].match.map((m) => `*://*.${m}/*`);
  const tabs = await chrome.tabs.query({ url: patterns });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    return tabs[0];
  }
  return null;
}

async function cycle(dir) {
  const { tab } = await activeSite();
  let site = tab ? siteOfUrl(tab.url) : null;
  if (!site) {
    const { uiSite } = await chrome.storage.local.get("uiSite");
    site = SITE_IDS.includes(uiSite) ? uiSite : "claude";
  }
  const profiles = await getProfiles(site);
  const keys = sortedKeys(profiles);
  if (keys.length === 0) return;
  const store = await chrome.storage.local.get(K(site, "lastActive"));
  const lastActive = store[K(site, "lastActive")];
  let i = keys.indexOf(lastActive);
  i = i < 0 ? (dir > 0 ? 0 : keys.length - 1) : (i + dir + keys.length) % keys.length;
  const target = (tab && siteOfUrl(tab.url) === site) ? tab : await siteTab(site);
  await coreSwitchTo(site, keys[i], target);
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "next-account") cycle(1).catch(() => {});
  else if (command === "prev-account") cycle(-1).catch(() => {});
});

let badgeT = 0;
async function refreshBadge() {
  const now = Date.now();
  if (now - badgeT < 2000) return;
  badgeT = now;
  try {
    const { tab } = await activeSite();
    const site = (tab && siteOfUrl(tab.url)) || "claude";
    const { key } = await detectLiveKey(site);
    if (tab && tab.id) {
      try {
        const icon = site === "chatgpt" ? "chatgpt" : "claude";
        await chrome.action.setIcon({ tabId: tab.id, path: {
          16: `icons/${icon}-16.png`, 48: `icons/${icon}-48.png`, 128: `icons/${icon}-128.png`,
        } });
      } catch (e) {}
    }
    if (key) { await setBadge(site, key); return; }
    const store = await chrome.storage.local.get(K(site, "lastActive"));
    await setBadge(site, store[K(site, "lastActive")] || null);
  } catch (e) {}
}

function isWatched(url) {
  return !!siteOfUrl(url);
}

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.tabs.onActivated.addListener(refreshBadge);
chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (isWatched(tab.url)) maybeRefreshSaves(siteOfUrl(tab.url), tab.id).catch(() => {});
  } catch (e) {}
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && isWatched(tab.url)) {
    maybeRefreshSaves(siteOfUrl(tab.url), tabId).catch(() => {});
    refreshBadge();
  }
});
chrome.cookies.onChanged.addListener((info) => {
  if (!info.cookie) return;
  for (const id of SITE_IDS) {
    if (isRelevant(id, info.cookie.domain)) { refreshBadge(); return; }
  }
});
