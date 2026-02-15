# Vibe Deck v1.0.0 — Análisis completo del código fuente

> Análisis verificado línea por línea contra el código descompilado de `Vibe+Deck-1.0.0-arm64.dmg`
> Código extraído en: `~/Desktop/decompilerdmg/vibe-deck-extracted/`
> Fecha: 2026-02-15

---

## 1. Qué es Vibe Deck

**"Voice-powered terminal with AI agents — The Ultimate Vibe Coding Interface"**

Un terminal multiplexor con interfaz 3D que permite:
- Manejar múltiples terminales (agentes) locales y SSH
- Control por voz: grabás audio → se transcribe con Whisper (Groq/OpenAI) → se inyecta como comando en la terminal activa
- Control por hardware: un **anillo físico JX-11** conectado por USB/HID que permite navegar entre agentes, hacer scroll y activar grabación de voz
- Análisis de output con IA: GPT-4o-mini resume qué pasó en la terminal (módulo existente pero NO integrado — ver sección 2.7)

**Stack confirmado por `package.json`:**
- Runtime: Electron (Node >=22.0.0)
- Frontend: React 18.2 + Zustand 4.4 + Three.js 0.182 + xterm 5.3
- Backend: `https://api.vibe-deck.com/api` (auth + licencias via Stripe)
- Hardware: `node-hid` 3.2 para el anillo JX-11
- Terminales: `node-pty` 1.0 (mismo que VS Code)
- SSH: `ssh2` 1.15
- Voz: `groq-sdk` 0.37 + `openai` 4.24 + `ffmpeg-static` + `fluent-ffmpeg`
- Extras: `axios`, `electron-store`, `dotenv`, `ws` (WebSocket — importado pero NO usado en main process)

**Dependencia inusual:** `@types/three` está en `dependencies` en lugar de `devDependencies`.

---

## 2. Arquitectura general — Los 9 ficheros del Main Process

Total: **1.862 líneas** de código JavaScript compilado desde TypeScript.

### 2.1 `dist/main/index.js` — Entry point de Electron (293 líneas)

**Qué hace:**
- Carga `.env` desde `../../.env` relativo a `__dirname`
- Inicializa `electron-store` para persistencia local
- Escribe un **debug log en el Desktop** del usuario (`~/Desktop/vibe-deck-debug.log`) con timestamps
- Crea una ventana **frameless** con efecto vibrancy de macOS:
  - Tamaño: `Math.min(1400, width * 0.85)` x `Math.min(900, height * 0.85)` — NO el 85% directo, sino con cap a 1400x900
  - Mínimo: 800x600
  - `frame: false`, `transparent: true`, `vibrancy: 'under-window'`
  - Traffic lights de macOS posicionados en `{ x: 16, y: 16 }`
  - `contextIsolation: true`, `nodeIntegration: false` — patrón seguro
- Inicializa los **5 managers** en este orden: AuthManager → TerminalManager → VoicePipeline → SSHManager → RingManager
- Carga la Groq API key desde `electron-store` y la pasa al VoicePipeline
- **Conecta el anillo al terminal**: `ringManager.setNavigationCallbacks()` engancha `focusPreviousAgent()`, `focusNextAgent()` y un callback para ENTER que obtiene el agente actual e inyecta `'\r'`
- Registra `CommandOrControl+Shift+Space` como shortcut global para push-to-talk
- Los shortcuts `Alt+Left` y `Alt+Right` están **COMENTADOS** — los quitaron por conflicto con la navegación del sistema
- En dev mode: carga `http://localhost:5173` (Vite) + abre DevTools detached + intenta setear ícono del dock
- En producción: carga `../renderer/index.html`
- Registra **30 handlers IPC** para: terminal (6), voz (4), settings (2), SSH (9), agent (2), ring (6), auth (4 — estos dentro del AuthManager)

**Hallazgo importante:** `OutputSynthesizer` y `CommandInterpreter` **NO se importan** en index.js. Existen como ficheros pero NO están integrados en la app.

### 2.2 `dist/main/ring-manager.js` — El anillo JX-11 (352 líneas)

Ver **Sección 3** para el análisis detallado del protocolo HID.

### 2.3 `dist/main/terminal-manager.js` — Gestión de terminales (229 líneas)

