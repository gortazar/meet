// What the menu holds, in every state it can be in — including the ones that would take a
// reconfigured live desktop, a broken instance or a refused API key to look at by hand.
//
// Two levels now: an instance, and the rooms it reports underneath. This file is where the
// entry's behaviour is pinned, because every one of those states is data here and a widget
// only in extension.js.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    buildMenuModel, MAX_ROOMS_SHOWN, PREFERENCES_LABEL, EMPTY_NOTE, EMPTY_DETAIL,
    NO_ROOMS_NOTE, NO_KEY_NOTE, REFUSED_NOTE, LOADING_NOTE, unreachableNote, moreLabel,
} from '../src/lib/menu.js';
import { DEFAULT_DESTINATIONS } from '../src/lib/destinations.js';
import { restoreDefaults } from '../src/lib/editing.js';

const kinds = model => model.map(item => item.kind);
const labels = model => model.map(item => item.label);
const roomsOf = model => model.filter(item => item.kind === 'room');

const ONE = { label: 'Work', url: 'https://meet.example.org/' };

/** A parsed room, as `lib/rooms.js` produces one. */
function room(id, overrides = {}) {
    return {
        id,
        name: id,
        status: 'open',
        createdAt: 1620000000000,
        joinUrl: `https://meet.example.org/room/${id}?secret=s-${id}`,
        ...overrides,
    };
}

suite('the menu a fresh install shows, before any instance has answered', () => {
    const model = buildMenuModel(restoreDefaults());

    test('Meet next, then Meet, then a way into the preferences', () => {
        // With no room state for either, nothing is claimed about their rooms. This is
        // exactly v0.1's menu, and it is what is on screen for the moment before the first
        // request answers.
        assertDeepEqual(kinds(model),
            ['instance', 'separator', 'instance', 'separator', 'preferences']);
        assertDeepEqual(labels(model).filter(l => l !== undefined),
            ['Meet next', 'Meet', PREFERENCES_LABEL]);
    });

    test('each instance carries the destination it will open', () => {
        assertDeepEqual(model.filter(i => i.kind === 'instance').map(i => i.destination.url),
            DEFAULT_DESTINATIONS.map(d => d.url));
    });
});

suite('rooms listed under their instance', () => {
    const model = buildMenuModel([ONE], {
        'https://meet.example.org/': { status: 'ok', rooms: [room('alpha'), room('beta')] },
    });

    test('the instance keeps its row, and the rooms come after it', () => {
        assertDeepEqual(kinds(model), ['instance', 'room', 'room', 'separator', 'preferences']);
        assertDeepEqual(labels(model).slice(0, 3), ['Work', 'alpha', 'beta']);
    });

    test('a room row is indented and an instance row is not', () => {
        // The answered assumption: flat and indented, not behind a submenu that has to be
        // opened. The indentation is data so that extension.js has nothing to decide.
        assertEqual(model[0].indented, false);
        assertEqual(model[1].indented, true);
    });

    test('each room carries the destination its button will open', () => {
        assertDeepEqual(roomsOf(model).map(item => item.destination.url),
            ['https://meet.example.org/room/alpha?secret=s-alpha',
                'https://meet.example.org/room/beta?secret=s-beta']);
    });

    test('the link is launched exactly as the instance gave it, byte for byte', () => {
        // The answered open question for 0.3: the extension adds nothing to a role link —
        // no participant-name, no initial-audio-active, no initial-video-active. OpenVidu
        // Meet has no address for the device page, so a parameter appended here would look
        // like a feature and do nothing, and pre-deciding the camera and microphone would
        // work against the very page the button is trying to reach. See the README.
        const given = 'https://meet.example.org/room/alpha?secret=s-alpha';
        const model = buildMenuModel([ONE], {
            [ONE.url]: { status: 'ok', rooms: [room('alpha', { joinUrl: given })] },
        });
        assertEqual(roomsOf(model)[0].destination.url, given);
    });

    test('a room destination is labelled with the room, so a failure names it', () => {
        assertEqual(roomsOf(model)[0].destination.label, 'alpha');
    });

    test('the button says what it does, to a screen reader as well', () => {
        assertEqual(roomsOf(model)[0].joinLabel, 'Join alpha');
    });

    test('the room id is carried, so a row can be told apart from its twin', () => {
        assertDeepEqual(roomsOf(model).map(item => item.roomId), ['alpha', 'beta']);
    });

    test('the instance row still opens the instance — nothing is taken away', () => {
        assertEqual(model[0].destination.url, ONE.url);
    });
});

