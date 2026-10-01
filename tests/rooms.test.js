// What a room is, and the one thing that matters about it: whether the link we were handed
// really lands in the call.
//
// Every case here is a shape a real instance can return. The degraded ones are the point —
// a link that quietly stops being a join link is the failure this module exists to catch.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    JOIN_ROLE, joinUrlProblem, parseRoom, parseRooms,
} from '../src/lib/rooms.js';

const INSTANCE = 'https://meet.example.org/';

/** A room as the REST API documents it: roomId, roomName, creationDate, access, status. */
function apiRoom(overrides = {}) {
    return {
        roomId: 'room-123',
        roomName: 'Weekly sync',
        owner: 'admin',
        creationDate: 1620000000000,
        status: 'open',
        access: {
            anonymous: {
                moderator: {
                    enabled: true,
                    url: 'https://meet.example.org/room/room-123?secret=modsecret',
                },
                speaker: {
                    enabled: true,
                    url: 'https://meet.example.org/room/room-123?secret=spksecret',
                },
            },
        },
        ...overrides,
    };
}

suite('which link a room joins with', () => {
    test('the role is the moderator, as the answered question settled', () => {
        assertEqual(JOIN_ROLE, 'moderator');
    });

    test('a whole room, as the API returns it', () => {
        assertDeepEqual(parseRoom(apiRoom(), INSTANCE), {
            id: 'room-123',
            name: 'Weekly sync',
            status: 'open',
            createdAt: 1620000000000,
            joinUrl: 'https://meet.example.org/room/room-123?secret=modsecret',
        });
    });

    test('the moderator link is taken, never the speaker one', () => {
        const room = parseRoom(apiRoom(), INSTANCE);
        assert(room.joinUrl.includes('modsecret'), `took ${room.joinUrl}`);
    });

    test('a moderator link that is switched off is not quietly swapped for the speaker', () => {
        // Falling back would join you as a different role than the one you chose, without
        // saying so. No link is the honest answer; the row is listed without a button.
        const room = parseRoom(apiRoom({
            access: {
                anonymous: {
                    moderator: { enabled: false, url: 'https://meet.example.org/room/r?secret=s' },
                    speaker: { enabled: true, url: 'https://meet.example.org/room/r?secret=t' },
                },
            },
        }), INSTANCE);
        assertEqual(room.joinUrl, null);
    });
});

suite('a join URL has to be a join URL', () => {
    test('the documented form passes', () => {
        assertEqual(
            joinUrlProblem('https://meet.example.org/room/room-123?secret=abc', INSTANCE),
            null);
    });

    test('without a secret it is the room page, not the call', () => {
        // The exact degradation the entry is about: same path, no secret, and you land on
        // a page that talks about the room instead of in it.
        assert(joinUrlProblem('https://meet.example.org/room/room-123', INSTANCE) !== null);
    });

    test('an empty secret is no secret', () => {
        assert(joinUrlProblem('https://meet.example.org/room/r?secret=', INSTANCE) !== null);
    });

    test('a link on another host is not this instance speaking', () => {
        assert(joinUrlProblem('https://elsewhere.example/room/r?secret=abc', INSTANCE) !== null);
    });

    test('http is refused, as it is everywhere else here', () => {
        assert(joinUrlProblem('http://meet.example.org/room/r?secret=abc', INSTANCE) !== null);
    });

    test('a scheme that is not the web at all is refused', () => {
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x'])
            assert(joinUrlProblem(url, INSTANCE) !== null, `${url} was accepted`);
    });

    test('nonsense is refused rather than thrown over', () => {
        for (const url of ['', 'not a url', null, undefined, 42, {}])
            assert(joinUrlProblem(url, INSTANCE) !== null, `${JSON.stringify(url)} was accepted`);
    });

    test('an instance URL we cannot parse means we cannot vouch for anything', () => {
        assert(joinUrlProblem('https://meet.example.org/room/r?secret=abc', 'nonsense') !== null);
    });

    test('the default https port is not a different host', () => {
        // A deployment that answers on :443 explicitly, or an instance configured with the
        // port spelled out, is the same instance. Refusing it would cost a real user their
        // whole room list over a cosmetic difference.
        assertEqual(
            joinUrlProblem('https://meet.example.org:443/room/r?secret=abc', INSTANCE), null);
        assertEqual(
            joinUrlProblem('https://meet.example.org/room/r?secret=abc',
                'https://meet.example.org:443/'), null);
    });

    test('a different port is a different host', () => {
        assert(joinUrlProblem('https://meet.example.org:8443/room/r?secret=abc', INSTANCE)
            !== null);
    });

    test('the host comparison ignores case, as host names do', () => {
        assertEqual(
            joinUrlProblem('https://MEET.example.ORG/room/r?secret=abc', INSTANCE), null);
    });

    test('a secret among other parameters still counts', () => {
        assertEqual(
            joinUrlProblem('https://meet.example.org/room/r?lang=es&secret=abc', INSTANCE),
            null);
    });

    test('a parameter merely containing "secret" is not the secret', () => {
        assert(joinUrlProblem('https://meet.example.org/room/r?not-secret=abc', INSTANCE)
            !== null);
    });
});

