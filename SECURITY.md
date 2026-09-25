# 🔐 Security model

This document describes how *Clipboard with Passwords* protects its data, what
it expects from the user, and what it deliberately does **not** promise. It is
the security companion to the [README](README.md) — feature descriptions,
installation and usage live there; threats, trust and encryption live here.

---

**Position statement.** This project provides a **locally integrated encrypted
vault for GNOME Shell**. It is designed to protect stored secrets against
ordinary unauthorized access to the vault file when a strong master password is
used. It is **not** a sandboxed password manager and cannot protect secrets
from malware or other code already running with equivalent access to the
user's session.

---

## Trust model

- The extension is **trusted software**: it is installed into your GNOME Shell
  and runs with **your user's privileges**. Treat it like any program you
  install — only install what you trust, and verify what you download (the
  README's install section shows how).
- Anything running with your user rights can read your clipboard at any
  moment, read the vault while it is unlocked in memory, and access whatever
  files your user can access — explicitly:
  - **malware or any other software running as your user**;
  - **another (malicious) GNOME Shell extension** installed next to this one;
  - a fully **compromised GNOME Shell / user session**;
  - **any process that can read the system clipboard**;
  - code able to read plaintext secrets out of a compromised runtime.
- In one sentence: *the vault protects secrets stored on disk from unauthorized
  file access and offline inspection when a strong master password is used — it
  does not protect secrets from malware, malicious GNOME Shell extensions, a
  compromised user session, or other code already trusted to run as the current
  user.* **No extension can change this**, and this project does not claim to
  protect you from malware or a compromised GNOME session.
- Features that reveal data or send it anywhere start **off**. Security-sensitive
  defaults are conservative, and opt-in features are documented where they are
  enabled (settings + README).

## Vault encryption at rest

- The vault is a **standard encrypted archive** containing a single `data.json`:
  - **ZIP** (default) — AES-256 via WinZip AES (`-mem=AES256`,
    PBKDF2-HMAC-SHA1). The legacy ZipCrypto algorithm is **never** used for new
    archives; archives written by older versions of the extension still open and
    are re-encrypted to AES-256 at the next save.
  - **7z** (opt-in) — native AES-256 with **encrypted headers** (the internal
    file name and sizes are not visible from the file alone).
- The archive is encrypted **at rest**; while the vault is unlocked its contents
  are held in the extension's memory (see the README for the session lifecycle —
  auto-lock on screen lock / suspend and after path changes).
- Encryption is performed by the external **7-Zip** binary (a required
  dependency). The extension detects the actual container from the archive's
  magic bytes, not from the file name, so a `.zip`-named 7z archive can never
  be silently treated as ZIP.
- The loader enforces **resource limits before trusting the content**: archive
  size, decompressed JSON size, item count (max 1000), per-field length and
  per-item extra-field count are bounded, and malformed data is validated — a
  crafted oversized archive is rejected with a readable error instead of
  grinding the shell to a halt or silently truncating a password.

## Master password & crypto trade-off

- **A strong, unique master password is required.** There is **no password
  reset and no recovery**: the master password is the key to the encryption.
  If you lose it, the archive cannot be opened — by anyone, including you.
  Keep it in a dedicated password manager.
- **Crypto trade-off:** WinZip AES' key derivation (PBKDF2-HMAC-SHA1) is
  **not** a modern memory-hard KDF such as scrypt or Argon2. 7z's AES-256 is
  likewise not equivalent to a memory-hard KDF. Against an offline attacker who
  obtained a copy of your archive, the practical protection therefore comes
  mostly from **the entropy of the master password** — a long, random, unique
  password is not optional, it *is* the security boundary of the vault.
- The master password is **never passed on the 7z command line**: it is handed
  to `7z` through the process's **stdin** (with a value-less `-p` switch), so it
  never appears in the process list (`ps aux`) or in logs.

## Password generation (built-in 🎲 generator)

- Entropy comes from the **system CSPRNG** — `/dev/urandom`, read through Gio.
  (GJS exposes no WebCrypto API, so the kernel device is the source.)
- Indices are drawn with **rejection sampling** (values that would bias the
  draw are re-drawn — no modulo bias), and the shuffle is **Fisher–Yates** with
  CSPRNG indices; `Math.random()` is never used for secrets.
- If entropy cannot be read (e.g. a broken `/dev/urandom`), generation **fails
  loudly** with an error notification — there is no silent fallback to a weaker
  random source.

