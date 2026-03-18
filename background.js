/**
 * background.js — Service worker coordinator for Flow Automation v2.
 * Extended state machine with queue management, image capture, and auto-retry.
 */

/* ============================================================
   DEFAULT SETTINGS
   ============================================================ */
const DEFAULT_SETTINGS = {
  mode: 'text-to-image',
  imagesPerTask: 4,
  imageModel: 'nano_banana_pro',
  imageRatio: '16:9',
  submitPath: 'dom_first',
  batchSize: 4,
  batchCooldownMs: 60000,
  intraPromptGapMs: 3000,
  imageSubmitWaitMs: 2500,
  typingDelayMs: 20,
  maxRetries: 2,
  submitMethod: 'auto',
  parserMode: 'line',
  detectionStrategy: 'hybrid',
  autoReattachAfterReload: true,
  autoStartNext: true,
  autoRetryFailed: false,
  autoRetryMaxRounds: 12,
  autoZoom: false,
  zoomLevel: 0.8,
  autoNewProject: false,
  customInputSelectors: [],
  customSubmitSelectors: [],
  downloadSettings: {
    autoDownloadImages: false,
    imageResolution: '1K',
    autoDownloadVideos: false,
    videoResolution: '720p',
    folder: 'flowautomation',
    autoNumber: true
  },
  filenameTemplate: {
    prefix: '',
    index: 'nn',
    promptPart: 'first_3_words',
    date: 'none',
    suffix: 'none',
    separator: '_'
  }
};

const ALARM_BATCH_COOLDOWN = 'batch-cooldown';

/* ============================================================
   STATE HELPERS
   ============================================================ */

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
        lastError: data.lastError || null,
        capturedImages: data.capturedImages || [],
        authContext: data.authContext || null,
        failedPrompts: data.failedPrompts || [],
        retryRound: data.retryRound || 0,
        jobId: data.jobId || null,
        totalJobs: data.totalJobs || 1,
        currentJob: data.currentJob || 1
      });
    });
  });
}

function saveState(updates) {
  return new Promise((resolve) => {
    chrome.storage.local.set(updates, resolve);
  });
}

async function addLogEntry(message, level) {
  const entry = {
    timestamp: new Date().toISOString(),
    message: message,
    level: level || 'info'
  };
  console.log(`[FlowAuto BG] [${entry.level.toUpperCase()}] ${entry.message}`);

  const state = await loadState();
  const logs = state.logs.slice(-499); // Keep last 500 entries
  logs.push(entry);
  await saveState({ logs: logs });
}