suite('how many rooms, in what order', () => {
    // Deliberately out of creation order, so a passing test cannot be an accident of input.
    const many = Array.from({ length: MAX_ROOMS_SHOWN + 5 }, (_, i) =>
        room(`r${i}`, { createdAt: 1000 + i }));

    const model = buildMenuModel([ONE], {
        [ONE.url]: { status: 'ok', rooms: many },
    });

    test('the cap is twenty, as the answered question settled', () => {
        assertEqual(MAX_ROOMS_SHOWN, 20);
    });

    test('at most twenty rooms are listed, however many the instance has', () => {
        assertEqual(roomsOf(model).length, MAX_ROOMS_SHOWN);
    });

    test('most recently created first', () => {
        const listed = roomsOf(model).map(item => item.label);
        assertEqual(listed[0], `r${MAX_ROOMS_SHOWN + 4}`);
        assertEqual(listed[MAX_ROOMS_SHOWN - 1], `r5`);
    });

    test('and the rest are accounted for rather than silently dropped', () => {
        const more = model.find(item => item.kind === 'more');
        assert(more !== undefined, 'nothing says there are more rooms');
        assertEqual(more.label, moreLabel(5));
        assert(more.label.includes('5'), `"${more.label}" does not say how many`);
    });

    test('the more row goes to the instance, which is where the rest are', () => {
        assertEqual(model.find(item => item.kind === 'more').destination.url, ONE.url);
    });

    test('exactly twenty rooms needs no more row', () => {
        const exact = buildMenuModel([ONE], {
            [ONE.url]: { status: 'ok', rooms: many.slice(0, MAX_ROOMS_SHOWN) },
        });
        assertEqual(exact.filter(item => item.kind === 'more').length, 0);
        assertEqual(roomsOf(exact).length, MAX_ROOMS_SHOWN);
    });

    test('rooms created at the same instant keep the order the API gave them', () => {
        const tied = [room('first', { createdAt: 7 }), room('second', { createdAt: 7 })];
        const sorted = buildMenuModel([ONE], { [ONE.url]: { status: 'ok', rooms: tied } });
        assertDeepEqual(roomsOf(sorted).map(item => item.label), ['first', 'second']);
    });

    test('a room with no creation date sorts last rather than first', () => {
        const mixed = [room('undated', { createdAt: 0 }), room('dated', { createdAt: 5 })];
        const sorted = buildMenuModel([ONE], { [ONE.url]: { status: 'ok', rooms: mixed } });
        assertDeepEqual(roomsOf(sorted).map(item => item.label), ['dated', 'undated']);
    });
});

suite('closed rooms are listed too', () => {
    test('a closed room is a row like any other', () => {
        // The answered question: the first twenty, most recent first, and closed ones shown
        // as well. A room you closed yesterday is one you may well want to reopen.
        const model = buildMenuModel([ONE], {
            [ONE.url]: {
                status: 'ok',
                rooms: [room('open-one'), room('shut', { status: 'closed', createdAt: 1 })],
            },
        });
        assertDeepEqual(roomsOf(model).map(item => item.label), ['open-one', 'shut']);
    });

    test('the room\'s own status rides along, in case a row ever wants it', () => {
        const model = buildMenuModel([ONE], {
            [ONE.url]: { status: 'ok', rooms: [room('shut', { status: 'closed' })] },
        });
        assertEqual(roomsOf(model)[0].roomStatus, 'closed');
    });
});

