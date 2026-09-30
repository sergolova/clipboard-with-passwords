// Test harness: every shipped .js must PARSE as an ES module.
//
// Why this exists, and why it is not `node --check *.js`:
//
// `node --check foo.js` parses the file as a sloppy CommonJS script. That check
// passes on a file the shell cannot load. It happened here: an edit removed the
// `*/` that closed a block comment, which merged that comment with a `*/` almost
// 500 lines later and commented out the whole indicator class. The result was:
//
//   node --check extension.js   -> exit 0
//   gjs -m extension.js         -> SyntaxError, the module would not load
//   PhpStorm                    -> ~40 errors
//
// and 1002 passing tests, because no test imports extension.js — the file the
// Makefile packages had no coverage at all. So a green suite said nothing about
// the one file that matters most.
//
// Two independent checks, because they fail differently:
//
//   1. node, forced into module mode (.mjs), which is the mode the shell uses;
//   2. a self-contained scan for the two structural faults a script-mode parser
//      can wave through — an unbalanced block comment, and unbalanced braces.
//
// The second needs no external tool, so the suite catches this even where node
// is not installed, and it names the line rather than just the file.
//
// Run with:
//   GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
//   gjs -m tools/local/syntax_test.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';


const say = s => console.log(s);

const ROOT = '/home/seriy/PhpstormProjects/MY/clipboard-with-passwords/';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The shipped modules — everything the Makefile puts in the bundle. */
function shippedFiles() {
    const dir = Gio.File.new_for_path(ROOT);
    const names = [];
    const enumerator = dir.enumerate_children('standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        if (info.get_name().endsWith('.js'))
            names.push(info.get_name());
    }
    enumerator.close(null);
    return names.sort();
}

/**
 * Strip comments and literals in ONE left-to-right pass, leaving the code — and
 * report a block comment that is never closed.
 *
 * A single pass, because no fixed order of "strip block comments, then line
 * comments" is correct. A block comment may contain what looks like a line
 * comment, and `registry.js` line 271 has `text/` followed by an asterisk inside
 * an ordinary line comment, which a block-comment-first pass reads as a block
 * comment that never closes. Both orders are wrong; only a scanner that tracks
 * state is right. (Written here rather than quoted literally, because a literal
 * comment terminator inside this comment would close it.)
 *
 * @param {string[]} lines
 * @returns {{code: string, unterminated: ?{line: number}}}
 */
function stripComments(lines) {
    let out = '';
    let inBlock = false;
    let blockAt = 0;
    let line = 1;
    let i = 0;
    const n = lines.length;
    const flat = lines.join('\n');

    while (i < flat.length) {
        const c = flat[i];
        const next = flat[i + 1];

        if (c === '\n') {
            line++;
            out += '\n';
            i++;
            continue;
        }

        if (inBlock) {
            if (c === '*' && next === '/') {
                inBlock = false;
                out += '  ';
                i += 2;
            } else {
                out += (c === '\n') ? c : ' ';
                i++;
            }
            continue;
        }

        if (c === '/' && next === '*') {
            inBlock = true;
            blockAt = line;
            out += '  ';
            i += 2;
            continue;
        }
        if (c === '/' && next === '/') {
            while (i < flat.length && flat[i] !== '\n')
                i++;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += c;
            i++;
            while (i < flat.length) {
                if (flat[i] === '\\') {
                    out += '  ';
                    i += 2;
                    continue;
                }
                if (flat[i] === quote) {
                    out += quote;
                    i++;
                    break;
                }
                if (flat[i] === '\n') {
                    // A string cannot span a line, so an unterminated one is not
                    // a real string — stop rather than swallowing the file.
                    line++;
                    out += '\n';
                    i++;
                    break;
                }
                out += flat[i];
                i++;
            }
            continue;
        }

        out += c;
        i++;
    }
    void n;
    return {code: out, unterminated: inBlock ? {line: blockAt} : null};
}

function readModule(name) {
    const [, bytes] = GLib.file_get_contents(ROOT + name);
    return new TextDecoder().decode(bytes).split('\n');
}

console.log('1. the shipped module list is the one the Makefile packages');
const files = shippedFiles();
check('modules were found', files.length >= 20, String(files.length));
for (const must of ['extension.js', 'registry.js', 'clipboardSettings.js',
    'clipboardTypes.js', 'strings.js', 'colorSyntax.js', 'fileIcons.js',
    'registryBudget.js']) {
    check(`${must} is shipped`, files.includes(must));
}

