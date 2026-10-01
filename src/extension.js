// OpenVidu Meet — one click from the top bar into a meeting room.
//
// This file is the only one that may import gi://St or resource:///org/gnome/shell:
// everything with a decision in it lives under lib/ and is tested headlessly. What happens
// here is creation and, symmetrically, destruction. An extension that leaks a widget, a
// signal handler or a callback across disable() is the classic review rejection, so every
// one of them is created in enable() and undone in disable().

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { createLauncher } from './lib/launcher.js';
import { createRoomsClient } from './lib/client.js';
import { buildMenuModel } from './lib/menu.js';
import { openKeyStore } from './lib/keyring.js';
import { panelIconPath } from './lib/icon.js';
import { readDestinations, DESTINATIONS_KEY } from './lib/settings.js';

/** What the panel button calls itself to a screen reader. */
const ACCESSIBLE_NAME = 'OpenVidu Meet';

/** How far a room row sits in from its instance. One indent step, as the shell uses them. */
const ROOM_INDENT = '2.5em';

/** The icon on the join button. Adwaita's own, so it follows the icon theme and recolours. */
const JOIN_ICON = 'call-start-symbolic';

/**
 * How long one request to an instance may take.
 *
 * Short, because the only thing waiting on it is a menu that is already open. A deployment
 * that has not answered in ten seconds is one the user should be told about rather than
 * left watching, and the row that says so is better than a spinner that never stops.
 */
const REQUEST_TIMEOUT_SECONDS = 10;

/**
 * One room: its name, and a button that joins the call.
 *
 * A custom item rather than a `PopupMenuItem` because the button has to be reachable in its
 * own right — its own accessible name, its own keyboard focus — rather than being a picture
 * glued to the end of a label. Both it and the row itself open the same link, which is what
 * the answered open question settled: the name does what the button does.
 */
const RoomMenuItem = GObject.registerClass(
class RoomMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(item) {
        super._init({});
        // Set afterwards, not passed in: PopupBaseMenuItem runs its params through
        // Params.parse, which throws on any key it does not know, and `style` is not one of
        // them. The failure is at construction time, so it takes the whole menu with it.
        this.style = `padding-left: ${ROOM_INDENT};`;

        const label = new St.Label({ text: item.label, y_align: Clutter.ActorAlign.CENTER });
        this.add_child(label);
        // What a screen reader reads for the row.
        this.label_actor = label;
        // And `label` as well, because that is the name PopupMenuItem gives its own and
        // therefore the one everything else looks for — the shell's menu accessors among
        // them. Without it a room row is on screen and invisible to anything asking the
        // menu what it holds.
        this.label = label;

        if (item.destination === null) {
            // A room whose link lib/rooms.js would not vouch for. It is still listed — the
            // instance really does have this room — but there is nothing here to activate,
            // and a row that looks clickable and does nothing is worse than a greyed one.
            this.setSensitive(false);
            return;
        }

        // Pushes the button to the trailing edge, and does so under a right-to-left locale
        // too, which a hand-set x_align would not.
        this.add_child(new St.Widget({ x_expand: true }));

        this._join = new St.Button({
            child: new St.Icon({ icon_name: JOIN_ICON, style_class: 'popup-menu-icon' }),
            style_class: 'button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: item.joinLabel,
        });
        // Activating the item rather than launching directly: that is what closes the menu,
        // and it keeps one handler for the two ways into the same room.
        this._joinId = this._join.connect('clicked',
            () => this.activate(Clutter.get_current_event()));
        this.add_child(this._join);

        this.connect('destroy', () => {
            if (this._joinId) {
                this._join.disconnect(this._joinId);
                this._joinId = 0;
            }
            this._join = null;
        });
    }
});

