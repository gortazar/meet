// The keyring, for real.
//
// This is the untestable half of `keyring.js`, kept to the three calls that need a running
// secret service and nothing else: everything with a decision in it — which attributes, what
// an absent key means, what an edit does — is next door and tested under plain gjs.
//
// It is imported **dynamically**, by `extension.js` and `prefs.js`, inside a try/catch.
// `gnome-shell` depends on libsecret the library but not on `gir1.2-secret-1`, its typelib,
// so a minimal GNOME install can have the first and not the second. A static import would
// turn that into an extension that does not load at all; this way it is an extension whose
// instances all read "add an API key", which is survivable and true.

import Secret from 'gi://Secret';

import { INSTANCE_ATTRIBUTE, KEY_SCHEMA_NAME } from './keyring.js';

/**
 * The schema these items are stored under.
 *
 * One attribute, the instance URL, and `NONE` rather than `DONT_MATCH_NAME` so that a lookup
 * finds only this extension's items.
 */
const SCHEMA = new Secret.Schema(KEY_SCHEMA_NAME, Secret.SchemaFlags.NONE, {
    [INSTANCE_ATTRIBUTE]: Secret.SchemaAttributeType.STRING,
});

/**
 * The seams `createKeyStore` needs, over the session's own keyring.
 *
 * Every call is asynchronous. The synchronous spellings — `password_lookup_sync` and its
 * siblings — block until the keyring is unlocked, which can mean until the user types a
 * password into a dialog, and in the compositor's process that is a frozen desktop.
 */
export function createSecretSeams() {
    return {
        lookup: attributes => new Promise((resolve, reject) => {
            Secret.password_lookup(SCHEMA, attributes, null, (source, result) => {
                try {
                    resolve(Secret.password_lookup_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        }),

        store: (attributes, label, key) => new Promise((resolve, reject) => {
            // COLLECTION_DEFAULT is the login keyring, which is unlocked at login on a
            // normal session. An item in the session collection would be forgotten at
            // logout, which is not what someone typing an API key into a settings window
            // expects of it.
            Secret.password_store(SCHEMA, attributes, Secret.COLLECTION_DEFAULT, label, key,
                null, (source, result) => {
                    try {
                        resolve(Secret.password_store_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
        }),

        clear: attributes => new Promise((resolve, reject) => {
            Secret.password_clear(SCHEMA, attributes, null, (source, result) => {
                try {
                    resolve(Secret.password_clear_finish(result));
                } catch (error) {
                    reject(error);
                }
            });
        }),
    };
}
