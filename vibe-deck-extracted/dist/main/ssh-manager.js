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
exports.SSHManager = void 0;
const ssh2_1 = require("ssh2");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const electron_store_1 = __importDefault(require("electron-store"));
class SSHManager {
    connections = new Map();
    mainWindow;
    store;
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.store = new electron_store_1.default();
    }
    // Profile Management
    getProfiles() {
        return this.store.get('sshProfiles') || [];
    }
    saveProfile(profile) {
        const profiles = this.getProfiles();
        const existingIndex = profiles.findIndex(p => p.id === profile.id || p.name === profile.name);
        if (existingIndex >= 0) {
            profiles[existingIndex] = { ...profile, id: profile.id || Date.now().toString() };
        }
        else {
            profiles.push({ ...profile, id: Date.now().toString() });
        }
        this.store.set('sshProfiles', profiles);
        return true;
    }
    deleteProfile(id) {
        const profiles = this.getProfiles();
        const newProfiles = profiles.filter(p => p.id !== id);
        this.store.set('sshProfiles', newProfiles);
        return true;
    }
    async connect(config) {
        const id = `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        return new Promise((resolve, reject) => {
            const client = new ssh2_1.Client();
            const connection = {
                id,
                name: config.name,
                client,
                shell: null,
                isConnected: false,
                outputBuffer: [],
                dimensions: { cols: 120, rows: 30 } // Default
            };
            this.connections.set(id, connection);
            client.on('ready', () => {
                connection.isConnected = true;
                // Use pending dimensions if available, otherwise default
                const windowOpts = {
                    term: 'xterm-256color',
                    cols: connection.dimensions?.cols || 120,
                    rows: connection.dimensions?.rows || 30
                };
                const onStream = (err, stream) => {
                    if (err) {
                        this.mainWindow.webContents.send('ssh:error', { id, error: err.message });
                        return;
                    }
                    connection.shell = stream;
                    // Ensure window size is set correctly immediately after stream creation
                    if (connection.dimensions) {
                        stream.setWindow(connection.dimensions.rows, connection.dimensions.cols, 0, 0);
                    }
                    stream.on('data', (data) => {
                        const text = data.toString();
                        connection.outputBuffer.push(text);
                        // Keep buffer limited
                        if (connection.outputBuffer.length > 1000) {
                            connection.outputBuffer.shift();
                        }
                        this.mainWindow.webContents.send('ssh:output', { id, data: text });
                    });
                    stream.stderr.on('data', (data) => {
                        const text = data.toString();
                        this.mainWindow.webContents.send('ssh:output', { id, data: text, isError: true });
                    });
                    stream.on('close', () => {
                        this.mainWindow.webContents.send('ssh:closed', { id });
                        this.cleanup();
                    });
                };
                if (false && config.useTmux) {
                    // Use 'tmux new -A -D -s vibedeck': 
                    // -A: attach if exists, else new
                    // -D: detach other clients (prevents size constraints)
                    // -s vibedeck: session name
                    const cmd = 'tmux new -A -D -s vibedeck || tmux new -s vibedeck || $SHELL';
                    client.exec(cmd, { pty: windowOpts }, onStream);
                }
                else {
                    client.shell(windowOpts, onStream);
                }
                this.mainWindow.webContents.send('ssh:connected', { id, name: config.name });
                resolve(id);
            });
            client.on('error', (err) => {
                this.mainWindow.webContents.send('ssh:error', { id, error: err.message });
                reject(err);
            });
            client.on('close', () => {
                connection.isConnected = false;
                this.mainWindow.webContents.send('ssh:disconnected', { id });
            });
            // Build connection config
            const connectConfig = {
                host: config.host,
                port: config.port || 22,
                username: config.username,
                readyTimeout: 30000, // Increased to 30s
                keepaliveInterval: 5000,
                keepaliveCountMax: 10,
                debug: (str) => {
                    if (str.includes('DEBUG:'))
                        return; // Filter too verbose logs if needed, or keep all
                    console.log(`[SSH DEBUG ${id}] ${str}`);
                },
            };
            if (config.password) {
                connectConfig.password = config.password;
            }
            else if (config.privateKeyPath) {
                const keyPath = config.privateKeyPath.startsWith('~')
                    ? path.join(os.homedir(), config.privateKeyPath.slice(1))
                    : config.privateKeyPath;
                if (fs.existsSync(keyPath)) {
                    connectConfig.privateKey = fs.readFileSync(keyPath);
                    if (config.passphrase) {
                        connectConfig.passphrase = config.passphrase;
                    }
                }
            }
            else {
                // Try default SSH key
                const defaultKey = path.join(os.homedir(), '.ssh', 'id_rsa');
                if (fs.existsSync(defaultKey)) {
                    connectConfig.privateKey = fs.readFileSync(defaultKey);
                }
            }
            try {
                client.connect(connectConfig);
            }
            catch (err) {
                reject(err);
            }
        });
    }
    async disconnect(id) {
        const connection = this.connections.get(id);
        if (connection) {
            if (connection.shell) {
                connection.shell.end();
            }
            connection.client.end();
            this.connections.delete(id);
        }
    }
    async execute(id, command) {
        const connection = this.connections.get(id);
        if (!connection || !connection.shell) {
            throw new Error(`SSH connection ${id} not found or not ready`);
        }
        // Write command to shell
        connection.shell.write(command + '\n');
        this.mainWindow.webContents.send('ssh:command-sent', {
            id,
            command,
            timestamp: Date.now()
        });
    }
    write(id, data) {
        const connection = this.connections.get(id);
        if (connection?.shell) {
            connection.shell.write(data);
        }
    }
    resize(id, cols, rows) {
        const connection = this.connections.get(id);
        if (connection) {
            connection.dimensions = { cols, rows };
            if (connection.shell) {
                connection.shell.setWindow(rows, cols, 0, 0);
            }
        }
    }
    getRecentOutput(id, lines = 50) {
        const connection = this.connections.get(id);
        if (!connection)
            return '';
        return connection.outputBuffer.slice(-lines).join('');
    }
    getAllConnections() {
        return Array.from(this.connections.values()).map(c => ({
            id: c.id,
            name: c.name,
            isConnected: c.isConnected,
        }));
    }
    cleanup() {
        this.connections.forEach(connection => {
            if (connection.shell) {
                connection.shell.end();
            }
            connection.client.end();
        });
        this.connections.clear();
    }
}
exports.SSHManager = SSHManager;
