// The installer, the README and the release workflow all name the same three things: this
// repository, the uuid, and the asset the release carries. Nothing enforces that but a
// test, and every one of the ways they can drift is silent until someone tries to install
// it — which is the one moment nobody is watching.

import { suite, test, assert, assertEqual } from './harness.js';
import { readFile, readJSON } from './util.js';

const UUID = readJSON('src', 'metadata.json').uuid;
const ASSET = `${UUID}.shell-extension.zip`;
const REPO = 'gortazar/meet';
const INSTALL_COMMAND =
    `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`;

suite('the installer', () => {
    const installer = readFile('install.sh');

    test('unpacks into the uuid the extension actually declares', () => {
        // Install into the wrong directory name and the shell simply never sees it: no
        // error, no button, nothing in the log.
        assert(installer.includes(`UUID="${UUID}"`),
            `install.sh does not install into ${UUID}`);
    });

    test('downloads the asset the release workflow publishes', () => {
        assert(installer.includes('ASSET="$UUID.shell-extension.zip"'),
            'install.sh asks for a differently named asset');
        assertEqual(ASSET, `${UUID}.shell-extension.zip`);
    });

    test('it downloads from this repository, not a sibling idea\'s', () => {
        assert(installer.includes(`REPO="\${REPO:-${REPO}}"`),
            `install.sh does not default to ${REPO}`);
    });

    test('it checks what it downloaded against the published checksum', () => {
        // The failure it exists to catch is a truncated download, which otherwise shows up
        // much later as an extension that will not load.
        assert(installer.includes('sha256sum -c'), 'install.sh verifies nothing');
        assert(installer.includes(`$ASSET.sha256`), 'install.sh does not fetch a checksum');
    });

    test('it builds nothing and needs no root', () => {
        for (const needle of ['sudo', 'make', 'nix build', 'npm install']) {
            assert(!installer.includes(needle),
                `install.sh uses ${needle} — "clone it and build" is not an install method`);
        }
    });

    test('it installs under the user\'s own data directory', () => {
        assert(installer.includes('${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions'),
            'install.sh does not install into the per-user extensions directory');
    });

    test('it recompiles the schema, so the preferences open', () => {
        assert(installer.includes('glib-compile-schemas'),
            'install.sh never compiles the settings schema');
    });
});

suite('the README', () => {
    const readme = readFile('README.md');

    test('it opens with the install command, before anything about development', () => {
        assert(readme.includes(INSTALL_COMMAND),
            'the README does not carry the one-line install command');
        assert(readme.indexOf(INSTALL_COMMAND) < readme.indexOf('nix develop'),
            'the development instructions come before the install command');
    });

    test('every screenshot it references is committed', () => {
        const referenced = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
        assert(referenced.length >= 3,
            `the README shows ${referenced.length} images; the panel, the menu and the ` +
            'preferences are all worth seeing');
        for (const path of referenced) {
            // readFile throws if it is not there, which is the assertion.
            readFile(...path.split('/'));
        }
    });

    test('it names the uuid someone needs to open the preferences', () => {
        assert(readme.includes(UUID), 'the README never says the uuid');
    });
});

suite('the release workflow', () => {
    const release = readFile('.github', 'workflows', 'release.yml');

    test('it runs the checks before publishing anything', () => {
        // A release that fails its own tests is worse than no release.
        assert(release.indexOf('nix flake check') < release.indexOf('gh release create'),
            'the release is created before the checks run');
    });

    test('it publishes a checksum beside the asset, which the installer looks for', () => {
        assert(release.includes('sha256sum'),
            'nothing publishes the checksum install.sh tries to verify against');
    });

    test('its release notes give the same install command as the README', () => {
        assert(release.includes(INSTALL_COMMAND),
            'the release notes tell people to install some other way');
    });

    test('it fires on a version tag, which is what the version in STATUS.md becomes', () => {
        assert(release.includes('tags: ["v*"]'), 'the release workflow has no tag trigger');
    });
});
