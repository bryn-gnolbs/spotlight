// A stand-in for the genolabs agent (net.genolabs.Agent), used by the unit
// tests and the smoke test. Like the real agent, Search matches memories
// containing every word of the query. Only ever run on a private test bus.

import Gio from 'gi://Gio';

const BUS_NAME = 'net.genolabs.Agent';
const OBJECT_PATH = '/net/genolabs/Agent';
const AGENT_XML = `
<node>
  <interface name="net.genolabs.Agent1">
    <method name="Status">
      <arg type="s" name="status_json" direction="out"/>
    </method>
    <method name="Search">
      <arg type="s" name="query" direction="in"/>
      <arg type="u" name="limit" direction="in"/>
      <arg type="s" name="memories_json" direction="out"/>
    </method>
  </interface>
</node>`;

export class FakeAgent {
    /** @param {object[]} memories - what Search answers from */
    constructor(memories) {
        this.memories = memories;
        // Every Search call as [query, limit], so tests can count requests.
        this.queries = [];
        // Set to a string to answer every Search with it instead (e.g. bad JSON).
        this.reply = null;
        this._exported = null;
        this._ownerId = 0;
    }

    Status() {
        return JSON.stringify({version: 'fake', memories: this.memories.length});
    }

    Search(query, limit) {
        this.queries.push([query, limit]);
        if (this.reply !== null)
            return this.reply;
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = this.memories.filter(m => words.every(w => m.text.toLowerCase().includes(w)));
        return JSON.stringify(matches.slice(0, limit));
    }

    /** Export on the session bus and own the agent's name. */
    start() {
        const connection = Gio.DBus.session;
        this._exported = Gio.DBusExportedObject.wrapJSObject(AGENT_XML, this);
        this._exported.export(connection, OBJECT_PATH);
        return new Promise((resolve, reject) => {
            this._ownerId = Gio.bus_own_name_on_connection(connection, BUS_NAME,
                Gio.BusNameOwnerFlags.NONE,
                () => resolve(),
                () => reject(new Error(`could not own ${BUS_NAME}`)));
        });
    }

    stop() {
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
        this._exported?.unexport();
        this._exported = null;
    }
}
