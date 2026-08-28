// What the menu holds, as a list of descriptions rather than as widgets.
//
// extension.js turns each entry here into a PopupMenuItem. Keeping the shape here means the
// states that are awkward to reach by hand — no rooms at all, one room, a room whose label
// is only spaces — are ordinary test cases instead of things you would have to reconfigure
// a live desktop to look at.

/** The item that opens the preferences window. Always present; see `buildMenuModel`. */
export const PREFERENCES_LABEL = 'Rooms…';

/** What the menu says when there is nothing in it. */
export const EMPTY_NOTE = 'No rooms yet';
export const EMPTY_DETAIL = 'Add one in Rooms… below.';

/**
 * The menu for a list of destinations, in order.
 *
 * The preferences item is not optional and is not a convenience. With the destinations
 * configurable, a menu with no rooms in it would otherwise be a dead end: nothing to click,
 * and no way from here to the window that would fix that. So every menu ends with a way
 * into the preferences, and the empty menu says what to do rather than being blank.
 */
export function buildMenuModel(destinations) {
    const rooms = Array.isArray(destinations) ? destinations : [];
    const items = rooms.map(destination => ({
        kind: 'destination',
        label: displayLabel(destination),
        destination,
    }));

    if (items.length === 0)
        items.push({ kind: 'note', label: EMPTY_NOTE, detail: EMPTY_DETAIL });

    items.push(
        { kind: 'separator' },
        { kind: 'preferences', label: PREFERENCES_LABEL });
    return items;
}

/**
 * What a room is called in the menu.
 *
 * A destination that reached storage always has a label — `destinationProblem` refuses one
 * without — so this only ever falls back for a caller that built one by hand. It falls back
 * rather than rendering an empty item, because a menu row you cannot see is a menu row you
 * cannot avoid clicking.
 */
function displayLabel(destination) {
    const label = typeof destination?.label === 'string' ? destination.label.trim() : '';
    return label === '' ? 'Untitled room' : label;
}
