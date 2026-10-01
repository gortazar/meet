// Static guards for the rules the extensions.gnome.org review checklist is made of, and for
// the one that keeps this suite honest: everything with a decision in it stays out of the
// compositor-only files, or it stops being testable here.

import { suite, test, assert, assertDeepEqual } from './harness.js';
import { readFile, listFiles } from './util.js';

const LIB = listFiles('src', 'lib').filter(name => name.endsWith('.js'));
const SHELL_FILES = ['extension.js', 'prefs.js'];
const ALL_SOURCES = [...SHELL_FILES.map(f => ['src', f]), ...LIB.map(n => ['src', 'lib', n])];

suite('code hygiene', () => {
    test('there is a lib/ to speak of', () => {
        assert(LIB.length >= 4, `only found ${LIB.length} modules under src/lib`);
    });

    test('nothing under lib/ imports the shell, so all of it runs under plain gjs', () => {
        // This is what makes the suite test the code the extension runs rather than a copy
        // of it. The moment a decision moves into extension.js it stops being covered.
        for (const name of LIB) {
            const source = readFile('src', 'lib', name);
            assert(!source.includes('resource:///org/gnome/shell'),
                `lib/${name} imports the shell`);
            for (const namespace of ['St', 'Clutter', 'Shell', 'Meta', 'Adw', 'Gtk']) {
                assert(!source.includes(`gi://${namespace}`),
                    `lib/${name} imports ${namespace}, which does not exist outside a ` +
                    'compositor or a GTK process');
            }
        }
    });

    test('the shell-side files use the modern ESM base classes', () => {
        const extension = readFile('src', 'extension.js');
        assert(extension.includes("from 'resource:///org/gnome/shell/extensions/extension.js'"),
            'extension.js does not import the Extension base class');
        assert(/export default class \w+ extends Extension/.test(extension),
            'extension.js does not export an Extension subclass');

        const prefs = readFile('src', 'prefs.js');
        assert(prefs.includes('ExtensionPreferences'),
            'prefs.js does not use ExtensionPreferences');
        assert(/export default class \w+ extends ExtensionPreferences/.test(prefs),
            'prefs.js does not export an ExtensionPreferences subclass');
    });

    test('exactly one file reaches the network, and it is named here', () => {
        // 0.1's rule was that nothing anywhere made a request. 0.2 replaces that rule rather
        // than dropping it: listing an instance's rooms needs one, and the point of naming
        // the single file that may make it is that a second one cannot appear quietly.
        const allowed = 'src/extension.js';
        const carriers = ALL_SOURCES
            .filter(parts => readFile(...parts).includes('gi://Soup'))
            .map(parts => parts.join('/'));
        assertDeepEqual(carriers, [allowed],
            `gi://Soup is imported by ${carriers.join(', ') || 'nothing at all'}`);
    });

    test('nothing under lib/ can reach the network even in principle', () => {
        // Which is what keeps client.js testable: every decision about a request is made
        // over an injected seam, and the seam is the four lines in extension.js.
        for (const name of LIB) {
            const source = readFile('src', 'lib', name);
            for (const needle of ['gi://Soup', 'XMLHttpRequest', 'fetch(']) {
                assert(!source.includes(needle),
                    `lib/${name} uses ${needle}, so the request is no longer injectable`);
            }
        }
    });

    test('the icon is still never fetched', () => {
        // The answered open question about the logo turns on exactly this: the icon is
        // vendored as a drawing precisely so that nothing has to be fetched at runtime.
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            assert(!/gi:\/\/Soup[\s\S]{0,400}icon/i.test(source),
                `${parts.join('/')} fetches something to do with the icon`);
        }
    });

    test('no synchronous Soup call anywhere, which would freeze the compositor', () => {
        // `send_and_read` and `send` are the blocking spellings and sit one underscore away
        // from the asynchronous ones, which is exactly how one gets written by accident.
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            for (const needle of ['send_and_read(', 'send_async_internal', '.send(']) {
                assert(!source.includes(needle),
                    `${parts.join('/')} uses ${needle}, which blocks the main loop`);
            }
            assert(!/\.send_and_read\s*\(/.test(source),
                `${parts.join('/')} calls send_and_read synchronously`);
        }
    });

    test('no response status is ever read through get_status()', () => {
        // It throws on any status outside libsoup's own enum — 429 is the one that bit a
        // sibling idea — and a throw from inside the async callback settles no promise, so
        // the request hangs for ever. The status is read as a property instead.
        for (const parts of ALL_SOURCES) {
            for (const line of readFile(...parts).split('\n')) {
                // Skipping comments: the one place that explains why this is forbidden has
                // to be able to name it.
                if (line.trim().startsWith('//') || line.trim().startsWith('*'))
                    continue;
                assert(!line.includes('get_status()'),
                    `${parts.join('/')} calls get_status(), which throws on an unknown ` +
                    `status: ${line.trim()}`);
            }
        }
        assert(readFile('src', 'extension.js').includes('message.status_code'),
            'the status is not read as a property either, so how is it read?');
    });

    test('a request can always be abandoned, and is', () => {
        const source = readFile('src', 'extension.js');
        assert(source.includes('Gio.Cancellable'), 'nothing creates a cancellable');
        assert(source.includes('.cancel()'), 'nothing ever cancels');
        const teardown = source.slice(source.indexOf('_onDestroy()'));
        assert(teardown.includes('_cancelRefresh()'),
            'disable() leaves a request in flight');
        assert(teardown.includes('abort()'),
            'disable() leaves the session holding its connections open');
    });

    test('no credential is ever written to a log or a notification', () => {
        // A role link's secret is the role, and an API key is an API key. Neither may be
        // passed to anything that writes text somewhere a person or a journal can read.
        const writers = /\b(log|logError|notifyError|print|printerr|console\.\w+)\s*\(/;
        for (const parts of ALL_SOURCES) {
            for (const line of readFile(...parts).split('\n')) {
                if (!writers.test(line) || line.trim().startsWith('//'))
                    continue;
                for (const needle of ['secret', 'apiKey', 'joinUrl', 'api_key', 'password'])
                    assert(!line.includes(needle), `${parts.join('/')}: ${line.trim()}`);
            }
        }
    });

    test('and every failure message is redacted before it is shown', () => {
        // The way a secret would reach the screen is not that somebody wrote it into a
        // message: a launch fails and GIO quotes the URI it was given.
        const launcher = readFile('src', 'lib', 'launcher.js');
        assert(launcher.includes('redactSecrets'),
            'launcher.js builds messages from errors without redacting them');
        const failure = launcher.slice(launcher.indexOf('export function launchFailureMessage'));
        assert(!/body: `[^`]*\$\{detail\}/.test(failure) ||
            failure.includes('redactSecrets(`The default browser'),
            'the body is built from the raw error message');
    });

    test('no http:// anywhere in the sources', () => {
        // Only the JS: the icon is an SVG and its xmlns is an XML namespace name, not an
        // address anything dereferences.
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            assert(!source.includes('http://'),
                `${parts.join('/')} contains an http:// literal`);
        }
    });

    test('nothing spawns anything', () => {
        // pwgen established why: a subprocess is a review risk and a main-loop risk, and
        // this extension has no reason for one. Opening a URL goes through the desktop's
        // own handler, not through xdg-open.
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            for (const needle of ['Gio.Subprocess', 'GLib.spawn', 'spawn_sync',
                'spawn_command_line', 'xdg-open'])
                assert(!source.includes(needle), `${parts.join('/')} uses ${needle}`);
        }
    });

    test('nothing blocks the compositor on a synchronous call', () => {
        // The synchronous spellings are the ones that freeze the desktop, and they are what
        // a reviewer greps for first.
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            for (const needle of ['launch_default_for_uri(', 'communicate_utf8(',
                'load_contents(']) {
                assert(!source.includes(needle),
                    `${parts.join('/')} uses ${needle}, which blocks the main loop`);
            }
        }
    });

    test('no eval, and no global monkey-patching', () => {
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            assert(!/\beval\s*\(/.test(source), `${parts.join('/')} calls eval`);
            assert(!/\bnew Function\s*\(/.test(source),
                `${parts.join('/')} builds a function from a string`);
            assert(!/\.prototype\.\w+\s*=/.test(source),
                `${parts.join('/')} patches a prototype, which outlives disable()`);
        }
    });

    test('every signal the shell connects is disconnected when its actor is destroyed', () => {
        // The rule a reviewer checks by hand, checked here instead: a handler that outlives
        // disable() keeps the whole extension alive with it, and the shell will happily
        // enable a second copy on top.
        //
        // Checked per class, because there are two now. A room row owns its join button's
        // handler and undoes it in its own 'destroy' — which is the right place for it, and
        // not somewhere the indicator's _onDestroy could reach.
        const source = readFile('src', 'extension.js');
        const classes = source.split(/(?=const \w+ = GObject\.registerClass)/);
        let found = 0;

        for (const body of classes) {
            const connected = [...body.matchAll(/this\.(_\w+Id) = this\.[\w.]+\.connect\(/g)];
            if (connected.length === 0)
                continue;
            found += connected.length;

            assert(body.includes("connect('destroy'"),
                'a class connects signals and never hears about its own destruction');
            for (const [, field] of connected) {
                assert(body.includes(`disconnect(this.${field})`),
                    `${field} is connected but never disconnected in the same class`);
                assert(body.includes(`this.${field} = 0`),
                    `${field} is disconnected but kept, so a second teardown would repeat it`);
            }
        }

        assert(found >= 2, `only found ${found} stored signal handlers in all`);
    });

    test('disable() destroys the indicator and forgets it', () => {
        // An indicator left in Main.panel.statusArea is a panel button that no longer
        // works, and the shell refuses to add a second one under the same name — so the
        // next enable() silently does nothing.
        const disable = readFile('src', 'extension.js');
        const body = disable.slice(disable.indexOf('    disable() {'));
        assert(body.includes('this._indicator?.destroy()'), 'the indicator is never destroyed');
        assert(body.includes('this._indicator = null'), 'the indicator reference is kept');
    });

    test('nothing touches the shell after the indicator is gone', () => {
        // A launch started just before disable() answers a moment later, on the main loop,
        // and by then this object has been destroyed. Notifying from there is a JS ERROR in
        // the journal at best.
        const source = readFile('src', 'extension.js');
        assert(source.includes('this._destroyed = true'),
            'nothing records that the indicator has been destroyed');
        // The method's definition, not the call site that passes it to the launcher.
        const notify = source.slice(source.indexOf('    _notify(title, body) {'));
        assert(notify.slice(0, 200).includes('this._destroyed'),
            '_notify does not check whether the indicator is still there');
    });

    test('the API key is never put on screen in clear', () => {
        // A key legible in a settings window is a key that ends up in a screen share. The
        // row has to be the password one, which is also what tells a screen reader not to
        // read it out.
        const prefs = readFile('src', 'prefs.js');
        assert(prefs.includes('Adw.PasswordEntryRow'),
            'the API key field is not a password row');
        assert(/title: 'API key'/.test(prefs), 'no API key field at all');
    });

    test('the API key never reaches GSettings', () => {
        // The answered open question put it in the keyring precisely so that it is not in a
        // dconf dump. toPairs drops it; nothing else may put it back.
        const settings = readFile('src', 'lib', 'settings.js');
        assert(!settings.includes('apiKey'), 'settings.js mentions the API key');
        const schema = readFile('src', 'schemas', 'org.gnome.shell.extensions.meet.gschema.xml');
        for (const needle of ['key', 'secret', 'token']) {
            assert(!schema.toLowerCase().includes(`name="${needle}`),
                `the schema has a ${needle} key, which dconf would show in clear`);
        }
    });

    test('the destinations are named in exactly one place', () => {
        // Two lists of URLs is one list of URLs and one stale list of URLs. The schema
        // default is the other statement of them, and schema.test.js holds it against this
        // one by compiling it.
        const carriers = ALL_SOURCES.filter(parts =>
            readFile(...parts).includes('meet-next.openvidu.io'));
        assert(carriers.length === 1 && carriers[0].join('/') === 'src/lib/destinations.js',
            `the default URLs appear in ${carriers.map(p => p.join('/')).join(', ')}`);
    });
});
