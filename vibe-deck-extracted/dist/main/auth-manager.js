"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = void 0;
const electron_1 = require("electron");
const electron_store_1 = __importDefault(require("electron-store"));
const axios_1 = __importDefault(require("axios"));
const API_URL = electron_1.app.isPackaged
    ? 'https://api.vibe-deck.com/api'
    : 'http://localhost:3333/api';
class AuthManager {
    store;
    token = null;
    constructor() {
        this.store = new electron_store_1.default();
        this.token = this.store.get('authToken') || null;
        this.setupIPC();
    }
    setupIPC() {
        electron_1.ipcMain.handle('auth:login', async (_, { email, password }) => {
            return this.login(email, password);
        });
        electron_1.ipcMain.handle('auth:register', async (_, { email, password, name }) => {
            return this.register(email, password, name);
        });
        electron_1.ipcMain.handle('auth:logout', async () => {
            return this.logout();
        });
        electron_1.ipcMain.handle('auth:check', async () => {
            return this.checkAuth();
        });
    }
    async login(email, password) {
        try {
            const response = await axios_1.default.post(`${API_URL}/auth/login`, { email, password });
            const { token, user, license } = response.data;
            this.setToken(token);
            this.store.set('userEmail', email);
            return { success: true, user, license };
        }
        catch (error) {
            console.error('Login failed:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || 'Login failed' };
        }
    }
    async register(email, password, name) {
        try {
            const response = await axios_1.default.post(`${API_URL}/auth/register`, { email, password, name });
            const { token, user, license } = response.data;
            this.setToken(token);
            this.store.set('userEmail', email);
            return { success: true, user, license };
        }
        catch (error) {
            console.error('Registration failed:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error || 'Registration failed' };
        }
    }
    async checkAuth() {
        if (!this.token)
            return { authenticated: false };
        try {
            // Verify token and get latest license status
            const response = await axios_1.default.get(`${API_URL}/license/status`, {
                headers: { Authorization: `Bearer ${this.token}` },
                timeout: 5000 // 5s timeout
            });
            const email = this.store.get('userEmail');
            return { authenticated: true, license: response.data, email };
        }
        catch (error) {
            // Token invalid or expired
            this.logout();
            return { authenticated: false };
        }
    }
    logout() {
        this.token = null;
        this.store.delete('authToken');
        this.store.delete('userEmail');
        return true;
    }
    setToken(token) {
        this.token = token;
        this.store.set('authToken', token);
    }
    isAuthenticated() {
        return !!this.token;
    }
}
exports.AuthManager = AuthManager;
