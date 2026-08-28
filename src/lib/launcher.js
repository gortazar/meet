// Opening a destination in whatever the desktop already uses for web links.
//
// The launch itself is one call — `Gio.AppInfo.launch_default_for_uri_async` — and it is
// injected rather than made here, so everything around it can be tested under plain gjs:
// with no browser, no compositor and no desktop. extension.js supplies the real seam.
//
// Deliberately *not* here: any attempt to force a new window. That means knowing which
// browser it is and passing its own flag, which is browser-specific, breaks under Flatpak
// and needs a subprocess this extension otherwise does not have. The URI goes to the
// default handler and the handler decides — a tab in a running browser is what that
// normally means, and it is what the answered open question accepted.

import Gio from 'gi://Gio';

import { destinationProblem } from './destinations.js';

/**
 * A launcher over an injected launch seam.
 *
 * @param {object} deps
 * @param {(uri: string, context: object|null) => (Promise<void>|void)} deps.launch
 *   Hands the URI to the default handler. May resolve, reject, return nothing, or throw.
 * @param {(title: string, body: string) => void} deps.notify Shows a failure to the user.
 * @param {() => object|null} [deps.launchContext] The shell's launch context, if there is
 *   one. Fetched per launch rather than kept, because it carries the current timestamp and
 *   workspace and a stale one puts the browser in the wrong place.
 */
export function createLauncher({ launch, notify, launchContext = () => null }) {
    /**
     * Open one destination. Resolves to whether the launch was attempted and did not fail.
     *
     * This never rejects and never throws. It is called straight from a menu item's
     * `activate`, which is inside the compositor's main loop: an exception escaping here
     * lands in the journal, and on a bad day takes the panel with it.
     */
    async function open(destination) {
        const problem = destinationProblem(destination);
        if (problem !== null) {
            // A destination that fails our own rules never reaches a browser. It can only
            // get here from a setting edited by hand, so say which rule it broke.
            report(notify, {
                title: `Could not open ${labelOf(destination)}`,
                body: capitalise(problem),
            });
            return false;
        }

        try {
            await launch(destination.url, launchContext());
            return true;
        } catch (error) {
            report(notify, launchFailureMessage(destination.label, error));
            return false;
        }
    }

    return { open };
}

/**
 * A GError from a failed launch, as a title and a body a person can act on.
 *
 * Split out and exported because this is the part with a decision in it, and because the
 * message it produces is the entire user interface of the failure path.
 */
export function launchFailureMessage(label, error) {
    const title = `Could not open ${label || 'the room'}`;

    if (isNoHandler(error)) {
        // A real state on a bare machine and in a fresh container. The raw error is
        // "No application is registered as handling this file", which is true and useless.
        return {
            title,
            body: 'No default browser is set for web links. Choose one in Settings → ' +
                'Default Apps and try again.',
        };
    }

    const detail = typeof error?.message === 'string' && error.message !== ''
        ? error.message
        : 'the browser did not say why';
    return { title, body: `The default browser could not open it: ${detail}.` };
}

/** Whether this failure means "nothing on this machine opens https:// links". */
function isNoHandler(error) {
    // `matches` is a GError method, so this is guarded: the seam is injectable and a test
    // double, or a plain Error, has no such method.
    if (typeof error?.matches !== 'function')
        return false;
    try {
        return error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED) ||
            error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
    } catch {
        return false;
    }
}

/**
 * Show a failure, and swallow a failure to show it.
 *
 * The notifier is the shell's, and it can raise — during a session-mode change, or while
 * the shell is shutting down. This is already the error path; a second error inside it
 * would be the one that actually reaches the compositor.
 */
function report(notify, { title, body }) {
    try {
        notify(title, body);
    } catch {
    }
}

function labelOf(destination) {
    const label = destination?.label;
    return typeof label === 'string' && label.trim() !== '' ? label.trim() : 'the room';
}

function capitalise(sentence) {
    return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
