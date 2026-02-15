"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputSynthesizer = void 0;
const openai_1 = __importDefault(require("openai"));
class OutputSynthesizer {
    mainWindow;
    openai = null;
    outputBuffer = new Map();
    enabled = false;
    voicePipeline = null;
    analysisTimers = new Map();
    lastNarrationTime = 0;
    // Debounce: wait 3s of silence before analyzing
    ANALYSIS_DEBOUNCE_MS = 3000;
    // Min interval between narrations to avoid spamming TTS
    MIN_NARRATION_INTERVAL_MS = 10000;
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new openai_1.default({ apiKey });
        }
    }
    setVoicePipeline(pipeline) {
        this.voicePipeline = pipeline;
    }
    enable() {
        this.enabled = true;
        console.log('[Narrator] Enabled');
        this.mainWindow.webContents.send('narrator:status-changed', { enabled: true });
    }
    disable() {
        this.enabled = false;
        // Clear all pending analysis timers
        this.analysisTimers.forEach(timer => clearTimeout(timer));
        this.analysisTimers.clear();
        console.log('[Narrator] Disabled');
        this.mainWindow.webContents.send('narrator:status-changed', { enabled: false });
    }
    toggle() {
        if (this.enabled) {
            this.disable();
        }
        else {
            this.enable();
        }
        return this.enabled;
    }
    isEnabled() {
        return this.enabled;
    }
    // Process terminal output: buffer + schedule debounced analysis
    processTerminalOutput(terminalId, data) {
        this.addOutput(terminalId, data);
        if (!this.enabled)
            return;
        // Clear existing timer for this terminal
        if (this.analysisTimers.has(terminalId)) {
            clearTimeout(this.analysisTimers.get(terminalId));
        }
        // Schedule analysis after silence period
        const timer = setTimeout(() => {
            this.analysisTimers.delete(terminalId);
            this.narrateIfReady(terminalId);
        }, this.ANALYSIS_DEBOUNCE_MS);
        this.analysisTimers.set(terminalId, timer);
    }
    async narrateIfReady(terminalId) {
        if (!this.enabled)
            return;
        // Rate limit: don't narrate too frequently
        const now = Date.now();
        if (now - this.lastNarrationTime < this.MIN_NARRATION_INTERVAL_MS) {
            console.log('[Narrator] Skipped — too soon since last narration');
            return;
        }
        const summary = await this.generateSpokenSummary(terminalId);
        if (!summary)
            return;
        this.lastNarrationTime = Date.now();
        console.log('[Narrator] Speaking:', summary);
        // Use voice pipeline TTS if available
        if (this.voicePipeline) {
            await this.voicePipeline.speak(summary);
        }
        else {
            // Fallback: send to renderer for native TTS
            this.mainWindow.webContents.send('voice:speak-native', { text: summary });
        }
        // Clear the buffer after narrating to avoid repeating
        this.clearBuffer(terminalId);
    }
    // Buffer terminal output for analysis
    addOutput(terminalId, output) {
        if (!this.outputBuffer.has(terminalId)) {
            this.outputBuffer.set(terminalId, []);
        }
        const buffer = this.outputBuffer.get(terminalId);
        buffer.push(output);
        // Keep buffer limited
        if (buffer.length > 100) {
            buffer.shift();
        }
    }
    // Get recent output for a terminal
    getRecentOutput(terminalId, lines = 50) {
        const buffer = this.outputBuffer.get(terminalId);
        if (!buffer)
            return '';
        return buffer.slice(-lines).join('');
    }
    // Analyze output using GPT-4
    async analyzeOutput(terminalId) {
        if (!this.openai) {
            return this.basicAnalysis(terminalId);
        }
        const output = this.getRecentOutput(terminalId);
        if (!output.trim())
            return null;
        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `You are a terminal output analyzer. Analyze the given terminal output and provide a brief, actionable summary.
            
Respond in JSON format:
{
  "type": "success" | "error" | "warning" | "info" | "progress",
  "summary": "Brief one-line summary",
  "details": "Additional context if needed",
  "actionRequired": true/false,
  "suggestedAction": "What the user should do next (if any)"
}

Be concise. Focus on the most recent and important output.`,
                    },
                    {
                        role: 'user',
                        content: `Analyze this terminal output:\n\n${output}`,
                    },
                ],
                temperature: 0.3,
                max_tokens: 200,
            });
            const content = response.choices[0]?.message?.content;
            if (!content)
                return null;
            try {
                return JSON.parse(content);
            }
            catch {
                return {
                    type: 'info',
                    summary: content.substring(0, 100),
                };
            }
        }
        catch (error) {
            console.error('Output analysis failed:', error);
            return this.basicAnalysis(terminalId);
        }
    }
    // Basic analysis without AI
    basicAnalysis(terminalId) {
        const output = this.getRecentOutput(terminalId).toLowerCase();
        if (!output.trim())
            return null;
        // Check for common patterns
        if (output.includes('error') || output.includes('failed') || output.includes('exception')) {
            return {
                type: 'error',
                summary: 'An error occurred in the output',
                actionRequired: true,
            };
        }
        if (output.includes('warning') || output.includes('warn')) {
            return {
                type: 'warning',
                summary: 'Warnings detected in output',
            };
        }
        if (output.includes('success') || output.includes('completed') || output.includes('done')) {
            return {
                type: 'success',
                summary: 'Operation completed successfully',
            };
        }
        if (output.includes('installing') || output.includes('downloading') || output.includes('%')) {
            return {
                type: 'progress',
                summary: 'Operation in progress',
            };
        }
        return {
            type: 'info',
            summary: 'Terminal output received',
        };
    }
    // Generate a spoken summary
    async generateSpokenSummary(terminalId) {
        const analysis = await this.analyzeOutput(terminalId);
        if (!analysis)
            return null;
        let summary = analysis.summary;
        if (analysis.actionRequired && analysis.suggestedAction) {
            summary += `. ${analysis.suggestedAction}`;
        }
        return summary;
    }
    // Clear buffer for a terminal
    clearBuffer(terminalId) {
        this.outputBuffer.delete(terminalId);
    }
}
exports.OutputSynthesizer = OutputSynthesizer;
