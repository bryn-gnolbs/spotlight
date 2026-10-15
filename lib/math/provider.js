// Spotlight: the Calculator section, answering arithmetic as it is typed
// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import St from 'gi://St';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {insertSection} from '../core/sections.js';
import {displayNumber, evaluate, plainNumber} from './expression.js';

const ICON = 'accessories-calculator-symbolic';
// GNOME Calculator's own search provider, which also answers arithmetic.
const GNOME_CALCULATOR_ID = 'org.gnome.Calculator.desktop';

// An in-process GNOME Shell search provider (see lib/memories/provider.js for
// the shape). It answers instantly, without leaving the desktop process, so
// the result is there by the time the last digit is typed.
export class MathSearchProvider {
    constructor() {
        this.id = 'genolabs-math';
        this.isRemoteProvider = false;
        this.canLaunchSearch = false;
        this.appInfo = {
            get_name: () => 'Calculator',
            get_icon: () => new Gio.ThemedIcon({name: ICON}),
            get_id: () => null,
            should_show: () => true,
        };
        this._rows = new Map();
    }

    getInitialResultSet(terms, _cancellable) {
        const result = evaluate(terms.join(' '));
        if (!result)
            return Promise.resolve([]);
        const copy = plainNumber(result.value);
        // The id carries the answer: GNOME reuses a row drawn for an id it has seen.
        const id = `math:${copy}:${result.expression}`;
        if (this._rows.size > 100)
            this._rows.clear();
        this._rows.set(id, {name: displayNumber(result.value), description: result.expression, copy});
        return Promise.resolve([id]);
    }

    getSubsearchResultSet(_previousResults, terms, cancellable) {
        return this.getInitialResultSet(terms, cancellable);
    }

    getResultMetas(ids, _cancellable) {
        return Promise.resolve(ids.map(id => {
            const row = this._rows.get(id) ?? {name: id, description: ''};
            return {
                id,
                name: row.name,
                description: row.description,
                createIcon: size => new St.Icon({icon_name: ICON, icon_size: size}),
            };
        }));
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    // Enter copies the answer, as plain digits ready to paste.
    activateResult(id, _terms) {
        const row = this._rows.get(id);
        if (row)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, row.copy);
    }

    launchSearch(_terms) {
    }

    destroy() {
        this._rows.clear();
    }
}

// First, above Applications: when the text is a calculation, Enter copies the answer.
export function addMathSection(searchResults, provider) {
    insertSection(searchResults, provider, 0);
    // Lets the stylesheet set the answer in bold.
    provider.display.add_style_class_name('spotlight-math');
}

// GNOME Calculator's search provider would show the same answer again, lower
// down. For text Spotlight already answers, it is asked nothing; everything
// else (units, currencies, functions) still goes to GNOME Calculator.
export class CalculatorDeduplicator {
    constructor(searchResults) {
        this._injections = new InjectionManager();
        const proto = remoteProviderPrototype(searchResults);
        if (!proto)
            return;
        // [method, position of the search terms among its arguments]
        for (const [method, termsAt] of [['getInitialResultSet', 0], ['getSubsearchResultSet', 1]]) {
            this._injections.overrideMethod(proto, method, original => function (...args) {
                if (this.id === GNOME_CALCULATOR_ID && evaluate(args[termsAt]?.join(' ')))
                    return Promise.resolve([]);
                return original.apply(this, args);
            });
        }
    }

    destroy() {
        this._injections.clear();
    }
}

// GNOME does not export its D-Bus search provider class, so find the
// prototype that defines the search methods through a loaded instance.
function remoteProviderPrototype(searchResults) {
    let proto = searchResults._providers.find(p => p.isRemoteProvider);
    while (proto && !Object.hasOwn(proto, 'getInitialResultSet'))
        proto = Object.getPrototypeOf(proto);
    return proto ?? null;
}