**Qué hace:**
- Crea pseudoterminales reales con `node-pty` (el mismo engine que usa VS Code)
- Cada terminal tiene:
  - ID único: `terminal-${Date.now()}-${random9chars}`
  - Nombre configurable
  - Proceso PTY (`node-pty`)
  - Buffer de output (últimas **1000** entradas — no líneas, sino chunks de data)
  - Flag `isActive`
- Detección de shell: `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh` — verifica que el ejecutable existe con `fs.accessSync(shell, X_OK)` antes de usarlo
- Windows support: detecta `win32` y usa `%COMSPEC%` o `cmd.exe`
- Configuración PTY:
  - Terminal: `xterm-256color` con `COLORTERM: truecolor`
  - Tamaño inicial: 120x30
  - CWD: el configurado o `os.homedir()`
  - PATH: antepone `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin` al PATH del sistema
- `injectCommand(id, command)`: escribe directamente en el `stdin` del proceso PTY via `process.write(command)` — así la voz y el botón inferior del anillo ejecutan comandos
- Navegación circular: `focusPreviousAgent()` / `focusNextAgent()` hacen wrap-around con el array `terminalOrder`
- Al destruir un terminal: mata el proceso, lo saca del orden, y auto-foca el primero disponible
- `getRecentOutput()`: devuelve las últimas N entradas del buffer (por defecto 50)

### 2.4 `dist/main/voice-pipeline.js` — Pipeline de voz (284 líneas)

**Flujo paso a paso:**

1. El usuario toca el centro del anillo (o pulsa `Cmd+Shift+Space`)
2. El main process envía `voice:toggle-recording` al renderer
3. El renderer activa `navigator.mediaDevices.getUserMedia()` con `MediaRecorder` (formato `audio/webm;codecs=opus`)
4. Al soltar, el audio se envía al main process como `ArrayBuffer`
5. **Transcripción con Groq** (prioridad): `whisper-large-v3` con LPU
   - 3 reintentos con backoff exponencial: **500ms, 1000ms** (NO 2000ms — la fórmula es `500 * 2^(attempts-1)`)
   - Timeout: 30s por intento
   - **Bug en el código:** `language: 'en'` con comentario `// Optimize for Spanish` — configurado para inglés a pesar del comentario
6. **Fallback a OpenAI** (solo si NO hay Groq): `whisper-1` con timeout 10s
7. El audio se guarda como archivo `.webm` temporal en `os.tmpdir()/vibedeck-audio/`
8. Tras la transcripción, el archivo temporal se elimina
9. El texto transcrito se envía al renderer via `voice:transcribed` IPC

**Dependencia de ffmpeg:** Importa `fluent-ffmpeg` y `ffmpeg-static`, pero solo usa `setFfmpegPath()`. No hay ningún paso de transcodificación activo — el audio webm se envía directamente a la API.

**TTS (Text-to-Speech) — 3 niveles de fallback:**

| Prioridad | Servicio | Modelo/Voz | Condición |
|-----------|----------|-----------|-----------|
| 1 | ElevenLabs | `eleven_monolingual_v1`, voz "Adam" (`pNInz6obpgDQGcFmaJgB`) | `ELEVENLABS_API_KEY` existe |
| 2 | OpenAI | `tts-1`, voz "onyx", velocidad 1.1x | `OPENAI_API_KEY` existe |
| 3 | Browser nativo | `SpeechSynthesis` (via IPC al renderer) | Fallback final |

ElevenLabs: `stability: 0.5`, `similarity_boost: 0.75`.

### 2.5 `dist/main/ssh-manager.js` — Conexiones SSH (251 líneas)

**Qué hace:**
- Usa `ssh2` para conexiones SSH nativas
- ID único: `ssh-${Date.now()}-${random9chars}`
- Autenticación (en este orden de prioridad):
  1. Password (si `config.password` existe)
  2. SSH key custom (si `config.privateKeyPath` existe) — soporta `~` como home
  3. SSH key por defecto: `~/.ssh/id_rsa`
  4. Si ninguna key existe, intenta sin autenticación por key
- Soporta passphrase para keys encriptadas
- Configuración de conexión:
  - `readyTimeout`: 30s
  - `keepaliveInterval`: 5s
  - `keepaliveCountMax`: 10
  - Terminal: `xterm-256color`, 120x30
