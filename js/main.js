import { parse } from './parser.js';
import { Player, buildTimeline } from './engine.js';
import { allNoteNames, getFreq, setFreq, resetTo12TET, clearAll, setCustomNote, clearCustomNotes, allCustomNotes } from './tuning.js';
import { noteToFreq as tet12Freq, isNoteName, normalizeNoteName, parseCentNote } from './notes.js';
import { getEasing } from './easing.js';
import { EditorView, keymap, Decoration } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { rechorder, setPlaybackHighlight, setLabelColors, findAllBlocks } from './rechorder-lang.js';

// --- Easing sparklines ---
(function drawSparklines() {
    const container = document.getElementById('easingSparklines');
    const names = ['lin','sineIn','sineOut','sineInOut','cubicIn','cubicOut','cubicInOut','quintIn','quintOut','quintInOut','wobbleIn','wobbleOut','wobbleInOut'];
    const W = 36, H = 16, dpr = window.devicePixelRatio || 1;
    for (const name of names) {
        const fn = getEasing(name);
        const row = document.createElement('div');
        row.className = 'easing-row';
        const canvas = document.createElement('canvas');
        canvas.width = W * dpr; canvas.height = H * dpr;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i <= W; i++) {
            const t = i / W;
            const y = H - 2 - fn(t) * (H - 4);
            i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
        }
        ctx.stroke();
        row.appendChild(canvas);
        const label = document.createElement('code');
        label.textContent = name;
        row.appendChild(label);
        container.appendChild(row);
    }
})();

// --- DOM refs ---
const playStopBtn = document.getElementById('playStop');
const bpmSlider   = document.getElementById('bpm');
const bpmVal      = document.getElementById('bpmVal');
const positionEl  = document.getElementById('position');
const tuningGrid  = document.getElementById('tuningGrid');

const player = new Player();
let parseDebounce = null;

// --- Editor (CodeMirror 6) ---
const DEFAULT_DOC = `# want to love (just raw) by aloboi
L:1/4 # 1 = quarter note
Anchor|saw|     C#2:4(100/50) >!Eb2:5 >S:2 >F2:4                          >lin:1        >Eb2:4 >sineIn:1  >C2:4 >!C#2:4 >S:5/2 >Eb2:4 >sineInOut:2/3 >F2:5
V2|saw|         Ab2:4(50/100) >!Bb2:5 >S:2 >C3:4                          >lin:1        >Bb2:4 >sineIn:1  >G2:4 >!Ab2:4 >S:5/2 >Bb2:4 >sineInOut:2/3 >C3:5
V3|saw|         F3:9(80/20)           >S:2 >F3:9                                               >sineIn:1  >E3:4 >!F3:4  >S:5/2 >G3:4  >sineInOut:2/3 >F3:5
Slidey Boi|saw| C4:9(20/80)           >S:2 >Bb3:3 >cubicinout:1/2 >A3:1/2 >cubicinout:1 >G3:4  >quintIn:1 >C4:8         >S:5/2 >Bb3:4 >sineInOut:2/3 >A3:5`;

function getInitialDoc() {
    if (!location.hash || location.hash.length < 2) return DEFAULT_DOC;
    try {
        const data = JSON.parse(decodeURIComponent(location.hash.slice(1)));
        return data.n || DEFAULT_DOC;
    } catch (_) {
        return DEFAULT_DOC;
    }
}

const editorView = new EditorView({
    doc: getInitialDoc(),
    extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        rechorder(),
        EditorView.updateListener.of(update => {
            if (update.docChanged) {
                clearTimeout(parseDebounce);
                parseDebounce = setTimeout(liveUpdate, 120);
            }
        }),
    ],
    parent: document.getElementById('editor'),
});

function getEditorText() {
    return editorView.state.doc.toString();
}

function setEditorText(text) {
    editorView.dispatch({
        changes: { from: 0, to: editorView.state.doc.length, insert: text },
    });
}
const tuningInputs = new Map();

// --- Tuning UI ---
function buildTuningUI() {
    tuningGrid.innerHTML = '';
    tuningInputs.clear();

    for (const name of allNoteNames()) {
        const label = document.createElement('label');

        const span = document.createElement('span');
        span.textContent = name;
        label.appendChild(span);

        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = 'any';
        inp.min = '0';
        const hz = getFreq(name);
        inp.value = hz !== null ? hz.toFixed(2) : '';
        inp.addEventListener('change', () => {
            const v = parseFloat(inp.value);
            setFreq(name, isNaN(v) ? null : v);
        });
        label.appendChild(inp);

        tuningGrid.appendChild(label);
        tuningInputs.set(name, inp);
    }
}

function refreshTuningUI() {
    for (const [name, inp] of tuningInputs) {
        const hz = getFreq(name);
        inp.value = hz !== null ? hz.toFixed(2) : '';
    }
}

buildTuningUI();

// --- Tuning presets ---
const NOTE_NAMES_12 = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// 5-limit just intonation ratios relative to C
const JUST_5LIMIT = [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 9/5, 15/8];

