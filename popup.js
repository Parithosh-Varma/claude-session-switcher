// Popup UI. Core session logic lives in shared.js.

let busy = false;
let armedDelete = null;
let liveKey = null;
let currentSite = "claude";

function setStatus(msg, type = "info") {
  const el = document.getElementById("status");
  if (!msg) { el.className = ""; el.textContent = ""; return; }
  el.className = "show " + type;
  el.textContent = msg;
  clearTimeout(setStatus._t);
  if (type === "success") setStatus._t = setTimeout(() => setStatus(""), 7000);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function timeAgo(ts) {
  if (!ts) return "unknown age";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

async function getSiteTab(site) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !siteOfUrl(tab.url) || siteOfUrl(tab.url) !== site) return null;
  return tab;
}

function setBusy(v) {
  busy = v;
  document.getElementById("save").disabled = v;
  document.querySelectorAll(".switch").forEach((b) => { b.disabled = v; });
}

async function setSite(site) {
  currentSite = site;
  await chrome.storage.local.set({ uiSite: site });
  document.getElementById("name").value = "";
  armedDelete = null;
  setStatus("");
  await renderList();
}

async function saveCurrent() {
  if (busy) return;
  const site = currentSite;
  const tab = await getSiteTab(site);
  if (!tab) { setStatus(`Patch from a ${SITES[site].host} tab — open one, log in, then patch.`, "warn"); return; }
  const nameEl = document.getElementById("name");
  const name = nameEl.value.trim();
  if (!name) { setStatus("Name this channel first — e.g. work.", "warn"); nameEl.focus(); return; }
  if (name === AUTO_KEY) { setStatus("That name is reserved.", "warn"); return; }

  setBusy(true);
  setStatus(`Patching “${name}”…`, "info");
  try {
    const snap = await snapshotLive(site, tab.id, tab.url);
    if (!snap) {
      setStatus(`No ${SITES[site].host} cookies here. Log in on this tab, then patch.`, "error");
      return;
    }
    const profiles = await getProfiles(site);
    profiles[name] = snap;
    await setProfiles(site, profiles);
    await chrome.storage.local.set({ [K(site, "lastActive")]: name });
    await setBadge(site, name);
    nameEl.value = "";
    armedDelete = null;
    const audit = auditProfile(site, snap);
    const bad = audit.filter((c) => !c.ok);
    if (bad.length === 0) {
      setStatus(`Patched “${name}” — ${snap.cookies.length} cookies, ${Object.keys(snap.storage?.local || {}).length} local keys. All checks pass.`, "success");
    } else {
      setStatus(`Patched “${name}” with problems:\n` + bad.map((c) => `× ${c.label}`).join("\n"), "error");
    }
    await renderList();
  } finally {
    setBusy(false);
  }
}

async function switchTo(name) {
  if (busy) return;
  const site = currentSite;
  setBusy(true);
  setStatus(`Throwing switch → “${displayName(name)}”…`, "info");
  try {
    const tab = await getSiteTab(site);
    const r = await coreSwitchTo(site, name, tab);
    setStatus(r.message, r.level);
    await renderList();
  } finally {
    setBusy(false);
  }
}

async function restoreHistory(index) {
  if (busy) return;
  const site = currentSite;
  setBusy(true);
  try {
    const hist = await getHist(site);
    const snap = hist[index];
    if (!snap) return;
    let tab = await getSiteTab(site);
    if (!tab) {
      tab = await chrome.tabs.create({ url: SITES[site].home });
      tab = await waitForComplete(tab.id) || tab;
    }
    const live = await snapshotLive(site, tab.id, tab.url).catch(() => null);
    const { res } = await coreRestoreSnapshot(site, snap, tab);
    hist.splice(index, 1);
    if (live) hist.unshift(live);
    await chrome.storage.local.set({ [K(site, "autoHistory")]: hist.slice(0, AUTO_HIST_MAX) });
    const profiles = await getProfiles(site);
    profiles[AUTO_KEY] = snap;
    await setProfiles(site, profiles);
    await chrome.storage.local.set({ [K(site, "lastActive")]: AUTO_KEY });
    await setBadge(site, AUTO_KEY);
    setStatus(res.missing.length > 0 ? `Recovered with warnings, missing [${res.missing.join(", ")}].` : `Recovered backup from ${timeAgo(snap.savedAt)}.`, res.missing.length > 0 ? "warn" : "success");
    await renderList();
  } finally {
    setBusy(false);
  }
}

