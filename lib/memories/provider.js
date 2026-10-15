// Spotlight: the Memories section, answered by the genolabs agent
// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import St from 'gi://St';

import {AgentClient} from '../agent/client.js';
import {insertSection} from '../core/sections.js';
import {waitUnlessCancelled} from '../core/timing.js';
import {memoryRows} from './model.js';

// Wait for a short pause in typing before asking the agent.
const TYPING_PAUSE_MS = 120;
const SEARCH_LIMIT = 20;

// An in-process GNOME Shell search provider, shown like every other section
// (Applications, Settings, Files) inside the stolen Overview search view.
// GNOME Shell calls these methods; the shape is defined by search.js.
export class MemorySearchProvider {
    constructor() {
        this.id = 'genolabs-memories';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;
        // GNOME draws a list section (rather than an icon grid) for providers
        // that have an appInfo, and takes the section's name and icon from it.
        this.appInfo = {
            get_name: () => 'Memories',
            get_icon: () => new Gio.ThemedIcon({name: 'document-open-recent-symbolic'}),
            get_id: () => null,
            should_show: () => true,
        };
        this._client = new AgentClient();
        this._rows = new Map();
        this._destroyed = false;
    }

    async getInitialResultSet(terms, cancellable) {
        const query = terms.join(' ').trim();
        if (query === '' || !this._client.available)
            return [];
        if (!await waitUnlessCancelled(TYPING_PAUSE_MS, cancellable))
            return [];
        const memories = await this._client.search(query, SEARCH_LIMIT, cancellable);
        if (this._destroyed) {
            // The section was removed while we waited. Never settle, so GNOME
            // does not try to update a display that no longer exists.
            return new Promise(() => {});
        }
        if (cancellable.is_cancelled())
            return [];
        const rows = memoryRows(memories);
        this._rows = new Map(rows.map(row => [row.id, row]));
        return rows.map(row => row.id);
    }

    // Typing more narrows the words, which changes the ranking, so ask again.
    getSubsearchResultSet(_previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(ids, _cancellable) {
        // GNOME requires exactly one meta per id, each with a name.
        return Promise.resolve(ids.map(id => {
            const row = this._rows.get(id) ?? {id, name: id, description: '', icon: 'edit-copy-symbolic'};
            return {
                id,
                name: row.name,
                description: row.description,
                createIcon: size => new St.Icon({icon_name: row.icon, icon_size: size}),
            };
        }));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    activateResult(id, _terms) {
        const row = this._rows.get(id);
        const action = row?.action;
        if (action?.kind === 'copy') {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, action.text);
        } else if (action?.kind === 'open') {
            try {
                Gio.AppInfo.launch_default_for_uri(action.uri, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.warn(`Spotlight: cannot open ${action.uri}: ${e.message}`);
            }
        }
        // Only after the action, and never awaited: tell the agent what was
        // used so its memory learns from it.
        if (row)
            this._client.used(row.usage);
    }

    launchSearch(_terms) {
    }

    destroy() {
        this._destroyed = true;
        this._client.destroy();
        this._rows.clear();
    }
}

// Right after Applications, so an app match still wins Enter.
export function addMemoriesSection(searchResults, provider) {
    const index = searchResults._providers.findIndex(p => p.id === 'applications') + 1;
    insertSection(searchResults, provider, index);
}
