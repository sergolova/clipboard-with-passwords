import St from 'gi://St';

/**
 * Detect the active Shell color scheme (dark vs light).
 *
 * The authoritative source is the theme that is actually loaded: the root
 * theme node's default `color` is near-white on dark shell themes and
 * near-black on light ones (e.g. Adwaita dark uses `#ffffff`, light uses
 * `#282828`). `St.Settings.color-scheme` only records the *preferred* scheme
 * (default/prefer-dark/prefer-light), so it is used only as a fallback.
 *
 * @returns {boolean} true when the active theme is dark
 */
export function isDarkTheme() {
    try {
        // 1. INITIAL CHECK: ANALYSIS OF THE ROOT THEME NODE'S TEXT COLOR
        // In GNOME Shell (St), Clutter.Color channels range from 0 to 255 (not 0 to 1).
        // On dark themes, the text color (foreground) is light (luminance > 128),
        // while on light themes (Adwaita/Yaru Light), it is dark (luminance <= 128).
        const context = St.ThemeContext.get_for_stage(global.stage);
        const node = context.get_root_node();
        const color = node.get_foreground_color(); // Возвращает Clutter.Color

        const luminance = 0.299 * color.red + 0.587 * color.green + 0.114 * color.blue;
        const isDark = luminance > 128;

        return isDark;
    } catch (e) {
        try {
            // 2. SECONDARY PROBE: CHECKING SYSTEM SETTINGS (St.Settings)
            const scheme = St.Settings.get().color_scheme;

            // If PREFER_LIGHT is explicitly specified, this is a light theme
            if (scheme === St.SystemColorScheme.PREFER_LIGHT) {
                return false;
            }

            // If PREFER_DARK is explicitly specified, this is the dark theme
            if (scheme === St.SystemColorScheme.PREFER_DARK) {
                return true;
            }

            // 3. HANDLING 'DEFAULT' (e.g., the standard Ubuntu / Yaru theme, where 'default' = light)
            // 'DEFAULT' is not strictly considered dark. It’s safer to return `false` (light),
            // or to use the default setting of your target system.
            return false;
        } catch (e2) {
            return true;
        }
    }
}

/**
 * CSS style class that mirrors the active theme. Add it to an actor and all
 * its children become theme-aware via stylesheet.css rules like
 * `.ci-theme-light .ci-tag-label { ... }`.
 *
 * @returns {string} 'ci-theme-dark' | 'ci-theme-light'
 */
export function themeClass() {
    return isDarkTheme() ? 'ci-theme-dark' : 'ci-theme-light';
}

const DARK = {
    // Text
    text: '#eeeeee',            // primary label text (cards, buttons)
    secondary: '#888888',       // category tags, hints, metadata
    hint: '#888888',
    desc: '#bbbbbb',           // service description
    key: '#aaaaaa',            // field keys ("Login:", "Password:")
    accent: '#4af',            // recent-service name
    error: '#ff5555',
    warn: '#f5c242',           // warning icon (hidden-field edge junk)

    // Cards & surfaces
    cardBg: 'rgba(255,255,255,0.04)',
    cardBorder: 'rgba(255,255,255,0.08)',
    bannerBg: 'rgba(255,255,255,0.08)',
    bannerBorder: 'rgba(255,255,255,0.15)',

    // Category buttons
    catBg: 'rgba(255,255,255,0.1)',
    catText: '#eeeeee',
    catBgSelected: '#3584e4',
    catTextSelected: '#ffffff',

    // Color-swatch border (clipboard color entries)
    swatchBorder: 'rgba(255,255,255,0.4)',
};

const LIGHT = {
    text: '#1a1a1a',
    secondary: '#5c5c5c',
    hint: '#777777',
    desc: '#444444',
    key: '#555555',
    accent: '#2a7de1',
    error: '#c0392b',
    warn: '#c78a00',           // warning icon (hidden-field edge junk)

    cardBg: 'rgba(0,0,0,0.05)',
    cardBorder: 'rgba(0,0,0,0.12)',
    bannerBg: 'rgba(0,0,0,0.07)',
    bannerBorder: 'rgba(0,0,0,0.18)',

    catBg: 'rgba(0,0,0,0.10)',
    catText: '#1a1a1a',
    catBgSelected: '#3584e4',
    catTextSelected: '#ffffff',

    swatchBorder: 'rgba(0,0,0,0.6)',
};

/**
 * Color palette matching the active theme. Call it at UI-build time so the
 * values reflect the current scheme.
 *
 * @returns {object} palette of CSS-ready color strings
 */
export function themeColors() {
    return isDarkTheme() ? DARK : LIGHT;
}