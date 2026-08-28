// Static guards for the rules the extensions.gnome.org review checklist is made of, and for
// the one that keeps this suite honest: everything with a decision in it stays out of the
// compositor-only files, or it stops being testable here.

import { suite, test, assert } from './harness.js';
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

    test('nothing reaches the network, from anywhere', () => {
        // The answered open question about the logo turns on exactly this: the icon is
        // vendored as a drawing precisely so that nothing has to be fetched at runtime. A
        // decoration that needs the network fails offline and is a review rejection.
        for (const parts of ALL_SOURCES) {
            const source = readFile(...parts);
            for (const needle of ['gi://Soup', 'XMLHttpRequest', 'fetch(']) {
                assert(!source.includes(needle),
                    `${parts.join('/')} uses ${needle} — this extension makes no requests`);
            }
        }
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

    test('every signal the indicator connects is disconnected when it is destroyed', () => {
        // The rule a reviewer checks by hand, checked here instead: a handler that outlives
        // disable() keeps the whole extension alive with it, and the shell will happily
        // enable a second copy on top.
        const source = readFile('src', 'extension.js');
        const connected = [...source.matchAll(/this\.(_\w+Id) = this\.[\w.]+\.connect\(/g)];
        assert(connected.length >= 1, 'no stored signal handlers found at all');

        const teardown = source.slice(source.indexOf('_onDestroy()'));
        for (const [, field] of connected) {
            assert(teardown.includes(`disconnect(this.${field})`),
                `${field} is connected but never disconnected in _onDestroy`);
        }
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