function applyRatioTuning(ratios) {
    // Ratios are relative to C; A = ratios[9]. Keep A4 = 440.
    const c4 = 440 / ratios[9];
    for (const name of allNoteNames()) {
        const m = name.match(/^([A-G]#?)(\d+)$/);
        if (!m) continue;
        const idx = NOTE_NAMES_12.indexOf(m[1]);
        const oct = parseInt(m[2]);
        setFreq(name, c4 * Math.pow(2, oct - 4) * ratios[idx]);
    }
    refreshTuningUI();
    liveUpdate();
}

const presetSelect = document.getElementById('tuningPreset');

presetSelect.addEventListener('change', () => {
    switch (presetSelect.value) {
        case '12tet': resetTo12TET(); refreshTuningUI(); liveUpdate(); break;
        case 'just':  applyRatioTuning(JUST_5LIMIT); break;
    }
});

document.getElementById('clearTuning').addEventListener('click', () => {
    clearAll();
    refreshTuningUI();
    liveUpdate();
});

// --- Scale generator (N-EDO → custom notes) ---
document.getElementById('generateEdo').addEventListener('click', () => {
    const divisions = parseInt(document.getElementById('edoDivisions').value);
    const startStr  = document.getElementById('edoStart').value.trim();
    const octaves   = parseInt(document.getElementById('edoOctaves').value) || 4;
    if (!divisions || divisions < 2) return;

    const startNorm = isNoteName(startStr) ? normalizeNoteName(startStr) : startStr;
    const startFreq = getFreq(startNorm);
    if (!startFreq) return;

    const startOct = parseInt(startNorm.match(/\d+$/)[0]);
    const stepCents = 1200 / divisions;

    const naturals = [
        { letter: 'c', center: 0 },
        { letter: 'd', center: 200 },
        { letter: 'e', center: 400 },
        { letter: 'f', center: 500 },
        { letter: 'g', center: 700 },
        { letter: 'a', center: 900 },
        { letter: 'b', center: 1100 },
    ];

    // Standard 12-TET positions — skip notes landing near any of these
    const tet12 = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100];
    function nearStandard(cents) {
        for (const c of tet12) {
            let d = Math.abs(cents - c);
            if (d > 600) d = 1200 - d;
            if (d < stepCents * 0.4) return true;
        }
        return false;
    }

    // Rank naturals by distance, pick one that gives 2+ accidentals (avoids
    // single-# or single-b names which collide with standard note names)
    function nameNote(centsInOct, octave) {
        const ranked = naturals.map(n => {
            let diff = centsInOct - n.center;
            if (diff > 600) diff -= 1200;
            if (diff < -600) diff += 1200;
            return { ...n, diff, absDiff: Math.abs(diff) };
        }).sort((a, b) => a.absDiff - b.absDiff);

        for (const nat of ranked) {
            const steps = Math.round(nat.diff / stepCents);
            if (steps === 0) return null; // matches a natural
            const abs = Math.abs(steps);
            if (abs === 1) continue; // single # or b → conflicts with standard notes
            const acc = steps > 0 ? '#'.repeat(abs) : 'b'.repeat(abs);
            return nat.letter + acc + octave;
        }
        // Fallback: use nearest natural even with 1 accidental (rare)
        const nat = ranked[0];
        const steps = Math.round(nat.diff / stepCents);
        const acc = steps > 0 ? '#'.repeat(Math.abs(steps)) : 'b'.repeat(Math.abs(steps));
        return nat.letter + acc + octave;
    }

    const lines = [`# ${divisions}-EDO from ${startNorm}, ${octaves} octave${octaves > 1 ? 's' : ''}`];

    for (let oct = 0; oct < octaves; oct++) {
        const noteOct = startOct + oct;
        for (let step = 0; step < divisions; step++) {
            const totalCents = oct * 1200 + step * stepCents;
            const freq = startFreq * Math.pow(2, totalCents / 1200);
            const centsInOct = (step * stepCents) % 1200;

            if (nearStandard(centsInOct)) continue;

            const name = nameNote(centsInOct, noteOct);
            if (!name) continue;

            lines.push(`${name} = ${freq.toFixed(4)}`);
        }
    }

    customNotesEl.value = lines.join('\n');
    parseCustomNotes();
});

// --- Custom notes ---
const customNotesEl = document.getElementById('customNotes');
const customErrorsEl = document.getElementById('customErrors');

function validateCustomName(name) {
    if (!name) return 'empty name';
    if (name.startsWith('!')) return 'cannot start with ! (accent prefix)';
    if (!/^[A-Za-z_][A-Za-z0-9_#]*$/.test(name)) return 'use only letters, digits, _ , # (start with letter or _)';
    if (/^[sS]$/.test(name)) return 'reserved (silence)';
    if (isNoteName(name)) return 'conflicts with standard note name';
    if (getEasing(name)) return 'conflicts with easing name';
    return null;
}

function resolveCustomValue(val) {
    val = val.trim();
    // Raw Hz
    if (/^\d+(\.\d+)?$/.test(val)) {
        const hz = parseFloat(val);
        return isFinite(hz) && hz > 0 ? hz : null;
    }
    // Cent-adjusted note
    const cent = parseCentNote(val);
    if (cent) {
        const normalized = normalizeNoteName(cent.baseName);
        const baseFreq = getFreq(normalized);
        if (baseFreq === null) return null;
        return baseFreq * Math.pow(2, cent.cents / 1200);
    }
    // Standard note reference
    if (isNoteName(val)) {
        const normalized = normalizeNoteName(val);
        return getFreq(normalized);
    }
    return null;
}

function parseCustomNotes() {
    clearCustomNotes();
    const lines = customNotesEl.value.split('\n');
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) { errors.push(`Line ${i + 1}: missing '='`); continue; }

        const name = line.slice(0, eqIdx).trim();
        const valStr = line.slice(eqIdx + 1).trim();

        const nameErr = validateCustomName(name);
        if (nameErr) { errors.push(`Line ${i + 1}: "${name}" — ${nameErr}`); continue; }

        if (!valStr) { errors.push(`Line ${i + 1}: missing value`); continue; }

        const freq = resolveCustomValue(valStr);
        if (freq === null) { errors.push(`Line ${i + 1}: can't resolve "${valStr}"`); continue; }

        setCustomNote(name, freq);
    }

    customErrorsEl.textContent = errors.join(' | ');
    liveUpdate();
}

let customDebounce = null;
customNotesEl.addEventListener('input', () => {
    clearTimeout(customDebounce);
    customDebounce = setTimeout(parseCustomNotes, 150);
});

document.getElementById('clearCustom').addEventListener('click', () => {
    customNotesEl.value = '';
    clearCustomNotes();
    customErrorsEl.textContent = '';
    liveUpdate();
});

// --- Timeline (frequency trace, fit-to-pane) ---
const timelineWrap   = document.getElementById('timelineWrap');
const timelineCanvas = document.getElementById('timelineCanvas');
const playheadEl     = document.getElementById('playhead');
const playFromBtn    = document.getElementById('playFrom');
const parseErrorsEl  = document.getElementById('parseErrors');
const TRACE_COLORS   = ['#2979FF','#00C853','#FF6D00','#D50000','#AA00FF','#00B8D4','#795548','#546E7A'];
const CANVAS_H = 320;
let currentArrangement = null;  // shared between renderer and player
let selectedPos = null;         // clicked position on timeline (null = no selection)
let currentLabelMargin = 0;     // left margin for channel labels

function buildArrangement(parsed) {
    const channels = parsed.channels.map(ch => {
        const tl = buildTimeline(ch);
        tl.name = ch.name || null;
        tl.voice = ch.voice || null;
        return tl;
    });
    const maxDuration = channels.length > 0
        ? Math.max(...channels.map(c => c.totalDuration)) : 0;
    return { channels, defaultLength: parsed.defaultLength, maxDuration };
}

function renderTimeline(arrangement) {
    const { channels, maxDuration } = arrangement;
    currentArrangement = arrangement;

    const w = timelineWrap.clientWidth;
    const h = CANVAS_H;
    const dpr = window.devicePixelRatio || 1;
    timelineCanvas.width  = w * dpr;
    timelineCanvas.height = h * dpr;
    timelineCanvas.style.height = h + 'px';
    const ctx = timelineCanvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    if (maxDuration === 0 || channels.length === 0) return;

    // Compute left margin for channel name labels
    ctx.font = 'bold 10px monospace';
    let labelMargin = 0;
    for (const ch of channels) {
        if (ch.name) {
            const lw = ctx.measureText(ch.name).width + 6;
            if (lw > labelMargin) labelMargin = lw;
        }
    }
    currentLabelMargin = labelMargin;

    const plotW = w - labelMargin;
    const pxPerUnit = plotW / maxDuration;

    // frequency range (skip silence freq=0)
    let fMin = Infinity, fMax = 0;
    for (const ch of channels) {
        for (const seg of ch.segments) {
            if (seg.type === 'note' && seg.freq > 0) {
                fMin = Math.min(fMin, seg.freq);
                fMax = Math.max(fMax, seg.freq);
            } else if (seg.type === 'slide') {
                if (seg.fromFreq > 0) fMin = Math.min(fMin, seg.fromFreq);
                if (seg.toFreq > 0)   fMin = Math.min(fMin, seg.toFreq);
                fMax = Math.max(fMax, seg.fromFreq, seg.toFreq);
            }
        }
    }
    if (!isFinite(fMin) || fMin <= 0) { fMin = 220; fMax = 880; }
    let logMin = Math.log2(fMin), logMax = Math.log2(fMax);
    // Ensure minimum range of 1 octave so single-note pieces still look good,
    // then add 10% padding on each side for labels
    const range = Math.max(1, logMax - logMin);
    const pad = range * 0.1;
    logMin = logMin - pad;
    logMax = logMin + range + 2 * pad;

    const plotTop = 14, plotH = h - plotTop - 10;
    const freqToY = f => f <= 0
        ? plotTop + plotH + 4   // silence goes below plot
        : plotTop + plotH * (1 - (Math.log2(f) - logMin) / (logMax - logMin));

    // horizontal grid lines at C notes
    ctx.setLineDash([4, 4]); ctx.lineWidth = 0.5;
    for (let oct = 0; oct <= 9; oct++) {
        const f = 440 * Math.pow(2, (12 * (oct + 1) - 69) / 12);
        const y = freqToY(f);
        if (y < plotTop || y > plotTop + plotH) continue;
        ctx.strokeStyle = '#ccc';
        ctx.beginPath(); ctx.moveTo(labelMargin, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillStyle = '#aaa'; ctx.font = '9px monospace';
        ctx.fillText('C' + oct, labelMargin + 2, y - 2);
    }
    ctx.setLineDash([]);

    // vertical lines at segment boundaries
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    const drawn = new Set();
    for (const ch of channels) {
        for (const seg of ch.segments) {
            for (const u of [seg.start, seg.end]) {
                const px = Math.round(labelMargin + u * pxPerUnit) + 0.5;
                if (drawn.has(px) || px <= labelMargin + 1 || px >= w - 1) continue;
                drawn.add(px);
                ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
            }
        }
    }

    // traces with volume as brightness
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const baseColor = TRACE_COLORS[i % TRACE_COLORS.length];
        const [r, g, b] = hexToRgb(baseColor);

        for (let s = 0; s < ch.segments.length; s++) {
            const seg = ch.segments[s];
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';

            if (seg.type === 'note') {
                const x1 = labelMargin + seg.start * pxPerUnit;
                const x2 = labelMargin + seg.end   * pxPerUnit;
                const y  = freqToY(seg.freq);
                ctx.strokeStyle = `rgba(${r},${g},${b},${volAlpha(seg.vol)})`;
                ctx.beginPath();
                ctx.moveTo(x1, y); ctx.lineTo(x2, y);
                ctx.stroke();

            } else if (seg.type === 'slide') {
                const dur = seg.end - seg.start;
                const n = Math.max(2, Math.ceil(dur * pxPerUnit / 2));
                for (let j = 0; j < n; j++) {
                    const t0 = j / n, t1 = (j + 1) / n;
                    const e0 = seg.easingFn(t0), e1 = seg.easingFn(t1);
                    const f0 = seg.fromFreq * Math.pow(seg.toFreq / seg.fromFreq, e0);
                    const f1 = seg.fromFreq * Math.pow(seg.toFreq / seg.fromFreq, e1);
                    const v  = seg.fromVol + (seg.toVol - seg.fromVol) * ((e0 + e1) / 2);
                    const x0 = labelMargin + (seg.start + t0 * dur) * pxPerUnit;
                    const x1 = labelMargin + (seg.start + t1 * dur) * pxPerUnit;
                    ctx.strokeStyle = `rgba(${r},${g},${b},${volAlpha(v)})`;
                    ctx.beginPath();
                    ctx.moveTo(x0, freqToY(f0));
                    ctx.lineTo(x1, freqToY(f1));
                    ctx.stroke();
                }
            }
        }

        // channel name label (in left margin)
        if (ch.name && ch.segments.length > 0) {
            const firstNote = ch.segments.find(s => s.type === 'note' && s.freq > 0);
            if (firstNote) {
                ctx.font = 'bold 10px monospace';
                ctx.fillStyle = baseColor;
                ctx.fillText(ch.name, 2, freqToY(firstNote.freq) + 3);
            }
        }

        // note labels
        ctx.font = '10px monospace';
        for (const seg of ch.segments) {
            if (seg.type !== 'note') continue;
            ctx.fillStyle = `rgba(${r},${g},${b},${volAlpha(seg.vol)})`;
            ctx.fillText(seg.name, labelMargin + seg.start * pxPerUnit + 3, freqToY(seg.freq) - 5);
        }
    }

    // Dim overlay for selected position (click selection only, not playback)
    if (selectedPos !== null && !player.playing) {
        const bounds = findColumnBounds(arrangement, selectedPos);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        const x1 = labelMargin + bounds.from * pxPerUnit;
        const x2 = labelMargin + bounds.to * pxPerUnit;
        if (x1 > labelMargin) ctx.fillRect(labelMargin, 0, x1 - labelMargin, h);
        if (x2 < w) ctx.fillRect(x2, 0, w - x2, h);
    }
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}


function volAlpha(v) {
    return (0.15 + 0.85 * v).toFixed(2);   // 0→0.15, 1→1.0
}


function updatePlayhead(pos) {
    if (!currentArrangement || currentArrangement.maxDuration <= 0) return;
    const wrapW = timelineWrap.clientWidth;
    const plotW = wrapW - currentLabelMargin;
    const px = currentLabelMargin + (pos / currentArrangement.maxDuration) * plotW;
    playheadEl.style.left = px + 'px';
}

function findColumnBounds(arrangement, pos) {
    const times = new Set([0, arrangement.maxDuration]);
    for (const ch of arrangement.channels) {
        for (const seg of ch.segments) {
            times.add(seg.start);
            times.add(seg.end);
        }
    }
    const sorted = [...times].sort((a, b) => a - b);
    let from = 0, to = arrangement.maxDuration;
    for (let i = 0; i < sorted.length - 1; i++) {
        if (pos >= sorted[i] && pos < sorted[i + 1]) {
            from = sorted[i];
            to = sorted[i + 1];
            break;
        }
    }
    return { from, to };
}

let segmentRanges = []; // per channel: array of { start, end, from, to } (timeline pos → editor pos)

// --- Live parse + timeline on edit ---
function liveUpdate() {
    const parsed = parse(getEditorText());

    // Show/hide parse errors inline
    if (parsed.errors.length > 0 || parsed.missingNotes.length > 0) {
        const msgs = [...parsed.errors];
        if (parsed.missingNotes.length > 0)
            msgs.push(`Untuned notes: ${parsed.missingNotes.join(', ')}`);
        parseErrorsEl.textContent = msgs.join(' | ');
    } else {
        parseErrorsEl.textContent = '';
    }

    const arr = buildArrangement(parsed);
    selectedPos = null;
    playFromBtn.style.display = 'none';
    renderTimeline(arr);
    buildSegmentRanges(arr);
    updateLabelColors();
    clearPlaybackHighlight();
}

function isCommentOnly(text) {
    const t = text.trim();
    return !t || t[0] === '#';
}

function updateLabelColors() {
    const doc = editorView.state.doc;
    const decos = [];
    let chIdx = 0;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text.trim();
        if (!text) continue;
        if (isCommentOnly(text)) continue;
        if (/^L:/i.test(text) || /^[TMKQXVW]:/i.test(text)) continue;

        const pipeIdx = line.text.indexOf('|');
        if (pipeIdx > 0) {
            const color = TRACE_COLORS[chIdx % TRACE_COLORS.length];
            decos.push(Decoration.mark({
                attributes: { style: `color:${color};font-weight:bold` },
            }).range(line.from, line.from + pipeIdx));
        }
        chIdx++;
    }

    editorView.dispatch({
        effects: setLabelColors.of(Decoration.set(decos)),
    });
}

