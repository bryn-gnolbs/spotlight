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

// The agent's intent classifier says how much the text is for the assistant
// (a question or a request: ask + do). From this much on, Ask comes first.
export const OFFER_AT = 0.5;

/** Whether the text asks explicitly: it starts or ends with "?". */
export function asksExplicitly(text) {
    const trimmed = text.trim();
    return (trimmed.startsWith('?') || trimmed.endsWith('?')) && trimmed.replace(/\?/g, '').trim().length >= 2;
}

/**
 * Whether to offer Ask: always when asked explicitly, by the agent's intent
 * classifier when it answered, and by looksLikeQuestion when it did not (an
 * older or busy agent).
 *
 * @param {string} text
 * @param {?{assistant: number}} intent - the agent's Intent, or null
 * @returns {boolean}
 */
export function offersAsk(text, intent) {
    if (asksExplicitly(text))
        return true;
    if (text.trim().length < 3)
        return false;
    if (intent)
        return intent.assistant >= OFFER_AT;
    return looksLikeQuestion(text);
}

/** The question itself, without a leading "?" used to ask explicitly. */
export function questionText(text) {
    return text.trim().replace(/^\?\s*/, '');
}