async function deleteProfile(site, name) {
  if (armedDelete === name) {
    const profiles = await getProfiles(site);
    delete profiles[name];
    await setProfiles(site, profiles);
    const store = await chrome.storage.local.get(K(site, "lastActive"));
    if (store[K(site, "lastActive")] === name) {
      await chrome.storage.local.remove(K(site, "lastActive"));
      await setBadge(site, null);
    }
    armedDelete = null;
    setStatus(`Pulled “${displayName(name)}” from the board.`, "info");
    await renderList();
  } else {
    armedDelete = name;
    await renderList();
    setStatus(`Press remove on “${displayName(name)}” again to confirm.`, "warn");
  }
}

function runAudit(site, name, profile) {
  const audit = auditProfile(site, profile);
  const lines = audit.map((c) => `${c.ok ? "✓" : "×"} ${c.label}`).join("\n");
  const bad = audit.some((c) => !c.ok);
  setStatus(`Audit “${displayName(name)}”:\n${lines}`, bad ? "error" : "success");
}

async function renderList() {
  const site = currentSite;
  const profiles = await getProfiles(site);
  const store = await chrome.storage.local.get(K(site, "lastActive"));
  const lastActive = store[K(site, "lastActive")];
  try { liveKey = (await detectLiveKey(site)).key; } catch (e) { liveKey = null; }
  const q = (document.getElementById("search").value || "").toLowerCase();
  const list = document.getElementById("list");
  const sub = document.getElementById("sub");
  const searchRow = document.getElementById("searchRow");
  list.innerHTML = "";

  for (const id of SITE_IDS) {
    const n = sortedKeys(await getProfiles(id)).length;
    document.getElementById("cnt-" + id).textContent = n > 0 ? n : "";
    const btn = document.getElementById("stab-" + id);
    btn.classList.toggle("on", id === site);
    btn.setAttribute("aria-selected", id === site ? "true" : "false");
  }

  const keys = sortedKeys(profiles).filter((n) => n.toLowerCase().includes(q));
  const total = sortedKeys(profiles).length;
  sub.textContent = total === 0 ? `no ${SITES[site].label.toLowerCase()} channels patched`
    : total === 1 ? `1 ${SITES[site].label.toLowerCase()} channel patched`
    : `${total} ${SITES[site].label.toLowerCase()} channels patched`;
  searchRow.classList.toggle("show", total > 3);

  const tab = await getSiteTab(site).catch(() => null);
  const lamp = document.getElementById("tabState");
  document.getElementById("tabStateTx").textContent = tab ? `${SITES[site].host} live` : `not on ${SITES[site].host}`;
  lamp.classList.toggle("ok", !!tab);

  if (keys.length === 0) {
    list.innerHTML = total === 0
      ? `<div class="empty"><span class="sig">An empty board.</span><b>Patch your first ${SITES[site].label} login</b> — open ${SITES[site].host}, log in, name it above, hit Patch. Your next account takes seconds.</div>`
      : `<div class="empty">No channel matches that filter.</div>`;
  }
  const order = sortedKeys(profiles);
  for (const name of keys) {
    const p = profiles[name];
    const h = profileHealth(site, p);
    const cookieNames = (p.cookies || []).map((c) => c.name).join(", ");
    const isActive = lastActive === name;
    const isLive = liveKey === name;
    const card = document.createElement("div");
    card.className = "channel" + (isActive ? " active" : "") + (isLive ? " live" : "");
    const chNum = "CH-" + String(order.indexOf(name) + 1).padStart(2, "0");
    const healthBit = h.level === "ok"
      ? (isLive ? ' · <span class="ok">live</span>' : "")
      : ` · <span class="${h.level === "bad" ? "bad" : "wrn"}">${esc(h.msg)}</span>`;
    card.innerHTML =
      `<span class="ch"><i></i>${esc(chNum)}</span>` +
      `<div class="meta"><div class="nm" title="${esc(cookieNames || "no cookies")}${isLive ? " — this is what's logged in now" : ""}">${esc(name)}</div>` +
      `<div class="dt">${(p.cookies || []).length} cookies · ${esc(timeAgo(p.savedAt))}${healthBit}</div></div>` +
      `<div class="actions"></div>`;
    const actions = card.querySelector(".actions");
    if (h.level !== "ok") {
      const chk = document.createElement("button");
      chk.className = "mini";
      chk.textContent = "check";
      chk.title = "Audit this save";
      chk.onclick = () => runAudit(site, name, p);
      actions.append(chk);
    }
    const sw = document.createElement("button");
    sw.className = "switch";
    sw.setAttribute("aria-pressed", isActive ? "true" : "false");
    sw.title = isLive ? `${name} — already live` : `Switch to ${name}`;
    sw.setAttribute("aria-label", `Switch to ${name}`);
    sw.disabled = busy;
    sw.onclick = () => switchTo(name);
    const del = document.createElement("button");
    del.className = "icon-btn" + (armedDelete === name ? " armed" : "");
    del.textContent = armedDelete === name ? "sure?" : "×";
    del.title = `Remove ${name}`;
    del.setAttribute("aria-label", `Remove ${name}`);
    del.onclick = () => deleteProfile(site, name);
    actions.append(sw, del);
    list.appendChild(card);
  }

  const rec = document.getElementById("recovery");
  const recList = document.getElementById("recList");
  recList.innerHTML = "";
  const hist = await getHist(site);
  const auto = profiles[AUTO_KEY];
  const items = [];
  if (auto) items.push({ label: `auto-backup · ${timeAgo(auto.savedAt)}`, snap: auto, histIndex: -1 });
  hist.forEach((h, i) => items.push({ label: `backup ${i + 2} · ${timeAgo(h.savedAt)}`, snap: h, histIndex: i }));
  rec.classList.toggle("show", items.length > 0);
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "rec";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = `${it.label} (${(it.snap.cookies || []).length} cookies)`;
    const b = document.createElement("button");
    b.className = "mini";
    b.textContent = "restore";
    b.onclick = () => it.histIndex < 0 ? switchTo(AUTO_KEY) : restoreHistory(it.histIndex);
    div.append(t, b);
    recList.appendChild(div);
  }

  try {
    const lsStore = await chrome.storage.local.get(K(site, "lastSwitch"));
    const lastSwitch = lsStore[K(site, "lastSwitch")];
    const el = document.getElementById("lastop");
    if (lastSwitch && lastSwitch.to) {
      const cls = lastSwitch.level === "success" ? "ok" : (lastSwitch.level === "warn" ? "wrn" : "bad");
      const miss = (lastSwitch.missing || []).length > 0 ? ` · missing ${lastSwitch.missing.length}` : "";
      el.innerHTML = `last switch → ${esc(displayName(lastSwitch.to))} · <span class="${cls}">${esc(lastSwitch.level)}</span> · ${esc(timeAgo(lastSwitch.at))}${esc(miss)}`;
    } else {
      el.textContent = "no switches yet";
    }
  } catch (e) {}
}

