const STEP_GAP_SEC = 0.008; // brief silence for step re-articulation

// --- Timeline construction ---

export function buildTimeline(channel) {
    const { elements } = channel;
    const segments = [];
    let pos = 0;

    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];

        if (el.type === 'note') {
            segments.push({
                type: 'note',
                start: pos,
                end: pos + el.duration,
                freq: el.freq,
                name: el.name,
                vol: el.vol ?? 1,
                accent: el.accent || false,
                panL: el.panL,
                panR: el.panR,
            });
            pos += el.duration;

        } else if (el.type === 'transition') {
            // Look backward for source note
            let fromFreq = null, fromVol = 1, fromPanL = null, fromPanR = null;
            for (let j = i - 1; j >= 0; j--) {
                if (elements[j].type === 'note') {
                    fromFreq = elements[j].freq;
                    fromVol = elements[j].vol ?? 1;
                    fromPanL = elements[j].panL;
                    fromPanR = elements[j].panR;
                    break;
                }
            }
            // Look forward for destination note
            let toFreq = null, toVol = 1, toPanL = null, toPanR = null;
            for (let j = i + 1; j < elements.length; j++) {
                if (elements[j].type === 'note') {
                    toFreq = elements[j].freq;
                    toVol = elements[j].vol ?? 1;
                    toPanL = elements[j].panL;
                    toPanR = elements[j].panR;
                    break;
                }
            }

            // Skip slides involving silence (freq=0 breaks log interpolation)
            if (fromFreq !== null && toFreq !== null && fromFreq > 0 && toFreq > 0) {
                segments.push({
                    type: 'slide',
                    start: pos,
                    end: pos + el.duration,
                    fromFreq, toFreq,
                    fromVol, toVol,
                    fromPanL, fromPanR, toPanL, toPanR,
                    easingFn: el.easingFn,
                    easingName: el.name,
                });
            }
            pos += el.duration;
        }
    }

    return { segments, totalDuration: pos };
}

// --- Frequency lookup ---

function getStateAtPosition(segments, pos) {
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (pos < seg.start || pos >= seg.end) continue;

        if (seg.type === 'note') {
            let vol = seg.vol;
            if (seg.accent && seg.end > seg.start) {
                const dur = seg.end - seg.start;
                const accentDur = dur / 8;
                const elapsed = pos - seg.start;
                if (elapsed < accentDur) {
                    // 200% → 100% over first 1/8th of duration
                    vol *= 2.0 - 1.0 * (elapsed / accentDur);
                }
            }
            return { freq: seg.freq, vol, panL: seg.panL, panR: seg.panR, segIndex: i };
        }

        // Slide: interpolate in log-frequency space for perceptual linearity
        const range = seg.end - seg.start;
        const t = range > 0 ? (pos - seg.start) / range : 1;
        const eased = seg.easingFn(t);
        const freq = seg.fromFreq * Math.pow(seg.toFreq / seg.fromFreq, eased);
        const vol = seg.fromVol + (seg.toVol - seg.fromVol) * eased;
        // Interpolate pan L/R if both endpoints have values
        let panL = null, panR = null;
        if (seg.fromPanL !== null && seg.toPanL !== null) {
            panL = seg.fromPanL + (seg.toPanL - seg.fromPanL) * eased;
            panR = seg.fromPanR + (seg.toPanR - seg.fromPanR) * eased;
        } else {
            panL = seg.toPanL ?? seg.fromPanL;
            panR = seg.toPanR ?? seg.fromPanR;
        }
        return { freq, vol, panL, panR, segIndex: i };
    }
    return null;
}

// --- Player ---

export class Player {
    constructor() {
        this.ctx = null;
        this.playing = false;
        this.bpm = 120;
        this.nodes = [];
        this.masterGain = null;
        this.position = 0;
        this.arrangement = null;
        this.lastTime = 0;
        this.animFrame = null;
        this.onTick = null;
        this.filterLow = 0;
        this.filterHigh = 22000;
        this.reverb = true;
        this.reverbDuration = 1;
        this.reverbWet = 0.6;
        this.highpassNode = null;
        this.lowpassNode = null;
        this.convolverNode = null;
        this.reverbGainNode = null;
        this._cleanupTimeout = null;
        this.analyserL = null;
        this.analyserR = null;
    }

