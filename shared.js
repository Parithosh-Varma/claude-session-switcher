// Shared core: session capture/restore/audit/vault, per site (Claude + ChatGPT).
// No DOM here (loaded by popup AND service worker). Firefox: load firefox-shim.js first.

const SITES = {
  claude: {
    label: "Claude",
    host: "claude.ai",
    home: "https://claude.ai/",
    match: ["claude.ai"],
    suffixes: ["claude.ai", "anthropic.com"],
    sessionCookies: ["sessionKey"],
  },
  chatgpt: {
    label: "ChatGPT",
    host: "chatgpt.com",
    home: "https://chatgpt.com/",
    match: ["chatgpt.com", "chat.openai.com"],
    suffixes: ["chatgpt.com", "openai.com", "auth0.com"],
    sessionCookies: ["__Secure-next-auth.session-token", "__Secure-next-auth.session-token.0"],
  },
};
const SITE_IDS = Object.keys(SITES);
const AUTO_KEY = "__previous";
const AUTO_LABEL = "Previous · auto";
const STALE_DAYS = 30;
const AUTO_HIST_MAX = 5;

function displayName(key) {
  return key === AUTO_KEY ? AUTO_LABEL : key;
}

// Storage keys: legacy flat keys stay Claude's (no migration needed).
function K(site, base) {
  return site === "claude" ? base : base + "_" + site;
}

function siteOfUrl(url) {
  if (!url) return null;
  for (const id of SITE_IDS) {
    if (SITES[id].match.some((m) => url.includes(m))) return id;
  }
  return null;
}

function isRelevant(site, domain) {
  const d = domain.startsWith(".") ? domain.slice(1).toLowerCase() : domain.toLowerCase();
  return SITES[site].suffixes.some((s) => d === s || d.endsWith("." + s));
}

function cookieUrl(c) {
  const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  const scheme = c.secure ? "https://" : "http://";
  return scheme + domain + (c.path || "/");
}

async function getRelevantCookies(site) {
  const all = await chrome.cookies.getAll({});
  const seen = new Map();
  for (const c of all) {
    if (!isRelevant(site, c.domain)) continue;
    seen.set(`${c.name}|${c.domain}|${c.path}|${c.storeId}`, c);
  }
  return [...seen.values()];
}

async function clearRelevantCookies(site) {
  const cookies = await getRelevantCookies(site);
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
  return { ok, failed };
}

// NOTE: these two run inside the site page (serialized via scripting).
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

async function getProfiles(site) {
  const { [K(site, "profiles")]: profiles = {} } = await chrome.storage.local.get(K(site, "profiles"));
  return profiles;
}

async function setProfiles(site, profiles) {
  await chrome.storage.local.set({ [K(site, "profiles")]: profiles });
}

async function getHist(site) {
  const { [K(site, "autoHistory")]: autoHistory = [] } = await chrome.storage.local.get(K(site, "autoHistory"));
  return autoHistory;
}

async function setBadge(site, key) {
  const label = key ? displayName(key) : "";
  const m = label.match(/[A-Za-z0-9]/);
  try {
    await chrome.action.setBadgeText({ text: key ? (m ? m[0].toUpperCase() : "•") : "" });
    await chrome.action.setBadgeBackgroundColor({ color: site === "chatgpt" ? "#3f8f6b" : "#c96f42" });
    await chrome.action.setTitle({ title: key ? `Session Switcher (${SITES[site].label}) — live: ${label}` : "Session Switcher" });
  } catch (e) {}
}

function sessionValue(site, cookies) {
  const names = SITES[site].sessionCookies;
  for (const n of names) {
    const c = (cookies || []).find((x) => x.name === n);
    if (c) return c.value;
  }
  return null;
}

