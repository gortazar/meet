// Asking an instance for its rooms: the request it needs, and what to make of the answer.
//
// The transport is injected. Everything with a decision in it — which URL, which header, what
// a 401 means, what an HTML body means — is here and tested under plain gjs; the only part
// that is not is the handful of lines in extension.js that hand this request to libsoup and
// bring back a status and a body.
//
// Every shape here comes from OpenVidu Meet's own OpenAPI specification:
//
//   GET  <instance>/api/v1/rooms?maxItems=100      X-API-KEY: <key>
//   200  { rooms: [ … ], _extraFields: [ … ], pagination: { isTruncated, nextPageToken } }
//   401/403 on a key the instance does not accept; 422 on a maxItems it will not take;
//   429 when rate limited; 500 when it is unwell.
//
// Nothing here throws and nothing here rejects. Every outcome is one of the states
// `buildMenuModel` can draw a row for, because a failure that reaches the compositor as an
// exception is a failure nobody sees and the journal does.

import GLib from 'gi://GLib';

import { urlProblem } from './destinations.js';
import { parseRooms } from './rooms.js';

/** The header OpenVidu authenticates the REST API with. Generated on the Embedded page. */
export const API_KEY_HEADER = 'X-API-KEY';

/** The rooms endpoint, relative to wherever the Meet application is served. */
const ROOMS_PATH = 'api/v1/rooms';

/**
 * How many rooms to ask for.
 *
 * `maxItems` defaults to 10 and is capped at 100, and zero or a negative value is answered
 * with 422. Asking for the cap means the menu's "…and N more" counts what is really there,
 * up to a hundred; past that the API paginates and the row undercounts, which is a menu
 * saying "and 80 more" when there are 130. It still goes to the instance, where all of them
 * are, so the cost of not following `nextPageToken` is one inaccurate number on a
 * deployment with more rooms than a popup menu could ever usefully show.
 */
export const MAX_ITEMS = 100;

/** The statuses that mean the key, not the instance, is the problem. */
const REFUSING_STATUSES = new Set([401, 403]);

/**
 * The request for an instance's rooms, or `null` if we should not make one.
 *
 * `null` is returned for an instance URL that fails the same rules a destination is held to,
 * and for a missing key — in both cases there is nothing to ask and nobody to ask it of, and
 * sending an unauthenticated request to find that out would be a request made for no reason.
 */
export function roomsRequest(instanceUrl, apiKey) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (key === '')
        return null;

    const uri = roomsUri(instanceUrl);
    if (uri === null)
        return null;

    return {
        method: 'GET',
        uri,
        headers: {
            // The key travels in a header and never in the URL: a URL reaches proxy logs,
            // browser history and crash reports, and a header does not.
            [API_KEY_HEADER]: key,
            // So that a reverse proxy's HTML login page is a disagreement we can detect
            // rather than something we try to parse as rooms.
            Accept: 'application/json',
        },
    };
}

/**
 * The absolute URL of the rooms endpoint for this instance, or `null`.
 *
 * Resolved *relative* to the instance URL rather than appended to its host. OpenVidu mounts
 * the Meet backend at `api/v1` relative to wherever the application itself is served, and a
 * deployment that serves it under `/meet` is the documented arrangement — so an instance of
 * `https://host/meet/` has to reach `https://host/meet/api/v1/rooms`. An absolute path would
 * miss that deployment entirely while working perfectly on one at the domain root, which is
 * the worst kind of bug to ship.
 */
function roomsUri(instanceUrl) {
    const base = typeof instanceUrl === 'string' ? instanceUrl.trim() : '';
    // The same rule every URL in this extension is held to, and borrowed rather than
    // restated: an instance is somewhere we send a credential, so `http:` here would put the
    // API key on the wire in clear.
    if (base === '' || urlProblem(base) !== null)
        return null;

    // `https://host/meet` and `https://host/meet/` are the same instance to a person, and
    // resolve to different endpoints to a URI parser — the first would drop the `/meet`.
    const withSlash = base.endsWith('/') ? base : `${base}/`;
    try {
        return `${GLib.Uri.resolve_relative(withSlash, ROOMS_PATH, GLib.UriFlags.NONE)}` +
            `?maxItems=${MAX_ITEMS}`;
    } catch {
        return null;
    }
}