suite('a room whose link we will not vouch for', () => {
    const model = buildMenuModel([ONE], {
        [ONE.url]: { status: 'ok', rooms: [room('nolink', { joinUrl: null })] },
    });

    test('is listed, because it is a room the instance has', () => {
        assertEqual(roomsOf(model).length, 1);
        assertEqual(roomsOf(model)[0].label, 'nolink');
    });

    test('but carries no destination, so no button is drawn and the name is inert', () => {
        // The alternative is a button that goes somewhere other than the call, which is the
        // one outcome this entry exists to prevent.
        assertEqual(roomsOf(model)[0].destination, null);
        assertEqual(roomsOf(model)[0].joinLabel, null);
    });
});

suite('every failure is a row, not an exception', () => {
    const noteUnder = state => {
        const model = buildMenuModel([ONE], { [ONE.url]: state });
        assertEqual(model[0].kind, 'instance', 'the instance row did not survive');
        assertEqual(model[1].kind, 'room-note', `no note for ${JSON.stringify(state)}`);
        assertEqual(model[1].indented, true);
        return model[1].label;
    };

    test('no API key asks for one, and says where', () => {
        assertEqual(noteUnder({ status: 'no-key' }), NO_KEY_NOTE);
        assert(NO_KEY_NOTE.includes(PREFERENCES_LABEL),
            'the note does not point at the window that fixes it');
    });

    test('unreachable names the instance, so you know which one is down', () => {
        assertEqual(noteUnder({ status: 'unreachable' }), unreachableNote(ONE.label));
        assert(unreachableNote('Work').includes('Work'));
    });

    test('a refused key says the key was refused, not that the server was down', () => {
        assertEqual(noteUnder({ status: 'refused' }), REFUSED_NOTE);
    });

    test('no rooms says so rather than leaving a gap under the instance', () => {
        assertEqual(noteUnder({ status: 'ok', rooms: [] }), NO_ROOMS_NOTE);
    });

    test('a request in flight says it is looking', () => {
        assertEqual(noteUnder({ status: 'loading' }), LOADING_NOTE);
    });

    test('a status nobody here knows about is not a crash and not a row', () => {
        const model = buildMenuModel([ONE], { [ONE.url]: { status: 'something-new' } });
        assertDeepEqual(kinds(model), ['instance', 'separator', 'preferences']);
    });

    test('a broken instance costs its rooms and not the menu', () => {
        const model = buildMenuModel([ONE, { label: 'Other', url: 'https://b.example/' }], {
            [ONE.url]: { status: 'unreachable' },
            'https://b.example/': { status: 'ok', rooms: [room('fine')] },
        });
        assertDeepEqual(kinds(model), [
            'instance', 'room-note', 'separator', 'instance', 'room', 'separator',
            'preferences',
        ]);
    });

    test('a note is never something you can click', () => {
        for (const state of [{ status: 'no-key' }, { status: 'unreachable' },
            { status: 'refused' }, { status: 'ok', rooms: [] }, { status: 'loading' }]) {
            const model = buildMenuModel([ONE], { [ONE.url]: state });
            assertEqual(model[1].destination, undefined,
                'a note carries somewhere to go');
        }
    });
});

