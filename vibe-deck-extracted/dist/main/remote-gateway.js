"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteGateway = void 0;
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const WebSocket = require("ws");

// Debug logger (matches index.js pattern)
const logPath = path.join(os.homedir(), 'Desktop', 'vibe-deck-debug.log');
function log(msg) {
    const time = new Date().toISOString();
    const logMsg = `[${time}] [RemoteGateway] ${msg}\n`;
    try {
        fs.appendFileSync(logPath, logMsg);
    }
    catch (e) {
        console.error('Failed to log:', e);
    }
}

// MIME types for static file serving
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
    '.manifest': 'application/manifest+json',
};

// Auth timeout: 10 seconds
const AUTH_TIMEOUT_MS = 10000;
// Rate limit: max 10 messages per second
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
// Max audio size: 10MB
const MAX_AUDIO_SIZE = 10 * 1024 * 1024;

class RemoteGateway {
    port;
    voicePipeline;
    terminalManager;
    outputSynthesizer;
    commandInterpreter;
    mainWindow;
    store;
    server = null;
    wss = null;
    clients = new Map();

    constructor(options) {
        this.port = options.port || 7777;
        this.voicePipeline = options.voicePipeline;
        this.terminalManager = options.terminalManager;
        this.outputSynthesizer = options.outputSynthesizer;
        this.commandInterpreter = options.commandInterpreter;
        this.mainWindow = options.mainWindow;
        this.store = options.store;
    }

    start() {
        // Ensure we have an auth token
        let token = this.store.get('remoteToken');
        if (!token) {
            token = crypto.randomBytes(32).toString('hex');
            this.store.set('remoteToken', token);
            log(`Generated new remote token: ${token.substring(0, 8)}...`);
        }

        const mobileDir = path.join(__dirname, '../renderer/mobile');

        // Create HTTP server that serves PWA files and upgrades to WebSocket
        this.server = http.createServer((req, res) => {
            const url = req.url || '/';

            // Serve mobile PWA files
            if (url === '/mobile' || url === '/mobile/') {
                this._serveFile(path.join(mobileDir, 'index.html'), res);
                return;
            }
            if (url.startsWith('/mobile/')) {
                const filePath = path.join(mobileDir, url.replace('/mobile/', ''));
                this._serveFile(filePath, res);
                return;
            }

            // Default: return 404
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        });

        // Create WebSocket server attached to the HTTP server
        this.wss = new WebSocket.Server({ server: this.server });

        this.wss.on('connection', (ws) => {
            const clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            const clientInfo = {
                id: clientId,
                ws,
                authenticated: false,
                connectedAt: Date.now(),
                lastActivity: Date.now(),
                messageTimestamps: [],
            };
            this.clients.set(clientId, clientInfo);
            log(`Client connected: ${clientId}`);

            // Auth timeout: disconnect if not authenticated within 10 seconds
            const authTimer = setTimeout(() => {
                if (!clientInfo.authenticated) {
                    log(`Client ${clientId} auth timeout — disconnecting`);
                    this._sendMessage(ws, { type: 'auth_result', success: false, error: 'Authentication timeout' });
                    ws.close(4001, 'Authentication timeout');
                }
            }, AUTH_TIMEOUT_MS);

            ws.on('message', (rawData) => {
                clientInfo.lastActivity = Date.now();

                // Rate limiting
                const now = Date.now();
                clientInfo.messageTimestamps = clientInfo.messageTimestamps.filter(
                    t => now - t < RATE_LIMIT_WINDOW_MS
                );
                if (clientInfo.messageTimestamps.length >= RATE_LIMIT_MAX) {
                    log(`Client ${clientId} rate limited`);
                    this._sendMessage(ws, { type: 'error', error: 'Rate limit exceeded' });
                    return;
                }
                clientInfo.messageTimestamps.push(now);

                // Parse message
                let msg;
                try {
                    msg = JSON.parse(rawData.toString());
                }
                catch (e) {
                    this._sendMessage(ws, { type: 'error', error: 'Invalid JSON' });
                    return;
                }

                this._handleMessage(clientId, clientInfo, msg, authTimer);
            });

            ws.on('close', () => {
                clearTimeout(authTimer);
                this.clients.delete(clientId);
                log(`Client disconnected: ${clientId}`);
            });

            ws.on('error', (err) => {
                log(`Client ${clientId} error: ${err.message}`);
                this.clients.delete(clientId);
            });
        });

        this.server.listen(this.port, () => {
            log(`Remote Gateway started on port ${this.port}`);
            console.log(`[RemoteGateway] Listening on port ${this.port}`);
        });

        this.server.on('error', (err) => {
            log(`Server error: ${err.message}`);
            console.error('[RemoteGateway] Server error:', err);
        });
    }

    stop() {
        if (this.wss) {
            // Close all client connections
            this.clients.forEach((clientInfo) => {
                try {
                    clientInfo.ws.close(1000, 'Server shutting down');
                }
                catch (e) {
                    // Ignore close errors
                }
            });
            this.clients.clear();
            this.wss.close();
            this.wss = null;
        }
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        log('Remote Gateway stopped');
    }

    getStatus() {
        return {
            running: this.server !== null && this.server.listening,
            port: this.port,
            clients: this.clients.size,
        };
    }

    getClients() {
        const result = [];
        this.clients.forEach((clientInfo) => {
            result.push({
                id: clientInfo.id,
                authenticated: clientInfo.authenticated,
                connectedAt: clientInfo.connectedAt,
                lastActivity: clientInfo.lastActivity,
            });
        });
        return result;
    }