suite('a room whose link does not survive those checks', () => {
    const withoutButton = raw => {
        const room = parseRoom(raw, INSTANCE);
        assert(room !== null, 'the room itself was dropped');
        assertEqual(room.joinUrl, null, 'a join URL survived that should not have');
        return room;
    };

    test('a link without a secret costs the button, not the row', () => {
        const room = withoutButton(apiRoom({
            access: {
                anonymous: {
                    moderator: { enabled: true, url: 'https://meet.example.org/room/room-123' },
                },
            },
        }));
        assertEqual(room.name, 'Weekly sync');
    });

    test('a link on another host costs the button, not the row', () => {
        withoutButton(apiRoom({
            access: {
                anonymous: {
                    moderator: { enabled: true, url: 'https://evil.example/room/x?secret=s' },
                },
            },
        }));
    });

    test('a room with no access object at all is still a room', () => {
        withoutButton(apiRoom({ access: undefined }));
    });

    test('a room with an empty access object is still a room', () => {
        withoutButton(apiRoom({ access: {} }));
        withoutButton(apiRoom({ access: { anonymous: {} } }));
        withoutButton(apiRoom({ access: { anonymous: { moderator: {} } } }));
    });

    test('a room whose access is a string, which no sane API returns', () => {
        withoutButton(apiRoom({ access: 'yes please' }));
    });
});

suite('what is required of a room, and what is not', () => {
    test('no roomId is not a room — there is nothing to join', () => {
        assertEqual(parseRoom(apiRoom({ roomId: undefined }), INSTANCE), null);
        assertEqual(parseRoom(apiRoom({ roomId: '' }), INSTANCE), null);
        assertEqual(parseRoom(apiRoom({ roomId: 17 }), INSTANCE), null);
    });

    test('anything that is not an object is not a room', () => {
        for (const raw of [null, undefined, 'room', 42, []])
            assertEqual(parseRoom(raw, INSTANCE), null, `${JSON.stringify(raw)} parsed`);
    });

    test('a missing name falls back to the id rather than losing the room', () => {
        assertEqual(parseRoom(apiRoom({ roomName: undefined }), INSTANCE).name, 'room-123');
        assertEqual(parseRoom(apiRoom({ roomName: '   ' }), INSTANCE).name, 'room-123');
    });

    test('a missing creation date sorts last rather than breaking the sort', () => {
        assertEqual(parseRoom(apiRoom({ creationDate: undefined }), INSTANCE).createdAt, 0);
        assertEqual(parseRoom(apiRoom({ creationDate: 'yesterday' }), INSTANCE).createdAt, 0);
    });

    test('a missing status is read as open, which is what a room usually is', () => {
        assertEqual(parseRoom(apiRoom({ status: undefined }), INSTANCE).status, 'open');
    });

    test('a status the API invents later is carried through, not rejected', () => {
        // A 3.x minor that adds a status must cost a field, not the menu.
        assertEqual(parseRoom(apiRoom({ status: 'hibernating' }), INSTANCE).status,
            'hibernating');
    });

    test('closed rooms are rooms — the answered question asks for them listed', () => {
        const room = parseRoom(apiRoom({ status: 'closed' }), INSTANCE);
        assertEqual(room.status, 'closed');
        assert(room.joinUrl !== null, 'a closed room lost its link');
    });

    test('the name is trimmed, because a menu row of spaces cannot be read', () => {
        assertEqual(parseRoom(apiRoom({ roomName: '  Weekly sync  ' }), INSTANCE).name,
            'Weekly sync');
    });

    test('fields nobody here uses are not carried along', () => {
        assertDeepEqual(Object.keys(parseRoom(apiRoom(), INSTANCE)).sort(),
            ['createdAt', 'id', 'joinUrl', 'name', 'status']);
    });
});

suite('a list of rooms', () => {
    test('in the order the API gave them', () => {
        const rooms = parseRooms([
            apiRoom({ roomId: 'a', roomName: 'A' }),
            apiRoom({ roomId: 'b', roomName: 'B' }),
        ], INSTANCE);
        assertDeepEqual(rooms.map(r => r.id), ['a', 'b']);
    });

    test('one unusable room costs that room and not the list', () => {
        const rooms = parseRooms([
            apiRoom({ roomId: 'a' }), { nonsense: true }, apiRoom({ roomId: 'c' }),
        ], INSTANCE);
        assertDeepEqual(rooms.map(r => r.id), ['a', 'c']);
    });

    test('anything that is not a list is an empty list', () => {
        for (const raw of [null, undefined, 'rooms', {}, 42])
            assertDeepEqual(parseRooms(raw, INSTANCE), []);
    });

    test('nothing here throws, whatever it is handed', () => {
        // parseRooms is called on a payload from the network. A throw would be an
        // unhandled rejection inside the compositor's main loop.
        parseRooms([null, undefined, [], 'x', { access: { anonymous: null } }], INSTANCE);
        parseRooms([apiRoom()], null);
        parseRooms([apiRoom()], undefined);
    });
});
