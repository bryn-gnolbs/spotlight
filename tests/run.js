// Unit tests for the shell-independent modules. Run with `make test`
// (dbus-run-session -- gjs -m tests/run.js): the agent client tests own a
// fake agent on that private bus. Exits non-zero if any test fails.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {AgentClient} from '../lib/agent/client.js';
import {waitUnlessCancelled} from '../lib/core/timing.js';
import {displayNumber, evaluate, plainNumber} from '../lib/math/expression.js';
import {
    isWebLink, linkHost, memoryDetails, memoryName, memoryRows, memoryUsage, parseMemories,
    primaryAction, relativeTime, shorten,
} from '../lib/memories/model.js';
import {FakeAgent} from './fakeAgent.js';

const tests = [];
const test = (name, fn) => tests.push({name, fn});

function assertEqual(actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`expected ${e}\n         got ${a}`);
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(condition, timeoutMs = 3000) {
    for (let waited = 0; !condition(); waited += 20) {
        if (waited >= timeoutMs)
            throw new Error('timed out waiting');
        await sleep(20);
    }
}

// console.warn is read-only in GJS, so catch warnings where they end up: in
// GLib's log. They are still printed.
const warnings = [];
GLib.log_set_writer_func((_level, fields) => {
    const message = new TextDecoder().decode(fields.MESSAGE ?? new Uint8Array());
    warnings.push(message);
    printerr(message);
    return GLib.LogWriterOutput.HANDLED;
});

const memory = (fields = {}) => ({
    id: 'm1', time: '2026-10-15T09:00:00.000Z', origin: 'screenvision', text: '',
    links: [], emails: [], codes: [], image: null, app: '', title: '', retrieval: '', ...fields,
});

// Model --------------------------------------------------------------------

test('parseMemories keeps valid memories and fills missing fields', () => {
    const json = JSON.stringify([
        {id: 'a', time: 't', text: 'hello', links: ['https://example.com', 'javascript:alert(1)', 'file:///etc/passwd'],
            image: '/home/me/shot.png', app: 'Firefox', title: 'Example', retrieval: 'r1'},
        {id: 'b'},
        {id: ''},
        {text: 'no id'},
        null,
        'string',
        {id: 'c', image: 'relative.png', links: 'not a list', text: 42, retrieval: 7},
    ]);
    assertEqual(parseMemories(json), [
        {id: 'a', time: 't', text: 'hello', links: ['https://example.com'], image: '/home/me/shot.png', app: 'Firefox', title: 'Example',
            retrieval: 'r1'},
        {id: 'b', time: '', text: '', links: [], image: null, app: '', title: '', retrieval: ''},
        {id: 'c', time: '', text: '', links: [], image: null, app: '', title: '', retrieval: ''},
    ]);
});

test('parseMemories rejects non-lists and bad JSON', () => {
    assertEqual(parseMemories('{"id": "a"}'), []);
    let threw = false;
    try {
        parseMemories('not json');
    } catch {
        threw = true;
    }
    assertEqual(threw, true);
});

test('isWebLink only accepts http and https', () => {
    assertEqual(['https://a.io/x', 'http://b.org', 'HTTPS://C.COM', 'ftp://x', 'mailto:a@b.c', 'https://', 'https:// space', 42]
        .map(isWebLink), [true, true, true, false, false, false, false, false]);
});

test('linkHost drops www and keeps unparsable input', () => {
    assertEqual(linkHost('https://www.github.com/bryn'), 'github.com');
    assertEqual(linkHost('http://example.com:8080/'), 'example.com');
    assertEqual(linkHost('not a url'), 'not a url');
});