function generateRunId() {
  return 'run-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}

function urlMatchesPatterns(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'labs.google' ||
           parsed.hostname.endsWith('.labs.google');
  } catch (e) { return false; }
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

/* ============================================================
   CORE AUTOMATION LOGIC
   ============================================================ */

async function sendNextPrompt() {
  const state = await loadState();

  if (state.status !== 'running') return;

  if (state.currentIndex >= state.prompts.length) {
    // Check for failed prompts to retry
    if (state.settings.autoRetryFailed && state.failedPrompts.length > 0 &&
        state.retryRound < state.settings.autoRetryMaxRounds) {
      await addLogEntry(`Retrying ${state.failedPrompts.length} failed prompts (round ${state.retryRound + 1})...`, 'info');
      await saveState({
        prompts: state.failedPrompts,
        failedPrompts: [],
        currentIndex: 0,
        retryRound: state.retryRound + 1
      });
      await sendNextPrompt();
      return;
    }

    await addLogEntry('All prompts processed!', 'success');
    await saveState({ status: 'completed', countdownEnd: null });
    return;
  }

  const prompt = state.prompts[state.currentIndex];
  await addLogEntry(`[Job ${state.currentJob}/${state.totalJobs}] Sending prompt ${state.currentIndex + 1}/${state.prompts.length}...`, 'info');

  const response = await sendToContent(state.activeTabId, {
    action: 'PROCESS_PROMPT',
    prompt: prompt,
    index: state.currentIndex,
    runId: state.runId,
    settings: state.settings
  });

  if (!response || !response.ok) {
    await addLogEntry('Failed to send prompt to content script.', 'error');
    await saveState({ status: 'error', lastError: 'Content script unreachable' });
  }
}

async function handlePromptDone(msg) {
  const state = await loadState();
  if (msg.runId !== state.runId) return;

  const newIndex = state.currentIndex + 1;
  const batchSize = state.settings.batchSize || 4;
  const batchCooldownMs = state.settings.batchCooldownMs || 60000;

  await addLogEntry(`Prompt ${newIndex} completed.`, 'success');

  if (newIndex >= state.prompts.length) {
    // Check auto-retry
    if (state.settings.autoRetryFailed && state.failedPrompts.length > 0 &&
        state.retryRound < state.settings.autoRetryMaxRounds) {
      await addLogEntry(`Starting retry round ${state.retryRound + 1} for ${state.failedPrompts.length} failed prompts.`, 'info');
      await saveState({
        prompts: state.failedPrompts,
        failedPrompts: [],
        currentIndex: 0,
        retryRound: state.retryRound + 1,
        status: 'running'
      });
      setTimeout(sendNextPrompt, 1000);
      return;
    }

    await saveState({ currentIndex: newIndex, status: 'completed', countdownEnd: null });
    await addLogEntry('All prompts completed!', 'success');
    return;
  }

  // Batch boundary check
  if (newIndex % batchSize === 0) {
    const countdownEnd = Date.now() + batchCooldownMs;
    await saveState({
      currentIndex: newIndex,
      status: 'waiting_cooldown',
      countdownEnd: countdownEnd
    });
    await addLogEntry(`Batch completed. Cooling down for ${batchCooldownMs / 1000}s...`, 'info');
    chrome.alarms.create(ALARM_BATCH_COOLDOWN, { when: countdownEnd });
  } else {
    await saveState({ currentIndex: newIndex, status: 'running' });
    const waitMs = state.settings.imageSubmitWaitMs || 2500;
    setTimeout(sendNextPrompt, waitMs);
  }
}

async function handlePromptError(msg) {
  const state = await loadState();
  if (msg.runId !== state.runId) return;

  const failedPrompt = state.prompts[state.currentIndex];
  const failedPrompts = [...state.failedPrompts, failedPrompt];

  await addLogEntry(`Prompt error: ${msg.error}`, 'error');

  // Continue to next prompt instead of stopping
  const newIndex = state.currentIndex + 1;
  if (newIndex >= state.prompts.length) {
    if (state.settings.autoRetryFailed && failedPrompts.length > 0 &&
        state.retryRound < state.settings.autoRetryMaxRounds) {
      await saveState({
        prompts: failedPrompts,
        failedPrompts: [],
        currentIndex: 0,
        retryRound: state.retryRound + 1,
        status: 'running'
      });
      await addLogEntry(`Starting retry round for ${failedPrompts.length} failed prompts.`, 'info');
      setTimeout(sendNextPrompt, 1000);
    } else {
      await saveState({
        currentIndex: newIndex,
        status: 'completed',
        failedPrompts: failedPrompts
      });
    }
  } else {
    await saveState({
      currentIndex: newIndex,
      status: 'running',
      failedPrompts: failedPrompts
    });
    setTimeout(sendNextPrompt, 1000);
  }
}

/* ============================================================
   ALARM HANDLER
   ============================================================ */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_BATCH_COOLDOWN) {
    const state = await loadState();
    if (state.status === 'waiting_cooldown') {
      await addLogEntry('Batch cooldown finished. Resuming.', 'info');
      await saveState({ status: 'running', countdownEnd: null });
      await sendNextPrompt();
    }
  }
});

