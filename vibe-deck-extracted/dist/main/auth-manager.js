"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = void 0;
const electron_1 = require("electron");
// Local-only AuthManager — no SaaS, no API calls, no registration needed.
// Always returns authenticated with a permanent local license.
const LOCAL_USER = {
    id: 'local-user',
    email: 'local@vibedeck.local',
    name: 'Local User',
};
const LOCAL_LICENSE = {
    plan: 'pro',
    status: 'active',
    expiresAt: null,
    features: ['voice', 'narrator', 'remote', 'telegram', 'claude-code', 'ssh', 'ring'],
};
class AuthManager {
    constructor() {
        this.setupIPC();
    }
    setupIPC() {
        electron_1.ipcMain.handle('auth:login', async () => {
            return { success: true, user: LOCAL_USER, license: LOCAL_LICENSE };
        });
        electron_1.ipcMain.handle('auth:register', async () => {
            return { success: true, user: LOCAL_USER, license: LOCAL_LICENSE };
        });
        electron_1.ipcMain.handle('auth:logout', async () => {
            // No-op: local user can't log out
            return true;
        });
        electron_1.ipcMain.handle('auth:check', async () => {
            return { authenticated: true, license: LOCAL_LICENSE, email: LOCAL_USER.email };
        });
    }
    isAuthenticated() {
        return true;
    }
}
exports.AuthManager = AuthManager;
