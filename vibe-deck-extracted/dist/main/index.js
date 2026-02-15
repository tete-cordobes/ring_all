"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const dotenv = __importStar(require("dotenv"));
const electron_store_1 = __importDefault(require("electron-store"));
// Load .env file from project root
dotenv.config({ path: path.join(__dirname, '../../.env') });
// Initialize store
const store = new electron_store_1.default();
// DEBUG: Simple logger to file
const fs = require('fs');
const logPath = path.join(electron_1.app.getPath('desktop'), 'vibe-deck-debug.log');
function log(msg) {
    const time = new Date().toISOString();
    const logMsg = `[${time}] ${msg}\n`;
    try {
        fs.appendFileSync(logPath, logMsg);
    }
    catch (e) {
        console.error('Failed to log:', e);
    }
}
log('--- App Starting ---');
log(`UserData: ${electron_1.app.getPath('userData')}`);
const terminal_manager_1 = require("./terminal-manager");
const voice_pipeline_1 = require("./voice-pipeline");
const ssh_manager_1 = require("./ssh-manager");
const ring_manager_1 = require("./ring-manager");
const auth_manager_1 = require("./auth-manager");
const output_synthesizer_1 = require("./output-synthesizer");
const { RemoteGateway } = require("./remote-gateway");
const { CommandInterpreter } = require("./command-interpreter");
const { TelegramBot } = require("./telegram-bot");
console.log('OPENAI_API_KEY configured:', !!process.env.OPENAI_API_KEY);
let mainWindow = null;
let terminalManager;
let voicePipeline;
let sshManager;
let ringManager;
let authManager;
let outputSynthesizer;
let remoteGateway = null;
let commandInterpreter = null;
let telegramBot = null;
const isDev = !electron_1.app.isPackaged;
// Set app name explicitly
electron_1.app.name = 'Vibe Deck';
function createWindow() {
    const { width, height } = electron_1.screen.getPrimaryDisplay().workAreaSize;
    try {
        mainWindow = new electron_1.BrowserWindow({
            width: Math.min(1400, width * 0.85),
            height: Math.min(900, height * 0.85),
            minWidth: 800,
            minHeight: 600,
            frame: false,
            transparent: true,
            vibrancy: 'under-window',
            visualEffectState: 'active',
            backgroundColor: '#00000000',
            titleBarStyle: 'hidden',
            trafficLightPosition: { x: 16, y: 16 },
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js'),
            },
        });
    }
    catch (e) {
        console.error('Error creating BrowserWindow:', e);
    }
    // Set icon for macOS Dock (useful in dev mode)
    if (process.platform === 'darwin' && isDev) {
        const iconPath = path.resolve(__dirname, '../../build/icon.png');
        try {
            electron_1.app.dock.setIcon(iconPath);
        }
        catch (e) {
            console.error('Error setting icon:', e);
        }
    }
    // Initialize managers
    try {
        authManager = new auth_manager_1.AuthManager();
        terminalManager = new terminal_manager_1.TerminalManager(mainWindow);
        voicePipeline = new voice_pipeline_1.VoicePipeline(mainWindow);
    }
    catch (e) {
        console.error('Error initializing managers:', e);
    }
    // Load stored API Key if available
    const storedGroqKey = store.get('groqApiKey');
    if (storedGroqKey) {
        voicePipeline.updateGroqKey(storedGroqKey);
    }
    // Initialize OutputSynthesizer (narrator)
    outputSynthesizer = new output_synthesizer_1.OutputSynthesizer(mainWindow);
    outputSynthesizer.setVoicePipeline(voicePipeline);
    // Wire terminal output to narrator AND remote gateway
    terminalManager.setOutputCallback((id, data) => {
        outputSynthesizer.processTerminalOutput(id, data);
        if (remoteGateway) {
            remoteGateway.broadcastToClients('output', { terminalId: id, data });
        }
    });
    // Initialize Command Interpreter (Phases 2+3)
    commandInterpreter = new CommandInterpreter({
        terminalManager,
        voicePipeline,
        outputSynthesizer,
        mainWindow,
        store,
    });
    // Wire command interpreter callbacks
    commandInterpreter.setOnNarrate((text) => {
        voicePipeline.speak(text);
    });
    commandInterpreter.setOnClaudeStatus((status) => {
        mainWindow.webContents.send('claude:status', status);
        if (remoteGateway) {
            remoteGateway.broadcastToClients('claude_status', status);
        }
    });
    // Initialize Remote Gateway (Phase 1)
    remoteGateway = new RemoteGateway({
        port: store.get('remotePort', 7777),
        voicePipeline,
        terminalManager,
        outputSynthesizer,
        commandInterpreter,
        mainWindow,
        store,
    });
    // Initialize Telegram Bot (Phase 5)
    telegramBot = new TelegramBot({
        voicePipeline,
        terminalManager,
        commandInterpreter,
        outputSynthesizer,
        mainWindow,
        store,
    });
    // Auto-start remote gateway if previously enabled
    if (store.get('remoteAutoStart', false)) {
        remoteGateway.start();
    }
    // Auto-start telegram if token exists
    const tgToken = store.get('telegramBotToken');
    if (tgToken) {
        telegramBot.start(tgToken).catch(err => {
            console.error('Failed to auto-start Telegram bot:', err.message);
        });
    }
    // Wire voice meta-commands (e.g. "enable narrator", "disable narrator")
    voicePipeline.setMetaCommandHandler((command) => {
        if (command === 'narrator:enable') {
            outputSynthesizer.enable();
            voicePipeline.speak('Narrator enabled');
            return { enabled: true };
        }
        if (command === 'narrator:disable') {
            outputSynthesizer.disable();
            voicePipeline.speak('Narrator disabled');
            return { enabled: false };
        }
        return null;
    });
    sshManager = new ssh_manager_1.SSHManager(mainWindow);
    ringManager = new ring_manager_1.RingManager(mainWindow);
    // Connect Ring navigation to terminal manager
    ringManager.setNavigationCallbacks(() => terminalManager.focusPreviousAgent(), () => terminalManager.focusNextAgent(), () => {
        const current = terminalManager.getCurrentAgent();
        if (current) {
            terminalManager.injectCommand(current.id, '\r');
        }
    });
    // Load the app
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
    }
    else {
        mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
    // Open DevTools in development
    if (isDev && mainWindow) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    // Setup global shortcuts for mouse buttons (fallback)
    setupGlobalShortcuts(mainWindow);
    mainWindow.on('closed', () => {
        mainWindow = null;
        terminalManager?.cleanup();
        sshManager?.cleanup();
        ringManager?.cleanup();
    });
}
function setupGlobalShortcuts(mainWindow) {
    // Mouse button shortcuts (these work as keyboard shortcuts too)
    // Side Button 1 (Back) - Previous Agent
    // REMOVED: Conflicto con navegación del sistema y ratón del usuario
    /*
    globalShortcut.register('Alt+Left', () => {
      terminalManager.focusPreviousAgent();
    });
    */
    // Side Button 2 (Forward) - Next Agent
    // REMOVED: Conflicto con navegación del sistema y ratón del usuario
    /*
    globalShortcut.register('Alt+Right', () => {
      terminalManager.focusNextAgent();
    });
    */
    // Push-to-Talk Toggle
    electron_1.globalShortcut.register('CommandOrControl+Shift+Space', () => {
        voicePipeline.toggleRecording();
    });
}
// IPC Handlers
electron_1.ipcMain.handle('terminal:create', async (_, config) => {
    return terminalManager.createTerminal(config);
});
electron_1.ipcMain.handle('terminal:write', async (_, { id, data }) => {
    terminalManager.writeToTerminal(id, data);
});
electron_1.ipcMain.handle('terminal:resize', async (_, { id, cols, rows }) => {
    terminalManager.resizeTerminal(id, cols, rows);
});
electron_1.ipcMain.handle('terminal:focus', async (_, id) => {
    terminalManager.focusTerminal(id);
});
electron_1.ipcMain.handle('terminal:destroy', async (_, id) => {
    terminalManager.destroyTerminal(id);
});
electron_1.ipcMain.handle('terminal:inject', async (_, { id, command }) => {
    terminalManager.injectCommand(id, command);
});
// Voice Pipeline handlers
electron_1.ipcMain.handle('voice:start-recording', async () => {
    return voicePipeline.startRecording();
});
electron_1.ipcMain.handle('voice:stop-recording', async () => {
    return voicePipeline.stopRecording();
});
electron_1.ipcMain.handle('voice:transcribe', async (_, audioBuffer) => {
    return voicePipeline.transcribe(audioBuffer);
});
electron_1.ipcMain.handle('voice:speak', async (_, text) => {
    return voicePipeline.speak(text);
});
// Settings Handlers
electron_1.ipcMain.handle('settings:get-api-key', async () => {
    return store.get('groqApiKey') || process.env.GROQ_API_KEY || '';
});
electron_1.ipcMain.handle('settings:save-api-key', async (_, key) => {
    store.set('groqApiKey', key);
    if (voicePipeline) {
        voicePipeline.updateGroqKey(key);
    }
    return true;
});
// SSH handlers
electron_1.ipcMain.handle('ssh:connect', async (_, config) => {
    return sshManager.connect(config);
});
electron_1.ipcMain.handle('ssh:disconnect', async (_, id) => {
    return sshManager.disconnect(id);
});
electron_1.ipcMain.handle('ssh:execute', async (_, { id, command }) => {
    return sshManager.execute(id, command);
});
electron_1.ipcMain.handle('ssh:write', async (_, { id, data }) => {
    return sshManager.write(id, data);
});
electron_1.ipcMain.handle('ssh:resize', async (_, { id, cols, rows }) => {
    return sshManager.resize(id, cols, rows);
});
electron_1.ipcMain.handle('ssh:get-history', async (_, id) => {
    return sshManager.getRecentOutput(id);
});
// SSH Profile handlers
electron_1.ipcMain.handle('ssh:get-profiles', async () => {
    return sshManager.getProfiles();
});
electron_1.ipcMain.handle('ssh:save-profile', async (_, profile) => {
    return sshManager.saveProfile(profile);
});
electron_1.ipcMain.handle('ssh:delete-profile', async (_, id) => {
    return sshManager.deleteProfile(id);
});
// Agent management
electron_1.ipcMain.handle('agent:get-current', async () => {
    return terminalManager.getCurrentAgent();
});
electron_1.ipcMain.handle('agent:set-focus', async (_, id) => {
    return terminalManager.focusTerminal(id);
});
// Ring HID handlers
electron_1.ipcMain.handle('ring:scan', async () => {
    return ringManager.scanDevices();
});
electron_1.ipcMain.handle('ring:connect', async (_, devicePath) => {
    return ringManager.connect(devicePath);
});
electron_1.ipcMain.handle('ring:disconnect', async () => {
    return ringManager.disconnect();
});
electron_1.ipcMain.handle('ring:status', async () => {
    return ringManager.getStatus();
});
electron_1.ipcMain.handle('ring:set-debug-mode', async (_, enabled) => {
    ringManager.setDebugMode(enabled);
    return true;
});
electron_1.ipcMain.handle('ring:get-debug-mode', async () => {
    return ringManager.isDebugModeEnabled();
});
// Narrator handlers
electron_1.ipcMain.handle('narrator:enable', async () => {
    outputSynthesizer.enable();
    return true;
});
electron_1.ipcMain.handle('narrator:disable', async () => {
    outputSynthesizer.disable();
    return true;
});
electron_1.ipcMain.handle('narrator:toggle', async () => {
    return outputSynthesizer.toggle();
});
electron_1.ipcMain.handle('narrator:status', async () => {
    return { enabled: outputSynthesizer.isEnabled() };
});
// Remote Gateway handlers
electron_1.ipcMain.handle('remote:start-server', async () => {
    remoteGateway.start();
    store.set('remoteAutoStart', true);
    return remoteGateway.getStatus();
});
electron_1.ipcMain.handle('remote:stop-server', async () => {
    remoteGateway.stop();
    store.set('remoteAutoStart', false);
    return { running: false };
});
electron_1.ipcMain.handle('remote:status', async () => {
    return remoteGateway.getStatus();
});
electron_1.ipcMain.handle('remote:get-clients', async () => {
    return remoteGateway.getClients();
});
electron_1.ipcMain.handle('remote:set-port', async (_, port) => {
    store.set('remotePort', port);
});
electron_1.ipcMain.handle('remote:get-token', async () => {
    return store.get('remoteToken') || '';
});
electron_1.ipcMain.handle('remote:regenerate-token', async () => {
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    store.set('remoteToken', token);
    return token;
});
// Telegram handlers
electron_1.ipcMain.handle('telegram:start', async (_, token) => {
    store.set('telegramBotToken', token);
    return telegramBot.start(token);
});
electron_1.ipcMain.handle('telegram:stop', async () => {
    telegramBot.stop();
    return { running: false };
});
electron_1.ipcMain.handle('telegram:status', async () => {
    return telegramBot.getStatus();
});
electron_1.ipcMain.handle('telegram:set-token', async (_, token) => {
    store.set('telegramBotToken', token);
});
// Command Interpreter handlers
electron_1.ipcMain.handle('command:interpret', async (_, text) => {
    return commandInterpreter.interpret(text);
});
electron_1.ipcMain.handle('command:driving-mode', async (_, enabled) => {
    commandInterpreter.setDrivingMode(enabled);
    return { enabled };
});
electron_1.ipcMain.handle('command:get-driving-mode', async () => {
    return { enabled: commandInterpreter.getDrivingMode() };
});
// App lifecycle
electron_1.app.whenReady().then(() => {
    createWindow();
    // RingManager auto-connects to JX-11 via node-hid
});
electron_1.app.on('window-all-closed', () => {
    electron_1.globalShortcut.unregisterAll();
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('activate', () => {
    if (electron_1.BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
electron_1.app.on('will-quit', () => {
    electron_1.globalShortcut.unregisterAll();
    if (remoteGateway) remoteGateway.stop();
    if (telegramBot) telegramBot.stop();
});
