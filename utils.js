/**
 * utils.js — Shared helper functions for Google Flow Prompt Automation
 * Injected alongside content.js on matching pages.
 */

/* ============================================================
   PROMPT PARSING
   ============================================================ */

/**
 * Parse a raw text file into an array of prompt strings.
 * @param {string} text - Raw file contents
 * @param {string} mode - 'line' or 'paragraph'
 * @returns {string[]} Array of non-empty, non-comment prompts
 */
function parsePrompts(text, mode) {
  if (!text || typeof text !== 'string') return [];

  let raw = [];

  if (mode === 'line') {
    raw = text.split(/\n/);
  } else {
    // paragraph mode — split on one or more blank lines
    raw = text.split(/\n\s*\n/);
  }

  return raw
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !p.startsWith('#'));
}

/* ============================================================
   DOM ELEMENT DETECTION
   ============================================================ */

/**
 * Check if an element is visible and interactable.
 */
function isElementVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

/**
 * Find the prompt input element using a cascade of selectors.
 * @param {string[]} customSelectors - User-defined selectors from options
 * @returns {HTMLElement|null}
 */
function findPromptInput(customSelectors) {
  const selectors = [
    ...(customSelectors || []),
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[type="text"]',
    '.prompt-input',
    '[data-placeholder]',
    '[aria-label*="prompt" i]',
    '[aria-label*="describe" i]',
    '[placeholder*="prompt" i]',
    '[placeholder*="describe" i]',
    '[placeholder*="type" i]',
    '[placeholder*="enter" i]'
  ];

  for (const selector of selectors) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (isElementVisible(el)) return el;
      }
    } catch (e) {
      // Invalid selector — skip
    }
  }

  // Broad fallback: any editable element near the bottom half of the viewport
  const allEditable = document.querySelectorAll(
    'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'
  );
  for (const el of allEditable) {
    if (isElementVisible(el)) return el;
  }

  return null;
}

/**
 * Find the submit / generate button using a cascade of selectors.
 * @param {string[]} customSelectors - User-defined selectors from options
 * @returns {HTMLElement|null}
 */
function findSubmitButton(customSelectors) {
  // === PRIORITY 1: Google Flow / positional detection ===
  // On Google Flow, the → arrow button has no aria-label or distinctive text.
  // We MUST detect it by position (rightmost in input bar) BEFORE generic selectors,
  // because the generic selectors match the + (add/create) button incorrectly.
  const promptInput = findPromptInput([]);
  if (promptInput) {
    const inputRect = promptInput.getBoundingClientRect();
    const allCandidates = [];

    // Walk up from the input to find the full input bar container
    let container = promptInput.parentElement;
    for (let i = 0; i < 8 && container; i++) {
      container = container.parentElement;
    }
    if (!container) container = document.body;

    const btns = container.querySelectorAll('button, [role="button"]');
    for (const btn of btns) {
      if (btn !== promptInput && isElementVisible(btn) && !btn.disabled) {
        const rect = btn.getBoundingClientRect();
        // Only buttons in the same vertical band as the input (same row)
        if (Math.abs(rect.top - inputRect.top) < 80) {
          allCandidates.push(btn);
        }
      }
    }

    // Debug: log all candidates found near the input
    for (const btn of allCandidates) {
      const rect = btn.getBoundingClientRect();
      const hasSvg = btn.querySelector('svg') !== null;
      const text = (btn.textContent || '').trim().substring(0, 30);
      addLog(`[Submit debug] text="${text}" svg=${hasSvg} right=${Math.round(rect.right)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`, 'info');
    }

    if (allCandidates.length > 1) {
      // Multiple buttons near the input — use smart detection

      // Strategy A: Circular button with SVG (the → arrow icon)
      const svgCircular = allCandidates.filter(btn => {
        const rect = btn.getBoundingClientRect();
        const hasSvg = btn.querySelector('svg') !== null;
        const isCircular = Math.abs(rect.width - rect.height) < 12 && rect.width > 20 && rect.width < 80;
        return hasSvg && isCircular;
      });
      if (svgCircular.length > 0) {
        const best = svgCircular.reduce((a, b) =>
          a.getBoundingClientRect().right > b.getBoundingClientRect().right ? a : b
        );
        addLog(`[Submit] Strategy A: circular SVG button.`, 'success');
        return best;
      }

      // Strategy B: Rightmost button that does NOT contain text like "add", "+", "create", model names
      const submitCandidates = allCandidates.filter(btn => {
        const text = (btn.textContent || '').toLowerCase().trim();
        // Skip buttons that are clearly NOT the submit arrow
        const isPlus = text === '+' || text === 'add' || text.includes('add_');
        const isMenu = btn.getAttribute('aria-haspopup') === 'menu';
        const hasLongText = text.length > 5; // The → arrow has no/minimal text
        return !isPlus && !isMenu && !hasLongText;
      });
      if (submitCandidates.length > 0) {
        const best = submitCandidates.reduce((a, b) =>
          a.getBoundingClientRect().right > b.getBoundingClientRect().right ? a : b
        );
        addLog(`[Submit] Strategy B: rightmost minimal-text button.`, 'success');
        return best;
      }

      // Strategy C: Just pick the absolute rightmost button
      const rightmost = allCandidates.reduce((a, b) =>
        a.getBoundingClientRect().right > b.getBoundingClientRect().right ? a : b
      );
      addLog(`[Submit] Strategy C: absolute rightmost button.`, 'success');
      return rightmost;
    } else if (allCandidates.length === 1) {
      addLog(`[Submit] Only one button near input.`, 'success');
      return allCandidates[0];
    }
  }

  // === PRIORITY 2: Generic selectors (for non-Flow sites) ===
  const selectors = [
    ...(customSelectors || []),
    'button[type="submit"]',
    'button[aria-label*="generate" i]',
    'button[aria-label*="submit" i]',
    'button[aria-label*="send" i]',
    '[role="button"][aria-label*="generate" i]',
    '[role="button"][aria-label*="send" i]',
    'button[aria-label*="run" i]',
    'button[data-tooltip*="generate" i]',
    'button[data-tooltip*="run" i]'
  ];

  for (const selector of selectors) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (isElementVisible(el) && !el.disabled) return el;
      }
    } catch (e) {
      // Invalid selector — skip
    }
  }

  // Heuristic: scan all visible buttons for text matching common submit words
  // NOTE: "create" removed — it matches the + (add/create) button on Flow
  const keywords = ['generate', 'submit', 'send'];
  const buttons = document.querySelectorAll('button, [role="button"]');
  for (const btn of buttons) {
    const text = (btn.textContent || '').toLowerCase().trim();
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    const title = (btn.getAttribute('title') || '').toLowerCase();
    const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
    const combined = text + ' ' + ariaLabel + ' ' + title + ' ' + tooltip;
    for (const kw of keywords) {
      if (combined.includes(kw) && isElementVisible(btn) && !btn.disabled) {
        return btn;
      }
    }
  }

  return null;
}