- Perfiles SSH persistidos en `electron-store` bajo la key `sshProfiles`
  - Cada perfil tiene: `id`, `name`, `host`, `port`, `username`
  - Upsert por `id` o `name`
- Buffer de output: últimas 1000 entradas (igual que terminal)
- Maneja `stdout` y `stderr` por separado (stderr con flag `isError: true`)

**Código muerto (tmux):**
```javascript
if (false && config.useTmux) {
    const cmd = 'tmux new -A -D -s vibedeck || tmux new -s vibedeck || $SHELL';
    client.exec(cmd, { pty: windowOpts }, onStream);
}
```
Estaba planeado pero explícitamente deshabilitado con `if (false && ...)`.

### 2.6 `dist/main/auth-manager.js` — Autenticación y licencias (93 líneas)

**Qué hace:**
- **Diferencia clave:** Este manager registra sus propios IPC handlers en el constructor (`setupIPC()`), a diferencia de los demás que se registran en `index.js`
- Handlers propios: `auth:login`, `auth:register`, `auth:logout`, `auth:check`
- Login/registro contra:
  - Producción: `https://api.vibe-deck.com/api/auth/login|register`
  - Dev: `http://localhost:3333/api/auth/login|register`
- Token JWT guardado en `electron-store` bajo `authToken`
- Email guardado bajo `userEmail`
- `checkAuth()`: GET a `/license/status` con header `Authorization: Bearer ${token}`, timeout 5s
  - Si falla → `logout()` automático (borra token y email)
  - Si éxito → devuelve `{ authenticated: true, license: response.data, email }`

### 2.7 `dist/main/output-synthesizer.js` — Análisis de output con IA (143 líneas)

**ESTADO: Existe pero NO está integrado** — No se importa en `index.js`, ningún otro módulo lo usa.

**Qué haría si estuviera conectado:**
- Bufferea output por terminal (últimas 100 entradas)
- Análisis con `gpt-4o-mini` (temperature 0.3, max 200 tokens):
  - Clasifica como: `success` | `error` | `warning` | `info` | `progress`
  - Incluye: `summary`, `details`, `actionRequired`, `suggestedAction`
- Fallback sin IA: regex buscando patrones en el output:
  - `error`/`failed`/`exception` → type `error`
  - `warning`/`warn` → type `warning`
  - `success`/`completed`/`done` → type `success`
  - `installing`/`downloading`/`%` → type `progress`
- `generateSpokenSummary()`: concatena summary + suggestedAction para TTS

### 2.8 `dist/main/command-interpreter.js` — DESHABILITADO (9 líneas)

```javascript
class CommandInterpreter {}
```
Stub vacío. El comentario menciona `@anthropic-ai/sdk` (Claude) — originalmente interpretaba comandos de voz con IA, pero fue removido completamente.

### 2.9 `dist/main/preload.js` — Bridge de seguridad (208 líneas)

**Qué hace:**
- Expone `window.vibering` al renderer con `contextBridge.exposeInMainWorld()` — patrón seguro de Electron
- **NO da acceso directo** a `ipcRenderer` — solo métodos específicos wrapeados
- Cada listener devuelve una función de cleanup (unsubscribe pattern):
  ```javascript
  onOutput: (callback) => {
      const handler = (_, data) => callback(data);
      ipcRenderer.on('terminal:output', handler);
      return () => ipcRenderer.removeListener('terminal:output', handler);
  }
  ```

**Namespaces expuestos en `window.vibering`:**

| Namespace | Métodos invoke | Listeners on |
|-----------|---------------|-------------|
| `terminal` | create, write, resize, focus, destroy, inject | onOutput, onCreated, onExit |
| `voice` | startRecording, stopRecording, transcribe, speak | onRecordingStarted, onRecordingStopped, onTranscribed, onSpeaking, onPlayAudio, onSpeakNative, onPTTPress, onPTTRelease, onToggleRecording |
| `auth` | login, register, logout, check | — |
| `ssh` | connect, disconnect, execute, write, resize, getHistory, getProfiles, saveProfile, deleteProfile | onConnected, onOutput, onDisconnected, onError |
| `agent` | getCurrent, setFocus | onPrev, onNext, onFocused |
| `command` | — | onInjected |
| `ring` | scan, connect, disconnect, getStatus, setDebugMode, getDebugMode | onScroll, onConnected, onDisconnected, onEvent, onError, onStatus, onDebugData, onDebugMode |
| `settings` | getApiKey, saveApiKey | — |

