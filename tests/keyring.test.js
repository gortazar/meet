// Where an instance's API key is kept, and what an edit in the preferences window does to
// what is kept there.
//
// The keyring itself is a seam: these tests inject one, so a locked keyring, a missing
// secret service and a key that is simply not there are ordinary cases here. The four lines
// that call libsecret for real are in lib/secret-store.js, which the nested shell exercises
// against a running gnome-keyring-daemon.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    KEY_SCHEMA_NAME, createKeyStore, keyAttributes, keyLabel, keyUpdates, openKeyStore,
} from '../src/lib/keyring.js';

const INSTANCE = { label: 'Work', url: 'https://meet.example.org/' };
const OTHER = { label: 'Home', url: 'https://meet.other.example/' };

/** A keyring seam over a plain object, plus a record of what it was asked to do. */
function fakeKeyring(initial = {}, failures = {}) {
    const held = { ...initial };
    const calls = [];
    return {
        held,
        calls,
        seams: {
            lookup: attributes => {
                calls.push(['lookup', attributes.instance]);
                if (failures.lookup)
                    return Promise.reject(new Error('the keyring is locked'));
                return Promise.resolve(held[attributes.instance] ?? null);
            },
            store: (attributes, label, key) => {
                calls.push(['store', attributes.instance, label]);
                if (failures.store)
                    return Promise.reject(new Error('no secret service'));
                held[attributes.instance] = key;
                return Promise.resolve(true);
            },
            clear: attributes => {
                calls.push(['clear', attributes.instance]);
                if (failures.clear)
                    return Promise.reject(new Error('no secret service'));
                delete held[attributes.instance];
                return Promise.resolve(true);
            },
        },
    };
}

suite('how a key is addressed in the keyring', () => {
    test('the schema is this extension, not a name another app could collide with', () => {
        assertEqual(KEY_SCHEMA_NAME, 'org.gnome.shell.extensions.meet');
    });

    test('an instance is told apart by its URL, which is what makes the key its own', () => {
        assertDeepEqual(keyAttributes(INSTANCE.url), { instance: 'https://meet.example.org/' });
    });

    test('whitespace around a URL does not make it a different instance', () => {
        assertDeepEqual(keyAttributes('  https://meet.example.org/\n'),
            { instance: 'https://meet.example.org/' });
    });

    test('something that is not an instance URL has no attributes to look up by', () => {
        for (const url of ['', '   ', null, undefined, 42, {}])
            assertEqual(keyAttributes(url), null, `${JSON.stringify(url)} produced attributes`);
    });

    test('the label a keyring manager shows names the instance and no secret', () => {
        const label = keyLabel(INSTANCE);
        assert(label.includes('Work'), label);
        assert(label.toLowerCase().includes('openvidu'), label);
    });

    test('an instance with no name is labelled by its address rather than blankly', () => {
        assert(keyLabel({ label: '  ', url: INSTANCE.url }).includes('meet.example.org'));
    });
});

