# AGENTS.md — Universal guidance for working with GNOME Shell extensions

This file is a **generic layer** for AI agents (and humans) working on **any**
GNOME Shell extension. It contains the runtime model, debugging traps, and
localization/schema gotchas that are common to every shell extension — read it
before changing code, and keep it up to date when the rules described here
change.

Repository-specific rules (branch, git identity, install path, extension
UUID, key invariants of the extension itself, the file map, maintained
locales) live in **`AGENTS.local.md`** in the same directory. Read **both**
files; if they ever disagree, `AGENTS.local.md` wins for that repo.

## Runtime model — the part most agents get wrong at least once

- A GNOME Shell extension is a **GJS (mozjs) app** loaded into the running
  shell — **no transpile step**, the `.js` files are the code. A JS syntax
  check on every change:
  ```bash
  node --check extension.js && node --check *.js
  ```
- The extension is usually installed as **a symlink** from
  `~/.local/share/gnome-shell/extensions/<uuid>` → the repo, so file edits are
  **live on disk** — but **loading new JS / a recompiled schema / new
  translations requires a shell restart** (`Alt+F2` → `r` on X11/Wayland
  session, or `dbus-run-session gnome-shell --nested --wayland` for a nested
  test session). Until the restart the **OLD code is running** — don't reason
  from «I restarted».
- Debug via `journalctl -f` (or `journalctl _PID=<pid>` — filter to the
  session you are debugging, not a different nested one). GJS `log()` calls
  and GLib criticals/warnings appear there.

## The one shell quirk that bites every extension with editable texts

If you build a dialog with several `St.Entry` / `St.PasswordEntry` fields,
opening it with non-empty text in an **unfocused** field trips pairs of
`clutter_input_focus_is_focused` criticals on the very first layout — one
critical pair per unfocused non-empty field.

- **Do not fix it with «set `editable=false`, then flip it back on the first
  allocation».** The editable and non-editable allocation branches compute
  different text offsets, so any state flip followed by another allocation
  re-trips the assertions for **every** unfocused field.
- **The robust pattern:** start every field **non-editable**; make it
  editable only on first user interaction (click / key press / tab into the
  field), when the input method is already attached and the assertions can't
  fire. The field the dialog gives key focus to at open can stay editable from
  the start — its input focus is attached before its first allocation.

## Schema / settings — don't break legacy

- **Never change the schema id** once shipped — users carry legacy settings;
  extend with new keys, don't rename existing ones.
- After editing `gschema.xml` compile the schema:
  ```bash
  glib-compile-schemas --strict --targetdir=schemas/ schemas
  ```
  Verify with:
  ```bash
  gsettings --schemadir schemas list-keys <schema-id>
  ```
- New settings are **booleans**, not enums (EGO reviews look at that);
  security-sensitive defaults must be **off** (keybindings that reveal
  clipboard/password data, third-party network fetches — see Localization for
  the fetch gate).

## Localization — known environment gotchas (critical)

- **GNU `msgfmt` on this machine serves stale output.** Always rebuild `.mo`
  with the pure-python compiler in the repo (`tools/` — see AGENTS.local.md
  for the exact path/command if maintained locales exist; the compiler is now a
  **local-only tool outside version control**, so the exact path lives in the
  local layer). The `.mo` must keep its
  **header entry** (empty `msgid` with `charset=UTF-8`) or GLib will not load
  the file.
- When adding translatable strings: update **both** the `.pot` template (in
  the repo root) **and** the maintained locale files together (source
  references like `#: extension.js` go in both), then rebuild the `.mo` files.
- **Verify** the result with python gettext (same-process reads are
  authoritative; GNU gettext binaries / cross-invocation reads can serve stale
  data):
  ```bash
  python3 - <<'EOF'
  import gettext
  t = gettext.translation('<domain>', localedir='locale', languages=['ru'])
  print(t.gettext('YOUR NEW STRING'))
  EOF
  ```

## Testing / verification

- Syntax: `node --check` on all `.js` (no transpile step).
- Schema: `glib-compile-schemas --strict` + `gsettings --schemadir` (above).
- Live testing: restart the shell (`Alt+F2` → `r`). Until the restart new
  schema keys fall back to defaults via try/catch in the getters — don't
  mistake that for a regression.
- Keep AGENTS.md, AGENTS.local.md and the repo README in sync when you change
  the rules described here.