/* ============================================================
   VALUE SETTING & EVENT DISPATCH
   ============================================================ */

/**
 * Dispatch a sequence of standard events on an element.
 */
function dispatchInputEvents(el) {
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

/**
 * Set the value of an input/textarea using the native setter to bypass React/framework wrappers.
 */
function setNativeValue(el, value) {
  const tagName = el.tagName.toLowerCase();
  const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                             el.getAttribute('contenteditable') === '';

  if (isContentEditable) {
    el.focus();
    // Use execCommand to properly notify the framework of the new value
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    if (value) {
      document.execCommand('insertText', false, value);
    }
    dispatchInputEvents(el);
  } else if (tagName === 'textarea' || tagName === 'input') {
    // Use native setter to bypass React's synthetic event system
    const nativeSetter =
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
    dispatchInputEvents(el);
  } else {
    // Generic fallback
    if ('value' in el) {
      el.value = value;
    } else {
      el.textContent = value;
    }
    dispatchInputEvents(el);
  }
}

/**
 * Focus the prompt input element.
 */
function focusPromptInput(el) {
  if (!el) return;
  el.focus();
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

/**
 * Clear the prompt input element.
 */
function clearPromptInput(el) {
  if (!el) return;
  focusPromptInput(el);

  const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                             el.getAttribute('contenteditable') === '';

  if (isContentEditable) {
    // Use execCommand to clear — this properly notifies the framework
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  } else {
    setNativeValue(el, '');
  }
  dispatchInputEvents(el);
}

/* ============================================================
   TYPING SIMULATION
   ============================================================ */

/**
 * Simulate realistic typing character by character.
 * @param {HTMLElement} el - Target input element
 * @param {string} text - Text to type
 * @param {number} delayMs - Delay between characters in ms
 * @returns {Promise<void>}
 */
function simulateTyping(el, text, delayMs) {
  return new Promise((resolve) => {
    focusPromptInput(el);
    clearPromptInput(el);

    const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                               el.getAttribute('contenteditable') === '';

    if (isContentEditable) {
      // For contenteditable: use execCommand('insertText') which properly
      // triggers the framework's internal input handling (React, Lit, etc.)
      // This is the ONLY reliable way to make frameworks see the value.
      document.execCommand('insertText', false, text);

      // Also dispatch input event for good measure
      el.dispatchEvent(new InputEvent('input', {
        data: text, inputType: 'insertText',
        bubbles: true, cancelable: true
      }));

      addLog(`Used execCommand to insert text (${text.length} chars)`, 'info');
      resolve();
      return;
    }

    // For textarea/input: use native setter + character-by-character typing
    let currentText = '';
    let i = 0;

    function typeNext() {
      if (i >= text.length) {
        resolve();
        return;
      }

      const char = text[i];
      currentText += char;

      // Dispatch keydown
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: char, code: 'Key' + char.toUpperCase(),
        charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0),
        bubbles: true, cancelable: true
      }));

      // Set value using native setter
      const nativeSetter =
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, currentText);
      } else {
        el.value = currentText;
      }

      // Dispatch input event
      el.dispatchEvent(new InputEvent('input', {
        data: char, inputType: 'insertText',
        bubbles: true, cancelable: true
      }));

      // Dispatch keyup
      el.dispatchEvent(new KeyboardEvent('keyup', {
        key: char, code: 'Key' + char.toUpperCase(),
        charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0),
        bubbles: true, cancelable: true
      }));

      i++;
      const jitter = Math.floor(Math.random() * delayMs * 0.5);
      setTimeout(typeNext, delayMs + jitter);
    }

    typeNext();
  });
}

