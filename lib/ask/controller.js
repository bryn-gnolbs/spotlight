// Spotlight: answering a question in the bubble, inside Spotlight
// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {AgentClient} from '../agent/client.js';
import {memoryName, memoryUsage, parseMemories, primaryAction, shorten} from '../memories/model.js';
import {AgentBubble} from '../ui/bubble.js';

const SOURCE_CHARS = 28;
const CLOSE_AFTER_COPY_MS = 600;

// Asks the agent and shows the answer where the results were: the same
// bubble ScreenVision speaks in (DESIGN.md), streaming as the model writes.
// Enter does what the first (blue) chip does, Copy; Esc goes back to the
// results; typing something else asks nothing until Enter.
export class AskController {
    constructor(popup) {
        this._popup = popup;
        this._client = new AgentClient();
        this._bubble = new AgentBubble();
        this._bubble.add_style_class_name('spotlight-answer');
        this._question = null;
        this._askId = null;
        this._early = [];
        this._gotText = false;
        this._answer = null;
        this._closeId = 0;
        this._stopListening = this._client.onAnswer({
            status: (id, text) => this._on(id, () => this._status(text)),
            text: (id, chunk) => this._on(id, () => this._text(chunk)),
            done: (id, answer) => this._on(id, () => this._done(answer)),
        });
    }

    get available() {
        return this._client.available;
    }

    get visible() {
        return this._question !== null;
    }

    get question() {
        return this._question;
    }

    /** The bubble, for tests. */
    get bubble() {
        return this._bubble;
    }

    async ask(question) {
        this._popup.keepOpen();
        this.dismiss();
        this._question = question;
        this._gotText = false;
        this._answer = null;
        this._popup.showAnswer(this._bubble);
        this._bubble.setActions([]);
        this._bubble.think('Asking');
        this._bubble.show();

        const askId = await this._client.ask(question);
        if (this._question !== question) {      // dismissed or replaced meanwhile
            this._client.cancelAsk(askId);
            return;
        }
        if (!askId) {
            this._bubble.say({
                headline: 'The assistant is not running',
                body: 'Start it with: systemctl --user start genolabs-agent',
            });
            return;
        }
        this._askId = askId;
        // Signals that arrived before the id did.
        for (const [id, handle] of this._early.splice(0))
            this._on(id, handle);
    }

    /** Enter: copy the answer (the primary chip). Returns whether it handled Enter. */
    activatePrimary() {
        if (!this.visible)
            return false;
        if (this._answer?.text && !this._answer.error)
            this._copy();
        return true;
    }

    /** Back to the results, cancelling an answer still being written. */
    dismiss() {
        if (this._askId)
            this._client.cancelAsk(this._askId);
        this._askId = null;
        this._early = [];
        this._question = null;
        this._answer = null;
        this._cancelClose();
        this._bubble.setActions([]);
        this._popup.hideAnswer(this._bubble);
    }

    /** The search text changed: anything but the question means a new search. */
    textChanged(text) {
        if (this.visible && text.trim() !== this._question)
            this.dismiss();
    }

    destroy() {
        this.dismiss();
        this._stopListening();
        this._client.destroy();
        this._bubble.destroy();
    }

    // Answer signals ------------------------------------------------------

    _on(id, handle) {
        if (this._question === null)
            return;
        if (this._askId === null) {
            this._early.push([id, handle]);
            return;
        }
        if (id === this._askId)
            handle();
    }

    _status(text) {
        if (!this._gotText)
            this._bubble.think(text);
    }

    _text(chunk) {
        if (!this._gotText) {
            this._gotText = true;
            this._bubble.say({headline: 'Answer'});
        }
        this._bubble.stream(chunk);
    }

    _done(answer) {
        this._askId = null;
        this._answer = answer;
        if (answer.cancelled)
            return;
        if (answer.error) {
            this._bubble.say({headline: 'The assistant could not answer', body: answer.error});
            this._bubble.setActions([]);
            return;
        }
        // The question is already in the search field; the headline says where the answer comes from.
        const sources = parseMemories(JSON.stringify(answer.sources ?? []));
        const headline = sources.length > 0 ? 'Answer · from your memories' : 'Answer';
        if (!this._gotText) {
            this._gotText = true;
            this._bubble.say({headline, body: answer.text || 'No answer'});
        } else {
            this._bubble.setHeadline(headline);
        }
        this._bubble.setActions([
            {label: 'Copy', onActivate: () => this._copy()},
            ...sources.map(memory => ({
                label: shorten(memoryName(memory), SOURCE_CHARS),
                onActivate: () => this._openSource(memory),
            })),
        ]);
    }

    // Actions -------------------------------------------------------------

    _copy() {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._answer.text);
        this._bubble.flash('Answer copied');
        this._cancelClose();
        // Let the confirmation register, then get out of the way.
        this._closeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_AFTER_COPY_MS, () => {
            this._closeId = 0;
            this._popup.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _openSource(memory) {
        const action = primaryAction(memory);
        if (action?.kind === 'copy') {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, action.text);
        } else if (action?.kind === 'open') {
            try {
                Gio.AppInfo.launch_default_for_uri(action.uri, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.warn(`Spotlight: cannot open ${action.uri}: ${e.message}`);
            }
        }
        this._client.used(memoryUsage(memory));
        this._popup.close();
    }

    _cancelClose() {
        if (this._closeId) {
            GLib.source_remove(this._closeId);
            this._closeId = 0;
        }
    }
}
