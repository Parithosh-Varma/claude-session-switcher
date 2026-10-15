// Shared core: cookies + storage + switch + backup history + audit + transfer.
// No DOM here (loaded by popup AND service worker). Firefox: load firefox-shim.js first.

const SUFFIXES = ["claude.ai", "anthropic.com"];
const AUTO_KEY = "__previous";
const AUTO_LABEL = "Previous · auto";
const STALE_DAYS = 30;
const AUTO_HIST_MAX = 5;

function displayName(key) {
  return key === AUTO_KEY ? AUTO_LABEL : key;
}

function isRelevant(domain) {
  const d = domain.startsWith(".") ? domain.slice(1).toLowerCase() : domain.toLowerCase();
  return SUFFIXES.some((s) => d === s || d.endsWith("." + s));
}

function cookieUrl(c) {
  const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  const scheme = c.secure ? "https://" : "http://";
  return scheme + domain + (c.path || "/");
}

async function getRelevantCookies() {
  const all = await chrome.cookies.getAll({});
  const seen = new Map();
  for (const c of all) {
    if (!isRelevant(c.domain)) continue;
    seen.set(`${c.name}|${c.domain}|${c.path}|${c.storeId}`, c);
  }
  return [...seen.values()];
}

async function clearRelevantCookies() {
  const cookies = await getRelevantCookies();
  await Promise.allSettled(
    cookies.map((c) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId }))
  );
}

function buildSetParams(c) {
  const params = {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  const hostOnly = c.hostOnly || c.name.startsWith("__Host-");
  if (!hostOnly && c.domain) params.domain = c.domain;
  if (c.sameSite && c.sameSite !== "unspecified") params.sameSite = c.sameSite;
  if (c.expirationDate && c.expirationDate > Date.now() / 1000 + 60) {
    params.expirationDate = c.expirationDate;
  }
  if (c.partitionKey) params.partitionKey = c.partitionKey;
  if (c.storeId) params.storeId = c.storeId;
  return params;
}

async function setRelevantCookies(cookies) {
  let ok = 0;
  const failed = [];
  for (const c of cookies) {
    const params = buildSetParams(c);
    try {
      await chrome.cookies.set(params);
      ok++;
    } catch (e1) {
      try {
        delete params.domain;
        await chrome.cookies.set(params);
        ok++;
      } catch (e2) {
        failed.push({ name: c.name, error: String((e2 && e2.message) || e2) });
      }
    }
  }
  const after = await getRelevantCookies();
  const afterNames = new Set(after.map((c) => c.name));
  const missing = cookies.filter((c) => !afterNames.has(c.name)).map((c) => c.name);
  return { ok, failed, missing, afterCount: after.length };
}

// NOTE: these two run inside the claude.ai page (serialized via scripting).
function dumpStorage() {
  const out = { local: {}, session: {} };
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    for (const k of keys) out.local[k] = localStorage.getItem(k);
  } catch (e) {}
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
    for (const k of keys) out.session[k] = sessionStorage.getItem(k);
  } catch (e) {}
  return out;
}

function restoreStorage(data) {
  try {
    localStorage.clear();
    for (const [k, v] of Object.entries((data && data.local) || {})) localStorage.setItem(k, v);
  } catch (e) { return "localStorage failed: " + e; }
  try {
    sessionStorage.clear();
    for (const [k, v] of Object.entries((data && data.session) || {})) sessionStorage.setItem(k, v);
  } catch (e) { return "sessionStorage failed: " + e; }
  return "ok";
}

async function runInTab(tabId, func, args) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
    return res[0]?.result;
  } catch (e) {
    const res = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return res[0]?.result;
  }
}

async function waitForComplete(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
    } catch (e) { return null; }
    await new Promise((r) => setTimeout(r, 300));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

async function getProfiles() {
  const { profiles = {} } = await chrome.storage.local.get("profiles");
  return profiles;
}

async function setProfiles(profiles) {
  await chrome.storage.local.set({ profiles });
}

async function getHist() {
  const { autoHistory = [] } = await chrome.storage.local.get("autoHistory");
  return autoHistory;
}