## File protection

- Keep the archive in a **protected location** (the default
  `~/.config/clipboard-with-passwords/` is a good private spot) — not in a
  world-readable directory.
- Permissions are hardened automatically: a freshly created vault directory is
  `0700` (pre-existing directories are left as they are), and the archive and
  its `.bak` are chmod'ed to `0600` after every save — other local users cannot
  read (and offline-crack) the encrypted vault.
- `.bak` files are copies of the **same encrypted archive** and deserve the
  same filesystem protection as the archive itself. Restore instructions live
  in the README.
- Saves are **atomic and verified**: the archive is written to a temporary file
  in the same directory, decrypted back and compared with the exact JSON that
  was serialized, and only then renamed over the target. A write that failed
  mid-way can never destroy the previous healthy archive (and its `.bak`).
- Two kinds of temporary files exist around a save and neither outlives normal
  operations: the **encrypted** archive is staged in a temporary file in the
  vault's own directory (same filesystem), and the **plaintext** JSON being
  packed lives only inside a private (0700) directory in the system temp dir
  (the file itself tightened to 0600) and is removed as soon as packing
  finishes. Leftovers of a save that died mid-way (crash, kill, power loss) are
  cleaned up at the next vault open or save — deletion is strictly scoped to
  this extension's own exact temp-artifact names, and it is *opportunistic*:
  no guarantee of secure removal after abnormal termination is made.

## Clipboard & history

- The clipboard history is stored as **plain text** and is **not a secure
  secret store**: everything you copy is visible in the history list and on
  disk in your cache directory. Because this is a *clipboard manager*, this
  applies to **anything you copy anywhere** — from another password manager,
  a browser, an SSH client or a terminal — not only to values copied from the
  built-in vault.
- The system clipboard is readable by **any process you run, at any moment** —
  that is a property of the desktop, not something an extension can change.
- **Auto-clear** (default: on, 20 s) removes a value copied from the vault
  after the delay, but *only while the clipboard still holds exactly that
  value* (values you copy in the meantime are never touched). It **shortens**
  the time a secret sits in the clipboard; it **cannot** prevent a process that
  reads the clipboard *before* the clear.
- The «Add vault copies to clipboard history» setting is insecure by nature and
  **off by default**.
- While the vault is unlocked, secrets are held in memory in the extension. JS
  strings cannot be guaranteed zeroized; on lock the in-memory references are
  dropped and the data is reclaimed by the garbage collector. The extension
  does **not** promise guaranteed memory erasure.

## Network access

- **By default the extension does not send clipboard data (or anything else) to
  third-party services.**
- The documented exception: the optional **YouTube title fetch** (off by
  default) sends the copied YouTube link to `https://www.youtube.com/oembed`
  when enabled.

## Privacy mask (display-only)

- The privacy mask replaces the visible characters of a pinned item for
  on-screen privacy (meetings, screen recordings). It is **display-only, not
  encryption**: the full value stays stored and readable — in the vault and in
  the item's own entry — and anyone with access to your session can see it.

## Implementation commitments

- **No homegrown cryptography.** The vault uses standard, well-known container
  formats (WinZip AES ZIP / 7z AES-256) through the standard **7-Zip** binary;
  no custom crypto or KDF is implemented in the extension.
- **No network analysis of your data.** Clipboard content is never sent
  anywhere for "password detection" or remote analysis (see
  [Network access](#network-access)).
- **Auto-clear is never unconditional.** The clipboard is cleared only while it
  still holds exactly the copied value; content you copied in the meantime is
  left untouched.
- **Nothing is hidden from the user.** Security-sensitive behavior and its
  limitations are documented here and in the README rather than papered over —
  no feature is presented as stronger than it is.

## What this extension does not promise

- 🚫 Protection against **malware or a compromised session** — anything running
  as your user can read your clipboard, unlocked vault and files.
- 🚫 Claims of "unbreakable" or similarly overstated security — see the crypto
  trade-off above; security always depends on the master password and on
  keeping your session trustable.
- 🚫 Guaranteed **memory erasure** when locking — not possible in JS/GJS; on
  lock the in-memory references are dropped and the data is reclaimed by the
  garbage collector.
- 🚫 Vault recovery without the master password.

---

*Feature behavior (archive formats, session lifecycle, settings) is documented
in the [README](README.md); this file intentionally contains only the security
model.*