    play(arrangement, startPos = 0) {
        if (this.playing) this.stop();

        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.ctx.resume();

        this.arrangement = arrangement;
        this.position = startPos;
        this.playing = true;

        // Master gain
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.7;

        // Cancel any pending cleanup from previous reverb tail
        if (this._cleanupTimeout) { clearTimeout(this._cleanupTimeout); this._cleanupTimeout = null; }

        // Filters
        this.highpassNode = this.ctx.createBiquadFilter();
        this.highpassNode.type = 'highpass';
        this.highpassNode.frequency.value = Math.max(this.filterLow, 1);
        this.highpassNode.Q.value = 0.7;

        this.lowpassNode = this.ctx.createBiquadFilter();
        this.lowpassNode.type = 'lowpass';
        this.lowpassNode.frequency.value = this.filterHigh;
        this.lowpassNode.Q.value = 0.7;

        // Reverb
        this.convolverNode = this.ctx.createConvolver();
        this.convolverNode.buffer = this._createImpulse(this.reverbDuration, 2);
        this.reverbGainNode = this.ctx.createGain();
        this.reverbGainNode.gain.value = this.reverb ? this.reverbWet : 0;

        // Stereo merger: all per-channel L/R gains feed into this
        this.merger = this.ctx.createChannelMerger(2);

        // Chain: merger → master → highpass → lowpass → destination + reverb path
        this.merger.connect(this.masterGain);
        this.masterGain.connect(this.highpassNode);
        this.highpassNode.connect(this.lowpassNode);
        this.lowpassNode.connect(this.ctx.destination);
        this.lowpassNode.connect(this.convolverNode);
        this.convolverNode.connect(this.reverbGainNode);
        this.reverbGainNode.connect(this.ctx.destination);

        // Oscilloscope: split stereo output into L/R analysers
        this.analyserL = this.ctx.createAnalyser();
        this.analyserR = this.ctx.createAnalyser();
        this.analyserL.fftSize = 2048;
        this.analyserR.fftSize = 2048;
        const splitter = this.ctx.createChannelSplitter(2);
        this.lowpassNode.connect(splitter);
        this.reverbGainNode.connect(splitter);
        splitter.connect(this.analyserL, 0);
        splitter.connect(this.analyserR, 1);

        const { channels } = arrangement;
        const n = channels.length;
        const perCh = 0.5 / Math.max(n, 1);

        // Compute expected peak amplitude per L/R for oscilloscope scaling.
        // Ignore accent transients (too brief to register visually) and use
        // sqrt-sum since uncorrelated waveforms don't add linearly.
        let sumSqL = 0, sumSqR = 0;
        for (let i = 0; i < n; i++) {
            let chMaxL = 0, chMaxR = 0;
            for (const seg of channels[i].segments) {
                const vol = seg.type === 'note' ? seg.vol
                    : Math.max(seg.fromVol, seg.toVol);
                const pL = (seg.panL ?? seg.fromPanL ?? 1);
                const pR = (seg.panR ?? seg.fromPanR ?? 1);
                chMaxL = Math.max(chMaxL, vol * pL);
                chMaxR = Math.max(chMaxR, vol * pR);
            }
            sumSqL += (perCh * chMaxL) ** 2;
            sumSqR += (perCh * chMaxR) ** 2;
        }
        this.peakAmplitude = this.masterGain.gain.value * Math.max(Math.sqrt(sumSqL), Math.sqrt(sumSqR), 0.01);

        for (let i = 0; i < n; i++) {
            const osc = this.ctx.createOscillator();
            const gainL = this.ctx.createGain();
            const gainR = this.ctx.createGain();
            osc.type = channels[i].voice || 'sine';
            osc.connect(gainL);
            osc.connect(gainR);
            gainL.connect(this.merger, 0, 0); // left channel
            gainR.connect(this.merger, 0, 1); // right channel
            gainL.gain.value = 0;
            gainR.gain.value = 0;

            const state = getStateAtPosition(channels[i].segments, startPos);
            if (state) osc.frequency.value = state.freq;

            osc.start();
            this.nodes.push({ osc, gainL, gainR, baseGain: perCh, lastSegIndex: null, lastPanL: null, lastPanR: null });
        }

        this.lastTime = performance.now();
        // Use setInterval for audio (runs in background tabs)
        this._interval = setInterval(() => this._audioTick(), 10);
        // Use rAF for UI updates only
        this._uiTick();
    }

