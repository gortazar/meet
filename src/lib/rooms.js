// What a room is, once an instance has told us about it.
//
// The REST API returns a good deal more than a menu needs, and it returns several URLs per
// room of which only some are the call. This module picks the one that is, and refuses the
// ones that are not — which is the whole point of the entry: a button that lands in the
// meeting rather than on a page about the meeting.
//
// Nothing here throws. The input is a JSON payload from the network, parsed in the
// compositor's process; a throw from here is an unhandled rejection inside the main loop.
// A room we cannot make sense of costs us that room, and a link we cannot vouch for costs
// that room its button — never the list, and never the menu.

import GLib from 'gi://GLib';

/**
 * The role the join button joins as.
 *
 * Moderator, per the answered open question: it is your own instance and your own room, and
 * it is the link that can start and manage the meeting. The speaker link is deliberately
 * never used — joining as a role you did not ask for, silently, is worse than no button.
 */
export const JOIN_ROLE = 'moderator';

/** The only scheme a join link may use, as everywhere else in this extension. */
const REQUIRED_SCHEME = 'https';

/** The query parameter that *is* the role. Without it the link is the room's own page. */
const SECRET_PARAM = 'secret';

/** What a room without a usable `status` is taken to be. */
const DEFAULT_STATUS = 'open';

/**
 * One room from the API's payload, or `null` if it is not a room at all.
 *
 * The required field is `roomId`: without it there is nothing to identify or to join, and
 * inventing one would put a row in the menu that cannot do anything. Everything else is
 * optional and degrades — a missing name falls back to the id, a missing date sorts last, a
 * link that fails `joinUrlProblem` becomes no link.
 *
 * @param {object} raw The room object as the instance returned it.
 * @param {string} instanceUrl The instance it came from, which its links must belong to.
 */
export function parseRoom(raw, instanceUrl) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;

    const id = typeof raw.roomId === 'string' ? raw.roomId.trim() : '';
    if (id === '')
        return null;

    const name = typeof raw.roomName === 'string' ? raw.roomName.trim() : '';
    const status = typeof raw.status === 'string' && raw.status.trim() !== ''
        ? raw.status.trim() : DEFAULT_STATUS;

    return {
        id,
        name: name === '' ? id : name,
        status,
        createdAt: Number.isFinite(raw.creationDate) ? raw.creationDate : 0,
        joinUrl: joinUrlOf(raw, instanceUrl),
    };
}

/**
 * Every room in the payload that is one, in the order the instance returned it.
 *
 * Ordering and how many of them a menu shows are the menu's business, not this module's;
 * see `buildMenuModel`.
 */
export function parseRooms(rawRooms, instanceUrl) {
    if (!Array.isArray(rawRooms))
        return [];

    const rooms = [];
    for (const raw of rawRooms) {
        const room = parseRoom(raw, instanceUrl);
        if (room !== null)
            rooms.push(room);
    }
    return rooms;
}

/**
 * The anonymous moderator link of a room, if it is one we will act on, and `null` otherwise.
 *
 * A link the instance has explicitly disabled is treated as absent. It would not work, and
 * the alternative — reaching for the speaker link instead — joins you as a role you did not
 * choose without telling you.
 */
function joinUrlOf(raw, instanceUrl) {
    const role = raw?.access?.anonymous?.[JOIN_ROLE];
    if (role === null || typeof role !== 'object')
        return null;
    if (role.enabled === false)
        return null;

    const url = typeof role.url === 'string' ? role.url.trim() : '';
    return joinUrlProblem(url, instanceUrl) === null ? url : null;
}

/**
 * Why this is not a link that joins a call on that instance, or `null` if it is.
 *
 * Three rules, and each one closes off a different way a "join" link silently becomes
 * something else:
 *
 * - **`https:`** — the same rule a destination is held to. This URL goes to the desktop's
 *   default handler for its scheme, so anything else here is the extension opening something
 *   on the user's behalf that they did not mean.
 * - **the instance's own host** — a payload that names another host is either a
 *   misconfigured deployment or a compromised one, and following it would send a click
 *   somewhere the user never configured.
 * - **a `secret`** — the secret *is* the role. The same path without one is the room's own
 *   page, which is precisely the thing the join button is supposed to go past. The secret is
 *   never built, never guessed and never logged; it is used exactly as the instance gave it.
 *
 * Returns the reason rather than a boolean so a caller can say which rule was broken. Today
 * none does — the room is simply listed without a button — but the alternative is a check
 * whose failures are indistinguishable from each other when one of them turns up in the
 * wild.
 */
export function joinUrlProblem(url, instanceUrl) {
    if (typeof url !== 'string' || url.trim() === '')
        return 'there is no link to join with';

    const link = parseUri(url.trim());
    if (link === null)
        return 'that is not an address the browser can open';
    if (link.get_scheme() !== REQUIRED_SCHEME)
        return 'a join link has to start with https://';

    const instance = parseUri(typeof instanceUrl === 'string' ? instanceUrl.trim() : '');
    if (instance === null)
        return 'we cannot tell which instance that link belongs to';
    if (!sameHost(link, instance))
        return 'that link is not on this instance';

    if (!hasSecret(link.get_query()))
        return 'that link opens the room page, not the call';
    return null;
}

/** A parsed URI, or `null` for anything GLib will not take. */
function parseUri(url) {
    if (url === '')
        return null;
    try {
        return GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch {
        return null;
    }
}

/**
 * Whether two parsed URIs name the same host and port.
 *
 * The port is normalised first: GLib reports `-1` for a URL that does not spell one out, so
 * `https://host/` and `https://host:443/` differ by a number and not by a destination.
 * Refusing that difference would cost a real deployment its entire room list.
 */
function sameHost(link, instance) {
    const host = link.get_host();
    const instanceHost = instance.get_host();
    if (host === null || host === '' || instanceHost === null || instanceHost === '')
        return false;
    if (host.toLowerCase() !== instanceHost.toLowerCase())
        return false;
    return normalisedPort(link) === normalisedPort(instance);
}

/** The port a URI really means: its own, or https's default when it names none. */
function normalisedPort(uri) {
    const port = uri.get_port();
    return port === -1 ? 443 : port;
}

/**
 * Whether a query string carries a non-empty `secret`.
 *
 * Parsed as a query rather than matched as a substring: `?not-secret=x` contains the word
 * and is not the parameter, and a button that trusted it would open the room page while
 * claiming to join the call.
 */
function hasSecret(query) {
    if (typeof query !== 'string' || query === '')
        return false;

    let params;
    try {
        params = GLib.Uri.parse_params(query, -1, '&', GLib.UriParamsFlags.NONE);
    } catch {
        return false;
    }
    const secret = params?.[SECRET_PARAM];
    return typeof secret === 'string' && secret !== '';
}
