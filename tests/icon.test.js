// The icon is tested as an image, not as a path.
//
// A file that is present but unloadable is the bug that otherwise ships unnoticed: GNOME
// falls back to a generic square, says nothing in the log, and the extension looks broken
// to everyone but the person who packaged it. So this rasterises the shipped SVG through
// the same GdkPixbuf/librsvg pair the shell draws it with, at the sizes a panel actually
// asks for, and looks at the pixels that come out.

import GdkPixbuf from 'gi://GdkPixbuf';

import { suite, test, assert, assertEqual } from './harness.js';
import { readFile, listFiles, repoPath } from './util.js';
import { PANEL_ICON, panelIconPath } from '../src/lib/icon.js';

const ICON_PATH = panelIconPath(repoPath('src'));

/** Rasterise at the size a panel would ask for, and describe what came out. */
function raster(size) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(ICON_PATH, size, size, true);
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const rowstride = pixbuf.get_rowstride();

    let inked = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const offset = y * rowstride + x * channels;
            // Symbolic icons are one colour over transparency, so alpha is the ink.
            const alpha = channels === 4 ? pixels[offset + 3] : 255;
            if (alpha > 128)
                inked++;
        }
    }

    return {
        pixbuf,
        width: pixbuf.get_width(),
        height: pixbuf.get_height(),
        inkFraction: inked / (pixbuf.get_width() * pixbuf.get_height()),
    };
}

suite('the panel icon is an image the shell can draw', () => {
    test('it decodes at the panel size', () => {
        const { width, height } = raster(16);
        assertEqual(width, 16);
        assertEqual(height, 16);
    });

    test('it decodes at HiDPI, where the shell asks for twice as many pixels', () => {
        // A raster icon would be a blur here. An SVG has no excuse.
        const { width, height } = raster(32);
        assertEqual(width, 32);
        assertEqual(height, 32);
    });

    test('there is something drawn, and it is not a solid block', () => {
        // Both halves matter. Nothing drawn is an empty panel button; everything drawn is
        // a black rectangle, which is what a broken path or a bad fill-rule produces and
        // which no eye reviewing a diff would catch.
        for (const size of [16, 24, 32, 48]) {
            const { inkFraction } = raster(size);
            assert(inkFraction > 0.15,
                `at ${size}px only ${(inkFraction * 100).toFixed(1)}% of the icon is drawn`);
            assert(inkFraction < 0.85,
                `at ${size}px ${(inkFraction * 100).toFixed(1)}% of the icon is drawn — ` +
                'that is a filled block, not a drawing');
        }
    });

    test('the play triangle is a hole, not a filled shape', () => {
        // The evenodd fill-rule is what makes the triangle transparent. Lose it and the
        // front bubble becomes a plain rounded rectangle: still an icon, still loads, and
        // no longer says "video call". Sampled where the triangle's middle is, at a size
        // big enough for one pixel to mean something.
        const { pixbuf } = raster(64);
        const pixels = pixbuf.get_pixels();
        const channels = pixbuf.get_n_channels();
        const rowstride = pixbuf.get_rowstride();
        const at = (x, y) => pixels[y * rowstride + x * channels + 3];

        // The triangle spans roughly x 8.3–12.3, y 6.7–10.3 of a 16-wide viewBox: at 64px
        // that is x 33–49, y 27–41, and its middle is comfortably inside.
        assert(at(38, 34) < 128, 'the middle of the play triangle is filled in');
        // ... while the bubble around it is not a hole.
        assert(at(56, 34) > 128, 'the front bubble is not drawn where it should be');
    });

    test('the two bubbles are separate — the back one is not swallowed by the front', () => {
        // The gap between them is what reads as one bubble being behind the other. If the
        // back band ever grows into the front bubble the icon becomes an undifferentiated
        // blob at 16px, which is exactly the failure this icon was drawn to avoid.
        const { pixbuf } = raster(64);
        const pixels = pixbuf.get_pixels();
        const channels = pixbuf.get_n_channels();
        const rowstride = pixbuf.get_rowstride();
        const at = (x, y) => pixels[y * rowstride + x * channels + 3];

        // The back bubble's left edge, at x ≈ 1.7 of 16 → 7 of 64.
        assert(at(7, 20) > 128, 'the back bubble has no left edge');
        // The gap the answered question is about: between the back band's cut end and the
        // front bubble's top edge, around y ≈ 3.8 of 16 → 15 of 64.
        assert(at(40, 15) < 128, 'there is no gap between the two bubbles');
    });
});

suite('the icon is shipped the way a symbolic icon has to be', () => {
    const source = readFile('src', 'icons', `${PANEL_ICON}.svg`);

    test('nothing precedes the root element', () => {
        // gdk-pixbuf refuses an SVG with a comment before <svg>, and GNOME then shows a
        // fallback with nothing in the log to say why. Costs one assertion; has cost a
        // sibling idea an afternoon.
        const beforeRoot = source.slice(0, source.indexOf('<svg'));
        assert(!beforeRoot.includes('<!--'),
            'there is an XML comment before <svg>, which gdk-pixbuf will not load');
    });

    test('it is named -symbolic, which is what makes GTK recolour it', () => {
        assert(PANEL_ICON.endsWith('-symbolic'), PANEL_ICON);
        assert(listFiles('src', 'icons').includes(`${PANEL_ICON}.svg`),
            `src/icons does not contain ${PANEL_ICON}.svg`);
    });

    test('filled shapes only — GTK recolours by forcing a fill, and a stroke survives it', () => {
        assert(!/\bstroke\s*=/.test(source), 'the icon uses a stroke, which will not recolour');
        assert(!/stroke\s*:/.test(source), 'the icon uses a stroke, which will not recolour');
    });

    test('one colour, so there is nothing for the theme to fight with', () => {
        const fills = new Set([...source.matchAll(/fill="([^"]+)"/g)]
            .map(match => match[1])
            .filter(value => value !== 'none'));
        assertEqual(fills.size, 1, `the icon uses ${fills.size} fill colours: ${[...fills]}`);
    });

    test('it declares the 16-unit viewBox a panel icon is drawn on', () => {
        assert(source.includes('viewBox="0 0 16 16"'),
            'the icon is not on the 16x16 grid symbolic icons are designed for');
    });

    test('it carries none of OpenVidu\'s artwork, and says so', () => {
        // The answered open question: the mark may not be redistributed. This is the file
        // where someone would be tempted to paste it back in.
        assert(source.includes('not OpenVidu\'s logo'),
            'the provenance note is gone from the icon');
        assert(!/<image\b/.test(source), 'the icon embeds a bitmap');
        assert(!/base64/.test(source), 'the icon embeds encoded data');
    });

    test('the extension and the test agree on where it lives', () => {
        assertEqual(panelIconPath('/x'), '/x/icons/openvidu-meet-symbolic.svg');
    });
});
