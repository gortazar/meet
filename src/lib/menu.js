// What the menu holds, as a list of descriptions rather than as widgets.
//
// extension.js turns each entry here into a menu item. Keeping the shape here means the
// states that are awkward to reach by hand — no instances at all, an instance that refused
// our API key, one that is down, one with ninety rooms — are ordinary test cases instead of
// things you would have to reconfigure a live desktop, or break a server, to look at.
//
// A note on names. What the settings call a `destination` is, in the user's terms, an
// **instance**: an OpenVidu Meet deployment. The stored key keeps its 0.1 name and its 0.1
// meaning, because a setting that changes under an upgrade is a setting that loses
// somebody's configuration; the menu uses the word the entry uses.

/** The item that opens the preferences window. Always present; see `buildMenuModel`. */
export const PREFERENCES_LABEL = 'Rooms…';

/** What the menu says when no instance is configured at all. Unchanged from 0.1. */
export const EMPTY_NOTE = 'No rooms yet';
export const EMPTY_DETAIL = 'Add one in Rooms… below.';

/**
 * The four states an instance's room list can be in other than "here they are", plus the
 * fifth that is not a failure: a request that has not answered yet.
 *
 * Each is a row under its instance rather than a notification or a thrown error. An
 * instance that is offline, or that we have no key for, costs you its rooms — never the
 * menu, and never the other instances.
 */
export const NO_ROOMS_NOTE = 'No rooms yet';
export const NO_KEY_NOTE = `Add an API key in ${PREFERENCES_LABEL}`;
export const REFUSED_NOTE = 'That instance refused the API key';
export const LOADING_NOTE = 'Looking for rooms…';

/** "Could not reach <instance>", naming which one, since you may have several. */
export function unreachableNote(instanceLabel) {
    const label = typeof instanceLabel === 'string' && instanceLabel.trim() !== ''
        ? instanceLabel.trim() : 'that instance';
    return `Could not reach ${label}`;
}

/**
 * How many rooms one instance may put in the menu.
 *
 * Twenty, per the answered open question. The API returns up to a hundred, and a hundred-row
 * popup menu on a busy deployment is not a menu. What is left over is not dropped silently:
 * see `moreLabel`.
 */
export const MAX_ROOMS_SHOWN = 20;

/** The row that accounts for the rooms the cap left out. */
export function moreLabel(remaining) {
    return `…and ${remaining} more`;
}

/**
 * The menu for a list of instances and what each of them has told us about its rooms.
 *
 * @param {Array<{label: string, url: string}>} instances The configured instances, in order.
 * @param {object} roomStates Keyed by instance URL. Each value is `{status, rooms}`, where
 *   status is one of `ok`, `loading`, `no-key`, `unreachable`, `refused`. An instance with no
 *   entry here claims nothing about its rooms and gets no rows — which is the menu for the
 *   moment before the first request answers, and is exactly 0.1's menu.
 *
 * The preferences item is not optional and is not a convenience. With the instances
 * configurable, a menu with none in it would otherwise be a dead end: nothing to click, and
 * no way from here to the window that would fix that. So every menu ends with a way into the
 * preferences, and the empty menu says what to do rather than being blank.
 */
export function buildMenuModel(instances, roomStates = {}) {
    const configured = Array.isArray(instances) ? instances : [];
    const states = roomStates !== null && typeof roomStates === 'object' &&
        !Array.isArray(roomStates) ? roomStates : {};

    const items = [];
    for (const instance of configured) {
        // Instances are told apart by a rule, not by a blank line: with rooms indented
        // underneath, the row after the last room of one instance is the next instance, and
        // without something between them the two levels read as one.
        if (items.length > 0)
            items.push({ kind: 'separator' });

        items.push({
            kind: 'instance',
            label: displayLabel(instance),
            indented: false,
            destination: instance,
        }, ...roomItems(instance, states[instance?.url]));
    }

    if (items.length === 0)
        items.push({ kind: 'note', label: EMPTY_NOTE, detail: EMPTY_DETAIL });

    items.push(
        { kind: 'separator' },
        { kind: 'preferences', label: PREFERENCES_LABEL });
    return items;
}

