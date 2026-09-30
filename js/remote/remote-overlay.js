// PoC: PEQ spectrum overlay mirror for the LAN remote control ("remote-v1" telemetry,
// "overlays" feature). While a client subscribed with overlays:true, the worklet keeps a
// separate set of compare-mode taps (setRemoteSpectrumTaps) on every PEQ stage, and each
// telemetry tick turns the latest before/after buffers into Spectrum Analyzer v1 frames
// (type 4, 12 points, 2049 bins, unsmoothed dB; the client smooths). The app's own
// overlay (spectrumTaps / 'spectrumOverlay') is not touched.

export const OVERLAY_TYPES = new Set(['FiveBandPEQPlugin', 'FifteenBandPEQPlugin', 'FiveBandFIRPEQPlugin']);

const FFT_POINTS = 12;
const FFT_SIZE = 1 << FFT_POINTS;
const BIN_COUNT = (FFT_SIZE >> 1) + 1;              // 2049, DC..Nyquist
const HEADER_BYTES = 16;
const ANALYZER_HEADER_BYTES = 12;                   // f32 rate, u32 bins, u16 points, u16 flags
const PAYLOAD_BYTES = ANALYZER_HEADER_BYTES + BIN_COUNT * 4 * 2;
export const FRAME_BYTES = HEADER_BYTES + PAYLOAD_BYTES; // 16420
const FRAME_TYPE_SPECTRUM = 4;
const POWER_FLOOR = 1e-24;
const CORRECTION_DC_DB = 6.020599913279624;          // 10*log10(4)
const CORRECTION_AC_DB = 12.041199826559248;         // 10*log10(16)
const RESEND_MS = 1000;

let workspace = null;
function fftWorkspace() {
    if (workspace) return workspace;
    const window = new Float32Array(FFT_SIZE);
    const cos = new Float32Array(FFT_SIZE);
    const sin = new Float32Array(FFT_SIZE);
    const reverse = new Uint16Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
        const angle = 2 * Math.PI / FFT_SIZE * i;
        window[i] = 0.5 * (1 - Math.cos(angle));
        cos[i] = Math.cos(angle);
        sin[i] = -Math.sin(angle);
        let bits = i;
        for (let bit = 0; bit < FFT_POINTS; bit++, bits >>= 1) {
            reverse[i] = (reverse[i] << 1) | (bits & 1);
        }
    }
    workspace = {
        real: new Float32Array(FFT_SIZE), imag: new Float32Array(FFT_SIZE),
        window, cos, sin, reverse
    };
    return workspace;
}

// Unsmoothed level per bin (dB), exactly the FFT of plugins/spectrum-overlay.js analyze()
// and the dB scale of the Spectrum Analyzer kernel (DC and Nyquist are real only).
export function spectrumLevels(buffer, bufferPosition, out = new Float32Array(BIN_COUNT)) {
    const { real, imag, window, cos, sin, reverse } = fftWorkspace();
    imag.fill(0);
    for (let i = 0; i < FFT_SIZE; i++) {
        real[reverse[i]] = buffer[(bufferPosition + i) & (FFT_SIZE - 1)] * window[i];
    }
    for (let stage = 1, size = 2; size <= FFT_SIZE; stage++, size <<= 1) {
        const half = size >> 1;
        const shift = FFT_POINTS - stage;
        for (let i = 0; i < FFT_SIZE; i += size) {
            for (let j = i, k = 0; j < i + half; j++, k++) {
                const index = k << shift;
                const tr = real[j + half] * cos[index] - imag[j + half] * sin[index];
                const ti = real[j + half] * sin[index] + imag[j + half] * cos[index];
                real[j + half] = (real[j] - tr) * 0.5;
                imag[j + half] = (imag[j] - ti) * 0.5;
                real[j] = (real[j] + tr) * 0.5;
                imag[j] = (imag[j] + ti) * 0.5;
            }
        }
    }
    const nyquist = BIN_COUNT - 1;
    for (let b = 0; b < BIN_COUNT; b++) {
        const re = real[b];
        const im = b === 0 || b === nyquist ? 0 : imag[b];
        out[b] = 10 * Math.log10(re * re + im * im + POWER_FLOOR) + (b === 0 ? CORRECTION_DC_DB : CORRECTION_AC_DB);
    }
    return out;
}

