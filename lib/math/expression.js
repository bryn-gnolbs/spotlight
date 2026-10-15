// Spotlight: arithmetic typed into the search field
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A small recursive-descent parser: text is tokenised and evaluated by
// hand, never handed to eval() or Function(), so the only thing it can ever
// do is arithmetic. Pure JavaScript, no GNOME Shell, so it is unit-tested.
//
// Understands: + - * / × ÷ (and x between numbers), ^ or ** for powers,
// parentheses, unary minus, 1,000 grouping, and percentages the way people
// say them: "15% of 80" = 12, "80 + 15%" = 92, "80 - 10%" = 72, "80 * 15%" = 12.

const SIGNIFICANT_DIGITS = 12;

const OPERATOR_ALIASES = {
    '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '·': '*', 'x': '*', 'X': '*',
    '/': '/', '÷': '/', '^': '^', '(': '(', ')': ')', '%': '%',
};
const PRETTY = {'+': '+', '-': '−', '*': '×', '/': '÷'};

class NotMath extends Error {}

/** Split text into number, operator and "of" tokens; throws NotMath on anything else. */
function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const rest = text.slice(i);
        const space = /^\s+/.exec(rest);
        if (space) {
            i += space[0].length;
            continue;
        }
        const number = /^(?:\d[\d,]*(?:\.\d*)?|\.\d+)/.exec(rest);
        if (number) {
            const raw = number[0];
            // Commas only as thousands separators ("1,000", not "1,5").
            if (raw.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/.test(raw))
                throw new NotMath();
            tokens.push({type: 'number', value: Number(raw.replaceAll(',', '')), text: raw});
            i += raw.length;
            continue;
        }
        if (rest.startsWith('**')) {
            tokens.push({type: 'op', value: '^'});
            i += 2;
            continue;
        }
        if (/^of\b/i.test(rest)) {
            tokens.push({type: 'op', value: 'of'});
            i += 2;
            continue;
        }
        const op = OPERATOR_ALIASES[rest[0]];
        if (!op)
            throw new NotMath();
        // "x" only means times between two numbers ("12x7", "12 x 7").
        if (op === '*' && /[xX]/.test(rest[0]) && tokens.at(-1)?.type !== 'number')
            throw new NotMath();
        tokens.push({type: 'op', value: op});
        i += 1;
    }
    return tokens;
}

class Parser {
    constructor(tokens) {
        this._tokens = tokens;
        this._pos = 0;
        // Binary operations and percentages seen: a bare "42" is not a calculation.
        this.operations = 0;
    }

    _peek() {
        return this._tokens[this._pos];
    }

    _accept(op) {
        const token = this._peek();
        if (token?.type === 'op' && token.value === op) {
            this._pos++;
            return true;
        }
        return false;
    }

    parse() {
        const node = this._expression();
        if (this._pos !== this._tokens.length)
            throw new NotMath();
        return node;
    }

    // expression := term (('+' | '-') term)*
    _expression() {
        let left = this._term();
        for (;;) {
            const op = this._accept('+') ? '+' : this._accept('-') ? '-' : null;
            if (!op)
                return left;
            const right = this._term();
            this.operations++;
            // "80 + 15%" means 80 plus 15% of 80.
            const amount = right.percent ? left.value * right.value : right.value;
            left = {
                value: op === '+' ? left.value + amount : left.value - amount,
                text: `${left.text} ${PRETTY[op]} ${right.text}`,
            };
        }
    }

    // term := factor (('*' | '/' | 'of') factor)*
    _term() {
        let left = this._factor();
        for (;;) {
            const op = this._accept('*') ? '*' : this._accept('/') ? '/' : this._accept('of') ? 'of' : null;
            if (!op)
                return left;
            // "of" only follows a percentage: "15% of 80".
            if (op === 'of' && !left.percent)
                throw new NotMath();
            const right = this._factor();
            this.operations++;
            left = {
                value: op === '/' ? left.value / right.value : left.value * right.value,
                text: `${left.text} ${op === 'of' ? 'of' : PRETTY[op]} ${right.text}`,
            };
        }
    }

    // factor := ('-' | '+') factor | power
    _factor() {
        if (this._accept('-')) {
            const operand = this._factor();
            return {value: -operand.value, text: `−${operand.text}`, percent: operand.percent};
        }
        if (this._accept('+'))
            return this._factor();
        return this._power();
    }

    // power := percentage ('^' factor)?   (right-associative; -2^2 = -4)
    _power() {
        const base = this._percentage();
        if (!this._accept('^'))
            return base;
        const exponent = this._factor();
        this.operations++;
        return {value: base.value ** exponent.value, text: `${base.text}^${exponent.text}`};
    }

    // percentage := primary '%'*
    _percentage() {
        let node = this._primary();
        while (this._accept('%')) {
            this.operations++;
            node = {value: node.value / 100, text: `${node.text}%`, percent: true};
        }
        return node;
    }

    // primary := number | '(' expression ')'
    _primary() {
        const token = this._peek();
        if (token?.type === 'number') {
            this._pos++;
            return {value: token.value, text: token.text};
        }
        if (this._accept('(')) {
            const inner = this._expression();
            if (!this._accept(')'))
                throw new NotMath();
            return {value: inner.value, text: `(${inner.text})`};
        }
        throw new NotMath();
    }
}

/**
 * Evaluate typed arithmetic.
 *
 * @param {string} text - what was typed
 * @returns {{value: number, expression: string}|null} the result and the
 *   expression as understood ("12 × 7"), or null when the text is not a
 *   calculation (no operator, letters, incomplete, or not a finite number)
 */
export function evaluate(text) {
    if (typeof text !== 'string' || !/\d/.test(text))
        return null;
    try {
        const parser = new Parser(tokenize(text.trim()));
        const node = parser.parse();
        if (parser.operations === 0 || !Number.isFinite(node.value))
            return null;
        return {value: node.value, expression: node.text};
    } catch (e) {
        if (e instanceof NotMath)
            return null;
        throw e;
    }
}

/**
 * The number as it should be pasted: plain digits, no grouping, rounded to
 * 12 significant digits so 0.1 + 0.2 gives 0.3.
 */
export function plainNumber(value) {
    const rounded = Number(value.toPrecision(SIGNIFICANT_DIGITS));
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** The number as it is shown: "1,234,567.5", "−3". Exponent forms are left alone. */
export function displayNumber(value) {
    const plain = plainNumber(value);
    if (/e/i.test(plain))
        return plain;
    const [whole, fraction] = plain.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',').replace(/^-/, '−');
    return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
