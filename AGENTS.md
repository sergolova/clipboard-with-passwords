# AGENTS.md — Clipboard with Passwords

Guidance for AI agents (and humans) working on this repository. Read this before
changing code, and keep it up to date when you change the rules described here.

## What this project is

A fork of the GNOME Shell extension **Clipboard Indicator v71** («Clipboard
with Passwords»). On top of the original clipboard history (+ keyboard
navigation, URL metadata, etc.) it adds:

- an **encrypted password vault** (ZIP + `passwords.json` inside),
- **localization** (**RU** and **UK** fully maintained, other locales inherited from the original),
- a clean, **hand-editable `passwords.json`** format,
- 6 new settings and 2 bug fixes (see «Key invariants»).

## Repository & workflow rules (do not break these)

- **Branch:** `clipboard-with-passwords`; **remote:** `git@github.com:sergolova/clipboard-with-passwords.git`
- **Git identity (already configured locally):** `sergolova <sergolova666@tutanota.com>`
- **The agent never creates commits.** The user commits the batch themselves.
  Push is done by the user. Keep the working tree as a clean uncommitted batch.
- **No `gh` CLI** — don't rely on it.
- Do **not** touch the backup archive
  `/mnt/data/SERA/Projects/Gnome/clipboard-indicator@tudmotu.com.tar.xz`.
- UUID: `clipboard-with-passwords@sergolova`; extension is **installed as a
  symlink** `~/.local/share/gnome-shell/extensions/clipboard-with-passwords@sergolova`
  → this repo, so file edits are live — but a **shell restart is required** to
  load new JS, a recompiled schema, and new translations (`Alt+F2` → `r`).
- After changing `gschema.xml` the compiled schema is needed:
  ```bash
  glib-compile-schemas --strict --targetdir=schemas/ schemas
  ```
  Verify with:
  ```bash
  gsettings --schemadir schemas list-keys org.gnome.shell.extensions.clipboard-indicator
  ```
- JS syntax check on every change:
  ```bash
  node --check extension.js && node --check *.js
  ```

## Key invariants (decisions that shaped the code)

- **Schema id stays** `org.gnome.shell.extensions.clipboard-indicator`
  (legacy settings compatibility). **gettext-domain** is
  `clipboard-with-passwords`.
- **Vault default path:** `~/.config/clipboard-indicator/passwords.zip`
  (resolved via `resolveVaultPath()` in `passwordVault.js`).
- **JSON format rules:**
  - No default categories; the root **`categories` key is absent**.
  - On save, **omit empty/false fields**: `category`, `description`, `login`,
    `password`, `extraFields`, `extraFields[].label`, and
    `extraFields[].isHidden=false`. `password` is kept **untrimmed**.
  - `_sanitizeItem()` in `passwordVault.js` builds minimal items; name
    fallback is `_('Untitled')`; it preserves `data.id` and `data.updatedAt`.
    Items are re-sanitized on **load and save** (fixes legacy/hand-edited files).
  - Categories are **derived dynamically** in `getCategories()`; there is no
    `addCategory()`; the filter bar has no fixed category list.
- **«All» pseudo-category** uses the internal sentinel
  `ALL_CATEGORY = '__all__'` (exported from `passwordVault.js`), **not** the
  translated word (`'Все'`/`'All'`) — a translated word would collide with a
  real user category. Backward compatible, no migration.
- **The added settings are booleans** (not enums), all defined in
  `prefs.js` + `constants.js` + `gschema.xml`:
  | Key | Default |
  | --- | --- |
  | `vault-enabled` | `true` |
  | `vault-pin-recent` | `true` |
  | `vault-hide-all-category` | `false` |
  | `vault-copy-to-history` | `false` |
  | `colorize-clipboard` | `true` |
  | `fetch-youtube-titles` | `true` |
- `VAULT_ENABLED` guards `openPasswordVault()` (early return); `_onSettingsChange`
  drops back to the history view when the vault is disabled while open.
  `VAULT_COPY_TO_HISTORY` makes vault copies go through the normal clipboard
  watcher (no `ignoreNextClipboardChange`) so they land in the visible history —
  intentionally insecure, default off, warning shown in prefs/README.
