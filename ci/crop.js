#!/usr/bin/env -S gjs -m
//
// Trim the full-screen captures the smoke-test driver takes down to the part a reader cares
// about. The shell screenshots a whole 1280x1024 virtual monitor; a panel button 28 pixels
// wide in the corner of that is not a screenshot of anything.
//
//     gjs -m ci/crop.js screenshots
//
// The regions are fixed because the layout is: the panel is at the top, the button is in
// the right-hand box, and the menu opens directly underneath it. Anything that moves them
// will be obvious in the result, which is the point of committing the images.

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

const CROPS = [
    // The button among its neighbours, tripled: it is 28 pixels wide on purpose, and 28
    // pixels in a README is useless. Its neighbours are in frame deliberately — "the same
    // visual weight as the icons beside it" is a claim a reader should be able to check.
    { name: 'panel.png', x: 1130, y: 0, width: 150, height: 34, scale: 3 },
    // The open menu, with the button it hangs from still in frame.
    { name: 'menu.png', x: 1040, y: 0, width: 240, height: 190, scale: 2 },
    // preferences.png is left alone: it is a window, and a window in its desktop is a fair
    // picture of a window.
];

const dir = ARGV[0];
if (!dir) {
    printerr('usage: gjs -m ci/crop.js <screenshots-dir>');
    imports.system.exit(2);
}

for (const crop of CROPS) {
    const path = GLib.build_filenamev([dir, crop.name]);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
        printerr(`no ${path} to crop`);
        imports.system.exit(1);
    }

    const full = GdkPixbuf.Pixbuf.new_from_file(path);
    // Idempotent: an image already smaller than the crop was cropped by an earlier run, and
    // cropping it again would take a slice of a slice.
    if (full.get_width() <= crop.x || full.get_height() <= crop.y) {
        print(`${crop.name} is already cropped (${full.get_width()}x${full.get_height()})`);
        continue;
    }
    const width = Math.min(crop.width, full.get_width() - crop.x);
    const height = Math.min(crop.height, full.get_height() - crop.y);
    let out = full.new_subpixbuf(crop.x, crop.y, width, height);
    if (crop.scale !== 1) {
        out = out.scale_simple(width * crop.scale, height * crop.scale,
            GdkPixbuf.InterpType.BILINEAR);
    }
    out.savev(path, 'png', [], []);
    print(`cropped ${crop.name} to ${out.get_width()}x${out.get_height()}`);
}
