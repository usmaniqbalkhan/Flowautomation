/**
 * content.js — DOM automation and message relay for Flow Automation v2.
 * Handles prompt processing, API interceptor communication, and panel coordination.
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
  let mutationObserver = null;
  let settings = {};
  let capturedAuthContext = null;
  let capturedApiEndpoints = {};

  /* ============================================================
     API INTERCEPTOR BRIDGE (MAIN world ↔ ISOLATED world)
     ============================================================ */

  /**
   * Listen for messages from api-interceptor.js running in MAIN world.
   * Relay relevant data to background.js and panel.js.
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('GFLOW_')) return;

    // api-interceptor.js wraps data in a `payload` field
    const payload = data.payload || {};

    switch (data.type) {
      case 'GFLOW_AUTH_UPDATED':
        // Auth context updated from intercepted API calls
        capturedAuthContext = payload;
        addLog(`API auth context updated (${payload.headerCount || 0} headers).`, 'success');
        chrome.runtime.sendMessage({
          action: 'API_AUTH_CAPTURED',
          authContext: payload
        });
        break;

      case 'GFLOW_TRPC_REQUEST':
        // Intercepted outgoing tRPC request
        if (payload.url) {
          try {
            const urlPath = new URL(payload.url, window.location.origin).pathname;
            capturedApiEndpoints[urlPath] = {
              method: payload.method || 'POST',
              procedures: payload.procedures || [],
              lastSeen: Date.now()
            };
          } catch (e) { /* ignore URL parse errors */ }
        }
        break;

      case 'GFLOW_TRPC_RESPONSE':
        // Intercepted tRPC response — logged for debugging
        if (payload.hasImages && payload.imageCount > 0) {
          addLog(`tRPC response: ${payload.imageCount} images from ${(payload.procedures || []).join(',')}.`, 'info');
        }
        break;

      case 'GFLOW_IMAGES_DISCOVERED':
        // New images discovered from API responses
        if (payload.newUrls && payload.newUrls.length > 0) {
          chrome.runtime.sendMessage({
            action: 'IMAGES_CAPTURED',
            images: payload.newUrls,
            promptText: payload.procedure || '',
            projectId: ''
          });
          addLog(`Captured ${payload.newUrls.length} image URLs from API.`, 'success');
        }
        break;

      case 'GFLOW_SUBMIT_RESULT':
        // Result from API-based prompt submission
        if (payload.success) {
          addLog('API submission successful.', 'success');
        } else {
          addLog('API submission failed: ' + (payload.error || 'unknown'), 'error');
        }
        break;

      case 'GFLOW_INTERCEPTOR_READY':
        addLog('API interceptor ready.', 'info');
        break;

      case 'GFLOW_TRPC_ERROR':
        addLog(`tRPC error: ${payload.error || 'unknown'} for ${payload.url || ''}`, 'warn');
        break;
    }
  });

  /**
   * Submit a prompt via the API interceptor (MAIN world).
   * @param {string} promptText - The prompt to submit
   * @returns {Promise<boolean>} Whether the API submission was initiated
   */
  function submitViaAPI(promptText) {
    return new Promise((resolve) => {
      // Send message to MAIN world api-interceptor (uses payload wrapper)
      window.postMessage({
        type: 'GFLOW_SUBMIT_PROMPT',
        payload: {
          prompt: promptText
        },
        timestamp: Date.now()
      }, '*');

      // Listen for result with timeout
      const timeout = setTimeout(() => {
        resolve(false);
      }, 10000);

      function onResult(event) {
        if (event.data?.type === 'GFLOW_SUBMIT_RESULT') {
          clearTimeout(timeout);
          window.removeEventListener('message', onResult);
          // api-interceptor wraps result in payload
          const payload = event.data.payload || event.data;
          resolve(payload.success || false);
        }
      }
      window.addEventListener('message', onResult);
    });
  }

  /* ============================================================
     MAIN PROMPT PROCESSING
     ============================================================ */

  async function processPrompt(prompt, index, runId, promptSettings) {
    if (isStopped || runId !== currentRunId) return;

    settings = promptSettings || settings;
    isProcessing = true;
    addLog(`Processing prompt ${index + 1}: "${prompt.substring(0, 60)}..."`, 'info');

    // Determine submission path
    const submitPath = settings.submitPath || 'dom_first';

    if (submitPath === 'api_first' || submitPath === 'api_only') {
      // Try API submission first
      addLog('Attempting API submission...', 'info');
      const apiSuccess = await submitViaAPI(prompt);

      if (apiSuccess) {
        addLog('Prompt submitted via API.', 'success');
        // Wait for generation to complete
        await waitForGenerationComplete();
        reportPromptDone(index, runId);
        return;
      }

      if (submitPath === 'api_only') {
        addLog('API submission failed and mode is API-only.', 'error');
        reportPromptError(index, runId, 'API submission failed');
        return;
      }

      addLog('API submission failed, falling back to DOM...', 'warn');
    }

    // DOM-based submission (dom_first or fallback from api_first)
    await processDOMSubmission(prompt, index, runId);
  }

  /**
   * Process prompt via DOM automation (typing + button click).
   */
  async function processDOMSubmission(prompt, index, runId) {
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
      reportPromptError(index, runId, 'Prompt input element not found');
      return;
    }

    addLog('Input element found.', 'success');

    // Check if paused
    if (isPaused) {
      addLog('Paused before typing.', 'info');
      await waitForUnpause();
      if (isStopped || runId !== currentRunId) return;
    }

    // Clear input thoroughly before typing new prompt
    // This prevents prompt accumulation (old prompts leaking into new ones)
    addLog(`Clearing input before prompt ${index + 1}...`, 'info');
    focusPromptInput(inputEl);
    clearPromptInput(inputEl);
    await sleep(300);
    // Verify input is empty
    const isContentEditable = inputEl.getAttribute('contenteditable') === 'true' ||
                               inputEl.getAttribute('contenteditable') === '';
    if (isContentEditable) {
      const leftover = (inputEl.textContent || '').trim();
      if (leftover.length > 0) {
        addLog(`Input not empty after clear ("${leftover.substring(0, 30)}..."), force clearing.`, 'warn');
        inputEl.innerHTML = '';
        await sleep(100);
        clearPromptInput(inputEl);
        await sleep(200);
      }
    }
    focusPromptInput(inputEl);
    await sleep(200);

    addLog(`Typing prompt ${index + 1}: "${prompt.substring(0, 50)}..."`, 'info');
    const typingDelay = settings.typingDelayMs || 20;
    await simulateTyping(inputEl, prompt, typingDelay);
    addLog('Prompt typed.', 'success');

    await sleep(300);

    // Check pause again
    if (isPaused) {
      await waitForUnpause();
      if (isStopped || runId !== currentRunId) return;
    }

    // Submit
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
        focusPromptInput(inputEl);
        await sleep(300);
      }
    }

    if (submitted) {
      addLog('Prompt submitted successfully.', 'success');
    } else {
      addLog('Prompt submission may have failed.', 'warn');
    }

    // Wait for generation to start
    addLog('Waiting for generation to start...', 'info');
    const generationStarted = await waitForGenerationStart(15000);

    if (!generationStarted) {
      addLog('Generation did not start — retrying submit...', 'warn');
      focusPromptInput(inputEl);
      await sleep(500);
      await submitPrompt(inputEl, submitMethod, settings.customSubmitSelectors || []);
      await sleep(1000);
      const retryStarted = await waitForGenerationStart(10000);
      if (!retryStarted) {
        addLog('Generation still not detected after retry.', 'error');
      }
    }

    // Wait for generation to complete
    await waitForGenerationComplete();
    reportPromptDone(index, runId);
  }

  /**
   * Wait for generation to complete (page to settle).
   */
  async function waitForGenerationComplete() {
    const detectionStrategy = settings.detectionStrategy || 'hybrid';
    const waitTime = settings.intraPromptGapMs || 3000;
    addLog('Waiting for generation to complete...', 'info');
    await waitForReadyState(waitTime, detectionStrategy);
  }

  /**
   * Report prompt completion to background.
   */
  function reportPromptDone(index, runId) {
    isProcessing = false;
    chrome.runtime.sendMessage({
      action: 'PROMPT_DONE',
      index: index,
      runId: runId
    });
  }

  /**
   * Report prompt error to background.
   */
  function reportPromptError(index, runId, error) {
    isProcessing = false;
    chrome.runtime.sendMessage({
      action: 'PROMPT_ERROR',
      index: index,
      runId: runId,
      error: error
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
    mutationObserver = new MutationObserver(() => {
      // Silent observation — used by waitForReadyState
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
        addLog('Automation stopped.', 'info');
        sendResponse({ ok: true });
        break;

      case 'SKIP':
        if (isProcessing) {
          isStopped = true;
          setTimeout(() => { isStopped = false; }, 500);
        }
        addLog('Skipping current prompt.', 'info');
        sendResponse({ ok: true });
        break;

      case 'FIND_INPUT': {
        const el = findPromptInput(msg.customSelectors || []);
        sendResponse({ found: !!el, tagName: el ? el.tagName : null });
        break;
      }

      case 'CONFIGURE_FLOW':
        configureFlow(msg.config || {}).then((results) => {
          sendResponse({ ok: true, results: results });
        });
        return true; // Keep channel open for async

      case 'TOGGLE_PANEL':
        // Handled by panel.js
        if (typeof togglePanel === 'function') {
          togglePanel();
        }
        sendResponse({ ok: true });
        break;

      case 'PING':
        sendResponse({ ok: true, ready: true, hasAuth: !!capturedAuthContext });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }

    return true;
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
    }
  });

  /* ============================================================
     STORAGE CHANGE LISTENER
     ============================================================ */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Panel handles its own UI updates via storage.onChanged
    // Content.js just needs to track settings changes
    if (changes.settings?.newValue) {
      settings = changes.settings.newValue;
    }
  });

})();
