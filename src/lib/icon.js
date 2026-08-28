// The panel icon, named in one place.
//
// extension.js builds a Gio.FileIcon over this path and a test rasterises the same file, so
// a rename that reaches one and not the other is a failing test rather than a top bar
// showing the generic "missing image" square — which is what GNOME does with an icon it
// cannot load, silently, with nothing in the log.

/** The icon's name, without the extension. `-symbolic` is what makes GTK recolour it. */
export const PANEL_ICON = 'openvidu-meet-symbolic';

/** Where it sits inside the extension directory, and inside the packed zip. */
export function panelIconPath(extensionPath) {
    return `${extensionPath}/icons/${PANEL_ICON}.svg`;
}