suite('reading a key back', () => {
    test('a key that is there comes back', async () => {
        const { seams } = fakeKeyring({ [INSTANCE.url]: 'the-key' });
        assertEqual(await createKeyStore(seams).lookupKey(INSTANCE.url), 'the-key');
    });

    test('a key that is not there is null, which is a state and not an error', async () => {
        const { seams } = fakeKeyring();
        assertEqual(await createKeyStore(seams).lookupKey(INSTANCE.url), null);
    });

    test('a locked or missing keyring reads as no key, never as a throw', async () => {
        // A session with no secret service running is a real machine, not a broken one.
        // The menu says "add an API key"; it does not say the extension crashed.
        const { seams } = fakeKeyring({}, { lookup: true });
        assertEqual(await createKeyStore(seams).lookupKey(INSTANCE.url), null);
    });

    test('a seam that throws on the calling frame is caught too', async () => {
        const store = createKeyStore({
            lookup: () => { throw new Error('no typelib'); },
            store: () => Promise.resolve(true),
            clear: () => Promise.resolve(true),
        });
        assertEqual(await store.lookupKey(INSTANCE.url), null);
    });

    test('an instance URL that is not one is never looked up at all', async () => {
        const { seams, calls } = fakeKeyring();
        assertEqual(await createKeyStore(seams).lookupKey('nonsense'), null);
        assertDeepEqual(calls, []);
    });

    test('a key of the wrong type is no key', async () => {
        const { seams } = fakeKeyring({ [INSTANCE.url]: 42 });
        assertEqual(await createKeyStore(seams).lookupKey(INSTANCE.url), null);
    });

    test('an empty stored key is no key, so it reads as "add one"', async () => {
        const { seams } = fakeKeyring({ [INSTANCE.url]: '   ' });
        assertEqual(await createKeyStore(seams).lookupKey(INSTANCE.url), null);
    });

    test('every instance at once, keyed by URL', async () => {
        const { seams } = fakeKeyring({ [INSTANCE.url]: 'one' });
        assertDeepEqual(await createKeyStore(seams).lookupKeys([INSTANCE, OTHER]),
            { [INSTANCE.url]: 'one', [OTHER.url]: null });
    });

    test('one instance with a locked key does not cost the others theirs', async () => {
        const store = createKeyStore({
            lookup: attributes => attributes.instance === INSTANCE.url
                ? Promise.reject(new Error('locked'))
                : Promise.resolve('two'),
            store: () => Promise.resolve(true),
            clear: () => Promise.resolve(true),
        });
        assertDeepEqual(await store.lookupKeys([INSTANCE, OTHER]),
            { [INSTANCE.url]: null, [OTHER.url]: 'two' });
    });
});

suite('writing a key', () => {
    test('a key is stored under its instance, with a label and no secret in it', async () => {
        const { seams, held, calls } = fakeKeyring();
        assertEqual(await createKeyStore(seams).storeKey(INSTANCE, 'the-key'), true);
        assertEqual(held[INSTANCE.url], 'the-key');
        assert(!calls[0][2].includes('the-key'), 'the label carries the key');
    });

    test('a key is trimmed on the way in, because it is pasted', async () => {
        const { seams, held } = fakeKeyring();
        await createKeyStore(seams).storeKey(INSTANCE, '  the-key\n');
        assertEqual(held[INSTANCE.url], 'the-key');
    });

    test('a keyring that refuses to store says so rather than throwing', async () => {
        // The answered open question named this cost: a preferences window that can fail to
        // save. It has to be able to tell the user, which means a false and not a crash.
        const { seams } = fakeKeyring({}, { store: true });
        assertEqual(await createKeyStore(seams).storeKey(INSTANCE, 'the-key'), false);
    });

    test('storing an empty key clears it instead of keeping an empty secret', async () => {
        const { seams, held, calls } = fakeKeyring({ [INSTANCE.url]: 'old' });
        assertEqual(await createKeyStore(seams).storeKey(INSTANCE, '   '), true);
        assertEqual(held[INSTANCE.url], undefined);
        assertEqual(calls[0][0], 'clear');
    });

    test('an instance that is not one is never written', async () => {
        const { seams, calls } = fakeKeyring();
        assertEqual(await createKeyStore(seams).storeKey({ url: 'nonsense' }, 'k'), false);
        assertDeepEqual(calls, []);
    });

    test('clearing a key removes it', async () => {
        const { seams, held } = fakeKeyring({ [INSTANCE.url]: 'old' });
        assertEqual(await createKeyStore(seams).clearKey(INSTANCE.url), true);
        assertEqual(held[INSTANCE.url], undefined);
    });

    test('clearing a key that was never there is not a failure', async () => {
        const { seams } = fakeKeyring();
        assertEqual(await createKeyStore(seams).clearKey(INSTANCE.url), true);
    });

    test('a keyring that refuses to clear says so', async () => {
        const { seams } = fakeKeyring({}, { clear: true });
        assertEqual(await createKeyStore(seams).clearKey(INSTANCE.url), false);
    });
});

