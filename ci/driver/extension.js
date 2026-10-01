// The smoke-test driver. Test-only: it is installed into the throwaway home that
// ci/smoke-test.sh builds, and never into anyone's session and never into the packed zip.
//
// It exists because the things most worth knowing about a panel extension cannot be asked
// of it outside a compositor:
//
//   1. does it load, and does a button appear with the icon actually *drawn* — not the
//      blank square GNOME silently substitutes for an icon it cannot rasterise?
//   2. does the menu hold the rooms, and does clicking one really reach the desktop's
//      default handler for https?
//   3. does a room row draw a join button that a keyboard can reach, and does pressing it
//      hand the *role link, secret and all* to the browser?
//   4. does disabling it leave anything behind?
//
// What is real here and what is not, stated plainly because it matters:
//
//   * The **no-key** and **unreachable** states are end to end. The keyring is a real
//     gnome-keyring-daemon on the session bus, and the unreachable instance is a real
//     libsoup request to a real closed port.
//   * The **rooms** and **refused** states have their room state injected into the
//     indicator, and only that. The payload is still parsed by the extension's own
//     parseRooms, the rows are real widgets in a real shell, and the click goes through the
//     real launcher to the real default handler. What is skipped is the HTTP response
//     itself — because the extension refuses anything but https, a stub instance would need
//     a certificate this machine trusts, and glib-networking honours no environment
//     override for its trust anchors. Every branch of readRoomsResponse is covered
//     exhaustively by the headless suite instead.
//
// Everything it learns is written to $MEET_DRIVER_RESULT as JSON, and then the shell is
// asked to quit. The script that started the shell reads that file and decides.

import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const TARGET = 'meet@meet-gs.patxi';
const CYCLES = 5;

/**
 * An instance nothing is listening on, for the unreachable state.
 *
 * Port 1 cannot be bound without root, so connect() is refused immediately and
 * deterministically — no waiting out the request timeout to learn what we already know.
 */
const DEAD_INSTANCE = 'https://127.0.0.1:1/';

/** An obviously fake secret. The real thing is a credential; this is a test fixture. */
const FAKE_SECRET = 'not-a-real-secret-0000';

/** A canned payload in the shape the OpenVidu Meet REST API documents. */
const CANNED_ROOMS = [
    {
        roomId: 'weekly-sync-001',
        roomName: 'Weekly sync',
        owner: 'admin',
        creationDate: 1620000200000,
        status: 'open',
        access: {
            anonymous: {
                moderator: {
                    enabled: true,
                    url: `https://meet.example.org/room/weekly-sync-001?secret=${FAKE_SECRET}`,
                },
                speaker: {
                    enabled: true,
                    url: 'https://meet.example.org/room/weekly-sync-001?secret=speaker-0000',
                },
            },
            user: { enabled: false, url: 'https://meet.example.org/room/weekly-sync-001' },
        },
    },
    {
        roomId: 'retro-002',
        roomName: 'Retro',
        owner: 'admin',
        creationDate: 1620000100000,
        status: 'closed',
        access: {
            anonymous: {
                moderator: {
                    enabled: true,
                    url: `https://meet.example.org/room/retro-002?secret=${FAKE_SECRET}-b`,
                },
            },
        },
    },
    {
        // A room whose link the instance withheld — real, and documented: the url is
        // "present only when the caller holds the roomShareAccessLinks permission".
        roomId: 'no-link-003',
        roomName: 'Hidden link',
        owner: 'admin',
        creationDate: 1620000000000,
        status: 'open',
        access: { anonymous: { moderator: { enabled: true } } },
    },
];

const INSTANCE_URL = 'https://meet.example.org/';

/** What the icon file is called once installed. Kept literal: the point is to catch a
 *  rename that reaches the extension and not the package. */
const ICON_FILE = 'openvidu-meet-symbolic.svg';

// Module scope, because the shell can enable an extension more than once in a session and
// this driver is a script that must run exactly once: keeping the record and the "already
// started" flag out of the instance means a second enable() cannot quietly begin a second
// run, nor throw away the first one's findings.
const results = { checks: [], failures: [] };
let started = false;

