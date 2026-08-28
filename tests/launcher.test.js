// Opening a URL is one call, and every interesting thing about it is what happens when that
// call does not work. A machine with no browser, a handler that refuses, a portal that
// errors: none of them may throw into the compositor, and all of them have to say something
// a person can act on.
//
// The seam is the launch itself. Everything above it — deciding whether to launch at all,
// turning a GError into a sentence, making sure exactly one message is shown — is tested
// here, under plain gjs, with no browser and no desktop.

import Gio from 'gi://Gio';

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import { createLauncher, launchFailureMessage } from '../src/lib/launcher.js';

/** A launch seam that records what it was asked for and answers however the test says. */
function recorder(answer = () => Promise.resolve()) {
    const calls = [];
    const launch = (uri, context) => {
        calls.push({ uri, context });
        return answer(uri, context);
    };
    return { launch, calls };
}

/** A notifier that records instead of putting anything on screen. */
function notifier() {
    const messages = [];
    return { notify: (title, body) => messages.push({ title, body }), messages };
}

const MEET = { label: 'Meet', url: 'https://meet.openvidu.io/' };

suite('opening a destination', () => {
    test('hands the URL to the default handler, exactly as stored', async () => {
        const { launch, calls } = recorder();
        const { notify, messages } = notifier();
        const launcher = createLauncher({ launch, notify });

        const opened = await launcher.open(MEET);

        assertEqual(opened, true, 'the launcher reported a failure');
        assertDeepEqual(calls.map(c => c.uri), ['https://meet.openvidu.io/']);
        assertEqual(messages.length, 0, `it said something on success: ${JSON.stringify(messages)}`);
    });

    test('passes the launch context through, so the browser is not flagged as demanding attention', async () => {
        // Without the shell's own launch context the browser arrives with no startup
        // timestamp: it opens on the wrong workspace, or the shell decides it is stealing
        // focus and lights it up in the dash instead of raising it.
        const context = { pretend: 'AppLaunchContext' };
        const { launch, calls } = recorder();
        await createLauncher({ launch, notify: () => {}, launchContext: () => context })
            .open(MEET);
        assertEqual(calls[0].context, context);
    });

    test('a missing launch context is not an error — it is just no context', async () => {
        const { launch, calls } = recorder();
        await createLauncher({ launch, notify: () => {} }).open(MEET);
        assertEqual(calls[0].context, null);
    });

    test('one click is one launch', async () => {
        const { launch, calls } = recorder();
        const launcher = createLauncher({ launch, notify: () => {} });
        await launcher.open(MEET);
        await launcher.open(MEET);
        assertEqual(calls.length, 2);
    });
});

suite('when the launch does not work', () => {
    test('a handler that refuses produces a message, not a throw', async () => {
        const { launch } = recorder(() => Promise.reject(new Error('the browser said no')));
        const { notify, messages } = notifier();

        const opened = await createLauncher({ launch, notify }).open(MEET);

        assertEqual(opened, false);
        assertEqual(messages.length, 1, 'expected exactly one message');
        assert(messages[0].title.includes('Meet'),
            `the message does not name the destination: ${messages[0].title}`);
    });

    test('a seam that throws before it ever gets asynchronous is caught too', async () => {
        // Gio.AppInfo.launch_default_for_uri_async can raise on the calling frame — a
        // malformed URI, a broken portal — and a promise chain that only handles rejection
        // would let that one straight into the compositor.
        const { notify, messages } = notifier();
        const opened = await createLauncher({
            launch: () => { throw new Error('raised on the calling frame'); },
            notify,
        }).open(MEET);

        assertEqual(opened, false);
        assertEqual(messages.length, 1);
    });

    test('a seam that returns nothing at all is treated as having worked', async () => {
        // A synchronous seam is a legitimate shape; only a rejection is a failure.
        const { notify, messages } = notifier();
        const opened = await createLauncher({ launch: () => undefined, notify }).open(MEET);
        assertEqual(opened, true);
        assertEqual(messages.length, 0);
    });

    test('a notifier that itself throws does not escape into the shell', async () => {
        // The failure path is the one nobody exercises by hand, so it is the one that must
        // not have a second failure hiding inside it.
        const { launch } = recorder(() => Promise.reject(new Error('no')));
        const opened = await createLauncher({
            launch,
            notify: () => { throw new Error('the message could not be shown either'); },
        }).open(MEET);
        assertEqual(opened, false);
    });

    test('the extension is still usable afterwards: the next launch is attempted', async () => {
        let fail = true;
        const { launch, calls } = recorder(() =>
            fail ? Promise.reject(new Error('no')) : Promise.resolve());
        const launcher = createLauncher({ launch, notify: () => {} });

        await launcher.open(MEET);
        fail = false;
        const opened = await launcher.open(MEET);

        assertEqual(opened, true, 'a failure left the launcher dead');
        assertEqual(calls.length, 2);
    });
});

suite('a destination the rules refuse never reaches a browser', () => {
    test('nothing is launched, and the reason is shown', async () => {
        const { launch, calls } = recorder();
        const { notify, messages } = notifier();

        const opened = await createLauncher({ launch, notify })
            .open({ label: 'Sneaky', url: 'file:///etc/passwd' });

        assertEqual(opened, false);
        assertEqual(calls.length, 0, 'a file: URL was handed to the default handler');
        assertEqual(messages.length, 1);
        assert(messages[0].body.includes('https'),
            `the reason does not mention the rule: ${messages[0].body}`);
    });

    test('so does a destination that is not one at all', async () => {
        const { launch, calls } = recorder();
        const { notify, messages } = notifier();
        for (const value of [null, undefined, {}, { label: 'x' }])
            await createLauncher({ launch, notify }).open(value);
        assertEqual(calls.length, 0);
        assertEqual(messages.length, 4);
    });
});

suite('what the failure message says', () => {
    test('it names the destination the user clicked', () => {
        const { title } = launchFailureMessage('Meet next', new Error('nope'));
        assert(title.includes('Meet next'), title);
    });

    test('no registered handler is described as no browser, not as an error code', () => {
        // This is a real state on a bare machine and in a fresh container, and
        // "GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown" helps nobody.
        const noHandler = new Gio.IOErrorEnum({
            code: Gio.IOErrorEnum.NOT_SUPPORTED,
            message: 'No application is registered as handling this file',
        });
        const { body } = launchFailureMessage('Meet', noHandler);
        assert(/default (browser|application)/i.test(body),
            `the message does not point at the default browser: ${body}`);
        assert(!body.includes('GDBus'), `the message leaks the raw error: ${body}`);
    });

    test('any other failure still says what went wrong', () => {
        const { body } = launchFailureMessage('Meet', new Error('the portal timed out'));
        assert(body.includes('the portal timed out'), body);
    });

    test('an error with nothing to say still produces a sentence', () => {
        for (const error of [null, undefined, {}, 'a string']) {
            const { title, body } = launchFailureMessage('Meet', error);
            assert(title.length > 0 && body.length > 0,
                `empty message for ${JSON.stringify(error)}`);
        }
    });
});