// Health of a SAVED profile (heuristic: expired cookies, missing session, old save).
function profileHealth(site, p) {
  const cookies = (p && p.cookies) || [];
  if (cookies.length === 0) return { level: "bad", msg: "empty save" };
  if (!sessionValue(site, cookies)) return { level: "bad", msg: "no session cookie" };
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
async function detectLiveKey(site) {
  const cookies = await getRelevantCookies(site);
  const live = cookieSig(cookies);
  if (live.size === 0) return { key: null, loggedOut: true };
  const profiles = await getProfiles(site);
  for (const k of Object.keys(profiles)) {
    if (sameSig(live, cookieSig(profiles[k].cookies))) return { key: k, loggedOut: false };
  }
  const liveSess = sessionValue(site, cookies);
  if (liveSess) {
    for (const k of Object.keys(profiles)) {
      if (sessionValue(site, profiles[k].cookies) === liveSess) return { key: k, loggedOut: false, partial: true };
    }
  }
  return { key: null, loggedOut: false };
}

// Structural audit of a save: does it look restorable? Returns [{ok, label}].
function auditProfile(site, p) {
  const checks = [];
  const cookies = (p && p.cookies) || [];
  checks.push({ ok: cookies.length > 0, label: cookies.length > 0 ? `${cookies.length} cookies saved` : "no cookies saved" });
  const sessNames = SITES[site].sessionCookies.join(" / ");
  checks.push(sessionValue(site, cookies)
    ? { ok: true, label: "session cookie present" }
    : { ok: false, label: `session cookie MISSING (${sessNames}) — save while logged in` });
  const now = Date.now() / 1000;
  const expired = cookies.filter((c) => c.expirationDate && c.expirationDate < now);
  checks.push({ ok: expired.length === 0, label: expired.length === 0 ? "no expired cookies" : `expired: ${expired.map((c) => c.name).join(", ")}` });
  const keys = Object.keys((p && p.storage && p.storage.local) || {}).length;
  checks.push({ ok: keys > 0, label: keys > 0 ? `${keys} localStorage keys` : "no localStorage captured" });
  return checks;
}

// Snapshot whatever is live right now. Null when logged out.
async function snapshotLive(site, tabId, url) {
  const cookies = await getRelevantCookies(site);
  if (cookies.length === 0) return null;
  const storage = await runInTab(tabId, dumpStorage, []);
  return { cookies, storage, savedAt: Date.now(), url };
}

async function pushHistory(site, snap) {
  if (!snap) return;
  const hist = await getHist(site);
  hist.unshift(snap);
  await chrome.storage.local.set({ [K(site, "autoHistory")]: hist.slice(0, AUTO_HIST_MAX) });
}

// Low-level restore of any snapshot (profile or history entry). No backup here.
async function coreRestoreSnapshot(site, snap, tab) {
  await clearRelevantCookies(site);
  const res = await setRelevantCookies(snap.cookies || []);
  const verify = await verifyJar(site, snap.cookies || []);
  const storeRes = await runInTab(tab.id, restoreStorage, [snap.storage || { local: {}, session: {} }]);
  await chrome.tabs.reload(tab.id);
  return { res, storeRes, verify };
}

async function verifyJar(site, expected) {
  const live = await getRelevantCookies(site);
  const liveMap = new Map(live.map((c) => [c.name, c.value]));
  const missing = [], mismatched = [];
  for (const c of expected || []) {
    if (!liveMap.has(c.name)) missing.push(c.name);
    else if (SITES[site].sessionCookies.includes(c.name) && liveMap.get(c.name) !== c.value) mismatched.push(c.name);
  }
  return { missing, mismatched, liveNames: live.map((c) => c.name) };
}

// Full switch: auto-backup current (+ history), restore target, reload, badge.
// On failure, rolls back to the pre-switch session.
async function coreSwitchTo(site, name, tab) {
  const profiles = await getProfiles(site);
  const target = profiles[name];
  if (!target) return { level: "error", message: `Unknown channel “${displayName(name)}”.` };

  if (!tab) {
    tab = await chrome.tabs.create({ url: SITES[site].home });
    tab = await waitForComplete(tab.id) || tab;
  }

  let prevLive = null;
  try {
    prevLive = await snapshotLive(site, tab.id, tab.url);
  } catch (e) { prevLive = null; }

  try {
    if (prevLive && !sameSig(cookieSig(prevLive.cookies), cookieSig(target.cookies))) {
      if (profiles[AUTO_KEY]) await pushHistory(site, profiles[AUTO_KEY]);
      profiles[AUTO_KEY] = prevLive;
      await setProfiles(site, profiles);
    }

    const { res, storeRes, verify } = await coreRestoreSnapshot(site, target, tab);
    await chrome.storage.local.set({ [K(site, "lastActive")]: name });
    await setBadge(site, name);

    let level = "success";
    let message = `Live on “${displayName(name)}” — ${res.ok} cookies, storage ${storeRes}.`;
    const problems = [];
    if (res.missing.length > 0 || res.failed.length > 0) problems.push(`missing [${res.missing.join(", ")}]`);
    if (verify.mismatched.length > 0) problems.push(`session cookie rejected by browser (jar holds a different value)`);
    if (verify.missing.length > 0) problems.push(`jar verify failed: [${verify.missing.join(", ")}] not in jar after set`);
    if (problems.length > 0) {
      level = "warn";
      message = `Switched with problems: ${problems.join("; ")}. If login fails, log in and patch over “${displayName(name)}”.`;
    }
    const restoredSess = sessionValue(site, target.cookies);
    await chrome.storage.local.set({ [K(site, "lastSwitch")]: { to: name, at: Date.now(), level, missing: res.missing, sessionKey: restoredSess } });
    return { level, message };
  } catch (e) {
    try {
      if (prevLive) await coreRestoreSnapshot(site, prevLive, tab);
    } catch (rb) {}
    const message = `Switch to “${displayName(name)}” failed (${(e && e.message) || e}). Rolled back — reload the tab if it looks logged out.`;
    await chrome.storage.local.set({ [K(site, "lastSwitch")]: { to: name, at: Date.now(), level: "error", missing: [] } });
    return { level: "error", message };
  }
}

function sortedKeys(profiles, includeAuto = false) {
  return Object.keys(profiles).sort().filter((k) => includeAuto || k !== AUTO_KEY);
}

// Strict silent refresh: exact session match, or rotation of our own last
// restore (per site). Never guesses across accounts.
async function maybeRefreshSaves(site, tabId) {
  try {
    const liveCookies = await getRelevantCookies(site);
    if (liveCookies.length === 0) return;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
    if (!tab || !siteOfUrl(tab.url) || siteOfUrl(tab.url) !== site) return;
    const liveSess = sessionValue(site, liveCookies);

    const profiles = await getProfiles(site);
    for (const k of Object.keys(profiles)) {
      if (k === AUTO_KEY) continue;
      const saved = profiles[k];
      const savedSess = sessionValue(site, saved.cookies);
      if (!liveSess || !savedSess || liveSess !== savedSess) continue;
      if (Date.now() - (saved.refreshedAt || 0) < 5 * 60 * 1000) return;
      const storage = await runInTab(tab.id, dumpStorage, []);
      const savedKeys = Object.keys((saved.storage && saved.storage.local) || {}).length;
      const liveKeys = Object.keys((storage && storage.local) || {}).length;
      if (liveKeys === 0 && savedKeys > 0) return;
      profiles[k] = { cookies: liveCookies, storage, savedAt: saved.savedAt, refreshedAt: Date.now(), url: tab.url };
      await setProfiles(site, profiles);
      return;
    }

    const store = await chrome.storage.local.get([K(site, "lastActive"), K(site, "lastSwitch")]);
    const lastActive = store[K(site, "lastActive")], lastSwitch = store[K(site, "lastSwitch")];
    if (lastSwitch && lastActive && lastSwitch.to === lastActive && Date.now() - (lastSwitch.at || 0) < 30 * 60 * 1000) {
      const p = profiles[lastActive];
      const savedSess = p ? sessionValue(site, p.cookies) : null;
      if (p && lastActive !== AUTO_KEY && lastSwitch.sessionKey && liveSess &&
          savedSess === lastSwitch.sessionKey && liveSess !== lastSwitch.sessionKey) {
        const storage = await runInTab(tab.id, dumpStorage, []);
        const liveKeys = Object.keys((storage && storage.local) || {}).length;
        profiles[lastActive] = {
          cookies: liveCookies,
          storage: liveKeys > 0 ? storage : p.storage,
          savedAt: p.savedAt, refreshedAt: Date.now(), url: tab.url,
        };
        await setProfiles(site, profiles);
        lastSwitch.sessionKey = liveSess;
        await chrome.storage.local.set({ [K(site, "lastSwitch")]: lastSwitch });
      }
    }
  } catch (e) {}
}

// ---- Encrypted export / import (AES-GCM + PBKDF2, WebCrypto), all sites ----

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
  const data = { sites: {} };
  for (const id of SITE_IDS) {
    data.sites[id] = { profiles: await getProfiles(id), autoHistory: await getHist(id) };
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder().encode(JSON.stringify(data));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc));
  return JSON.stringify({ app: "claude-session-switcher", v: 2, exportedAt: Date.now(), salt: b64(salt), iv: b64(iv), data: b64(ct) });
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
  const data = JSON.parse(new TextDecoder().decode(plain));
  // v2: {sites:{id:{profiles}}}; v1: {profiles:{flat}} -> Claude.
  const incoming = data.sites || { claude: { profiles: data.profiles || {} } };
  let added = 0, renamed = 0, skipped = 0;
  for (const id of SITE_IDS) {
    const inc = (incoming[id] && incoming[id].profiles) || {};
    const current = await getProfiles(id);
    for (const [k, v] of Object.entries(inc)) {
      if (!v || !Array.isArray(v.cookies)) { skipped++; continue; }
      if (!current[k]) { current[k] = v; added++; }
      else if (JSON.stringify(current[k].cookies) === JSON.stringify(v.cookies)) { skipped++; }
      else { current[`${k} (imported)`] = v; renamed++; }
    }
    await setProfiles(id, current);
  }
  return { added, renamed, skipped };
}

