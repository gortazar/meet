// The request an instance's room list needs, and what to make of every answer it can give.
//
// The transport is injected, so "the server answered 401", "the server answered HTML" and
// "the server answered a room with no links" are ordinary tests here rather than things you
// would have to break a deployment to see. The only part not covered from here is the four
// lines in extension.js that hand the request to libsoup.
//
// Every shape asserted below is from OpenVidu Meet's own OpenAPI specification
// (meet-ce/backend/openapi), not from guesswork.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    API_KEY_HEADER, MAX_ITEMS, createRoomsClient, readRoomsResponse, roomsRequest,
} from '../src/lib/client.js';

const INSTANCE = { label: 'Work', url: 'https://meet.example.org/' };
const KEY = 'ovmeet_testkey';

/** The documented 200 body, trimmed to the fields this extension reads. */
function payload(rooms) {
    return JSON.stringify({
        rooms,
        _extraFields: [],
        pagination: { isTruncated: false, nextPageToken: null, maxItems: MAX_ITEMS },
    });
}

function apiRoom(id, overrides = {}) {
    return {
        roomId: id,
        roomName: id,
        owner: 'admin',
        creationDate: 1620000000000,
        status: 'open',
        access: {
            anonymous: {
                moderator: { enabled: true, url: `https://meet.example.org/room/${id}?secret=m` },
                speaker: { enabled: true, url: `https://meet.example.org/room/${id}?secret=s` },
            },
            user: { enabled: false, url: `https://meet.example.org/room/${id}` },
        },
        ...overrides,
    };
}

/** A client whose transport answers with exactly this, once. */
function clientAnswering(response) {
    const sent = [];
    const client = createRoomsClient({
        send: request => {
            sent.push(request);
            return typeof response === 'function' ? response(request) : response;
        },
    });
    return { client, sent };
}

suite('the request the API needs', () => {
    const request = roomsRequest(INSTANCE.url, KEY);

    test('it is a GET, because listing rooms changes nothing', () => {
        assertEqual(request.method, 'GET');
    });

    test('the path is resolved against the instance, not bolted onto its host', () => {
        // OpenVidu mounts the Meet backend at api/v1 relative to wherever the app is
        // served, and a deployment that serves it under /meet is the documented case. An
        // absolute /api/v1/rooms would miss that deployment entirely.
        assertEqual(roomsRequest('https://meet.example.org/', KEY).uri,
            `https://meet.example.org/api/v1/rooms?maxItems=${MAX_ITEMS}`);
        assertEqual(roomsRequest('https://host.example/meet/', KEY).uri,
            `https://host.example/meet/api/v1/rooms?maxItems=${MAX_ITEMS}`);
    });

    test('an instance written without its trailing slash still means that instance', () => {
        assertEqual(roomsRequest('https://host.example/meet', KEY).uri,
            `https://host.example/meet/api/v1/rooms?maxItems=${MAX_ITEMS}`);
    });

    test('the key goes in the header OpenVidu documents, and only there', () => {
        assertEqual(request.headers[API_KEY_HEADER], KEY);
        assertEqual(API_KEY_HEADER, 'X-API-KEY');
        assert(!request.uri.includes(KEY), 'the key is in the URL, where it would be logged');
    });

    test('it asks for JSON, so an HTML error page is the server disagreeing', () => {
        assertEqual(request.headers.Accept, 'application/json');
    });

    test('it asks for a hundred rooms: the cap the API applies anyway', () => {
        // maxItems defaults to 10 and is capped at 100. Asking for the cap means the
        // "…and N more" row counts what is really there, up to a hundred.
        assertEqual(MAX_ITEMS, 100);
        assert(request.uri.includes(`maxItems=${MAX_ITEMS}`), request.uri);
    });

    test('a zero or negative maxItems is never sent, because the API answers 422', () => {
        assert(MAX_ITEMS >= 1);
    });

    test('an instance URL that is not one produces no request at all', () => {
        for (const url of ['', '   ', 'not a url', 'http://meet.example.org/',
            'file:///tmp', null, undefined, 42])
            assertEqual(roomsRequest(url, KEY), null, `${JSON.stringify(url)} built a request`);
    });

    test('no key produces no request, rather than an unauthenticated one', () => {
        for (const key of ['', '   ', null, undefined, 42])
            assertEqual(roomsRequest(INSTANCE.url, key), null);
    });

    test('a key with stray whitespace around it is trimmed, not refused', () => {
        // Pasted out of the Embedded page, a key arrives with a newline more often than not.
        assertEqual(roomsRequest(INSTANCE.url, `  ${KEY}\n`).headers[API_KEY_HEADER], KEY);
    });
});