const MeetIndicator = GObject.registerClass(
class MeetIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, ACCESSIBLE_NAME, false);

        this._extension = extension;
        this._settings = extension.getSettings();
        // What each instance has told us about its rooms, keyed by instance URL, held for
        // this session only. No room name and emphatically no join link is written to
        // dconf: one is a credential and the other is somebody's meeting schedule.
        this._roomStates = {};
        // Set on the way out, and checked by anything that runs after: a launch started
        // just before disable() answers a moment later, and by then this object is gone.
        this._destroyed = false;

        // 'system-status-icon' is what makes the icon the panel's own icon size and follow
        // the scale factor, so it is sharp on HiDPI and the same weight as its neighbours.
        // A hand-set icon_size is how an extension ends up looking slightly wrong on
        // everyone else's desktop.
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(panelIconPath(extension.path)),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
        // The shell has no tooltips in the top bar; this is the equivalent, and it is what
        // Orca reads out and what makes the button findable by keyboard navigation.
        this.accessible_name = ACCESSIBLE_NAME;

        this._launcher = createLauncher({
            launch: launchDefaultForUri,
            notify: (title, body) => this._notify(title, body),
            launchContext: () => this._launchContext(),
        });

        // One session for the indicator's lifetime, aborted in _onDestroy. The timeout is
        // the session's, so a deployment that accepts a connection and then says nothing is
        // bounded too, not only one that refuses outright.
        this._session = new Soup.Session({
            timeout: REQUEST_TIMEOUT_SECONDS,
            user_agent: 'gnome-shell-meet',
        });
        this._client = createRoomsClient({ send: request => this._send(request) });
        // Opened once and kept: a keyring that has to be unlocked should be unlocked once,
        // not on every menu open.
        this._keyStore = openKeyStore();
        this._refreshCancellable = null;

        // Every connection made here is disconnected in _onDestroy.
        this._settingsChangedId = this._settings.connect(
            `changed::${DESTINATIONS_KEY}`, () => this._rebuildMenu());
        // Rooms are fetched when the menu opens, never on a timer. A panel button that polls
        // a remote API every minute for a list nobody is looking at is a battery problem and
        // a review problem; and closing the menu is the moment nothing is waiting on the
        // answer any more, so it is also where the request is abandoned.
        this._menuStateId = this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen)
                this._refreshRooms();
            else
                this._cancelRefresh();
        });

        this._rebuildMenu();
        this.connect('destroy', () => this._onDestroy());
    }

    /**
     * Ask every configured instance for its rooms.
     *
     * The previous list stays on screen while the new one arrives: only an instance we have
     * never heard anything from shows "looking for rooms", so re-opening the menu does not
     * blank a list that is perfectly good while it is confirmed.
     *
     * Never awaited by its caller — it is called from a signal handler — so it must not
     * reject. Every step that could is already a state rather than a throw.
     */
    async _refreshRooms() {
        const instances = readDestinations(this._settings);
        if (instances.length === 0)
            return;

        this._cancelRefresh();
        const cancellable = new Gio.Cancellable();
        this._refreshCancellable = cancellable;

        // A state for an instance that has since been removed is a state nothing will ever
        // draw. Dropped here rather than left to accumulate for the session.
        const configured = new Set(instances.map(instance => instance.url));
        for (const url of Object.keys(this._roomStates)) {
            if (!configured.has(url))
                delete this._roomStates[url];
        }

        let pending = false;
        for (const instance of instances) {
            if (this._roomStates[instance.url] === undefined) {
                this._roomStates[instance.url] = { status: 'loading' };
                pending = true;
            }
        }
        if (pending)
            this._rebuildMenu();

        const keyStore = await this._keyStore;
        if (this._stale(cancellable))
            return;
        const keys = await keyStore.lookupKeys(instances);
        if (this._stale(cancellable))
            return;

        await Promise.all(instances.map(async instance => {
            const state = await this._client.fetchRooms(
                instance, keys[instance.url], cancellable);
            // A cancelled request is the menu having closed. It leaves what was on screen
            // exactly as it was, rather than replacing a good list with an error nobody
            // caused.
            if (this._stale(cancellable) || state.status === 'cancelled')
                return;
            this._roomStates[instance.url] = state;
            this._rebuildMenu();
        }));
    }

    /** Whether this refresh is still the one anybody is waiting for. */
    _stale(cancellable) {
        return this._destroyed || cancellable.is_cancelled() ||
            this._refreshCancellable !== cancellable;
    }

    /** Abandon whatever is in flight. Safe to call when nothing is. */
    _cancelRefresh() {
        this._refreshCancellable?.cancel();
        this._refreshCancellable = null;
    }

    /**
     * The one place this extension touches the network.
     *
     * Asynchronous, cancellable, and `https:` only — `client.js` refuses to build a request
     * for anything else, and nothing else builds one.
     */
    _send(request) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new(request.method, request.uri);
            if (message === null) {
                reject(new Error(`libsoup would not take ${request.method} as a request`));
                return;
            }
            for (const [name, value] of Object.entries(request.headers))
                message.request_headers.append(name, value);

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT,
                request.cancellable ?? null, (session, result) => {
                    try {
                        const bytes = this._session.send_and_read_finish(result);
                        resolve({
                            // Read as a property, never through get_status(). That throws on
                            // any status outside libsoup's own enum — 429 is the one that
                            // bit a sibling idea — and a throw from inside this callback
                            // settles no promise at all, so the request would hang forever.
                            status: message.status_code,
                            body: decodeBody(bytes),
                        });
                    } catch (error) {
                        reject(asCancellation(error));
                    }
                });
        });
    }

    /**
     * The menu, from the stored destinations.
     *
     * Rebuilt wholesale rather than patched, because the list can change in any way at once
     * — reordered, renamed, emptied — and `removeAll()` destroys the old items and their
     * handlers with them, which is exactly the bookkeeping we would otherwise have to do
     * by hand and get wrong.
     */
    _rebuildMenu() {
        if (this._destroyed)
            return;

        this.menu.removeAll();
        const instances = readDestinations(this._settings);
        for (const item of buildMenuModel(instances, this._roomStates)) {
            // A note is the only entry that is two lines: what is wrong, and what to do
            // about it. Two unclickable items rather than one, because a wrapped label in a
            // popup menu sizes badly at every width but the one it was tried at.
            if (item.kind === 'note') {
                this.menu.addMenuItem(note(item.label));
                this.menu.addMenuItem(note(item.detail));
                continue;
            }
            this.menu.addMenuItem(this._menuItem(item));
        }
    }

    _menuItem(item) {
        if (item.kind === 'separator')
            return new PopupMenu.PopupSeparatorMenuItem();

        // Why an instance is offline, or has no key, or has no rooms. Indented with its
        // rooms, because it is standing in for them.
        if (item.kind === 'room-note')
            return note(item.label, ROOM_INDENT);

        if (item.kind === 'room') {
            const roomItem = new RoomMenuItem(item);
            if (item.destination !== null)
                roomItem.connect('activate', () => this._launcher.open(item.destination));
            return roomItem;
        }

        const menuItem = new PopupMenu.PopupMenuItem(item.label);
        if (item.kind === 'more')
            menuItem.style = `padding-left: ${ROOM_INDENT};`;
        if (item.kind === 'preferences') {
            menuItem.connect('activate', () => this._extension.openPreferences());
            return menuItem;
        }

        // Activating a PopupMenuItem closes the menu, which is what a launcher should do.
        // The launch itself is asynchronous and its result is a notification, not a return
        // value, so nothing is awaited here.
        menuItem.connect('activate', () => {
            this._launcher.open(item.destination);
        });
        return menuItem;
    }

    /**
     * The shell's own launch context: it carries the current timestamp and workspace, so
     * the browser opens where you are and is raised rather than flagged as demanding
     * attention. Fetched per launch, because a kept one goes stale immediately.
     */
    _launchContext() {
        try {
            return global.create_app_launch_context(0, -1);
        } catch {
            // Better a launch with no context than no launch. The failure modes without one
            // are cosmetic; without the launch there is no extension.
            return null;
        }
    }

    /** One message, on the screen, naming what could not be opened. */
    _notify(title, body) {
        if (this._destroyed)
            return;
        Main.notifyError(title, body);
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = 0;
        }
        // Both, and in this order. The cancellable settles the promise this object is
        // waiting on; abort() closes the connections the session is holding open. A reply
        // that arrives anyway finds _destroyed set and touches nothing.
        this._cancelRefresh();
        this._session?.abort();
        this._session = null;
        this._client = null;
        this._keyStore = null;
        this._settings = null;
        this._launcher = null;
        this._extension = null;
        this._roomStates = null;
        // The icon and every menu item are children of this actor and go with it; the menu
        // items' handlers go with the items.
        this._icon = null;
    }
});

