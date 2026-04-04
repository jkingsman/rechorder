import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { hoverTooltip, Decoration, EditorView } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { hasCustomNote } from './tuning.js';

const EASING_NAMES = new Set([
    'lin','linear','sinein','sineout','sineinout',
    'cubicin','cubicout','cubicinout',
    'quintin','quintout','quintinout',
    'wobblein','wobbleout','wobbleinout',
]);

const VOICE_NAMES = new Set([
    'sine','triangle','tri','square','sawtooth','saw',
]);

const NOTE_RE    = /^[A-Ga-g][#b]?\d+$/;
const CENT_RE    = /^[A-Ga-g][#b]?\d+[+-]\d+$/;
const HZ_RE      = /^\d+(\.\d+)?$/;
const HEADER_RE  = /^[LTMKQXVWltmkqxvw]:.*/;

function classifyName(n) {
    if (/^[sS]$/.test(n))    return 'atom';        // silence
    if (HZ_RE.test(n))       return 'number';       // raw Hz
    if (NOTE_RE.test(n))     return 'variableName'; // standard note
    if (CENT_RE.test(n))     return 'variableName'; // cent-adjusted note
    if (EASING_NAMES.has(n.toLowerCase())) return 'typeName';     // easing
    if (/^[A-Za-z_][A-Za-z0-9_#]*$/.test(n)) {
        return hasCustomNote(n) ? 'string' : 'invalid';  // custom note: must be defined
    }
    return 'invalid';
}

const rechorderParser = {
    name: 'rechorder',

    startState() {
        return { phase: 'lineStart' };
    },

    token(stream, state) {
        if (stream.eatSpace()) return null;

        // Comment: # at start of line or after whitespace
        if (stream.peek() === '#' && (stream.pos === 0 || /\s/.test(stream.string[stream.pos - 1]))) {
            stream.skipToEnd();
            return 'lineComment';
        }

        if (stream.sol()) state.phase = 'lineStart';

        // --- Line start: detect headers and | prefixes ---
        if (state.phase === 'lineStart') {
            // Header line: L:1/4, T:title, etc.
            if (stream.match(HEADER_RE)) return 'meta';

            // Check if line has | (channel prefix)
            const rest = stream.string.slice(stream.pos);
            const pipeIdx = rest.indexOf('|');
            if (pipeIdx >= 0) {
                state.phase = 'prefix';
                state._pipePos = stream.pos + pipeIdx;
            } else {
                state.phase = 'elements';
            }
        }

        // --- Prefix: consume label, |, optional voice, | ---
        if (state.phase === 'prefix') {
            if (stream.eat('|')) {
                // After |, check if next chunk before another | is a voice
                const rest = stream.string.slice(stream.pos);
                const nextPipe = rest.indexOf('|');
                if (nextPipe >= 0) {
                    const between = rest.slice(0, nextPipe).trim().toLowerCase();
                    if (VOICE_NAMES.has(between)) {
                        state.phase = 'voice';
                        return 'punctuation';
                    }
                }
                state.phase = 'elements';
                return 'punctuation';
            }
            // Consume label chars up to |
            if (stream.pos < state._pipePos) {
                while (stream.pos < state._pipePos && !stream.eol()) stream.next();
                return 'labelName';
            }
            state.phase = 'elements';
        }

        if (state.phase === 'voice') {
            if (stream.eat('|')) {
                state.phase = 'elements';
                return 'punctuation';
            }
            // Consume voice name chars
            while (!stream.eol() && stream.peek() !== '|') stream.next();
            return 'keyword';
        }

        // --- Elements: name:duration=vol separated by > ---
        if (state.phase === 'elements') {
            // > separator
            if (stream.eat('>')) return 'punctuation';

            // Accent prefix
            if (stream.eat('!')) return 'operator';

            // Pan: (L/R)
            if (stream.match(/^\(\d+\/\d+\)/)) return 'operator';

            // Volume: =number
            if (stream.eat('=')) {
                stream.match(/^\d+/);
                return 'operator';
            }

            // Colon + duration
            if (stream.eat(':')) {
                stream.match(/^\d*(\/\d+)?/);
                return 'integer';
            }

            // Element name: consume until : = > or whitespace
            const m = stream.match(/^[^\s:=>]+/);
            if (m) return classifyName(m[0]);

            stream.next();
            return 'invalid';
        }

        stream.next();
        return null;
    },
};

export const rechorderLanguage = StreamLanguage.define(rechorderParser);

export const rechorderHighlight = HighlightStyle.define([
    { tag: tags.meta,         color: '#777', fontStyle: 'italic' },
    { tag: tags.keyword,      color: '#AA00FF' },
    { tag: tags.punctuation,  color: '#222', fontWeight: '900' },
    { tag: tags.variableName, color: '#2979FF' },
    { tag: tags.number,       color: '#00897B' },
    { tag: tags.atom,         color: '#546E7A' },
    { tag: tags.typeName,     color: '#E65100' },
    { tag: tags.string,       color: '#00897B', fontStyle: 'italic' },
    { tag: tags.integer,      color: '#795548' },
    { tag: tags.operator,     color: '#D50000' },
    { tag: tags.invalid,      color: '#fff', backgroundColor: '#c00' },
    { tag: tags.lineComment,  color: '#999', fontStyle: 'italic' },
]);

// --- Friendly names for easings ---
const EASING_LABELS = {
    lin: 'linear slide', linear: 'linear slide',
    sinein: 'sine ease in', sineout: 'sine ease out', sineinout: 'sine ease in/out',
    cubicin: 'cubic ease in', cubicout: 'cubic ease out', cubicinout: 'cubic ease in/out',
    quintin: 'quintic ease in', quintout: 'quintic ease out', quintinout: 'quintic ease in/out',
    wobblein: 'elastic wobble in', wobbleout: 'elastic wobble out', wobbleinout: 'elastic wobble in/out',
};

// Find the element block (name:dur=vol) surrounding a position in a line
function findBlock(lineText, offsetInLine) {
    // Strip prefix (everything before last |)
    let body = lineText;
    const lastPipe = lineText.lastIndexOf('|');
    const bodyStart = lastPipe >= 0 ? lastPipe + 1 : 0;
    body = lineText.slice(bodyStart);
    const adjOffset = offsetInLine - bodyStart;
    if (adjOffset < 0) return null;

    // Split by > and find which block the offset falls in
    let pos = 0;
    const parts = body.split('>');
    for (const part of parts) {
        const blockStart = bodyStart + pos;
        const blockEnd = bodyStart + pos + part.length;
        if (offsetInLine >= blockStart && offsetInLine < blockEnd) {
            // Parse this block: name:dur=vol(L/R)
            const colonIdx = part.indexOf(':');
            const name = colonIdx >= 0 ? part.slice(0, colonIdx).trim() : part.trim();
            let suffix = colonIdx >= 0 ? part.slice(colonIdx + 1).trim() : '';
            // Extract pan
            let panL = null, panR = null;
            const panMatch = suffix.match(/\((\d+)\/(\d+)\)\s*$/);
            if (panMatch) {
                panL = panMatch[1];
                panR = panMatch[2];
                suffix = suffix.slice(0, panMatch.index).trim();
            }
            let vol = null;
            const eqIdx = suffix.indexOf('=');
            if (eqIdx >= 0) {
                vol = suffix.slice(eqIdx + 1).trim();
                suffix = suffix.slice(0, eqIdx).trim();
            }
            return { name, dur: suffix || '1', vol, panL, panR, from: blockStart, to: blockEnd };
        }
        pos += part.length + 1; // +1 for >
    }
    return null;
}

function describeBlock(block) {
    let { name, dur, vol, panL, panR } = block;
    let accent = false;
    if (name.startsWith('!')) { accent = true; name = name.slice(1); }
    const counts = `${dur} count${dur === '1' ? '' : 's'}`;
    let desc = '';

    if (/^[sS]$/.test(name)) {
        desc = `silence, ${counts}`;
    } else if (HZ_RE.test(name)) {
        desc = `${name} Hz, ${counts}`;
    } else if (NOTE_RE.test(name) || CENT_RE.test(name)) {
        desc = `${name[0].toUpperCase() + name.slice(1)}, ${counts}`;
    } else if (EASING_NAMES.has(name.toLowerCase())) {
        desc = `${EASING_LABELS[name.toLowerCase()] || name}, ${counts}`;
    } else if (/^[A-Za-z_]\w*$/.test(name)) {
        desc = `${name} (custom), ${counts}`;
    } else {
        return null;
    }

    if (accent) desc = 'accented ' + desc;
    if (vol !== null) desc += `, ${vol}% vol`;
    if (panL !== null && panR !== null) desc += `, ${panL}L/${panR}R`;
    return desc;
}

// Hover tooltip extension
const blockTooltip = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const lineText = line.text;
    const offsetInLine = pos - line.from;

    // Skip header lines
    if (/^[LTMKQXVWltmkqxvw]:/.test(lineText)) return null;

    const block = findBlock(lineText, offsetInLine);
    if (!block) return null;

    const desc = describeBlock(block);
    if (!desc) return null;

    return {
        pos: line.from + block.from,
        end: line.from + block.to,
        above: true,
        create() {
            const el = document.createElement('div');
            el.style.cssText = 'font:12px monospace;padding:3px 8px;';
            el.textContent = desc;
            return { dom: el };
        },
    };
});

// Block highlight on hover — uses a state field driven by hover pos
const highlightMark = Decoration.mark({ class: 'cm-block-highlight' });

const hoverBlockField = StateField.define({
    create() { return Decoration.none; },
    update(decos, tr) {
        for (const e of tr.effects) {
            if (e.is(setHoverBlock)) return e.value;
        }
        return tr.docChanged ? Decoration.none : decos;
    },
    provide: f => EditorView.decorations.from(f),
});

const setHoverBlock = StateEffect.define();

const hoverBlockPlugin = EditorView.domEventHandlers({
    mousemove(e, view) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) {
            view.dispatch({ effects: setHoverBlock.of(Decoration.none) });
            return;
        }
        const line = view.state.doc.lineAt(pos);
        if (/^[LTMKQXVWltmkqxvw]:/.test(line.text)) {
            view.dispatch({ effects: setHoverBlock.of(Decoration.none) });
            return;
        }
        const block = findBlock(line.text, pos - line.from);
        if (!block) {
            view.dispatch({ effects: setHoverBlock.of(Decoration.none) });
            return;
        }
        const from = line.from + block.from;
        const to = line.from + block.to;
        const deco = Decoration.set([highlightMark.range(from, to)]);
        view.dispatch({ effects: setHoverBlock.of(deco) });
    },
    mouseleave(_e, view) {
        view.dispatch({ effects: setHoverBlock.of(Decoration.none) });
    },
});