suite('what to make of a 200', () => {
    test('the documented body becomes rooms the menu can list', () => {
        const state = readRoomsResponse(
            { status: 200, body: payload([apiRoom('alpha'), apiRoom('beta')]) }, INSTANCE.url);
        assertEqual(state.status, 'ok');
        assertDeepEqual(state.rooms.map(r => r.id), ['alpha', 'beta']);
        assertEqual(state.rooms[0].joinUrl, 'https://meet.example.org/room/alpha?secret=m');
    });

    test('no rooms is a successful answer, not a failure', () => {
        const state = readRoomsResponse({ status: 200, body: payload([]) }, INSTANCE.url);
        assertEqual(state.status, 'ok');
        assertDeepEqual(state.rooms, []);
    });

    test('the user link is never mistaken for a way in', () => {
        // access.user.url is the room's own page — the same path with no secret. It is the
        // exact thing the join button must go past, and it sits right next to the link we
        // do want.
        const state = readRoomsResponse(
            { status: 200, body: payload([apiRoom('alpha')]) }, INSTANCE.url);
        assert(state.rooms[0].joinUrl.includes('secret='), state.rooms[0].joinUrl);
    });

    test('a room with no links at all is listed with none', () => {
        // Real: the url fields are removed unless the caller holds roomShareAccessLinks.
        const room = apiRoom('alpha');
        delete room.access.anonymous.moderator.url;
        const state = readRoomsResponse({ status: 200, body: payload([room]) }, INSTANCE.url);
        assertEqual(state.status, 'ok');
        assertEqual(state.rooms[0].joinUrl, null);
        assertEqual(state.rooms[0].name, 'alpha');
    });

    test('a room the parser cannot use costs that room and not the answer', () => {
        const state = readRoomsResponse(
            { status: 200, body: payload([apiRoom('alpha'), { nope: true }]) }, INSTANCE.url);
        assertEqual(state.status, 'ok');
        assertDeepEqual(state.rooms.map(r => r.id), ['alpha']);
    });

    test('a bare array, should a later version answer with one, is read too', () => {
        const state = readRoomsResponse(
            { status: 200, body: JSON.stringify([apiRoom('alpha')]) }, INSTANCE.url);
        assertEqual(state.status, 'ok');
        assertDeepEqual(state.rooms.map(r => r.id), ['alpha']);
    });

    test('fields a later version adds are ignored, not fatal', () => {
        const body = JSON.stringify({
            rooms: [apiRoom('alpha', { somethingNew: { deeply: ['nested'] } })],
            somethingElseNew: 42,
        });
        assertEqual(readRoomsResponse({ status: 200, body }, INSTANCE.url).status, 'ok');
    });

    test('a 200 whose body is not the envelope at all is not a room list', () => {
        // A proxy's login page answers 200 with HTML. Reading that as "no rooms yet" would
        // tell the user their deployment is empty when it is in fact in front of a login.
        for (const body of ['<!doctype html><html><body>Sign in</body></html>',
            '{"message":"ok"}', '{"rooms":"lots"}', '{', '', 'null', '42']) {
            assertEqual(readRoomsResponse({ status: 200, body }, INSTANCE.url).status,
                'unreachable', `"${body}" was read as a room list`);
        }
    });

    test('a body truncated mid-JSON is not half a room list', () => {
        const whole = payload([apiRoom('alpha')]);
        assertEqual(
            readRoomsResponse({ status: 200, body: whole.slice(0, 60) }, INSTANCE.url).status,
            'unreachable');
    });

    test('201 and 204 are not the answer to this request either', () => {
        for (const status of [201, 204]) {
            assertEqual(readRoomsResponse({ status, body: payload([]) }, INSTANCE.url).status,
                'unreachable');
        }
    });
});

