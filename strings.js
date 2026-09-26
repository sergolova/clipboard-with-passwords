// Minimal printf-style formatter for translated strings that carry positional
// placeholders (%1$s, %2$d). GJS does not expose String.prototype.format (the
// codebase must therefore never rely on it), and a bare `.replace('%1$s', x)`
// would substitute only the first occurrence — so every user-facing string
// with placeholders routes through this helper.
//
// Supported placeholders: %1$s, %2$s, %1$d, %2$d … (the index is 1-based).
// Unknown indexes render as ''; the literal sequence '%%' is left untouched.
export function fmt(tpl, ...args) {
    return String(tpl).replace(/%(\d+)\$([ds])/g, (match, idx, type) => {
        const value = args[Number(idx) - 1];
        if (value === undefined) {
            return '';
        }
        return type === 'd' ? String(Math.floor(Number(value))) : String(value);
    });
}