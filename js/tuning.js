import { noteToFreq } from './notes.js';

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const MIN_OCTAVE = 0;
const MAX_OCTAVE = 10;

// Ordered list: C0, C#0, … B9, C10
const ALL_NOTES = [];
for (let oct = MIN_OCTAVE; oct <= MAX_OCTAVE; oct++) {
    const last = oct === MAX_OCTAVE ? 0 : 11;
    for (let i = 0; i <= last; i++) ALL_NOTES.push(NOTE_NAMES[i] + oct);
}

const freq = new Map();

export function allNoteNames() { return ALL_NOTES; }
export function getFreq(name)  { return freq.get(name) ?? null; }

export function setFreq(name, hz) {
    if (hz === null || hz === undefined || isNaN(hz) || hz <= 0) {
        freq.delete(name);
    } else {
        freq.set(name, hz);
    }
}

export function resetTo12TET() {
    for (const n of ALL_NOTES) freq.set(n, noteToFreq(n));
}

export function clearAll() {
    freq.clear();
}

// --- Custom note aliases ---
const customNotes = new Map();

export function setCustomNote(name, freq) {
    const key = name.toLowerCase();
    if (freq === null || freq === undefined || isNaN(freq) || freq <= 0) {
        customNotes.delete(key);
    } else {
        customNotes.set(key, freq);
    }
}

export function getCustomFreq(name) {
    return customNotes.get(name.toLowerCase()) ?? null;
}

export function hasCustomNote(name) {
    return customNotes.has(name.toLowerCase());
}

export function clearCustomNotes() {
    customNotes.clear();
}

export function allCustomNotes() {
    return [...customNotes.entries()];
}

// Start with standard tuning
resetTo12TET();