export default class MeetExtension extends Extension {
    enable() {
        this._indicator = new MeetIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        // destroy() removes it from the status area and fires the 'destroy' handler above,
        // which is where everything this extension took is given back.
        this._indicator?.destroy();
        this._indicator = null;
    }
}

/** An unclickable line of explanation, styled the way the shell styles one. */
function note(text, indent = null) {
    const item = new PopupMenu.PopupMenuItem(text);
    item.setSensitive(false);
    if (indent !== null)
        item.style = `padding-left: ${indent};`;
    return item;
}

/**
 * A response body as text, for a body that may be empty or absent.
 *
 * `send_and_read_finish` returns a GLib.Bytes whose data is null for a 204 or for a
 * connection that closed with nothing on it, and TextDecoder will not take null.
 */
function decodeBody(bytes) {
    const data = bytes?.get_data();
    return data === null || data === undefined ? '' : new TextDecoder().decode(data);
}

/**
 * The same error, marked if it is the request having been cancelled.
 *
 * `client.js` tells cancellation apart from failure by this flag, because a menu that was
 * closed must not leave "could not reach that instance" behind it. Guarded at every step:
 * `matches` is a GError method and this error may be anything.
 */
function asCancellation(error) {
    try {
        if (typeof error?.matches === 'function' &&
            error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            error.cancelled = true;
    } catch {
    }
    return error;
}

/**
 * Hand a URI to whatever the desktop already opens web links with.
 *
 * Asynchronous: the synchronous spelling blocks the compositor for as long as the browser
 * takes to acknowledge, which on a cold start is seconds of frozen desktop.
 */
function launchDefaultForUri(uri, context) {
    return new Promise((resolve, reject) => {
        Gio.AppInfo.launch_default_for_uri_async(uri, context, null, (source, result) => {
            try {
                Gio.AppInfo.launch_default_for_uri_finish(result);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}
