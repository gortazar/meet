// What the menu holds, in every state it can be in — including the ones that would take a
// reconfigured live desktop to look at by hand.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    buildMenuModel, PREFERENCES_LABEL, EMPTY_NOTE, EMPTY_DETAIL,
} from '../src/lib/menu.js';
import { DEFAULT_DESTINATIONS } from '../src/lib/destinations.js';
import { restoreDefaults } from '../src/lib/editing.js';

const kinds = model => model.map(item => item.kind);
const labels = model => model.map(item => item.label);

suite('the menu a fresh install shows', () => {
    const model = buildMenuModel(restoreDefaults());

    test('Meet next, then Meet, then a way into the preferences', () => {
        assertDeepEqual(kinds(model),
            ['destination', 'destination', 'separator', 'preferences']);
        assertDeepEqual(labels(model).slice(0, 2), ['Meet next', 'Meet']);
    });

    test('each room carries the destination it will open', () => {
        assertDeepEqual(model.slice(0, 2).map(item => item.destination.url),
            DEFAULT_DESTINATIONS.map(d => d.url));
    });
});

suite('the menu in the states configuration can put it in', () => {
    test('the order is the order you set, not an alphabetical one', () => {
        const model = buildMenuModel([
            { label: 'Zulu', url: 'https://z.example/' },
            { label: 'Alpha', url: 'https://a.example/' },
        ]);
        assertDeepEqual(labels(model).slice(0, 2), ['Zulu', 'Alpha']);
    });

    test('as many rooms as you like', () => {
        const many = Array.from({ length: 12 }, (_, i) =>
            ({ label: `Room ${i}`, url: `https://r${i}.example/` }));
        assertEqual(buildMenuModel(many).filter(item => item.kind === 'destination').length, 12);
    });

    test('no rooms at all says what to do instead of being blank', () => {
        // Reachable: remove every entry in the preferences. A menu that opened to nothing
        // would be a dead end — nothing to click, and no way from here to the window that
        // would fix it.
        const model = buildMenuModel([]);
        assertDeepEqual(kinds(model), ['note', 'separator', 'preferences']);
        assertEqual(model[0].label, EMPTY_NOTE);
        assertEqual(model[0].detail, EMPTY_DETAIL);
        assert(model[0].detail.includes(PREFERENCES_LABEL),
            'the empty menu does not point at the item that fixes it');
    });

    test('there is always exactly one way into the preferences, and it is last', () => {
        for (const list of [[], restoreDefaults(), [{ label: 'One', url: 'https://x.example/' }]]) {
            const model = buildMenuModel(list);
            assertEqual(model.filter(item => item.kind === 'preferences').length, 1);
            assertEqual(model[model.length - 1].kind, 'preferences');
            assertEqual(model[model.length - 1].label, PREFERENCES_LABEL);
        }
    });

    test('the separator sits between the rooms and the preferences, never at the top', () => {
        for (const list of [[], restoreDefaults()]) {
            const model = buildMenuModel(list);
            assertEqual(kinds(model).indexOf('separator'), model.length - 2);
        }
    });

    test('a room with no name is still visible, so it can be clicked or fixed', () => {
        // Not reachable through the setting — the validator refuses a blank label — but
        // reachable through a caller that built one by hand, and an invisible menu row is
        // one you cannot avoid clicking.
        const model = buildMenuModel([{ label: '   ', url: 'https://x.example/' }]);
        assertEqual(model[0].kind, 'destination');
        assert(model[0].label.trim() !== '', 'the row has no visible label');
    });

    test('nothing at all in place of a list is the empty menu, not a throw', () => {
        for (const value of [null, undefined, 'rooms', 42])
            assertDeepEqual(kinds(buildMenuModel(value)), ['note', 'separator', 'preferences']);
    });
});
