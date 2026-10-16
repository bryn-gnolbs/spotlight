// Spotlight: popup close defense layers
// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Installs the multi-layer close defense on a popup. Each layer catches a
// different activation path that the others might miss.
export function installCloseDefense(popup, search, entry) {
    // Layer 1: mouse clicks on any result. Uses idle so activation runs first.
    search.connectObject(
        'button-press-event', (_actor, event) => {
            if (popup.keepsOpenFor(event.get_source()))
                return Clutter.EVENT_PROPAGATE;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (popup._visible)
                    popup.close();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        },
        popup,
    );

    // Layer 2: Esc, Enter or Space on result buttons.
    global.stage.connectObject(
        'captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS)
                return Clutter.EVENT_PROPAGATE;

            const key = event.get_key_symbol();

            if (key === Clutter.KEY_Escape) {
                // An answer first goes back to the results.
                if (popup.answers?.visible)
                    popup.answers.dismiss();
                else
                    popup.close();
                return Clutter.EVENT_STOP;
            }

            // Arrow and page keys scroll a long answer.
            if (popup.answers?.visible) {
                const pages = {
                    [Clutter.KEY_Up]: -0.3, [Clutter.KEY_Down]: 0.3,
                    [Clutter.KEY_Page_Up]: -1, [Clutter.KEY_Page_Down]: 1,
                }[key];
                if (pages !== undefined) {
                    popup.answers.scrollBy(pages);
                    return Clutter.EVENT_STOP;
                }
            }

            if (key === Clutter.KEY_Return ||
                key === Clutter.KEY_KP_Enter ||
                key === Clutter.KEY_space) {
                const focus = global.stage.get_key_focus();
                if (focus &&
                    focus !== entry &&
                    !entry.contains(focus) &&
                    popup.contains(focus) &&
                    (!focus.has_style_class_name ||
                     !focus.has_style_class_name('popup-menu'))) {
                    popup.close();
                    // Activate now: St.Button fires on key release, and by then the
                    // close has taken the result off screen, so the press is lost.
                    if (focus instanceof St.Button) {
                        focus.emit('clicked', 0);
                        return Clutter.EVENT_STOP;
                    }
                }
            }

            return Clutter.EVENT_PROPAGATE;
        },
        popup,
    );

    // Close on key-focus loss unless focus moved to a popup-menu.
    global.stage.connectObject(
        'notify::key-focus', () => {
            if (!popup._visible)
                return;
            const focus = global.stage.get_key_focus();

            if (!focus) {
                entry.grab_key_focus();
                return;
            }

            if (entry && (entry === focus || entry.contains(focus)))
                return;

            if (popup.contains(focus))
                return;

            if (focus.has_style_class_name &&
                focus.has_style_class_name('popup-menu'))
                return;

            popup.close();
        },
        popup,
    );

    // Layer 3: external app focus at the window manager level. Catches web
    // search opening in a browser and any activation that shifts focus outside
    // the GNOME Shell stage. Uses plain connect so defense uninstall cannot
    // wipe persistent signals on global.display that share the popup owner.
    popup._focusWindowId = global.display.connect(
        'notify::focus-window', () => {
            if (!popup._visible)
                return;
            if (global.display.focus_window !== null)
                popup.close();
        },
    );
}

// Disconnects all defense handlers. Stage and search signals use
// connectObject with the popup owner. The focus-window signal on global.display
// uses plain connect with an explicit ID to avoid colliding with persistent
// signals that share the same owner.
export function uninstallCloseDefense(popup, search) {
    global.stage.disconnectObject(popup);
    if (popup._focusWindowId) {
        global.display.disconnect(popup._focusWindowId);
        popup._focusWindowId = 0;
    }
    if (search)
        search.disconnectObject(popup);
}