/* ============================================================
   SUBMISSION
   ============================================================ */

/**
 * Submit via Enter key simulation on the input element.
 * Tries multiple Enter dispatch strategies for maximum compatibility.
 */
function submitViaEnter(el) {
  const enterProps = {
    key: 'Enter', code: 'Enter',
    keyCode: 13, which: 13, charCode: 13,
    bubbles: true, cancelable: true
  };

  // Dispatch on the input element — bubbles:true lets parent frameworks catch it
  el.dispatchEvent(new KeyboardEvent('keydown', enterProps));
  el.dispatchEvent(new KeyboardEvent('keypress', enterProps));
  el.dispatchEvent(new KeyboardEvent('keyup', enterProps));
}

/**
 * Submit via clicking the submit/generate button.
 * Tries real click, then MouseEvent dispatch, then pointer events.
 * @param {string[]} customSelectors
 * @returns {boolean} Whether a button was found and clicked
 */
function submitViaButton(customSelectors) {
  const btn = findSubmitButton(customSelectors);
  if (btn) {
    // Log what button we found for debugging
    const btnInfo = btn.getAttribute('aria-label') || btn.textContent?.trim().substring(0, 30) || btn.tagName;
    addLog(`Found submit button: "${btnInfo}"`, 'info');

    // Use native click — simplest and most reliable
    btn.click();

    addLog('Clicked generate/submit button.', 'success');
    return true;
  }
  addLog('No submit button found.', 'warn');
  return false;
}

/**
 * Attempt to submit the current prompt.
 * Auto mode tries BUTTON CLICK FIRST (more reliable for Google Flow), then Enter.
 * @param {HTMLElement} el - The prompt input element
 * @param {string} method - 'enter', 'button', or 'auto'
 * @param {string[]} customSubmitSelectors
 * @returns {Promise<boolean>} Whether submission appeared to succeed
 */
function submitPrompt(el, method, customSubmitSelectors) {
  return new Promise((resolve) => {
    if (method === 'enter') {
      submitViaEnter(el);
      resolve(true);
    } else if (method === 'button') {
      const clicked = submitViaButton(customSubmitSelectors);
      resolve(clicked);
    } else {
      // Auto: try BUTTON CLICK first (Google Flow uses a generate button)
      const clicked = submitViaButton(customSubmitSelectors);
      if (clicked) {
        resolve(true);
      } else {
        // Fallback to Enter key simulation
        addLog('No button found, falling back to Enter key...', 'info');
        submitViaEnter(el);

        // Wait 1.5s to check if Enter worked
        setTimeout(() => {
          resolve(true);
        }, 1500);
      }
    }
  });
}

/* ============================================================
   GENERATION DETECTION
   ============================================================ */

/**
 * Check if the page appears to be actively generating (loading indicators, busy states).
 */
function detectGenerationActivity() {
  // Check aria-busy
  const busyEls = document.querySelectorAll('[aria-busy="true"]');
  if (busyEls.length > 0) return true;

  // Check for common loading indicators
  const loadingSelectors = [
    '.loading', '.spinner', '[class*="loading"]', '[class*="spinner"]',
    '[class*="progress"]', '[role="progressbar"]',
    '[class*="generating"]', '[class*="pending"]'
  ];
  for (const sel of loadingSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (isElementVisible(el)) return true;
      }
    } catch (e) { /* skip */ }
  }

  // Check if submit button is disabled (indicating processing)
  const submitBtn = findSubmitButton([]);
  if (submitBtn && submitBtn.disabled) return true;

  return false;
}