// Initial render
liveUpdate();

// Re-render on resize
let resizeDebounce = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
        if (currentArrangement) renderTimeline(currentArrangement);
    }, 150);
});

// --- Timeline click → highlight active blocks in editor ---
timelineCanvas.addEventListener('click', (e) => {
    if (player.playing) return;
    if (!currentArrangement || currentArrangement.maxDuration <= 0) return;

    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const plotX = x - currentLabelMargin * (rect.width / timelineWrap.clientWidth);
    const plotW = rect.width - currentLabelMargin * (rect.width / timelineWrap.clientWidth);
    if (plotX < 0) return;
    selectedPos = (plotX / plotW) * currentArrangement.maxDuration;

    renderTimeline(currentArrangement);
    updatePlaybackHighlight(selectedPos);
    playFromBtn.style.display = '';
});

// --- Playback highlight in editor ---

function buildSegmentRanges(arrangement) {
    segmentRanges = [];
    const doc = editorView.state.doc;
    let chIdx = 0;

    for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        const text = line.text.trim();
        if (!text) continue;
        if (isCommentOnly(text)) continue;
        if (/^L:/i.test(text)) continue;
        if (/^[TMKQXVW]:/i.test(text)) continue;

        if (chIdx >= arrangement.channels.length) break;
        const ch = arrangement.channels[chIdx];
        const blocks = findAllBlocks(text);
        const ranges = [];

        // Map each element block to its segment's timeline position
        // blocks and segments should be 1:1 (parser produces one element per block)
        const segs = ch.segments;
        for (let s = 0; s < segs.length && s < blocks.length; s++) {
            ranges.push({
                start: segs[s].start,
                end: segs[s].end,
                from: line.from + blocks[s].from,
                to: line.from + blocks[s].to,
            });
        }
        segmentRanges.push({ ranges, colorIdx: chIdx });
        chIdx++;
    }
}

