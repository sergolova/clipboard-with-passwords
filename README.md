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

### 🛡️ Protect pinned items
Pinned (favorite) text items can be flagged as a **password** with a single click (`Mark as password`). The last **3 characters** of the item are then replaced with `***` everywhere it is displayed — in the menu and in the topbar preview. Handy for passwords and other sensitive data during meetings and screen recordings.

### 🔐 Built-in password manager
- Sensitive data is stored in a **separate encrypted ZIP archive** at a user-defined path (default `~/.config/clipboard-indicator/passwords.zip`).
- The archive is a **standard encrypted ZIP** — it can be read and edited outside the extension (see [The vault archive](#the-vault-archive)).
- The archive contains a single `passwords.json` file, which can also be edited manually.
- Access is protected by a **master password**.

### 🏷️ Flexible service records
- Besides the standard **login** and **password**, each service supports **arbitrary custom fields** (e.g. 2FA code, PIN, recovery key).
- Each custom field can be **hidden** (shown as `••••••••`, toggleable with one click).

### 🔍 Vault search & filter
- Convenient filter to search services **by name, description and login** (also matches category and custom field labels/values).
- Categories with no services are hidden automatically; the bar re-layouts to fill the menu width.
- The **last used service** stays pinned at the top of the vault for quick access.

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
  "categories": ["Общее", "Работа", "Личное"],
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
        { "label": "PIN", "value": "5531", "isHidden": false }
      ],
      "updatedAt": 1737528540000
    }
  ]
}
```

Field reference:

| Field | Type | Description |
| --- | --- | --- |
| `version` | int | Archive format version (`1`) |
| `categories` | string[] | Category names (displayed in the filter bar) |
| `items[].id` | string | Unique service identifier |
| `items[].name` | string | Service name (shown as the card title) |
| `items[].category` | string | Category this service belongs to |
| `items[].description` | string | Optional one-line description (searchable) |
| `items[].login` | string | Login / e-mail |
| `items[].password` | string | Password |
| `items[].extraFields[]` | object[] | Custom fields: `label`, `value`, `isHidden` |
| `items[].updatedAt` | int | Unix timestamp of the last modification |

## ⚙️ Added settings

Compared to the original extension, two new settings were added:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `password-vault-path` | string | `~/.config/clipboard-indicator/passwords.zip` | Path to the encrypted vault ZIP archive |
| `toggle-password-vault` | keybinding | `<Super><Shift>p` | Shortcut to open/close the password vault menu |

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