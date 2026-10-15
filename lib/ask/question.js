// Spotlight: does the text read as a question for the assistant?
// SPDX-License-Identifier: GPL-3.0-or-later
// No GNOME imports, so tests/run.js can check it with plain gjs.

// Words a question or a request usually starts with.
const OPENERS = new Set([
    'what', 'whats', "what's", 'when', 'where', 'who', 'whom', 'whose', 'why', 'which', 'how',
    'is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
    'have', 'has', 'had', 'tell', 'show', 'find', 'remind', 'explain', 'summarise', 'summarize',
    'list', 'compare',
]);

/**
 * Whether to offer "Ask" for this text: it ends with "?", starts with "?"
 * (ask explicitly), or is at least two words starting like a question.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeQuestion(text) {
    const trimmed = text.trim();
    if (trimmed.length < 3)
        return false;
    if (trimmed.startsWith('?') || trimmed.endsWith('?'))
        return trimmed.replace(/\?/g, '').trim().length >= 2;
    const words = trimmed.toLowerCase().split(/\s+/);
    return words.length >= 2 && OPENERS.has(words[0]);
}

/** The question itself, without a leading "?" used to ask explicitly. */
export function questionText(text) {
    return text.trim().replace(/^\?\s*/, '');
}
