// A test harness small enough to read in one sitting. No dependencies beyond GLib, so the
// whole suite runs under plain `gjs -m tests/run.js` with no display and no compositor.

import GLib from 'gi://GLib';

const suites = [];
let current = null;

/** Declare a group of tests. Groups print together and share nothing. */
export function suite(name, body) {
    current = { name, tests: [] };
    suites.push(current);
    body();
    current = null;
}

/** Declare one test. `fn` throws to fail. */
export function test(name, fn) {
    if (current === null)
        throw new Error(`test("${name}") declared outside a suite()`);
    current.tests.push({ name, fn });
}

export function assert(cond, message = 'assertion failed') {
    if (!cond)
        throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
    if (!Object.is(actual, expected)) {
        throw new Error(
            `${message ? message + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

/** Deep equality over JSON-shaped values — enough for row models and argv arrays. */
export function assertDeepEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message ? message + ': ' : ''}expected ${b}, got ${a}`);
}

export function assertThrows(fn, message = 'expected a throw') {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error(message);
}

// Deadline for one asynchronous test. Long enough for a real subprocess on a loaded
// machine, short enough that a hung test is a failure rather than a hung CI job.
const ASYNC_TIMEOUT_SECONDS = 30;

/**
 * If a test returned a promise, run a main loop until it settles and rethrow whatever it
 * rejected with. Everything asynchronous in this extension is driven by the same GLib main
 * loop the shell runs, so this is the loop the code under test expects.
 */
function settle(result) {
    if (result === null || typeof result?.then !== 'function')
        return;

    const loop = new GLib.MainLoop(null, false);
    let error = null;
    let done = false;

    let guardFired = false;
    const guard = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ASYNC_TIMEOUT_SECONDS, () => {
        guardFired = true;
        error = new Error(`timed out after ${ASYNC_TIMEOUT_SECONDS}s waiting for the test`);
        done = true;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    result.then(() => {
        done = true;
        loop.quit();
    }, e => {
        error = e instanceof Error ? e : new Error(`rejected with ${JSON.stringify(e)}`);
        done = true;
        loop.quit();
    });

    if (!done)
        loop.run();
    if (!guardFired)
        GLib.Source.remove(guard);

    if (error !== null)
        throw error;
}

/** Run every declared suite. Returns the process exit code. */
export function run() {
    let passed = 0;
    const failures = [];

    for (const s of suites) {
        print(`\n${s.name}`);
        for (const t of s.tests) {
            try {
                settle(t.fn());
                passed++;
                print(`  ok   ${t.name}`);
            } catch (e) {
                failures.push({ suite: s.name, test: t.name, error: e });
                print(`  FAIL ${t.name}`);
                print(`       ${e.message}`);
                if (e.stack)
                    print(e.stack.split('\n').map(l => `       ${l}`).join('\n'));
            }
        }
    }

    print('');
    if (failures.length === 0) {
        print(`${passed} tests passed`);
        return 0;
    }
    print(`${passed} passed, ${failures.length} FAILED`);
    for (const f of failures)
        print(`  ${f.suite} / ${f.test}`);
    return 1;
}
