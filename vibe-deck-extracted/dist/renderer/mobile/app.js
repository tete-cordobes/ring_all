// Vibe Deck Remote — Mobile PWA Client
// Vanilla JS, no frameworks

(function () {
  'use strict';

  // ============================
  // DOM Elements
  // ============================
  const loginScreen = document.getElementById('login-screen');
  const mainScreen = document.getElementById('main-screen');
  const loginForm = document.getElementById('login-form');
  const hostInput = document.getElementById('host-input');
  const tokenInput = document.getElementById('token-input');
  const loginError = document.getElementById('login-error');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const btnDisconnect = document.getElementById('btn-disconnect');
  const pttButton = document.getElementById('ptt-button');
  const lastAction = document.getElementById('last-action');
  const btnDriving = document.getElementById('btn-driving');

  // ============================
  // State
  // ============================
  const state = {
    ws: null,
    isRecording: false,
    isDrivingMode: false,
    isAuthenticated: false,
    mediaRecorder: null,
    audioChunks: [],
    audioContext: null,
    wakeLock: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    host: '',
    token: '',
  };

  const MAX_RECONNECT_ATTEMPTS = 10;
  const RECONNECT_BASE_DELAY = 1000;
  const STORAGE_KEY = 'vibe-deck-remote';

  // ============================
  // Service Worker Registration
  // ============================
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/mobile/sw.js').catch(() => {});
  }

  // ============================
  // Persistence
  // ============================
  function saveCredentials() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ host: state.host, token: state.token })
      );
    } catch (_) {}
  }

  function loadCredentials() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data) {
        hostInput.value = data.host || '';
        tokenInput.value = data.token || '';
      }
    } catch (_) {}
  }

  // ============================
  // UI Helpers
  // ============================
  function showScreen(screen) {
    loginScreen.hidden = screen !== 'login';
    mainScreen.hidden = screen !== 'main';
  }

  function setStatus(className, text) {
    statusDot.className = 'status-dot ' + className;
    statusText.textContent = text;
  }

  function setPTTState(className) {
    pttButton.className = 'ptt-button ' + className;
  }

  function setLastAction(text) {
    lastAction.textContent = text;
  }

  function showLoginError(msg) {
    loginError.textContent = msg;
    loginError.hidden = false;
  }

  function hideLoginError() {
    loginError.hidden = true;
  }

  function hapticFeedback() {
    if (navigator.vibrate) {
      navigator.vibrate(30);
    }
  }

  // ============================
  // Wake Lock
  // ============================
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    } catch (_) {}
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  // Re-acquire wake lock when page becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.isAuthenticated) {
      requestWakeLock();
    }
  });

  // ============================
  // AudioContext (for TTS playback)
  // ============================
  function getAudioContext() {
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume if suspended (mobile requires user gesture)
    if (state.audioContext.state === 'suspended') {
      state.audioContext.resume();
    }
    return state.audioContext;
  }

  async function playAudioBase64(base64Data, mimeType) {
    try {
      const ctx = getAudioContext();
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.start(0);
      setLastAction('Playing response...');
      source.onended = () => {
        setLastAction('Ready');
        setPTTState('');
        setStatus('connected', 'Connected');
      };
    } catch (err) {
      setLastAction('Audio playback failed');
      // Fallback: try <audio> element
      try {
        const audio = new Audio('data:' + (mimeType || 'audio/mp3') + ';base64,' + base64Data);
        audio.play();
        audio.onended = () => {
          setLastAction('Ready');
          setPTTState('');
          setStatus('connected', 'Connected');
        };
      } catch (_) {}
    }
  }

  // ============================
  // WebSocket
  // ============================
  function connect(host, token) {
    state.host = host;
    state.token = token;

    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + host;

    setStatus('idle', 'Connecting...');
    setLastAction('');

    try {
      state.ws = new WebSocket(wsUrl);
    } catch (err) {
      showLoginError('Invalid host address');
      return;
    }

    state.ws.onopen = () => {
      state.reconnectAttempts = 0;
      setStatus('idle', 'Authenticating...');
      state.ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    };

    state.ws.onmessage = (event) => {
      handleMessage(event.data);
    };

    state.ws.onclose = () => {
      state.isAuthenticated = false;
      if (mainScreen.hidden) {
        // Still on login screen
        showLoginError('Connection closed');
      } else {
        setStatus('idle', 'Disconnected');
        setLastAction('Connection lost');
        scheduleReconnect();
      }
    };

    state.ws.onerror = () => {
      if (mainScreen.hidden) {
        showLoginError('Cannot connect to host');
      }
    };
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'auth_result':
        if (msg.success) {
          state.isAuthenticated = true;
          saveCredentials();
          showScreen('main');
          setStatus('connected', 'Connected');
          setLastAction('Ready');
          requestWakeLock();
        } else {
          showLoginError(msg.error || 'Authentication failed');
          disconnect();
          showScreen('login');
        }
        break;

      case 'tts':
        setPTTState('ready');
        setStatus('connected', 'Connected');
        if (msg.audio) {
          playAudioBase64(msg.audio, msg.mime);
        }
        break;

      case 'transcription':
        setLastAction('You: ' + (msg.text || ''));
        break;

      case 'narrator':
        setLastAction(msg.summary || '');
        break;

      case 'claude_status':
        if (msg.status === 'started') {
          setPTTState('processing');
          setStatus('processing', 'Claude working...');
        } else if (msg.status === 'progress') {
          setLastAction(msg.message || 'Working...');
        } else if (msg.status === 'completed') {
          setPTTState('ready');
          setStatus('connected', 'Connected');
          setLastAction(msg.message || 'Done');
        } else if (msg.status === 'error') {
          setPTTState('');
          setStatus('connected', 'Connected');
          setLastAction('Error: ' + (msg.message || 'Task failed'));
        }
        break;

      case 'output':
        // Terminal output — show last bit
        if (msg.data) {
          var clean = msg.data.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (clean) setLastAction(clean.substring(clean.length - 100));
        }
        break;

      case 'status':
        if (msg.data) {
          setLastAction('Terminals: ' + msg.data.terminals + ' | Active: ' + (msg.data.activeTerminal || 'none'));
        }
        break;

      case 'error':
        setLastAction(msg.error || 'Error');
        setPTTState('');
        setStatus('connected', 'Connected');
        break;

      default:
        break;
    }
  }

  function disconnect() {
    clearTimeout(state.reconnectTimer);
    state.reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }
    state.isAuthenticated = false;
    releaseWakeLock();
    setStatus('idle', 'Disconnected');
    showScreen('login');
  }

  function scheduleReconnect() {
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setLastAction('Reconnect failed. Tap to retry.');
      return;
    }
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts);
    state.reconnectAttempts++;
    setStatus('idle', 'Reconnecting (' + state.reconnectAttempts + ')...');

    state.reconnectTimer = setTimeout(() => {
      connect(state.host, state.token);
    }, Math.min(delay, 30000));
  }

  // Heartbeat
  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);

  // ============================
  // Recording (Push-to-Talk)
  // ============================
  async function startRecording() {
    if (state.isRecording) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      setLastAction('Not connected');
      return;
    }

    hapticFeedback();

    // Ensure AudioContext is resumed (needs user gesture on mobile)
    getAudioContext();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.audioChunks = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      state.mediaRecorder = new MediaRecorder(stream, { mimeType });

      state.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          state.audioChunks.push(e.data);
        }
      };

      state.mediaRecorder.onstop = () => {
        // Stop all tracks
        stream.getTracks().forEach((t) => t.stop());

        if (state.audioChunks.length === 0) return;

        const blob = new Blob(state.audioChunks, { type: mimeType });

        // Convert to base64 and send
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1];
          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(
              JSON.stringify({ type: 'audio', data: base64, mime: mimeType })
            );
            setPTTState('processing');
            setStatus('processing', 'Processing...');
            setLastAction('Sending audio...');
          }
        };
        reader.readAsDataURL(blob);
      };

      state.mediaRecorder.start(100); // Collect in 100ms chunks
      state.isRecording = true;
      setPTTState('recording');
      setStatus('recording', 'Recording...');
      setLastAction('Listening...');
    } catch (err) {
      setLastAction('Mic access denied');
    }
  }

  function stopRecording() {
    if (!state.isRecording || !state.mediaRecorder) return;

    hapticFeedback();
    state.isRecording = false;

    if (state.mediaRecorder.state === 'recording') {
      state.mediaRecorder.stop();
    }
  }

  // ============================
  // Event Listeners
  // ============================

  // Login form
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    hideLoginError();
    const host = hostInput.value.trim();
    const token = tokenInput.value.trim();
    if (!host) {
      showLoginError('Host is required');
      return;
    }
    if (!token) {
      showLoginError('Token is required');
      return;
    }
    connect(host, token);
  });

  // Disconnect button
  btnDisconnect.addEventListener('click', () => {
    disconnect();
  });

  // PTT button — touch events for mobile
  pttButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startRecording();
  });

  pttButton.addEventListener('touchend', (e) => {
    e.preventDefault();
    stopRecording();
  });

  pttButton.addEventListener('touchcancel', (e) => {
    e.preventDefault();
    stopRecording();
  });

  // PTT button — mouse events for desktop testing
  pttButton.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startRecording();
  });

  pttButton.addEventListener('mouseup', (e) => {
    e.preventDefault();
    stopRecording();
  });

  pttButton.addEventListener('mouseleave', () => {
    if (state.isRecording) stopRecording();
  });

  // Driving mode toggle
  btnDriving.addEventListener('click', () => {
    state.isDrivingMode = !state.isDrivingMode;
    document.body.classList.toggle('driving-mode', state.isDrivingMode);
    btnDriving.classList.toggle('active', state.isDrivingMode);
  });

  // Double-tap anywhere in driving mode exits it
  let lastTapTime = 0;
  document.addEventListener('touchend', (e) => {
    if (!state.isDrivingMode) return;
    // Ignore if it's on the PTT button (don't interfere with recording)
    if (e.target.closest('#ptt-button')) return;

    const now = Date.now();
    if (now - lastTapTime < 300) {
      state.isDrivingMode = false;
      document.body.classList.remove('driving-mode');
      btnDriving.classList.remove('active');
    }
    lastTapTime = now;
  });

  // Prevent context menu on long-press (interferes with PTT)
  document.addEventListener('contextmenu', (e) => {
    if (mainScreen.hidden) return;
    e.preventDefault();
  });

  // ============================
  // Initialization
  // ============================
  function init() {
    // Set default host from current page
    const currentHost = window.location.hostname + ':' + (window.location.port || '443');
    hostInput.placeholder = currentHost;

    // Load saved credentials
    loadCredentials();

    // If credentials exist, fill defaults
    if (!hostInput.value) {
      hostInput.value = window.location.host;
    }

    showScreen('login');
  }

  init();
})();