test('shorten cuts at a word boundary', () => {
    assertEqual(shorten('short', 10), 'short');
    assertEqual(shorten('the quick brown fox jumps', 16), 'the quick brown…');
    assertEqual(shorten('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghi…');
});

test('relativeTime speaks plainly', () => {
    const now = new Date(2026, 9, 15, 18, 30);
    const at = (...args) => new Date(...args).toISOString();
    assertEqual(relativeTime(at(2026, 9, 15, 18, 29, 40), now), 'just now');
    assertEqual(relativeTime(at(2026, 9, 15, 18, 29), now), '1 minute ago');
    assertEqual(relativeTime(at(2026, 9, 15, 18, 5), now), '25 minutes ago');
    assertEqual(relativeTime(at(2026, 9, 15, 17, 20), now), '1 hour ago');
    assertEqual(relativeTime(at(2026, 9, 15, 8, 0), now), '10 hours ago');
    assertEqual(relativeTime(at(2026, 9, 14, 23, 0), now), 'yesterday');
    assertEqual(relativeTime(at(2026, 9, 11, 12, 0), now), '4 days ago');
    assertEqual(relativeTime(at(2026, 9, 2, 12, 0), now), '2 Oct');
    assertEqual(relativeTime(at(2025, 11, 24, 12, 0), now), '24 Dec 2025');
    assertEqual(relativeTime('garbage', now), '');
});

test('memoryName uses the first line of text, then the link, then the window', () => {
    assertEqual(memoryName(memory({text: '\n  Invoice   #42 \nsecond line'})), 'Invoice #42');
    assertEqual(memoryName(memory({links: ['https://www.example.com/a']})), 'example.com');
    assertEqual(memoryName(memory({title: 'Photos', app: 'Loupe'})), 'Photos');
    assertEqual(memoryName(memory({app: 'Loupe'})), 'Loupe');
    assertEqual(memoryName(memory()), 'Screenshot');
});

test('memoryDetails says where and when', () => {
    const now = new Date('2026-10-15T11:00:00.000Z');
    assertEqual(memoryDetails(memory({app: 'Firefox', title: 'Docs'}), now), 'Firefox · 2 hours ago');
    assertEqual(memoryDetails(memory({title: 'Docs'}), now), 'Docs · 2 hours ago');
    assertEqual(memoryDetails(memory({time: ''}), now), '');
});

test('primaryAction copies text, else opens the link, else the screenshot', () => {
    assertEqual(primaryAction(memory({text: 'hi', links: ['https://a.io']})), {kind: 'copy', text: 'hi'});
    assertEqual(primaryAction(memory({text: '  ', links: ['https://a.io'], image: '/p/s.png'})), {kind: 'open', uri: 'https://a.io'});
    assertEqual(primaryAction(memory({image: '/p/my shot.png'})), {kind: 'open', uri: 'file:///p/my%20shot.png'});
    assertEqual(primaryAction(memory()), null);
});

test('memoryRows offers the best match\'s links and screenshot as follow-ups', () => {
    const now = new Date('2026-10-15T09:30:00.000Z');
    const rows = memoryRows([
        memory({id: 'a', text: 'Read https://example.com', links: ['https://example.com', 'https://b.org', 'https://c.net'],
            image: '/s/a.png', app: 'Firefox'}),
        memory({id: 'b', text: 'second', links: ['https://d.io'], image: '/s/b.png'}),
        memory({id: 'empty'}),
    ], now);
    assertEqual(rows.map(r => [r.id, r.name, r.description, r.icon]), [
        ['a', 'Read https://example.com', 'Firefox · 30 minutes ago', 'edit-copy-symbolic'],
        ['a#link0', 'Open example.com', 'https://example.com', 'web-browser-symbolic'],
        ['a#link1', 'Open b.org', 'https://b.org', 'web-browser-symbolic'],
        ['a#image', 'Open screenshot', 'a.png', 'image-x-generic-symbolic'],
        ['b', 'second', '30 minutes ago', 'edit-copy-symbolic'],
    ]);
    assertEqual(rows[3].action, {kind: 'open', uri: 'file:///s/a.png'});
});

test('memoryRows does not repeat the primary action as a follow-up', () => {
    const rows = memoryRows([memory({id: 'a', links: ['https://a.io'], image: '/s/a.png'})]);
    assertEqual(rows.map(r => r.id), ['a', 'a#image']);
    assertEqual(memoryRows([memory({id: 'b', image: '/s/b.png'})]).map(r => r.id), ['b']);
});

test('every row of a memory reports that memory as used', () => {
    assertEqual(memoryUsage(memory({id: 'a', retrieval: 'r1'})), {retrieval: 'r1', ids: ['a']});
    assertEqual(memoryUsage(memory({id: 'a'})), {ids: ['a']});
    const rows = memoryRows([
        memory({id: 'a', text: 'x', links: ['https://a.io'], image: '/s/a.png', retrieval: 'r1'}),
        memory({id: 'b', text: 'y', retrieval: 'r1'}),
    ]);
    assertEqual(rows.map(r => [r.id, r.usage]), [
        ['a', {retrieval: 'r1', ids: ['a']}],
        ['a#link0', {retrieval: 'r1', ids: ['a']}],
        ['a#image', {retrieval: 'r1', ids: ['a']}],
        ['b', {retrieval: 'r1', ids: ['b']}],
    ]);
});

// Inline math ---------------------------------------------------------------

const calc = text => {
    const result = evaluate(text);
    return result && [plainNumber(result.value), result.expression];
};

test('evaluate does arithmetic with the usual precedence', () => {
    assertEqual(calc('12*7'), ['84', '12 × 7']);
    assertEqual(calc(' 2 + 3 * 4 '), ['14', '2 + 3 × 4']);
    assertEqual(calc('(2 + 3) * 4'), ['20', '(2 + 3) × 4']);
    assertEqual(calc('10 / 4'), ['2.5', '10 ÷ 4']);
    assertEqual(calc('10 - 2 - 3'), ['5', '10 − 2 − 3']);
    assertEqual(calc('-5 + 2'), ['-3', '−5 + 2']);
    assertEqual(calc('2^10'), ['1024', '2^10']);
    assertEqual(calc('2**3**2'), ['512', '2^3^2']);
    assertEqual(calc('-2^2'), ['-4', '−2^2']);
    assertEqual(calc('2^-1'), ['0.5', '2^−1']);
    assertEqual(calc('.5 + 1.25'), ['1.75', '.5 + 1.25']);
});

test('evaluate accepts the symbols people type', () => {
    assertEqual(calc('12×7'), ['84', '12 × 7']);
    assertEqual(calc('12 x 7'), ['84', '12 × 7']);
    assertEqual(calc('84÷12'), ['7', '84 ÷ 12']);
    assertEqual(calc('9 − 4'), ['5', '9 − 4']);
    assertEqual(calc('1,000 * 3'), ['3000', '1,000 × 3']);
});

test('evaluate reads percentages the way people say them', () => {
    assertEqual(calc('15% of 80'), ['12', '15% of 80']);
    assertEqual(calc('80 + 15%'), ['92', '80 + 15%']);
    assertEqual(calc('80 - 10%'), ['72', '80 − 10%']);
    assertEqual(calc('80 * 15%'), ['12', '80 × 15%']);
    assertEqual(calc('15%'), ['0.15', '15%']);
    assertEqual(calc('(50 + 50) of 2'), null);
});

test('evaluate ignores text that is not a calculation', () => {
    for (const text of ['', '42', '-42', '(42)', 'settings', 'firefox 2', '12*', '*12', '(1 + 2', '1 + 2)',
        '1,5 + 1', '1/0', '0/0', 'x 7', 'sqrt(9)', '2 of 3', 'offset 1+1', '10 usd to aud', 'eval(1+1)', '1;2'])
        assertEqual([text, evaluate(text)], [text, null]);
    assertEqual(evaluate(null), null);
});

test('numbers are copied plain and shown grouped', () => {
    assertEqual(plainNumber(0.1 + 0.2), '0.3');
    assertEqual(plainNumber(1234567.5), '1234567.5');
    assertEqual(plainNumber(-0), '0');
    assertEqual(plainNumber(2 ** 70), '1.18059162072e+21');
    assertEqual(displayNumber(1234567.5), '1,234,567.5');
    assertEqual(displayNumber(-1234), '−1,234');
    assertEqual(displayNumber(84), '84');
    assertEqual(displayNumber(2 ** 70), '1.18059162072e+21');
});

// Typing pause --------------------------------------------------------------

test('waitUnlessCancelled resolves true after the pause', async () => {
    const start = GLib.get_monotonic_time();
    assertEqual(await waitUnlessCancelled(50, new Gio.Cancellable()), true);
    if (GLib.get_monotonic_time() - start < 45000)
        throw new Error('returned before the pause');
    assertEqual(await waitUnlessCancelled(10, null), true);
});

test('waitUnlessCancelled resolves false as soon as a keystroke cancels', async () => {
    const cancellable = new Gio.Cancellable();
    const start = GLib.get_monotonic_time();
    const waiting = waitUnlessCancelled(5000, cancellable);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        cancellable.cancel();
        return GLib.SOURCE_REMOVE;
    });
    assertEqual(await waiting, false);
    if (GLib.get_monotonic_time() - start > 1000000)
        throw new Error('waited for the full pause');

    const cancelled = new Gio.Cancellable();
    cancelled.cancel();
    assertEqual(await waitUnlessCancelled(5000, cancelled), false);
});

