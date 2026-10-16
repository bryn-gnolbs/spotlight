// Spotlight: answering a question in the bubble, inside Spotlight
// SPDX-License-Identifier: GPL-3.0-or-later
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {AgentClient} from '../agent/client.js';
import {memoryName, memoryUsage, parseMemories, primaryAction, shorten} from '../memories/model.js';
import {AgentBubble} from '../ui/bubble.js';
import {plainText} from '../ui/markdown.js';

const SOURCE_CHARS = 28;
const CLOSE_AFTER_COPY_MS = 600;
const FOLLOW_UP_HINT = 'Type a follow-up · Esc for results';

// Asks the agent and shows the answer where the results were: the same
// bubble ScreenVision speaks in (DESIGN.md), streaming as the model writes,
// formatted and scrolling when long. It is a conversation: once an answer is
// in, the question is selected, so typing replaces it with a follow-up and
// Enter asks it (the earlier turns stay above, quietly). Enter on the
// unchanged question does what the first chip does, Copy; Esc goes back to
// the results and ends the conversation.
export class AskController {
    constructor(popup) {
        this._popup = popup;
        this._client = new AgentClient();
        this._bubble = new AgentBubble();
        this._bubble.add_style_class_name('spotlight-answer');
        this._bubble.setFormat('markdown');
        this._question = null;
        this._typed = '';
        this._conversation = null;
        this._turns = [];
        this._sources = [];
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

    /** What the text is for, from the agent (null when it cannot say). */
    intent(text, cancellable = null) {
        return this._client.intent(text, cancellable);
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

    /** Ask a new question, or a follow-up while an answer shows. */
    async ask(question) {
        this._popup.keepOpen();
        const followUp = this.visible && this._answer !== null;
        if (followUp) {
            if (this._answer.text && !this._answer.error)
                this._turns.push({question: this._question, answer: this._answer.text});
            this._cancelRunning();
        } else {
            this.dismiss();
        }
        this._question = question;
        this._typed = question;
        this._gotText = false;
        this._answer = null;
        this._sources = [];
        this._popup.showAnswer(this._bubble);
        this._bubble.setMaxBodyHeight(this._popup.maxAnswerHeight?.() ?? 0);
        this._bubble.setHistory(this._turns);
        this._bubble.setActions([]);
        this._bubble.setHint('');
        this._bubble.think('Asking');
        this._bubble.show();

        const reply = await this._client.converse(question, this._conversation);
        const askId = reply?.askId ?? null;
        if (this._question !== question) {      // dismissed or replaced meanwhile
            this._client.cancelAsk(askId);
            return;
        }
        this._conversation = reply?.conversation ?? null;
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

    /**
     * Enter: ask the follow-up typed in place of the question, or else do what
     * the first chip does (Copy). Returns whether it handled Enter.
     */
    activatePrimary() {
        if (!this.visible)
            return false;
        if (this._followUpTyped())
            this.ask(this._typed);
        else if (this._answer?.text && !this._answer.error)
            this._copy();
        return true;
    }

    /** Scroll a long answer (arrow and page keys). */
    scrollBy(pages) {
        return this.visible && this._bubble.scrollBy(pages);
    }

    /** Back to the results, ending the conversation and any answer still being written. */
    dismiss() {
        this._cancelRunning();
        this._question = null;
        this._answer = null;
        this._conversation = null;
        this._turns = [];
        this._bubble.setActions([]);
        this._bubble.setHint('');
        this._bubble.setHistory([]);
        this._popup.hideAnswer(this._bubble);
    }

    /** The search text changed: typing over the question writes a follow-up. */
    textChanged(text) {
        this._typed = text.trim();
        if (this.visible && this._answer)
            this._showActions();
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
        if (answer.conversation)
            this._conversation = answer.conversation;
        if (answer.cancelled)
            return;
        if (answer.error) {
            this._bubble.say({headline: 'The assistant could not answer', body: answer.error});
            this._showActions();
            return;
        }
        // The question is already in the search field; the headline says where the answer comes from.
        this._sources = parseMemories(JSON.stringify(answer.sources ?? []));
        const headline = this._sources.length > 0 ? 'Answer · from your memories' : 'Answer';
        if (!this._gotText) {
            this._gotText = true;
            this._bubble.say({headline, body: answer.text || 'No answer'});
        } else {
            this._bubble.setHeadline(headline);
        }
        this._showActions();
        // Typing now replaces the question: a follow-up.
        this._popup.selectSearchText?.();
    }

    /** Chips and hint for what Enter does now: ask the typed follow-up, or Copy. */
    _showActions() {
        const answered = this._answer?.text && !this._answer.error;
        if (this._followUpTyped()) {
            this._bubble.setActions([{label: 'Ask follow-up', onActivate: () => this.ask(this._typed)}]);
            this._bubble.setHint('Enter asks · Esc for results');
            return;
        }
        this._bubble.setActions(answered ? [
            {label: 'Copy', onActivate: () => this._copy()},
            ...(this._sources ?? []).map(memory => ({
                label: shorten(memoryName(memory), SOURCE_CHARS),
                onActivate: () => this._openSource(memory),
            })),
        ] : []);
        this._bubble.setHint(answered ? FOLLOW_UP_HINT : '');
    }

    _followUpTyped() {
        return this._answer !== null && this._typed.length > 0 && this._typed !== this._question;
    }

    _cancelRunning() {
        if (this._askId)
            this._client.cancelAsk(this._askId);
        this._askId = null;
        this._early = [];
        this._cancelClose();
    }

    // Actions -------------------------------------------------------------

    _copy() {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, plainText(this._answer.text));
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
