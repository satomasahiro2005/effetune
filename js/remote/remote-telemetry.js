// PoC: analyzer mirror for the LAN remote control ("remote-v1" telemetry).
// While a client is subscribed, the main process asks for frames at the highest
// requested rate. Frames of Analyzer-category stages are copied off the telemetry
// hub (latest one per stage and frame type) and handed to main on each tick.
// Nothing here touches the audio thread.

const HEADER_BYTES = 16;
const DEFAULT_FPS = 15;
const MAX_FPS = 30;

export class RemoteTelemetry {
    constructor(win, api) {
        this.win = win;
        this.api = api;
        this.on = false;
        this.fps = DEFAULT_FPS;
        this.timer = null;
        this.taps = new Map();   // plugin.id -> { index, nm }
        this.latest = new Map(); // `${tapId}:${frameType}` -> { tapId, type, bytes }
        this.hub = null;
        this.onFrame = this.onFrame.bind(this);
        this.tick = this.tick.bind(this);
    }

    setControl(control) {
        const on = control?.on === true;
        const fps = Math.min(MAX_FPS, Math.max(1, Math.round(Number(control?.fps) || DEFAULT_FPS)));
        const audioManager = this.win.audioManager;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (!on) {
            if (this.hub?.mirrorListener === this.onFrame) this.hub.setMirrorListener(null);
            this.hub = null;
            if (this.on) audioManager?.setRemoteTelemetryDemand?.(false);
            this.on = false;
            this.latest.clear();
            this.taps.clear();
            return;
        }
        this.on = true;
        this.fps = fps;
        this.refreshTaps();
        this.hub = this.win.dspTelemetryHub || null;
        this.hub?.setMirrorListener?.(this.onFrame);
        audioManager?.setRemoteTelemetryDemand?.(true);
        this.period = 1000 / fps;
        this.nextAt = performance.now() + this.period;
        this.schedule();
    }

    // A fixed 1/fps schedule: setInterval runs slow on Windows' 15.6 ms timer grain.
    schedule() {
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.on) return;
            this.tick();
            const now = performance.now();
            this.nextAt = Math.max(this.nextAt + this.period, now);
            this.schedule();
        }, Math.max(0, this.nextAt - performance.now()));
    }

    // Called from TelemetryHub._dispatch. The packet goes back to the worklet as
    // soon as dispatch returns, and on the visual-sync path frame.byteOffset no
    // longer points at the header, so rebuild the header and copy the payload now.
    onFrame(frame) {
        if (!this.taps.has(frame.tapId)) return;
        const payloadBytes = frame.payloadBytes;
        const bytes = new Uint8Array(HEADER_BYTES + payloadBytes);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, frame.frameType, true);
        view.setUint16(2, frame.formatVersion, true);
        view.setUint32(4, frame.tapId, true);
        view.setUint32(8, frame.sequence, true);
        view.setUint16(12, payloadBytes, true);
        view.setUint16(14, frame.flags, true);
        const payload = frame.payload;
        bytes.set(new Uint8Array(payload.buffer, payload.byteOffset, payloadBytes), HEADER_BYTES);
        this.latest.set(`${frame.tapId}:${frame.frameType}`, {
            tapId: frame.tapId, type: frame.frameType, bytes
        });
    }

    refreshTaps() {
        const taps = new Map();
        const pipeline = this.win.audioManager?.pipeline || [];
        const analyzers = this.win.pluginManager?.effectCategories?.Analyzer?.plugins || [];
        pipeline.forEach((plugin, index) => {
            if (!plugin || !analyzers.includes(plugin.name)) return;
            if (!Number.isInteger(plugin.id)) return;
            taps.set(plugin.id, { index, nm: plugin.name });
        });
        this.taps = taps;
    }

    tick() {
        if (!this.on) return;
        // A PC-side edit may have moved or removed stages since the last tick.
        this.refreshTaps();
        // The hub may have been replaced by an audio reset.
        const hub = this.win.dspTelemetryHub || null;
        if (hub !== this.hub) {
            if (this.hub?.mirrorListener === this.onFrame) this.hub.setMirrorListener(null);
            this.hub = hub;
            hub?.setMirrorListener?.(this.onFrame);
        }
        const frames = [];
        for (const [key, entry] of this.latest) {
            const tap = this.taps.get(entry.tapId);
            if (!tap) continue;
            frames.push({ key, index: tap.index, nm: tap.nm, type: entry.type, bytes: entry.bytes });
        }
        this.latest.clear();
        if (frames.length > 0) {
            try { this.api.publishTelemetry(frames); } catch (_) { /* main went away */ }
        }
    }
}