---

## 3. El Anillo JX-11 — Protocolo HID completo

### 3.1 Identificación del hardware

```
Vendor ID:  0x05AC  (registrado como Apple — probablemente un VID compartido/genérico)
Product ID: 0x0220
Interfaz:   Consumer Control (USB HID usage_page 0x0C)
```

### 3.2 Conexión automática

- Al arrancar la app, `RingManager` inicia `tryAutoConnect()` + loop cada **3 segundos**
- Busca dispositivos con `node-hid.devices(0x05AC, 0x0220)`
- Filtra específicamente la interfaz **Consumer Control** (`usagePage === 0x0C`) — ignora otras interfaces del mismo dispositivo
- Cuando lo encuentra, se conecta con `new HID(devicePath)`
- Si se desconecta inesperadamente (`readTimeout` lanza error), el loop de reconnect lo vuelve a enganchar

### 3.3 Lectura HID

- Lee datos cada **1 milisegundo** (`setInterval` de 1ms con `readTimeout(10)`)
- Los datos crudos son arrays de bytes: `[reportId, byte1, byte2, byte3, byte4, ...]`
- Mínimo 3 bytes para procesar, mínimo 5 bytes para Report ID 1
- **Modo debug** disponible: envía los bytes crudos en hex al renderer para análisis

### 3.4 Los 5 gestos del anillo

#### Gesto 1: Toque central → TOGGLE GRABACIÓN DE VOZ

| Campo | Valor |
|-------|-------|
| Report ID | `0x03` (3) |
| byte[1] | `233` (0xE9) o `234` (0xEA) |
| Ignora | `0` (release) |
| Debounce | 250ms |

**Flujo:**
1. `ring-manager.js` detecta `reportId === 0x03` con `buttonCode` 233 o 234
2. Envía `voice:toggle-recording` al renderer via IPC
3. El renderer activa/desactiva el `MediaRecorder` del browser
4. Si estaba grabando → para, transcribe con Whisper, inyecta el texto como comando
5. También envía `ring:event { type: 'button', action: 'center-tap' }` para feedback visual

#### Gesto 2: Toque lateral izquierdo → AGENTE ANTERIOR

| Campo | Valor |
|-------|-------|
| Report ID | `0x01` (1) |
| byte[1] (state) | `0x02` (touch start) |
| byte[2] (zone) | `0x20` a `0x60` = zona izquierda |
| Debounce | 300ms (navegación) + 500ms (anti-scroll) |

**Flujo:**
1. `getTouchZone(byte2)` devuelve `'left'`
2. Verifica que no haya scroll reciente (500ms) ni navegación reciente (300ms)
3. Ejecuta `terminalManager.focusPreviousAgent()` — cambia al terminal anterior (circular wrap-around)
4. Envía `ring:event { type: 'button', action: 'prev' }` al renderer

#### Gesto 3: Toque lateral derecho → AGENTE SIGUIENTE

| Campo | Valor |
|-------|-------|
| Report ID | `0x01` (1) |
| byte[1] (state) | `0x02` (touch start) |
| byte[2] (zone) | `0xA0` a `0xD0` = zona derecha |
| Debounce | 300ms (navegación) + 500ms (anti-scroll) |

**Flujo:**
1. `getTouchZone(byte2)` devuelve `'right'`
2. Misma lógica de debounce que el izquierdo
3. Ejecuta `terminalManager.focusNextAgent()` — cambia al terminal siguiente (circular)
4. Envía `ring:event { type: 'button', action: 'next' }` al renderer

#### Gesto 4: Botón inferior → ENTER en el terminal activo

| Campo | Valor |
|-------|-------|
| Report ID | `0x01` (1) |
| byte[1] (state) | `0x07` (press) — ignora `0x00` (release) |
| byte[2] | `0xF4` (244) |
| byte[3] | `0x01` |
| byte[4] | `0x19` |
| Debounce | 250ms |

