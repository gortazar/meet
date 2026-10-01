// Where an instance's API key lives, and what an edit in the preferences does to it.
//
// The answered open question put the key in the **system keyring** rather than in dconf: a
// key in GSettings is readable by anything in the session and turns up in a `dconf dump`
// somebody pastes into a bug report. The cost it named — a second storage path to test, and
// a preferences window that can fail to save — is paid here, by making the keyring an
// injected seam so that a locked keyring, a session with no secret service and a key that is
// simply absent are all ordinary tests.
//
// The four lines that talk to libsecret are in `secret-store.js`. Nothing in this file
// imports it, which is what keeps the whole of this module runnable under plain gjs.
//
// A key is a credential: it is never logged, never put in a keyring item's label, and never
// written to dconf.

import { destinationProblem, urlProblem } from './destinations.js';

/**
 * The libsecret schema these items are stored under.
 *
 * The same string as the GSettings schema deliberately: it is this extension's name in the
 * session, and an item stored under it cannot be confused with another application's.
 */
export const KEY_SCHEMA_NAME = 'org.gnome.shell.extensions.meet';

/** The single attribute an item is addressed by. */
export const INSTANCE_ATTRIBUTE = 'instance';

/**
 * The attributes identifying one instance's key, or `null` if that is not an instance.
 *
 * The instance's URL is the identity, exactly as stored — which is why an edit to the URL
 * has to move the key rather than leave it behind. See `keyUpdates`.
 *
 * Held to the same rule a destination is: an address we would not send a browser to is not
 * one we will keep a credential against either, and a key stored under a half-typed URL is
 * a key nothing will ever look up again.
 */
export function keyAttributes(instanceUrl) {
    const url = typeof instanceUrl === 'string' ? instanceUrl.trim() : '';
    if (url === '' || urlProblem(url) !== null)
        return null;
    return { [INSTANCE_ATTRIBUTE]: url };
}

/**
 * What a keyring manager shows for this item.
 *
 * Seahorse and GNOME Settings list these by label, so it has to say which instance it
 * belongs to. It must never contain the key itself: the label is the one part of a keyring
 * item that is displayed without being asked for.
 */
export function keyLabel(instance) {
    const label = typeof instance?.label === 'string' ? instance.label.trim() : '';
    const url = typeof instance?.url === 'string' ? instance.url.trim() : '';
    return `OpenVidu Meet API key for ${label === '' ? url : label}`;
}

/**
 * A key store over an injected keyring.
 *
 * @param {object} seams
 * @param {(attributes: object) => Promise<string|null>} seams.lookup
 * @param {(attributes: object, label: string, key: string) => Promise<boolean>} seams.store
 * @param {(attributes: object) => Promise<boolean>} seams.clear
 *
 * Nothing here rejects. A keyring that is locked, absent or refusing is a state the user can
 * be told about — "add an API key", or a message in the preferences window — and an
 * exception from the compositor's main loop is not.
 */
