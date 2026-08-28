// What the menu offers: a label and a URL, as many times as you like.
//
// Two of them ship by default — the ones the idea names — and they are ordinary entries,
// not special cases: they can be edited and they can be removed. Everything else about a
// destination is a rule, and the rules live here rather than in extension.js so a test can
// hold them without a compositor.
//
// The stored form is a GSettings `a(ss)`, which unpacks to an array of two-string arrays.
// That means every destination arrives from outside this file — from dconf, from a
// hand-typed `gsettings set`, from a preferences window mid-edit — so nothing here trusts
// its input, and nothing here throws: a bad row costs you that row and not the menu.

import GLib from 'gi://GLib';

/**
 * The destinations a fresh install has. Frozen: a caller that mutated this would change
 * what "restore the defaults" restores, for the rest of the session.
 */
export const DEFAULT_DESTINATIONS = Object.freeze([
    Object.freeze({ label: 'Meet next', url: 'https://meet-next.openvidu.io/' }),
    Object.freeze({ label: 'Meet', url: 'https://meet.openvidu.io/' }),
]);

/** The only scheme a destination may use. See `destinationProblem`. */
const REQUIRED_SCHEME = 'https';

/**
 * Why this is not a destination, or `null` if it is.
 *
 * Returns the reason rather than a boolean because the preferences window shows it: "that
 * is not a valid destination" is a worse error message than "the address has to start with
 * https://", and the caller should not have to reconstruct which rule was broken.
 */
export function destinationProblem(destination) {
    if (destination === null || typeof destination !== 'object')
        return 'a destination is a label and an address';

    const { label, url } = destination;
    if (typeof label !== 'string' || label.trim() === '')
        return 'give it a name — that is what the menu shows';
    if (typeof url !== 'string' || url.trim() === '')
        return 'give it an address, starting with https://';

    return urlProblem(url.trim());
}

/**
 * Why this is not an address we will hand to a browser.
 *
 * The rule is deliberately strict — absolute, `https:`, with a host — and the strictness is
 * the point. This URL is passed to the desktop's default handler for its scheme, so a
 * `file:` or a `javascript:` here is not a broken link, it is the extension opening
 * something on your behalf that you did not mean. Refusing everything but https costs a
 * self-hosted deployment nothing and closes that off entirely.
 */
function urlProblem(url) {
    let parsed;
    try {
        parsed = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (e) {
        void e;
        return 'that is not an address the browser can open';
    }

    if (parsed.get_scheme() !== REQUIRED_SCHEME)
        return 'the address has to start with https://';
    const host = parsed.get_host();
    if (host === null || host === '')
        return 'the address is missing a host name';
    return null;
}

/**
 * The stored `a(ss)` as a list of destinations, in the order it was stored in.
 *
 * Rows that break the rules are dropped. That is the only sane response to a setting the
 * user can edit by hand: an unusable row is not worth losing the usable ones over, and it
 * is visible in the preferences window, which is where it can be fixed.
 */
export function parseDestinations(stored) {
    if (!Array.isArray(stored))
        return [];

    const destinations = [];
    for (const row of stored) {
        // Exactly two strings. A row of three cannot come out of an `a(ss)`, but it can
        // come out of a test double or a hand-written variant, and taking the first two
        // would be inventing a destination nobody typed.
        if (!Array.isArray(row) || row.length !== 2)
            continue;
        const [label, url] = row;
        if (typeof label !== 'string' || typeof url !== 'string')
            continue;

        const destination = { label: label.trim(), url: url.trim() };
        if (destinationProblem(destination) === null)
            destinations.push(destination);
    }
    return destinations;
}

/**
 * A list of destinations as the `a(ss)` GSettings stores, dropping any that break the
 * rules. The preferences window can hold a half-typed address; dconf should not.
 */
export function toPairs(destinations) {
    if (!Array.isArray(destinations))
        return [];
    return destinations
        .filter(destination => destinationProblem(destination) === null)
        .map(destination => [destination.label.trim(), destination.url.trim()]);
}