/**
 * The answer to that request, as a state the menu can draw.
 *
 * - `ok` with `rooms` — a 200 carrying the documented envelope. An empty list is an `ok`:
 *   an instance with no rooms is working correctly and has nothing to show.
 * - `refused` — 401 or 403. Kept apart from `unreachable` because the two are fixed in
 *   different places: one in the preferences window, one by the deployment coming back.
 * - `unreachable` — everything else. A 500 is not literally unreachable, and the row will
 *   say "could not reach"; the alternative is a sixth state whose row reads "that instance
 *   answered 500", which tells a user no more and one more thing to understand. What they
 *   can do about either is the same: wait, or look at their deployment.
 *
 * A failure state never carries rooms, so a caller cannot accidentally keep a stale list
 * alive through one.
 */
export function readRoomsResponse(response, instanceUrl) {
    const status = Number.isFinite(response?.status) ? response.status : 0;

    if (REFUSING_STATUSES.has(status))
        return { status: 'refused' };
    if (status !== 200)
        return { status: 'unreachable' };

    const rooms = roomsIn(response.body);
    if (rooms === null)
        return { status: 'unreachable' };
    return { status: 'ok', rooms: parseRooms(rooms, instanceUrl) };
}

/**
 * The raw room list inside a 200's body, or `null` if that is not what the body is.
 *
 * Strict about the envelope and relaxed about everything inside it. A proxy's login page
 * answers 200 with HTML, and reading that as an empty list would tell someone their
 * deployment has no rooms when it is in fact sitting behind a login. A bare array is
 * accepted as well as the documented `{rooms: […]}`, so a later version that drops the
 * envelope costs a line here and not the menu.
 */
function roomsIn(body) {
    if (typeof body !== 'string' || body.trim() === '')
        return null;

    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }

    if (Array.isArray(parsed))
        return parsed;
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.rooms))
        return parsed.rooms;
    return null;
}

/**
 * A rooms client over an injected transport.
 *
 * @param {object} deps
 * @param {(request: object) => (Promise<{status: number, body: string}>|object)} deps.send
 *   Performs the request. May resolve, reject, return nothing, or throw. A rejection whose
 *   error is marked `cancelled` is a request the caller abandoned, not a failure.
 */
export function createRoomsClient({ send }) {
    /**
     * Ask one instance for its rooms. Resolves to a state; never rejects, never throws.
     *
     * @param {{label: string, url: string}} instance
     * @param {string} apiKey The key for this instance, or an empty value if there is none.
     * @param {object|null} cancellable Passed through to the transport untouched — this
     *   module knows nothing about Gio, which is what keeps it testable.
     */
    async function fetchRooms(instance, apiKey, cancellable = null) {
        const key = typeof apiKey === 'string' ? apiKey.trim() : '';
        if (key === '') {
            // The shipped instances are in this state until someone adds a key. It must
            // cost no request: one sent to be refused is a request made for no reason.
            return { status: 'no-key' };
        }

        const request = roomsRequest(instance?.url, key);
        if (request === null)
            return { status: 'unreachable' };

        let response;
        try {
            response = await send({ ...request, cancellable });
        } catch (error) {
            // Cancellation is the menu closing or the extension being disabled. Reporting it
            // as a failure would replace the rooms on screen with an error nobody caused.
            return { status: isCancelled(error) ? 'cancelled' : 'unreachable' };
        }
        return readRoomsResponse(response, instance?.url);
    }

    return { fetchRooms };
}

/**
 * Whether this failure is the request having been abandoned.
 *
 * Guarded at every step: the error comes from an injected seam, so it can be a GError, a
 * plain Error, or — from a transport written in a hurry — a string.
 */
function isCancelled(error) {
    if (error === null || typeof error !== 'object')
        return false;
    return error.cancelled === true;
}
