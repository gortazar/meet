// The preferences window's behaviour, without the preferences window.
//
// prefs.js is Adwaita rows and buttons over these functions, and Adwaita cannot be loaded
// outside a GTK process — so if the rules about what "add", "remove", "move" and "restore"
// do lived in prefs.js, nothing would ever test them but a human clicking. Here they are
// ordinary functions over ordinary arrays.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    BLANK_DESTINATION, addDestination, removeAt, replaceAt, moveAt, restoreDefaults,
    isDefault, isBlank, listProblems,
} from '../src/lib/editing.js';
import { DEFAULT_DESTINATIONS, toPairs } from '../src/lib/destinations.js';

const A = { label: 'A', url: 'https://a.example/' };
const B = { label: 'B', url: 'https://b.example/' };
const C = { label: 'C', url: 'https://c.example/' };

suite('adding a destination', () => {
    test('a new row goes on the end, prefilled with the scheme', () => {
        const list = addDestination([A]);
        assertEqual(list.length, 2);
        assertDeepEqual(list[1], { label: '', url: BLANK_DESTINATION.url });
        assertEqual(BLANK_DESTINATION.url, 'https://',
            'the prefill is not the one scheme a destination may have');
    });

    test('adding to nothing gives you one row', () => {
        // The state after removing every entry, which the user is allowed to reach.
        assertEqual(addDestination([]).length, 1);
    });

    test('an explicit destination can be added instead of a blank one', () => {
        assertDeepEqual(addDestination([], A), [A]);
    });

    test('the list it was given is not the list it returns', () => {
        // Every one of these is called from a signal handler with the window's own list.
        // Mutating in place there means the window and the model disagree about what is on
        // screen, which is the bug that looks like "the row came back".
        const before = [A];
        addDestination(before);
        assertEqual(before.length, 1);
    });
});

suite('removing a destination', () => {
    test('the row goes and the order of the rest is kept', () => {
        assertDeepEqual(removeAt([A, B, C], 1), [A, C]);
    });

    test('the last one can be removed — including a default', () => {
        // The answered open question is explicit: the two shipped entries appear by
        // default and can be removed. Nothing here treats them as undeletable.
        assertDeepEqual(removeAt(restoreDefaults(), 0).map(d => d.label), ['Meet']);
        assertDeepEqual(removeAt(removeAt(restoreDefaults(), 0), 0), []);
    });

    test('an index that is not there changes nothing', () => {
        for (const index of [-1, 3, 1.5, NaN, null, undefined, '1'])
            assertDeepEqual(removeAt([A, B, C], index), [A, B, C], `index ${index}`);
    });

    test('it does not mutate', () => {
        const before = [A, B];
        removeAt(before, 0);
        assertEqual(before.length, 2);
    });
});

suite('editing a destination', () => {
    test('a patch of one field leaves the other alone', () => {
        // What an entry row's "changed" signal has to say: this box changed, the one next
        // to it did not.
        assertDeepEqual(replaceAt([A, B], 1, { url: 'https://new.example/' }),
            [A, { label: 'B', url: 'https://new.example/' }]);
        assertDeepEqual(replaceAt([A, B], 0, { label: 'Renamed' }),
            [{ label: 'Renamed', url: 'https://a.example/' }, B]);
    });

    test('a row can be edited into an invalid state, and stays on the list', () => {
        // Someone typing "https://meet." is not making an error, they are typing. The row
        // has to survive the intermediate states or the box empties itself as you use it.
        const list = replaceAt([A], 0, { url: 'https://meet.' });
        assertEqual(list.length, 1);
        assertEqual(list[0].url, 'https://meet.');
    });

    test('an index or a patch that makes no sense changes nothing', () => {
        for (const index of [-1, 2, null])
            assertDeepEqual(replaceAt([A, B], index, { label: 'x' }), [A, B]);
        for (const patch of [null, undefined, 'x', 42])
            assertDeepEqual(replaceAt([A, B], 0, patch), [A, B]);
    });

    test('it does not mutate', () => {
        const before = [{ ...A }];
        replaceAt(before, 0, { label: 'Changed' });
        assertEqual(before[0].label, 'A');
    });
});

suite('reordering', () => {
    test('the menu is the order you set, so a row can be moved', () => {
        assertDeepEqual(moveAt([A, B, C], 2, 0).map(d => d.label), ['C', 'A', 'B']);
        assertDeepEqual(moveAt([A, B, C], 0, 2).map(d => d.label), ['B', 'C', 'A']);
    });

    test('moving the first row up does nothing, rather than something else', () => {
        // Clamping an out-of-range move would quietly reorder a different pair, which is
        // worse than the button doing nothing.
        assertDeepEqual(moveAt([A, B, C], 0, -1), [A, B, C]);
        assertDeepEqual(moveAt([A, B, C], 2, 3), [A, B, C]);
        assertDeepEqual(moveAt([A, B, C], 1, 1), [A, B, C]);
    });

    test('it does not mutate', () => {
        const before = [A, B];
        moveAt(before, 0, 1);
        assertDeepEqual(before.map(d => d.label), ['A', 'B']);
    });
});