suite('what to make of everything else', () => {
    const statusFor = status =>
        readRoomsResponse({ status, body: '{"error":"no"}' }, INSTANCE.url).status;

    test('401 and 403 are the key being refused, and say so', () => {
        // Distinct from unreachable on purpose: one is fixed in the preferences window and
        // the other is fixed by the deployment coming back.
        assertEqual(statusFor(401), 'refused');
        assertEqual(statusFor(403), 'refused');
    });

    test('404, 429, 500 and 502 are the instance not answering with rooms', () => {
        // 429 is the one that bit a sibling idea: libsoup's get_status() throws on a status
        // outside its enum. Nothing here calls it — the status arrives as a number.
        for (const status of [404, 422, 429, 500, 502, 503])
            assertEqual(statusFor(status), 'unreachable', `${status} was not unreachable`);
    });

    test('a response that is not a response is unreachable, not a throw', () => {
        for (const response of [null, undefined, 'answer', 42, {}, { status: 'two hundred' }])
            assertEqual(readRoomsResponse(response, INSTANCE.url).status, 'unreachable');
    });

    test('no failure state ever carries rooms, so a stale list cannot leak through one', () => {
        for (const status of [401, 500, 429]) {
            const state = readRoomsResponse({ status, body: payload([apiRoom('a')]) },
                INSTANCE.url);
            assertEqual(state.rooms, undefined, `${status} carried rooms`);
        }
    });
});

suite('the client over its transport', () => {
    test('one call, one request, carrying the key', async () => {
        const { client, sent } = clientAnswering({ status: 200, body: payload([apiRoom('a')]) });
        const state = await client.fetchRooms(INSTANCE, KEY);
        assertEqual(state.status, 'ok');
        assertEqual(sent.length, 1);
        assertEqual(sent[0].headers[API_KEY_HEADER], KEY);
    });

    test('no key is a state, and nothing is sent', async () => {
        // The two shipped instances are in this state until someone adds a key, so it must
        // cost no request at all — not a request that is going to be refused.
        for (const key of ['', '   ', null, undefined, 42]) {
            const { client, sent } = clientAnswering({ status: 200, body: payload([]) });
            assertEqual((await client.fetchRooms(INSTANCE, key)).status, 'no-key',
                `${JSON.stringify(key)} was treated as a key`);
            assertEqual(sent.length, 0, 'a request went out without a key');
        }
    });

    test('an instance URL that is not one is unreachable, and nothing is sent', async () => {
        for (const url of ['nonsense', 'http://meet.example.org/', '', null]) {
            const { client, sent } = clientAnswering({ status: 200, body: payload([]) });
            assertEqual((await client.fetchRooms({ label: 'Broken', url }, KEY)).status,
                'unreachable', `${JSON.stringify(url)} produced a request`);
            assertEqual(sent.length, 0);
        }
    });

    test('a transport that rejects is unreachable, not an unhandled rejection', async () => {
        const { client } = clientAnswering(() => Promise.reject(new Error('no route to host')));
        assertEqual((await client.fetchRooms(INSTANCE, KEY)).status, 'unreachable');
    });

    test('a transport that throws on the calling frame is caught too', async () => {
        const { client } = clientAnswering(() => {
            throw new Error('the session was disposed');
        });
        assertEqual((await client.fetchRooms(INSTANCE, KEY)).status, 'unreachable');
    });

    test('a transport that answers nothing at all is unreachable', async () => {
        const { client } = clientAnswering(undefined);
        assertEqual((await client.fetchRooms(INSTANCE, KEY)).status, 'unreachable');
    });

    test('a cancelled request is its own state, so a closing menu draws no error', async () => {
        // Closing the menu cancels in flight. That is not a failure and must not replace
        // the rooms on screen with "could not reach".
        const { client } = clientAnswering(() => {
            const error = new Error('Operation was cancelled');
            error.cancelled = true;
            return Promise.reject(error);
        });
        assertEqual((await client.fetchRooms(INSTANCE, KEY)).status, 'cancelled');
    });

    test('fetchRooms never rejects, whatever the transport does', async () => {
        // A transport written in a hurry can throw something that is not an Error at all.
        const notAnError = 'a string, thrown';
        for (const answer of [() => Promise.reject('a string'), () => Promise.reject(null),
            () => { throw notAnError; }, () => null]) {
            const { client } = clientAnswering(answer);
            const state = await client.fetchRooms(INSTANCE, KEY);
            assert(typeof state.status === 'string', 'no state came back');
        }
    });

    test('the transport is handed the cancellable it was given, untouched', async () => {
        const token = { it: 'is opaque to the client' };
        const { client, sent } = clientAnswering({ status: 200, body: payload([]) });
        await client.fetchRooms(INSTANCE, KEY, token);
        assertEqual(sent[0].cancellable, token);
    });
});