suite('the states configuration can put the menu in', () => {
    test('the order is the order you set, not an alphabetical one', () => {
        const model = buildMenuModel([
            { label: 'Zulu', url: 'https://z.example/' },
            { label: 'Alpha', url: 'https://a.example/' },
        ]);
        assertDeepEqual(labels(model).slice(0, 1), ['Zulu']);
        assertDeepEqual(model.filter(i => i.kind === 'instance').map(i => i.label),
            ['Zulu', 'Alpha']);
    });

    test('as many instances as you like', () => {
        const many = Array.from({ length: 12 }, (_, i) =>
            ({ label: `Room ${i}`, url: `https://r${i}.example/` }));
        assertEqual(buildMenuModel(many).filter(item => item.kind === 'instance').length, 12);
    });

    test('instances are separated from each other, and the first has none above it', () => {
        const model = buildMenuModel([ONE, { label: 'Other', url: 'https://b.example/' }]);
        assertEqual(model[0].kind, 'instance');
        assertEqual(kinds(model).filter(k => k === 'separator').length, 2);
    });

    test('one instance gets one separator, the one before the preferences', () => {
        const model = buildMenuModel([ONE]);
        assertEqual(kinds(model).filter(k => k === 'separator').length, 1);
        assertEqual(kinds(model).indexOf('separator'), model.length - 2);
    });

    test('no instances at all says what to do instead of being blank', () => {
        // Reachable: remove every entry in the preferences. A menu that opened to nothing
        // would be a dead end — nothing to click, and no way from here to the window that
        // would fix it. Unchanged from 0.1, deliberately.
        const model = buildMenuModel([]);
        assertDeepEqual(kinds(model), ['note', 'separator', 'preferences']);
        assertEqual(model[0].label, EMPTY_NOTE);
        assertEqual(model[0].detail, EMPTY_DETAIL);
        assert(model[0].detail.includes(PREFERENCES_LABEL),
            'the empty menu does not point at the item that fixes it');
    });

    test('there is always exactly one way into the preferences, and it is last', () => {
        for (const list of [[], restoreDefaults(), [ONE]]) {
            const model = buildMenuModel(list);
            assertEqual(model.filter(item => item.kind === 'preferences').length, 1);
            assertEqual(model[model.length - 1].kind, 'preferences');
            assertEqual(model[model.length - 1].label, PREFERENCES_LABEL);
        }
    });

    test('an instance with no name is still visible, so it can be clicked or fixed', () => {
        const model = buildMenuModel([{ label: '   ', url: 'https://x.example/' }]);
        assertEqual(model[0].kind, 'instance');
        assert(model[0].label.trim() !== '', 'the row has no visible label');
    });

    test('nothing at all in place of a list is the empty menu, not a throw', () => {
        for (const value of [null, undefined, 'rooms', 42])
            assertDeepEqual(kinds(buildMenuModel(value)), ['note', 'separator', 'preferences']);
    });

    test('nothing at all in place of the room states is the menu without rooms', () => {
        for (const value of [null, undefined, 'states', 42, []]) {
            assertDeepEqual(kinds(buildMenuModel([ONE], value)),
                ['instance', 'separator', 'preferences']);
        }
    });

    test('a room state for an instance nobody configured is ignored', () => {
        const model = buildMenuModel([ONE], {
            'https://gone.example/': { status: 'ok', rooms: [room('ghost')] },
        });
        assertDeepEqual(kinds(model), ['instance', 'separator', 'preferences']);
    });

    test('a room state that is not a state at all is no rows, not a throw', () => {
        for (const state of [null, 'ok', 42, [], {}]) {
            assertDeepEqual(kinds(buildMenuModel([ONE], { [ONE.url]: state })),
                ['instance', 'separator', 'preferences']);
        }
    });

    test('an ok state whose rooms are not a list is read as no rooms', () => {
        const model = buildMenuModel([ONE], { [ONE.url]: { status: 'ok', rooms: 'lots' } });
        assertEqual(model[1].kind, 'room-note');
        assertEqual(model[1].label, NO_ROOMS_NOTE);
    });
});

suite('nothing in the menu model carries a secret further than it must', () => {
    test('a secret appears exactly once per room: in the URL it will open', () => {
        // A role link is a credential. It belongs in the destination the launcher is handed
        // and nowhere else — not in a label, not in an accessible name, not in an id.
        const model = buildMenuModel([ONE], {
            [ONE.url]: { status: 'ok', rooms: [room('alpha')] },
        });
        for (const item of model) {
            for (const [field, value] of Object.entries(item)) {
                if (field === 'destination' || typeof value !== 'string')
                    continue;
                assert(!value.includes('secret'), `${item.kind}.${field} carries a secret`);
            }
        }
    });
});
