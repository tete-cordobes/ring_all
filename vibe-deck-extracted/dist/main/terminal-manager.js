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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalManager = void 0;
const pty = __importStar(require("node-pty"));
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
class TerminalManager {
    terminals = new Map();
    activeTerminalId = null;
    terminalOrder = [];
    mainWindow;
    outputCallback = null;
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
    }
    // Guard against sending to destroyed window during shutdown
    _send(channel, data) {
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this._send(channel, data);
            }
        } catch (e) {
            // Window already destroyed during shutdown — safe to ignore
        }
    }
    setOutputCallback(callback) {
        this.outputCallback = callback;
    }
    getDefaultShell() {
        if (os.platform() === 'win32') {
            return process.env.COMSPEC || 'cmd.exe';
        }
        // Try common shell paths
        const shells = [
            process.env.SHELL,
            '/bin/zsh',
            '/bin/bash',
            '/bin/sh'
        ].filter(Boolean);
        for (const shell of shells) {
            try {
                fs.accessSync(shell, fs.constants.X_OK);
                return shell;
            }
            catch {
                continue;
            }
        }
        return '/bin/bash';
    }
    createTerminal(config) {
        const id = `terminal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const shell = config.shell || this.getDefaultShell();
        const cwd = config.cwd || os.homedir();
        console.log(`Creating terminal with shell: ${shell}, cwd: ${cwd}`);
        const ptyProcess = pty.spawn(shell, ['--login'], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd,
            env: {
                ...process.env,
                ...config.env,
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                SHELL: shell,
                HOME: os.homedir(),
                LANG: process.env.LANG || 'en_US.UTF-8',
                PATH: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + (process.env.PATH || ''),
            },
        });
        const terminal = {
            id,
            name: config.name,
            process: ptyProcess,
            isActive: false,
            outputBuffer: [],
        };
        // Handle terminal output
        ptyProcess.onData((data) => {
            terminal.outputBuffer.push(data);
            // Keep buffer limited
            if (terminal.outputBuffer.length > 1000) {
                terminal.outputBuffer.shift();
            }
            this._send('terminal:output', { id, data });
            // Forward to output callback (narrator/synthesizer)
            if (this.outputCallback) {
                this.outputCallback(id, data);
            }
        });
        ptyProcess.onExit(({ exitCode }) => {
            this._send('terminal:exit', { id, exitCode });
            this.terminals.delete(id);
            this.terminalOrder = this.terminalOrder.filter(tid => tid !== id);
        });
        this.terminals.set(id, terminal);
        this.terminalOrder.push(id);
        // Auto-focus if first terminal
        if (this.terminals.size === 1) {
            this.focusTerminal(id);
        }
        this._send('terminal:created', {
            id,
            name: config.name,
            isActive: terminal.isActive
        });
        return id;
    }
    writeToTerminal(id, data) {
        const terminal = this.terminals.get(id);
        if (terminal) {
            terminal.process.write(data);
        }
    }
    resizeTerminal(id, cols, rows) {
        const terminal = this.terminals.get(id);
        if (terminal) {
            terminal.process.resize(cols, rows);
        }
    }
    focusTerminal(id) {
        // Deactivate current terminal
        if (this.activeTerminalId) {
            const currentTerminal = this.terminals.get(this.activeTerminalId);
            if (currentTerminal) {
                currentTerminal.isActive = false;
            }
        }
        // Activate new terminal
        const terminal = this.terminals.get(id);
        if (terminal) {
            terminal.isActive = true;
            this.activeTerminalId = id;
            this._send('agent:focused', {
                id,
                name: terminal.name,
            });
        }
    }
    destroyTerminal(id) {
        const terminal = this.terminals.get(id);
        if (terminal) {
            terminal.process.kill();
            this.terminals.delete(id);
            this.terminalOrder = this.terminalOrder.filter(tid => tid !== id);
            // Focus next available terminal
            if (this.activeTerminalId === id && this.terminalOrder.length > 0) {
                this.focusTerminal(this.terminalOrder[0]);
            }
        }
    }
    injectCommand(id, command) {
        const terminal = this.terminals.get(id);
        if (terminal) {
            // Write command to terminal stdin
            terminal.process.write(command);
            this._send('command:injected', {
                id,
                command,
                timestamp: Date.now()
            });
        }
    }
    focusPreviousAgent() {
        if (this.terminalOrder.length <= 1)
            return;
        const currentIndex = this.terminalOrder.indexOf(this.activeTerminalId || '');
        const prevIndex = currentIndex <= 0
            ? this.terminalOrder.length - 1
            : currentIndex - 1;
        this.focusTerminal(this.terminalOrder[prevIndex]);
    }
    focusNextAgent() {
        if (this.terminalOrder.length <= 1)
            return;
        const currentIndex = this.terminalOrder.indexOf(this.activeTerminalId || '');
        const nextIndex = currentIndex >= this.terminalOrder.length - 1
            ? 0
            : currentIndex + 1;
        this.focusTerminal(this.terminalOrder[nextIndex]);
    }
    getCurrentAgent() {
        if (!this.activeTerminalId)
            return null;
        const terminal = this.terminals.get(this.activeTerminalId);
        if (!terminal)
            return null;
        return {
            id: terminal.id,
            name: terminal.name,
        };
    }
    getRecentOutput(id, lines = 50) {
        const terminal = this.terminals.get(id);
        if (!terminal)
            return '';
        return terminal.outputBuffer.slice(-lines).join('');
    }
    getAllTerminals() {
        return Array.from(this.terminals.values()).map(t => ({
            id: t.id,
            name: t.name,
            isActive: t.isActive,
        }));
    }
    cleanup() {
        this.terminals.forEach(terminal => {
            terminal.process.kill();
        });
        this.terminals.clear();
        this.terminalOrder = [];
        this.activeTerminalId = null;
    }
}
exports.TerminalManager = TerminalManager;