const hoverBlockTheme = EditorView.baseTheme({
    '.cm-block-highlight': {
        backgroundColor: 'rgba(0,0,0,0.06)',
        borderRadius: '2px',
        outline: '1px solid rgba(0,0,0,0.15)',
    },
});

// --- Playback highlight (driven from main.js) ---
export const setPlaybackHighlight = StateEffect.define();

const playbackField = StateField.define({
    create() { return Decoration.none; },
    update(decos, tr) {
        for (const e of tr.effects) {
            if (e.is(setPlaybackHighlight)) return e.value;
        }
        return tr.docChanged ? Decoration.none : decos;
    },
    provide: f => EditorView.decorations.from(f),
});


// Utility: find all element blocks in a line body with their char offsets
export function findAllBlocks(lineText) {
    // Strip prefix (everything before and including last |)
    const lastPipe = lineText.lastIndexOf('|');
    const bodyStart = lastPipe >= 0 ? lastPipe + 1 : 0;
    const body = lineText.slice(bodyStart);

    const blocks = [];
    let pos = 0;
    const parts = body.split('>');
    for (const part of parts) {
        const leadingSpaces = part.length - part.trimStart().length;
        const absStart = bodyStart + pos + leadingSpaces;
        const absEnd = bodyStart + pos + part.length;
        if (part.trim()) {
            blocks.push({ from: absStart, to: absEnd });
        }
        pos += part.length + 1; // +1 for >
    }
    return blocks;
}

// --- Channel label coloring (driven from main.js) ---
export const setLabelColors = StateEffect.define();

const labelColorField = StateField.define({
    create() { return Decoration.none; },
    update(decos, tr) {
        for (const e of tr.effects) {
            if (e.is(setLabelColors)) return e.value;
        }
        return tr.docChanged ? Decoration.none : decos;
    },
    provide: f => EditorView.decorations.from(f),
});

export function rechorder() {
    return [
        rechorderLanguage,
        syntaxHighlighting(rechorderHighlight),
        blockTooltip,
        hoverBlockField,
        hoverBlockPlugin,
        hoverBlockTheme,
        playbackField,
        labelColorField,
    ];
}