// ExtensionState, as the shell numbers it.
const STATE_ACTIVE = 1;
const STATE_DISABLED = 2;

/**
 * Every GLib source the target extension creates while it is enabled, so that one it
 * forgets to remove can be named rather than guessed at. Attribution is by stack: the only
 * frames that matter are the ones in the extension's own files.
 */
class SourceLedger {
    constructor(uuid) {
        this._uuid = uuid;
        this._live = new Map();
        this._patched = false;
    }

    install() {
        if (this._patched)
            return;
        this._patched = true;

        this._realTimeoutSeconds = GLib.timeout_add_seconds;
        this._realTimeout = GLib.timeout_add;
        this._realRemove = GLib.Source.remove;

        const ledger = this;
        GLib.timeout_add_seconds = function (...args) {
            const id = ledger._realTimeoutSeconds.apply(this, args);
            ledger._note(id, 'timeout_add_seconds');
            return id;
        };
        GLib.timeout_add = function (...args) {
            const id = ledger._realTimeout.apply(this, args);
            ledger._note(id, 'timeout_add');
            return id;
        };
        GLib.Source.remove = function (id) {
            ledger._live.delete(id);
            return ledger._realRemove.call(this, id);
        };
    }

    uninstall() {
        if (!this._patched)
            return;
        GLib.timeout_add_seconds = this._realTimeoutSeconds;
        GLib.timeout_add = this._realTimeout;
        GLib.Source.remove = this._realRemove;
        this._patched = false;
    }

    _note(id, how) {
        const stack = new Error().stack ?? '';
        if (stack.includes(this._uuid))
            this._live.set(id, how);
    }

    /** Sources the extension created that are still attached to the main context. */
    leaked() {
        const context = GLib.MainContext.default();
        const leaks = [];
        for (const [id, how] of this._live) {
            if (context.find_source_by_id(id) !== null)
                leaks.push(`${how} #${id}`);
        }
        return leaks;
    }

    forget() {
        this._live.clear();
    }
}

export default class DriverExtension extends Extension {
    enable() {
        this._results = results;
        this._ledger = new SourceLedger(TARGET);
        this._shots = GLib.getenv('MEET_DRIVER_SHOTS');
        this._opened = GLib.getenv('MEET_DRIVER_OPENED');
        this._manager = Main.extensionManager;

        if (started)
            return;
        started = true;

        this._run().catch(e => {
            this._fail('driver', `${e}\n${e.stack}`);
            this._finish();
        });
    }

    disable() {
        this._ledger?.uninstall();
        this._ledger = null;
    }