suite('what an edit in the preferences does to the keyring', () => {
    const withKey = (instance, apiKey) => ({ ...instance, apiKey });

    test('a key typed into a new instance is stored', () => {
        assertDeepEqual(keyUpdates([], [withKey(INSTANCE, 'typed')]),
            { store: [{ url: INSTANCE.url, key: 'typed' }], clear: [] });
    });

    test('an instance removed takes its key with it', () => {
        // Otherwise a key outlives the instance it belongs to, invisible in the preferences
        // and still sitting in the keyring.
        assertDeepEqual(keyUpdates([INSTANCE], []), { store: [], clear: [INSTANCE.url] });
    });

    test('an instance whose URL was edited moves its key rather than orphaning it', () => {
        const moved = { label: 'Work', url: 'https://moved.example/', apiKey: 'typed' };
        assertDeepEqual(keyUpdates([INSTANCE], [moved]),
            { store: [{ url: moved.url, key: 'typed' }], clear: [INSTANCE.url] });
    });

    test('a key field left alone is left alone', () => {
        // The window loads keys asynchronously and a row whose key has not arrived — or
        // could not be read — has no apiKey at all. Treating that as "the user cleared it"
        // would delete a key because a keyring was slow to unlock.
        assertDeepEqual(keyUpdates([INSTANCE], [{ ...INSTANCE }]), { store: [], clear: [] });
        assertDeepEqual(keyUpdates([INSTANCE], [withKey(INSTANCE, undefined)]),
            { store: [], clear: [] });
        assertDeepEqual(keyUpdates([INSTANCE], [withKey(INSTANCE, null)]),
            { store: [], clear: [] });
    });

    test('a key field emptied on purpose clears the key', () => {
        assertDeepEqual(keyUpdates([INSTANCE], [withKey(INSTANCE, '')]),
            { store: [], clear: [INSTANCE.url] });
        assertDeepEqual(keyUpdates([INSTANCE], [withKey(INSTANCE, '   ')]),
            { store: [], clear: [INSTANCE.url] });
    });

    test('a URL that is both gone and back again is stored, not cleared', () => {
        // Reordering the list is a remove and an add of the same URL. Clearing it would
        // throw the key away for having moved up one row.
        assertDeepEqual(keyUpdates([INSTANCE, OTHER], [withKey(OTHER, 'two'), INSTANCE]),
            { store: [{ url: OTHER.url, key: 'two' }], clear: [] });
    });

    test('nothing changed is nothing to do', () => {
        assertDeepEqual(keyUpdates([INSTANCE, OTHER], [INSTANCE, OTHER]),
            { store: [], clear: [] });
    });

    test('an instance that is not one is neither stored nor cleared', () => {
        assertDeepEqual(keyUpdates([{ url: 'nonsense' }], [{ url: 'nonsense', apiKey: 'k' }]),
            { store: [], clear: [] });
    });

    test('lists that are not lists are no updates, not a throw', () => {
        for (const value of [null, undefined, 'instances', 42])
            assertDeepEqual(keyUpdates(value, value), { store: [], clear: [] });
    });

    test('a key is never carried into the clear list, which is only URLs', () => {
        const updates = keyUpdates([INSTANCE], [withKey(INSTANCE, '')]);
        for (const entry of updates.clear)
            assertEqual(typeof entry, 'string');
    });
});

suite('opening the real keyring', () => {
    test('a machine with no libsecret typelib still gets a key store', async () => {
        // gnome-shell depends on libsecret the library but not on gir1.2-secret-1, its
        // typelib, so this is a real GNOME install and not a hypothetical one. It must cost
        // the API keys and not the extension.
        const store = await openKeyStore();
        for (const method of ['lookupKey', 'lookupKeys', 'storeKey', 'clearKey'])
            assertEqual(typeof store[method], 'function', `${method} is missing`);
    });

    test('and looking a key up on one answers null rather than throwing', async () => {
        // Safe to run against a real keyring too: this instance URL is not one anybody has.
        const store = await openKeyStore();
        assertEqual(await store.lookupKey('https://not-an-instance.invalid/'), null);
    });
});
