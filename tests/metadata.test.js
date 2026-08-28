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
