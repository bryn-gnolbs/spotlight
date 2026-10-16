// Spotlight: the mind's notifications, in the agent's bubble
// SPDX-License-Identifier: GPL-3.0-or-later
//
// When the assistant speaks unasked (a reminder Bryn set, or something the mind
// decided Bryn should know), the agent emits Notify. It shows here as the same
// bubble every part of the project speaks in (genolabs-os docs/DESIGN.md), in
// the top-right corner, with its chips as complete answers ("Done", "In an hour").
// It stays while the pointer is on it, otherwise leaves after a while ("ignored"),
// unless it is sticky. The agent's timing rules (quiet hours, Do Not Disturb) are
// applied before Notify is sent; GNOME's own notification is the agent's fallback
// when nothing here confirms it was shown.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AgentClient} from '../agent/client.js';
import {AgentBubble} from '../ui/bubble.js';

const MARGIN = 16;
const SHOW_MS = 15000;
const MAX_BODY_HEIGHT = 240;
const DISMISS = 'Dismiss';

export class Notifications {
    /** @param {AgentClient} [client] - the agent (tests pass their own) */
    constructor(client = null) {
        this._ownClient = !client;
        this._client = client ?? new AgentClient();
        this._bubble = null;
        this._current = null;
        this._hideId = 0;
        this._stopListening = this._client.onNotify(note => this.show(note));
    }

    /** The bubble, for tests. */
    get bubble() {
        return this._bubble;
    }

    /** The notification on screen, if any. */
    get current() {
        return this._current;
    }

    show(note) {
        if (!note?.id || !note.headline)
            return;
        if (this._current)
            this._finish('ignored');
        this._client.notificationShown(note.id);
        const bubble = this._ensureBubble();
        this._current = note;
        const chips = [...(note.chips ?? [])].filter(label => typeof label === 'string' && label);
        if (!chips.includes(DISMISS))
            chips.push(DISMISS);
        bubble.say({headline: note.headline, body: note.body ?? ''});
        bubble.setActions(chips.map(label => ({
            label,
            onActivate: () => this._finish(label === DISMISS ? 'dismissed' : label),
        })));
        bubble.setHint('');
        this._place();
        bubble.show();
        if (note.sound)
            global.display.get_sound_player().play_from_theme('message-new-instant', note.headline, null);
        this._scheduleHide();
    }

    _ensureBubble() {
        if (!this._bubble) {
            this._bubble = new AgentBubble();
            this._bubble.add_style_class_name('spotlight-notification');
            this._bubble.setFormat('markdown');
            this._bubble.setMaxBodyHeight(MAX_BODY_HEIGHT);
            this._bubble.reactive = true;
            this._bubble.track_hover = true;
            this._bubble.connect('notify::hover', () => this._scheduleHide());
            this._bubble.connect('notify::width', () => this._place());
            this._bubble.hide();
            Main.layoutManager.addTopChrome(this._bubble);
        }
        return this._bubble;
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._bubble || !monitor)
            return;
        const [, width] = this._bubble.get_preferred_width(-1);
        const top = monitor.y + (Main.panel?.height ?? 0) + MARGIN;
        this._bubble.set_position(Math.round(monitor.x + monitor.width - width - MARGIN), Math.round(top));
    }

    _scheduleHide() {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (!this._current || this._current.sticky || this._bubble?.hover)
            return;
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHOW_MS, () => {
            this._hideId = 0;
            this._finish('ignored');
            return GLib.SOURCE_REMOVE;
        });
    }

    _finish(reaction) {
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        const note = this._current;
        this._current = null;
        if (note)
            this._client.notificationReaction(note.id, reaction);
        this._bubble?.hide();
    }

    destroy() {
        this._stopListening?.();
        this._stopListening = null;
        if (this._hideId) {
            GLib.source_remove(this._hideId);
            this._hideId = 0;
        }
        if (this._bubble) {
            Main.layoutManager.removeChrome(this._bubble);
            this._bubble.destroy();
            this._bubble = null;
        }
        if (this._ownClient)
            this._client.destroy();
        this._client = null;
        this._current = null;
    }
}
