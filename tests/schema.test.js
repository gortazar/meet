// The settings schema, compiled and read back the way the shell reads it.
//
// Not by grepping the XML: the interesting failures are the ones the XML looks fine for.
// A `a(ss)` default with a typo in its variant syntax is a file that will not compile, and
// glib-compile-schemas failing at install time is an extension whose preferences will not
// open. A default that compiles but says something other than what DEFAULT_DESTINATIONS
// says is worse — two sources of truth for what a fresh install has, drifting silently.
//
// So this compiles the shipped schema into a throwaway directory, opens it as a real
// Gio.Settings, and asserts the value that comes out is the one the code ships.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import { readFile, readJSON, listFiles } from './util.js';
import { DEFAULT_DESTINATIONS, parseDestinations } from '../src/lib/destinations.js';
import {
    SCHEMA_ID, DESTINATIONS_KEY, readDestinations, writeDestinations, resetDestinations,
} from '../src/lib/settings.js';

/**
 * The shipped schema, compiled and opened. Compiled rather than mocked because the thing
 * being tested *is* whether glib can compile it.
 */
function shippedSettings() {
    const dir = GLib.Dir.make_tmp('meet-schema-XXXXXX');
    const name = `${SCHEMA_ID}.gschema.xml`;
    GLib.file_set_contents(GLib.build_filenamev([dir, name]),
        new TextEncoder().encode(readFile('src', 'schemas', name)));

    // --strict, because a warning here is a rejection at extensions.gnome.org.
    const proc = Gio.Subprocess.new(['glib-compile-schemas', '--strict', dir],
        Gio.SubprocessFlags.STDERR_PIPE);
    const [, , stderr] = proc.communicate_utf8(null, null);
    assertEqual(proc.get_exit_status(), 0,
        `glib-compile-schemas refused the shipped schema: ${stderr}`);

    const source = Gio.SettingsSchemaSource.new_from_directory(dir, null, true);
    const schema = source.lookup(SCHEMA_ID, false);
    assert(schema !== null, `the compiled schema has no ${SCHEMA_ID}`);

    // Over a memory backend, not dconf. `new Gio.Settings({ settings_schema })` would write
    // to the real /org/gnome/shell/extensions/meet/ of whoever is running the suite — the
    // developer's own session, or a CI runner's — and every test would then see the
    // leftovers of the one before it. A fresh backend per call is also the isolation these
    // tests need: several of them start from the defaults.
    return Gio.Settings.new_full(schema, Gio.memory_settings_backend_new(), null);
}

suite('the settings schema', () => {
    test('it compiles under --strict, which is what the shell and EGO both require', () => {
        // The assertion is inside shippedSettings(); reaching the end is the test.
        assert(shippedSettings() !== null);
    });

    test('its id and path follow the convention every other extension uses', () => {
        const xml = readFile('src', 'schemas', `${SCHEMA_ID}.gschema.xml`);
        assert(xml.includes(`id="${SCHEMA_ID}"`), 'the schema XML declares a different id');
        assert(xml.includes(`path="/${SCHEMA_ID.replace(/\./g, '/')}/"`),
            'the schema path does not follow from its id');
    });

    test('metadata.json points at it, or the shell hands the extension no settings at all', () => {
        assertEqual(readJSON('src', 'metadata.json')['settings-schema'], SCHEMA_ID);
    });

    test('the destinations key is the a(ss) the code unpacks', () => {
        const settings = shippedSettings();
        assertEqual(settings.settings_schema.get_key(DESTINATIONS_KEY).get_value_type()
            .dup_string(), 'a(ss)');
    });

    test('a fresh install gets exactly the destinations the code ships', () => {
        // The one assertion this whole file exists for: the schema default and
        // DEFAULT_DESTINATIONS are two statements of the same fact, and nothing but a test
        // keeps them in step.
        const stored = shippedSettings().get_value(DESTINATIONS_KEY).deepUnpack();
        assertDeepEqual(parseDestinations(stored),
            DEFAULT_DESTINATIONS.map(d => ({ label: d.label, url: d.url })));
    });

    test('every shipped default survives the rules the extension applies to it', () => {
        // A default that parseDestinations drops would be an extension whose menu is empty
        // on a fresh install, with nothing anywhere saying why.
        const stored = shippedSettings().get_value(DESTINATIONS_KEY).deepUnpack();
        assertEqual(parseDestinations(stored).length, stored.length,
            'a shipped default is dropped by the extension\'s own validator');
    });

    test('there is exactly one key, because there is exactly one setting', () => {
        // v0.1 configures the destinations and nothing else. A key added without a
        // preferences row is a setting nobody can change.
        assertDeepEqual(shippedSettings().settings_schema.list_keys(), [DESTINATIONS_KEY]);
    });

    test('the shipped schema directory holds nothing but this schema', () => {
        // The packer copies src/schemas/*.gschema.xml wholesale, so a stray file here
        // travels into everybody's install and gets compiled with the real one.
        assertDeepEqual(listFiles('src', 'schemas'), [`${SCHEMA_ID}.gschema.xml`]);
    });
});

suite('destinations through a real Gio.Settings', () => {
    // Against the compiled schema rather than a stand-in, because the thing worth checking
    // is the GVariant packing: `a(ss)` is the one place in this extension where a wrong
    // type is not a wrong value but a crash inside GLib, on the compositor's main loop.

    test('a fresh settings object already has the two shipped rooms', () => {
        assertDeepEqual(readDestinations(shippedSettings()).map(d => d.label),
            ['Meet next', 'Meet']);
    });

    test('what is written comes back, in order', () => {
        const settings = shippedSettings();
        const written = [
            { label: 'Ours', url: 'https://vc.example.org/' },
            { label: 'Standup', url: 'https://vc.example.org/standup' },
        ];
        writeDestinations(settings, written);
        assertDeepEqual(readDestinations(settings), written);
    });

    test('an empty list survives a round trip as an empty list', () => {
        // Removing everything is a state the user can reach, and it must not read back as
        // the defaults — that would make the last delete look like it failed.
        const settings = shippedSettings();
        writeDestinations(settings, []);
        assertDeepEqual(readDestinations(settings), []);
    });

    test('a half-typed row never reaches dconf, and says so on the way out', () => {
        const settings = shippedSettings();
        const stored = writeDestinations(settings, [
            { label: 'Ours', url: 'https://vc.example.org/' },
            { label: 'Half typed', url: 'https://' },
        ]);
        assertDeepEqual(stored, [['Ours', 'https://vc.example.org/']]);
        assertEqual(readDestinations(settings).length, 1);
    });

    test('resetting puts the shipped rooms back', () => {
        const settings = shippedSettings();
        writeDestinations(settings, []);
        assertEqual(readDestinations(settings).length, 0);
        resetDestinations(settings);
        assertDeepEqual(readDestinations(settings).map(d => d.label), ['Meet next', 'Meet']);
    });
});
