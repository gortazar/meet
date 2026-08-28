// The preferences window: the rooms the menu offers, in the order it offers them.
//
// Like extension.js this is a thin shell around lib/. What an edit *does* — add, remove,
// move, restore, and which rows are complained about — lives in lib/editing.js, where a
// test can reach it without a GTK process. What is here is the Adwaita rendering of that,
// and the one decision that is genuinely about the window: the working list lives in this
// object, and only valid entries are written to GSettings.
//
// That separation is what stops the classic preferences bug. If every keystroke were
// written straight through, typing "https://meet." would store nothing — the entry is not
// valid yet — and the row would empty itself under the cursor. So the window keeps what you
// typed, shows you what is wrong with it, and commits the rest.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    addDestination, removeAt, replaceAt, moveAt, restoreDefaults, isDefault, isBlank,
} from './lib/editing.js';
import { destinationProblem } from './lib/destinations.js';
import { readDestinations, writeDestinations, resetDestinations } from './lib/settings.js';

export default class MeetPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._rooms = readDestinations(this._settings);

        const page = new Adw.PreferencesPage({
            title: 'Rooms',
            icon_name: 'video-display-symbolic',
        });

        this._group = new Adw.PreferencesGroup({
            title: 'Rooms',
            description: 'What the top bar menu offers, in the order it offers it. The two ' +
                'that ship with the extension are ordinary entries: rename them, point them ' +
                'at your own OpenVidu, reorder them, or remove them.',
        });
        this._group.set_header_suffix(this._addButton());
        page.add(this._group);

        this._restoreGroup = new Adw.PreferencesGroup();
        this._restoreGroup.add(this._restoreRow());
        page.add(this._restoreGroup);

        window.add(page);
        this._rebuild();
    }

    /** Every row, from scratch. Called when the *shape* of the list changes, never on a
     *  keystroke: rebuilding while someone is typing takes the focus out of their box. */
    _rebuild() {
        for (const row of this._builtRows ?? [])
            this._group.remove(row);

        this._builtRows = this._rooms.map((room, index) => this._roomRow(room, index));
        for (const row of this._builtRows)
            this._group.add(row);

        if (this._rooms.length === 0) {
            this._emptyRow = new Adw.ActionRow({
                title: 'No rooms',
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

        const remove = iconButton('user-trash-symbolic', 'Remove this room');
        remove.connect('clicked', () => this._restructure(removeAt(this._rooms, index)));

        for (const button of [up, down, remove])
            row.add_suffix(button);

        const name = new Adw.EntryRow({ title: 'Name', text: room.label });
        const address = new Adw.EntryRow({ title: 'Address', text: room.url });
        // `changed` rather than `apply`: an entry row that only commits on Enter loses
        // whatever was typed when the window is closed, which is how most people close it.
        name.connect('changed', () => this._edit(row, index, { label: name.text }));
        address.connect('changed', () => this._edit(row, index, { url: address.text }));
        row.add_row(name);
        row.add_row(address);

        return row;
    }

    /** A keystroke: update the model and this row's summary, and commit what is valid. */
    _edit(row, index, patch) {
        this._rooms = replaceAt(this._rooms, index, patch);
        this._describe(row, this._rooms[index]);
        this._restoreButton?.set_sensitive(!isDefault(this._rooms));
        writeDestinations(this._settings, this._rooms);
    }

    /** A change to the list itself: rebuild the rows, then commit. */
    _restructure(rooms) {
        this._rooms = rooms;
        this._rebuild();
        writeDestinations(this._settings, this._rooms);
    }

    /**
     * What a collapsed row says about itself.
     *
     * The subtitle carries the address, or the problem with it when there is one — so a row
     * that will never open says why without having to be expanded first. A row nobody has
     * typed into yet is unfinished rather than wrong, and is not complained about.
     */
    _describe(row, room) {
        row.title = room.label.trim() === '' ? 'New room' : room.label;

        const problem = isBlank(room) ? null : destinationProblem(room);
        row.subtitle = problem === null ? room.url : problem;
        if (problem === null)
            row.remove_css_class('error');
        else
            row.add_css_class('error');
    }

    _addButton() {
        const button = iconButton('list-add-symbolic', 'Add a room');
        button.connect('clicked', () => this._restructure(addDestination(this._rooms)));
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
