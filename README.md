# Claude Session Switcher

A browser extension that saves your `claude.ai` login sessions and switches between accounts in one click — no more logging in and out. Think of it as a switchboard for Claude accounts.

![switchboard UI](icons/claude-128.png)

## How it works

On **Patch**, the extension snapshots the live session for the current `claude.ai` tab:

- all `claude.ai` + `anthropic.com` cookies (including the httpOnly `sessionKey`),
- `localStorage` + `sessionStorage` of the page.

On **Switch**, it backs up what's live, clears the jar, restores the saved snapshot, and reloads. Sessions are stored in `chrome.storage.local` — on this machine only, never sent anywhere.

## Install (Chrome)

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open `https://claude.ai/`, log in, click the toolbar icon, name the channel, hit **Patch**.
4. Repeat for each account. Flip a channel's toggle to switch.

Reload the extension on `chrome://extensions` after every update.

## Features

- **One-click switching** — channel strips with toggle switches; the glowing channel is last used, the green lamp is what's actually live (live-detect matches cookies, so it stays truthful even if you log in/out by hand).
- **Keyboard shortcuts** — `Alt+Shift+N` next account, `Alt+Shift+P` previous. Remap at `chrome://extensions/shortcuts`.
- **Auto-backup + recovery** — every switch snapshots the outgoing session into *Previous · auto*, plus a rolling history of the last 5. A bad switch never loses a login.
- **Health + audit** — saves are flagged (`no session cookie`, `N expired cookies`, `old save`), and any flagged channel gets a **check** button that audits it (session presence, expiry, storage capture).
- **Toolbar badge** — shows the initial of the live account; hover for the full name.
- **Encrypted export / import** — move profiles between machines or Chrome profiles. Vault footer → set a password → export downloads an AES-GCM (PBKDF2 100k) file. Wrong password = unrecoverable by design.

## Firefox

```bash
./firefox/make-firefox.sh
```

then load `firefox/build/` via `about:debugging → This Firefox → Load Temporary Add-on`. Requires Firefox 131+ (uses `scripting.executeScript` with `world: "MAIN"`). Status: ported, smoke-test before daily use — see [`firefox/`](firefox/).

## Permissions — why each

| Permission | Why |
|---|---|
| `cookies` + `*.claude.ai` / `*.anthropic.com` | read/write session cookies (the actual login) |
| `scripting`, `activeTab` | snapshot/restore page storage, only on `claude.ai` tabs |
| `storage` | profiles live in `chrome.storage.local` on this machine |
| `tabs` | find/activate the `claude.ai` tab for shortcuts |

## Troubleshooting

- **Switch lands on the login page** — the saved session expired server-side. Log in manually on `claude.ai`, then Patch over the same name.
- **“No session cookie” flag** — you patched from a logged-out tab or a login popup. Log in on the main `claude.ai` tab and re-patch.
- **Side-by-side accounts** — impossible in one Chrome profile (cookies are shared per profile, not per tab). Use two Chrome profiles, one per account, tiled side by side.
- **Lost password on an export file** — unrecoverable. The key is derived from your password only.

## Privacy

Session cookies *are* credentials. Anyone with access to your browser profile (or an exported vault + its password) can act as you on Claude. Don't share vault files; Delete channels you no longer use.

## Files

- `manifest.json` — MV3 manifest (Chrome)
- `popup.html` / `popup.js` — switchboard UI
- `shared.js` — session capture/restore/audit/transfer core (no DOM; shared with the worker)
- `background.js` — shortcuts + badge upkeep
- `icons/` — Claude mark (via [lobe-icons](https://github.com/lobehub/lobe-icons)), 16/48/128px
- `firefox/` — Firefox manifest, `browser`-namespace shim, build script