// Agent client --------------------------------------------------------------

test('AgentClient degrades to no results while the agent is not running', async () => {
    const client = new AgentClient();
    await sleep(200);
    assertEqual(client.available, false);
    assertEqual(await client.search('anything', 5), []);
    client.destroy();
});

test('AgentClient searches the agent once it appears, and stops when it goes', async () => {
    const client = new AgentClient();
    await sleep(100);
    const agent = new FakeAgent([
        memory({id: 'x', text: 'ScreenVision reads this 2026', links: ['https://example.com', 'javascript:bad']}),
        memory({id: 'y', text: 'Something else'}),
    ]);
    await agent.start();
    try {
        await waitFor(() => client.available);
        const found = await client.search('screenvision 2026', 7);
        assertEqual(found.map(m => [m.id, m.links]), [['x', ['https://example.com']]]);
        assertEqual(agent.queries, [['screenvision 2026', 7]]);

        // A cancelled request resolves quietly with nothing.
        const cancellable = new Gio.Cancellable();
        cancellable.cancel();
        assertEqual(await client.search('screenvision', 7, cancellable), []);

        // A broken answer is dropped, not shown.
        agent.reply = 'not json';
        assertEqual(await client.search('screenvision', 7), []);
    } finally {
        agent.stop();
    }
    await waitFor(() => !client.available);
    assertEqual(await client.search('screenvision', 7), []);
    client.destroy();
});

