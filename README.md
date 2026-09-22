# 🔐 Clipboard with Passwords

A fork of the popular [Clipboard Indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator) (v71) for GNOME Shell, extended with a **built-in encrypted password manager**.

Forked from: [Tudmotu/gnome-shell-extension-clipboard-indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator) · Extension UUID: `clipboard-with-passwords@sergolova`

---

## ✨ What's new compared to the original

### 🧠 Smart clipboard content recognition
Clipboard entries are detected and visually distinguished by their content type, each with its own accent color in the menu:

| Type | Example |
| --- | --- |
| **E-mail** | `user@example.com` |
| **URL** | `https://github.com` |
| **File list** | dragged/copied files show the file names |
| **Multi-line text** | shows a preview of the non-empty lines |
| **HTML/CSS colors** | predefined color names + hex codes (`#ff5500`) get a real color swatch preview |
| **Images** | thumbnails with a preview button |

Type-based coloring can be turned off in the settings («Colorize clipboard content»).

For copied **YouTube links**, the video title is fetched via the YouTube oEmbed API and shown under the URL — this is also a setting («Fetch YouTube video titles»), so network requests can be disabled entirely.

### 🛡️ Protect pinned items
Pinned (favorite) text items can be flagged as a **password** with a single click (`Mark as password`). The last **3 characters** of the item are then replaced with `***` everywhere it is displayed — in the menu and in the topbar preview. Handy for passwords and other sensitive data during meetings and screen recordings.

