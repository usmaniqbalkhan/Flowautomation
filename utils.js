/**
 * utils.js — Shared helper functions for Google Flow Prompt Automation
 * Injected alongside content.js on matching pages.
 */

/* ============================================================
   PROMPT PARSING
   ============================================================ */

/**
 * Parse a raw text file into an array of prompt strings.
 * Auto-detects numbered prompts and strips numbering prefixes.
 *
 * Supported numbering formats:
 *   1. prompt text        1) prompt text       1 - prompt text
 *   2. prompt text        2) prompt text       2 - prompt text
 *   (also works with multi-line prompts after a number header)
 *
 * @param {string} text - Raw file contents
 * @param {string} mode - 'line', 'paragraph', or 'auto' (default)
 * @returns {string[]} Array of non-empty, non-comment, number-stripped prompts
 */
function parsePrompts(text, mode) {
  if (!text || typeof text !== 'string') return [];

  // First, try to detect numbered prompts regardless of mode
  const numberedResult = parseNumberedPrompts(text);
  if (numberedResult.length > 0) {
    return numberedResult;
  }

  // Fallback: simple split by mode
  let raw = [];

  if (mode === 'paragraph') {
    // paragraph mode — split on one or more blank lines
    raw = text.split(/\n\s*\n/);
  } else {
    // line mode (default)
    raw = text.split(/\n/);
  }

  return raw
    .map(p => stripNumberPrefix(p.trim()))
    .filter(p => p.length > 0)
    .filter(p => !p.startsWith('#'));
}

/**
 * Detect and parse numbered prompts from text.
 * Handles cases where a numbered prompt spans multiple lines until the next number.
 *
 * @param {string} text - Raw text
 * @returns {string[]} Array of prompts (empty if no numbered pattern detected)
 */
function parseNumberedPrompts(text) {
  const lines = text.split(/\n/);

  // Regex to detect a line starting with a number prefix:
  // "1. ", "1) ", "1 - ", "1: ", "01. ", etc.
  const numberPrefixRegex = /^\s*(\d{1,4})\s*[.):\-]\s*/;

  // First pass: check if the text has numbered prompts (need at least 2)
  let numberedLineCount = 0;
  let lastNum = 0;
  for (const line of lines) {
    const match = line.match(numberPrefixRegex);
    if (match) {
      const num = parseInt(match[1], 10);
      // Check for sequential or near-sequential numbering
      if (num > lastNum || num === 1) {
        numberedLineCount++;
        lastNum = num;
      }
    }
  }

  // Need at least 2 numbered lines to consider this a numbered format
  if (numberedLineCount < 2) return [];

  // Second pass: split into prompts at each numbered line
  const prompts = [];
  let currentPrompt = '';

  for (const line of lines) {
    const match = line.match(numberPrefixRegex);
    if (match) {
      // Save previous prompt if exists
      if (currentPrompt.trim().length > 0) {
        prompts.push(currentPrompt.trim());
      }
      // Start new prompt with the number prefix stripped
      currentPrompt = line.replace(numberPrefixRegex, '');
    } else {
      // Continuation line — append to current prompt
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('#')) {
        if (currentPrompt.length > 0) {
          currentPrompt += ' ' + trimmed;
        } else {
          currentPrompt = trimmed;
        }
      }
    }
  }

  // Don't forget the last prompt
  if (currentPrompt.trim().length > 0) {
    prompts.push(currentPrompt.trim());
  }

  return prompts.filter(p => p.length > 0);
}

/**
 * Strip common numbering prefixes from a single line.
 * E.g., "1. prompt text" -> "prompt text"
 *       "42) prompt text" -> "prompt text"
 *       "3 - prompt text" -> "prompt text"
 *
 * @param {string} line - A single prompt line
 * @returns {string} The line with any leading number prefix removed
 */
function stripNumberPrefix(line) {
  if (!line) return '';
  return line.replace(/^\s*\d{1,4}\s*[.):\-]\s*/, '').trim();
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
 * Check if an element is inside the extension's panel (must be excluded from DOM detection).
 */
function isInsidePanel(el) {
  return el && el.closest && el.closest('#gflow-panel, #gflow-panel-toggle');
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
        if (isElementVisible(el) && !isInsidePanel(el)) return el;
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
    if (isElementVisible(el) && !isInsidePanel(el)) return el;
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
      if (btn !== promptInput && isElementVisible(btn) && !btn.disabled && !isInsidePanel(btn)) {
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
        if (isElementVisible(el) && !el.disabled && !isInsidePanel(el)) return el;
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
    if (isInsidePanel(btn)) continue;
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
    // Clear with beforeinput/input events for React
    document.execCommand('selectAll', false, null);
    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true
    }));
    document.execCommand('delete', false, null);
    el.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward', bubbles: true, cancelable: false, composed: true
    }));
    if (value) {
      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: value, bubbles: true, cancelable: true, composed: true
      }));
      document.execCommand('insertText', false, value);
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: value, bubbles: true, cancelable: false, composed: true
      }));
    }
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
 * Clear the prompt input element completely.
 * Uses multiple strategies to ensure contenteditable is truly empty,
 * preventing prompt accumulation across submissions.
 */
