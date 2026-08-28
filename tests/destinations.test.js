// The destinations are the whole of what this extension knows: a label and a URL, twice
// over to begin with and as many times as you like after that. They live in GSettings as an
// `a(ss)`, which means every one of them arrives from outside — from dconf, from a
// hand-edited gsettings call, from a preferences window mid-edit — and any of them can be
// nonsense. So the rules about what counts as a destination are pinned here rather than
// discovered in the compositor.

import { suite, test, assert, assertEqual, assertDeepEqual } from './harness.js';
import {
    DEFAULT_DESTINATIONS, parseDestinations, toPairs, destinationProblem,
} from '../src/lib/destinations.js';

suite('the destinations shipped by default', () => {
    test('there are exactly two, and Meet next leads', () => {
        // The order is the idea text's order, and it is not alphabetical or arbitrary:
        // "Meet next" is the one being tried out, so it goes first.
        assertDeepEqual(DEFAULT_DESTINATIONS.map(d => d.label), ['Meet next', 'Meet']);
    });

    test('they point where the idea says they point', () => {
        assertDeepEqual(DEFAULT_DESTINATIONS.map(d => d.url), [
            'https://meet-next.openvidu.io/',
            'https://meet.openvidu.io/',
        ]);
    });

    test('every one of them survives its own validator', () => {
        for (const destination of DEFAULT_DESTINATIONS) {
            assertEqual(destinationProblem(destination), null,
                `the default ${destination.label} is rejected by our own rules`);
        }
    });

    test('they cannot be edited through the exported constant', () => {
        // A caller that mutated this would change what "restore the defaults" restores, in
        // a way that survives until the shell is restarted.
        assert(Object.isFrozen(DEFAULT_DESTINATIONS), 'the array is not frozen');
        for (const destination of DEFAULT_DESTINATIONS)
            assert(Object.isFrozen(destination), `${destination.label} is not frozen`);
    });
});

suite('what counts as a destination', () => {
    const good = { label: 'Meet', url: 'https://meet.openvidu.io/' };

    test('a label and an absolute https URL', () => {
        assertEqual(destinationProblem(good), null);
    });

    test('a self-hosted deployment is a destination too', () => {
        // The reason this setting is configurable at all: someone else's OpenVidu.
        assertEqual(destinationProblem({ label: 'Ours', url: 'https://vc.example.org/room/1' }),
            null);
    });

    test('http is refused, because the panel must not downgrade anyone', () => {
        const problem = destinationProblem({ ...good, url: 'http://meet.openvidu.io/' });
        assert(problem !== null, 'http was accepted');
        assert(problem.includes('https'), `the problem does not mention https: ${problem}`);
    });

    test('a scheme that is not the web at all is refused', () => {
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.org/']) {
            assert(destinationProblem({ ...good, url }) !== null,
                `${url} was accepted as a destination`);
        }
    });

    test('a relative or schemeless URL is refused rather than guessed at', () => {
        for (const url of ['meet.openvidu.io', '/room/1', '//meet.openvidu.io/', '']) {
            assert(destinationProblem({ ...good, url }) !== null,
                `${JSON.stringify(url)} was accepted as a destination`);
        }
    });

    test('https with no host is refused', () => {
        assert(destinationProblem({ ...good, url: 'https:///room' }) !== null,
            'a URL with no host was accepted');
    });

    test('an empty or blank label is refused, because it would be an unclickable menu item', () => {
        for (const label of ['', '   ', '\t']) {
            assert(destinationProblem({ ...good, label }) !== null,
                `${JSON.stringify(label)} was accepted as a label`);
        }
    });

    test('anything that is not a pair of strings is refused rather than thrown over', () => {
        for (const value of [null, undefined, 'https://meet.openvidu.io/', 42, {},
            { label: 'x' }, { url: 'https://x.example/' }, { label: 1, url: 2 }])
            assert(destinationProblem(value) !== null, `${JSON.stringify(value)} was accepted`);
    });
});

suite('reading destinations out of settings', () => {
    test('the GSettings shape becomes a list of objects', () => {
        assertDeepEqual(
            parseDestinations([['Meet next', 'https://meet-next.openvidu.io/'],
                ['Meet', 'https://meet.openvidu.io/']]),
            [{ label: 'Meet next', url: 'https://meet-next.openvidu.io/' },
                { label: 'Meet', url: 'https://meet.openvidu.io/' }]);
    });

    test('order is kept, because the menu is the order you set', () => {
        const labels = parseDestinations([['C', 'https://c.example/'],
            ['A', 'https://a.example/'], ['B', 'https://b.example/']]).map(d => d.label);
        assertDeepEqual(labels, ['C', 'A', 'B']);
    });

    test('surrounding whitespace is trimmed off both parts', () => {
        assertDeepEqual(parseDestinations([['  Meet  ', ' https://meet.openvidu.io/ ']]),
            [{ label: 'Meet', url: 'https://meet.openvidu.io/' }]);
    });

    test('an entry that fails the rules is dropped, and the rest still work', () => {
        // Dropped rather than thrown on: one bad row in dconf must not cost you the menu.
        assertDeepEqual(
            parseDestinations([['Bad', 'http://insecure.example/'],
                ['Good', 'https://good.example/'],
                ['', 'https://nameless.example/']]),
            [{ label: 'Good', url: 'https://good.example/' }]);
    });

    test('an empty list stays empty rather than quietly becoming the defaults', () => {
        // Removing every entry is a thing a user can do, and the menu has to say so
        // instead of putting back what they just deleted.
        assertDeepEqual(parseDestinations([]), []);
    });

    test('garbage in the setting produces an empty list, not an exception', () => {
        for (const value of [null, undefined, 'nonsense', 42, {}])
            assertDeepEqual(parseDestinations(value), [], `${JSON.stringify(value)} threw or leaked`);
        assertDeepEqual(parseDestinations([null, 'x', [], ['only-one'], ['a', 'b', 'c']]), []);
    });

    test('a row of three is not silently truncated into a destination', () => {
        // ('a','b','c') cannot come from an a(ss), but it can come from a test double or a
        // hand-written variant, and taking the first two would invent a destination.
        assertDeepEqual(parseDestinations([['Meet', 'https://meet.openvidu.io/', 'extra']]), []);
    });
});

suite('writing destinations back to settings', () => {
    test('a list of objects becomes the GSettings shape', () => {
        assertDeepEqual(toPairs([{ label: 'Meet', url: 'https://meet.openvidu.io/' }]),
            [['Meet', 'https://meet.openvidu.io/']]);
    });

    test('the defaults round-trip through settings unchanged', () => {
        assertDeepEqual(parseDestinations(toPairs(DEFAULT_DESTINATIONS)),
            DEFAULT_DESTINATIONS.map(d => ({ label: d.label, url: d.url })));
    });

    test('an invalid entry never reaches the setting', () => {
        // The preferences window can hold a half-typed URL; dconf should not.
        assertDeepEqual(toPairs([{ label: 'Meet', url: 'https://meet.openvidu.io/' },
            { label: 'Half typed', url: 'https:/' }]),
            [['Meet', 'https://meet.openvidu.io/']]);
    });
});
