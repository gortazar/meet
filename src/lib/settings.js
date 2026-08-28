// Where the destinations are kept, and the two-line translation between the stored form and
// the one the rest of the code uses.
//
// The stored form is a GSettings `a(ss)` — the natural shape for "a list of name/address
// pairs", and one dconf and gsettings can both show and edit. Everything that knows about
// GVariant packing is here; nothing else in the extension mentions `a(ss)` at all.

import GLib from 'gi://GLib';

import { parseDestinations, toPairs } from './destinations.js';

/** The schema metadata.json points at, and the one prefs.js and extension.js both open. */
export const SCHEMA_ID = 'org.gnome.shell.extensions.meet';

/** The only key in it. */
export const DESTINATIONS_KEY = 'destinations';

/** The GVariant type of that key, in one place rather than in three call sites. */
const DESTINATIONS_TYPE = 'a(ss)';

/**
 * The destinations currently stored, valid ones only and in the stored order.
 *
 * Takes the Gio.Settings rather than making it: extension.js and prefs.js each get theirs
 * from the extension object, which is the only way to reach a schema that lives inside the
 * extension directory rather than on the system schema path.
 */
export function readDestinations(settings) {
    return parseDestinations(settings.get_value(DESTINATIONS_KEY).deepUnpack());
}

/**
 * Store a list of destinations, dropping any that break the rules.
 *
 * Returns what was actually written, so a caller that wants to know whether a half-typed
 * row was left behind does not have to read the setting back to find out.
 */
export function writeDestinations(settings, destinations) {
    const pairs = toPairs(destinations);
    settings.set_value(DESTINATIONS_KEY, new GLib.Variant(DESTINATIONS_TYPE, pairs));
    return pairs;
}

/** Put the shipped destinations back, by forgetting the stored ones. */
export function resetDestinations(settings) {
    settings.reset(DESTINATIONS_KEY);
}
