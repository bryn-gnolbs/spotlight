// A stand-in for the genolabs agent (net.genolabs.Agent), used by the unit
// tests and the smoke test. Like the real agent, Search matches memories
// containing every word of the query. Only ever run on a private test bus.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const BUS_NAME = 'net.genolabs.Agent';
const OBJECT_PATH = '/net/genolabs/Agent';
const USED_XML = `
    <method name="Used">
      <arg type="s" name="usage_json" direction="in"/>
      <arg type="u" name="recorded" direction="out"/>
    </method>`;
const ASK_XML = `
    <method name="Intent">
      <arg type="s" name="text" direction="in"/>
      <arg type="s" name="intent_json" direction="out"/>
    </method>
    <method name="Ask">
      <arg type="s" name="question" direction="in"/>
      <arg type="s" name="ask_id" direction="out"/>
    </method>
    <method name="CancelAsk">
      <arg type="s" name="ask_id" direction="in"/>
      <arg type="b" name="cancelled" direction="out"/>
    </method>
    <signal name="AnswerStatus"><arg type="s" name="ask_id"/><arg type="s" name="status"/></signal>
    <signal name="AnswerText"><arg type="s" name="ask_id"/><arg type="s" name="text"/></signal>
    <signal name="AnswerDone"><arg type="s" name="ask_id"/><arg type="s" name="answer_json"/></signal>`;
const agentXml = withUsed => `
<node>
  <interface name="net.genolabs.Agent1">${withUsed ? ASK_XML : ''}
    <method name="Status">
      <arg type="s" name="status_json" direction="out"/>
    </method>
    <method name="Search">
      <arg type="s" name="query" direction="in"/>
      <arg type="u" name="limit" direction="in"/>
      <arg type="s" name="memories_json" direction="out"/>
    </method>${withUsed ? USED_XML : ''}
  </interface>
</node>`;

export class FakeAgent {
    /**
     * @param {object[]} memories - what Search answers from
     * @param {object} [options]
     * @param {boolean} [options.withUsed] - false plays an agent from before Used
     */
    constructor(memories, {withUsed = true} = {}) {
        this.memories = memories;
        this.withUsed = withUsed;
        // Set to a string to add it to every Search result as "retrieval", like
        // the long-term memory does; null answers like the offline fallback.
        this.retrieval = null;
        // Every Used call, parsed.
        this.used = [];
        // Every Search call as [query, limit], so tests can count requests.
        this.queries = [];
        // Set to a string to answer every Search with it instead (e.g. bad JSON).
        this.reply = null;
        // How Ask answers: the text arrives in these chunks, then Done with the
        // memories matching the question as sources. Set error to fail instead.
        this.answerChunks = ['It is due ', 'on Friday.'];
        this.answerError = null;
        // Every Ask as its question, and every CancelAsk id.
        this.asked = [];
        this.cancelledAsks = [];
        // Every Intent call's text. Intent says a text is for the assistant when
        // it starts with one of these words (the real agent uses a model).
        this.intents = [];
        this.assistantWords = ['when', 'what', 'turn', 'set'];
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
        const results = matches.slice(0, limit);
        return JSON.stringify(this.retrieval === null ? results : results.map(m => ({...m, retrieval: this.retrieval})));
    }

    Used(usageJson) {
        const usage = JSON.parse(usageJson);
        this.used.push(usage);
        return usage.ids.length;
    }

    Intent(text) {
        this.intents.push(text);
        const forAssistant = this.assistantWords.includes(text.trim().toLowerCase().split(/\s+/)[0]);
        return JSON.stringify(forAssistant
            ? {intent: 'ask', confidence: 0.9, assistant: 0.9, by: 'model'}
            : {intent: 'find', confidence: 0.9, assistant: 0.1, by: 'model'});
    }

    Ask(question) {
        this.asked.push(question);
        const id = `ask${this.asked.length}`;
        const signals = [['AnswerStatus', [id, 'Searching memories']]];
        if (!this.answerError)
            signals.push(...this.answerChunks.map(chunk => ['AnswerText', [id, chunk]]));
        const words = question.toLowerCase().split(/\s+/).filter(Boolean);
        const sources = this.memories.filter(m => words.some(w => m.text.toLowerCase().includes(w)));
        signals.push(['AnswerDone', [id, JSON.stringify({
            text: this.answerError ? '' : this.answerChunks.join(''), sources: sources.slice(0, 3),
            model: 'fake', error: this.answerError, cancelled: false,
        })]]);
        // After the reply, one signal at a time, like a model writing.
        let delay = 30;
        for (const [name, args] of signals) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                if (!this.cancelledAsks.includes(id))
                    this._exported?.emit_signal(name, new GLib.Variant('(ss)', args));
                return GLib.SOURCE_REMOVE;
            });
            delay += 30;
        }
        return id;
    }

    CancelAsk(id) {
        this.cancelledAsks.push(id);
        return true;
    }

    /** Export on the session bus and own the agent's name. */
    start() {
        const connection = Gio.DBus.session;
        this._exported = Gio.DBusExportedObject.wrapJSObject(agentXml(this.withUsed), this);
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