export function createKeyStore({ lookup, store, clear }) {
    /** The key for one instance, or `null` for every way there might not be one. */
    async function lookupKey(instanceUrl) {
        const attributes = keyAttributes(instanceUrl);
        if (attributes === null)
            return null;

        try {
            const key = await lookup(attributes);
            // A stored empty string is not a key. It would otherwise send a request
            // guaranteed to be refused, and show "that instance refused the API key" to
            // somebody who has not added one.
            return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Every instance's key, keyed by URL, with `null` for the ones there is no key for.
     *
     * One instance whose key cannot be read does not cost the others theirs: the lookups are
     * independent and each one already answers `null` rather than failing.
     */
    async function lookupKeys(instances) {
        const list = Array.isArray(instances) ? instances : [];
        const keys = {};
        await Promise.all(list.map(async instance => {
            keys[instance?.url] = await lookupKey(instance?.url);
        }));
        return keys;
    }

    /** Store one instance's key. Resolves to whether it was really stored. */
    async function storeKey(instance, key) {
        const attributes = keyAttributes(instance?.url);
        if (attributes === null)
            return false;

        const trimmed = typeof key === 'string' ? key.trim() : '';
        // Emptying the field means "I have no key for this instance", which is a removal.
        // Storing an empty secret would leave an item in the keyring that means nothing.
        if (trimmed === '')
            return clearKey(instance?.url);

        try {
            return await store(attributes, keyLabel(instance), trimmed) !== false;
        } catch {
            return false;
        }
    }

    /** Forget one instance's key. Resolves to whether the keyring agreed. */
    async function clearKey(instanceUrl) {
        const attributes = keyAttributes(instanceUrl);
        if (attributes === null)
            return false;

        try {
            await clear(attributes);
            return true;
        } catch {
            return false;
        }
    }

    return { lookupKey, lookupKeys, storeKey, clearKey };
}

/**
 * A key store over the session's real keyring, or over one that politely has nothing.
 *
 * The import is dynamic and guarded because `gnome-shell` depends on libsecret the library
 * but not on its typelib, so a minimal GNOME install can have the first without the second.
 * A static import would make that an extension which does not load at all; this makes it an
 * extension whose instances all read "add an API key" — survivable, and true.
 *
 * Both callers await this once and keep the result.
 */
export async function openKeyStore() {
    try {
        const { createSecretSeams } = await import('./secret-store.js');
        return createKeyStore(createSecretSeams());
    } catch {
        return createKeyStore(unavailableSeams());
    }
}

/** A keyring that is not there: every operation fails, and `createKeyStore` absorbs it. */
function unavailableSeams() {
    const absent = () => Promise.reject(new Error('no keyring on this system'));
    return { lookup: absent, store: absent, clear: absent };
}

/**
 * What the keyring has to be told, given the instance list before an edit and after it.
 *
 * Returned as data rather than performed, so the rules — which are the fiddly part — are
 * tested without a keyring at all. Three of them are worth stating:
 *
 * - **An absent `apiKey` means "unknown", not "empty".** The preferences window loads keys
 *   asynchronously, and a row whose key has not arrived, or whose keyring would not open,
 *   carries no `apiKey` at all. Treating that as a deliberate clearing would throw away a
 *   key because a keyring was slow to unlock. An `apiKey` of `''` is the user emptying the
 *   field, and that does clear it.
 * - **An instance that is gone takes its key with it**, so a key cannot outlive the instance
 *   it belongs to — invisible in the preferences and still sitting in the keyring.
 * - **A URL still in the list is never cleared**, even though reordering looks like a
 *   removal and an addition of the same URL from one side.
 */
export function keyUpdates(before, after) {
    const previous = usableInstances(before);
    const current = usableInstances(after);
    const currentUrls = new Set(current.map(instance => instance.url.trim()));
    const previousKeys = new Map(previous
        .filter(instance => typeof instance.apiKey === 'string')
        .map(instance => [instance.url.trim(), instance.apiKey.trim()]));

    const toStore = [];
    const toClear = [];
    for (const instance of current) {
        const url = instance.url.trim();
        if (typeof instance.apiKey !== 'string')
            continue;
        const key = instance.apiKey.trim();
        // A key the keyring already holds is not news. Without this, every save rewrites
        // every key — harmless but for the fact that each rewrite is a chance for a keyring
        // that has since locked to report a failure about something nobody changed.
        if (previousKeys.get(url) === key)
            continue;
        if (key === '')
            toClear.push(url);
        else
            toStore.push({ url, key });
    }

    for (const instance of previous) {
        const url = instance.url.trim();
        if (!currentUrls.has(url) && !toClear.includes(url))
            toClear.push(url);
    }

    return { store: toStore, clear: toClear };
}

/**
 * The entries of a list that are instances at all.
 *
 * A half-typed row in the preferences window is not one yet, and it has no keyring item —
 * the key is held in the window until the row becomes a real instance.
 */
function usableInstances(list) {
    if (!Array.isArray(list))
        return [];
    return list.filter(instance =>
        destinationProblem({ label: instance?.label, url: instance?.url }) === null);
}