/** The rows that go under one instance: its rooms, or the one note that explains why not. */
function roomItems(instance, state) {
    if (state === null || typeof state !== 'object' || Array.isArray(state))
        return [];

    const note = noteFor(instance, state);
    if (note !== null)
        return [{ kind: 'room-note', label: note, indented: true }];
    if (state.status !== 'ok')
        return [];

    const rooms = mostRecentFirst(state.rooms);
    const shown = rooms.slice(0, MAX_ROOMS_SHOWN);
    const items = shown.map(room => roomItem(room, instance));

    if (rooms.length > shown.length) {
        // The rest are not dropped silently. The row goes to the instance itself, which is
        // the page that can show all of them.
        items.push({
            kind: 'more',
            label: moreLabel(rooms.length - shown.length),
            indented: true,
            destination: instance,
        });
    }
    return items;
}

/**
 * The note this state calls for, or `null` when the state is rooms to list.
 *
 * A status this version has never heard of returns `null` and lists nothing: a row reading
 * the name of an internal state is worse than no row.
 */
function noteFor(instance, state) {
    switch (state.status) {
    case 'no-key':
        return NO_KEY_NOTE;
    case 'unreachable':
        return unreachableNote(instance?.label);
    case 'refused':
        return REFUSED_NOTE;
    case 'loading':
        return LOADING_NOTE;
    case 'ok':
        return Array.isArray(state.rooms) && state.rooms.length > 0 ? null : NO_ROOMS_NOTE;
    default:
        return null;
    }
}

/**
 * One room row.
 *
 * `destination` is the room's join link in the shape the launcher already takes, so a room
 * and an instance are opened by the same code. It is `null` when `lib/rooms.js` would not
 * vouch for the link: the row is still listed — it is a room the instance has — but no
 * button is drawn and the name does nothing. A button that went somewhere other than the
 * call is the one outcome this entry exists to prevent.
 *
 * The name does what the button does, per the answered open question, which is why there is
 * one destination here and not two.
 */
function roomItem(room, instance) {
    const name = displayLabel({ label: room?.name }, 'Untitled room');
    const joinable = typeof room?.joinUrl === 'string' && room.joinUrl !== '';
    return {
        kind: 'room',
        label: name,
        indented: true,
        roomId: typeof room?.id === 'string' ? room.id : '',
        roomStatus: typeof room?.status === 'string' ? room.status : '',
        // Read by a screen reader off the button, which otherwise announces only its icon.
        joinLabel: joinable ? `Join ${name}` : null,
        destination: joinable ? { label: name, url: room.joinUrl } : null,
        instance,
    };
}

/**
 * The rooms most recently created first, as the answered question asks.
 *
 * Sorted on a copy: the caller's array is the cached room list, and reordering it in place
 * would make the order depend on how many times the menu had been opened. `Array.sort` is
 * stable, so rooms created in the same millisecond keep the order the instance gave them.
 */
function mostRecentFirst(rooms) {
    if (!Array.isArray(rooms))
        return [];
    return [...rooms].sort((a, b) => createdAt(b) - createdAt(a));
}

function createdAt(room) {
    return Number.isFinite(room?.createdAt) ? room.createdAt : 0;
}

/**
 * What a row is called in the menu.
 *
 * An instance that reached storage always has a label — `destinationProblem` refuses one
 * without — so this only ever falls back for a caller that built one by hand, or for a room
 * whose name the API left out. It falls back rather than rendering an empty item, because a
 * menu row you cannot see is a menu row you cannot avoid clicking.
 */
function displayLabel(entry, fallback = 'Untitled room') {
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    return label === '' ? fallback : label;
}
