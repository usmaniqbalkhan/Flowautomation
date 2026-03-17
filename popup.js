/**
 * popup.js — Popup UI controller for Google Flow Prompt Automation.
 * Handles file upload, settings, controls, progress display, and logs.
 */

(function () {
  'use strict';

  /* ============================================================
     DOM REFERENCES
     ============================================================ */
  const fileInput = document.getElementById('file-input');
  const btnLoad = document.getElementById('btn-load');
  const promptCountEl = document.getElementById('prompt-count');

  const batchSizeInput = document.getElementById('batch-size');
  const cooldownInput = document.getElementById('cooldown');
  const intraGapInput = document.getElementById('intra-gap');
  const typingDelayInput = document.getElementById('typing-delay');
  const submitMethodSelect = document.getElementById('submit-method');

  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnResume = document.getElementById('btn-resume');
  const btnStop = document.getElementById('btn-stop');
  const btnSkip = document.getElementById('btn-skip');
  const btnReset = document.getElementById('btn-reset');

  const statusBadge = document.getElementById('status-badge');
  const progressBar = document.getElementById('progress-bar');
  const progressPct = document.getElementById('progress-pct');
  const statCurrent = document.getElementById('stat-current');
  const statTotal = document.getElementById('stat-total');
  const statRemaining = document.getElementById('stat-remaining');
  const countdownDisplay = document.getElementById('countdown-display');
  const countdownValue = document.getElementById('countdown-value');
  const logArea = document.getElementById('log-area');
  const optionsLink = document.getElementById('options-link');

  let countdownTimer = null;
  let fileText = null;

  /* ============================================================
     PROMPT PARSER (duplicated from utils.js since popup can't
     access content script functions directly)
     ============================================================ */
  function parsePrompts(text, mode) {
    if (!text || typeof text !== 'string') return [];
    let raw = [];
    if (mode === 'line') {
      raw = text.split(/\n/);
    } else {
      raw = text.split(/\n\s*\n/);
    }
    return raw
      .map(p => p.trim())
      .filter(p => p.length > 0)
      .filter(p => !p.startsWith('#'));
  }

  /* ============================================================
     INITIALIZATION
     ============================================================ */

  function init() {
    loadUIFromStorage();
    bindEvents();
    startStorageListener();
    startCountdownRefresh();
  }

  function loadUIFromStorage() {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (resp) => {
      if (!resp || !resp.ok) return;
      const state = resp.state;
      updateUI(state);
    });
  }

  /* ============================================================
     UI UPDATE
     ============================================================ */

  function updateUI(state) {
    if (!state) return;

    const { prompts, currentIndex, status, settings, logs, countdownEnd } = state;
    const total = (prompts || []).length;
    const current = currentIndex || 0;
    const remaining = Math.max(0, total - current);
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;

    // Prompt count
    promptCountEl.textContent = total;

    // Settings
    if (settings) {
      batchSizeInput.value = settings.batchSize || 4;
      cooldownInput.value = settings.batchCooldownMs || 60000;
      intraGapInput.value = settings.intraPromptGapMs || 3000;
      typingDelayInput.value = settings.typingDelayMs || 20;
      submitMethodSelect.value = settings.submitMethod || 'auto';
    }

    // Status badge
    statusBadge.textContent = formatStatus(status);
    statusBadge.className = status || 'idle';

    // Progress
    progressBar.style.width = pct + '%';
    progressPct.textContent = pct + '%';
    statCurrent.textContent = current;
    statTotal.textContent = total;
    statRemaining.textContent = remaining;

    // Countdown
    if (countdownEnd && status === 'waiting_cooldown') {
      countdownDisplay.style.display = '';
      updateCountdownDisplay(countdownEnd);
    } else {
      countdownDisplay.style.display = 'none';
    }

    // Button states
    updateButtonStates(status, total);

    // Logs
    renderLogs(logs || []);
  }

  function formatStatus(status) {
    const map = {
      idle: 'Idle',
      running: 'Running',
      paused: 'Paused',
      waiting_cooldown: 'Waiting',
      completed: 'Completed',
      error: 'Error'
    };
    return map[status] || status || 'Idle';
  }

  function updateButtonStates(status, totalPrompts) {
    const isIdle = status === 'idle' || !status;
    const isRunning = status === 'running';
    const isPaused = status === 'paused';
    const isWaiting = status === 'waiting_cooldown';
    const isCompleted = status === 'completed';
    const isError = status === 'error';
    const hasPrompts = totalPrompts > 0;

    btnStart.disabled = !(isIdle || isCompleted || isError) || !hasPrompts;
    btnPause.disabled = !(isRunning || isWaiting);
    btnResume.disabled = !isPaused;
    btnStop.disabled = isIdle || isCompleted;
    btnSkip.disabled = !(isRunning || isPaused);
    btnReset.disabled = false; // Always available
  }

  function renderLogs(logs) {
    const recent = logs.slice(-50);
    logArea.innerHTML = recent.map(entry => {
      const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
      const level = entry.level || 'info';
      return `<div class="log-entry log-${level}">` +
             `<span class="log-time">${time}</span>` +
             `<span class="log-msg">${escapeHtml(entry.message)}</span>` +
             `</div>`;
    }).join('');
    logArea.scrollTop = logArea.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function updateCountdownDisplay(endTimestamp) {
    const remaining = Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000));
    countdownValue.textContent = remaining + 's';
    if (remaining <= 0) {
      countdownDisplay.style.display = 'none';
    }
  }

  /* ============================================================
     EVENT BINDINGS
     ============================================================ */

  function bindEvents() {
    // File upload
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        fileText = ev.target.result;
      };
      reader.readAsText(file);
    });

    // Load prompts
    btnLoad.addEventListener('click', () => {
      if (!fileText) {
        alert('Please select a .txt file first.');
        return;
      }
      const mode = document.querySelector('input[name="parse-mode"]:checked').value;
      const prompts = parsePrompts(fileText, mode);
      if (prompts.length === 0) {
        alert('No valid prompts found in file.');
        return;
      }

      // Save settings first, then load prompts
      saveCurrentSettings(() => {
        chrome.runtime.sendMessage({ action: 'LOAD_PROMPTS', prompts: prompts }, (resp) => {
          if (resp && resp.ok) {
            promptCountEl.textContent = resp.count;
            loadUIFromStorage();
          }
        });
      });
    });

    // Start
    btnStart.addEventListener('click', () => {
      saveCurrentSettings(() => {
        chrome.runtime.sendMessage({ action: 'START' }, (resp) => {
          if (resp && !resp.ok) {
            alert('Cannot start: ' + resp.error);
          }
          loadUIFromStorage();
        });
      });
    });

    // Pause
    btnPause.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'PAUSE' }, () => loadUIFromStorage());
    });

    // Resume
    btnResume.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'RESUME' }, () => loadUIFromStorage());
    });

    // Stop
    btnStop.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'STOP' }, () => loadUIFromStorage());
    });

    // Skip
    btnSkip.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'SKIP' }, () => loadUIFromStorage());
    });

    // Reset
    btnReset.addEventListener('click', () => {
      if (confirm('Reset all progress to 0?')) {
        chrome.runtime.sendMessage({ action: 'RESET' }, () => loadUIFromStorage());
      }
    });

    // Options link
    optionsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });

    // Save settings when inputs change
    [batchSizeInput, cooldownInput, intraGapInput, typingDelayInput, submitMethodSelect].forEach(el => {
      el.addEventListener('change', () => saveCurrentSettings());
    });
  }

  /**
   * Read current settings from the popup form and send to background.
   */
  function saveCurrentSettings(callback) {
    const settings = {
      batchSize: parseInt(batchSizeInput.value, 10) || 4,
      batchCooldownMs: parseInt(cooldownInput.value, 10) || 60000,
      intraPromptGapMs: parseInt(intraGapInput.value, 10) || 3000,
      typingDelayMs: parseInt(typingDelayInput.value, 10) || 20,
      submitMethod: submitMethodSelect.value || 'auto'
    };

    chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: settings }, () => {
      if (callback) callback();
    });
  }

  /* ============================================================
     STORAGE CHANGE LISTENER (live updates)
     ============================================================ */

  function startStorageListener() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Reload full state to keep UI consistent
      loadUIFromStorage();
    });
  }

  /* ============================================================
     COUNTDOWN REFRESH
     ============================================================ */

  function startCountdownRefresh() {
    // Refresh countdown every second
    setInterval(() => {
      chrome.storage.local.get(['countdownEnd', 'status'], (data) => {
        if (data.status === 'waiting_cooldown' && data.countdownEnd) {
          countdownDisplay.style.display = '';
          updateCountdownDisplay(data.countdownEnd);
        } else {
          countdownDisplay.style.display = 'none';
        }
      });
    }, 1000);
  }

  /* ============================================================
     INIT
     ============================================================ */

  document.addEventListener('DOMContentLoaded', init);

})();