**Flujo:**
1. Detecta la combinación EXACTA `byte2=0xF4, byte3=0x01, byte4=0x19` — esto lo diferencia del scroll que también usa `byte2=0xF4` pero con byte3 variable
2. Solo en `state === 0x07` (press), ignora release
3. Ejecuta `onEnter()` → `terminalManager.injectCommand(currentAgent.id, '\r')` — envía ENTER al terminal activo
4. Envía `ring:event { type: 'button', action: 'bottom-button' }`

#### Gesto 5: Scroll táctil (deslizar) → SCROLL EN LA VENTANA

| Campo | Valor |
|-------|-------|
| Report ID | `0x01` (1) |
| byte[1] (state) | `0x07` (active touch) |
| byte[2] (zone) | `null` (`0x60` a `0x9F`, zona neutral) |
| byte[3] | Posición del dedo (cambia al mover) |
| Rate limit | Mínimo 8ms entre eventos |
| Multiplicador | x2 (bajado desde x6) |

**Algoritmo de scroll:**
1. Calcula delta: `byte3_actual - byte3_anterior`
2. Maneja wraparound de 8 bits: si `|delta| > 90`, ajusta ±256
3. Filtra ruido: ignora movimientos de `≤1` unidad
4. Suaviza con buffer circular de **2 muestras** (media móvil)
5. Rate limit: mínimo 8ms entre eventos
6. Aplica multiplicador x2 al delta suavizado
7. Envía **evento nativo `mouseWheel`** al centro exacto de la ventana:
   ```javascript
   mainWindow.webContents.sendInputEvent({
       type: 'mouseWheel',
       x: Math.floor(bounds.width / 2),
       y: Math.floor(bounds.height / 2),
       deltaX: 0,
       deltaY: -deltaY,
   });
   ```
8. También envía `ring:scroll { direction, delta }` por IPC para que la terminal lo maneje

### 3.5 Mapa de zonas táctiles del anillo

```
         ┌──────────────┐
         │  0x60 - 0x9F │  ← Zona neutral (scroll)
    ┌────┤              ├────┐
    │    │    CENTRO     │    │
    │ IZQ│   (Report     │DER │
    │0x20│    0x03)      │0xA0│
    │  a │  233/234      │  a │
    │0x60│              │0xD0│
    └────┤              ├────┘
         │   INFERIOR   │
         │ 0xF4,01,19   │
         │ (state 0x07) │
         └──────────────┘
```

### 3.6 Protección contra falsos positivos

El código tiene múltiples capas de debounce para evitar activaciones accidentales:
- **250ms** entre acciones de botón (centro, inferior)
- **300ms** entre navegaciones (izq/der)
- **500ms** anti-scroll antes de permitir navegación
- **8ms** rate limit en scroll
- **Filtro de ruido** en scroll (ignora |delta| ≤ 1)
- **Suavizado** con media móvil de 2 muestras
- **Ignora releases** (state `0x00` y buttonCode `0`)

---

## 4. Frontend (Renderer)

### 4.1 Stack del renderer

- **1 fichero JS** minificado: `index-CzYmbddK.js` (~1MB / 1.027.736 bytes)
- **1 fichero CSS**: `index-i_7Q-3ME.css` (~38KB)
- **Fuentes**: JetBrains Mono (código) + Outfit (UI) via Google Fonts
- **CSP (Content Security Policy)** configurada en el HTML — permite `self`, inline scripts/styles, Google Fonts, y WebSocket a localhost

**Dependencias incluidas en el bundle (de `package.json`):**
- React 18.2 + ReactDOM
- Zustand 4.4 (state management)
- Three.js 0.182 + `@dimforge/rapier3d-compat` (motor de físicas 3D)
- `@tweenjs/tween.js` (animaciones)
- xterm 5.3 + `xterm-addon-fit` + `xterm-addon-web-links`
- `@electron/remote` (acceso remoto a APIs de Electron)

### 4.2 Estado global (Zustand Store)

Basado en los IPC handlers y el preload, el store maneja:
- `agents[]`: lista de terminales/agentes activos
- `activeAgentId`: cuál está enfocado
- `voice`: estado de grabación/transcripción/TTS/nivel de audio
- `viewMode`: `"carousel"` o `"grid"` — dos modos de visualizar terminales
- Settings, SSH modal, HUD state