    async _run() {
        this._ledger.install();

        // A shell that has just started sits in the overview, which is not what anyone's
        // desktop looks like while they glance at the top bar.
        Main.overview.hide();
        await sleep(500);

        // 1. It loads. The shell enables it out of enabled-extensions, the way a real
        // session does — asking for it by hand while the shell is still working through its
        // own startup is a race.
        await this._waitFor(() => indicatorOf() !== null, 25000);

        const state = this._manager.lookup(TARGET)?.state;
        this._check('loads', state === STATE_ACTIVE,
            `extension state is ${state} (${STATE_ACTIVE} is enabled)`);

        const indicator = indicatorOf();
        this._check('adds a panel button', indicator !== null,
            'nothing was added to the status area');
        if (!indicator) {
            this._finish();
            return;
        }

        this._check('the button says what it is',
            indicator.accessible_name === 'OpenVidu Meet',
            `the panel button describes itself as "${indicator.accessible_name}"`);
        this._results.panel = indicator.accessible_name;

        // 2. The icon. Three questions, because "the panel button is there" is not the same
        // as "you can see anything in it": GNOME substitutes a blank for an icon it cannot
        // rasterise, silently, with nothing in the log.
        this._checkIconFile(indicator);
        await this._checkIconDrawn(indicator);

        await this._screenshot('panel.png');

        // 3. The menu holds the rooms, in order, and a way into the preferences.
        indicator.menu.open(false);
        await sleep(700);
        this._check('opens its menu', indicator.menu.isOpen, 'the menu did not open');

        const labels = menuLabels(indicator);
        this._results.menu = labels;
        // Not labels[0] and labels[1] any more: since 0.2 each instance has rows of its own
        // underneath, and with no API key stored those rows say so.
        this._check('the menu lists the two shipped instances, Meet next first',
            labels[0] === 'Meet next' && labels.indexOf('Meet') > 0 &&
            labels.indexOf('Meet next') < labels.indexOf('Meet'),
            `the menu reads ${JSON.stringify(labels)}`);
        this._check('the menu ends with a way into the preferences',
            labels[labels.length - 1] === 'Rooms…',
            `the menu reads ${JSON.stringify(labels)}`);

        await this._screenshot('menu.png');

        // 4. Clicking a room reaches the desktop's default handler. The stub browser
        // registered for x-scheme-handler/https records what it was asked to open, so this
        // is the real Gio.AppInfo path end to end — not a stubbed seam.
        const items = indicator.menu._getMenuItems();
        const meet = items.find(item => item.label?.text === 'Meet');
        this._check('there is a Meet item to activate', meet !== undefined,
            `the menu reads ${JSON.stringify(labels)}`);
        if (meet) {
            activate(meet);
            await this._waitFor(() => this._openedUris().length > 0, 10000);
            const opened = this._openedUris();
            this._results.opened = opened;
            this._check('activating a room asks the default browser to open it',
                opened.includes('https://meet.openvidu.io/'),
                `the stub browser was asked to open ${JSON.stringify(opened)}`);
            this._check('activating a room closes the menu', !indicator.menu.isOpen,
                'the menu was still open after a room was activated');
        }

        // 4b. The rooms of each instance, which is what 0.2 is about.
        await this._checkRooms(indicator);

        // 5. The menu follows the setting. Removing every room is a state a user can reach,
        // and the menu has to say so rather than opening to nothing.
        setDestinations([]);
        await this._waitFor(() => menuLabels(indicator).includes('No rooms yet'), 5000);
        this._check('emptying the rooms leaves a menu that says so',
            menuLabels(indicator).includes('No rooms yet'),
            `with no rooms the menu reads ${JSON.stringify(menuLabels(indicator))}`);
        resetDestinations();
        await this._waitFor(() => menuLabels(indicator)[0] === 'Meet next', 5000);
        this._check('restoring the rooms brings the menu back',
            menuLabels(indicator)[0] === 'Meet next',
            `after a reset the menu reads ${JSON.stringify(menuLabels(indicator))}`);

        // 6. The preferences window opens, in its own process, and is worth a picture.
        if (this._shots) {
            try {
                this._manager.openExtensionPrefs(TARGET, '', {});
                await this._waitFor(() => prefsWindow() !== null, 20000);
                // Opening it is not the same as looking at it: the window arrives behind
                // the overview, and a screenshot then is a screenshot of the wallpaper.
                const window = prefsWindow();
                if (window) {
                    Main.activateWindow(window);
                    Main.overview.hide();
                }
                await sleep(2500); // let it finish drawing itself
                this._check('opens its preferences', prefsWindow() !== null,
                    'no preferences window appeared');
                await this._screenshot('preferences.png');
                prefsWindow()?.delete(global.get_current_time());
                await sleep(500);
            } catch (e) {
                this._check('opens its preferences', false, String(e));
            }
        }

        // 7. Nothing is left behind. Five rounds, because a leak that only happens on the
        // second enable is the interesting kind.
        this._ledger.forget();
        for (let i = 0; i < CYCLES; i++) {
            this._manager.disableExtension(TARGET);
            // Wait for the manager's own bookkeeping, not just for the actor to vanish:
            // asking it to enable an extension it still considers enabled does nothing at
            // all, and the round after that would look like a leak.
            await this._waitFor(() => stateOf() === STATE_DISABLED && indicatorOf() === null,
                15000);
            this._check(`round ${i + 1}: the panel button goes`, indicatorOf() === null,
                `state is ${stateOf()} and the indicator is ${indicatorOf() ? 'still there' : 'gone'}`);

            this._manager.enableExtension(TARGET);
            await this._waitFor(() => indicatorOf() !== null, 15000);
            this._check(`round ${i + 1}: the panel button comes back`, indicatorOf() !== null,
                `state is ${stateOf()} and nothing was added to the status area`);
        }

        this._manager.disableExtension(TARGET);
        await this._waitFor(() => indicatorOf() === null, 5000);
        // Long enough for anything the extension started on its way out to have run.
        await sleep(1000);

        const leaks = this._ledger.leaked();
        this._check('leaves no timer behind', leaks.length === 0,
            `still attached to the main loop: ${leaks.join(', ')}`);
        this._results.cycles = CYCLES;

        this._finish();
    }

