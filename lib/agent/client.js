// Spotlight: client for the genolabs agent on the session bus
// SPDX-License-Identifier: GPL-3.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseMemories} from '../memories/model.js';

export const AGENT_BUS_NAME = 'net.genolabs.Agent';
export const AGENT_OBJECT_PATH = '/net/genolabs/Agent';
export const AGENT_INTERFACE = 'net.genolabs.Agent1';

// The agent answers from a local SQLite index in milliseconds; anything slower
// than this is a stuck agent, and Spotlight must never wait on one.
const CALL_TIMEOUT_MS = 1500;

// Errors that only mean "the agent is not running right now".
const AGENT_GONE_ERRORS = [
    'org.freedesktop.DBus.Error.ServiceUnknown',
    'org.freedesktop.DBus.Error.NameHasNoOwner',
    'org.freedesktop.DBus.Error.NoReply',
];

// An agent from before Used existed.
const OLD_AGENT_ERRORS = ['org.freedesktop.DBus.Error.UnknownMethod'];

// Talks to the agent through a Gio.DBusProxy. The proxy is created once,
// asynchronously, and then follows the agent as it starts and stops (the
// proxy's g-name-owner is null while nobody owns the name). Every call is
// async, so the desktop never blocks on the agent.
export class AgentClient {
    constructor() {
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            // The agent is a systemd user service, not D-Bus activated: never
            // try to start it, and only call it while it is running.
            Gio.DBusProxyFlags.DO_NOT_AUTO_START |
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES |
            Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS,
            null,
            AGENT_BUS_NAME,
            AGENT_OBJECT_PATH,
            AGENT_INTERFACE,
            this._cancellable,
            (_source, result) => {
                try {
                    this._proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Spotlight: cannot reach the session bus: ${e.message}`);
                }
            });
    }

    // True while the agent owns its bus name.
    get available() {
        return Boolean(this._proxy?.g_name_owner);
    }

    // Memories matching every word of the query, best first. Resolves to an
    // empty list when the agent is not running or the request was cancelled.
    search(query, limit, cancellable = null) {
        if (!this.available)
            return Promise.resolve([]);
        return new Promise(resolve => {
            this._proxy.call(
                'Search',
                new GLib.Variant('(su)', [query, limit]),
                Gio.DBusCallFlags.NO_AUTO_START,
                CALL_TIMEOUT_MS,
                cancellable,
                (proxy, result) => {
                    try {
                        const [json] = proxy.call_finish(result).deepUnpack();
                        resolve(parseMemories(json));
                    } catch (e) {
                        if (!isQuietError(e))
                            console.warn(`Spotlight: memory search failed: ${e.message}`);
                        resolve([]);
                    }
                });
        });
    }

    // Tell the agent which Search results were used (opened, copied), as
    // {"retrieval", "ids"}, so its memory learns what belongs together. Fire
    // and forget: resolves to how many the agent recorded, 0 when it is not
    // running or too old to know Used.
    used(usage) {
        if (!this.available)
            return Promise.resolve(0);
        return new Promise(resolve => {
            this._proxy.call(
                'Used',
                new GLib.Variant('(s)', [JSON.stringify(usage)]),
                Gio.DBusCallFlags.NO_AUTO_START,
                CALL_TIMEOUT_MS,
                this._cancellable,
                (proxy, result) => {
                    try {
                        const [recorded] = proxy.call_finish(result).deepUnpack();
                        resolve(recorded);
                    } catch (e) {
                        if (!isQuietError(e, OLD_AGENT_ERRORS))
                            console.warn(`Spotlight: telling the agent what was used failed: ${e.message}`);
                        resolve(0);
                    }
                });
        });
    }

    // Ask the assistant. Resolves to the id its answer signals will carry, or
    // null when the agent is not running (or too old to answer questions).
    ask(question) {
        if (!this.available)
            return Promise.resolve(null);
        return new Promise(resolve => {
            this._proxy.call(
                'Ask',
                new GLib.Variant('(s)', [question]),
                Gio.DBusCallFlags.NO_AUTO_START,
                CALL_TIMEOUT_MS,
                this._cancellable,
                (proxy, result) => {
                    try {
                        const [askId] = proxy.call_finish(result).deepUnpack();
                        resolve(askId);
                    } catch (e) {
                        if (!isQuietError(e, OLD_AGENT_ERRORS))
                            console.warn(`Spotlight: asking the agent failed: ${e.message}`);
                        resolve(null);
                    }
                });
        });
    }

    // Stop an answer that is no longer wanted. Fire and forget.
    cancelAsk(askId) {
        if (!this.available || !askId)
            return;
        this._proxy.call('CancelAsk', new GLib.Variant('(s)', [askId]),
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, this._cancellable, (proxy, result) => {
                try {
                    proxy.call_finish(result);
                } catch (_e) {
                    // Already finished, or the agent went away: nothing to stop.
                }
            });
    }

    // Follow answers as they stream: handlers {status(id, text), text(id, chunk),
    // done(id, answer)}. Returns a function that stops listening.
    onAnswer({status = () => {}, text = () => {}, done = () => {}}) {
        const connection = Gio.DBus.session;
        const handlers = {
            AnswerStatus: ([id, value]) => status(id, value),
            AnswerText: ([id, chunk]) => text(id, chunk),
            AnswerDone: ([id, json]) => {
                let answer;
                try {
                    answer = JSON.parse(json);
                } catch (_e) {
                    answer = {text: '', sources: [], error: 'The agent sent an answer that could not be read'};
                }
                done(id, answer);
            },
        };
        const ids = Object.entries(handlers).map(([signal, handler]) =>
            connection.signal_subscribe(AGENT_BUS_NAME, AGENT_INTERFACE, signal, AGENT_OBJECT_PATH,
                null, Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, parameters) => handler(parameters.deepUnpack())));
        return () => ids.forEach(id => connection.signal_unsubscribe(id));
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy = null;
    }
}

function isQuietError(error, alsoQuiet = []) {
    if (!(error instanceof GLib.Error))
        return false;
    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return true;
    const remote = Gio.DBusError.get_remote_error(error);
    return AGENT_GONE_ERRORS.includes(remote) || alsoQuiet.includes(remote);
}
