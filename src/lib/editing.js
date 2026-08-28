// Editing a list of destinations, as the preferences window does it.
//
// Every operation takes a list and returns a new one; nothing here mutates its argument and
// nothing here talks to GSettings. That is what lets the preferences window — which cannot
// be loaded outside a GTK process — have its behaviour tested under plain gjs: prefs.js
// becomes rows and buttons over these functions, and the rules about what an edit does live
// where a test can reach them.
//
// The working list may hold entries that are **not** valid destinations: a row someone is
// halfway through typing is not a destination yet, and it still has to stay on screen. Only
// `toPairs` at the commit step drops those, which is why editing is separate from storage.

import { DEFAULT_DESTINATIONS, destinationProblem } from './destinations.js';

/** What a freshly added row starts as. */
export const BLANK_DESTINATION = Object.freeze({ label: '', url: 'https://' });

/**
 * A new row at the end.
 *
 * Prefilled with the scheme rather than empty, because `https://` is the only scheme a
 * destination may have and typing it out is a thing the user should not have to discover
 * by getting it wrong first.
 */
export function addDestination(list, destination = BLANK_DESTINATION) {
    return [...asList(list), { label: destination.label ?? '', url: destination.url ?? '' }];
}

/** Without the row at `index`. An index that is not there changes nothing. */
export function removeAt(list, index) {
    const rows = asList(list);
    if (!inRange(rows, index))
        return rows;
    return rows.filter((_, i) => i !== index);
}

/**
 * The row at `index`, with `patch` applied to it. A patch of `{ url }` leaves the label
 * alone, which is what an entry row's `changed` signal wants to say.
 */
export function replaceAt(list, index, patch) {
    const rows = asList(list);
    if (!inRange(rows, index) || patch === null || typeof patch !== 'object')
        return rows;
    return rows.map((row, i) => i === index
        ? {
            label: typeof patch.label === 'string' ? patch.label : row.label,
            url: typeof patch.url === 'string' ? patch.url : row.url,
        }
        : row);
}

/**
 * The row at `from`, moved to `to`. Out-of-range moves are refused rather than clamped: a
 * "move up" on the first row should do nothing, not silently reorder something else.
 */
export function moveAt(list, from, to) {
    const rows = asList(list);
    if (!inRange(rows, from) || !inRange(rows, to) || from === to)
        return rows;
    const moved = [...rows];
    const [row] = moved.splice(from, 1);
    moved.splice(to, 0, row);
    return moved;
}

/**
 * The list a fresh install has, as an editable copy.
 *
 * A copy, not the frozen constant: this is handed to a window that will edit it, and
 * handing out the constant would make the first keystroke throw in strict mode.
 */
export function restoreDefaults() {
    return DEFAULT_DESTINATIONS.map(destination => ({ ...destination }));
}

/** Whether this list is the shipped one, unedited. What a "restore" button greys out on. */
export function isDefault(list) {
    const rows = asList(list);
    if (rows.length !== DEFAULT_DESTINATIONS.length)
        return false;
    return rows.every((row, i) =>
        row.label === DEFAULT_DESTINATIONS[i].label && row.url === DEFAULT_DESTINATIONS[i].url);
}

/**
 * The problems in a list, as `{ index, problem }`, in list order.
 *
 * The window shows each one against its own row. A blank row — the state a just-added row
 * is in — is not reported: it is not wrong yet, it is just unfinished, and shouting at
 * someone the instant they press "Add" is not a preferences window.
 */
export function listProblems(list) {
    const problems = [];
    asList(list).forEach((row, index) => {
        if (isBlank(row))
            return;
        const problem = destinationProblem(row);
        if (problem !== null)
            problems.push({ index, problem });
    });
    return problems;
}

/** A row nobody has typed anything into yet: still exactly as `addDestination` left it. */
export function isBlank(row) {
    const label = typeof row?.label === 'string' ? row.label.trim() : '';
    const url = typeof row?.url === 'string' ? row.url.trim() : '';
    return label === '' && (url === '' || url === BLANK_DESTINATION.url);
}

function asList(list) {
    return Array.isArray(list) ? list : [];
}

function inRange(rows, index) {
    return Number.isInteger(index) && index >= 0 && index < rows.length;
}
