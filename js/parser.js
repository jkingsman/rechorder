import { isNoteName, normalizeNoteName, parseCentNote } from './notes.js';
import { getFreq, getCustomFreq } from './tuning.js';
import { getEasing } from './easing.js';

const VOICES = ['sine', 'triangle', 'tri', 'square', 'sawtooth', 'saw'];
const VOICE_ALIASES = { saw: 'sawtooth', tri: 'triangle' };

// Strip comment: # preceded by start-of-line or whitespace begins a comment
function stripComment(line) {
    for (let i = 0; i < line.length; i++) {
        if (line[i] === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
            return line.slice(0, i);
        }
    }
    return line;
}

export function parse(text) {
    const rawLines = text.split('\n');
    let defaultLength = 1 / 8;
    const channels = [];
    const errors = [];
    const missingNotes = new Set();

    for (let lineNum = 0; lineNum < rawLines.length; lineNum++) {
        const line = stripComment(rawLines[lineNum]).trim();
        if (!line) continue;

        // L: header — default note length
        if (/^L:/i.test(line)) {
            const m = line.match(/^L:\s*(\d+)\s*\/\s*(\d+)/i);
            if (m) {
                const val = parseInt(m[1]) / parseInt(m[2]);
                if (isFinite(val) && val > 0) {
                    defaultLength = val;
                } else {
                    errors.push(`Invalid L: value: ${line}`);
                }
            } else {
                errors.push(`Invalid L: header: ${line}`);
            }
            continue;
        }

        // Skip known single-letter ABC headers (T:, M:, K:, etc.)
        if (/^[TMKQXVW]:/i.test(line)) continue;

        // Named channel: "Name|voice|body" or "Name|body" or just body
        let channelName = null;
        let channelVoice = null;
        let channelBody = line;
        const pipeParts = line.split('|');
        if (pipeParts.length >= 3) {
            // name|voice|body
            channelName = pipeParts[0].trim() || null;
            const v = pipeParts[1].trim().toLowerCase();
            if (VOICES.includes(v)) {
                channelVoice = VOICE_ALIASES[v] || v;
            } else if (v) {
                errors.push(`Line ${lineNum}: unknown voice "${v}"`);
            }
            channelBody = pipeParts.slice(2).join('|').trim();
        } else if (pipeParts.length === 2) {
            // Could be name|body or voice|body
            const first = pipeParts[0].trim();
            const second = pipeParts[1].trim();
            if (VOICES.includes(first.toLowerCase())) {
                channelVoice = VOICE_ALIASES[first.toLowerCase()] || first.toLowerCase();
                channelBody = second;
            } else {
                channelName = first || null;
                channelBody = second;
            }
        }

        if (!channelBody) continue;

        const channel = parseChannel(channelBody, errors, missingNotes, lineNum);
        if (channel && channel.elements.length > 0) {
            channel.name = channelName;
            channel.voice = channelVoice;
            channels.push(channel);
        }
    }

    return { defaultLength, channels, errors, missingNotes: [...missingNotes] };
}

function parseDuration(str) {
    if (!str) return 1;
    str = str.trim();
    if (!str) return 1;
    const m = str.match(/^(\d+)?(?:\/(\d+))?$/);
    if (!m) return null;
    const num = m[1] ? parseInt(m[1]) : 1;
    const den = m[2] ? parseInt(m[2]) : 1;
    return num / den;
}

function parseChannel(line, errors, missingNotes, lineNum) {
    const parts = line.split('>').map(s => s.trim()).filter(s => s);
    const elements = [];

    for (let b = 0; b < parts.length; b++) {
        const part = parts[b];
        const loc = `Line ${lineNum}, block ${b + 1}`;

        // Element format: name:duration=vol (colon required)
        const colonIdx = part.indexOf(':');
        let name, suffix;
        if (colonIdx < 0) {
            name = part.trim();
            suffix = '';
        } else {
            name = part.slice(0, colonIdx).trim();
            suffix = part.slice(colonIdx + 1).trim();
        }

        // Accent prefix
        let accent = false;
        if (name.startsWith('!')) {
            accent = true;
            name = name.slice(1);
        }

        if (!name) {
            errors.push(`${loc}: empty name in "${part}"`);
            continue;
        }

        // Split off (L/R) pan suffix — independent L/R volume scalars 0–100
        let panL = null, panR = null;
        const panMatch = suffix.match(/\((\d+)\/(\d+)\)\s*$/);
        if (panMatch) {
            panL = parseInt(panMatch[1]) / 100;
            panR = parseInt(panMatch[2]) / 100;
            suffix = suffix.slice(0, panMatch.index);
        }

        // Split off =volume suffix (0-100 → normalized to 0.0-1.0)
        let vol = null;
        const eqIdx = suffix.indexOf('=');
        if (eqIdx !== -1) {
            const volStr = suffix.slice(eqIdx + 1);
            const v = parseInt(volStr);
            if (isNaN(v) || v < 0 || v > 100) {
                errors.push(`${loc}: expected numerical volume 0-100, got '${volStr}'`);
            } else {
                vol = v / 100;
            }
            suffix = suffix.slice(0, eqIdx);
        }

        const dur = parseDuration(suffix);
        if (dur === null || !isFinite(dur) || dur < 0) {
            errors.push(`${loc}: invalid duration "${suffix}"`);
            continue;
        }

        // Classify the name
        if (/^[sS]$/.test(name)) {
            // Silence
            elements.push({ type: 'note', name, freq: 0, duration: dur, vol: 0.0, panL, panR });
        } else {
            const rawHz = parseFloat(name);
            if (isFinite(rawHz) && rawHz > 0 && /^\d+(\.\d+)?$/.test(name)) {
                // Raw Hz
                elements.push({ type: 'note', name, freq: rawHz, duration: dur, vol, accent, panL, panR });
            } else if (isNoteName(name)) {
                // Standard note
                const normalized = normalizeNoteName(name);
                const freq = getFreq(normalized);
                if (freq === null) {
                    missingNotes.add(normalized);
                    elements.push({ type: 'note', name, freq: 0, duration: dur, vol: 0, panL, panR });
                } else {
                    elements.push({ type: 'note', name, freq, duration: dur, vol, accent, panL, panR });
                }
            } else {
                // Cent-adjusted note (e.g. C4+50, Bb3-20)
                const cent = parseCentNote(name);
                if (cent) {
                    const normalized = normalizeNoteName(cent.baseName);
                    const baseFreq = getFreq(normalized);
                    if (baseFreq === null) {
                        missingNotes.add(normalized);
                        elements.push({ type: 'note', name, freq: 0, duration: dur, vol: 0, panL, panR });
                    } else {
                        const freq = baseFreq * Math.pow(2, cent.cents / 1200);
                        elements.push({ type: 'note', name, freq, duration: dur, vol, accent, panL, panR });
                    }
                } else {
                    // Custom note alias
                    const customFreq = getCustomFreq(name);
                    if (customFreq !== null) {
                        elements.push({ type: 'note', name, freq: customFreq, duration: dur, vol, accent, panL, panR });
                    } else {
                        // Easing / transition
                        const easingFn = getEasing(name);
                        if (!easingFn) {
                            errors.push(`${loc}: unknown note or easing "${name}"`);
                            elements.push({ type: 'note', name, freq: 0, duration: dur, vol: 0, panL, panR });
                        } else {
                            elements.push({ type: 'transition', name, easingFn, duration: dur });
                        }
                    }
                }
            }
        }
    }

    return { elements };
}
