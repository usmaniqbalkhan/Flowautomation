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
  const selectors = [
    ...(customSelectors || []),
    'button[type="submit"]',
    'button[aria-label*="generate" i]',
    'button[aria-label*="submit" i]',
    'button[aria-label*="send" i]',
    'button[aria-label*="create" i]',
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
  const keywords = ['generate', 'submit', 'send', 'create'];
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

  // Google Flow specific: find the submit arrow button next to the prompt input
  // The submit button is the LAST button inside the same container as the prompt input
  // (the → arrow button at the right side of the input bar)
  const promptInput = findPromptInput([]);
  if (promptInput) {
    // Walk up only 2-3 levels (stay within the input bar container, don't go too high)
    let container = promptInput.parentElement;
    for (let i = 0; i < 3 && container; i++) {
      const btns = container.querySelectorAll('button, [role="button"]');
      if (btns.length > 0) {
        // Get all visible, enabled buttons in this container
        const candidates = Array.from(btns).filter(
          btn => btn !== promptInput && isElementVisible(btn) && !btn.disabled
        );

        if (candidates.length > 0) {
          // Pick the LAST (rightmost) button — on Flow this is the submit arrow →
          // Exclude buttons that look like navigation (back arrows, close buttons)
          const safeButtons = candidates.filter(btn => {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const text = (btn.textContent || '').toLowerCase().trim();
            // Skip buttons that are clearly navigation/menu
            return !label.includes('back') && !label.includes('close') &&
                   !label.includes('menu') && !label.includes('search') &&
                   !text.includes('back') && text !== '+';
          });

          if (safeButtons.length > 0) {
            return safeButtons[safeButtons.length - 1];
          }
        }
      }
      container = container.parentElement;
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
    el.innerHTML = '';
    el.textContent = value;
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
    el.innerHTML = '';
    el.textContent = '';
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

      // Dispatch keypress
      el.dispatchEvent(new KeyboardEvent('keypress', {
        key: char, code: 'Key' + char.toUpperCase(),
        charCode: char.charCodeAt(0), keyCode: char.charCodeAt(0),
        bubbles: true, cancelable: true
      }));

      // Set value
      if (isContentEditable) {
        el.textContent = currentText;
      } else {
        const nativeSetter =
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set ||
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, currentText);
        } else {
          el.value = currentText;
        }
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
      // Add slight randomness to typing delay for realism
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