function updatePlaybackHighlight(pos) {
    const decos = [];
    for (const ch of segmentRanges) {
        const color = TRACE_COLORS[ch.colorIdx % TRACE_COLORS.length];
        const [r, g, b] = hexToRgb(color);
        for (const rng of ch.ranges) {
            if (pos >= rng.start && pos < rng.end) {
                decos.push(Decoration.mark({
                    attributes: {
                        style: `background:rgba(${r},${g},${b},0.15);outline:1.5px solid rgba(${r},${g},${b},0.5);border-radius:2px`,
                    },
                }).range(rng.from, rng.to));
            }
        }
    }
    const ranges = decos;
    ranges.sort((a, b) => a.from - b.from);
    editorView.dispatch({
        effects: setPlaybackHighlight.of(Decoration.set(ranges)),
    });
}

function clearPlaybackHighlight() {
    editorView.dispatch({
        effects: setPlaybackHighlight.of(Decoration.none),
    });
}

// --- Play / Stop ---
function startPlayback(startPos = 0) {
    const parsed = parse(getEditorText());
    if (parsed.missingNotes.length > 0 || parsed.channels.length === 0) return;

    const arr = buildArrangement(parsed);
    selectedPos = null;
    playFromBtn.style.display = 'none';
    renderTimeline(arr);
    buildSegmentRanges(arr);

    player.bpm = parseInt(bpmSlider.value);
    player.play(arr, startPos);
    playheadEl.style.display = '';
    playheadEl.style.height = CANVAS_H + 'px';
    playStopBtn.textContent = 'Stop';
}

