// OpenVidu Meet — one click from the top bar into a meeting room.
//
// This file is the only one that may import gi://St or resource:///org/gnome/shell:
// everything with a decision in it lives under lib/ and is tested headlessly. What happens
// here is creation and, symmetrically, destruction. An extension that leaks a widget, a
// signal handler or a callback across disable() is the classic review rejection, so every
// one of them is created in enable() and undone in disable().

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { createLauncher } from './lib/launcher.js';
import { buildMenuModel } from './lib/menu.js';
import { panelIconPath } from './lib/icon.js';
import { readDestinations, DESTINATIONS_KEY } from './lib/settings.js';

/** What the panel button calls itself to a screen reader. */
const ACCESSIBLE_NAME = 'OpenVidu Meet';

/** How far a room row sits in from its instance. One indent step, as the shell uses them. */
const ROOM_INDENT = '2.5em';

/** The icon on the join button. Adwaita's own, so it follows the icon theme and recolours. */
const JOIN_ICON = 'call-start-symbolic';

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
        super._init({ style: `padding-left: ${ROOM_INDENT};` });

        const label = new St.Label({ text: item.label, y_align: Clutter.ActorAlign.CENTER });
        this.add_child(label);
        // What a screen reader reads for the row, and what the shell's own search of a menu
        // matches on.
        this.label_actor = label;

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

        // Every connection made here is disconnected in _onDestroy.
        this._settingsChangedId = this._settings.connect(
            `changed::${DESTINATIONS_KEY}`, () => this._rebuildMenu());

        this._rebuildMenu();
        this.connect('destroy', () => this._onDestroy());
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
