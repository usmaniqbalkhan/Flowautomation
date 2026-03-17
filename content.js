/**
 * content.js — DOM automation and on-page overlay for Google Flow Prompt Automation.
 * Injected on matching Google Flow URLs alongside utils.js.
 */

(function () {
  'use strict';

  /* ============================================================
     STATE
     ============================================================ */
  let currentRunId = null;
  let isPaused = false;
  let isStopped = false;
  let isProcessing = false;
  let overlayEl = null;
  let countdownInterval = null;
  let mutationObserver = null;
  let settings = {};

  /* ============================================================
     OVERLAY UI
     ============================================================ */

  function createOverlay() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'gflow-auto-overlay';
    overlayEl.innerHTML = `
      <div id="gflow-overlay-header">
        <span id="gflow-overlay-title">Flow Auto</span>
        <span id="gflow-overlay-minimize" title="Minimize">—</span>
      </div>
      <div id="gflow-overlay-body">
        <div id="gflow-overlay-status">
          <span class="gflow-label">Status:</span>
          <span id="gflow-ov-status-val">Idle</span>
        </div>
        <div id="gflow-overlay-progress">
          <span class="gflow-label">Prompt:</span>
          <span id="gflow-ov-current">0</span> / <span id="gflow-ov-total">0</span>
          (<span id="gflow-ov-remaining">0</span> left)
        </div>
        <div id="gflow-overlay-batch">
          <span class="gflow-label">Batch:</span>
          <span id="gflow-ov-batch">0</span> / <span id="gflow-ov-batchsize">4</span>
        </div>
        <div id="gflow-overlay-countdown" style="display:none;">
          <span class="gflow-label">Next batch in:</span>
          <span id="gflow-ov-countdown-val">0s</span>
        </div>
        <div id="gflow-overlay-buttons">
          <button id="gflow-ov-pause" title="Pause">⏸</button>
          <button id="gflow-ov-resume" title="Resume" style="display:none;">▶</button>
          <button id="gflow-ov-skip" title="Skip">⏭</button>
          <button id="gflow-ov-stop" title="Stop">⏹</button>
        </div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #gflow-auto-overlay {
        position: fixed;
        bottom: 120px;
        right: 20px;
        width: 240px;
        background: #1a1a2e;
        color: #e0e0e0;
        border: 1px solid #333;
        border-radius: 10px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 12px;
        z-index: 999999;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        user-select: none;
        transition: opacity 0.2s;
      }
      #gflow-auto-overlay.gflow-minimized #gflow-overlay-body {
        display: none;
      }
      #gflow-overlay-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: #16213e;
        border-radius: 10px 10px 0 0;
        cursor: move;
        font-weight: 600;
        font-size: 13px;
      }
      #gflow-overlay-minimize {
        cursor: pointer;
        padding: 0 4px;
        font-size: 16px;
        opacity: 0.7;
      }
      #gflow-overlay-minimize:hover { opacity: 1; }
      #gflow-overlay-body {
        padding: 10px 12px;
      }
      #gflow-overlay-body > div {
        margin-bottom: 6px;
      }
      .gflow-label {
        color: #888;
        margin-right: 4px;
      }
      #gflow-ov-status-val {
        font-weight: 600;
        color: #4ecca3;
      }
      #gflow-overlay-buttons {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      #gflow-overlay-buttons button {
        flex: 1;
        padding: 5px 0;
        border: 1px solid #444;
        background: #0f3460;
        color: #e0e0e0;
        border-radius: 5px;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.15s;
      }
      #gflow-overlay-buttons button:hover {
        background: #1a5276;
      }
    `;

    document.body.appendChild(style);
    document.body.appendChild(overlayEl);

    // Draggable
    makeDraggable(overlayEl, document.getElementById('gflow-overlay-header'));

    // Minimize toggle
    document.getElementById('gflow-overlay-minimize').addEventListener('click', () => {
      overlayEl.classList.toggle('gflow-minimized');
    });

    // Overlay button handlers
    document.getElementById('gflow-ov-pause').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'PAUSE' });
    });
    document.getElementById('gflow-ov-resume').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'RESUME' });
    });
    document.getElementById('gflow-ov-skip').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'SKIP' });
    });
    document.getElementById('gflow-ov-stop').addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'STOP' });
    });
  }

  function makeDraggable(el, handle) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      offsetX = e.clientX - el.getBoundingClientRect().left;
      offsetY = e.clientY - el.getBoundingClientRect().top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = (e.clientX - offsetX) + 'px';
      el.style.top = (e.clientY - offsetY) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function updateOverlay(data) {
    if (!overlayEl) return;
    const statusEl = document.getElementById('gflow-ov-status-val');
    const currentEl = document.getElementById('gflow-ov-current');
    const totalEl = document.getElementById('gflow-ov-total');
    const remainingEl = document.getElementById('gflow-ov-remaining');
    const batchEl = document.getElementById('gflow-ov-batch');
    const batchSizeEl = document.getElementById('gflow-ov-batchsize');
    const countdownDiv = document.getElementById('gflow-overlay-countdown');
    const countdownVal = document.getElementById('gflow-ov-countdown-val');
    const pauseBtn = document.getElementById('gflow-ov-pause');
    const resumeBtn = document.getElementById('gflow-ov-resume');

    if (data.status) {
      statusEl.textContent = data.status;
      const colors = {
        idle: '#888', running: '#4ecca3', paused: '#f0a500',
        waiting_cooldown: '#3498db', completed: '#2ecc71', error: '#e74c3c'
      };
      statusEl.style.color = colors[data.status] || '#e0e0e0';
    }
    if (data.currentIndex !== undefined && data.totalPrompts !== undefined) {
      currentEl.textContent = data.currentIndex + 1;
      totalEl.textContent = data.totalPrompts;
      remainingEl.textContent = data.totalPrompts - data.currentIndex;
    }
    if (data.batchProgress !== undefined && data.batchSize !== undefined) {
      batchEl.textContent = data.batchProgress;
      batchSizeEl.textContent = data.batchSize;
    }

    // Pause/Resume visibility
    if (data.status === 'paused') {
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = '';
    } else {
      pauseBtn.style.display = '';
      resumeBtn.style.display = 'none';
    }

    // Countdown
    if (data.countdownEnd) {
      countdownDiv.style.display = '';
      startCountdownDisplay(data.countdownEnd);
    } else {
      countdownDiv.style.display = 'none';
      stopCountdownDisplay();
    }
  }

  function startCountdownDisplay(endTimestamp) {
    stopCountdownDisplay();
    const countdownVal = document.getElementById('gflow-ov-countdown-val');
    countdownInterval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endTimestamp - Date.now()) / 1000));
      countdownVal.textContent = remaining + 's';
      if (remaining <= 0) {
        stopCountdownDisplay();
        document.getElementById('gflow-overlay-countdown').style.display = 'none';
      }
    }, 500);
  }

  function stopCountdownDisplay() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  function removeOverlay() {
    stopCountdownDisplay();
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
  }

  /* ============================================================
     MAIN PROMPT PROCESSING
     ============================================================ */

  async function processPrompt(prompt, index, runId, promptSettings) {
    if (isStopped || runId !== currentRunId) return;

    settings = promptSettings || settings;
    isProcessing = true;
    addLog(`Processing prompt: "${prompt.substring(0, 60)}..."`, 'info');

    // Find input
    let inputEl = null;
    const maxRetries = settings.maxRetries || 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      inputEl = findPromptInput(settings.customInputSelectors || []);
      if (inputEl) break;
      addLog(`Input not found, retry ${attempt + 1}/${maxRetries}...`, 'warn');
      await sleep(1000);
    }

    if (!inputEl) {
      addLog('Could not find prompt input after retries.', 'error');
      isProcessing = false;
      chrome.runtime.sendMessage({
        action: 'PROMPT_ERROR',
        index: index,
        runId: runId,
        error: 'Prompt input element not found'
      });
      return;
    }

    addLog('Input element found.', 'success');

    // Check if paused before continuing
    if (isPaused) {
      addLog('Paused before typing.', 'info');
      await waitForUnpause();
      if (isStopped || runId !== currentRunId) return;
    }

    // Clear, focus, type
    clearPromptInput(inputEl);
    await sleep(200);
    focusPromptInput(inputEl);
    await sleep(200);

    addLog('Typing prompt...', 'info');
    const typingDelay = settings.typingDelayMs || 20;
    await simulateTyping(inputEl, prompt, typingDelay);
    addLog('Prompt typed.', 'success');

    await sleep(300);

    // Check pause again
    if (isPaused) {
      await waitForUnpause();
      if (isStopped || runId !== currentRunId) return;
    }

    // Submit — try multiple times if needed
    const submitMethod = settings.submitMethod || 'auto';
    addLog('Submitting prompt...', 'info');

    let submitted = false;
    const submitRetries = settings.maxRetries || 2;

    for (let attempt = 0; attempt <= submitRetries; attempt++) {
      submitted = await submitPrompt(inputEl, submitMethod, settings.customSubmitSelectors || []);
      if (submitted) break;

      if (attempt < submitRetries) {
        addLog('Submit attempt failed, retrying...', 'warn');
        await sleep(1000);
        // Re-focus input before retry
        focusPromptInput(inputEl);
        await sleep(300);
      }
    }

    if (submitted) {
      addLog('Prompt submitted successfully.', 'success');
    } else {
      addLog('Prompt submission may have failed (no button found).', 'warn');
    }

    // Wait after submission for generation to start and complete
    await sleep(2000);

    // Wait for generation to complete
    const detectionStrategy = settings.detectionStrategy || 'hybrid';
    const waitTime = settings.intraPromptGapMs || 3000;
    addLog('Waiting for page ready state...', 'info');
    await waitForReadyState(waitTime, detectionStrategy);

    isProcessing = false;

    // Report done
    chrome.runtime.sendMessage({
      action: 'PROMPT_DONE',
      index: index,
      runId: runId
    });
  }

  function waitForUnpause() {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!isPaused || isStopped) {
          clearInterval(check);
          resolve();
        }
      }, 300);
    });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* ============================================================
     MUTATION OBSERVER
     ============================================================ */

  function startMutationObserver() {
    if (mutationObserver) return;
    mutationObserver = new MutationObserver((mutations) => {
      // Silent observation — used by waitForReadyState via detectGenerationActivity
    });
    mutationObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true
    });
  }

  function stopMutationObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  /* ============================================================
     MESSAGE HANDLING
     ============================================================ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {

      case 'PROCESS_PROMPT':
        currentRunId = msg.runId;
        isPaused = false;
        isStopped = false;
        if (settings.overlayEnabled !== false) {
          createOverlay();
        }
        startMutationObserver();
        processPrompt(msg.prompt, msg.index, msg.runId, msg.settings);
        sendResponse({ ok: true });
        break;

      case 'PAUSE':
        isPaused = true;
        addLog('Automation paused.', 'info');
        sendResponse({ ok: true });
        break;

      case 'RESUME':
        isPaused = false;
        addLog('Automation resumed.', 'info');
        sendResponse({ ok: true });
        break;

      case 'STOP':
        isStopped = true;
        isPaused = false;
        currentRunId = null;
        isProcessing = false;
        stopMutationObserver();
        stopCountdownDisplay();
        addLog('Automation stopped.', 'info');
        sendResponse({ ok: true });
        break;

      case 'SKIP':
        // If currently processing, signal skip (stop current then background sends next)
        if (isProcessing) {
          isStopped = true; // Will cause processPrompt to bail
          setTimeout(() => { isStopped = false; }, 500);
        }
        addLog('Skipping current prompt.', 'info');
        sendResponse({ ok: true });
        break;

      case 'FIND_INPUT':
        const el = findPromptInput(msg.customSelectors || []);
        sendResponse({ found: !!el, tagName: el ? el.tagName : null });
        break;

      case 'UPDATE_OVERLAY':
        if (settings.overlayEnabled !== false) {
          createOverlay();
          updateOverlay(msg.data || {});
        }
        sendResponse({ ok: true });
        break;

      case 'REMOVE_OVERLAY':
        removeOverlay();
        sendResponse({ ok: true });
        break;

      case 'PING':
        sendResponse({ ok: true, ready: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }

    return true; // Keep message channel open for async
  });

  /* ============================================================
     AUTO-REATTACH ON LOAD
     ============================================================ */

  chrome.storage.local.get(['status', 'autoReattachAfterReload', 'activeTabId', 'settings'], (data) => {
    settings = data.settings || {};

    if (data.autoReattachAfterReload !== false &&
        (data.status === 'running' || data.status === 'paused' || data.status === 'waiting_cooldown')) {
      addLog('Content script reloaded — sending CONTENT_READY.', 'info');
      chrome.runtime.sendMessage({ action: 'CONTENT_READY' });

      if (settings.overlayEnabled !== false) {
        createOverlay();
        updateOverlay({ status: data.status });
      }
    }
  });

  /* ============================================================
     STORAGE CHANGE LISTENER (for overlay updates)
     ============================================================ */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    const newStatus = changes.status?.newValue;
    const newIndex = changes.currentIndex?.newValue;
    const newCountdown = changes.countdownEnd?.newValue;
    const prompts = changes.prompts?.newValue;

    if (overlayEl) {
      chrome.storage.local.get(['status', 'currentIndex', 'prompts', 'settings', 'countdownEnd'], (data) => {
        const totalPrompts = (data.prompts || []).length;
        const s = data.settings || {};
        const batchSize = s.batchSize || 4;
        const batchProgress = data.currentIndex % batchSize;

        updateOverlay({
          status: data.status,
          currentIndex: data.currentIndex || 0,
          totalPrompts: totalPrompts,
          batchProgress: batchProgress,
          batchSize: batchSize,
          countdownEnd: data.countdownEnd
        });
      });
    }
  });

})();