function stopPlayback() {
    player.stop();
    playheadEl.style.display = 'none';
    clearPlaybackHighlight();
    playStopBtn.textContent = 'Play';
    positionEl.textContent = '';
    if (currentArrangement) renderTimeline(currentArrangement);
}

playStopBtn.addEventListener('click', () => {
    if (player.playing) { stopPlayback(); return; }
    startPlayback();
});

playFromBtn.addEventListener('click', () => {
    if (selectedPos === null) return;
    const pos = selectedPos;
    startPlayback(pos);
});

// --- Autoformat ---
function autoformatDur(str) {
    if (!str || !str.trim()) return 1;
    str = str.trim();
    const m = str.match(/^(\d+)?(?:\/(\d+))?$/);
    if (!m) return 1;
    const num = m[1] ? parseInt(m[1]) : 1;
    const den = m[2] ? parseInt(m[2]) : 1;
    return den === 0 ? 0 : num / den;
}

function autoformat() {
    const text = getEditorText();
    const lines = text.split('\n');

    const channelData = [];
    const otherLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Strip comment (# preceded by start-of-line or whitespace)
        let commentSuffix = '';
        let stripped = line;
        for (let j = 0; j < line.length; j++) {
            if (line[j] === '#' && (j === 0 || /\s/.test(line[j - 1]))) {
                stripped = line.slice(0, j);
                commentSuffix = line.slice(j);
                break;
            }
        }

        const trimmed = stripped.trim();

        if (!trimmed || /^[LTMKQXVWltmkqxvw]:/.test(trimmed)) {
            otherLines.push({ lineIdx: i, text: line });
            continue;
        }

        let prefix = '';
        let body = trimmed;
        const lastPipe = trimmed.lastIndexOf('|');
        if (lastPipe >= 0) {
            prefix = trimmed.slice(0, lastPipe + 1);
            body = trimmed.slice(lastPipe + 1);
        }
        body = body.trim();

        if (!body) {
            otherLines.push({ lineIdx: i, text: line });
            continue;
        }

        const parts = body.split('>');
        const elements = [];

        for (const rawPart of parts) {
            const part = rawPart.trim();
            if (!part) continue;

            const colonIdx = part.indexOf(':');
            if (colonIdx < 0) {
                elements.push({ text: part, duration: 1 });
                continue;
            }

            let suffix = part.slice(colonIdx + 1).trim();
            suffix = suffix.replace(/\(\d+\/\d+\)\s*$/, '').trim();
            const eqIdx = suffix.indexOf('=');
            if (eqIdx >= 0) suffix = suffix.slice(0, eqIdx).trim();

            elements.push({ text: part, duration: autoformatDur(suffix) });
        }

        if (elements.length > 0) {
            channelData.push({ lineIdx: i, prefix, elements, commentSuffix });
        } else {
            otherLines.push({ lineIdx: i, text: line });
        }
    }

    if (channelData.length === 0) return;

    // Compute start/end times per element
    for (const ch of channelData) {
        let t = 0;
        for (const el of ch.elements) {
            el.startTime = Math.round(t * 1e6) / 1e6;
            t += el.duration;
            el.endTime = Math.round(t * 1e6) / 1e6;
        }
    }

    // Unique start times → columns
    const timeSet = new Set();
    for (const ch of channelData)
        for (const el of ch.elements) timeSet.add(el.startTime);
    const columns = [...timeSet].sort((a, b) => a - b);
    const colIdx = new Map();
    columns.forEach((t, i) => colIdx.set(t, i));

    // Slot widths: max element text length at each column + 1 padding
    const slotW = new Array(columns.length).fill(1);
    for (const ch of channelData) {
        for (const el of ch.elements) {
            const ci = colIdx.get(el.startTime);
            slotW[ci] = Math.max(slotW[ci], el.text.length + 1);
        }
    }

    // Ensure multi-column elements fit
    for (const ch of channelData) {
        for (const el of ch.elements) {
            const sc = colIdx.get(el.startTime);
            let ec = sc + 1;
            while (ec < columns.length && columns[ec] < el.endTime) ec++;
            if (ec > sc + 1) {
                let avail = 0;
                for (let c = sc; c < ec; c++) avail += slotW[c];
                avail += ec - sc - 1;
                const needed = el.text.length + 1;
                if (needed > avail) slotW[sc] += needed - avail;
            }
        }
    }

    // Cumulative column char positions
    const colPos = [0];
    for (let i = 0; i < columns.length - 1; i++)
        colPos.push(colPos[i] + slotW[i] + 1);

    // Pad prefixes to same length
    const maxPrefixLen = Math.max(0, ...channelData.map(ch => ch.prefix.length));

    // Rebuild lines
    const output = new Array(lines.length);
    for (const h of otherLines) output[h.lineIdx] = h.text;

    for (const ch of channelData) {
        let line = maxPrefixLen > 0
            ? (ch.prefix || '').padEnd(maxPrefixLen) + ' '
            : '';

        for (let e = 0; e < ch.elements.length; e++) {
            const el = ch.elements[e];
            const sc = colIdx.get(el.startTime);

            let width;
            if (e === ch.elements.length - 1) {
                width = el.text.length;
            } else {
                const nextSc = colIdx.get(ch.elements[e + 1].startTime);
                width = Math.max(el.text.length, colPos[nextSc] - colPos[sc] - 1);
            }

            if (e > 0) line += '>';
            line += el.text + ' '.repeat(Math.max(0, width - el.text.length));
        }

        if (ch.commentSuffix) line += ' ' + ch.commentSuffix;
        output[ch.lineIdx] = line;
    }

    setEditorText(output.join('\n'));
}