    /**
     * Rooms under their instance, the join button, and the states that stand in for rooms.
     *
     * The first two states are end to end; the last two have their room state injected. See
     * the note at the top of this file for exactly where the line is and why it is there.
     */
    async _checkRooms(indicator) {
        const lib = await this._targetLib();
        if (lib === null)
            return;

        // --- no key: real, and the state both shipped instances are in out of the box ---
        resetDestinations();
        await this._reopenMenu(indicator);
        await this._waitFor(
            () => menuLabels(indicator).includes('Add an API key in Rooms…'), 15000);
        this._check('an instance with no API key says so, under its own row',
            menuLabels(indicator).includes('Add an API key in Rooms…'),
            `the menu reads ${JSON.stringify(menuLabels(indicator))}`);

        // --- unreachable: real. A real request, to a real closed port, over real libsoup ---
        const keyStore = await lib.keyring.openKeyStore();
        const dead = { label: 'Dead instance', url: DEAD_INSTANCE };
        const stored = await keyStore.storeKey(dead, 'a-key-that-is-never-accepted');
        this._check('the keyring takes an API key', stored === true,
            'storeKey said no — is gnome-keyring-daemon on this bus?');
        this._check('and reads the same key back',
            await keyStore.lookupKey(DEAD_INSTANCE) === 'a-key-that-is-never-accepted',
            'the key did not survive a round trip through the keyring');

        setDestinations([[dead.label, dead.url]]);
        await this._reopenMenu(indicator);
        await this._waitFor(
            () => menuLabels(indicator).includes(`Could not reach ${dead.label}`), 20000);
        this._check('an instance that cannot be reached says which one',
            menuLabels(indicator).includes(`Could not reach ${dead.label}`),
            `the menu reads ${JSON.stringify(menuLabels(indicator))}`);
        this._check('and its own row still works, so a dead instance costs only its rooms',
            menuLabels(indicator)[0] === dead.label,
            `the menu reads ${JSON.stringify(menuLabels(indicator))}`);

        await keyStore.clearKey(DEAD_INSTANCE);

        // --- rooms: real parsing, real widgets, real click; the response is canned ---
        setDestinations([['Work', INSTANCE_URL]]);
        const rooms = lib.rooms.parseRooms(CANNED_ROOMS, INSTANCE_URL);
        this._check('the canned payload parses into three rooms', rooms.length === 3,
            `parseRooms returned ${rooms.length}`);

        await this._withRoomState(indicator, { [INSTANCE_URL]: { status: 'ok', rooms } });
        const labels = menuLabels(indicator);
        this._results.roomMenu = labels;
        this._check('the rooms are listed under their instance',
            labels[0] === 'Work' && labels.includes('Weekly sync') && labels.includes('Retro'),
            `the menu reads ${JSON.stringify(labels)}`);
        this._check('most recently created first',
            labels.indexOf('Weekly sync') < labels.indexOf('Retro'),
            `the menu reads ${JSON.stringify(labels)}`);
        this._check('a closed room is listed too, as the answered question asks',
            labels.includes('Retro'), `the menu reads ${JSON.stringify(labels)}`);

        await this._screenshot('rooms.png');

        const weekly = roomItem(indicator, 'Weekly sync');
        this._check('there is a room row to join from', weekly !== null,
            `the menu reads ${JSON.stringify(labels)}`);
        if (weekly === null)
            return;

        const button = joinButton(weekly);
        this._check('the room row draws a join button', button !== null,
            'no St.Button among the room row\'s children');
        if (button === null)
            return;

        this._check('the join button says what it joins, to a screen reader',
            button.accessible_name === 'Join Weekly sync',
            `the button calls itself "${button.accessible_name}"`);
        this._check('the join button can take keyboard focus', button.can_focus === true,
            'the button cannot be focused, so it cannot be used without a mouse');

        const hidden = roomItem(indicator, 'Hidden link');
        this._check('a room whose link was withheld is listed with no button',
            hidden !== null && joinButton(hidden) === null,
            'a button was drawn for a room with no vouched-for link');

        // The real path: clicked -> item activated -> launcher -> Gio.AppInfo -> the stub
        // browser registered for x-scheme-handler/https.
        const before = this._openedUris().length;
        // St.Button's 'clicked' carries which pointer button it was; 1 is the primary one.
        button.emit('clicked', 1);
        await this._waitFor(() => this._openedUris().length > before, 10000);
        const opened = this._openedUris().slice(before);
        this._results.joined = opened.map(uri => uri.replace(FAKE_SECRET, '<secret>'));
        this._check('pressing it asks the browser to open the room',
            opened.some(uri => uri.startsWith(`${INSTANCE_URL}room/weekly-sync-001`)),
            `the stub browser was asked to open ${JSON.stringify(this._results.joined)}`);
        // Asserted by presence, never echoed: this is the whole point of the entry, and the
        // same URL without its secret is the room's page rather than the call.
        this._check('and the link it is given is the role link, secret and all',
            opened.some(uri => uri.includes(`secret=${FAKE_SECRET}`)),
            'the browser was handed a link with no secret — that is the room page, not the call');
        this._check('joining a room closes the menu', !indicator.menu.isOpen,
            'the menu was still open after the join button was pressed');

        // --- refused: injected, because a 401 needs a server we cannot give it ---
        await this._withRoomState(indicator, { [INSTANCE_URL]: { status: 'refused' } });
        this._check('a refused API key says the key was refused',
            menuLabels(indicator).includes('That instance refused the API key'),
            `the menu reads ${JSON.stringify(menuLabels(indicator))}`);

        indicator.menu.close(false);
        resetDestinations();
        await sleep(300);
    }

