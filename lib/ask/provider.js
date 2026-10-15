// Spotlight: the Ask section, offering the assistant for questions
// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import St from 'gi://St';

import {insertSection} from '../core/sections.js';
import {asksExplicitly, offersAsk, questionText} from './question.js';

const ICON = 'dialog-question-symbolic';

// An in-process GNOME Shell search provider (see lib/memories/provider.js for
// the shape) with at most one row: "Ask", for text meant for the assistant.
// The agent's intent classifier decides (a few milliseconds a keystroke), so
// "whats my tailscale ip" offers Ask and "tailscale ip" searches; no "?" needed.
// Activating it hands the question to the AskController, which answers in
// the bubble inside Spotlight instead of closing it.
export class AskSearchProvider {
    /**
     * @param {object} options
     * @param {function(string): void} options.onAsk - answer this question
     * @param {function(): boolean} options.available - whether the agent is running
     * @param {function(string, Gio.Cancellable): Promise<?object>} options.classify - the agent's Intent
     */
    constructor({onAsk, available, classify}) {
        this.id = 'genolabs-ask';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;
        this.appInfo = {
            get_name: () => 'Assistant',
            get_icon: () => new Gio.ThemedIcon({name: ICON}),
            get_id: () => null,
            should_show: () => true,
        };
        this._onAsk = onAsk;
        this._available = available;
        this._classify = classify;
        this._questions = new Map();
    }

    async getInitialResultSet(terms, cancellable) {
        const text = terms.join(' ');
        if (!this._available() || text.trim().length < 2)
            return [];
        const intent = asksExplicitly(text) ? null : await this._classify(text, cancellable);
        if (cancellable?.is_cancelled() || !offersAsk(text, intent))
            return [];
        const question = questionText(text);
        const id = `ask:${question}`;
        if (this._questions.size > 50)
            this._questions.clear();
        this._questions.set(id, question);
        return [id];
    }

    getSubsearchResultSet(_previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(ids, _cancellable) {
        return Promise.resolve(ids.map(id => ({
            id,
            name: 'Ask the assistant',
            description: this._questions.get(id) ?? '',
            createIcon: size => new St.Icon({icon_name: ICON, icon_size: size}),
        })));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    activateResult(id, _terms) {
        const question = this._questions.get(id);
        if (question)
            this._onAsk(question);
    }

    launchSearch(_terms) {
    }

    destroy() {
        this._questions.clear();
    }
}

// First of all: when the text is a question, Enter asks it.
export function addAskSection(searchResults, provider) {
    insertSection(searchResults, provider, 0);
}