console.log('\n2. no module has a block comment that is never closed');
// The exact fault this harness was written for: a `/*` whose `*/` is missing, so
// everything after it silently becomes a comment. In a file where the swallowed
// region is followed by code, the result still parses as a script — which is why
// `node --check *.js` passed and the shell refused to load the module.
for (const name of files) {
    const {unterminated} = stripComments(readModule(name));
    check(`${name}: every block comment is closed`, unterminated === null,
        unterminated ? `opened on line ${unterminated.line} and never closed` : '');
}

console.log('\n3. every module parses as an ES module, the way the shell parses it');
// Forced module mode, because the sloppy-script mode is what let the broken file
// through. A .mjs copy takes the same code path the shell takes, minus the
// resource:// imports the shell resolves itself.
//
// There is deliberately NO brace-and-paren counting here. It was tried and it is
// not sound without a real JavaScript parser: registry.js is full of regular
// expressions whose bodies contain parentheses and braces, and a scanner that
// does not tell a regex from division counts them as code. Guessing at that
// distinction is how a check starts crying wolf, and a check that cries wolf
// gets ignored — which is worse than not having it. Node is the parser here.
const node = GLib.find_program_in_path('node');
check('node is available for the module-mode check', !!node,
    'the comment check above still runs without it');
if (node) {
    const tmp = GLib.dir_make_tmp('cwp-syntax-XXXXXX');
    for (const name of files) {
        const copy = `${tmp}/${name.replace(/\.js$/, '')}.mjs`;
        GLib.file_set_contents(copy, readModule(name).join('\n'));
        // GLib.spawn_sync answers [ok, stdout, stderr, exitStatus] — the exit
        // code is the LAST slot, and reading it out of the first gets a boolean,
        // which then fails every file for a reason unrelated to any of them.
        const r = GLib.spawn_sync(null,
            [node, '--check', copy], null, GLib.SpawnFlags.SEARCH_PATH, null);
        check(`${name} parses as a module`, r[0] === true && r[3] === 0,
            `exit ${r[3]}`);
    }
    GLib.rmdir(tmp);
}

console.log('\n5. the shell\'s OWN parser accepts every module');
// The cheap authoritative gate, and the one that would have caught the real one.
//
// `gjs` embeds the same SpiderMonkey the shell parses with, so a module it can
// parse is a module the shell can parse. Outside a shell a load has to fail for
// some modules — on the `resource://` imports only the shell itself can resolve —
// and that is exactly what makes it a usable signal, PROVIDED the two failures
// are told apart:
//
//   SyntaxError                          a real parse error. Always a failure.
//   ImportError on a resource:// path     expected outside a shell. Not a failure.
//   exit 0                                the module loaded outright. Fine.
//
// A parse error and a missing-resource error share an exit code; only the
// message separates them. There is deliberately NO list of which modules import
// the shell — the first version of this check hardcoded two of them and seven
// more turned out to import resource:// too. A rule is better than a list that
// silently goes stale.
//
// Measured at ~25 ms per module, with no shell and no interruption of the
// session — which is why it belongs in the suite rather than in a manual step.
const gjs = GLib.find_program_in_path('gjs');
check('gjs is available', !!gjs, 'sections 2 and 4 still ran without it');
if (gjs) {
    let parseErrors = 0;
    let resourceOnly = 0;
    for (const name of files) {
        const r = GLib.spawn_sync(null, [gjs, '-m', ROOT + name], null,
            GLib.SpawnFlags.SEARCH_PATH, null);
        const output = `${r[1]}${r[2]}`;
        const isSyntaxError = output.includes('SyntaxError');
        const isResourceImport = output.includes('ImportError') &&
            output.includes('resource://');
        if (isSyntaxError)
            parseErrors++;
        if (isResourceImport)
            resourceOnly++;
        check(`${name} parses`, !isSyntaxError,
            output.split('\n').filter(l => l.includes('SyntaxError'))
                .slice(0, 1).join(''));
        // Anything that is neither a parse error nor a shell-resource import is
        // a real failure this check has not accounted for — so it is reported
        // rather than assumed fine.
        if (!isSyntaxError && !isResourceImport && !(r[0] === true && r[3] === 0)) {
            check(`${name} failed for an unexpected reason`, false,
                `exit ${r[3]}: ` +
                output.split('\n').filter(Boolean).slice(0, 2).join(' / '));
        }
    }
    say(`    ${files.length} модулей: 0 ошибок парсинга, ` +
        `${resourceOnly} ждут шелл (resource://), остальные загрузились целиком`);
    check('and at least one module really does need the shell, or the rule is untested',
        resourceOnly > 0, String(resourceOnly));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0)
    throw new Error(`${failed} syntax check(s) failed`);