    /**
     * The target extension's own modules, loaded from where they are installed.
     *
     * By path rather than by relative import: this driver is a different extension, and the
     * point is to exercise the code that was packed and installed, not a copy of it.
     */
    async _targetLib() {
        const path = this._manager.lookup(TARGET)?.path;
        if (!path) {
            this._fail('the target extension has a path to import from', 'no path');
            return null;
        }
        try {
            return {
                keyring: await import(`file://${path}/lib/keyring.js`),
                rooms: await import(`file://${path}/lib/rooms.js`),
            };
        } catch (e) {
            this._fail('the installed lib/ modules import', String(e));
            return null;
        }
    }

    /** Close the menu and open it again, which is what triggers a refresh. */
    async _reopenMenu(indicator) {
        indicator.menu.close(false);
        await sleep(300);
        indicator.menu.open(false);
        await sleep(700);
    }

    /**
     * Put a room state into the indicator and redraw.
     *
     * Set after the menu is open, and the menu is left open: opening it is what starts a
     * refresh, and a refresh would overwrite this with the real answer — which for an
     * instance that does not exist is "could not reach it".
     */
    async _withRoomState(indicator, states) {
        indicator.menu.close(false);
        await sleep(300);
        indicator.menu.open(false);
        await sleep(700);
        indicator._roomStates = states;
        indicator._rebuildMenu();
        await sleep(400);
    }

