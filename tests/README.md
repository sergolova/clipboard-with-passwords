# Tests

Two kinds of test live here, and they do not need the same anything.

| | where | needs | tracked in git |
|---|---|---|---|
| **Unit tests** | `tests/*_test.js` | `gjs` only | **yes** |
| **Probes** | `tests/probes/probe_*/` | a nested GNOME Shell | no — see below |

Run the unit tests from the repository root:

```bash
for f in tests/*_test.js; do
    GI_TYPELIB_PATH=/usr/lib/gnome-shell:/usr/lib/x86_64-linux-gnu/mutter-14 \
    GSETTINGS_SCHEMA_DIR=schemas \
    gjs -m "$f" 2>&1 | sed 's/Gjs-Console-Message: [0-9:.]* //' | grep -E '^  FAIL|passed,'
done
```

A file whose last line is a `passed, failed` count passed only when the `failed`
is zero. **Count the files, not just the totals**: a test that dies before its
first check still exits 0, and a missing line means it never ran. That is not
hypothetical — a stray `}` in `registry.js` once made three tests vanish from the
run without anything reporting a failure.

## The four symbols you will see in a test

They come from the file's own header, and each one is a different kind of check:

- `check(name, cond, detail)` — a boolean, used by most files.
- `eq(actual, expected, what)` — an equality, preferred where the failure message
  should name what differed.
- `say(...)` / `print(...)` — a value the test wants visible in the output,
  usually a measurement. **A `say` is not a check**; if a test only prints, it
  asserts nothing.
- `PASS` / `FAIL` in the output — the only lines worth reading. Everything else
  is context.

## Things that are easy to get wrong here

**A test that imports the wrong file proves nothing.** `logging.js`,
`strings.js`, `random.js` and `stdoutReader.js` in this directory are
**symlinks** to the modules in the repository root, not copies. They exist so a
test can import a real module by a path that resolves. They must stay
symlinks: a copy would drift, and a test against the copy would keep passing
after the real module had changed.

**Do not pin a number the user is free to change.** Two checks were written that
way and both had to be rewritten: a swatch colour assertion that failed when the
light-theme grey was adjusted, and an icon-size assertion that failed when the
icon went from 12px to 14px. Pin the *shape* — "a comma-separated `rgb()`", "an
icon between 1 and 16px", "a number of dropped files, not a fixed count" — and
print the value so a change is visible without being a failure.

**A test must not assert what it cannot know.** `meta.state` in the shell's
extension manager is a shell-internal enum; guessing its numbering produced a
check that failed against a perfectly working extension. Guessing in a test is
how a suite learns to be ignored.

**A test that always passes is worse than no test.** `|| true` in a condition,
a placeholder assertion, a value computed but never compared — all of these were
written by accident here and all of them were caught by reading the diff. If a
condition cannot fail, delete it.

**Do not count braces or parentheses.** Without a real JavaScript parser a
scanner cannot tell a regular-expression literal from division, and `registry.js`
is full of regexes containing both. This was tried, produced false failures, and
was removed. `tests/syntax_test.js` gets that answer from `node --check` on a
`.mjs` copy and from the shell's own parser instead.

**`node --check *.js` is not a check.** It parses each file as a sloppy
CommonJS script and passes on files the shell refuses to load. Use
`tests/syntax_test.js`.

## What `syntax_test.js` is for, and why it exists

It is the gate that would have caught a real outage. An edit once removed the
closing `*/` of a block comment, which merged it with a `*/` about 500 lines
later and commented out the entire indicator class. The result:

```
node --check extension.js   ->  exit 0
gjs -m extension.js         ->  SyntaxError, the module would not load
PhpStorm                    ->  ~40 errors
the test suite              ->  1002 passing
```

The suite was green because **no test imported `extension.js`** — the file the
Makefile ships had no coverage at all. `syntax_test.js` now covers every shipped
module in three ways, and it is the one test in this directory that is worth
knowing about: it checks that every block comment is closed, that every module
parses as an ES module, and that the shell's own parser accepts each one. It
takes about 25 ms per module and needs no shell, so it costs nothing to run.

## Probes: why they are not in git

A probe is a real extension that drives a real nested GNOME Shell, so it needs
the runner beside it, an X display, and this machine's extension uuid. Those are
not portable, so `tests/probes/` is ignored along with `tools/local/`.

```bash
tools/local/run_nested.sh <probe-name> <report.txt> [extra-uuids...]
# e.g.
tools/local/run_nested.sh probe_load /tmp/opencode/loadprobe.txt \
    clipboard-with-passwords@sergolova
```

The second argument is the report; the extra uuids are extensions to enable
alongside the probe, which is how a probe reaches the real indicator.

**A probe interrupts your live session.** The runner enables a probe by writing
the shared `enabled-extensions` key, which your own shell acts on immediately:
for the duration of the run the probe is enabled in your session too, and the
real extension is switched off. A probe whose `disable()` does nothing keeps
running after the runner restores the key, still holding the code it was loaded
with and still writing the report — that produced a 32-check probe reporting
"710 passed". If you add a probe, `disable()` must stop it.

Probes live in `tools/local/` only in the sense that their runner does; the
probes themselves are in `tests/probes/`.

## A pure test cannot check anything about width

A test that runs under plain `gjs` has no Pango layout, no font and no
allocation, so it cannot answer "does this text fit in 384 px". Anything that
looks like such a check in a unit test is either measuring something else or
asserting a number the author chose. `strings_test.js` deliberately tests only
what is font-independent — the whitespace flattening and the character count —
and states that a character count cannot stand in for a width.

`probe_rowwidth` is the width check, and it works comparatively: it builds rows
whose strings have the same character count but very different pixel widths, and
requires the rows to come out the same width. No particular width is asserted,
because the width is a CSS value the user can change.

Two things it learned the hard way, both of which would otherwise be rewritten
wrongly:

- **`get_pixel_size()` cannot prove that ellipsize is cutting.** Once ellipsize
  is on, St has already given the Pango layout the label's width as its own, so
  the text's pixel size and the label's allocation are equal by construction.
  Read the `ellipsize` property instead.
- **A `PopupMenuItem`'s label does not expand horizontally.** The shell creates
  it with `y_expand` only, so it asks for its full natural width and never gets
  cut. It has to be set to expand — and whatever else expands in that box must
  stop, or the two share the leftover space and the label is cut to half.

## Known wart

`vault_align_test.js` writes its fixture archives into `tests/align/` and
`tests/guard/`, beside the test file, rather than into a temporary directory.
They are therefore ignored by git and appear on disk after a run. It predates
this directory and is not worth changing casually — the test builds and
consumes real vault archives, and a temp directory would need the same
arrangement anyway. It is on the list of things to fix properly, not a thing to
be surprised by.
