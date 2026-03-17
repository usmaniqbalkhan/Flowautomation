/**
 * background.js — Service worker coordinator for Google Flow Prompt Automation.
 * Manages state machine, job lifecycle, single-tab enforcement, and messaging.
 */

/* ============================================================
   DEFAULT SETTINGS
   ============================================================ */
const DEFAULT_SETTINGS = {
  batchSize: 4,
  batchCooldownMs: 60000,
  intraPromptGapMs: 3000,
  typingDelayMs: 20,
  maxRetries: 2,
  submitMethod: 'auto',
  parserMode: 'paragraph',
  overlayEnabled: true,
  detectionStrategy: 'hybrid',
  autoReattachAfterReload: true,
  customInputSelectors: [],
  customSubmitSelectors: [],
  urlPatterns: ['*://aitestkitchen.withgoogle.com/*', '*://labs.google/*']
};

const ALARM_BATCH_COOLDOWN = 'batch-cooldown';

/* ============================================================
   STATE HELPERS
   ============================================================ */

/**
 * Load full state from storage with defaults.
 */
function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (data) => {
      resolve({
        prompts: data.prompts || [],
        currentIndex: data.currentIndex || 0,
        status: data.status || 'idle',
        runId: data.runId || null,
        activeTabId: data.activeTabId || null,
        settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
        logs: data.logs || [],
        countdownEnd: data.countdownEnd || null,
        lastError: data.lastError || null
      });
    });
  });
}

/**
 * Save partial state updates to storage.
 */
function saveState(updates) {
  return new Promise((resolve) => {
    chrome.storage.local.set(updates, resolve);
  });
}

/**
 * Add a log entry to storage.
 */
async function addLogEntry(message, level) {
  const entry = {
    timestamp: new Date().toISOString(),
    message: message,
    level: level || 'info'
  };
  console.log(`[FlowAuto BG] [${entry.level.toUpperCase()}] ${entry.message}`);

  const state = await loadState();
  const logs = state.logs.slice(-199); // Keep last 200 entries
  logs.push(entry);
  await saveState({ logs: logs });
}

/**
 * Generate a unique run ID.
 */
function generateRunId() {
  return 'run-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

/**
 * Check if a URL matches allowed patterns.
 */
function urlMatchesPatterns(url, patterns) {
  if (!url) return false;
  for (const pattern of patterns) {
    // Convert match pattern to regex
    const regexStr = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    try {
      if (new RegExp('^' + regexStr + '$').test(url)) return true;
    } catch (e) {
      // Simpler check — see if the URL contains key parts
    }
  }
  // Fallback: check known hostnames
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'aitestkitchen.withgoogle.com' ||
        parsed.hostname === 'labs.google' ||
        parsed.hostname.endsWith('.labs.google')) {
      return true;
    }
  } catch (e) { /* invalid URL */ }
  return false;
}

/* ============================================================
   SEND MESSAGE TO CONTENT SCRIPT
   ============================================================ */

function sendToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[FlowAuto BG] sendToContent error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Update the overlay on the content script tab.
 */
async function updateContentOverlay(state) {
  if (!state.activeTabId) return;
  const totalPrompts = (state.prompts || []).length;
  const batchSize = state.settings.batchSize || 4;
  const batchProgress = state.currentIndex % batchSize;

  await sendToContent(state.activeTabId, {
    action: 'UPDATE_OVERLAY',
    data: {
      status: state.status,
      currentIndex: state.currentIndex,
      totalPrompts: totalPrompts,
      batchProgress: batchProgress,
      batchSize: batchSize,
      countdownEnd: state.countdownEnd
    }
  });
}

/* ============================================================
   CORE AUTOMATION LOGIC
   ============================================================ */

/**
 * Send the next prompt to the content script.
 */
async function sendNextPrompt() {
  const state = await loadState();

  if (state.status !== 'running') {
    return;
  }

  if (state.currentIndex >= state.prompts.length) {
    await addLogEntry('All prompts processed!', 'success');
    await saveState({ status: 'completed', countdownEnd: null });
    await updateContentOverlay({ ...state, status: 'completed', countdownEnd: null });
    return;
  }

  const prompt = state.prompts[state.currentIndex];
  await addLogEntry('Sending next prompt...', 'info');

  const response = await sendToContent(state.activeTabId, {
    action: 'PROCESS_PROMPT',
    prompt: prompt,
    index: state.currentIndex,
    runId: state.runId,
    settings: state.settings
  });

  if (!response || !response.ok) {
    await addLogEntry('Failed to send prompt to content script. Tab may have been closed or navigated away.', 'error');
    await saveState({ status: 'error', lastError: 'Content script unreachable' });
  }

  await updateContentOverlay(state);
}

/**
 * Handle successful prompt completion.
 */
