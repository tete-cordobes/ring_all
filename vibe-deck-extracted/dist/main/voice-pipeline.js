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
exports.VoicePipeline = void 0;
const openai_1 = __importDefault(require("openai"));
const groq_sdk_1 = __importDefault(require("groq-sdk"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const fluent_ffmpeg_1 = __importDefault(require("fluent-ffmpeg"));
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
// Set ffmpeg path
if (ffmpeg_static_1.default) {
    fluent_ffmpeg_1.default.setFfmpegPath(ffmpeg_static_1.default.replace('app.asar', 'app.asar.unpacked'));
}
class VoicePipeline {
    mainWindow;
    openai = null;
    groq = null;
    isRecording = false;
    audioChunks = [];
    tempDir;
    metaCommandHandler = null;
    constructor(mainWindow, config) {
        this.mainWindow = mainWindow;
        this.tempDir = path.join(os.tmpdir(), 'vibedeck-audio');
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        // Initialize OpenAI client if API key is available
        const apiKey = config?.whisperApiKey || process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new openai_1.default({ apiKey });
        }
        // Initialize Groq client
        const groqKey = process.env.GROQ_API_KEY;
        if (groqKey) {
            this.groq = new groq_sdk_1.default({ apiKey: groqKey });
            console.log('Groq client initialized from env');
        }
    }
    setMetaCommandHandler(handler) {
        this.metaCommandHandler = handler;
    }
    checkMetaCommand(text) {
        if (!text)
            return null;
        const normalized = text.toLowerCase().trim();
        // Enable narrator patterns (English + Spanish)
        const enablePatterns = [
            /\b(enable|activate|turn on|start)\b.*\bnarrator\b/,
            /\bnarrator\b.*\b(on|enable|activate|start)\b/,
            /\b(activar|encender|prender|habilitar)\b.*\b(narrador|narrator)\b/,
            /\b(narrador|narrator)\b.*\b(activar|encender|prender|habilitar|activado)\b/,
        ];
        // Disable narrator patterns (English + Spanish)
        const disablePatterns = [
            /\b(disable|deactivate|turn off|stop)\b.*\bnarrator\b/,
            /\bnarrator\b.*\b(off|disable|deactivate|stop)\b/,
            /\b(desactivar|apagar|deshabilitar|parar)\b.*\b(narrador|narrator)\b/,
            /\b(narrador|narrator)\b.*\b(desactivar|apagar|deshabilitar|desactivado|off)\b/,
        ];
        for (const pattern of enablePatterns) {
            if (pattern.test(normalized))
                return 'narrator:enable';
        }
        for (const pattern of disablePatterns) {
            if (pattern.test(normalized))
                return 'narrator:disable';
        }
        return null;
    }
    updateGroqKey(apiKey) {
        if (!apiKey) {
            this.groq = null;
            console.log('Groq client disabled (no key)');
            return;
        }
        try {
            this.groq = new groq_sdk_1.default({ apiKey });
            console.log('Groq client updated with new key');
        }
        catch (error) {
            console.error('Failed to initialize Groq with new key:', error);
        }
    }
    async startRecording() {
        // We send 'toggle-recording' to the renderer because the renderer manages the MediaRecorder via useVoice hook.
        // The renderer acts as the source of truth for recording state.
        this.mainWindow.webContents.send('voice:toggle-recording');
        return true;
    }
    async stopRecording() {
        // We send 'toggle-recording' to the renderer because the renderer manages the MediaRecorder via useVoice hook.
        this.mainWindow.webContents.send('voice:toggle-recording');
        return null;
    }
    addAudioChunk(chunk) {
        if (this.isRecording) {
            this.audioChunks.push(chunk);
        }
    }
    async transcribe(audioData) {
        // Convert ArrayBuffer to Buffer if needed
        let audioBuffer;
        if (audioData instanceof ArrayBuffer) {
            audioBuffer = Buffer.from(audioData);
        }
        else if (audioData instanceof Uint8Array) {
            audioBuffer = Buffer.from(audioData);
        }
        else if (Buffer.isBuffer(audioData)) {
            audioBuffer = audioData;
        }
        else {
            console.error('Invalid audio data type:', typeof audioData);
            return '';
        }
        console.log('Transcribe called, buffer size:', audioBuffer.length);
        if (!this.openai && !this.groq) {
            const errorMsg = 'No AI service configured (Groq or OpenAI)';
            console.warn(errorMsg);
            this.mainWindow.webContents.send('voice:error', { error: errorMsg });
            return '';
        }
        if (audioBuffer.length < 1000) {
            console.warn('Audio buffer too small:', audioBuffer.length);
            return '';
        }
        this.mainWindow.webContents.send('voice:transcribing');
        try {
            // Write raw audio buffer to temp file (webm)
            const inputId = Date.now();
            const inputFile = path.join(this.tempDir, `recording-${inputId}.webm`);
            fs.writeFileSync(inputFile, audioBuffer);
            console.log('Audio saved to:', inputFile, 'size:', audioBuffer.length);
            let transcription = '';
            const fileStream = fs.createReadStream(inputFile);
            if (this.groq) {
                // Retry logic for Groq API
                let attempts = 0;
                const maxAttempts = 3;
                while (attempts < maxAttempts) {
                    try {
                        console.log(`Transcribing with Groq (Attempt ${attempts + 1}/${maxAttempts})...`);
                        // Re-create stream for each attempt as it might be consumed
                        const retryStream = fs.createReadStream(inputFile);
                        const completion = await this.groq.audio.transcriptions.create({
                            file: retryStream,
                            model: 'whisper-large-v3', // Fast LPU inference
                            response_format: 'text',
                            language: 'en', // Optimize for Spanish
                        }, { timeout: 30000 }); // 30s timeout
                        // Handle Groq return type safely
                        if (typeof completion === 'object' && completion !== null && 'text' in completion) {
                            transcription = completion.text;
                        }
                        else {
                            transcription = String(completion);
                        }
                        // If successful, break loop
                        break;
                    }
                    catch (err) {
                        attempts++;
                        console.warn(`Groq attempt ${attempts} failed:`, err.message);
                        if (attempts >= maxAttempts)
                            throw err;
                        // Wait before retry (exponential backoff: 500ms, 1000ms...)
                        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempts - 1)));
                    }
                }
            }
            else if (this.openai) {
                console.log('Transcribing with OpenAI (Fallback)...');
                const resp = await this.openai.audio.transcriptions.create({
                    file: fileStream,
                    model: 'whisper-1',
                    response_format: 'text',
                }, { timeout: 10000 }); // 10s timeout
                transcription = resp;
            }
            console.log('Transcription result:', transcription);
            // Cleanup temp file
            try {
                if (fs.existsSync(inputFile))
                    fs.unlinkSync(inputFile);
            }
            catch (e) {
                console.warn('Failed to cleanup temp file:', e);
            }
            // Check for meta-commands before sending to renderer
            const metaCommand = this.checkMetaCommand(transcription);
            if (metaCommand && this.metaCommandHandler) {
                console.log('[Voice] Meta-command detected:', metaCommand);
                const result = this.metaCommandHandler(metaCommand);
                this.mainWindow.webContents.send('voice:meta-command', {
                    command: metaCommand,
                    text: transcription,
                    result,
                });
                return transcription;
            }
            this.mainWindow.webContents.send('voice:transcribed', { text: transcription });
            return transcription;
        }
        catch (error) {
            console.error('Transcription error:', error);
            this.mainWindow.webContents.send('voice:error', {
                error: error instanceof Error ? error.message : 'Transcription failed'
            });
            return '';
        }
    }
    async speak(text) {
        if (!text.trim())
            return;
        this.mainWindow.webContents.send('voice:speaking', { text });
        // Check for ElevenLabs API key
        const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
        if (elevenLabsKey) {
            await this.speakWithElevenLabs(text, elevenLabsKey);
        }
        else if (this.openai) {
            await this.speakWithOpenAI(text);
        }
        else {
            // Fallback to system TTS via renderer
            this.mainWindow.webContents.send('voice:speak-native', { text });
        }
    }
    async speakWithOpenAI(text) {
        if (!this.openai)
            return;
        try {
            const mp3 = await this.openai.audio.speech.create({
                model: 'tts-1',
                voice: 'onyx',
                input: text,
                speed: 1.1,
            });
            const audioBuffer = Buffer.from(await mp3.arrayBuffer());
            const tempFile = path.join(this.tempDir, `speech-${Date.now()}.mp3`);
            fs.writeFileSync(tempFile, audioBuffer);
            this.mainWindow.webContents.send('voice:play-audio', { filePath: tempFile });
        }
        catch (error) {
            console.error('OpenAI TTS error:', error);
            this.mainWindow.webContents.send('voice:speak-native', { text });
        }
    }
    async speakWithElevenLabs(text, apiKey) {
        const voiceId = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // Adam voice
        try {
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                method: 'POST',
                headers: {
                    'Accept': 'audio/mpeg',
                    'Content-Type': 'application/json',
                    'xi-api-key': apiKey,
                },
                body: JSON.stringify({
                    text,
                    model_id: 'eleven_monolingual_v1',
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                    },
                }),
            });
            if (!response.ok) {
                throw new Error(`ElevenLabs API error: ${response.status}`);
            }
            const audioBuffer = Buffer.from(await response.arrayBuffer());
            const tempFile = path.join(this.tempDir, `speech-${Date.now()}.mp3`);
            fs.writeFileSync(tempFile, audioBuffer);
            this.mainWindow.webContents.send('voice:play-audio', { filePath: tempFile });
        }
        catch (error) {
            console.error('ElevenLabs TTS error:', error);
            // Fallback to native TTS
            this.mainWindow.webContents.send('voice:speak-native', { text });
        }
    }
    async transcribeFile(filePath) {
        if (!this.openai && !this.groq) {
            console.warn('No AI service configured for transcription');
            return '';
        }
        try {
            let transcription = '';
            if (this.groq) {
                let attempts = 0;
                const maxAttempts = 3;
                while (attempts < maxAttempts) {
                    try {
                        const stream = fs.createReadStream(filePath);
                        const completion = await this.groq.audio.transcriptions.create({
                            file: stream,
                            model: 'whisper-large-v3',
                            response_format: 'text',
                            language: 'en',
                        }, { timeout: 30000 });
                        if (typeof completion === 'object' && completion !== null && 'text' in completion) {
                            transcription = completion.text;
                        }
                        else {
                            transcription = String(completion);
                        }
                        break;
                    }
                    catch (err) {
                        attempts++;
                        console.warn(`Groq transcribeFile attempt ${attempts} failed:`, err.message);
                        if (attempts >= maxAttempts)
                            throw err;
                        await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempts - 1)));
                    }
                }
            }
            else if (this.openai) {
                const stream = fs.createReadStream(filePath);
                const resp = await this.openai.audio.transcriptions.create({
                    file: stream,
                    model: 'whisper-1',
                    response_format: 'text',
                }, { timeout: 10000 });
                transcription = resp;
            }
            return transcription;
        }
        catch (error) {
            console.error('TranscribeFile error:', error);
            return '';
        }
    }
    toggleRecording() {
        this.mainWindow.webContents.send('voice:toggle-recording');
    }
    getRecordingState() {
        return this.isRecording;
    }
}
exports.VoicePipeline = VoicePipeline;
