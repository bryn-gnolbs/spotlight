// Spotlight: turns the agent's memories into search result rows
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure functions (GLib only, no GNOME Shell) so they run in the unit tests.
import GLib from 'gi://GLib';

const NAME_MAX_CHARS = 80;
// The best match also offers its links and screenshot as rows of their own.
const MAX_LINK_ROWS = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const asString = value => (typeof value === 'string' ? value : '');

/**
 * Parse and validate the agent's Search/Recent JSON. Anything malformed is
 * dropped rather than trusted, since it ends up on screen and in launch calls.
 *
 * @param {string} json
 * @returns {Array<{id: string, time: string, text: string, links: string[],
 *   image: string|null, app: string, title: string}>}
 */
export function parseMemories(json) {
    const data = JSON.parse(json);
    if (!Array.isArray(data))
        return [];
    return data
        .filter(m => m && typeof m === 'object' && asString(m.id) !== '')
        .map(m => {
            const image = asString(m.image);
            return {
                id: m.id,
                time: asString(m.time),
                text: asString(m.text),
                links: Array.isArray(m.links) ? m.links.filter(isWebLink) : [],
                image: image !== '' && GLib.path_is_absolute(image) ? image : null,
                app: asString(m.app),
                title: asString(m.title),
            };
        });
}

/** Only web links are ever opened; other schemes could launch anything. */
export function isWebLink(value) {
    return typeof value === 'string' && /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(value);
}

/** "github.com" for "https://www.github.com/x". */
export function linkHost(link) {
    try {
        const host = GLib.Uri.parse(link, GLib.UriFlags.NONE).get_host() ?? link;
        return host.replace(/^www\./, '');
    } catch {
        return link;
    }
}

/** Shorten at a word boundary, ending with "…". */
export function shorten(text, maxChars = NAME_MAX_CHARS) {
    if (text.length <= maxChars)
        return text;
    const cut = text.slice(0, maxChars - 1);
    if (/\s/.test(text[maxChars - 1]))
        return `${cut.trimEnd()}…`;
    const space = cut.lastIndexOf(' ');
    return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * When something was remembered, in plain words: "just now", "5 minutes ago",
 * "3 hours ago", "yesterday", "4 days ago", "12 Oct", "12 Oct 2025".
 *
 * @param {string} iso - ISO 8601 time
 * @param {Date} now
 */
export function relativeTime(iso, now = new Date()) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime()))
        return '';
    const minutes = Math.floor((now - then) / 60000);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;

    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const days = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
    if (days === 0) {
        const hours = Math.floor(minutes / 60);
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    }
    if (days === 1)
        return 'yesterday';
    if (days < 7)
        return `${days} days ago`;
    const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
    return then.getFullYear() === now.getFullYear() ? date : `${date} ${then.getFullYear()}`;
}

/** The row's title: the first line of what was read. */
export function memoryName(memory) {
    const line = memory.text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).find(l => l !== '');
    if (line)
        return shorten(line);
    if (memory.links.length > 0)
        return linkHost(memory.links[0]);
    return memory.title || memory.app || 'Screenshot';
}

/** Where and when: "Firefox · 2 hours ago". */
export function memoryDetails(memory, now = new Date()) {
    return [memory.app || memory.title, relativeTime(memory.time, now)].filter(Boolean).join(' · ');
}

/**
 * What Enter does on a memory: copy its text; failing that open its link;
 * failing that open its screenshot.
 */
export function primaryAction(memory) {
    if (memory.text.trim() !== '')
        return {kind: 'copy', text: memory.text};
    if (memory.links.length > 0)
        return {kind: 'open', uri: memory.links[0]};
    if (memory.image)
        return {kind: 'open', uri: GLib.filename_to_uri(memory.image, null)};
    return null;
}

/**
 * Result rows for a list of memories, best first. Each memory is one row; the
 * best match is followed by rows for its links and its screenshot, so the
 * common follow-ups are one arrow key away.
 *
 * @returns {Array<{id: string, name: string, description: string,
 *   icon: string, action: object}>}
 */
export function memoryRows(memories, now = new Date()) {
    const rows = [];
    memories.forEach((memory, index) => {
        const action = primaryAction(memory);
        if (!action)
            return;
        rows.push({
            id: memory.id,
            name: memoryName(memory),
            description: memoryDetails(memory, now),
            icon: memoryIcon(memory, action),
            action,
        });
        if (index === 0)
            rows.push(...followUpRows(memory, action));
    });
    return rows;
}

function memoryIcon(memory, action) {
    if (action.kind === 'copy')
        return 'edit-copy-symbolic';
    return memory.links.length > 0 ? 'web-browser-symbolic' : 'image-x-generic-symbolic';
}

function followUpRows(memory, primary) {
    const rows = memory.links
        .filter(link => link !== primary.uri)
        .slice(0, MAX_LINK_ROWS)
        .map((link, i) => ({
            id: `${memory.id}#link${i}`,
            name: `Open ${linkHost(link)}`,
            description: link,
            icon: 'web-browser-symbolic',
            action: {kind: 'open', uri: link},
        }));
    if (memory.image) {
        const uri = GLib.filename_to_uri(memory.image, null);
        if (uri !== primary.uri) {
            rows.push({
                id: `${memory.id}#image`,
                name: 'Open screenshot',
                description: GLib.path_get_basename(memory.image),
                icon: 'image-x-generic-symbolic',
                action: {kind: 'open', uri},
            });
        }
    }
    return rows;
}
