// Spotlight: waiting for a pause in typing
// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';

/**
 * Resolve to true after `ms`, or to false as soon as `cancellable` is
 * cancelled. GNOME Shell cancels a search's cancellable on every keystroke,
 * so awaiting this before a request debounces typing: only the search for
 * the text the user paused on goes out.
 *
 * @param {number} ms
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<boolean>}
 */
export function waitUnlessCancelled(ms, cancellable) {
    return new Promise(resolve => {
        if (cancellable?.is_cancelled()) {
            resolve(false);
            return;
        }
        let handlerId = 0;
        const sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            // Safe here; disconnecting from inside the cancelled handler would deadlock.
            if (handlerId)
                cancellable.disconnect(handlerId);
            resolve(true);
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable) {
            handlerId = cancellable.connect(() => {
                GLib.source_remove(sourceId);
                resolve(false);
            });
        }
    });
}
