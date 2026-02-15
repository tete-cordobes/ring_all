"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
electron_1.contextBridge.exposeInMainWorld('vibering', {
    // Terminal operations
    terminal: {
        create: (config) => electron_1.ipcRenderer.invoke('terminal:create', config),
        write: (id, data) => electron_1.ipcRenderer.invoke('terminal:write', { id, data }),
        resize: (id, cols, rows) => electron_1.ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
        focus: (id) => electron_1.ipcRenderer.invoke('terminal:focus', id),
        destroy: (id) => electron_1.ipcRenderer.invoke('terminal:destroy', id),
        inject: (id, command) => electron_1.ipcRenderer.invoke('terminal:inject', { id, command }),
        onOutput: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('terminal:output', handler);
            return () => electron_1.ipcRenderer.removeListener('terminal:output', handler);
        },
        onCreated: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('terminal:created', handler);
            return () => electron_1.ipcRenderer.removeListener('terminal:created', handler);
        },
        onExit: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('terminal:exit', handler);
            return () => electron_1.ipcRenderer.removeListener('terminal:exit', handler);
        },
    },
    // Voice operations
    voice: {
        startRecording: () => electron_1.ipcRenderer.invoke('voice:start-recording'),
        stopRecording: () => electron_1.ipcRenderer.invoke('voice:stop-recording'),
        transcribe: (audioBuffer) => electron_1.ipcRenderer.invoke('voice:transcribe', audioBuffer),
        speak: (text) => electron_1.ipcRenderer.invoke('voice:speak', text),
        onRecordingStarted: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('voice:recording-started', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:recording-started', handler);
        },
        onRecordingStopped: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('voice:recording-stopped', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:recording-stopped', handler);
        },
        onTranscribed: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('voice:transcribed', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:transcribed', handler);
        },
        onSpeaking: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('voice:speaking', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:speaking', handler);
        },
        onPlayAudio: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('voice:play-audio', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:play-audio', handler);
        },
        onSpeakNative: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('voice:speak-native', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:speak-native', handler);
        },
        onPTTPress: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('voice:ptt-press', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:ptt-press', handler);
        },
        onPTTRelease: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('voice:ptt-release', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:ptt-release', handler);
        },
        onToggleRecording: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('voice:toggle-recording', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:toggle-recording', handler);
        },
    },
    // Auth operations
    auth: {
        login: (creds) => electron_1.ipcRenderer.invoke('auth:login', creds),
        register: (data) => electron_1.ipcRenderer.invoke('auth:register', data),
        logout: () => electron_1.ipcRenderer.invoke('auth:logout'),
        check: () => electron_1.ipcRenderer.invoke('auth:check'),
    },
    // SSH operations
    ssh: {
        connect: (config) => electron_1.ipcRenderer.invoke('ssh:connect', config),
        disconnect: (id) => electron_1.ipcRenderer.invoke('ssh:disconnect', id),
        execute: (id, command) => electron_1.ipcRenderer.invoke('ssh:execute', { id, command }),
        write: (id, data) => electron_1.ipcRenderer.invoke('ssh:write', { id, data }),
        resize: (id, cols, rows) => electron_1.ipcRenderer.invoke('ssh:resize', { id, cols, rows }),
        getHistory: (id) => electron_1.ipcRenderer.invoke('ssh:get-history', id),
        // Profile management
        getProfiles: () => electron_1.ipcRenderer.invoke('ssh:get-profiles'),
        saveProfile: (profile) => electron_1.ipcRenderer.invoke('ssh:save-profile', profile),
        deleteProfile: (id) => electron_1.ipcRenderer.invoke('ssh:delete-profile', id),
        onConnected: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ssh:connected', handler);
            return () => electron_1.ipcRenderer.removeListener('ssh:connected', handler);
        },
        onOutput: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ssh:output', handler);
            return () => electron_1.ipcRenderer.removeListener('ssh:output', handler);
        },
        onDisconnected: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ssh:disconnected', handler);
            return () => electron_1.ipcRenderer.removeListener('ssh:disconnected', handler);
        },
        onError: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ssh:error', handler);
            return () => electron_1.ipcRenderer.removeListener('ssh:error', handler);
        },
    },
    // Agent navigation
    agent: {
        getCurrent: () => electron_1.ipcRenderer.invoke('agent:get-current'),
        setFocus: (id) => electron_1.ipcRenderer.invoke('agent:set-focus', id),
        onPrev: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('agent:prev', handler);
            return () => electron_1.ipcRenderer.removeListener('agent:prev', handler);
        },
        onNext: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('agent:next', handler);
            return () => electron_1.ipcRenderer.removeListener('agent:next', handler);
        },
        onFocused: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('agent:focused', handler);
            return () => electron_1.ipcRenderer.removeListener('agent:focused', handler);
        },
    },
    // Command interpreter + injection events
    command: {
        onInjected: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('command:injected', handler);
            return () => electron_1.ipcRenderer.removeListener('command:injected', handler);
        },
        interpret: (text) => electron_1.ipcRenderer.invoke('command:interpret', text),
        setDrivingMode: (enabled) => electron_1.ipcRenderer.invoke('command:driving-mode', enabled),
        getDrivingMode: () => electron_1.ipcRenderer.invoke('command:get-driving-mode'),
        onClaudeStatus: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('claude:status', handler);
            return () => electron_1.ipcRenderer.removeListener('claude:status', handler);
        },
    },
    // Ring controller events
    ring: {
        // HID operations
        scan: () => electron_1.ipcRenderer.invoke('ring:scan'),
        connect: (devicePath) => electron_1.ipcRenderer.invoke('ring:connect', devicePath),
        disconnect: () => electron_1.ipcRenderer.invoke('ring:disconnect'),
        getStatus: () => electron_1.ipcRenderer.invoke('ring:status'),
        // Debug mode for button detection
        setDebugMode: (enabled) => electron_1.ipcRenderer.invoke('ring:set-debug-mode', enabled),
        getDebugMode: () => electron_1.ipcRenderer.invoke('ring:get-debug-mode'),
        // Event listeners
        onScroll: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:scroll', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:scroll', handler);
        },
        onConnected: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:connected', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:connected', handler);
        },
        onDisconnected: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('ring:disconnected', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:disconnected', handler);
        },
        onEvent: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:event', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:event', handler);
        },
        onError: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:error', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:error', handler);
        },
        onStatus: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:status', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:status', handler);
        },
        onDebugData: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:debug-data', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:debug-data', handler);
        },
        onDebugMode: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('ring:debug-mode', handler);
            return () => electron_1.ipcRenderer.removeListener('ring:debug-mode', handler);
        },
    },
    // Narrator (OutputSynthesizer)
    narrator: {
        enable: () => electron_1.ipcRenderer.invoke('narrator:enable'),
        disable: () => electron_1.ipcRenderer.invoke('narrator:disable'),
        toggle: () => electron_1.ipcRenderer.invoke('narrator:toggle'),
        getStatus: () => electron_1.ipcRenderer.invoke('narrator:status'),
        onStatusChanged: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('narrator:status-changed', handler);
            return () => electron_1.ipcRenderer.removeListener('narrator:status-changed', handler);
        },
        onMetaCommand: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('voice:meta-command', handler);
            return () => electron_1.ipcRenderer.removeListener('voice:meta-command', handler);
        },
    },
    // Settings
    settings: {
        getApiKey: () => electron_1.ipcRenderer.invoke('settings:get-api-key'),
        saveApiKey: (key) => electron_1.ipcRenderer.invoke('settings:save-api-key', key),
    },
    // Remote Gateway
    remote: {
        startServer: () => electron_1.ipcRenderer.invoke('remote:start-server'),
        stopServer: () => electron_1.ipcRenderer.invoke('remote:stop-server'),
        getStatus: () => electron_1.ipcRenderer.invoke('remote:status'),
        getClients: () => electron_1.ipcRenderer.invoke('remote:get-clients'),
        setPort: (port) => electron_1.ipcRenderer.invoke('remote:set-port', port),
        getToken: () => electron_1.ipcRenderer.invoke('remote:get-token'),
        regenerateToken: () => electron_1.ipcRenderer.invoke('remote:regenerate-token'),
    },
    // Telegram Bot
    telegram: {
        start: (token) => electron_1.ipcRenderer.invoke('telegram:start', token),
        stop: () => electron_1.ipcRenderer.invoke('telegram:stop'),
        getStatus: () => electron_1.ipcRenderer.invoke('telegram:status'),
        setToken: (token) => electron_1.ipcRenderer.invoke('telegram:set-token', token),
    },
});
