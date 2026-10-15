// Popup UI. Core session logic lives in shared.js.

let busy = false;
let armedDelete = null;
let liveKey = null;

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

async function getClaudeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.url.includes("claude.ai")) return null;
  return tab;
}

function setBusy(v) {
  busy = v;
  document.getElementById("save").disabled = v;
  document.querySelectorAll(".switch").forEach((b) => { b.disabled = v; });
}

async function saveCurrent() {
  if (busy) return;
  const tab = await getClaudeTab();
  if (!tab) { setStatus("Patch from a claude.ai tab — open one, log in, then patch.", "warn"); return; }
  const nameEl = document.getElementById("name");
  const name = nameEl.value.trim();
  if (!name) { setStatus("Name this channel first — e.g. work.", "warn"); nameEl.focus(); return; }
  if (name === AUTO_KEY) { setStatus("That name is reserved.", "warn"); return; }

  setBusy(true);
  setStatus(`Patching “${name}”…`, "info");
  try {
    const snap = await snapshotLive(tab.id, tab.url);
    if (!snap) {
      setStatus("No claude.ai cookies here. Log in on this tab, then patch.", "error");
      return;
    }
    const profiles = await getProfiles();
    profiles[name] = snap;
    await setProfiles(profiles);
    await chrome.storage.local.set({ lastActive: name });
    await setBadge(name);
    nameEl.value = "";
    armedDelete = null;
    const audit = auditProfile(snap);
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
  setBusy(true);
  setStatus(`Throwing switch → “${displayName(name)}”…`, "info");
  try {
    let tab = await getClaudeTab();
    const r = await coreSwitchTo(name, tab);
    setStatus(r.message, r.level);
    await renderList();
  } finally {
    setBusy(false);
  }
}

async function restoreHistory(index) {
  if (busy) return;
  setBusy(true);
  try {
    const hist = await getHist();
    const snap = hist[index];
    if (!snap) return;
    let tab = await getClaudeTab();
    if (!tab) {
      tab = await chrome.tabs.create({ url: "https://claude.ai/" });
      tab = await waitForComplete(tab.id) || tab;
    }
    const live = await snapshotLive(tab.id, tab.url).catch(() => null);
    const { res } = await coreRestoreSnapshot(snap, tab);
    hist.splice(index, 1);
    if (live) hist.unshift(live);
    await chrome.storage.local.set({ autoHistory: hist.slice(0, AUTO_HIST_MAX) });
    const profiles = await getProfiles();
    profiles[AUTO_KEY] = snap;
    await setProfiles(profiles);
    await chrome.storage.local.set({ lastActive: AUTO_KEY });
    await setBadge(AUTO_KEY);
    setStatus(res.missing.length > 0 ? `Recovered with warnings, missing [${res.missing.join(", ")}].` : `Recovered backup from ${timeAgo(snap.savedAt)}.`, res.missing.length > 0 ? "warn" : "success");
    await renderList();
  } finally {
    setBusy(false);
  }
}

async function deleteProfile(name) {
  if (armedDelete === name) {
    const profiles = await getProfiles();
    delete profiles[name];
    await setProfiles(profiles);
    const { lastActive } = await chrome.storage.local.get("lastActive");
    if (lastActive === name) {
      await chrome.storage.local.remove("lastActive");
      await setBadge(null);
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

function runAudit(name, profile) {
  const audit = auditProfile(profile);
  const lines = audit.map((c) => `${c.ok ? "✓" : "×"} ${c.label}`).join("\n");
  const bad = audit.some((c) => !c.ok);
  setStatus(`Audit “${displayName(name)}”:\n${lines}`, bad ? "error" : "success");
}

async function renderList() {
  const profiles = await getProfiles();
  const { lastActive } = await chrome.storage.local.get("lastActive");
  try { liveKey = (await detectLiveKey()).key; } catch (e) { liveKey = null; }
  const q = (document.getElementById("search").value || "").toLowerCase();
  const list = document.getElementById("list");
  const sub = document.getElementById("sub");
  const searchRow = document.getElementById("searchRow");
  list.innerHTML = "";

  const allKeys = sortedKeys(profiles, true);
  const keys = sortedKeys(profiles).filter((n) => n.toLowerCase().includes(q));
  const total = sortedKeys(profiles).length;
  sub.textContent = total === 0 ? "no channels patched"
    : total === 1 ? "1 channel patched" : `${total} channels patched`;
  searchRow.classList.toggle("show", total > 3);

  const tab = await getClaudeTab().catch(() => null);
  const lamp = document.getElementById("tabState");
  document.getElementById("tabStateTx").textContent = tab ? "claude.ai live" : "not on claude.ai";
  lamp.classList.toggle("ok", !!tab);

  if (keys.length === 0) {
    list.innerHTML = total === 0
      ? `<div class="empty"><span class="sig">An empty board.</span><b>Patch your first login</b> — open claude.ai, log in, name it above, hit Patch. Your next account takes seconds.</div>`
      : `<div class="empty">No channel matches that filter.</div>`;
  }
  const order = sortedKeys(profiles);
  for (const name of keys) {
    const p = profiles[name];
    const h = profileHealth(p);
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
      chk.onclick = () => runAudit(name, p);
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
    del.onclick = () => deleteProfile(name);
    actions.append(sw, del);
    list.appendChild(card);
  }

  // Recovery section: auto-backup slot + history.
  const rec = document.getElementById("recovery");
  const recList = document.getElementById("recList");
  recList.innerHTML = "";
  const hist = await getHist();
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
  void allKeys;
}

// ---- Encrypted export / import ----

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
    a.download = `claude-switchboard-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    document.getElementById("xpass").value = "";
    setStatus("Vault exported — encrypted file downloaded. Wrong password = unrecoverable, keep it safe.", "success");
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
renderList();