function clearPromptInput(el) {
  if (!el) return;
  focusPromptInput(el);

  const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                             el.getAttribute('contenteditable') === '';

  if (isContentEditable) {
    // Strategy 1: Select all via execCommand and delete
    document.execCommand('selectAll', false, null);

    el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      bubbles: true, cancelable: true, composed: true
    }));

    document.execCommand('delete', false, null);

    el.dispatchEvent(new InputEvent('input', {
      inputType: 'deleteContentBackward',
      bubbles: true, cancelable: false, composed: true
    }));

    // Strategy 2: If text still remains, force-clear via Selection API
    const remainingText = (el.textContent || '').trim();
    if (remainingText.length > 0) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true, cancelable: true, composed: true
      }));

      document.execCommand('delete', false, null);

      el.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true, cancelable: false, composed: true
      }));
    }

    // Strategy 3: If STILL not empty, nuke the innerHTML directly
    // and fire synthetic events to force React to sync
    if ((el.textContent || '').trim().length > 0) {
      el.innerHTML = '';
      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true, cancelable: true, composed: true
      }));
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true, cancelable: false, composed: true
      }));
    }
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
  return new Promise(async (resolve) => {
    const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                               el.getAttribute('contenteditable') === '';

    // CRITICAL: Fully clear input before typing new prompt.
    // Call clear multiple times with small delays to ensure React state syncs.
    focusPromptInput(el);
    clearPromptInput(el);
    await new Promise(r => setTimeout(r, 100));

    // Verify the input is actually empty
    if (isContentEditable) {
      const remaining = (el.textContent || '').trim();
      if (remaining.length > 0) {
        addLog(`Input still has text after clear: "${remaining.substring(0, 30)}..." — force clearing.`, 'warn');
        // Force clear again
        el.innerHTML = '';
        focusPromptInput(el);
        clearPromptInput(el);
        await new Promise(r => setTimeout(r, 100));
      }
    }

    if (isContentEditable) {
      // For contenteditable (React/Next.js apps like Google Flow):
      // We must type character-by-character with proper beforeinput/input
      // events so React's Input Events Level 2 handling picks up each change.

      // Find the actual text target — often a <p> inside the contenteditable
      let textTarget = el.querySelector('p') || el;

      // Place cursor at START of the text target (not end — we just cleared it)
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(textTarget);
      range.collapse(true); // collapse to START
      selection.removeAllRanges();
      selection.addRange(range);

      // Type character by character with beforeinput + input events
      // Use small chunks (5 chars) for speed while maintaining React compatibility
      const chunkSize = 5;
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.substring(i, Math.min(i + chunkSize, text.length));

        // beforeinput — React uses this to know text is about to change
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: chunk,
          bubbles: true,
          cancelable: true,
          composed: true
        }));

        // Actually insert the text using execCommand (updates the DOM)
        document.execCommand('insertText', false, chunk);

        // input — React uses this to read the new value from the DOM
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: chunk,
          bubbles: true,
          cancelable: false,
          composed: true
        }));

        // Small delay every few chunks to let React process
        if (i % 20 === 0 && i > 0) {
          await new Promise(r => setTimeout(r, 10));
        }
      }

      addLog(`Typed ${text.length} chars into contenteditable (cleared first).`, 'info');
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
      // Auto: try BOTH Enter and button click for maximum reliability.
      // Enter key is tried first since it goes through the same React event
      // pipeline as real user input, which helps when React state is involved.
      const isContentEditable = el.getAttribute('contenteditable') === 'true' ||
                                 el.getAttribute('contenteditable') === '';
      if (isContentEditable) {
        // For contenteditable: Enter first (React handles it natively)
        addLog('Contenteditable detected — submitting via Enter key...', 'info');
        submitViaEnter(el);
        // Also click button after small delay as backup
        setTimeout(() => {
          submitViaButton(customSubmitSelectors);
        }, 300);
        setTimeout(() => {
          resolve(true);
        }, 500);
      } else {
        // For regular inputs: button first, then Enter fallback
        const clicked = submitViaButton(customSubmitSelectors);
        if (clicked) {
          resolve(true);
        } else {
          addLog('No button found, falling back to Enter key...', 'info');
          submitViaEnter(el);
          setTimeout(() => {
            resolve(true);
          }, 1500);
        }
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