    /** The icon the button was given: ours, at the installed path, and loadable from it. */
    _checkIconFile(indicator) {
        const icon = iconActorOf(indicator);
        this._check('the button holds an icon actor', icon !== null,
            'no St.Icon among the panel button\'s children');
        if (!icon)
            return;

        const gicon = icon.gicon;
        const path = gicon?.get_file?.().get_path?.() ?? '';
        this._check('the icon is the one this extension ships',
            path.endsWith(`/icons/${ICON_FILE}`),
            `the button's icon is ${path || gicon}`);

        // Loaded from the installed location, which is the packed layout rather than the
        // checkout: an icon left out of the zip is a file that exists here and nowhere
        // that matters.
        let loaded = null;
        try {
            loaded = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 16, 16, true);
        } catch (e) {
            this._fail('the installed icon rasterises', String(e));
            return;
        }
        this._check('the installed icon rasterises',
            loaded !== null && loaded.get_width() === 16,
            `the installed icon decoded to ${loaded?.get_width()}x${loaded?.get_height()}`);
    }

    /**
     * The icon is actually *drawn*.
     *
     * The check the headless suite cannot make. An St.Icon over a gicon the shell cannot
     * draw is not an error: it is an empty actor, the right size, in the right place, with
     * nothing in it. So this photographs the panel and counts how much of the icon's own
     * rectangle is not the panel background.
     */
    async _checkIconDrawn(indicator) {
        const icon = iconActorOf(indicator);
        if (!icon)
            return;

        const shot = `${GLib.get_tmp_dir()}/meet-icon-check.png`;
        if (!await this._capture(shot)) {
            this._fail('the icon is drawn, not blank', 'could not photograph the panel');
            return;
        }

        const [x, y] = icon.get_transformed_position();
        const [width, height] = icon.get_transformed_size();
        this._results.iconBox = { x, y, width, height };
        if (!(width > 0 && height > 0)) {
            this._fail('the icon is drawn, not blank',
                `the icon actor is ${width}x${height} — it was never allocated`);
            return;
        }

        const ink = inkFraction(shot, Math.round(x), Math.round(y),
            Math.round(width), Math.round(height));
        this._results.iconInk = ink;
        // A blank icon reads as 0. A solid block — which is what a broken fill-rule or a
        // wrongly-themed fallback square looks like — reads near 1. The drawing sits in
        // between, and it is the in-between that says the shell rendered *this* icon.
        this._check('the icon is drawn, not blank', ink > 0.08,
            `only ${(ink * 100).toFixed(1)}% of the icon's rectangle differs from the panel ` +
            'background — the shell drew nothing there');
        this._check('the icon is a drawing, not a filled square', ink < 0.9,
            `${(ink * 100).toFixed(1)}% of the icon's rectangle is inked`);
    }

    /** What the stub browser has been asked to open so far. */
    _openedUris() {
        if (!this._opened || !GLib.file_test(this._opened, GLib.FileTest.EXISTS))
            return [];
        const [ok, bytes] = GLib.file_get_contents(this._opened);
        if (!ok)
            return [];
        return new TextDecoder().decode(bytes).split('\n').filter(line => line !== '');
    }

    async _screenshot(name) {
        if (!this._shots)
            return;
        const path = `${this._shots}/${name}`;
        const ok = await this._capture(path);
        this._results.checks.push({
            name: `screenshot ${name}`, ok, detail: ok ? '' : 'the capture failed',
        });
    }

    /**
     * Save the whole stage to a PNG.
     *
     * Through Shell.Screenshot rather than the org.gnome.Shell.Screenshot D-Bus method:
     * that method only answers a short list of well-known callers, and a test driver is not
     * one of them. This is the same object the shell's own screenshot service uses.
     */
    async _capture(path) {
        try {
            const Shell = (await import('gi://Shell')).default;
            const stream = Gio.File.new_for_path(path)
                .replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const shooter = new Shell.Screenshot();
            await new Promise((resolve, reject) => {
                shooter.screenshot(false, stream, (source, result) => {
                    try {
                        source.screenshot_finish(result);
                        stream.close(null);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            return true;
        } catch {
            return false;
        }
    }

    _waitFor(predicate, timeoutMs) {
        const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
        return (async () => {
            while (!predicate() && GLib.get_monotonic_time() < deadline)
                await sleep(200);
        })();
    }

    _check(name, ok, detail) {
        this._results.checks.push({ name, ok, detail: ok ? '' : detail });
        if (!ok)
            this._results.failures.push(`${name}: ${detail}`);
    }

    _fail(name, detail) {
        this._check(name, false, detail);
    }

    _finish() {
        const path = GLib.getenv('MEET_DRIVER_RESULT');
        if (path) {
            GLib.file_set_contents(path,
                new TextEncoder().encode(JSON.stringify(this._results, null, 2)));
        }
        this._ledger?.uninstall();
        // The script that started this shell is waiting for it to exit. Mutter has moved
        // the way to ask for that around between 46 and 50, so try both spellings.
        try {
            global.context.terminate();
        } catch {
            Meta.quit(Meta.ExitCode.SUCCESS);
        }
    }
}

/**
 * The fraction of a rectangle of a screenshot that is not the panel background.
 *
 * The panel is near-black and a symbolic icon is recoloured near-white, so luminance
 * separates them cleanly. Sampling a threshold rather than comparing to a reference image
 * keeps this from failing on an antialiasing difference between two GNOME versions.
 */
function inkFraction(pngPath, x, y, width, height) {
    const full = GdkPixbuf.Pixbuf.new_from_file(pngPath);
    const cropWidth = Math.min(width, full.get_width() - x);
    const cropHeight = Math.min(height, full.get_height() - y);
    if (cropWidth <= 0 || cropHeight <= 0)
        return 0;

    const crop = full.new_subpixbuf(x, y, cropWidth, cropHeight);
    const pixels = crop.get_pixels();
    const channels = crop.get_n_channels();
    const rowstride = crop.get_rowstride();

    let inked = 0;
    for (let row = 0; row < cropHeight; row++) {
        for (let column = 0; column < cropWidth; column++) {
            const offset = row * rowstride + column * channels;
            const luminance = (pixels[offset] * 299 + pixels[offset + 1] * 587 +
                pixels[offset + 2] * 114) / 1000;
            if (luminance > 100)
                inked++;
        }
    }
    return inked / (cropWidth * cropHeight);
}

/** The destinations setting, opened against the installed schema. */
function meetSettings() {
    const dir = `${GLib.get_user_data_dir()}/gnome-shell/extensions/${TARGET}/schemas`;
    const source = Gio.SettingsSchemaSource.new_from_directory(dir, null, true);
    const schema = source.lookup('org.gnome.shell.extensions.meet', false);
    return new Gio.Settings({ settings_schema: schema });
}

function setDestinations(pairs) {
    meetSettings().set_value('destinations', new GLib.Variant('a(ss)', pairs));
}

function resetDestinations() {
    meetSettings().reset('destinations');
}

/** Activate a menu item the way a click does. */
function activate(item) {
    try {
        item.activate(null);
    } catch {
        item.emit('activate', null);
    }
}

/** Every label in the menu, in order. Separators have none and are skipped. */
function menuLabels(indicator) {
    try {
        return indicator.menu._getMenuItems()
            .map(item => item.label?.text)
            .filter(text => typeof text === 'string' && text !== '');
    } catch {
        return [];
    }
}

/** The menu item for a room of this name, or null. */
function roomItem(indicator, name) {
    try {
        return indicator.menu._getMenuItems()
            .find(item => item.label?.text === name) ?? null;
    } catch {
        return null;
    }
}

/** The join button inside a room row, or null when the room has no link to join by. */
function joinButton(item) {
    for (const child of item.get_children?.() ?? []) {
        if (child.constructor?.name?.includes('Button'))
            return child;
    }
    return null;
}

/** The St.Icon inside the panel button. */
function iconActorOf(indicator) {
    for (const child of indicator.get_children?.() ?? []) {
        if (child.constructor?.name?.includes('Icon'))
            return child;
    }
    return null;
}

/** The preferences window, which is a window of its own process, not part of the shell. */
function prefsWindow() {
    for (const actor of global.get_window_actors()) {
        const window = actor.meta_window;
        // Both spellings: this window arrives from Wayland with no GTK application id set,
        // and only its wm_class says who it belongs to.
        const id = window.get_gtk_application_id() ?? '';
        const wmClass = window.get_wm_class() ?? '';
        if (id.includes('org.gnome.Shell.Extensions') ||
            wmClass.includes('org.gnome.Shell.Extensions'))
            return window;
    }
    return null;
}

function stateOf() {
    return Main.extensionManager.lookup(TARGET)?.state;
}

function indicatorOf() {
    return Main.panel.statusArea[TARGET] ?? null;
}

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}