### 4.3 Flujo de voz en el renderer (hook `useVoice`)

1. Pide permiso de micrófono con `getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })`
2. Crea `AudioContext` + `AnalyserNode` con `fftSize=256` para calcular nivel de audio en tiempo real
3. Graba con `MediaRecorder` en formato `audio/webm;codecs=opus`
4. Al parar: convierte chunks a `ArrayBuffer` → llama a `window.vibering.voice.transcribe(audioData)`
5. Timeout de 10s para la transcripción
6. El texto se inyecta como comando via `window.vibering.terminal.inject(agentId, text.trim())`

### 4.4 Three.js + Rapier3D

La app incluye un motor 3D completo con físicas, utilizado para la interfaz visual del "deck" de terminales (probablemente el modo carousel). Los eventos del anillo NO controlan directamente la escena 3D — controlan terminales y voz. El 3D es puramente visual.

---

## 5. Flujo completo: Ring → Voz → Comando

```
[ANILLO JX-11]
     │
     ├─ Toque centro (0xE9/0xEA, Report 0x03)
     │      ↓
     │  ring-manager → IPC 'voice:toggle-recording' → renderer
     │      ↓
     │  useVoice hook → MediaRecorder.start() / .stop()
     │      ↓
     │  Audio webm/opus → IPC 'voice:transcribe' → main process
     │      ↓
     │  Groq whisper-large-v3 (3 retries, 30s timeout)
     │  └─ Fallback: OpenAI whisper-1 (10s timeout)
     │      ↓
     │  Texto → IPC 'voice:transcribed' → renderer
     │      ↓
     │  window.vibering.terminal.inject(id, texto) → node-pty stdin
     │
     ├─ Toque izquierdo (byte2: 0x20-0x60, state 0x02)
     │      ↓
     │  terminalManager.focusPreviousAgent() → wrap-around circular
     │
     ├─ Toque derecho (byte2: 0xA0-0xD0, state 0x02)
     │      ↓
     │  terminalManager.focusNextAgent() → wrap-around circular
     │
     ├─ Botón inferior (0xF4+0x01+0x19, state 0x07)
     │      ↓
     │  terminalManager.injectCommand(id, '\r') → ENTER
     │
     └─ Scroll (byte2: 0x60-0x9F, state 0x07, deslizar)
            ↓
        Delta suavizado × 2 → mouseWheel nativo al centro ventana
        + ring:scroll IPC → scroll en xterm
```

---

## 6. APIs externas

| Servicio | Endpoint/Modelo | Para qué | Config |
|----------|----------------|----------|--------|
| **Groq** | `whisper-large-v3` | Transcripción STT (prioridad) | `GROQ_API_KEY` (env o electron-store) |
| **OpenAI** | `whisper-1` | STT fallback | `OPENAI_API_KEY` |
| **OpenAI** | `tts-1` (voz "onyx") | TTS nivel 2 | `OPENAI_API_KEY` |
| **OpenAI** | `gpt-4o-mini` | Análisis de output (NO integrado) | `OPENAI_API_KEY` |
| **ElevenLabs** | `eleven_monolingual_v1` (voz "Adam") | TTS nivel 1 | `ELEVENLABS_API_KEY` |
| **vibe-deck.com** | `/api/auth/login\|register` | Auth | JWT en electron-store |
| **vibe-deck.com** | `/api/license/status` | Verificación de licencia | Bearer token |
| **Stripe** | Checkout URL | Pagos/upgrade | Integrado en UI |

---

## 7. Ficheros y métricas