// ---- Diagnostics (safe to share: names + timestamps only, NEVER values) ----

async function buildDiagnostics(site) {
  const now = Date.now();
  const scrub = (cookies) => (cookies || []).map((c) => ({
    n: c.name,
    d: c.domain,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: c.sameSite || null,
    expIn: c.expirationDate ? Math.round(c.expirationDate - now / 1000) + "s" : "session",
  }));
  const live = await getRelevantCookies(site);
  const profiles = await getProfiles(site);
  const store = await chrome.storage.local.get([K(site, "lastActive"), K(site, "lastSwitch")]);
  const prof = {};
  for (const [k, v] of Object.entries(profiles)) {
    prof[displayName(k)] = {
      nCookies: (v.cookies || []).length,
      cookies: scrub(v.cookies),
      localKeys: Object.keys((v.storage && v.storage.local) || {}).length,
      sessKeys: Object.keys((v.storage && v.storage.session) || {}).length,
      savedAt: v.savedAt || null,
      refreshedAt: v.refreshedAt || null,
      health: profileHealth(site, v),
    };
  }
  const ls = store[K(site, "lastSwitch")];
  return {
    app: "claude-session-switcher",
    v: "1.3.0",
    site,
    at: now,
    liveCookies: scrub(live),
    profiles: prof,
    lastActive: store[K(site, "lastActive")] ? displayName(store[K(site, "lastActive")]) : null,
    lastSwitch: ls ? {
      to: displayName(ls.to), at: ls.at, level: ls.level,
      missing: ls.missing || [],
      hadSession: !!ls.sessionKey,
    } : null,
    history: (await getHist(site)).map((h) => ({ at: h.savedAt, nCookies: (h.cookies || []).length })),
    note: "cookie names + expirations + timestamps only — no secret values",
  };
}
