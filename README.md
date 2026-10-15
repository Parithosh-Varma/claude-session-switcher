# Claude Session Switcher

<img src="icons/claude-128.png" alt="Claude logo" width="64"> <img src="icons/chatgpt-128.png" alt="ChatGPT logo" width="64">

> Save your `claude.ai` and `chatgpt.com` logins as channels and flip between accounts in one click — no more signing in and out.

## Why this exists

## Why this exists

Claude and ChatGPT each hold one login per browser profile. People with work and personal accounts either juggle profiles or retype credentials all day. This extension snapshots the full login session (cookies + page storage) per account and restores it on demand, so switching takes one click or one keystroke. A tab bar up top flips the whole board between **Claude** and **ChatGPT** — each assistant keeps its own channels, backups, and vault.

## Features

- **One-click switching** — each account is a channel strip with a toggle. The glowing channel was used last; the green lamp marks the account that is actually live right now (detected from real cookies, so it stays truthful even if you sign in/out by hand).
- **Keyboard shortcuts** — `Alt+Shift+N` next account, `Alt+Shift+P` previous (remappable at `chrome://extensions/shortcuts`).
- **Auto-backup + recovery** — every switch snapshots the outgoing session into *Previous · auto*, plus a rolling history of the last 5. A bad switch never loses a login. Failed switches roll back automatically.
- **Health checks + audit** — saves get flagged (`no session cookie`, `N expired cookies`, `old save`), and flagged channels grow a **check** button that audits session presence, expiry, and storage capture.
- **Toolbar badge** — shows the live account's initial; hover for the full name.
- **Encrypted export / import** — move profiles between machines or Chrome profiles via a password-protected vault file (AES-GCM, PBKDF2 100k). A lost password is unrecoverable by design.
- **Silent save refresh** — while you browse `claude.ai`, the live save is refreshed (throttled) on exact-session match, and rotations of a session the extension restored itself are tracked — so server-side key rotation doesn't silently stale saves. Never guesses across accounts.

## Quick start

### Prerequisites

- Chrome (or any Chromium browser) with Developer mode available.
- One `claude.ai` or `chatgpt.com` account logged in to begin with.

### Install

1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Open `https://claude.ai/` (or `https://chatgpt.com/`) and log in.
4. Click the toolbar icon — it opens on the tab matching your active page — name the channel (e.g. `work`), hit **Patch**.
5. Repeat step 3–4 for each account. Flip a toggle to switch.

After pulling updates, hit **Reload** on `chrome://extensions`.

## Usage

- **Patch** — saves the current tab's session under the name you type.
- **Toggle** — backs up the live session, restores the channel, reloads the tab.
- **check** (on flagged channels) — audits the save and reports exactly what's wrong.
- **Recovery section** — restores auto-backups when a switch goes sideways.
- **Vault (footer)** — set a password, then `↓ export` to download the encrypted vault or `↑ import` to merge one in. Conflicting names are kept as `(imported)` copies; identical saves are skipped.

## How it works

```
Patch:  claude.ai tab → cookies + localStorage/sessionStorage → chrome.storage.local
Switch: snapshot live → clear jar → restore saved snapshot → reload tab
```

Each save holds the `claude.ai` + `anthropic.com` cookies (including the httpOnly `sessionKey`) and the page's web storage. Restore replays them with original attributes (`Secure`, `HttpOnly`, `SameSite`, `__Host-` rules, CHIPS partitions), then verifies what actually landed and warns about anything missing. Shared logic lives in `shared.js` (no DOM), used by both the popup and the background worker.

## Firefox

```bash
./firefox/make-firefox.sh
```

Load `firefox/build/` via `about:debugging → This Firefox → Load Temporary Add-on`. Requires Firefox 131+. The Firefox port is built and syntax-checked but not yet daily-driven — report issues if you try it.

## Permissions

| Permission | Why |
|---|---|
| `cookies` + `*.claude.ai`, `*.anthropic.com`, `*.chatgpt.com`, `*.openai.com`, `*.auth0.com` | read/write session cookies — the actual logins |
| `scripting`, `activeTab` | snapshot/restore page storage, only on `claude.ai` tabs |
| `storage` | profiles live in `chrome.storage.local`, on this machine only |
| `tabs` | find/activate the `claude.ai` tab for shortcut switching |

Nothing leaves the machine: no network calls, no analytics, no sync.

## Limitations

- One live login per Chrome profile — cookies are shared across tabs, so two accounts can't be active side by side in one window. Use two Chrome profiles, tiled, for that.
- Saved sessions can expire server-side; the extension can't renew them, only restore what was saved.
- Sessions are credentials: anyone with your browser profile (or a vault file + its password) can act as you. Delete channels you don't use.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Switch lands on the login page | Session expired. Log in on `claude.ai`, Patch over the same name. |
| Signed out out of nowhere | Usually server-side expiry or rotation. Re-log, re-patch; saves now auto-refresh while you browse, and the popup footer shows the last switch result. |
| `no session cookie` flag | Patched from a logged-out tab or login popup. Log in on the main tab, re-patch. |
| Shortcuts do nothing | Check `chrome://extensions/shortcuts` for conflicts; shortcuts need a `claude.ai` tab or open one. |
| Import fails | Wrong password or a non-vault file. Passwords can't be recovered. |

## Project structure

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (Chrome), v1.2.0 |
| `popup.html` / `popup.js` | switchboard UI |
| `shared.js` | capture / restore / audit / vault core, shared by popup + worker |
| `background.js` | shortcuts + badge upkeep |
| `icons/` | Claude mark ([lobe-icons](https://github.com/lobehub/lobe-icons)) + ChatGPT knot ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:ChatGPT-Logo.png)), 16/48/128 px |
| `firefox/` | Firefox manifest, `browser`-namespace shim, build script |

## Contributing

Bug reports and small PRs welcome. Please describe your browser + version, the channel state (flags shown), and the exact status message — the status line already contains the diagnosis in most cases.