- **Master password life cycle:**
  - Asked only when opening the vault while it is **not unlocked**;
    afterwards the vault stays unlocked in memory for the session.
  - **Auto-lock** on screen lock and suspend (see `_setupAutoLock()` in
    `extension.js`; subscribes to `org.gnome.ScreenSaver` `Locked` and
    `org.freedesktop.login1` `PrepareForSleep`). Vault menu closes, a
    notification is shown.
  - If the **vault path in settings changes while unlocked**, the vault is
    locked again and the password re-requested (no silent write to a new file).
  - Unlock/save errors are user-facing: `passwordVault.js` throws `Error`
    whose `message` is a translated string; the unlock dialog displays
    `e.message`; save-time failures surface via `Main.notify`.
- **If the zip is deleted mid-session:** while unlocked the data survives in
  memory and the next save recreates the archive; while locked, unlock creates
  a new empty vault — the previous `.bak` (`passwords.zip.bak`) can restore it.
- **Hide-All privacy mode** also hides the counts on category buttons.

## File map

| File | Purpose |
| --- | --- |
| `extension.js` | Main indicator: clipboard tracking, menu, type styles (`_updateTypeStyle()`), YouTube oEmbed gate, vault wiring, auto-lock |
| `theme.js` | Theme detection (`isDarkTheme()`), `themeClass()` (`ci-theme-dark`/`ci-theme-light`), `themeColors()` palette (DARK/LIGHT) — the single source for all text/swatch/card colors |
| `stylesheet.css` | Scoped CSS rules incl. theme-variant overrides (`.ci-theme-light …`) and the visible pinned/history separator |
| `passwordVault.js` | `PasswordVaultManager`, `ALL_CATEGORY`, `generatePassword()`, `resolveVaultPath()`, 7z I/O, sanitize, path/writability checks |
| `passwordVaultMenu.js` | Vault UI: cards, filter bar, category buttons, service row callbacks, `_notifySaveError()` |
| `passwordVaultDialog.js` | `MasterPasswordDialog`, `ServiceEditDialog`, paste-button helper |
| `prefs.js` | Settings panel rows + bindings (incl. the 4 new booleans) |
| `constants.js` | `PrefsFields` keys (incl. the 4 new ones) |
| `registry.js` | Clipboard/selection listeners, URL metadata glue |
| `urlMetadataManager.js` | URL title cache (incl. YouTube) |
| `keyboard.js` | Global keybind handling helper |
| `confirmDialog.js` | Confirm dialog helper |
| `schemas/org.gnome.shell.extensions.clipboard-indicator.gschema.xml` | Settings schema |
| `locale/<lang>/LC_MESSAGES/clipboard-with-passwords.{po,mo}` | Translations (RU and UK are fully maintained) |
| `clipboard-with-passwords.pot` | Translation template |
| `tools/mo_writer.py` | Pure-python po→mo compiler (see Localization) |

## Localization — known environment gotchas (critical)

- **GNU `msgfmt` on this machine serves stale output.** Always rebuild `.mo`
  with the pure-python compiler:
  ```bash
  python3 tools/mo_writer.py locale/ru/LC_MESSAGES/clipboard-with-passwords.po \
      locale/ru/LC_MESSAGES/clipboard-with-passwords.mo
  ```
  (The `Makefile` still uses `msgfmt`; prefer the python path for real edits.)
- The `.mo` must keep its **header entry** (empty msgid with `charset=UTF-8`)
  or GLib will not load the file — `mo_writer.py` handles this.
- When adding translatable strings: update **both** `clipboard-with-passwords.pot`
  and the maintained locale files (`locale/ru/...po`, `locale/uk/...po`)
  together (source references like `#: passwordVault.js` go in both), then
  rebuild both `.mo` files.
- **Verify** the result with python gettext (same-process reads are
  authoritative; GNU gettext binaries / cross-invocation reads can serve stale
  data):
  ```bash
  python3 - <<'EOF'
  import gettext
  t = gettext.translation('clipboard-with-passwords',
      localedir='locale', languages=['ru'])
  print(t.gettext('YOUR NEW STRING'))
  EOF
  ```
- Deployed `ru.mo` and `uk.mo` each have 181 entries; the extension `locale/`
  is live via the install symlink. The `uk.po` was fully re-translated
  (regenerated from the pot); edit it in place and rebuild `uk.mo` with
  `tools/mo_writer.py`.

## Testing / verification

- Syntax: `node --check` on all `.js` (no transpile step).
- Schema: `glib-compile-schemas --strict` + `gsettings --schemadir` (above).
- Live testing: restart the shell (`Alt+F2` → `r`). Until the restart new
  schema keys fall back to defaults via try/catch in the getters — don't
  mistake that for a regression.
- AGENTS.md and README notes: the README documents the master-password life
  cycle, deleted-archive behavior, and invalid-path/write-protection handling.