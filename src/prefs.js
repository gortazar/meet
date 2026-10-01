// The preferences window: the instances the menu offers, in the order it offers them, and
// the API key that lets each one list its rooms.
//
// Like extension.js this is a thin shell around lib/. What an edit *does* — add, remove,
// move, restore, which rows are complained about, and what an edit means for the keyring —
// lives in lib/editing.js and lib/keyring.js, where a test can reach it without a GTK
// process. What is here is the Adwaita rendering of that, and the one decision that is
// genuinely about the window: the working list lives in this object, and only valid entries
// are written to GSettings.
//
// That separation is what stops the classic preferences bug. If every keystroke were
// written straight through, typing "https://meet." would store nothing — the entry is not
// valid yet — and the row would empty itself under the cursor. So the window keeps what you
// typed, shows you what is wrong with it, and commits the rest.
//
// The API key is not written to GSettings at all. It goes to the system keyring, debounced,
// because a keystroke is not a decision to store a credential forty times.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    addDestination, removeAt, replaceAt, moveAt, restoreDefaults, isDefault, isBlank,
} from './lib/editing.js';
import { destinationProblem } from './lib/destinations.js';
import { keyUpdates, openKeyStore } from './lib/keyring.js';
import { readDestinations, writeDestinations, resetDestinations } from './lib/settings.js';

/**
 * How long after the last keystroke the keyring is written.
 *
 * Long enough that typing a key is one store and not forty, short enough that it has
 * happened by the time anyone reaches for the window's close button.
 */
const KEY_SAVE_DELAY_MS = 400;