async function handlePromptDone(msg) {
  const state = await loadState();

  // Validate run ID to prevent stale messages
  if (msg.runId !== state.runId) {
    console.warn('[FlowAuto BG] Stale runId, ignoring PROMPT_DONE');
    return;
  }

  const newIndex = state.currentIndex + 1;
  const batchSize = state.settings.batchSize || 4;
  const batchCooldownMs = state.settings.batchCooldownMs || 60000;

  await addLogEntry('Prompt completed.', 'success');

  // Check if all done
  if (newIndex >= state.prompts.length) {
    await saveState({ currentIndex: newIndex, status: 'completed', countdownEnd: null });
    await addLogEntry('All prompts completed!', 'success');
    await updateContentOverlay({ ...state, currentIndex: newIndex, status: 'completed', countdownEnd: null });
    return;
  }

  // Check if batch boundary
  if (newIndex % batchSize === 0) {
    // Start batch cooldown
    const countdownEnd = Date.now() + batchCooldownMs;
    await saveState({
      currentIndex: newIndex,
      status: 'waiting_cooldown',
      countdownEnd: countdownEnd
    });
    await addLogEntry(`Batch completed. Cooling down for ${batchCooldownMs / 1000}s...`, 'info');

    // Set alarm for cooldown
    chrome.alarms.create(ALARM_BATCH_COOLDOWN, {
      when: countdownEnd
    });

    await updateContentOverlay({
      ...state, currentIndex: newIndex,
      status: 'waiting_cooldown', countdownEnd: countdownEnd
    });
  } else {
    // Continue with next prompt after intra-prompt gap
    await saveState({ currentIndex: newIndex, status: 'running' });

    // Small delay before sending next prompt (intra-prompt gap is handled by content script's waitForReadyState)
    setTimeout(sendNextPrompt, 500);
  }
}

/**
 * Handle prompt error.
 */
async function handlePromptError(msg) {
  const state = await loadState();
  if (msg.runId !== state.runId) return;

  await addLogEntry(`Prompt error: ${msg.error}`, 'error');
  await saveState({ status: 'error', lastError: msg.error });
  await updateContentOverlay({ ...state, status: 'error' });
}

/* ============================================================
   ALARM HANDLER (batch cooldown)
   ============================================================ */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_BATCH_COOLDOWN) {
    const state = await loadState();
    if (state.status === 'waiting_cooldown') {
      await addLogEntry('Batch cooldown finished. Resuming automation.', 'info');
      await saveState({ status: 'running', countdownEnd: null });
      await sendNextPrompt();
    }
  }
});