| Fichero | Líneas | Bytes | Qué contiene |
|---------|--------|-------|--------------|
| `dist/main/ring-manager.js` | 352 | — | TODA la lógica HID del anillo JX-11 |
| `dist/main/index.js` | 293 | — | Entry point, IPC handlers, ventana Electron |
| `dist/main/voice-pipeline.js` | 284 | — | Transcripción (Groq/OpenAI) + TTS (3 niveles) |
| `dist/main/ssh-manager.js` | 251 | — | Conexiones SSH con ssh2 |
| `dist/main/terminal-manager.js` | 229 | — | Gestión de PTY con node-pty |
| `dist/main/preload.js` | 208 | — | Bridge seguro renderer↔main (8 namespaces) |
| `dist/main/output-synthesizer.js` | 143 | — | Análisis con GPT-4o-mini (NO INTEGRADO) |
| `dist/main/auth-manager.js` | 93 | — | Login/registro/licencias JWT |
| `dist/main/command-interpreter.js` | 9 | — | STUB vacío (Anthropic SDK removido) |
| `dist/renderer/assets/index-*.js` | — | ~1MB | React + Three.js + Rapier + toda la UI (minificado) |
| `dist/renderer/assets/index-*.css` | — | ~38KB | Estilos completos |
| `dist/renderer/index.html` | 17 | — | Shell HTML con CSP + Google Fonts |
| **TOTAL main process** | **1.862** | — | — |

---

## 8. Hallazgos adicionales (no en el plan original)

### 8.1 Idioma de transcripción — NO es un bug
En `voice-pipeline.js:156`:
```javascript
language: 'en', // Optimize for Spanish
```
A primera vista parece un error, pero es **intencional**: el usuario habla en español y Whisper con `language: 'en'` fuerza la transcripción a inglés, actuando como traductor implícito. Así, decir "listar archivos" produce `ls` o similar en la terminal. El comentario `// Optimize for Spanish` está mal redactado — debería decir algo como "Spanish speech → English transcription".

### 8.2 Debug log en el Desktop
`index.js` escribe un log de debug en `~/Desktop/vibe-deck-debug.log` con timestamp ISO. Esto se ejecuta SIEMPRE (no solo en dev mode), lo cual es unusual para una app en producción.

### 8.3 OutputSynthesizer — INTEGRADO (Narrator)
Originalmente existía como código muerto (no importado). Ahora está completamente integrado como "Narrator" con:
- Toggle por voz: "enable narrator" / "disable narrator" (interceptado antes de inyectar en terminal)
- Toggle por UI: `window.vibering.narrator.toggle()` / IPC `narrator:toggle`
- Debounce de 3s de silencio antes de analizar output
- Rate limit de 10s entre narraciones para no spamear TTS
- Limpieza de buffer post-narración para no repetir
- Confirmación por TTS: "Narrator enabled" / "Narrator disabled"
- Desactivado por defecto — el usuario lo activa cuando quiere

### 8.4 CommandInterpreter removido
Originalmente usaba `@anthropic-ai/sdk` (Claude) para interpretar comandos de voz naturales. Fue reemplazado por inyección directa del texto transcrito. El stub vacío quedó en el build.

### 8.5 WebSocket sin usar
`ws` está en las dependencias de `package.json` pero no se importa en ningún fichero del main process. Posiblemente planeado para comunicación en tiempo real que no se implementó.

### 8.6 ffmpeg incluido pero no utilizado activamente
`ffmpeg-static` y `fluent-ffmpeg` se importan en `voice-pipeline.js` pero solo se usa `setFfmpegPath()`. No hay ningún paso de transcodificación — el audio webm se envía directamente a las APIs. El path se ajusta para `app.asar.unpacked` (patrón estándar de Electron para binarios nativos).

### 8.7 Auth handlers auto-registrados
A diferencia de los demás managers donde los IPC handlers se registran en `index.js`, `AuthManager` registra los suyos propios en su constructor (`setupIPC()`). Esto rompe la consistencia del patrón pero funciona porque `ipcMain` es un singleton global.

### 8.8 Seguridad del anillo
El VID `0x05AC` es el Vendor ID oficial de **Apple**. Que el JX-11 lo use sugiere que:
- Es un dispositivo que se presenta como accesorio Apple (similar a cómo algunos teclados BT usan VIDs genéricos)
- O usa un VID no autorizado oficialmente

### 8.9 CSP del renderer
```
default-src 'self';
script-src 'self' 'unsafe-inline';
connect-src 'self' ws://localhost:*;
```
Permite `unsafe-inline` en scripts y WebSocket solo a localhost. Las conexiones a APIs externas (Groq, OpenAI, ElevenLabs) se hacen desde el **main process** (Node.js), no desde el renderer, por lo que no necesitan estar en la CSP.