    _audioTick() {
        if (!this.playing) return;

        const now = performance.now();
        const deltaSec = (now - this.lastTime) / 1000;
        this.lastTime = now;

        const secPerUnit = this.arrangement.defaultLength * 4 * (60 / this.bpm);
        this.position += deltaSec / secPerUnit;

        if (this.position >= this.arrangement.maxDuration) {
            this.position %= this.arrangement.maxDuration;
        }

        for (let i = 0; i < this.arrangement.channels.length; i++) {
            const ch = this.arrangement.channels[i];
            const node = this.nodes[i];
            const state = getStateAtPosition(ch.segments, this.position);

            if (state) {
                // Resolve L/R pan: persist last known pan when not specified
                if (state.panL !== null) { node.lastPanL = state.panL; node.lastPanR = state.panR; }
                const pL = node.lastPanL !== null ? node.lastPanL : 1;
                const pR = node.lastPanR !== null ? node.lastPanR : 1;
                const targetL = node.baseGain * state.vol * pL;
                const targetR = node.baseGain * state.vol * pR;

                const prevSeg = node.lastSegIndex !== null
                    ? ch.segments[node.lastSegIndex] : null;
                const currSeg = ch.segments[state.segIndex];
                const stepped = state.segIndex !== node.lastSegIndex
                    && (!prevSeg || (prevSeg.type === 'note' && currSeg.type === 'note'));

                if (stepped) {
                    const t = this.ctx.currentTime;
                    node.gainL.gain.cancelScheduledValues(t);
                    node.gainL.gain.setValueAtTime(0, t);
                    node.gainL.gain.linearRampToValueAtTime(targetL, t + STEP_GAP_SEC);
                    node.gainR.gain.cancelScheduledValues(t);
                    node.gainR.gain.setValueAtTime(0, t);
                    node.gainR.gain.linearRampToValueAtTime(targetR, t + STEP_GAP_SEC);
                } else {
                    // Must cancel lingering automation events before direct .value assignment,
                    // otherwise browsers may silently ignore the write.
                    const t = this.ctx.currentTime;
                    node.gainL.gain.cancelScheduledValues(t);
                    node.gainL.gain.value = targetL;
                    node.gainR.gain.cancelScheduledValues(t);
                    node.gainR.gain.value = targetR;
                }

                node.osc.frequency.value = state.freq;
                node.lastSegIndex = state.segIndex;
            } else {
                const t = this.ctx.currentTime;
                node.gainL.gain.cancelScheduledValues(t);
                node.gainL.gain.setValueAtTime(0, t);
                node.gainR.gain.cancelScheduledValues(t);
                node.gainR.gain.setValueAtTime(0, t);
                node.lastSegIndex = null;
            }
        }
    }

    _uiTick() {
        if (!this.playing) return;
        if (this.onTick) this.onTick(this.position, this.arrangement);
        this.animFrame = requestAnimationFrame(() => this._uiTick());
    }

    stop() {
        this.playing = false;
        if (this._interval) { clearInterval(this._interval); this._interval = null; }
        if (this.animFrame) { cancelAnimationFrame(this.animFrame); this.animFrame = null; }
        if (this._cleanupTimeout) { clearTimeout(this._cleanupTimeout); this._cleanupTimeout = null; }

        // Stop oscillators (cuts input; reverb tail continues naturally)
        for (const node of this.nodes) {
            try { node.osc.stop(); } catch (_) {}
        }

        // Capture refs for delayed cleanup
        const ctx = this.ctx;
        const toDisconnect = [
            ...this.nodes.flatMap(n => [n.osc, n.gainL, n.gainR]),
            this.masterGain, this.highpassNode, this.lowpassNode,
            this.convolverNode, this.reverbGainNode,
            this.analyserL, this.analyserR, this.merger,
        ].filter(Boolean);

        // Null out immediately so play() can create fresh nodes
        this.nodes = [];
        this.masterGain = null;
        this.highpassNode = null;
        this.lowpassNode = null;
        this.convolverNode = null;
        this.reverbGainNode = null;
        this.analyserL = null;
        this.analyserR = null;
        this.merger = null;
        this.ctx = null;

        // Delay cleanup to let reverb tail fade
        const tailMs = this.reverb ? this.reverbDuration * 1000 + 500 : 50;
        this._cleanupTimeout = setTimeout(() => {
            for (const n of toDisconnect) try { n.disconnect(); } catch (_) {}
            try { ctx.close(); } catch (_) {}
            this._cleanupTimeout = null;
        }, tailMs);
    }

    setBpm(bpm) {
        this.bpm = bpm;
    }

    setFilterLow(freq) {
        this.filterLow = freq;
        if (this.highpassNode) this.highpassNode.frequency.value = Math.max(freq, 1);
    }

    setFilterHigh(freq) {
        this.filterHigh = freq;
        if (this.lowpassNode) this.lowpassNode.frequency.value = freq;
    }

    setReverb(on) {
        this.reverb = on;
        if (this.reverbGainNode) this.reverbGainNode.gain.value = on ? this.reverbWet : 0;
    }

    setReverbDuration(dur) {
        this.reverbDuration = dur;
        // Impulse buffer is regenerated on next play()
    }

    setReverbWet(val) {
        this.reverbWet = val;
        if (this.reverb && this.reverbGainNode) this.reverbGainNode.gain.value = val;
    }

    _createImpulse(duration, decay) {
        const rate = this.ctx.sampleRate;
        const length = rate * duration;
        const impulse = this.ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = impulse.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        return impulse;
    }
}