/* ============================================================
   MESSAGE HANDLER
   ============================================================ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Handle async operations by wrapping in an IIFE
  (async () => {
    try {
      switch (msg.action) {

        case 'START': {
          const state = await loadState();

          // Validate prompts loaded
          if (!state.prompts || state.prompts.length === 0) {
            sendResponse({ ok: false, error: 'No prompts loaded. Upload a .txt file first.' });
            return;
          }

          // Get active tab
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab) {
            sendResponse({ ok: false, error: 'No active tab found.' });
            return;
          }

          // Validate URL
          if (!urlMatchesPatterns(activeTab.url, state.settings.urlPatterns)) {
            sendResponse({ ok: false, error: 'Current tab URL does not match Google Flow page. Navigate to the Flow page first.' });
            return;
          }

          // Single-tab enforcement
          if (state.status === 'running' && state.activeTabId && state.activeTabId !== activeTab.id) {
            sendResponse({ ok: false, error: 'Automation is already running in another tab.' });
            return;
          }

          // Ensure content script is responsive
          const pingResp = await sendToContent(activeTab.id, { action: 'PING' });
          if (!pingResp || !pingResp.ready) {
            // Try injecting content scripts
            try {
              await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                files: ['utils.js', 'content.js']
              });
              // Wait briefly for scripts to initialize
              await new Promise(r => setTimeout(r, 500));
            } catch (e) {
              sendResponse({ ok: false, error: 'Cannot inject content script: ' + e.message });
              return;
            }
          }

          // Start automation
          const runId = generateRunId();
          await saveState({
            status: 'running',
            runId: runId,
            activeTabId: activeTab.id,
            countdownEnd: null,
            lastError: null
          });
          await addLogEntry('Automation started.', 'success');

          sendResponse({ ok: true, runId: runId });

          // Send first prompt
          await sendNextPrompt();
          break;
        }

        case 'PAUSE': {
          const state = await loadState();
          if (state.status === 'running' || state.status === 'waiting_cooldown') {
            await saveState({ status: 'paused' });
            chrome.alarms.clear(ALARM_BATCH_COOLDOWN);
            if (state.activeTabId) {
              await sendToContent(state.activeTabId, { action: 'PAUSE' });
            }
            await addLogEntry('Automation paused.', 'info');
            await updateContentOverlay({ ...state, status: 'paused', countdownEnd: null });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'RESUME': {
          const state = await loadState();
          if (state.status === 'paused') {
            await saveState({ status: 'running', countdownEnd: null });
            if (state.activeTabId) {
              await sendToContent(state.activeTabId, { action: 'RESUME' });
            }
            await addLogEntry('Automation resumed.', 'info');
            await sendNextPrompt();
          }
          sendResponse({ ok: true });
          break;
        }

        case 'STOP': {
          const state = await loadState();
          chrome.alarms.clear(ALARM_BATCH_COOLDOWN);
          if (state.activeTabId) {
            await sendToContent(state.activeTabId, { action: 'STOP' });
          }
          await saveState({
            status: 'idle',
            runId: null,
            activeTabId: null,
            countdownEnd: null
          });
          await addLogEntry('Automation stopped.', 'info');
          sendResponse({ ok: true });
          break;
        }

        case 'SKIP': {
          const state = await loadState();
          if (state.status === 'running' || state.status === 'paused') {
            // Signal content script to skip
            if (state.activeTabId) {
              await sendToContent(state.activeTabId, { action: 'SKIP' });
            }
            const newIndex = state.currentIndex + 1;
            await addLogEntry('Skipped current prompt.', 'info');

            if (newIndex >= state.prompts.length) {
              await saveState({ currentIndex: newIndex, status: 'completed' });
              await addLogEntry('All prompts completed (last was skipped).', 'success');
            } else {
              await saveState({ currentIndex: newIndex, status: 'running' });
              setTimeout(sendNextPrompt, 1000);
            }
          }
          sendResponse({ ok: true });
          break;
        }

        case 'RESET': {
          const state = await loadState();
          chrome.alarms.clear(ALARM_BATCH_COOLDOWN);
          if (state.activeTabId) {
            await sendToContent(state.activeTabId, { action: 'STOP' });
            await sendToContent(state.activeTabId, { action: 'REMOVE_OVERLAY' });
          }
          await saveState({
            currentIndex: 0,
            status: 'idle',
            runId: null,
            activeTabId: null,
            countdownEnd: null,
            lastError: null,
            logs: []
          });
          await addLogEntry('Progress reset to 0.', 'info');
          sendResponse({ ok: true });
          break;
        }

        case 'GET_STATE': {
          const state = await loadState();
          sendResponse({ ok: true, state: state });
          break;
        }

        case 'LOAD_PROMPTS': {
          const prompts = msg.prompts || [];
          await saveState({
            prompts: prompts,
            currentIndex: 0,
            status: 'idle',
            runId: null,
            activeTabId: null
          });
          await addLogEntry(`Loaded ${prompts.length} prompts.`, 'success');
          sendResponse({ ok: true, count: prompts.length });
          break;
        }

        case 'SAVE_SETTINGS': {
          const currentState = await loadState();
          const newSettings = { ...currentState.settings, ...msg.settings };
          await saveState({ settings: newSettings });
          await addLogEntry('Settings updated.', 'info');
          sendResponse({ ok: true });
          break;
        }

        case 'PROMPT_DONE': {
          await handlePromptDone(msg);
          sendResponse({ ok: true });
          break;
        }

        case 'PROMPT_ERROR': {
          await handlePromptError(msg);
          sendResponse({ ok: true });
          break;
        }

        case 'CONTENT_READY': {
          // Content script reloaded — check if we should auto-resume
          const state = await loadState();
          if (state.settings.autoReattachAfterReload &&
              (state.status === 'running' || state.status === 'waiting_cooldown')) {
            const tabId = sender.tab?.id;
            if (tabId) {
              await saveState({ activeTabId: tabId });
              await addLogEntry('Content script reconnected after reload.', 'info');

              if (state.status === 'running') {
                await sendNextPrompt();
              }
            }
          }
          sendResponse({ ok: true });
          break;
        }

        case 'ADD_LOG': {
          if (msg.log) {
            const state = await loadState();
            const logs = state.logs.slice(-199);
            logs.push(msg.log);
            await saveState({ logs: logs });
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown action: ' + msg.action });
      }
    } catch (err) {
      console.error('[FlowAuto BG] Error handling message:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async
});

/* ============================================================
   TAB EVENT LISTENERS
   ============================================================ */

// Tab closed — if it was the active automation tab, pause
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (state.activeTabId === tabId && state.status !== 'idle' && state.status !== 'completed') {
    chrome.alarms.clear(ALARM_BATCH_COOLDOWN);
    await saveState({ status: 'paused', activeTabId: null, countdownEnd: null });
    await addLogEntry('Active tab was closed. Automation paused.', 'warn');
  }
});

// Tab URL changed — if active tab navigated away from target, warn
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const state = await loadState();
  if (state.activeTabId === tabId && state.status === 'running') {
    if (!urlMatchesPatterns(changeInfo.url, state.settings.urlPatterns)) {
      await saveState({ status: 'paused' });
      await addLogEntry('Active tab navigated away from target page. Automation paused.', 'warn');
    }
  }
});

/* ============================================================
   SERVICE WORKER INSTALL/ACTIVATE
   ============================================================ */

chrome.runtime.onInstalled.addListener(async () => {
  // Initialize default settings if not present
  const state = await loadState();
  if (!state.settings || Object.keys(state.settings).length === 0) {
    await saveState({ settings: DEFAULT_SETTINGS });
  }
  console.log('[FlowAuto BG] Extension installed/updated.');
});
