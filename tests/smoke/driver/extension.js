// Scripted end-to-end check, loaded next to Spotlight inside a headless
// GNOME Shell (see run.sh). It opens Spotlight with the keyboard, searches,
// starts a fake genolabs agent on the private bus, and reports what happened
// as "SMOKE <name> <json>" lines in the shell log.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FakeAgent} from './fakeAgent.js';

const UUID = 'spotlight@genolabs.net';
const OUT_DIR = GLib.getenv('SPOTLIGHT_SMOKE_OUT');
const SAMPLE_TEXT = 'ScreenVision reads this 2026';

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));
const report = (name, value) => console.log(`SMOKE ${name} ${JSON.stringify(value)}`);
const check = (name, ok, detail) => report(ok ? `PASS ${name}` : `FAIL ${name}`, detail);

async function saveScreenshot(name) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([OUT_DIR, name]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
            try {
                resolve(shooter.screenshot_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    stream.close(null);
}

// Created once, early: key presses sent right after creating a virtual
// device can be dropped before the device is fully set up.
let keyboard = null;

async function pressKeys(keyvals) {
    const now = () => GLib.get_monotonic_time();
    for (const keyval of keyvals)
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
    for (const keyval of [...keyvals].reverse())
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
    await sleep(600);
}

// A key held for a moment, as a person types (press and release are separate events).
async function tapKey(keyval, holdMs = 90) {
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
    await sleep(holdMs);
    keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    await sleep(600);
}

async function typeText(text) {
    for (const char of text) {
        const keyval = Clutter.unicode_to_keysym(char.codePointAt(0));
        const shifted = char !== char.toLowerCase();
        await pressKeys(shifted ? [Clutter.KEY_Shift_L, keyval] : [keyval]);
    }
}

const clipboardText = () => new Promise(resolve =>
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => resolve(text)));

// Row titles currently shown in a provider's section.
function sectionRows(provider) {
    const display = provider?.display;
    if (!display?.visible)
        return [];
    // List sections keep rows in _content, icon grids (Applications) in _grid.
    return (display._content ?? display._grid).get_children()
        .filter(row => row.visible)
        .map(row => row.label_actor?.text ?? row.icon?.label?.text ?? '');
}

function findRow(provider, title) {
    return provider.display._content.get_children().find(row => row.label_actor?.text === title);
}

async function search(entry, text, settleMs = 900) {
    entry.set_text('');
    await sleep(100);
    entry.set_text(text);
    await sleep(settleMs);
}

async function run() {
    keyboard = Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    await sleep(2500);
    const info = Main.extensionManager.lookup(UUID);
    check('extension enabled', info?.state === 1, info?.error ?? info?.state);
    const ext = () => Main.extensionManager.lookup(UUID).stateObj;
    const popup = () => ext()._popup;
    const results = () => popup().searchResults;
    const memories = () => ext()._memories;
    const apps = () => results()._providers.find(p => p.id === 'applications');
    const math = () => ext()._math;
    const ask = () => ext()._ask;
    const answers = () => ext()._answers;
    const gnomeCalculator = () => results()._providers.find(p => p.id === 'org.gnome.Calculator.desktop');
    const order = () => results()._providers.map(p => p.id);

    check('Ask first, then Calculator, Applications, Memories',
        results()._providers[0] === ask() && results()._providers[1] === math() &&
        results()._providers[2]?.id === 'applications' && results()._providers[3] === memories(), order());
    check('Memories header is not a launcher', memories().display.providerInfo.reactive === false);

    // Stock GNOME binds Super+Space to input-source switching, which blocks the grab.
    const grabbed = () => Object.values(ext()._keybindingManager._grabbers).map(g => g.accelerator);
    check('the clash is detected, not silently ignored', grabbed().length === 0, grabbed());
    new Gio.Settings({schema_id: 'org.gnome.desktop.wm.keybindings'}).set_strv('switch-input-source', []);
    await sleep(500);
    const settings = ext()._settings;
    settings.set_strv('toggle-shortcut', ['<Control>space']);
    settings.reset('toggle-shortcut');
    await sleep(300);
    check('Super+Space is grabbed once free', JSON.stringify(grabbed()) === '["<Super>space"]', grabbed());

    // Open with the keyboard, like a person would.
    await pressKeys([Clutter.KEY_Super_L, Clutter.KEY_space]);
    check('Super+Space opens Spotlight', popup()._visible && popup().visible);
    const entry = popup()._stealer.entry;
    const focus = global.stage.get_key_focus();
    check('the search field has the keyboard', focus !== null && entry.contains(focus), String(focus));

    // Original features: apps and system actions come from GNOME's providers.
    await typeText('settings');
    check('typing finds apps', sectionRows(apps()).includes('Settings'), sectionRows(apps()));
    await search(entry, 'lock');
    check('system actions still found', sectionRows(apps()).some(t => /lock/i.test(t)), sectionRows(apps()));
    check('words are not calculations', sectionRows(math()).length === 0, sectionRows(math()));

    // Inline math: the answer is there as soon as the expression is complete.
    await search(entry, '');
    await typeText('12*7');
    check('typing 12*7 answers 84', JSON.stringify(sectionRows(math())) === '["84"]', sectionRows(math()));
    check('the answer shows the expression as understood',
        findRow(math(), '84')?._descriptionLabel?.text === '12 × 7', findRow(math(), '84')?._descriptionLabel?.text);
    // GNOME Calculator would repeat the answer lower down; give it time to try.
    await sleep(1500);
    check('GNOME Calculator does not repeat it', sectionRows(gnomeCalculator()).length === 0,
        gnomeCalculator() ? sectionRows(gnomeCalculator()) : 'GNOME Calculator not installed');
    await saveScreenshot('math.png');
    await search(entry, '15% of 80');
    check('percentages read naturally', JSON.stringify(sectionRows(math())) === '["12"]', sectionRows(math()));
    await search(entry, '1234567 * 3');
    check('large answers are grouped', JSON.stringify(sectionRows(math())) === '["3,703,701"]', sectionRows(math()));
    if (gnomeCalculator()) {
        // What Spotlight does not answer still reaches GNOME Calculator.
        await search(entry, 'sqrt(16)', 3000);
        check('GNOME Calculator still answers the rest', sectionRows(math()).length === 0 &&
            sectionRows(gnomeCalculator()).length > 0, sectionRows(gnomeCalculator()));
    }
    await search(entry, '12*7');
    entry.grab_key_focus();
    await tapKey(Clutter.KEY_Return);
    check('Enter copies the plain answer', await clipboardText() === '84', await clipboardText());
    check('Enter on a calculation closes Spotlight', !popup()._visible);
    await pressKeys([Clutter.KEY_Super_L, Clutter.KEY_space]);

    // No agent on this bus yet: the section stays hidden and nothing breaks.
    await search(entry, 'screenvision');
    check('no agent: Memories stays hidden', sectionRows(memories()).length === 0 && !memories().display.visible);
    check('no agent: popup still works', popup()._visible);

    const now = Date.now();
    const agent = new FakeAgent([
        {id: 'm-text', time: new Date(now - 5 * 60e3).toISOString(), origin: 'screenvision', text: SAMPLE_TEXT,
            links: [], emails: [], codes: [], image: null, app: 'Claude', title: 'Claude'},
        {id: 'm-link', time: new Date(now - 26 * 3600e3).toISOString(), origin: 'screenvision',
            text: 'Release notes at https://example.com/notes', links: ['https://example.com/notes'], emails: [],
            codes: [], image: GLib.build_filenamev([OUT_DIR, 'shot.png']), app: 'Firefox', title: 'Notes'},
    ]);
    agent.retrieval = 'r-smoke';
    await agent.start();
    for (let i = 0; i < 50 && !memories()._client.available; i++)
        await sleep(100);
    check('agent noticed when it starts', memories()._client.available);

    await search(entry, 'screenvision');
    check('typing a remembered word shows the memory', JSON.stringify(sectionRows(memories())) === JSON.stringify([SAMPLE_TEXT]),
        sectionRows(memories()));
    check('memory row says where and when',
        findRow(memories(), SAMPLE_TEXT)?._descriptionLabel?.text === 'Claude · 5 minutes ago',
        findRow(memories(), SAMPLE_TEXT)?._descriptionLabel?.text);
    await saveScreenshot('memories.png');

    // Typing quickly sends one request for the word the user paused on.
    entry.set_text('');
    await sleep(200);
    const before = agent.queries.length;
    for (const prefix of ['s', 'sc', 'scr', 'scre', 'scree', 'screen', 'screenv', 'screenvi']) {
        entry.set_text(prefix);
        await sleep(40);
    }
    await sleep(900);
    const sent = agent.queries.slice(before).map(([q]) => q);
    check('typing is debounced', sent.length <= 2 && sent.at(-1) === 'screenvi', sent);

    // Enter copies the memory's text and closes.
    await search(entry, 'screenvision');
    entry.grab_key_focus();
    await pressKeys([Clutter.KEY_Return]);
    check('Enter copies the memory text', await clipboardText() === SAMPLE_TEXT, await clipboardText());
    check('Enter closes Spotlight', !popup()._visible);
    await sleep(200);
    check('Enter tells the agent the memory was used',
        JSON.stringify(agent.used) === JSON.stringify([{retrieval: 'r-smoke', ids: ['m-text']}]), agent.used);

    // The best match offers its link and screenshot; opening goes to the default app.
    const opened = [];
    const realLaunch = Gio.AppInfo.launch_default_for_uri;
    Gio.AppInfo.launch_default_for_uri = uri => opened.push(uri);
    try {
        popup().open();
        await sleep(600);
        await search(popup()._stealer.entry, 'release notes');
        const rows = sectionRows(memories());
        check('best match offers its link and screenshot',
            JSON.stringify(rows) === JSON.stringify(['Release notes at https://example.com/notes', 'Open example.com', 'Open screenshot']),
            rows);
        await saveScreenshot('memory-actions.png');
        // Down moves from the best match to its first follow-up; Enter opens it.
        await tapKey(Clutter.KEY_Down);
        check('arrow keys reach the follow-up rows', global.stage.get_key_focus() === findRow(memories(), 'Open example.com'),
            String(global.stage.get_key_focus()));
        await tapKey(Clutter.KEY_Return);
        check('link row opens the link', opened[0] === 'https://example.com/notes', opened);
        check('activating a row closes Spotlight', !popup()._visible);
        await sleep(200);
        check('opening a follow-up row tells the agent its memory was used',
            JSON.stringify(agent.used.at(-1)) === JSON.stringify({retrieval: 'r-smoke', ids: ['m-link']}), agent.used);
        popup().open();
        await sleep(600);
        await search(popup()._stealer.entry, 'release notes');
        findRow(memories(), 'Open screenshot').activate();
        await sleep(400);
        check('screenshot row opens the image', opened[1] === `file://${OUT_DIR}/shot.png`, opened);
    } finally {
        Gio.AppInfo.launch_default_for_uri = realLaunch;
    }

    // Asking: a question offers Ask first, and Enter answers in the bubble.
    popup().open();
    await sleep(600);
    const askEntry = popup()._stealer.entry;
    await search(askEntry, 'release notes');
    check('plain words do not offer Ask', sectionRows(ask()).length === 0, sectionRows(ask()));
    const QUESTION = 'when are the release notes due?';
    await search(askEntry, QUESTION);
    check('a question offers Ask first', JSON.stringify(sectionRows(ask())) === '["Ask the assistant"]',
        sectionRows(ask()));
    askEntry.grab_key_focus();
    await tapKey(Clutter.KEY_Return);
    check('Enter on Ask keeps Spotlight open', popup()._visible);
    for (let i = 0; i < 30 && answers().bubble.bodyText !== 'It is due on Friday.'; i++)
        await sleep(100);
    await sleep(1800);   // let the words finish fading in
    check('the agent is asked the question', agent.asked.at(-1) === QUESTION, agent.asked);
    check('the answer streams into the bubble', answers().bubble.bodyText === 'It is due on Friday.',
        answers().bubble.bodyText);
    check('the answer takes the results\' place', answers().bubble.visible && !results().visible);
    check('the question stays in the search field', popup()._stealer.entry.get_text() === QUESTION,
        popup()._stealer.entry.get_text());
    const chips = answers().bubble._chips.map(chip => chip.label);
    check('chips: Copy first, then the memory it drew on',
        JSON.stringify(chips) === JSON.stringify(['Copy', 'Release notes at…']), chips);
    await saveScreenshot('answer.png');
    await tapKey(Clutter.KEY_Escape);
    check('Esc goes back to the results', popup()._visible && !answers().visible && results().visible &&
        sectionRows(ask()).length === 1);
    await tapKey(Clutter.KEY_Return);
    for (let i = 0; i < 30 && answers().bubble.bodyText !== 'It is due on Friday.'; i++)
        await sleep(100);
    await tapKey(Clutter.KEY_Return);
    check('Enter copies the answer', await clipboardText() === 'It is due on Friday.', await clipboardText());
    await sleep(900);
    check('then Spotlight closes', !popup()._visible);

    // A problem is said plainly, with what to do.
    agent.answerError = 'Claude has no API key: put ANTHROPIC_API_KEY=<your key> in secrets.env';
    popup().open();
    await sleep(600);
    await search(popup()._stealer.entry, QUESTION);
    popup()._stealer.entry.grab_key_focus();
    await tapKey(Clutter.KEY_Return);
    await sleep(1200);
    check('a problem is said in the bubble', answers().bubble.headlineText === 'The assistant could not answer' &&
        answers().bubble.bodyText.startsWith('Claude has no API key'), answers().bubble.headlineText);
    await saveScreenshot('answer-problem.png');
    // Typing something else is a new search.
    await search(popup()._stealer.entry, 'release');
    check('typing again goes back to the results', !answers().visible && results().visible);
    agent.answerError = null;
    popup().close();
    await sleep(500);

    // Esc and the shortcut still close it.
    popup().open();
    await sleep(600);
    await pressKeys([Clutter.KEY_Escape]);
    check('Esc closes Spotlight', !popup()._visible);
    await pressKeys([Clutter.KEY_Super_L, Clutter.KEY_space]);
    check('Super+Space opens again', popup()._visible);
    await pressKeys([Clutter.KEY_Super_L, Clutter.KEY_space]);
    check('Super+Space toggles closed', !popup()._visible);

    // The agent going away is handled quietly.
    agent.stop();
    for (let i = 0; i < 50 && memories()._client.available; i++)
        await sleep(100);
    popup().open();
    await sleep(600);
    await search(popup()._stealer.entry, 'screenvision');
    check('agent gone: Memories hides again', sectionRows(memories()).length === 0);
    popup().close();
    await sleep(500);

    // Disable gives everything back to GNOME; enable takes it again.
    const results0 = results();
    const provider0 = memories();
    const math0 = math();
    Main.extensionManager.disableExtension(UUID);
    await sleep(500);
    check('disable removes the Memories section', !results0._providers.includes(provider0));
    check('disable removes the Calculator section', !results0._providers.includes(math0));
    const calculator0 = results0._providers.find(p => p.id === 'org.gnome.Calculator.desktop');
    check('disable gives GNOME Calculator back its searches', !calculator0 ||
        calculator0.getInitialResultSet.toString().includes('GetInitialResultSetAsync'));
    check('disable returns the search entry to the Overview', Main.overview.searchEntry.get_parent() !== null &&
        Main.overview.searchEntry.visible);
    Main.extensionManager.enableExtension(UUID);
    await sleep(500);
    check('re-enable works', Main.extensionManager.lookup(UUID).state === 1 &&
        results()._providers[0] === ask() && results()._providers[1] === math() &&
        results()._providers[3] === memories(), order());
}

// GNOME briefly disables and re-enables extensions loaded after one that is
// toggled (including this driver), so make sure the script runs only once.
let started = false;

export default class SmokeDriver extends Extension {
    enable() {
        if (started)
            return;
        started = true;
        run()
            .catch(e => report('FAIL driver crashed', `${e.message}\n${e.stack}`))
            .finally(() => report('done', true));
    }

    disable() {
    }
}