    broadcastToClients(type, data) {
        const message = JSON.stringify({ type, ...data });
        this.clients.forEach((clientInfo) => {
            if (clientInfo.authenticated && clientInfo.ws.readyState === WebSocket.OPEN) {
                try {
                    clientInfo.ws.send(message);
                }
                catch (e) {
                    log(`Failed to broadcast to ${clientInfo.id}: ${e.message}`);
                }
            }
        });
    }

    // --- Private methods ---

    _serveFile(filePath, res) {
        // Prevent directory traversal
        const normalizedPath = path.normalize(filePath);
        const mobileDir = path.join(__dirname, '../renderer/mobile');
        if (!normalizedPath.startsWith(mobileDir)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        const ext = path.extname(normalizedPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(normalizedPath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        });
    }

    _sendMessage(ws, data) {
        if (ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify(data));
            }
            catch (e) {
                log(`Failed to send message: ${e.message}`);
            }
        }
    }

    _handleMessage(clientId, clientInfo, msg, authTimer) {
        const { ws } = clientInfo;

        switch (msg.type) {
            case 'auth':
                this._handleAuth(clientId, clientInfo, msg, authTimer);
                break;
            case 'audio':
                if (!clientInfo.authenticated) {
                    this._sendMessage(ws, { type: 'error', error: 'Not authenticated' });
                    return;
                }
                this._handleAudio(clientId, clientInfo, msg);
                break;
            case 'text':
                if (!clientInfo.authenticated) {
                    this._sendMessage(ws, { type: 'error', error: 'Not authenticated' });
                    return;
                }
                this._handleText(clientId, clientInfo, msg);
                break;
            case 'status':
                if (!clientInfo.authenticated) {
                    this._sendMessage(ws, { type: 'error', error: 'Not authenticated' });
                    return;
                }
                this._handleStatus(clientId, clientInfo);
                break;
            default:
                this._sendMessage(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
        }
    }

    _handleAuth(clientId, clientInfo, msg, authTimer) {
        const { ws } = clientInfo;
        const expectedToken = this.store.get('remoteToken');

        if (msg.token === expectedToken) {
            clientInfo.authenticated = true;
            clearTimeout(authTimer);
            log(`Client ${clientId} authenticated`);
            this._sendMessage(ws, { type: 'auth_result', success: true });
        }
        else {
            log(`Client ${clientId} auth failed — invalid token`);
            this._sendMessage(ws, { type: 'auth_result', success: false, error: 'Invalid token' });
            // Close after failed auth
            setTimeout(() => ws.close(4003, 'Invalid token'), 500);
        }
    }

    async _handleAudio(clientId, clientInfo, msg) {
        const { ws } = clientInfo;

        if (!msg.data) {
            this._sendMessage(ws, { type: 'error', error: 'Missing audio data' });
            return;
        }

        // Check audio size
        const base64Length = msg.data.length;
        const estimatedSize = (base64Length * 3) / 4;
        if (estimatedSize > MAX_AUDIO_SIZE) {
            this._sendMessage(ws, { type: 'error', error: 'Audio data too large (max 10MB)' });
            return;
        }

        try {
            // Decode base64 audio
            const audioBuffer = Buffer.from(msg.data, 'base64');
            log(`Client ${clientId} sent audio: ${audioBuffer.length} bytes`);

            // Transcribe via voice pipeline
            if (this.voicePipeline) {
                const transcription = await this.voicePipeline.transcribe(audioBuffer);
                if (transcription) {
                    this._sendMessage(ws, { type: 'transcription', text: transcription });

                    // Pass to command interpreter if available
                    if (this.commandInterpreter) {
                        try {
                            await this.commandInterpreter.interpret(transcription);
                        }
                        catch (e) {
                            log(`Command interpreter error: ${e.message}`);
                        }
                    }
                }
            }
            else {
                this._sendMessage(ws, { type: 'error', error: 'Voice pipeline not available' });
            }
        }
        catch (e) {
            log(`Audio processing error for ${clientId}: ${e.message}`);
            this._sendMessage(ws, { type: 'error', error: 'Audio processing failed' });
        }
    }

    async _handleText(clientId, clientInfo, msg) {
        const { ws } = clientInfo;

        if (!msg.text || typeof msg.text !== 'string') {
            this._sendMessage(ws, { type: 'error', error: 'Missing or invalid text' });
            return;
        }

        log(`Client ${clientId} sent text command: ${msg.text}`);

        // Use command interpreter if available
        if (this.commandInterpreter) {
            try {
                await this.commandInterpreter.interpret(msg.text);
            }
            catch (e) {
                log(`Command interpreter error: ${e.message}`);
                this._sendMessage(ws, { type: 'error', error: 'Command interpretation failed' });
            }
        }
        else if (this.terminalManager) {
            // Fallback: inject directly into active terminal
            const current = this.terminalManager.getCurrentAgent();
            if (current) {
                this.terminalManager.injectCommand(current.id, msg.text + '\n');
            }
            else {
                this._sendMessage(ws, { type: 'error', error: 'No active terminal' });
            }
        }
        else {
            this._sendMessage(ws, { type: 'error', error: 'No command handler available' });
        }
    }

    _handleStatus(clientId, clientInfo) {
        const { ws } = clientInfo;
        const terminals = this.terminalManager ? this.terminalManager.getAllTerminals() : [];
        const current = this.terminalManager ? this.terminalManager.getCurrentAgent() : null;

        this._sendMessage(ws, {
            type: 'status',
            data: {
                connected: true,
                terminals: terminals.length,
                activeTerminal: current ? current.id : null,
            },
        });
    }
}

exports.RemoteGateway = RemoteGateway;
