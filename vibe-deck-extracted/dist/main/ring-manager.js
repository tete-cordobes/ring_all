"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RingManager = void 0;
const node_hid_1 = __importDefault(require("node-hid"));
// JX-11 identifiers
const JX11_VID = 0x05AC;
const JX11_PID = 0x0220;
class RingManager {
    mainWindow;
    device = null;
    isConnected = false;
    readInterval = null;
    reconnectInterval = null;
    currentDevicePath = null;
    onNavigatePrev = null;
    onNavigateNext = null;
    onEnter = null;
    // Debug mode - when active, logs all HID data and sends to renderer
    debugMode = false;
    // General debounce for all button actions to prevent electrical bouncing
    lastButtonActionTime = 0;
    // Scroll state
    lastScrollTime = 0;
    lastScrollDirection = null;
    lastScrollByte3 = 0;
    scrollDeltaBuffer = [];
    // Navigation debounce
    lastNavigationTime = 0;
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        // Auto-connect on startup
        this.startAutoConnect();
    }
    /**
     * Set navigation callbacks
     */
    setNavigationCallbacks(onPrev, onNext, onEnter) {
        console.log('[Ring] Navigation callbacks configurados');
        this.onNavigatePrev = onPrev;
        this.onNavigateNext = onNext;
        if (onEnter)
            this.onEnter = onEnter;
    }
    /**
     * Enable/disable debug mode for button detection
     */
    setDebugMode(enabled) {
        this.debugMode = enabled;
        console.log(`[Ring] Debug mode: ${enabled ? 'ON' : 'OFF'}`);
        this.mainWindow.webContents.send('ring:debug-mode', { enabled });
    }
    /**
     * Get debug mode status
     */
    isDebugModeEnabled() {
        return this.debugMode;
    }
    /**
     * Start auto-connect loop
     */
    startAutoConnect() {
        this.tryAutoConnect();
        this.reconnectInterval = setInterval(() => {
            if (!this.isConnected) {
                this.tryAutoConnect();
            }
        }, 3000);
    }
    /**
     * Try to auto-connect to JX-11
     */
    tryAutoConnect() {
        const devices = node_hid_1.default.devices(JX11_VID, JX11_PID);
        if (devices.length === 0)
            return;
        // Find Consumer Control interface (usage_page 0x0C)
        const consumerDevice = devices.find(d => d.usagePage === 0x0C);
        if (consumerDevice && consumerDevice.path) {
            console.log('[Ring] JX-11 encontrado, conectando...');
            this.connect(consumerDevice.path);
        }
    }
    /**
     * Scan for available ring devices
     */
    scanDevices() {
        const devices = node_hid_1.default.devices(JX11_VID, JX11_PID);
        return devices.map(d => ({
            path: d.path || '',
            vendorId: d.vendorId,
            productId: d.productId,
            product: d.product || 'JX-11',
            manufacturer: d.manufacturer || 'Unknown',
            usagePage: d.usagePage || 0,
        }));
    }
    /**
     * Connect to a ring device by path
     */
    connect(devicePath) {
        if (this.isConnected)
            this.disconnect();
        try {
            this.device = new node_hid_1.default.HID(devicePath);
            this.currentDevicePath = devicePath;
            this.isConnected = true;
            // Start reading events
            this.startReading();
            this.mainWindow.webContents.send('ring:connected', { path: devicePath });
            this.mainWindow.webContents.send('ring:status', { connected: true });
            console.log('[Ring] Conectado');
            return true;
        }
        catch (error) {
            console.error('[Ring] Error de conexión:', error);
            this.mainWindow.webContents.send('ring:error', {
                error: error instanceof Error ? error.message : 'Connection failed'
            });
            return false;
        }
    }
    /**
     * Disconnect from current device
     */
    disconnect() {
        this.stopReading();
        if (this.device) {
            try {
                this.device.close();
            }
            catch (e) {
                // Ignore close errors
            }
            this.device = null;
        }
        this.isConnected = false;
        this.currentDevicePath = null;
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('ring:disconnected');
                this.mainWindow.webContents.send('ring:status', { connected: false });
            }
        } catch (e) {
            // Window already destroyed during shutdown — safe to ignore
        }
        console.log('[Ring] Desconectado');
    }
    /**
     * Get connection status
     */
    getStatus() {
        return {
            connected: this.isConnected,
            devicePath: this.currentDevicePath,
        };
    }
    /**
     * Start reading HID events
     */
    startReading() {
        if (!this.device)
            return;
        this.readInterval = setInterval(() => {
            if (!this.device)
                return;
            try {
                const data = this.device.readTimeout(10);
                if (data && data.length > 0) {
                    this.processHIDData(Array.from(data));
                }
            }
            catch (error) {
                console.error('[Ring] Error de lectura:', error);
                this.handleDisconnect();
            }
        }, 1);
    }
    /**
     * Stop reading HID events
     */
    stopReading() {
        if (this.readInterval) {
            clearInterval(this.readInterval);
            this.readInterval = null;
        }
    }
    /**
     * Handle unexpected disconnect
     */
    handleDisconnect() {
        this.stopReading();
        this.isConnected = false;
        this.device = null;
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('ring:disconnected');
                this.mainWindow.webContents.send('ring:status', { connected: false });
            }
        } catch (e) {
            // Window already destroyed during shutdown — safe to ignore
        }
        console.log('[Ring] Desconexión inesperada');
    }
    /**
     * Get touch zone from byte[2]
     */
    getTouchZone(byte2) {
        if (byte2 >= 0x20 && byte2 <= 0x60) {
            return 'left';
        }
        else if (byte2 >= 0xA0 && byte2 <= 0xD0) {
            return 'right';
        }
        else if (byte2 >= 0x60 && byte2 < 0xA0) {
            return null;
        }
        return null;
    }
    /**
     * Process HID data from ring
     */
    processHIDData(data) {
        if (data.length < 3)
            return;
        const reportId = data[0];
        // Debug mode: send all raw HID data to renderer
        if (this.debugMode) {
            const hexData = data.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase());
            console.log('[Ring DEBUG] Raw HID:', hexData.join(' '));
            this.mainWindow.webContents.send('ring:debug-data', {
                raw: data,
                hex: hexData,
                reportId,
                timestamp: Date.now()
            });
        }
        // Report ID 3: Center button events
        if (reportId === 0x03) {
            const buttonCode = data[1];
            console.log('[Ring] Button Code:', buttonCode, '(0x' + buttonCode.toString(16).toUpperCase() + ')');
            // Ignore 0 (Release)
            if (buttonCode === 0)
                return;
            const now = Date.now();
            // Simple debounce to prevent duplicate triggers (250ms)
            if (now - this.lastButtonActionTime < 250) {
                console.log('[Ring] Ignored due to debounce');
                return;
            }
            // Action: TOGGLE RECORDING (Code 233/234) - Center tap
            if (buttonCode === 233 || buttonCode === 0xE9 || buttonCode === 234 || buttonCode === 0xEA) {
                console.log('[Ring] Code 233/234 -> TOGGLE RECORDING (Instant)');
                this.lastButtonActionTime = now;
                this.mainWindow.webContents.send('voice:toggle-recording');
                this.mainWindow.webContents.send('ring:event', { type: 'button', action: 'center-tap' });
                return;
            }
            return;
        }
        // Report ID 1: Touch data (left, right, scroll) + Bottom button
        if (reportId === 0x01 && data.length >= 5) {
            const state = data[1];
            const byte2 = data[2];
            const now = Date.now();
            // Bottom button: byte[2] = 0xF4 (244) with specific byte3=0x01 and byte4=0x19
            // Note: Scroll also uses byte2=0xF4 but byte3 changes as finger moves
            const byte3 = data[3];
            const byte4 = data[4];
            if (byte2 === 0xF4 && byte3 === 0x01 && byte4 === 0x19) {
                // state 0x07 = press, 0x00 = release
                if (state === 0x07) {
                    // Debounce
                    if (now - this.lastButtonActionTime < 250) {
                        return;
                    }
                    this.lastButtonActionTime = now;
                    console.log('[Ring] Bottom Button -> SEND ENTER');
                    if (this.onEnter) {
                        this.onEnter();
                    }
                    this.mainWindow.webContents.send('ring:event', { type: 'button', action: 'bottom-button' });
                }
                return;
            }
            const zone = this.getTouchZone(byte2);
            // State 0x02 = touch start (click for laterales)
            if (state === 0x02) {
                if (now - this.lastScrollTime < 500)
                    return;
                if (now - this.lastNavigationTime < 300)
                    return;
                if (zone === 'left') {
                    console.log('[Ring] << IZQUIERDO');
                    this.lastNavigationTime = now;
                    if (this.onNavigatePrev)
                        this.onNavigatePrev();
                    this.mainWindow.webContents.send('ring:event', { type: 'button', action: 'prev' });
                }
                else if (zone === 'right') {
                    console.log('[Ring] >> DERECHO');
                    this.lastNavigationTime = now;
                    if (this.onNavigateNext)
                        this.onNavigateNext();
                    this.mainWindow.webContents.send('ring:event', { type: 'button', action: 'next' });
                }
            }
            // State 0x07 = active touch (scrolling motion)
            if (state === 0x07 && zone === null) {
                if (this.lastScrollByte3 !== 0) {
                    const rawDelta = byte3 - this.lastScrollByte3;
                    let delta = rawDelta;
                    // Handle wraparound
                    if (rawDelta > 90)
                        delta = rawDelta - 256;
                    if (rawDelta < -90)
                        delta = rawDelta + 256;
                    // Filter out noise (tiny movements)
                    if (Math.abs(delta) > 1) {
                        // Add to buffer for smoothing
                        this.scrollDeltaBuffer.push(delta);
                        if (this.scrollDeltaBuffer.length > 2)
                            this.scrollDeltaBuffer.shift();
                        // Calculate smoothed delta (average of recent deltas)
                        const smoothedDelta = this.scrollDeltaBuffer.reduce((a, b) => a + b, 0) / this.scrollDeltaBuffer.length;
                        // Rate limit to prevent too many events (min 8ms between events)
                        if (now - this.lastScrollTime > 8) {
                            this.lastScrollTime = now;
                            const scrollMultiplier = 2; // Reduced from 6 to 2 for smoother scroll
                            const deltaY = Math.round(smoothedDelta * scrollMultiplier);
                            if (deltaY !== 0) {
                                // Send native mouse wheel event
                                this.mainWindow.webContents.sendInputEvent({
                                    type: 'mouseWheel',
                                    x: Math.floor(this.mainWindow.getBounds().width / 2),
                                    y: Math.floor(this.mainWindow.getBounds().height / 2),
                                    deltaX: 0,
                                    deltaY: -deltaY,
                                });
                                // Also send IPC event for terminal scroll
                                const direction = deltaY > 0 ? 'down' : 'up';
                                this.mainWindow.webContents.send('ring:scroll', { direction, delta: deltaY });
                            }
                        }
                    }
                }
                this.lastScrollByte3 = byte3;
            }
        }
    }
    /**
     * Cleanup resources
     */
    cleanup() {
        if (this.reconnectInterval) {
            clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        this.disconnect();
    }
}
exports.RingManager = RingManager;
