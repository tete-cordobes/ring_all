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
exports.TelegramBot = void 0;
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
// Set ffmpeg path
if (ffmpeg_static_1.default) {
    fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_static_1.default.replace('app.asar', 'app.asar.unpacked'));
}
class TelegramBot {
    voicePipeline;
    terminalManager;
    commandInterpreter;
    outputSynthesizer;
    mainWindow;
    store;
    apiUrl = '';
    token = '';
    lastUpdateId = 0;
    polling = false;
    pollTimeout = null;
    botUsername = '';
    tempDir;
    drivingMode = false;
    statusInterval = null;
    constructor(options) {
        this.voicePipeline = options.voicePipeline;
        this.terminalManager = options.terminalManager;
        this.commandInterpreter = options.commandInterpreter;
        this.outputSynthesizer = options.outputSynthesizer;
        this.mainWindow = options.mainWindow;
        this.store = options.store;
        this.tempDir = path.join(os.tmpdir(), 'vibedeck-telegram');
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }
    // --- Telegram Bot API helpers ---
    async apiCall(method, params = {}) {
        try {
            const response = await axios_1.default.get(`${this.apiUrl}/${method}`, {
                params,
                timeout: method === 'getUpdates' ? 35000 : 10000,
            });
            return response.data;
        }
        catch (error) {
            console.error(`[TelegramBot] API call ${method} failed:`, error.message);
            return null;
        }
    }
    async apiPost(method, data, config = {}) {
        try {
            const response = await axios_1.default.post(`${this.apiUrl}/${method}`, data, {
                timeout: 30000,
                ...config,
            });
            return response.data;
        }
        catch (error) {
            console.error(`[TelegramBot] API POST ${method} failed:`, error.message);
            return null;
        }
    }
    // --- Authorization ---
    getAuthorizedUsers() {
        return this.store.get('telegramAuthorizedUsers', []);
    }
    setAuthorizedUsers(users) {
        this.store.set('telegramAuthorizedUsers', users);
    }
    getAdminUserId() {
        const users = this.getAuthorizedUsers();
        return users.length > 0 ? users[0] : null;
    }
    isAuthorized(userId) {
        const users = this.getAuthorizedUsers();
        return users.includes(userId);
    }
    authorizeUser(userId) {
        const users = this.getAuthorizedUsers();
        if (!users.includes(userId)) {
            users.push(userId);
            this.setAuthorizedUsers(users);
        }
    }
    // --- Start / Stop ---
    async start(token) {
        if (this.polling) {
            console.log('[TelegramBot] Already running, stopping first...');
            this.stop();
        }
        this.token = token;
        this.apiUrl = `https://api.telegram.org/bot${token}`;
        this.store.set('telegramBotToken', token);
        // Verify token with getMe
        const me = await this.apiCall('getMe');
        if (!me || !me.ok) {
            console.error('[TelegramBot] Invalid token or API error');
            throw new Error('Invalid Telegram bot token');
        }
        this.botUsername = me.result.username;
        console.log(`[TelegramBot] Started as @${this.botUsername}`);
        this.polling = true;
        this.poll();
        return { username: this.botUsername };
    }
    stop() {
        this.polling = false;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
        console.log('[TelegramBot] Stopped');
    }
    getStatus() {
        return {
            running: this.polling,
            botUsername: this.botUsername,
            authorizedUsers: this.getAuthorizedUsers(),
        };
    }
    isRunning() {
        return this.polling;
    }
    // --- Long Polling ---
    async poll() {
        if (!this.polling) return;
        try {
            const response = await this.apiCall('getUpdates', {
                offset: this.lastUpdateId + 1,
                timeout: 30,
                allowed_updates: JSON.stringify(['message']),
            });
            if (response && response.ok && response.result) {
                for (const update of response.result) {
                    this.lastUpdateId = update.update_id;
                    await this.handleUpdate(update);
                }
            }
        }
        catch (error) {
            console.error('[TelegramBot] Poll error:', error.message);
        }
        // Schedule next poll (small delay to prevent tight loop on error)
        if (this.polling) {
            this.pollTimeout = setTimeout(() => this.poll(), 300);
        }
    }
    // --- Update Router ---
    async handleUpdate(update) {
        const message = update.message;
        if (!message) return;
        const chatId = message.chat.id;
        const userId = message.from?.id;
        const text = message.text;
        if (!userId) return;
        // Handle /start — auto-authorize first user
        if (text === '/start') {
            await this.handleStart(chatId, userId);
            return;
        }
        // All other messages require authorization
        if (!this.isAuthorized(userId)) {
            await this.sendText(chatId, 'You are not authorized. Ask the admin to run /authorize with your user ID.');
            return;
        }
        // Commands
        if (text && text.startsWith('/')) {
            await this.handleCommand(chatId, userId, text);
            return;
        }
        // Voice message
        if (message.voice || message.audio) {
            await this.handleVoiceMessage(chatId, message);
            return;
        }
        // Text message
        if (text) {
            await this.handleTextMessage(chatId, text);
            return;
        }
    }
    // --- /start ---
    async handleStart(chatId, userId) {
        const users = this.getAuthorizedUsers();
        if (users.length === 0) {
            // First user gets auto-authorized as admin
            this.authorizeUser(userId);
            console.log(`[TelegramBot] Auto-authorized first user: ${userId}`);
            await this.sendText(chatId, `Welcome to Vibe Deck Remote!\n\nYou have been auto-authorized as admin (ID: ${userId}).\n\nAvailable commands:\n/status - Terminal status & active agents\n/driving - Toggle driving mode\n/narrator - Toggle narrator\n/authorize <user_id> - Authorize another user\n/help - Show all commands\n\nSend text to execute commands, or send a voice message.`);
        }
        else if (this.isAuthorized(userId)) {
            await this.sendText(chatId, `Welcome back! You are authorized.\n\nSend text or voice to interact with Vibe Deck.\nType /help for available commands.`);
        }
        else {
            await this.sendText(chatId, `Welcome! You are not yet authorized.\nYour user ID: ${userId}\nAsk the admin to run /authorize ${userId}`);
        }
    }
    // --- Command Handler ---
    async handleCommand(chatId, userId, text) {
        const parts = text.split(' ');
        const command = parts[0].toLowerCase().replace(`@${this.botUsername}`, '');
        switch (command) {
            case '/status':
                await this.handleStatusCommand(chatId);
                break;
            case '/driving':
                await this.handleDrivingCommand(chatId);
                break;
            case '/narrator':
                await this.handleNarratorCommand(chatId);
                break;
            case '/authorize':
                await this.handleAuthorizeCommand(chatId, userId, parts);
                break;
            case '/help':
                await this.handleHelpCommand(chatId);
                break;
            default:
                await this.sendText(chatId, `Unknown command: ${command}\nType /help for available commands.`);
        }
    }
    async handleStatusCommand(chatId) {
        const terminals = this.terminalManager.getAllTerminals();
        const current = this.terminalManager.getCurrentAgent();
        let statusText = 'Vibe Deck Status\n\n';
        statusText += `Active Terminals: ${terminals.length}\n`;
        if (current) {
            statusText += `Focused: ${current.name} (${current.id})\n`;
        }
        statusText += `Driving Mode: ${this.drivingMode ? 'ON' : 'OFF'}\n`;
        statusText += `Narrator: ${this.outputSynthesizer.isEnabled() ? 'ON' : 'OFF'}\n`;
        if (terminals.length > 0) {
            statusText += '\nTerminals:\n';
            for (const t of terminals) {
                statusText += `  ${t.isActive ? '>' : ' '} ${t.name} [${t.id.slice(0, 12)}...]\n`;
            }
        }
        await this.sendText(chatId, statusText);
    }
    async handleDrivingCommand(chatId) {
        this.drivingMode = !this.drivingMode;
        if (this.drivingMode) {
            // Start periodic status updates
            this.statusInterval = setInterval(async () => {
                if (!this.drivingMode || !this.polling) {
                    clearInterval(this.statusInterval);
                    this.statusInterval = null;
                    return;
                }
                await this.handleStatusCommand(chatId);
            }, 30000);
            await this.sendText(chatId, 'Driving mode ENABLED\n- All responses will include voice\n- Status updates every 30s');
            await this.sendVoiceReply(chatId, 'Driving mode enabled. You will receive voice status updates.');
        }
        else {
            if (this.statusInterval) {
                clearInterval(this.statusInterval);
                this.statusInterval = null;
            }
            await this.sendText(chatId, 'Driving mode DISABLED');
        }
    }
    async handleNarratorCommand(chatId) {
        const enabled = this.outputSynthesizer.toggle();
        await this.sendText(chatId, `Narrator ${enabled ? 'ENABLED' : 'DISABLED'}`);
    }
    async handleAuthorizeCommand(chatId, userId, parts) {
        const adminId = this.getAdminUserId();
        if (userId !== adminId) {
            await this.sendText(chatId, 'Only the admin can authorize users.');
            return;
        }
        if (parts.length < 2) {
            await this.sendText(chatId, 'Usage: /authorize <user_id>');
            return;
        }
        const targetId = parseInt(parts[1], 10);
        if (isNaN(targetId)) {
            await this.sendText(chatId, 'Invalid user ID. Must be a number.');
            return;
        }
        this.authorizeUser(targetId);
        await this.sendText(chatId, `User ${targetId} authorized.`);
    }
    async handleHelpCommand(chatId) {
        const helpText = `Vibe Deck Remote - Commands\n\n` +
            `/start - Welcome & setup\n` +
            `/status - Terminal status & active agents\n` +
            `/driving - Toggle driving mode (voice replies + periodic status)\n` +
            `/narrator - Toggle narrator\n` +
            `/authorize <user_id> - Authorize a user (admin only)\n` +
            `/help - This message\n\n` +
            `Text: Send any text to route as a command\n` +
            `Voice: Send a voice message to transcribe & execute`;
        await this.sendText(chatId, helpText);
    }
    // --- Text Message Handler ---
    async handleTextMessage(chatId, text) {
        await this.sendText(chatId, `Received: ${text}`);
        try {
            // Route through command interpreter if it has an interpret method
            if (this.commandInterpreter && typeof this.commandInterpreter.interpret === 'function') {
                const result = await this.commandInterpreter.interpret(text);
                const replyText = result?.response || result?.text || JSON.stringify(result) || 'Command processed.';
                await this.sendText(chatId, replyText);
                if (this.drivingMode) {
                    await this.sendVoiceReply(chatId, replyText);
                }
            }
            else {
                // Fallback: inject as terminal command to the active agent
                const current = this.terminalManager.getCurrentAgent();
                if (current) {
                    this.terminalManager.injectCommand(current.id, text + '\r');
                    await this.sendText(chatId, `Sent to terminal [${current.name}]: ${text}`);
                }
                else {
                    await this.sendText(chatId, 'No active terminal. Create one in Vibe Deck first.');
                }
            }
        }
        catch (error) {
            console.error('[TelegramBot] Text message error:', error);
            await this.sendText(chatId, `Error: ${error.message}`);
        }
    }
    // --- Voice Message Handler ---
    async handleVoiceMessage(chatId, message) {
        const fileId = message.voice?.file_id || message.audio?.file_id;
        if (!fileId) {
            await this.sendText(chatId, 'Could not read voice message.');
            return;
        }
        await this.sendText(chatId, 'Processing voice message...');
        try {
            // Step 1: Get file path from Telegram
            const fileInfo = await this.apiCall('getFile', { file_id: fileId });
            if (!fileInfo || !fileInfo.ok) {
                await this.sendText(chatId, 'Failed to get voice file info.');
                return;
            }
            const filePath = fileInfo.result.file_path;
            const fileUrl = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
            // Step 2: Download the file
            const downloadResponse = await axios_1.default.get(fileUrl, {
                responseType: 'arraybuffer',
                timeout: 30000,
            });
            const inputId = Date.now();
            const ogaFile = path.join(this.tempDir, `voice-${inputId}.oga`);
            const webmFile = path.join(this.tempDir, `voice-${inputId}.webm`);
            fs.writeFileSync(ogaFile, Buffer.from(downloadResponse.data));
            console.log('[TelegramBot] Voice downloaded:', ogaFile, 'size:', downloadResponse.data.byteLength);
            // Step 3: Convert OGA to WebM using ffmpeg
            await this.convertAudio(ogaFile, webmFile);
            // Step 4: Transcribe
            const audioBuffer = fs.readFileSync(webmFile);
            const transcription = await this.voicePipeline.transcribe(audioBuffer);
            // Cleanup temp files
            this.cleanupFile(ogaFile);
            this.cleanupFile(webmFile);
            if (!transcription || !transcription.trim()) {
                await this.sendText(chatId, 'Could not transcribe voice message. Try again or send as text.');
                return;
            }
            await this.sendText(chatId, `Transcribed: "${transcription}"`);
            // Step 5: Route through command interpreter or terminal
            if (this.commandInterpreter && typeof this.commandInterpreter.interpret === 'function') {
                const result = await this.commandInterpreter.interpret(transcription);
                const replyText = result?.response || result?.text || JSON.stringify(result) || 'Command processed.';
                await this.sendText(chatId, replyText);
                // Always send voice reply for voice input (or when driving)
                await this.sendVoiceReply(chatId, replyText);
            }
            else {
                // Fallback: inject into active terminal
                const current = this.terminalManager.getCurrentAgent();
                if (current) {
                    this.terminalManager.injectCommand(current.id, transcription + '\r');
                    const reply = `Sent to terminal [${current.name}]: ${transcription}`;
                    await this.sendText(chatId, reply);
                    if (this.drivingMode) {
                        await this.sendVoiceReply(chatId, reply);
                    }
                }
                else {
                    await this.sendText(chatId, 'No active terminal. Create one in Vibe Deck first.');
                }
            }
        }
        catch (error) {
            console.error('[TelegramBot] Voice message error:', error);
            await this.sendText(chatId, `Voice processing error: ${error.message}`);
        }
    }
    // --- Audio Conversion ---
    convertAudio(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            fluent_ffmpeg_1.default(inputPath)
                .toFormat('webm')
                .audioCodec('libopus')
                .on('end', () => {
                    console.log('[TelegramBot] Audio converted:', outputPath);
                    resolve();
                })
                .on('error', (err) => {
                    console.error('[TelegramBot] ffmpeg conversion error:', err);
                    reject(err);
                })
                .save(outputPath);
        });
    }
    // --- Send Text Reply ---
    async sendText(chatId, text) {
        // Telegram max message length is 4096
        if (text.length > 4096) {
            text = text.substring(0, 4090) + '...';
        }
        return this.apiPost('sendMessage', {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML',
        });
    }
    // --- Send Voice Reply ---
    async sendVoiceReply(chatId, text) {
        if (!text || !text.trim()) return;
        try {
            // Generate TTS audio using the voice pipeline's speak method approach
            // We need to generate the audio file directly rather than using speak()
            // which routes to the renderer. Check for available TTS providers.
            const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
            const openaiKey = process.env.OPENAI_API_KEY;
            let audioBuffer = null;
            if (elevenLabsKey) {
                audioBuffer = await this.generateTTSElevenLabs(text, elevenLabsKey);
            }
            else if (openaiKey) {
                audioBuffer = await this.generateTTSOpenAI(text, openaiKey);
            }
            if (!audioBuffer) {
                // No TTS available, skip voice reply
                console.log('[TelegramBot] No TTS provider available, skipping voice reply');
                return;
            }
            // Convert MP3 to OGG/Opus for Telegram voice message
            const inputId = Date.now();
            const mp3File = path.join(this.tempDir, `tts-${inputId}.mp3`);
            const oggFile = path.join(this.tempDir, `tts-${inputId}.ogg`);
            fs.writeFileSync(mp3File, audioBuffer);
            await this.convertToOgg(mp3File, oggFile);
            // Send as voice message using multipart form data
            // Build multipart manually to avoid extra dependencies
            const boundary = `----VibeDeck${Date.now()}`;
            const oggData = fs.readFileSync(oggFile);
            const header = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
                `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`;
            const footer = `\r\n--${boundary}--\r\n`;
            const headerBuf = Buffer.from(header, 'utf-8');
            const footerBuf = Buffer.from(footer, 'utf-8');
            const body = Buffer.concat([headerBuf, oggData, footerBuf]);
            await this.apiPost('sendVoice', body, {
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': body.length,
                },
                timeout: 30000,
            });
            // Cleanup
            this.cleanupFile(mp3File);
            this.cleanupFile(oggFile);
        }
        catch (error) {
            console.error('[TelegramBot] Voice reply error:', error.message);
            // Silently fail — text reply was already sent
        }
    }
    async generateTTSOpenAI(text, apiKey) {
        try {
            const response = await axios_1.default.post('https://api.openai.com/v1/audio/speech', {
                model: 'tts-1',
                voice: 'onyx',
                input: text,
                speed: 1.1,
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                responseType: 'arraybuffer',
                timeout: 30000,
            });
            return Buffer.from(response.data);
        }
        catch (error) {
            console.error('[TelegramBot] OpenAI TTS error:', error.message);
            return null;
        }
    }
    async generateTTSElevenLabs(text, apiKey) {
        const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
        try {
            const response = await axios_1.default.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                text,
                model_id: 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                },
            }, {
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': apiKey,
                },
                responseType: 'arraybuffer',
                timeout: 30000,
            });
            return Buffer.from(response.data);
        }
        catch (error) {
            console.error('[TelegramBot] ElevenLabs TTS error:', error.message);
            return null;
        }
    }
    convertToOgg(inputPath, outputPath) {
        return new Promise((resolve, reject) => {
            fluent_ffmpeg_1.default(inputPath)
                .toFormat('ogg')
                .audioCodec('libopus')
                .on('end', () => {
                    console.log('[TelegramBot] TTS audio converted to ogg:', outputPath);
                    resolve();
                })
                .on('error', (err) => {
                    console.error('[TelegramBot] ffmpeg ogg conversion error:', err);
                    reject(err);
                })
                .save(outputPath);
        });
    }
    // --- Cleanup Helpers ---
    cleanupFile(filePath) {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        catch (e) {
            console.warn('[TelegramBot] Failed to cleanup:', filePath, e);
        }
    }
}
exports.TelegramBot = TelegramBot;
