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

    destroy() {
        this._cancellable.cancel();
        this._proxy = null;
    }
}

function isQuietError(error) {
    if (!(error instanceof GLib.Error))
        return false;
    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return true;
    return AGENT_GONE_ERRORS.includes(Gio.DBusError.get_remote_error(error));
}
