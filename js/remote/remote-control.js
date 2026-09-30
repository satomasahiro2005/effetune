// PoC: renderer side of the LAN remote control ("remote-v1").
// The WebSocket server lives in the main process (electron/remote-control-host.cjs).
// Here we answer forwarded client operations against the live pipeline and publish
// pipeline snapshots (throttled to <= 10 Hz) whenever it changes.

import {
    convertLongToShortFormat,
    getSerializablePluginStateShort
} from '../utils/serialization-utils.js';

const STATE_MIN_INTERVAL_MS = 100;
const SAFETY_POLL_MS = 1000;
const HISTORY_SAVE_DEBOUNCE_MS = 1000;

export async function startRemoteControl(win = window) {
    const api = win.electronAPI?.remoteV1;
    if (!api || win.remoteControlController) return win.remoteControlController || null;
    const controller = new RemoteControl(win, api);
    win.remoteControlController = controller;
    const started = await controller.start();
    if (!started) win.remoteControlController = null;
    return started ? controller : null;
}

class RemoteControl {
    constructor(win, api) {
        this.win = win;
        this.api = api;
        this.lastSentJson = null;
        this.lastSentAt = 0;
        this.publishTimer = null;
        this.pollTimer = null;
        this.historyTimer = null;
        this.disposeRequestListener = null;
    }

    async start() {
        this.disposeRequestListener = this.api.onRequest(request => {
            void this.handleRequest(request);
        });
        let status;
        try {
            status = await this.api.rendererReady();
        } catch (error) {
            console.warn('[remote] renderer-ready failed:', error);
            status = null;
        }
        if (!status || status.enabled !== true) {
            this.disposeRequestListener?.();
            this.disposeRequestListener = null;
            return false;
        }
        this.installHooks();
        this.win.addEventListener('pagehide', () => {
            this.api.rendererUnavailable().catch(() => {});
        }, { once: true });
        console.log('[remote] renderer ready; remote control enabled');
        this.schedulePublish();
        return true;
    }

    // ---- state -----------------------------------------------------------

    takeSnapshot() {
        const audioManager = this.win.audioManager;
        const pipeline = (audioManager?.pipeline || []).map(plugin =>
            getSerializablePluginStateShort(plugin)
        );
        return { masterBypass: !!audioManager?.masterBypass, pipeline };
    }

    installHooks() {
        const self = this;
        const uiManager = this.win.uiManager;
        if (uiManager && typeof uiManager.updateURL === 'function') {
            const original = uiManager.updateURL;
            // Hook before the Double Blind Test early return inside updateURL.
            uiManager.updateURL = function (...args) {
                try { self.schedulePublish(); } catch (_) { /* never break the app */ }
                return original.apply(this, args);
            };
        }
        const audioManager = this.win.audioManager;
        if (audioManager && typeof audioManager.setMasterBypass === 'function') {
            const original = audioManager.setMasterBypass;
            audioManager.setMasterBypass = function (...args) {
                const result = original.apply(this, args);
                try { self.schedulePublish(); } catch (_) { /* ignore */ }
                return result;
            };
        }
        // Safety net for mutations that do not reach updateURL.
        this.pollTimer = setInterval(() => this.schedulePublish(), SAFETY_POLL_MS);
    }

    schedulePublish() {
        if (this.publishTimer) return;
        const wait = Math.max(0, STATE_MIN_INTERVAL_MS - (Date.now() - this.lastSentAt));
        this.publishTimer = setTimeout(() => {
            this.publishTimer = null;
            this.publishNow();
        }, wait);
    }

    publishNow() {
        let snapshot;
        try {
            snapshot = this.takeSnapshot();
        } catch (error) {
            console.warn('[remote] snapshot failed:', error);
            return;
        }
        const json = JSON.stringify(snapshot);
        if (json === this.lastSentJson) return;
        this.lastSentJson = json;
        this.lastSentAt = Date.now();
        this.api.publishState(snapshot).catch(() => {
            this.lastSentJson = null;
        });
    }

    // ---- requests --------------------------------------------------------

    async handleRequest(request) {
        const requestId = request?.requestId;
        if (typeof requestId !== 'string') return;
        let response;
        try {
            const result = await this.execute(request.message || {});
            response = { requestId, ok: true, ...result };
        } catch (error) {
            response = { requestId, ok: false, error: String(error?.message || error) };
        }
        try {
            response.snapshot = this.takeSnapshot();
            this.lastSentJson = JSON.stringify(response.snapshot);
            this.lastSentAt = Date.now();
        } catch (_) { /* snapshot is best effort */ }
        try {
            await this.api.respond(response);
        } catch (error) {
            console.warn('[remote] respond failed:', error);
        }
    }