document.getElementById('autoformat').addEventListener('click', autoformat);

// --- Share (URL hash) ---
function buildShareHash() {
    const data = {
        n: getEditorText(),
        b: parseInt(bpmSlider.value),
    };
    // Tuning diffs from 12-TET
    const diffs = {};
    for (const name of allNoteNames()) {
        const cur = getFreq(name);
        const std = tet12Freq(name);
        if (cur === null && std !== null) {
            diffs[name] = null;
        } else if (cur !== null && std !== null && Math.abs(cur - std) > 0.001) {
            diffs[name] = +cur.toFixed(4);
        }
    }
    if (Object.keys(diffs).length > 0) data.t = diffs;
    // Custom notes
    const cn = allCustomNotes();
    if (cn.length > 0) data.c = customNotesEl.value;
    // Filter + Reverb
    data.fl = parseInt(filterLowSlider.value);
    data.fh = parseInt(filterHighSlider.value);
    data.rv = reverbCheckbox.checked;
    data.rd = parseFloat(reverbDurSlider.value);
    data.rw = parseInt(reverbWetSlider.value);
    return '#' + encodeURIComponent(JSON.stringify(data));
}

document.getElementById('saveUrl').addEventListener('click', () => {
    window.history.replaceState(null, '', buildShareHash());
});

