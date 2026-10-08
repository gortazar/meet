// Packaging metadata is checked by a test because a mistake in it is invisible until the
// shell refuses to load the extension — or until extensions.gnome.org rejects the upload.

import { suite, test, assert, assertEqual } from './harness.js';
import { readJSON, readFile } from './util.js';

export const UUID = 'meet@meet-gs.patxi';

suite('metadata.json', () => {
    test('carries every field extensions.gnome.org requires', () => {
        const meta = readJSON('src', 'metadata.json');
        for (const field of ['uuid', 'name', 'description', 'shell-version', 'url']) {
            assert(field in meta, `missing "${field}"`);
            const value = meta[field];
            const empty = Array.isArray(value) ? value.length === 0 : value === '';
            assert(!empty, `"${field}" is empty`);
        }
    });

    test('uuid matches the one the flake packs and the installer unpacks into', () => {
        assertEqual(readJSON('src', 'metadata.json').uuid, UUID);
    });

    test('declares the shell versions the sibling GNOME ideas support', () => {
        // The same range as pwgen and recap-gs: one fleet, one answer to "does it run here".
        const versions = readJSON('src', 'metadata.json')['shell-version'];
        for (const v of ['46', '47', '48', '49', '50'])
            assert(versions.includes(v), `shell-version is missing ${v}`);
    });

    test('points at this repository, which is where the review links land', () => {
        assertEqual(readJSON('src', 'metadata.json').url, 'https://github.com/gortazar/meet');
    });

    test('carries a version-name, and it is the idea version', () => {
        // The one file a person opens to answer "what am I running", and the one the
        // Extensions app reads to show a version against the entry. A literal, because the
        // upstream suite cannot see STATUS.md — that lives in the workshop repo. What ties
        // the two together is the wrapper's check-pin.sh, which compares STATUS.md against
        // this key in the *pinned* commit.
        assertEqual(readJSON('src', 'metadata.json')['version-name'], '0.4');
    });

    test('the version has the two-component shape this project versions by', () => {
        // So `0.4.0` or `v0.4` fail here, by name, rather than at tag time when the release
        // workflow compares them and refuses — which is the slower way to find out.
        const version = readJSON('src', 'metadata.json')['version-name'];
        assert(/^\d+\.\d+$/.test(version),
            `version-name is "${version}", which is not <major>.<minor>`);
    });

    test('has no version key, which the Shell assigns and EGO rejects by hand', () => {
        // version is the integer extensions.gnome.org sets on upload; setting it by hand is
        // a rejection. It is an easy slip while editing this very object, so it is pinned.
        assertEqual(readJSON('src', 'metadata.json').version, undefined);
    });

    test('ships the licence the packed zip is required to carry', () => {
        // GPL-2.0-or-later is what extensions.gnome.org expects, and a LICENSE that went
        // missing from src/ is a rejection nobody notices until upload day.
        const licence = readFile('src', 'LICENSE');
        assert(licence.includes('GNU GENERAL PUBLIC LICENSE'),
            'src/LICENSE is not the GPL text');
        assert(licence.includes('Version 2, June 1991'),
            'src/LICENSE is not version 2, which is what the extension declares');
    });
});