suite('restoring the defaults', () => {
    test('gives back the two shipped destinations, in their order', () => {
        assertDeepEqual(restoreDefaults().map(d => d.label), ['Meet next', 'Meet']);
    });

    test('gives back a copy that can be edited', () => {
        // Handing out the frozen constant would make the first keystroke after a restore
        // throw, in the preferences window, in a GTK signal handler.
        const list = restoreDefaults();
        list[0].label = 'Edited';
        assertEqual(DEFAULT_DESTINATIONS[0].label, 'Meet next',
            'restoring handed out the frozen constant itself');
        for (const row of restoreDefaults())
            assert(!Object.isFrozen(row), 'a restored row is frozen');
    });

    test('a restored list is recognised as the default one', () => {
        assertEqual(isDefault(restoreDefaults()), true);
        assertEqual(isDefault(removeAt(restoreDefaults(), 0)), false);
        assertEqual(isDefault(addDestination(restoreDefaults(), A)), false);
        assertEqual(isDefault(replaceAt(restoreDefaults(), 0, { label: 'Nope' })), false);
        assertEqual(isDefault(moveAt(restoreDefaults(), 0, 1)), false,
            'a reordered list is not the default list');
        assertEqual(isDefault([]), false);
        assertEqual(isDefault('not a list'), false);
    });
});

suite('what the window complains about', () => {
    test('a blank row is unfinished, not wrong', () => {
        // Shouting at someone the instant they press Add is not a preferences window.
        assertDeepEqual(listProblems(addDestination([])), []);
        assertEqual(isBlank({ label: '', url: 'https://' }), true);
        assertEqual(isBlank({ label: '', url: '' }), true);
        assertEqual(isBlank({ label: '  ', url: '  ' }), true);
        assertEqual(isBlank({ label: 'Named', url: 'https://' }), false);
        assertEqual(isBlank({ label: '', url: 'https://x.example/' }), false);
    });

    test('a row that is wrong is reported against its own index', () => {
        const problems = listProblems([A, { label: 'Bad', url: 'http://x.example/' }, C]);
        assertEqual(problems.length, 1);
        assertEqual(problems[0].index, 1);
        assert(problems[0].problem.includes('https'), problems[0].problem);
    });

    test('a named row with no address is reported, because it will never open', () => {
        const problems = listProblems([{ label: 'Standup', url: 'https://' }]);
        assertEqual(problems.length, 1);
        assertEqual(problems[0].index, 0);
    });

    test('the shipped defaults have nothing wrong with them', () => {
        assertDeepEqual(listProblems(restoreDefaults()), []);
    });
});

suite('what reaches the setting', () => {
    test('a half-typed row is kept on screen and left out of dconf', () => {
        // The two halves of the same decision: the window holds the working list, and only
        // valid entries are committed. That is why editing and storage are separate.
        const working = addDestination([A]);
        assertEqual(working.length, 2, 'the blank row was dropped from the window');
        assertDeepEqual(toPairs(working), [['A', 'https://a.example/']]);
    });

    test('an emptied list commits as empty, not as the defaults', () => {
        assertDeepEqual(toPairs([]), []);
    });
});

suite('an instance carries its API key through an edit', () => {
    const keyed = { label: 'Work', url: 'https://meet.example.org/', apiKey: 'the-key' };

    test('a row added with a key keeps it', () => {
        assertEqual(addDestination([], keyed)[0].apiKey, 'the-key');
    });

    test('a row added without one does not grow an empty key field', () => {
        // The difference matters: a missing apiKey means "we do not know this instance's
        // key", and an empty one means "the user cleared it". See keyUpdates.
        assert(!('apiKey' in addDestination([])[0]), 'a blank row carries an apiKey');
        assert(!('apiKey' in addDestination([], { label: 'A', url: 'https://a.example/' })[0]));
    });

    test('renaming an instance does not forget its key', () => {
        assertEqual(replaceAt([keyed], 0, { label: 'Renamed' })[0].apiKey, 'the-key');
    });

    test('repointing an instance does not forget its key either', () => {
        // The key moves with it: keyUpdates stores it under the new URL and clears the old.
        const moved = replaceAt([keyed], 0, { url: 'https://moved.example/' })[0];
        assertEqual(moved.apiKey, 'the-key');
        assertEqual(moved.url, 'https://moved.example/');
    });

    test('typing a new key replaces the old one', () => {
        assertEqual(replaceAt([keyed], 0, { apiKey: 'a-newer-key' })[0].apiKey, 'a-newer-key');
    });

    test('emptying the key field is kept as an empty string, not dropped', () => {
        const cleared = replaceAt([keyed], 0, { apiKey: '' })[0];
        assert('apiKey' in cleared, 'the cleared field was dropped, which reads as unknown');
        assertEqual(cleared.apiKey, '');
    });

    test('a row whose key was never loaded is not given one by an unrelated edit', () => {
        const unknown = { label: 'Work', url: 'https://meet.example.org/' };
        assert(!('apiKey' in replaceAt([unknown], 0, { label: 'Renamed' })[0]),
            'an edit invented an apiKey, which would clear a key nobody touched');
    });

    test('moving a row moves its key with it', () => {
        const list = [keyed, { label: 'Other', url: 'https://b.example/' }];
        assertEqual(moveAt(list, 0, 1)[1].apiKey, 'the-key');
    });

    test('a key never reaches the setting, which is the point of the keyring', () => {
        assertDeepEqual(toPairs([keyed]), [['Work', 'https://meet.example.org/']]);
    });

    test('a keyed default pair is still the default list, so restore stays greyed out', () => {
        const defaults = restoreDefaults().map(d => ({ ...d, apiKey: 'k' }));
        assert(isDefault(defaults), 'adding a key made the shipped list look edited');
    });

    test('restoring the defaults claims nothing about any key', () => {
        // Restoring the instance list must not delete the keys for the same two URLs, and
        // an absent apiKey is what tells keyUpdates to leave them alone.
        for (const row of restoreDefaults())
            assert(!('apiKey' in row), 'restoreDefaults invented an apiKey');
    });
});