function restoreFromHash() {
    if (!location.hash || location.hash.length < 2) return;
    try {
        const data = JSON.parse(decodeURIComponent(location.hash.slice(1)));
        if (data.n) setEditorText(data.n);
        if (data.b) { bpmSlider.value = data.b; bpmVal.textContent = data.b; }
        if (data.t) {
            for (const [name, hz] of Object.entries(data.t)) {
                setFreq(name, hz);
            }
            refreshTuningUI();
        }
        if (data.c) {
            customNotesEl.value = data.c;
            parseCustomNotes();
        }
        // Filter + Reverb
        if (data.fl !== undefined) {
            filterLowSlider.value = data.fl;
            const freq = sliderToFreq(data.fl);
            filterLowVal.textContent = formatFreq(freq);
            player.setFilterLow(freq);
        }
        if (data.fh !== undefined) {
            filterHighSlider.value = data.fh;
            const freq = sliderToFreq(data.fh);
            filterHighVal.textContent = formatFreq(freq);
            player.setFilterHigh(freq);
        }
        if (data.rv !== undefined) {
            reverbCheckbox.checked = data.rv;
            player.setReverb(data.rv);
        }
        if (data.rd !== undefined) {
            reverbDurSlider.value = data.rd;
            reverbDurVal.textContent = parseFloat(data.rd).toFixed(1);
            player.setReverbDuration(parseFloat(data.rd));
        }
        if (data.rw !== undefined) {
            reverbWetSlider.value = data.rw;
            reverbWetVal.textContent = data.rw;
            player.setReverbWet(data.rw / 100);
        }
    } catch (e) {
        // invalid hash, ignore
    }
}

restoreFromHash();

bpmSlider.addEventListener('input', () => {
    const bpm = parseInt(bpmSlider.value);
    bpmVal.textContent = bpm;
    player.setBpm(bpm);
});

// --- Filter + Reverb ---
const filterLowSlider  = document.getElementById('filterLow');
const filterHighSlider = document.getElementById('filterHigh');
const filterLowVal     = document.getElementById('filterLowVal');
const filterHighVal    = document.getElementById('filterHighVal');
const reverbCheckbox   = document.getElementById('reverb');
const reverbDurSlider  = document.getElementById('reverbDuration');
const reverbDurVal     = document.getElementById('reverbDurVal');
const reverbWetSlider  = document.getElementById('reverbWet');
const reverbWetVal     = document.getElementById('reverbWetVal');