### 🔐 Built-in password manager
- Sensitive data is stored in a **separate encrypted ZIP archive** at a user-defined path (default `~/.config/clipboard-indicator/passwords.zip`).
- The archive is a **standard encrypted ZIP** — it can be read and edited outside the extension (see [The vault archive](#the-vault-archive)).
- The archive contains a single `passwords.json` file, which can also be edited manually.
- Access is protected by a **master password**.

> 🖱️ **Left-click** on the panel icon opens the regular clipboard list; **right-click**
> opens the password vault (the `Super+Shift+P` hotkey does the same). The whole
> vault feature can be turned off in the settings («Enable password vault»).

> ⚠️ **«Add vault copies to clipboard history»** — everything copied from the
> vault (*logins, passwords, custom fields, «copy all»*) is also added to the
> visible clipboard list. That list is stored in plain text, so **this is
> insecure** — keep it off unless you fully understand the risk. Default: off.

### 🏷️ Flexible service records
- Besides the standard **login** and **password**, each service supports **arbitrary custom fields** (e.g. 2FA code, PIN, recovery key).
- Each custom field can be **hidden** (shown as `••••••••`, toggleable with one click).

### 🔍 Vault search & filter
- Convenient filter to search services **by name, description and login** (also matches category and custom field labels/values).
- Categories with no services are hidden automatically; the bar re-layouts to fill the menu width.
- The **last used service** stays pinned at the top of the vault for quick access — pinning can be disabled in settings («Pin last used service card»).
- **«All» privacy mode** — with the setting «Hide services in the 'All' view» the vault shows *nothing* when the «All» category is selected; entries appear only while you type in the search box, and category counts are hidden as well.

### 📋 Convenience
- **«Copy all»** button — copies login, password and all custom fields at once, formatted as `ключ: значение` multi-line text.
- **Paste buttons** (📋) — insert the current clipboard content into dialogs on **X11**, where native Ctrl+V may silently fail inside shell dialogs.
- Clipboard menu: pinned and regular history are separated by a proper divider.

---

## Requirements

- **GNOME Shell 46 – 50**
- **7-Zip** (`7z` command) — used to encrypt and decrypt the vault archive.
  - Ubuntu / Debian: `sudo apt install p7zip-full`
  - Fedora: `sudo dnf install p7zip`
  - Arch Linux: `sudo pacman -S p7zip`
- Paste buttons inside dialogs work on **X11** (on Wayland the standard clipboard flow is used).

## Installation

Install the extension by symlinking your source checkout into GNOME's extensions directory:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
ln -s /path/to/clipboard-with-passwords \
    ~/.local/share/gnome-shell/extensions/clipboard-with-passwords@sergolova
```

Then restart the shell (`Alt+F2` → `r`) or log out and back in, and enable the extension in **GNOME Extensions** (or with `gnome-extensions enable clipboard-with-passwords@sergolova`).

> ℹ️ Windows/menus are auto-created on first use. History and settings are stored under
> `~/.cache/clipboard-with-passwords@sergolova` and in the GSettings schema
> `org.gnome.shell.extensions.clipboard-indicator` respectively.

## 🔐 The vault archive

The vault is a standard encrypted ZIP archive that contains a single `passwords.json` file.
The extension uses the `7z` command for both encryption and decryption.

Working with the archive manually:

```bash
# list the contents
7z l ~/.config/clipboard-indicator/passwords.zip

# extract the JSON to the current directory (you will be prompted for the master password)
7z x ~/.config/clipboard-indicator/passwords.zip

# extract the JSON to stdout and save it
7z x -so ~/.config/clipboard-indicator/passwords.zip > passwords.json

# write the file back into the archive (encrypted)
7z a -tzip -p"YOUR_MASTER_PASSWORD" ~/.config/clipboard-indicator/passwords.zip passwords.json
```

Each save also keeps a `.bak` copy of the previous archive next to it.

### Example `passwords.json`

```json
{
  "version": 1,
  "items": [
    {
      "id": "service_1737528540000_123",
      "name": "GitHub",
      "category": "Работа",
      "description": "Основной аккаунт разработчика",
      "login": "sergolova",
      "password": "s3cret-p@ss",
      "extraFields": [
        { "label": "2FA", "value": "384729", "isHidden": true },
        { "label": "PIN", "value": "5531" }
      ],
      "updatedAt": 1737528540000
    }
  ]
}
```

Empty and `false` fields are **omitted entirely**: an optional field (`category`,
`description`, `login`, `password`, `extraFields`) is only written when it has a
value, `extraFields[].label` is omitted when empty, and
`extraFields[].isHidden` is omitted when `false`. The file can be edited by
hand — categories shown in the filter bar are derived automatically from the
items, so there is no fixed `categories` list to maintain.

Field reference:

| Field | Type | Description |
| --- | --- | --- |
| `version` | int | Archive format version (`1`) |
| `items[].id` | string | Unique service identifier |
| `items[].name` | string | Service name (shown as the card title) |
| `items[].category` | string | _Optional._ Category this service belongs to (omitted when empty) |
| `items[].description` | string | _Optional._ One-line description, searchable (omitted when empty) |
| `items[].login` | string | _Optional._ Login / e-mail (omitted when empty) |
| `items[].password` | string | _Optional._ Password (omitted when empty) |
| `items[].extraFields[]` | object[] | _Optional._ Custom fields: `label`, `value`, `isHidden` (array omitted when empty) |
| `items[].updatedAt` | int | Unix timestamp of the last modification |

## 🔑 Master password & session lifecycle

**When the master password is requested.** The password is asked only when the
vault is opened (`Super+Shift+P`, right-click the panel icon, or the menu item)
and is **not unlocked yet**. The vault stays unlocked in memory for the whole
session — until one of the events below — so you are **not** prompted on every
open.

**Screen lock & suspend.** The vault is **auto-locked** when the screen locks
(wallpaper / `Super+L`) and when the machine goes to sleep: the vault menu (if
open) closes, a «vault locked» notification is shown, and the master password
is required again after waking up. This also happens when the vault file path
in the settings is changed while the vault was unlocked — the new path is never
written to without re-authentication.

**Logout / shell restart / reboot.** Nothing extra needs to be done — every
change is saved to the archive immediately, so the file on disk is always the
latest state. When the session ends the in-memory copy disappears and the vault
is effectively locked; the master password is requested again on the next
session.

**The archive is deleted while the extension is running.**
- If the vault is **unlocked** (the usual case mid-session): all services are
  kept in memory, and the next save simply recreates the archive with all the
  data (a fresh `.bak` is made from the previous state if it still existed).
- If the vault is **locked** when the file disappears (e.g. after auto-lock on
  suspend): unlocking creates a **new empty** vault for that master password.
  Your previous data is not destroyed though — the `passwords.zip.bak` from the
  last save (if any) is still on disk, and can be restored manually:

```bash
# recover the previous archive from the backup copy
cp ~/.config/clipboard-indicator/passwords.zip.bak ~/.config/clipboard-indicator/passwords.zip
```

**Invalid path or a write-protected file.** If the «Password vault file path»
setting points somewhere that cannot be used — a directory instead of a file,
a folder that cannot be created, a read-only file or directory, or a missing
`7z` binary — the unlock dialog shows a clear message instead of a generic
failure (bad paths also make every save attempt show a notification with the
reason). Fix the path in the extension settings and try again.

## ⚙️ Added settings

Compared to the original extension, these settings were added:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `password-vault-path` | string | `~/.config/clipboard-indicator/passwords.zip` | Path to the encrypted vault ZIP archive |
| `vault-enabled` | boolean | `true` | Enable the built-in password vault entirely |
| `vault-copy-to-history` | boolean | `false` | Add everything copied from the vault to the plain-text clipboard history (⚠️ insecure) |
| `toggle-password-vault` | keybinding | `<Super><Shift>p` | Shortcut to open/close the password vault menu |
| `vault-pin-recent` | boolean | `true` | Pin the last used service card at the top of the vault |
| `vault-hide-all-category` | boolean | `false` | «All» privacy mode — hide all services until the user searches |
| `colorize-clipboard` | boolean | `true` | Colorize clipboard entries by content type |
| `fetch-youtube-titles` | boolean | `true` | Fetch and show YouTube video titles for copied links |

## 🛠 Development

```bash
# syntax check the JavaScript
node --check extension.js && node --check passwordVault*.js

# update the translation template and merge it into the locale files
make update-po-files

# compile translations (.po → .mo) and the GSettings schema
make
```

## 📄 License & credits

- Original project: [Tudmotu/gnome-shell-extension-clipboard-indicator](https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator) — see [`LICENSE.rst`](LICENSE.rst).
- This fork (password vault and related features) is maintained by **sergolova**.