    async execute(msg) {
        switch (msg.op) {
            case 'hello':
            case 'get':
                return {};
            case 'chain':
                return this.opChain(msg);
            case 'params':
                return this.opParams(msg);
            case 'bypass':
                return this.opBypass(msg);
            case 'listPresets':
                return this.opListPresets();
            case 'getPreset':
                return this.opGetPreset(msg);
            default:
                throw new Error('unknown-op: ' + msg.op);
        }
    }

    requireApp() {
        const { audioManager, pipelineManager, pluginManager } = this.win;
        if (!audioManager || !pipelineManager || !pluginManager) throw new Error('app-not-ready');
        return { audioManager, pipelineManager, pluginManager };
    }

    async opChain(msg) {
        const { audioManager, pipelineManager, pluginManager } = this.requireApp();
        const items = msg.pipeline;
        if (!Array.isArray(items)) throw new Error('pipeline must be an array');
        for (const [i, item] of items.entries()) {
            if (!item || typeof item !== 'object' || typeof item.nm !== 'string') {
                throw new Error('invalid item at ' + i);
            }
            if (!pluginManager.isPluginAvailable(item.nm)) {
                throw new Error('unknown effect: ' + item.nm);
            }
        }
        const previousBypass = !!audioManager.masterBypass;
        const ok = await pipelineManager.presetManager.loadPreset({
            name: 'Remote',
            plugins: items.map(item => ({ ...item }))
        });
        if (ok === false) throw new Error('chain rejected by preset loader');
        // loadPreset forces master bypass OFF; put the previous state back.
        if (previousBypass) this.setBypass(true);
        return {};
    }

    // Mirrors the master toggle click handler in pipeline-core.js.
    setBypass(on) {
        const { pipelineManager } = this.requireApp();
        const core = pipelineManager.core;
        core.enabled = !on;
        const toggle = core.masterToggle || this.win.document.querySelector('.toggle-button.master-toggle');
        toggle?.classList.toggle('off', on);
        core.workletSync.updateMasterBypass(on);
        core.updateAllPluginDisplayState?.();
    }

    opBypass(msg) {
        if (typeof msg.on !== 'boolean') throw new Error('on must be boolean');
        this.setBypass(msg.on);
        return {};
    }

    opParams(msg) {
        const { audioManager, pipelineManager } = this.requireApp();
        const index = msg.index;
        const pipeline = audioManager.pipeline;
        if (!Number.isInteger(index) || index < 0 || index >= pipeline.length) {
            throw new Error('index out of range: ' + index);
        }
        const params = msg.params;
        if (!params || typeof params !== 'object' || Array.isArray(params)) {
            throw new Error('params must be an object');
        }
        const plugin = pipeline[index];
        const { nm, en, ib, ob, ch, ...rest } = params;
        if (Object.keys(rest).length > 0) plugin.setParameters(rest);
        if (typeof en === 'boolean') plugin.setEnabled(en);
        if (ib !== undefined) plugin.inputBus = ib;
        if (ob !== undefined) plugin.outputBus = ob;
        if (ch !== undefined) plugin.channel = ch === '' ? null : ch;
        pipelineManager.core.updateWorkletPlugin(plugin);
        plugin.syncUIControls?.();
        pipelineManager.core.updateAllPluginDisplayState?.();
        this.win.uiManager?.updateURL?.();
        this.scheduleHistorySave();
        return {};
    }

    scheduleHistorySave() {
        if (this.historyTimer) clearTimeout(this.historyTimer);
        this.historyTimer = setTimeout(() => {
            this.historyTimer = null;
            this.win.pipelineManager?.historyManager?.saveState?.();
        }, HISTORY_SAVE_DEBOUNCE_MS);
    }

    async opListPresets() {
        const { pipelineManager } = this.requireApp();
        const presets = await pipelineManager.presetManager.getPresets();
        return { names: Object.keys(presets || {}) };
    }

    async opGetPreset(msg) {
        const { pipelineManager } = this.requireApp();
        if (typeof msg.name !== 'string') throw new Error('name must be a string');
        const presets = await pipelineManager.presetManager.getPresets();
        const preset = Object.prototype.hasOwnProperty.call(presets || {}, msg.name)
            ? presets[msg.name]
            : null;
        if (!preset) throw new Error('preset not found: ' + msg.name);
        let pipeline;
        if (Array.isArray(preset.pipeline)) {
            pipeline = preset.pipeline.map(convertLongToShortFormat);
        } else if (Array.isArray(preset.plugins)) {
            pipeline = preset.plugins;
        } else {
            throw new Error('unrecognized preset format');
        }
        return { name: msg.name, pipeline };
    }
}