document.getElementById("xferToggle").addEventListener("click", () => {
  document.getElementById("xbox").classList.toggle("show");
});

document.getElementById("doExport").addEventListener("click", async () => {
  const pass = document.getElementById("xpass").value;
  if (!pass) { setStatus("Set a vault password first.", "warn"); return; }
  try {
    const json = await exportProfiles(pass);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `session-switchboard-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    document.getElementById("xpass").value = "";
    setStatus("Vault exported (both assistants) — encrypted file downloaded. Wrong password = unrecoverable.", "success");
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, "error");
  }
});

document.getElementById("doImport").addEventListener("click", () => {
  if (!document.getElementById("xpass").value) { setStatus("Enter the vault password first, then pick the file.", "warn"); return; }
  document.getElementById("xfile").click();
});

document.getElementById("xfile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  const pass = document.getElementById("xpass").value;
  try {
    const text = await f.text();
    const r = await importProfiles(text, pass);
    document.getElementById("xpass").value = "";
    setStatus(`Import done: ${r.added} added${r.renamed ? `, ${r.renamed} kept as “(imported)” copies` : ""}${r.skipped ? `, ${r.skipped} skipped` : ""}.`, "success");
    await renderList();
  } catch (err) {
    setStatus(`Import failed: ${err.message}`, "error");
  }
});

document.getElementById("save").addEventListener("click", saveCurrent);
document.getElementById("name").addEventListener("keydown", (e) => { if (e.key === "Enter") saveCurrent(); });
document.getElementById("search").addEventListener("input", () => renderList());
document.getElementById("diagBtn").addEventListener("click", async () => {
  try {
    const diag = await buildDiagnostics(currentSite);
    const text = JSON.stringify(diag, null, 1);
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setStatus(`Diagnostics (${SITES[currentSite].label}) copied — paste them in chat. Cookie names only, no secret values.`, "success");
  } catch (e) {
    setStatus(`Diagnostics failed: ${e.message}`, "error");
  }
});
for (const id of ["claude", "chatgpt"]) {
  document.getElementById("stab-" + id).addEventListener("click", () => setSite(id));
}
(async () => {
  const { uiSite } = await chrome.storage.local.get("uiSite");
  currentSite = uiSite === "chatgpt" ? "chatgpt" : "claude";
  // Deep-link: open the popup on the assistant matching the active tab.
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const s = tabs[0] && siteOfUrl(tabs[0].url);
    if (s) currentSite = s;
  } catch (e) {}
  await renderList();
})();