/**
 * Wait until generation has started after clicking submit.
 * Detects: prompt input cleared, loading indicators, new DOM elements appearing,
 * or the prompt input becoming empty (Flow clears it after accepting).
 * @param {number} timeoutMs - Max time to wait for generation to start (default 10s)
 * @returns {Promise<boolean>} true if generation detected, false if timed out
 */
function waitForGenerationStart(timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  return new Promise((resolve) => {
    const startTime = Date.now();
    const startImageCount = getImageCountIfPossible();

    // Snapshot the current prompt input value
    const promptInput = findPromptInput([]);
    const startInputText = promptInput ? (promptInput.textContent || promptInput.value || '').trim() : '';

    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;

      // 1. Check if prompt input was cleared (Flow clears it after accepting)
      if (promptInput) {
        const currentText = (promptInput.textContent || promptInput.value || '').trim();
        if (startInputText.length > 0 && currentText.length === 0) {
          clearInterval(checkInterval);
          addLog('Generation detected: prompt input was cleared.', 'success');
          resolve(true);
          return;
        }
        // Also check if input text changed significantly (replaced with new placeholder etc.)
        if (startInputText.length > 10 && currentText !== startInputText && currentText.length < startInputText.length / 2) {
          clearInterval(checkInterval);
          addLog('Generation detected: prompt input content changed.', 'success');
          resolve(true);
          return;
        }
      }

      // 2. Check for loading/generation activity
      if (detectGenerationActivity()) {
        clearInterval(checkInterval);
        addLog('Generation detected: loading indicators found.', 'success');
        resolve(true);
        return;
      }

      // 3. Check if new images appeared
      const currentImageCount = getImageCountIfPossible();
      if (currentImageCount > startImageCount) {
        clearInterval(checkInterval);
        addLog('Generation detected: new images appeared.', 'success');
        resolve(true);
        return;
      }

      // 4. Timeout
      if (elapsed >= timeoutMs) {
        clearInterval(checkInterval);
        addLog('Generation start detection timed out — proceeding anyway.', 'warn');
        resolve(false);
        return;
      }
    }, 300);
  });
}

/**
 * Try to count image tiles on the page (for detecting new generations).
 */
function getImageCountIfPossible() {
  const imageSelectors = [
    'img[src*="generated"]', 'img[class*="result"]',
    '[class*="image-tile"]', '[class*="image-card"]',
    '[class*="generated-image"]', '[role="img"]'
  ];
  let count = 0;
  for (const sel of imageSelectors) {
    try {
      count += document.querySelectorAll(sel).length;
    } catch (e) { /* skip */ }
  }
  // Fallback: count all non-tiny images
  if (count === 0) {
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 64 && rect.height > 64) count++;
    }
  }
  return count;
}

/**
 * Wait for the page to be ready for the next prompt.
 * @param {number} timeoutMs - Max time to wait
 * @param {string} strategy - 'dom', 'timing', or 'hybrid'
 * @returns {Promise<void>}
 */
function waitForReadyState(timeoutMs, strategy) {
  return new Promise((resolve) => {
    if (strategy === 'timing') {
      setTimeout(resolve, timeoutMs);
      return;
    }

    const startTime = Date.now();
    let settled = false;
    let observer = null;
    let lastMutationTime = Date.now();
    let checkInterval = null;

    function cleanup() {
      if (observer) { observer.disconnect(); observer = null; }
      if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
    }

    function done() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    // For 'dom' and 'hybrid': watch for mutations to settle
    observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
    });

    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, characterData: true
    });

    // Check periodically if mutations have settled (no change for 2s)
    checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const sinceLastMutation = Date.now() - lastMutationTime;

      // If no mutations for 2 seconds, consider ready
      if (sinceLastMutation > 2000 && !detectGenerationActivity()) {
        done();
        return;
      }

      // Timeout fallback
      if (elapsed >= timeoutMs) {
        done();
        return;
      }
    }, 500);

    // Hard timeout
    setTimeout(done, timeoutMs);
  });
}

/* ============================================================
   LOGGING HELPER
   ============================================================ */

/**
 * Add a log entry and store it.
 * @param {string} message
 * @param {string} level - 'info', 'warn', 'error', 'success'
 */
function addLog(message, level) {
  const entry = {
    timestamp: new Date().toISOString(),
    message: message,
    level: level || 'info'
  };
  console.log(`[FlowAuto] [${entry.level.toUpperCase()}] ${entry.message}`);

  // Store log via messaging to background
  try {
    chrome.runtime.sendMessage({ action: 'ADD_LOG', log: entry });
  } catch (e) {
    // Extension context may be invalidated
  }
}