function sliderToFreq(val) {
    if (val <= 0) return 0;
    return 20 * Math.pow(1100, val / 100); // 20 Hz → 22 kHz
}

function formatFreq(hz) {
    if (hz <= 0) return '0';
    if (hz >= 1000) return (hz / 1000).toFixed(1) + 'k';
    return Math.round(hz).toString();
}

filterLowSlider.addEventListener('input', () => {
    let lo = parseInt(filterLowSlider.value);
    let hi = parseInt(filterHighSlider.value);
    if (lo > hi) { lo = hi; filterLowSlider.value = lo; }
    const freq = sliderToFreq(lo);
    filterLowVal.textContent = formatFreq(freq);
    player.setFilterLow(freq);
});

filterHighSlider.addEventListener('input', () => {
    let lo = parseInt(filterLowSlider.value);
    let hi = parseInt(filterHighSlider.value);
    if (hi < lo) { hi = lo; filterHighSlider.value = hi; }
    const freq = sliderToFreq(hi);
    filterHighVal.textContent = formatFreq(freq);
    player.setFilterHigh(freq);
});

reverbCheckbox.addEventListener('change', () => {
    player.setReverb(reverbCheckbox.checked);
});

reverbDurSlider.addEventListener('input', () => {
    const dur = parseFloat(reverbDurSlider.value);
    reverbDurVal.textContent = dur.toFixed(1);
    player.setReverbDuration(dur);
});

reverbWetSlider.addEventListener('input', () => {
    const wet = parseInt(reverbWetSlider.value);
    reverbWetVal.textContent = wet;
    player.setReverbWet(wet / 100);
});

// --- Tick display ---
let lastDisplayTime = 0;

player.onTick = (pos, arrangement) => {
    const now = performance.now();
    if (now - lastDisplayTime > 40) {
        positionEl.textContent = `${pos.toFixed(1)} / ${arrangement.maxDuration}`;
        updatePlayhead(pos);
        updatePlaybackHighlight(pos);
        lastDisplayTime = now;
    }
};

// --- Oscilloscope (X/Y Lissajous) ---
const oscCanvas = document.getElementById('oscilloscope');
const oscCtx = oscCanvas.getContext('2d');
let oscFrame = null;
const OSC_FILL = 0.45; // how much of the canvas radius to fill

function drawOscilloscope() {
    oscFrame = requestAnimationFrame(drawOscilloscope);

    const dpr = window.devicePixelRatio || 1;
    const rect = oscCanvas.parentElement;
    const w = rect.clientWidth;
    const h = rect.clientHeight;
    if (oscCanvas.width !== w * dpr || oscCanvas.height !== h * dpr) {
        oscCanvas.width = w * dpr;
        oscCanvas.height = h * dpr;
    }
    oscCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fade previous frame for persistence effect
    oscCtx.fillStyle = 'rgba(17, 17, 17, 0.45)';
    oscCtx.fillRect(0, 0, w, h);

    if (!player.analyserL || !player.analyserR || !player.playing) {
        // Draw crosshairs when idle
        oscCtx.strokeStyle = '#333';
        oscCtx.lineWidth = 0.5;
        oscCtx.beginPath();
        oscCtx.moveTo(w / 2, 0); oscCtx.lineTo(w / 2, h);
        oscCtx.moveTo(0, h / 2); oscCtx.lineTo(w, h / 2);
        oscCtx.stroke();
        return;
    }

    const oscScale = OSC_FILL / player.peakAmplitude;

    const bufLen = player.analyserL.frequencyBinCount;
    const dataL = new Float32Array(bufLen);
    const dataR = new Float32Array(bufLen);
    player.analyserL.getFloatTimeDomainData(dataL);
    player.analyserR.getFloatTimeDomainData(dataR);

    // Crosshairs
    oscCtx.strokeStyle = '#222';
    oscCtx.lineWidth = 0.5;
    oscCtx.beginPath();
    oscCtx.moveTo(w / 2, 0); oscCtx.lineTo(w / 2, h);
    oscCtx.moveTo(0, h / 2); oscCtx.lineTo(w, h / 2);
    oscCtx.stroke();

    // Lissajous trace
    oscCtx.strokeStyle = '#0f0';
    oscCtx.lineWidth = 1.5;
    oscCtx.shadowColor = '#0f0';
    oscCtx.shadowBlur = 4;
    oscCtx.beginPath();
    for (let i = 0; i < bufLen; i++) {
        const x = (0.5 + dataL[i] * oscScale) * w;
        const y = (0.5 - dataR[i] * oscScale) * h;
        if (i === 0) oscCtx.moveTo(x, y);
        else oscCtx.lineTo(x, y);
    }
    oscCtx.stroke();
    oscCtx.shadowBlur = 0;
}

drawOscilloscope();