export default class MeetPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._rooms = readDestinations(this._settings);
        // What the keyring was last told. `keyUpdates` compares it with the working list to
        // work out what to store and what to clear; starting them equal means opening the
        // window and closing it again touches nothing.
        this._savedRooms = this._rooms.map(room => ({ ...room }));
        this._keySaveTimeout = 0;

        const page = new Adw.PreferencesPage({
            title: 'Rooms',
            icon_name: 'video-display-symbolic',
        });

        this._group = new Adw.PreferencesGroup({
            title: 'Instances',
            description: 'Each OpenVidu Meet deployment the top bar menu offers, in the ' +
                'order it offers them. The two that ship with the extension are ordinary ' +
                'entries: rename them, point them at your own OpenVidu, reorder them, or ' +
                'remove them. Give one an API key and the menu lists that deployment\'s ' +
                'rooms underneath it.',
        });
        this._group.set_header_suffix(this._addButton());
        page.add(this._group);

        this._restoreGroup = new Adw.PreferencesGroup();
        this._restoreGroup.add(this._restoreRow());
        page.add(this._restoreGroup);

        window.add(page);
        this._rebuild();

        // The keyring answers on its own schedule — it may be locked, and unlocking it is a
        // dialog. So the rows are built first and filled in when the keys arrive, rather
        // than the window waiting on a daemon before it draws anything.
        this._loadKeys();
        // Anything still pending when the window goes is written now rather than lost.
        window.connect('close-request', () => {
            this._flushKeys();
            return false;
        });
    }

    /** The stored keys, into the working list and onto the rows that are already drawn. */
    async _loadKeys() {
        this._keyStore = await openKeyStore();
        // The list as it was when the lookup started. Unlocking a keyring can take as long
        // as someone takes to type a password, and in that time the user may have added or
        // removed a row; writing this result over that would undo their edit.
        const asked = this._rooms;
        const keys = await this._keyStore.lookupKeys(asked);
        if (this._rooms !== asked)
            return;

        this._rooms = this._rooms.map(room => {
            const key = keys[room.url];
            // A key that could not be read leaves the field absent rather than empty: an
            // empty one would read as "the user cleared it" and delete the key on the next
            // save. See keyUpdates.
            return typeof key === 'string' ? { ...room, apiKey: key } : room;
        });
        this._savedRooms = this._rooms.map(room => ({ ...room }));

        this._rooms.forEach((room, index) => {
            const entry = this._keyEntries?.[index];
            if (entry !== undefined && typeof room.apiKey === 'string')
                entry.text = room.apiKey;
        });
    }

    /** Every row, from scratch. Called when the *shape* of the list changes, never on a
     *  keystroke: rebuilding while someone is typing takes the focus out of their box. */
    _rebuild({ expandLast = false } = {}) {
        for (const row of this._builtRows ?? [])
            this._group.remove(row);

        // Rebuilt with the rows, and indexed the same way: _loadKeys fills these in when the
        // keyring answers, which is after this has run.
        this._keyEntries = [];
        this._builtRows = this._rooms.map((room, index) => this._roomRow(room, index));
        for (const row of this._builtRows)
            this._group.add(row);

        // A room you just asked for opens ready to be typed into. Pressing "+" and getting
        // a collapsed row called "New room" leaves you to work out that it has to be
        // expanded before it can be filled in.
        if (expandLast && this._builtRows.length > 0)
            this._builtRows[this._builtRows.length - 1].expanded = true;

        if (this._rooms.length === 0) {
            this._emptyRow = new Adw.ActionRow({
                title: 'No instances',
                subtitle: 'The menu will say so. Add one, or restore the defaults below.',
            });
            this._group.add(this._emptyRow);
            this._builtRows.push(this._emptyRow);
        }

        this._restoreButton?.set_sensitive(!isDefault(this._rooms));
    }

    /** One room: its name and address, with the buttons that act on its position. */
    _roomRow(room, index) {
        const row = new Adw.ExpanderRow();
        this._describe(row, room);

        const up = iconButton('go-up-symbolic', 'Move up');
        up.set_sensitive(index > 0);
        up.connect('clicked', () => this._restructure(moveAt(this._rooms, index, index - 1)));

        const down = iconButton('go-down-symbolic', 'Move down');
        down.set_sensitive(index < this._rooms.length - 1);
        down.connect('clicked', () => this._restructure(moveAt(this._rooms, index, index + 1)));

        const remove = iconButton('user-trash-symbolic', 'Remove this instance');
        remove.connect('clicked', () => this._restructure(removeAt(this._rooms, index)));

        // One box rather than three suffixes. `add_suffix` called three times puts them on
        // screen in the reverse of the order they were added — which was visible in the
        // nested-shell screenshot as a delete button sitting nearest the room's name, the
        // last place a destructive action belongs. A box packs in the order written, and
        // does not depend on which libadwaita is installed.
        const buttons = new Gtk.Box({ spacing: 0, valign: Gtk.Align.CENTER });
        for (const button of [up, down, remove])
            buttons.append(button);
        row.add_suffix(buttons);

        const name = new Adw.EntryRow({ title: 'Name', text: room.label });
        const address = new Adw.EntryRow({ title: 'Address', text: room.url });
        // `changed` rather than `apply`: an entry row that only commits on Enter loses
        // whatever was typed when the window is closed, which is how most people close it.
        name.connect('changed', () => this._edit(row, index, { label: name.text }));
        address.connect('changed', () => this._edit(row, index, { url: address.text }));
        row.add_row(name);
        row.add_row(address);

        // A password row, not an entry row: the key is a credential, and one left legible in
        // a settings window is one that ends up in a screen share. Empty until the keyring
        // answers — see _loadKeys.
        const key = new Adw.PasswordEntryRow({ title: 'API key' });
        if (typeof room.apiKey === 'string')
            key.text = room.apiKey;
        key.connect('changed', () => this._edit(row, index, { apiKey: key.text }));
        row.add_row(key);
        this._keyEntries[index] = key;

        // Where the key comes from, because nobody guesses "the Embedded page" — and what
        // it costs not to have one, because an instance with no key is not broken.
        row.add_row(new Adw.ActionRow({
            title: 'Generate one on this deployment\'s Embedded page',
            subtitle: 'Without a key the menu still opens this instance; it just cannot ' +
                'list its rooms. The key is kept in your login keyring, never in dconf.',
            css_classes: ['dim-label'],
        }));

        return row;
    }

    /** A keystroke: update the model and this row's summary, and commit what is valid. */
    _edit(row, index, patch) {
        this._rooms = replaceAt(this._rooms, index, patch);
        this._describe(row, this._rooms[index]);
        this._restoreButton?.set_sensitive(!isDefault(this._rooms));
        writeDestinations(this._settings, this._rooms);
        this._scheduleKeySave();
    }

    /** A change to the list itself: rebuild the rows, then commit. */
    _restructure(rooms, options = {}) {
        this._rooms = rooms;
        this._rebuild(options);
        writeDestinations(this._settings, this._rooms);
        // A removed instance has a key to forget, and a reordered one has not.
        this._scheduleKeySave();
    }

    /**
     * Write the keyring shortly, replacing any write already pending.
     *
     * Debounced because an API key is forty characters and a `changed` signal fires on each
     * of them: storing on every keystroke is forty credential writes, thirty-nine of them to
     * values that were never a key. The delay is short enough to have elapsed before anyone
     * reaches the close button, and `close-request` flushes whatever is left anyway.
     */
    _scheduleKeySave() {
        if (this._keySaveTimeout !== 0)
            GLib.Source.remove(this._keySaveTimeout);
        this._keySaveTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, KEY_SAVE_DELAY_MS, () => {
                this._keySaveTimeout = 0;
                this._flushKeys();
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Tell the keyring what has changed since it was last told.
     *
     * The decision of *what* to tell it is `keyUpdates`, which is tested; this is the part
     * that cannot be. A store that fails marks its row rather than throwing — the answered
     * open question named exactly this cost of the keyring, "a prefs window that can fail to
     * save", and a failure nobody is shown is worse than the dconf it replaced.
     */
    _flushKeys() {
        if (this._keySaveTimeout !== 0) {
            GLib.Source.remove(this._keySaveTimeout);
            this._keySaveTimeout = 0;
        }
        if (this._keyStore === undefined)
            return;

        const { store, clear } = keyUpdates(this._savedRooms, this._rooms);
        this._savedRooms = this._rooms.map(room => ({ ...room }));

        for (const url of clear)
            this._keyStore.clearKey(url);
        for (const { url, key } of store) {
            const instance = this._rooms.find(room => room.url.trim() === url);
            this._keyStore.storeKey(instance ?? { url }, key)
                .then(ok => this._markKeySaved(url, ok));
        }
    }

    /**
     * Show, on the row it belongs to, whether that key reached the keyring.
     *
     * Never the key itself and never the reason verbatim: a libsecret error can quote what
     * it was given, and this is a window someone may well be sharing their screen in.
     */
    _markKeySaved(url, ok) {
        const index = this._rooms.findIndex(room => room.url.trim() === url);
        const entry = this._keyEntries?.[index];
        if (entry === undefined)
            return;

        entry.title = ok ? 'API key' : 'API key — the keyring would not store it';
        if (ok)
            entry.remove_css_class('error');
        else
            entry.add_css_class('error');
    }

    /**
     * What a collapsed row says about itself.
     *
     * The subtitle carries the address, or the problem with it when there is one — so a row
     * that will never open says why without having to be expanded first. A row nobody has
     * typed into yet is unfinished rather than wrong, and is not complained about.
     */
    _describe(row, room) {
        row.title = room.label.trim() === '' ? 'New instance' : room.label;

        const problem = isBlank(room) ? null : destinationProblem(room);
        row.subtitle = problem === null ? room.url : problem;
        if (problem === null)
            row.remove_css_class('error');
        else
            row.add_css_class('error');
    }

    _addButton() {
        const button = iconButton('list-add-symbolic', 'Add an instance');
        button.connect('clicked', () =>
            this._restructure(addDestination(this._rooms), { expandLast: true }));
        return button;
    }

    _restoreRow() {
        const row = new Adw.ActionRow({
            title: 'Restore the defaults',
            subtitle: 'Puts Meet next and Meet back, and discards everything else.',
        });
        this._restoreButton = new Gtk.Button({
            label: 'Restore',
            valign: Gtk.Align.CENTER,
        });
        this._restoreButton.connect('clicked', () => {
            // Through the setting rather than by writing the constant, so a future default
            // that changes upstream is what a restore actually restores.
            resetDestinations(this._settings);
            this._rooms = restoreDefaults();
            this._rebuild();
            // An instance that is gone takes its key with it, which is a thing to tell the
            // keyring rather than leave behind for nothing to ever look up again.
            this._scheduleKeySave();
        });
        row.add_suffix(this._restoreButton);
        row.activatable_widget = this._restoreButton;
        return row;
    }
}

function iconButton(iconName, tooltip) {
    const button = new Gtk.Button({
        icon_name: iconName,
        valign: Gtk.Align.CENTER,
        tooltip_text: tooltip,
    });
    button.add_css_class('flat');
    return button;
}