test('AgentClient tells the agent which results were used', async () => {
    const client = new AgentClient();
    assertEqual(await client.used({ids: ['x']}), 0);   // no agent yet: nothing to tell
    const agent = new FakeAgent([memory({id: 'x', text: 'ScreenVision'})]);
    agent.retrieval = 'r1';
    await agent.start();
    try {
        await waitFor(() => client.available);
        const [found] = await client.search('screenvision', 5);
        assertEqual(found.retrieval, 'r1');
        assertEqual(await client.used(memoryUsage(found)), 1);
        // Offline fallback results have no retrieval id: the ids alone still teach.
        assertEqual(await client.used({ids: ['x', 'y']}), 2);
        assertEqual(agent.used, [{retrieval: 'r1', ids: ['x']}, {ids: ['x', 'y']}]);
    } finally {
        agent.stop();
    }
    await waitFor(() => !client.available);
    client.destroy();
});

test('AgentClient.used is quiet with an agent from before Used', async () => {
    const client = new AgentClient();
    const agent = new FakeAgent([memory({id: 'x', text: 'ScreenVision'})], {withUsed: false});
    await agent.start();
    try {
        await waitFor(() => client.available);
        const before = warnings.length;
        assertEqual(await client.used({ids: ['x']}), 0);
        assertEqual(warnings.slice(before), []);
        assertEqual(agent.used, []);
    } finally {
        agent.stop();
    }
    await waitFor(() => !client.available);
    client.destroy();
});

// Runner --------------------------------------------------------------------

async function main() {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            await fn();
            print(`ok    ${name}`);
        } catch (e) {
            failed++;
            print(`FAIL  ${name}\n      ${e.message}`);
        }
    }
    print(`\n${tests.length - failed} passed, ${failed} failed`);
    return failed;
}

if (!Gio.DBus.session)
    throw new Error('No session bus: run with dbus-run-session (make test)');

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
main().then(failed => {
    exitCode = failed > 0 ? 1 : 0;
}).catch(e => {
    printerr(e.stack);
    exitCode = 1;
}).finally(() => loop.quit());
loop.run();
System.exit(exitCode);
