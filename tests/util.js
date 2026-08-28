// Helpers shared by the test suites: locating the checkout and reading what it ships.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * The repository root, derived from this file's own location rather than the working
 * directory, so the suite runs the same from anywhere and from the nix store.
 */
export function rootDir() {
    const here = GLib.filename_from_uri(import.meta.url)[0];
    return GLib.path_get_dirname(GLib.path_get_dirname(here));
}

export function readFile(...parts) {
    const path = GLib.build_filenamev([rootDir(), ...parts]);
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`could not read ${path}`);
    return new TextDecoder().decode(bytes);
}

export function readJSON(...parts) {
    return JSON.parse(readFile(...parts));
}

/** The names of the files in a directory of the checkout, sorted. */
export function listFiles(...parts) {
    const dir = Gio.File.new_for_path(GLib.build_filenamev([rootDir(), ...parts]));
    const names = [];
    const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = iter.next_file(null)) !== null)
        names.push(info.get_name());
    names.sort();
    return names;
}

/** An absolute path inside the checkout. */
export function repoPath(...parts) {
    return GLib.build_filenamev([rootDir(), ...parts]);
}