/* ============================================================
   MESSAGE HANDLER
   ============================================================ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {

        case 'START': {
          const state = await loadState();

          if (!state.prompts || state.prompts.length === 0) {
            sendResponse({ ok: false, error: 'No prompts loaded.' });
            return;
          }

          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!activeTab) {
            sendResponse({ ok: false, error: 'No active tab found.' });
            return;
          }

          if (!urlMatchesPatterns(activeTab.url)) {
            sendResponse({ ok: false, error: 'Navigate to Google Flow first.' });
            return;
          }

          // Ensure content script is ready
          const pingResp = await sendToContent(activeTab.id, { action: 'PING' });
          if (!pingResp || !pingResp.ready) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                files: ['utils.js', 'flow-configurator.js', 'content.js', 'panel.js']
              });
              await new Promise(r => setTimeout(r, 500));
            } catch (e) {
              sendResponse({ ok: false, error: 'Cannot inject content script: ' + e.message });
              return;
            }
          }

          // Configure Flow if needed
          if (state.settings.autoZoom || state.settings.autoNewProject) {
            await sendToContent(activeTab.id, {
              action: 'CONFIGURE_FLOW',
              config: {
                autoZoom: state.settings.autoZoom,
                zoomLevel: state.settings.zoomLevel,
                newProject: state.settings.autoNewProject,
                imageCount: state.settings.imagesPerTask,
                model: state.settings.imageModel,
                ratio: state.settings.imageRatio
              }
            });
            await new Promise(r => setTimeout(r, 1000));
          }

          const runId = generateRunId();
          const startIndex = state.settings.startFrom ? Math.max(0, state.settings.startFrom - 1) : (state.currentIndex || 0);

          await saveState({
            status: 'running',
            runId: runId,
            activeTabId: activeTab.id,
            currentIndex: startIndex,
            countdownEnd: null,
            lastError: null,
            failedPrompts: [],
            retryRound: 0,
            currentJob: 1,
            totalJobs: 1
          });
          await addLogEntry('Automation started.', 'success');

          sendResponse({ ok: true, runId: runId });
          await sendNextPrompt();
          break;
        }

        case 'PAUSE': {
          const state = await loadState();
          if (state.status === 'running' || state.status === 'waiting_cooldown') {
            await saveState({ status: 'paused', countdownEnd: null });
            chrome.alarms.clear(ALARM_BATCH_COOLDOWN);
            if (state.activeTabId) {
              await sendToContent(state.activeTabId, { action: 'PAUSE' });
            }
            await addLogEntry('Automation paused.', 'info');
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
            if (state.activeTabId) {
              await sendToContent(state.activeTabId, { action: 'SKIP' });
            }
            const newIndex = state.currentIndex + 1;
            await addLogEntry('Skipped current prompt.', 'info');

            if (newIndex >= state.prompts.length) {
              await saveState({ currentIndex: newIndex, status: 'completed' });
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
          }
          await saveState({
            currentIndex: 0,
            status: 'idle',
            runId: null,
            activeTabId: null,
            countdownEnd: null,
            lastError: null,
            failedPrompts: [],
            retryRound: 0,
            logs: []
          });
          await addLogEntry('Progress reset.', 'info');
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
            activeTabId: null,
            failedPrompts: [],
            retryRound: 0
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
          const state = await loadState();
          if (state.settings.autoReattachAfterReload &&
              (state.status === 'running' || state.status === 'waiting_cooldown')) {
            const tabId = sender.tab?.id;
            if (tabId) {
              await saveState({ activeTabId: tabId });
              await addLogEntry('Content script reconnected.', 'info');
              if (state.status === 'running') {
                await sendNextPrompt();
              }
            }
          }
          sendResponse({ ok: true });
          break;
        }

        case 'API_AUTH_CAPTURED': {
          await saveState({ authContext: msg.authContext });
          await addLogEntry('API auth context stored.', 'info');
          sendResponse({ ok: true });
          break;
        }

        case 'IMAGES_CAPTURED': {
          const state = await loadState();
          const newImages = (msg.images || []).map(url => ({
            url: url,
            promptText: msg.promptText || '',
            projectId: msg.projectId || '',
            timestamp: Date.now(),
            resolution: '1K'
          }));
          const capturedImages = [...state.capturedImages, ...newImages];
          await saveState({ capturedImages: capturedImages });
          sendResponse({ ok: true });
          break;
        }

        case 'RETRY_FAILED': {
          const state = await loadState();
          if (state.failedPrompts.length > 0) {
            await saveState({
              prompts: state.failedPrompts,
              failedPrompts: [],
              currentIndex: 0,
              status: 'idle',
              retryRound: state.retryRound + 1
            });
            await addLogEntry(`Queued ${state.failedPrompts.length} failed prompts for retry.`, 'info');
          }
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_GALLERY': {
          await saveState({ capturedImages: [] });
          await addLogEntry('Gallery cleared.', 'info');
          sendResponse({ ok: true });
          break;
        }

        case 'ADD_LOG': {
          if (msg.log) {
            const state = await loadState();
            const logs = state.logs.slice(-499);
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
      console.error('[FlowAuto BG] Error:', err);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

/* ============================================================
   TAB EVENT LISTENERS
   ============================================================ */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await loadState();
  if (state.activeTabId === tabId && state.status !== 'idle' && state.status !== 'completed') {
    chrome.alarms.clear(ALARM_BATCH_COOLDOWN);
    await saveState({ status: 'paused', activeTabId: null, countdownEnd: null });
    await addLogEntry('Active tab closed. Automation paused.', 'warn');
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const state = await loadState();
  if (state.activeTabId === tabId && state.status === 'running') {
    if (!urlMatchesPatterns(changeInfo.url)) {
      await saveState({ status: 'paused' });
      await addLogEntry('Tab navigated away. Automation paused.', 'warn');
    }
  }
});

/* ============================================================
   TOOLBAR ICON CLICK — Toggle Panel
   ============================================================ */

chrome.action.onClicked.addListener(async (tab) => {
  if (urlMatchesPatterns(tab.url)) {
    await sendToContent(tab.id, { action: 'TOGGLE_PANEL' });
  } else {
    // Open Flow page
    chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' });
  }
});

/* ============================================================
   INSTALL/UPDATE
   ============================================================ */

chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadState();
  if (!state.settings || Object.keys(state.settings).length === 0) {
    await saveState({ settings: DEFAULT_SETTINGS });
  }
  console.log('[FlowAuto BG] Extension installed/updated v2.0.');
});