async function setBadge(key) {
  const label = key ? displayName(key) : "";
  const m = label.match(/[A-Za-z0-9]/);
  try {
    await chrome.action.setBadgeText({ text: key ? (m ? m[0].toUpperCase() : "•") : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#c96f42" });
    await chrome.action.setTitle({ title: key ? `Claude Session Switcher — live: ${label}` : "Claude Session Switcher" });
  } catch (e) {}
}

// Health of a SAVED profile (heuristic: expired cookies, missing session, old save).
function profileHealth(p) {
  const cookies = (p && p.cookies) || [];
  if (cookies.length === 0) return { level: "bad", msg: "empty save" };
  const names = cookies.map((c) => c.name);
  if (!names.includes("sessionKey")) return { level: "bad", msg: "no session cookie" };
  const now = Date.now() / 1000;
  const expired = cookies.filter((c) => c.expirationDate && c.expirationDate < now);
  if (expired.length > 0) return { level: "warn", msg: `${expired.length} expired cookie${expired.length > 1 ? "s" : ""}` };
  if (p.savedAt && Date.now() - p.savedAt > STALE_DAYS * 86400000) {
    return { level: "warn", msg: "old save, may be stale" };
  }
  return { level: "ok", msg: "" };
}

function cookieSig(cookies) {
  return new Set((cookies || []).map((c) => `${c.name}=${c.value}`));
}

function sameSig(a, b) {
  if (!a || !b || a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

// Which saved profile matches what is live right now? Null when logged out / unknown.
async function detectLiveKey() {
  const live = cookieSig(await getRelevantCookies());
  if (live.size === 0) return { key: null, loggedOut: true };
  const profiles = await getProfiles();
  for (const k of Object.keys(profiles)) {
    if (sameSig(live, cookieSig(profiles[k].cookies))) return { key: k, loggedOut: false };
  }
  // Fallback: match on sessionKey value alone (storage may differ after navigation).
  const sessionVal = [...live].find((s) => s.startsWith("sessionKey="));
  if (sessionVal) {
    for (const k of Object.keys(profiles)) {
      if (cookieSig(profiles[k].cookies).has(sessionVal)) return { key: k, loggedOut: false, partial: true };
    }
  }
  return { key: null, loggedOut: false };
}

// Structural audit of a save: does it look restorable? Returns [{ok, label}].
function auditProfile(p) {
  const checks = [];
  const cookies = (p && p.cookies) || [];
  checks.push({ ok: cookies.length > 0, label: cookies.length > 0 ? `${cookies.length} cookies saved` : "no cookies saved" });
  const names = cookies.map((c) => c.name);
  checks.push({ ok: names.includes("sessionKey"), label: names.includes("sessionKey") ? "sessionKey present" : "sessionKey MISSING — save while logged in" });
  const now = Date.now() / 1000;
  const expired = cookies.filter((c) => c.expirationDate && c.expirationDate < now);
  checks.push({ ok: expired.length === 0, label: expired.length === 0 ? "no expired cookies" : `expired: ${expired.map((c) => c.name).join(", ")}` });
  const keys = Object.keys((p && p.storage && p.storage.local) || {}).length;
  checks.push({ ok: keys > 0, label: keys > 0 ? `${keys} localStorage keys` : "no localStorage captured" });
  return checks;
}

// Snapshot whatever is live right now. Null when logged out.
async function snapshotLive(tabId, url) {
  const cookies = await getRelevantCookies();
  if (cookies.length === 0) return null;
  const storage = await runInTab(tabId, dumpStorage, []);
  return { cookies, storage, savedAt: Date.now(), url };
}

async function pushHistory(snap) {
  if (!snap) return;
  const hist = await getHist();
  hist.unshift(snap);
  await chrome.storage.local.set({ autoHistory: hist.slice(0, AUTO_HIST_MAX) });
}

// Low-level restore of any snapshot (profile or history entry). No backup here.
async function coreRestoreSnapshot(snap, tab) {
  await clearRelevantCookies();
  const res = await setRelevantCookies(snap.cookies || []);
  const storeRes = await runInTab(tab.id, restoreStorage, [snap.storage || { local: {}, session: {} }]);
  await chrome.tabs.reload(tab.id);
  return { res, storeRes };
}

// Full switch: auto-backup current (+ history), restore target, reload, badge.
// On failure, rolls back to the pre-switch session.
async function coreSwitchTo(name, tab) {
  const profiles = await getProfiles();
  const target = profiles[name];
  if (!target) return { level: "error", message: `Unknown channel “${displayName(name)}”.` };

  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://claude.ai/" });
    tab = await waitForComplete(tab.id) || tab;
  }

  let prevLive = null;
  try {
    prevLive = await snapshotLive(tab.id, tab.url);
  } catch (e) { prevLive = null; }

  try {
    if (prevLive && !sameSig(cookieSig(prevLive.cookies), cookieSig(target.cookies))) {
      if (profiles[AUTO_KEY]) await pushHistory(profiles[AUTO_KEY]);
      profiles[AUTO_KEY] = prevLive;
      await setProfiles(profiles);
    }

    const { res, storeRes } = await coreRestoreSnapshot(target, tab);
    await chrome.storage.local.set({ lastActive: name });
    await setBadge(name);

    let level = "success";
    let message = `Live on “${displayName(name)}” — ${res.ok} cookies, storage ${storeRes}.`;
    if (res.missing.length > 0 || res.failed.length > 0) {
      level = "warn";
      message = `Live with warnings: ${res.ok} set, missing [${res.missing.join(", ")}]. If login fails, log in and patch over “${displayName(name)}”.`;
    }
    const restoredSess = ((target.cookies || []).find((c) => c.name === "sessionKey") || {}).value || null;
    await chrome.storage.local.set({ lastSwitch: { to: name, at: Date.now(), level, missing: res.missing, sessionKey: restoredSess } });
    return { level, message };
  } catch (e) {
    try {
      if (prevLive) await coreRestoreSnapshot(prevLive, tab);
    } catch (rb) {}
    const message = `Switch to “${displayName(name)}” failed (${(e && e.message) || e}). Rolled back — reload the tab if it looks logged out.`;
    await chrome.storage.local.set({ lastSwitch: { to: name, at: Date.now(), level: "error", missing: [] } });
    return { level: "error", message };
  }
}

// Silently refresh a matching save while the user browses, so snapshots
// don't go stale. Strict rules:
//  1. Exact sessionKey match => same session => safe to refresh (throttled).
//     Storage is only overwritten when the live page is hydrated, so a
//     half-loaded page can never wipe a save.
//  2. Rotation is accepted ONLY for the profile we restored ourselves
//     (lastActive + recorded sessionKey + 30 min window). Cross-profile
//     guessing by cookie similarity is banned: two accounts on one machine
//     look nearly identical and would clobber each other.
async function maybeRefreshSaves(tabId) {
  try {
    const liveCookies = await getRelevantCookies();
    if (liveCookies.length === 0) return;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (!tab || !tab.url || !tab.url.includes("claude.ai")) return;
    const liveSess = (liveCookies.find((c) => c.name === "sessionKey") || {}).value || null;

    const profiles = await getProfiles();
    for (const k of Object.keys(profiles)) {
      if (k === AUTO_KEY) continue;
      const saved = profiles[k];
      const savedSess = ((saved.cookies || []).find((c) => c.name === "sessionKey") || {}).value || null;
      if (!liveSess || !savedSess || liveSess !== savedSess) continue;
      if (Date.now() - (saved.refreshedAt || 0) < 5 * 60 * 1000) return;
      const storage = await runInTab(tab.id, dumpStorage, []);
      const savedKeys = Object.keys((saved.storage && saved.storage.local) || {}).length;
      const liveKeys = Object.keys((storage && storage.local) || {}).length;
      if (liveKeys === 0 && savedKeys > 0) return;
      profiles[k] = { cookies: liveCookies, storage, savedAt: saved.savedAt, refreshedAt: Date.now(), url: tab.url };
      await setProfiles(profiles);
      return;
    }

    const store = await chrome.storage.local.get(["lastActive", "lastSwitch"]);
    const lastActive = store.lastActive, lastSwitch = store.lastSwitch;
    if (lastSwitch && lastActive && lastSwitch.to === lastActive && Date.now() - (lastSwitch.at || 0) < 30 * 60 * 1000) {
      const p = profiles[lastActive];
      const savedSess = (p && (p.cookies || []).find((c) => c.name === "sessionKey") || {}).value || null;
      if (p && lastActive !== AUTO_KEY && lastSwitch.sessionKey && liveSess &&
          savedSess === lastSwitch.sessionKey && liveSess !== lastSwitch.sessionKey) {
        const storage = await runInTab(tab.id, dumpStorage, []);
        const liveKeys = Object.keys((storage && storage.local) || {}).length;
        profiles[lastActive] = {
          cookies: liveCookies,
          storage: liveKeys > 0 ? storage : p.storage,
          savedAt: p.savedAt, refreshedAt: Date.now(), url: tab.url,
        };
        await setProfiles(profiles);
        lastSwitch.sessionKey = liveSess;
        await chrome.storage.local.set({ lastSwitch });
      }
    }
  } catch (e) {}
}

function sortedKeys(profiles, includeAuto = false) {
  return Object.keys(profiles).sort().filter((k) => includeAuto || k !== AUTO_KEY);
}

// ---- Encrypted export / import (AES-GCM + PBKDF2, WebCrypto) ----

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function exportProfiles(password) {
  if (!password) throw new Error("password required");
  const profiles = await getProfiles();
  const hist = await getHist();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const data = new TextEncoder().encode(JSON.stringify({ profiles, autoHistory: hist }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  return JSON.stringify({ app: "claude-session-switcher", v: 1, exportedAt: Date.now(), salt: b64(salt), iv: b64(iv), data: b64(ct) });
}

async function importProfiles(fileText, password) {
  if (!password) throw new Error("password required");
  let wrap;
  try { wrap = JSON.parse(fileText); } catch (e) { throw new Error("not a valid export file"); }
  if (wrap.app !== "claude-session-switcher" || !wrap.data) throw new Error("not a valid export file");
  const key = await deriveKey(password, unb64(wrap.salt));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(wrap.iv) }, key, unb64(wrap.data));
  } catch (e) { throw new Error("wrong password or corrupted file"); }
  const { profiles: incoming = {} } = JSON.parse(new TextDecoder().decode(plain));
  if (typeof incoming !== "object") throw new Error("not a valid export file");

  const current = await getProfiles();
  let added = 0, renamed = 0, skipped = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (!v || !Array.isArray(v.cookies)) { skipped++; continue; }
    if (!current[k]) { current[k] = v; added++; }
    else if (JSON.stringify(current[k].cookies) === JSON.stringify(v.cookies)) { skipped++; }
    else { current[`${k} (imported)`] = v; renamed++; }
  }
  await setProfiles(current);
  return { added, renamed, skipped };
}