// One Spectrum Analyzer v1 telemetry frame (16420 bytes, little-endian); peaks = current.
export function encodeSpectrumFrame(buffer, bufferPosition, sampleRate, tapId, sequence) {
    const bytes = new Uint8Array(FRAME_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, FRAME_TYPE_SPECTRUM, true);
    view.setUint16(2, 1, true);
    view.setUint32(4, tapId >>> 0, true);
    view.setUint32(8, sequence >>> 0, true);
    view.setUint16(12, PAYLOAD_BYTES, true);
    view.setUint16(14, 0, true);
    view.setFloat32(16, sampleRate, true);
    view.setUint32(20, BIN_COUNT, true);
    view.setUint16(24, FFT_POINTS, true);
    view.setUint16(26, 0, true);
    const current = new Float32Array(bytes.buffer, HEADER_BYTES + ANALYZER_HEADER_BYTES, BIN_COUNT);
    spectrumLevels(buffer, bufferPosition, current);
    new Float32Array(bytes.buffer, HEADER_BYTES + ANALYZER_HEADER_BYTES + BIN_COUNT * 4, BIN_COUNT).set(current);
    return bytes;
}

export class RemoteOverlay {
    constructor(win) {
        this.win = win;
        this.enabled = false;
        this.node = null;
        this.targets = new Map();   // plugin.id -> { index, nm }
        this.latest = new Map();    // plugin.id -> latest 'remoteSpectrumOverlay' message
        this.sequences = new Map(); // `${id}:${role}` -> last sequence
        this.sentJson = null;
        this.sentAt = 0;
        this.onMessage = this.onMessage.bind(this);
    }

    setEnabled(on) {
        on = on === true;
        if (on === this.enabled) return;
        this.enabled = on;
        if (on) return; // the first collect() binds the node and posts the taps
        const node = this.node;
        if (node) {
            try { node.port.postMessage({ type: 'setRemoteSpectrumTaps', pluginIds: [] }); } catch (_) { /* node gone */ }
            node.port.removeEventListener('message', this.onMessage);
        }
        this.node = null;
        this.targets.clear();
        this.latest.clear();
        this.sequences.clear();
        this.sentJson = null;
        this.sentAt = 0;
    }

    onMessage(event) {
        const data = event?.data;
        if (!data || data.type !== 'remoteSpectrumOverlay') return;
        if (!this.targets.has(data.spectrumPluginId)) return;
        this.latest.set(data.spectrumPluginId, data);
    }

    refreshTargets() {
        const targets = new Map();
        const pipeline = this.win.audioManager?.pipeline || [];
        pipeline.forEach((plugin, index) => {
            if (!plugin || !OVERLAY_TYPES.has(plugin.constructor?.name)) return;
            if (!Number.isInteger(plugin.id)) return;
            targets.set(plugin.id, { index, nm: plugin.name });
        });
        this.targets = targets;
    }

    bindNode() {
        const node = this.win.workletNode || null;
        if (node === this.node) return node;
        this.node?.port.removeEventListener('message', this.onMessage);
        this.node = node;
        this.latest.clear();
        this.sentJson = null;
        // The port is already started: audio-manager sets its onmessage.
        node?.port.addEventListener('message', this.onMessage);
        return node;
    }

    // Called from RemoteTelemetry.tick(). Returns [{ key, index, nm, type, role, bytes }].
    collect() {
        if (!this.enabled) return [];
        this.refreshTargets();
        const node = this.bindNode();
        if (node) {
            const ids = [...this.targets.keys()].sort((a, b) => a - b);
            const json = JSON.stringify(ids);
            const now = Date.now();
            // The periodic re-post restores ids the worklet pruned in an updatePlugins race.
            if (json !== this.sentJson || now - this.sentAt >= RESEND_MS) {
                try {
                    node.port.postMessage({ type: 'setRemoteSpectrumTaps', pluginIds: ids });
                    this.sentJson = json;
                    this.sentAt = now;
                } catch (_) { /* node gone; rebound next tick */ }
            }
        }
        const frames = [];
        for (const [id, m] of this.latest) {
            const target = this.targets.get(id);
            if (!target) continue;
            for (const [role, buffer] of [['after', m.outputBuffer], ['before', m.inputBuffer]]) {
                if (!(buffer instanceof Float32Array) || buffer.length !== FFT_SIZE) continue;
                const seqKey = `${id}:${role}`;
                const sequence = ((this.sequences.get(seqKey) ?? 0) + 1) >>> 0;
                this.sequences.set(seqKey, sequence);
                frames.push({
                    key: `ov:${id}:${role}`, index: target.index, nm: target.nm, type: FRAME_TYPE_SPECTRUM, role,
                    bytes: encodeSpectrumFrame(buffer, m.bufferPosition, m.sampleRate, id, sequence)
                });
            }
        }
        this.latest.clear();
        for (const key of this.sequences.keys()) {
            if (!this.targets.has(Number(key.slice(0, key.indexOf(':'))))) this.sequences.delete(key);
        }
        return frames;
    }
}
