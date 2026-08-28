// OpenVidu Meet — one click from the top bar into a meeting room.
//
// This file is the only one that may import gi://St or resource:///org/gnome/shell:
// everything with a decision in it lives under lib/ and is tested headlessly. What happens
// here is creation and, symmetrically, destruction. An extension that leaks a widget, a
// signal handler or a menu item across disable() is the classic review rejection, so every
// one of them is created in enable() and undone in disable().

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MeetExtension extends Extension {
    enable() {
        // The panel button lands here in a later unit.
    }

    disable() {
    }
}
