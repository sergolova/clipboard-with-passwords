// Test harness for registrySaver.js — the debounced single-writer core behind
// registry.txt persistence.
//
// Sections 1-9 use FAKE timers and a recording writer whose completion the
// test controls by hand, so every coalescing / ordering scenario is
// deterministic: no real waits, no real file IO, no race window. Sections 10-
// 11 are REAL-GLib integration cases: they arm genuine main-loop timers
// through the exact glue registry.js injects (3-arg GLib.timeout_add), so a
// change to that glue — e.g. back to the 2-arg shorthand, which throws in the
// shell's GJS — fails the harness instead of silently killing persistence.
// The production module is imported verbatim (it is pure JS — no gi://
// imports of its own).
// Run with: gjs -m tools/local/registry_saver_test.js

import { DebouncedSaver } from '../registrySaver.js';
import GLib from 'gi://GLib';

let passed = 0, failed = 0;
function check(name, cond) {
    if (cond) { passed++; console.log(`  PASS ${name}`); }
    else { failed++; console.log(`  FAIL ${name}`); }
}

const loop = new GLib.MainLoop(null, false);

// Real main-context delay, driven by the loop.run() at the bottom.
function delay(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Deterministic fake environment: one debounce slot, a recording writer whose
// promises only resolve when the test says so.
function makeEnv({rejectWrites = false} = {}) {
    let timer = null;          // {ms, cb} while a debounce is armed
    let timerArms = 0;         // how many times a timer was scheduled
    const writes = [];         // snapshots handed to the writer, in order
    const pending = [];        // resolvers for the in-flight write promises
    const saver = new DebouncedSaver({
        debounceMs: 150,
        scheduleTimer: (ms, cb) => { timerArms++; timer = {ms, cb}; return timerArms; },
        cancelTimer: () => { timer = null; },
        write: (snapshot) => {
            writes.push(snapshot);
            return new Promise((resolve, reject) => {
                pending.push(() => rejectWrites ? reject(new Error('io')) : resolve());
            });
        },
    });
    return {
        saver,
        get writes() { return writes.slice(); },
        get pendingCount() { return pending.length; },
        get timerArmed() { return timer !== null; },
        get timerArms() { return timerArms; },
        fireTimer() {
            const t = timer;
            timer = null;
            if (t) t.cb();
        },
        completeWrite() {  // resolve the OLDEST in-flight write
            const done = pending.shift();
            if (done) done();
        },
        async settle() {  // flush microtasks (saver's .then(done) handlers)
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

async function main() {
    console.log('== 1. schedule alone does not write immediately ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        check('no write before the debounce fires', env.writes.length === 0);
        check('debounce timer armed', env.timerArmed);
    }

    console.log('== 2. timer fire → exactly one write with the scheduled snapshot ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        env.fireTimer();
        await env.settle();
        check('one write', env.writes.length === 1);
        check('writes the scheduled snapshot', env.writes[0] === 'A');
        env.completeWrite();
        await env.settle();
        check('no write after completion', env.writes.length === 1);
        check('timer not re-armed', env.timerArms === 1 && !env.timerArmed);
    }

    console.log('== 3. burst inside the window coalesces into one write with the LAST snapshot ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        env.saver.schedule('B');
        env.saver.schedule('C');
        check('only one timer for the whole burst', env.timerArms === 1);
        env.fireTimer();
        await env.settle();
        check('one write for three schedules', env.writes.length === 1);
        check('writes the latest snapshot', env.writes[0] === 'C');
        env.completeWrite();
        await env.settle();
        check('nothing left behind', env.writes.length === 1);
    }

    console.log('== 4. schedule during an in-flight write queues ONE follow-up (latest), no second writer ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        env.fireTimer();
        await env.settle();
        check('write A started', env.writes.length === 1 && env.writes[0] === 'A');
        env.saver.schedule('B');
        env.saver.schedule('C');
        check('no second writer while A is in flight', env.writes.length === 1);
        check('no debounce timer armed either', !env.timerArmed);
        env.completeWrite();
        await env.settle();
        check('follow-up write carries the latest (B collapsed into C)',
              env.writes.length === 2 && env.writes[1] === 'C');
        env.completeWrite();
        await env.settle();
        check('devoted follow-up done — nothing more queued', env.writes.length === 2);
    }

    console.log('== 5. flush with a pending debounce writes immediately and cancels the timer ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        env.saver.flush();
        await env.settle();
        check('write happened without waiting', env.writes.length === 1 && env.writes[0] === 'A');
        check('timer cancelled (firing later must not double-write)', !env.timerArmed);
        env.fireTimer();
        await env.settle();
        check('late timer fire is harmless', env.writes.length === 1);
        env.completeWrite();
        await env.settle();
        check('no extra write after completion', env.writes.length === 1);
    }

    console.log('== 6. flush with nothing scheduled is a no-op ==');
    {
        const env = makeEnv();
        env.saver.flush();
        await env.settle();
        check('no write', env.writes.length === 0);
    }

    console.log('== 7. flush during an in-flight write never starts a concurrent writer ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        env.fireTimer();
        await env.settle();
        env.saver.schedule('B');
        env.saver.flush();
        check('still exactly one writer', env.writes.length === 1);
        env.completeWrite();
        await env.settle();
        check('follow-up carries B', env.writes.length === 2 && env.writes[1] === 'B');
        env.completeWrite();
        await env.settle();
        check('settled', env.writes.length === 2);
    }

    console.log('== 8. the queue keeps working across several write cycles ==');
    {
        const env = makeEnv();
        env.saver.schedule('A');
        env.fireTimer(); await env.settle();
        env.saver.schedule('B');              // queued behind A
        env.completeWrite(); await env.settle();  // A done → B starts
        env.saver.schedule('C');              // queued behind B
        env.completeWrite(); await env.settle();  // B done → C starts
        check('full ordering A,B,C preserved', env.writes.join(',') === 'A,B,C');
        env.completeWrite(); await env.settle();
        check('nothing more after C', env.writes.length === 3);
    }

    console.log('== 9. writer failure does not wedge the saver ==');
    {
        const env = makeEnv({rejectWrites: true});
        env.saver.schedule('A');
        env.fireTimer(); await env.settle();
        check('write A attempted', env.writes.length === 1);
        env.saver.schedule('B');
        env.completeWrite(); await env.settle();
        check('follow-up B still written after A failed',
              env.writes.length === 2 && env.writes[1] === 'B');
        env.completeWrite(); await env.settle();
        check('in-flight flag cleared', env.writes.length === 2);
    }

    console.log('== 10. REAL glue: 3-arg GLib.timeout_add drives the debounce (regression: 2-arg shorthand throws) ==');
    {
        const writes = [];
        const saver = new DebouncedSaver({
            debounceMs: 40,
            // This is the exact glue injection registry.js uses (3-arg form).
            // If it ever regresses to the 2-arg shorthand, schedule() throws
            // here (GLib.timeout_add demands at least 3 args) and main() fails
            // the harness loudly instead of the shell failing silently.
            scheduleTimer: (ms, cb) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, cb),
            cancelTimer: (sourceId) => GLib.source_remove(sourceId),
            write: (snapshot) => { writes.push(snapshot); return Promise.resolve(); },
        });
        saver.schedule('A');
        saver.schedule('B');
        await delay(250);
        check('real debounce fired exactly once with the latest snapshot',
              writes.length === 1 && writes[0] === 'B');
    }

    console.log('== 11. REAL glue: flush cancels the genuine timer, no double write ==');
    {
        const writes = [];
        const saver = new DebouncedSaver({
            debounceMs: 40,
            scheduleTimer: (ms, cb) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, cb),
            cancelTimer: (sourceId) => GLib.source_remove(sourceId),
            write: (snapshot) => { writes.push(snapshot); return Promise.resolve(); },
        });
        saver.schedule('A');
        saver.flush();
        await delay(0);
        check('flush wrote immediately', writes.length === 1 && writes[0] === 'A');
        await delay(250);
        check('cancelled real timer did not double-write', writes.length === 1);
    }

    console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
    loop.quit();
    if (failed > 0)
        process.exit(1);
}

main().catch(e => { console.log('HARNESS ERROR:', e); loop.quit(); process.exit(1); });
loop.run();