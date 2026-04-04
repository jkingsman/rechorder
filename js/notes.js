const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteToFreq(name) {
    const m = name.match(/^([A-Ga-g])([#b]?)(\d+)$/);
    if (!m) return null;
    let semi = SEMITONES[m[1].toUpperCase()];
    if (m[2] === '#') semi++;
    if (m[2] === 'b') semi--;
    const midi = 12 * (parseInt(m[3]) + 1) + semi;
    return 440 * Math.pow(2, (midi - 69) / 12);
}

export function isNoteName(s) {
    return /^[A-Ga-g][#b]?\d+$/.test(s);
}

export function freqToNoteName(freq) {
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[midi % 12] + (Math.floor(midi / 12) - 1);
}

export function parseCentNote(name) {
    const m = name.match(/^([A-Ga-g][#b]?\d+)([+-]\d+)$/);
    if (!m) return null;
    return { baseName: m[1], cents: parseInt(m[2]) };
}

const FLAT_TO_SHARP = {
    Cb: 'B', Db: 'C#', Eb: 'D#', Fb: 'E', Gb: 'F#', Ab: 'G#', Bb: 'A#',
};

export function normalizeNoteName(name) {
    const m = name.match(/^([A-Ga-g])([#b]?)(\d+)$/);
    if (!m) return name;
    const letter = m[1].toUpperCase();
    const acc = m[2];
    let oct = parseInt(m[3]);
    if (acc === 'b') {
        const key = letter + 'b';
        if (FLAT_TO_SHARP[key]) {
            if (key === 'Cb') oct--;
            return FLAT_TO_SHARP[key] + oct;
        }
    }
    return letter + (acc === '#' ? '#' : '') + oct;
}
