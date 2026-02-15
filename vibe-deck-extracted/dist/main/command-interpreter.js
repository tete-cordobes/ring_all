"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommandInterpreter = void 0;
const child_process_1 = require("child_process");
const openai_1 = __importDefault(require("openai"));
// Regex-first classification patterns (covers 90%+ of inputs)
const DIRECT_PATTERNS = /^(ls|cd|pwd|cat|echo|mkdir|rm|cp|mv|git|npm|npx|yarn|pnpm|bun|docker|kubectl|make|cargo|go|python|pip|node|deno|curl|wget|ssh|scp|brew|apt|yum|pacman|eza|bat|rg|fd|sd|tmux|zellij|vim|nvim|nano|htop|top|ps|kill|grep|find|sed|awk|tar|zip|unzip|which|env|export|source|chmod|chown|clear|exit|history|man|touch|ln|df|du|tail|head|sort|wc|diff|ping|traceroute|dig|nslookup|ifconfig|netstat|lsof|open|code|subl)\b/i;
const META_PATTERNS = /\b(enable|disable|activate|deactivate|turn on|turn off|switch|driving mode|narrator|terminal|agent|open terminal|new terminal|new agent|work in|work on|create terminal|create agent)\b/i;
const QUERY_PATTERNS = /\b(what happened|any errors|status|what's going on|show me|tell me|how's it going|qué pasó|algún error|estado|what did|what was|last output|recent output|show output|read terminal|what errors|show errors|summarize|summary)\b/i;
class CommandInterpreter {
    terminalManager;
    voicePipeline;
    outputSynthesizer;
    mainWindow;
    store;
    openai = null;
    drivingMode = false;
    onClaudeStatusCallback = null;
    onNarrateCallback = null;
    activeClaudeProcess = null;
    constructor(options) {
        this.terminalManager = options.terminalManager;
        this.voicePipeline = options.voicePipeline;
        this.outputSynthesizer = options.outputSynthesizer;
        this.mainWindow = options.mainWindow;
        this.store = options.store || null;
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new openai_1.default({ apiKey });
        }
    }
    // Main entry point
    async interpret(text, source = 'local') {
        if (!text || !text.trim()) {
            return { type: 'empty', action: 'none', result: null };
        }
        const trimmed = text.trim();
        const type = this.classify(trimmed);
        console.log(`[CommandInterpreter] Classified "${trimmed.substring(0, 50)}..." as: ${type}`);
        let result;
        switch (type) {
            case 'direct_command':
                result = await this.executeDirect(trimmed);
                break;
            case 'dev_task':
                result = await this.executeDevTask(trimmed);
                break;
            case 'meta_command':
                result = await this.executeMeta(trimmed);
                break;
            case 'query':
                result = await this.executeQuery(trimmed);
                break;
            default:
                result = { error: 'Unknown command type' };
        }
        return { type, action: type, result };
    }
    // Regex-first classification (fast, no API call)
    classify(text) {
        const trimmed = text.trim();
        // 1. Check direct commands first (starts with a known CLI command)
        if (DIRECT_PATTERNS.test(trimmed)) {
            return 'direct_command';
        }
        // 2. Check meta commands (system control)
        if (META_PATTERNS.test(trimmed)) {
            return 'meta_command';
        }
        // 3. Check queries (questions about terminal state)
        if (QUERY_PATTERNS.test(trimmed)) {
            return 'query';
        }
        // 4. Default: natural language → dev_task
        return 'dev_task';
    }
    // Fallback GPT-4o-mini classification for ambiguous cases
    async classifyWithAI(text) {
        if (!this.openai) {
            return 'dev_task';
        }
        try {
            const response = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: `Classify the following voice command into exactly one category. Respond with ONLY the category name, nothing else.

Categories:
- direct_command: Shell commands like ls, git status, npm test, docker build, etc.
- dev_task: Development tasks described in natural language like "fix the login bug", "add error handling", "refactor the auth module"
- meta_command: System control like "enable narrator", "switch terminal", "driving mode on"
- query: Questions about terminal state like "what happened?", "any errors?", "status?"`,
                    },
                    {
                        role: 'user',
                        content: text,
                    },
                ],
                temperature: 0,
                max_tokens: 20,
            });
            const category = response.choices[0]?.message?.content?.trim().toLowerCase();
            if (['direct_command', 'dev_task', 'meta_command', 'query'].includes(category)) {
                return category;
            }
            return 'dev_task';
        }
        catch (error) {
            console.error('[CommandInterpreter] AI classification failed:', error);
            return 'dev_task';
        }
    }
    // Execute direct command: inject into active terminal
    async executeDirect(command) {
        const activeTerminalId = this.terminalManager.activeTerminalId;
        if (!activeTerminalId) {
            console.warn('[CommandInterpreter] No active terminal for direct command');
            return { error: 'No active terminal' };
        }
        // Inject command with newline to execute it
        this.terminalManager.injectCommand(activeTerminalId, command + '\n');
        console.log(`[CommandInterpreter] Injected direct command: ${command}`);
        if (this.onNarrateCallback) {
            this.onNarrateCallback(`Running: ${command.substring(0, 60)}`);
        }
        return { injected: true, terminalId: activeTerminalId, command };
    }
    // Execute dev task: spawn Claude Code CLI
    async executeDevTask(task) {
        if (this.activeClaudeProcess) {
            console.warn('[CommandInterpreter] Claude Code already running');
            return { error: 'Claude Code is already running a task' };
        }
        if (this.onClaudeStatusCallback) {
            this.onClaudeStatusCallback({ status: 'started', message: `Starting: ${task.substring(0, 80)}` });
        }
        if (this.onNarrateCallback) {
            this.onNarrateCallback(`Starting development task: ${task.substring(0, 60)}`);
        }
        try {
            const result = await this.spawnClaudeCode(task);
            return result;
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Claude Code failed';
            console.error('[CommandInterpreter] Dev task error:', errorMsg);
            if (this.onClaudeStatusCallback) {
                this.onClaudeStatusCallback({ status: 'error', message: errorMsg });
            }
            if (this.onNarrateCallback) {
                this.onNarrateCallback(`Task failed: ${errorMsg}`);
            }
            return { error: errorMsg };
        }
    }
    // Spawn Claude Code CLI process
    async spawnClaudeCode(task, options = {}) {
        const maxBudget = options.maxBudget || 1.00;
        const cwd = options.cwd || process.cwd();
        const args = [
            '--print',
            '--output-format', 'stream-json',
            '--permission-mode', 'bypassPermissions',
            '--max-budget-usd', maxBudget.toString(),
            task
        ];
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)('claude', args, {
                cwd,
                env: {
                    ...process.env,
                    PATH: '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + (process.env.PATH || ''),
                },
            });
            this.activeClaudeProcess = proc;
            const filesEdited = [];
            const commandsRun = [];
            let lastMessage = '';
            let outputBuffer = '';
            proc.stdout.on('data', (data) => {
                outputBuffer += data.toString();
                // Parse stream-json output line by line
                const lines = outputBuffer.split('\n');
                // Keep the last incomplete line in the buffer
                outputBuffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const event = JSON.parse(line);
                        // Handle different stream-json event types
                        if (event.type === 'assistant' && event.message) {
                            const content = event.message.content;
                            if (Array.isArray(content)) {
                                for (const block of content) {
                                    if (block.type === 'text') {
                                        lastMessage = block.text;
                                    }
                                    if (block.type === 'tool_use') {
                                        if (block.name === 'Edit' || block.name === 'Write') {
                                            const filePath = block.input?.file_path || block.input?.path || 'unknown';
                                            if (!filesEdited.includes(filePath)) {
                                                filesEdited.push(filePath);
                                            }
                                        }
                                        if (block.name === 'Bash') {
                                            const cmd = block.input?.command || '';
                                            commandsRun.push(cmd.substring(0, 100));
                                        }
                                    }
                                }
                            }
                            if (this.onClaudeStatusCallback) {
                                this.onClaudeStatusCallback({
                                    status: 'progress',
                                    message: lastMessage.substring(0, 200),
                                    filesEdited: [...filesEdited],
                                    commandsRun: [...commandsRun],
                                });
                            }
                        }
                        if (event.type === 'result') {
                            lastMessage = event.result || lastMessage;
                        }
                    }
                    catch {
                        // Not valid JSON, skip
                    }
                }
            });
            proc.stderr.on('data', (data) => {
                console.warn('[ClaudeCode stderr]', data.toString());
            });
            proc.on('close', (code) => {
                this.activeClaudeProcess = null;
                const result = {
                    exitCode: code,
                    filesEdited,
                    commandsRun,
                    summary: lastMessage.substring(0, 500),
                };
                if (this.onClaudeStatusCallback) {
                    this.onClaudeStatusCallback({
                        status: code === 0 ? 'completed' : 'error',
                        message: code === 0
                            ? `Completed. ${filesEdited.length} file(s) edited, ${commandsRun.length} command(s) run.`
                            : `Exited with code ${code}`,
                        filesEdited,
                        commandsRun,
                    });
                }
                if (this.onNarrateCallback) {
                    if (code === 0) {
                        this.onNarrateCallback(`Task completed. ${filesEdited.length} files edited.`);
                    }
                    else {
                        this.onNarrateCallback(`Task failed with exit code ${code}.`);
                    }
                }
                if (code === 0) {
                    resolve(result);
                }
                else {
                    resolve({ ...result, error: `Claude Code exited with code ${code}` });
                }
            });
            proc.on('error', (error) => {
                this.activeClaudeProcess = null;
                console.error('[ClaudeCode] Spawn error:', error.message);
                reject(error);
            });
        });
    }
    // Execute meta command: handle internal system commands
    async executeMeta(text) {
        const normalized = text.toLowerCase().trim();
        // Narrator controls
        if (/\b(enable|activate|turn on|start)\b.*\bnarrator\b/.test(normalized) ||
            /\bnarrator\b.*\b(on|enable|activate|start)\b/.test(normalized)) {
            if (this.outputSynthesizer) {
                this.outputSynthesizer.enable();
            }
            if (this.onNarrateCallback) {
                this.onNarrateCallback('Narrator enabled');
            }
            return { action: 'narrator_enabled' };
        }
        if (/\b(disable|deactivate|turn off|stop)\b.*\bnarrator\b/.test(normalized) ||
            /\bnarrator\b.*\b(off|disable|deactivate|stop)\b/.test(normalized)) {
            if (this.outputSynthesizer) {
                this.outputSynthesizer.disable();
            }
            return { action: 'narrator_disabled' };
        }
        // Driving mode
        if (/\b(enable|activate|turn on|start)\b.*\bdriving mode\b/.test(normalized) ||
            /\bdriving mode\b.*\b(on|enable|activate|start)\b/.test(normalized)) {
            this.setDrivingMode(true);
            return { action: 'driving_mode_enabled' };
        }
        if (/\b(disable|deactivate|turn off|stop)\b.*\bdriving mode\b/.test(normalized) ||
            /\bdriving mode\b.*\b(off|disable|deactivate|stop)\b/.test(normalized)) {
            this.setDrivingMode(false);
            return { action: 'driving_mode_disabled' };
        }
        // Terminal switching
        const switchMatch = normalized.match(/switch\s+(?:to\s+)?terminal\s+(\d+)/);
        if (switchMatch) {
            const terminals = this.terminalManager.getAllTerminals();
            const index = parseInt(switchMatch[1], 10) - 1; // 1-indexed to 0-indexed
            if (index >= 0 && index < terminals.length) {
                this.terminalManager.focusTerminal(terminals[index].id);
                if (this.onNarrateCallback) {
                    this.onNarrateCallback(`Switched to terminal ${switchMatch[1]}`);
                }
                return { action: 'terminal_switched', terminal: index + 1 };
            }
            return { error: `Terminal ${switchMatch[1]} not found` };
        }
        if (/\bnext terminal\b/.test(normalized)) {
            this.terminalManager.focusNextAgent();
            if (this.onNarrateCallback) {
                this.onNarrateCallback('Switched to next terminal');
            }
            return { action: 'terminal_next' };
        }
        if (/\b(previous|prev) terminal\b/.test(normalized)) {
            this.terminalManager.focusPreviousAgent();
            if (this.onNarrateCallback) {
                this.onNarrateCallback('Switched to previous terminal');
            }
            return { action: 'terminal_previous' };
        }
        // Voice terminal creation: "open terminal in Desktop", "work in projects/myapp"
        const openMatch = normalized.match(/(?:open|new|create)\s+(?:terminal|agent)\s+(?:in|at|on)\s+(.+)/);
        const workMatch = !openMatch && normalized.match(/(?:work|start)\s+(?:in|on|at)\s+(.+)/);
        const dirMatch = openMatch || workMatch;
        if (dirMatch) {
            const rawPath = dirMatch[1].trim();
            const path = require('path'), os = require('os'), fs = require('fs');
            let resolved = path.isAbsolute(rawPath) ? rawPath
                : rawPath.startsWith('~') ? rawPath.replace('~', os.homedir())
                : path.join(os.homedir(), rawPath);
            try {
                if (fs.statSync(resolved).isDirectory()) {
                    const terminals = this.terminalManager.getAllTerminals();
                    const name = `Agent ${terminals.length + 1}`;
                    const id = this.terminalManager.createTerminal({ name, cwd: resolved });
                    if (this.onNarrateCallback) {
                        this.onNarrateCallback(`Opened terminal in ${resolved.replace(os.homedir(), '~')}`);
                    }
                    if (this.store) {
                        const recent = this.store.get('recentDirectories') || [];
                        this.store.set('recentDirectories', [resolved, ...recent.filter(p => p !== resolved)].slice(0, 10));
                        this.store.set('lastDirectory', resolved);
                    }
                    return { action: 'terminal_created', terminalId: id, cwd: resolved, name };
                }
            } catch (e) { /* path doesn't exist */ }
            if (this.onNarrateCallback) this.onNarrateCallback(`Directory not found: ${rawPath}`);
            return { action: 'directory_not_found', path: rawPath };
        }
        return { action: 'meta_unhandled', text };
    }
    // Execute query: summarize recent terminal output
    async executeQuery(text) {
        const activeTerminalId = this.terminalManager.activeTerminalId;
        if (!activeTerminalId) {
            return { error: 'No active terminal' };
        }
        const recentOutput = this.terminalManager.getRecentOutput(activeTerminalId, 50);
        if (!recentOutput || !recentOutput.trim()) {
            const noOutput = 'No recent terminal output to summarize.';
            if (this.onNarrateCallback) {
                this.onNarrateCallback(noOutput);
            }
            return { summary: noOutput };
        }
        // Use GPT-4o-mini to summarize if available
        if (this.openai) {
            try {
                const response = await this.openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: `You are a helpful terminal output summarizer. The user asked: "${text}"

Analyze the terminal output and provide a brief, spoken-friendly summary (1-3 sentences). Focus on:
- Errors or failures (most important)
- Successes or completions
- Current state/progress
Be concise and natural, as this will be read aloud.`,
                        },
                        {
                            role: 'user',
                            content: `Recent terminal output:\n\n${recentOutput.substring(0, 3000)}`,
                        },
                    ],
                    temperature: 0.3,
                    max_tokens: 150,
                });
                const summary = response.choices[0]?.message?.content || 'Unable to summarize output.';
                if (this.onNarrateCallback) {
                    this.onNarrateCallback(summary);
                }
                return { summary, terminalId: activeTerminalId };
            }
            catch (error) {
                console.error('[CommandInterpreter] Query summarization failed:', error);
            }
        }
        // Fallback: basic text summary
        const lines = recentOutput.trim().split('\n').filter(l => l.trim());
        const lastLines = lines.slice(-5).join('. ');
        const fallbackSummary = `Recent output: ${lastLines.substring(0, 200)}`;
        if (this.onNarrateCallback) {
            this.onNarrateCallback(fallbackSummary);
        }
        return { summary: fallbackSummary, terminalId: activeTerminalId };
    }
    // Callback setters
    setOnClaudeStatus(callback) {
        this.onClaudeStatusCallback = callback;
    }
    setOnNarrate(callback) {
        this.onNarrateCallback = callback;
    }
    // Driving mode accessors
    getDrivingMode() {
        return this.drivingMode;
    }
    setDrivingMode(enabled) {
        this.drivingMode = enabled;
        console.log(`[CommandInterpreter] Driving mode: ${enabled ? 'ON' : 'OFF'}`);
        if (enabled) {
            // Enable narrator in driving mode
            if (this.outputSynthesizer) {
                this.outputSynthesizer.enable();
            }
            if (this.onNarrateCallback) {
                this.onNarrateCallback('Driving mode enabled. Narrator is on. All commands will execute without confirmation.');
            }
        }
        else {
            if (this.onNarrateCallback) {
                this.onNarrateCallback('Driving mode disabled.');
            }
        }
        // Notify renderer
        if (this.mainWindow) {
            this.mainWindow.webContents.send('driving-mode:changed', { enabled });
        }
    }
}
exports.CommandInterpreter = CommandInterpreter;
