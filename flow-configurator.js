/**
 * flow-configurator.js — Auto-configure Google Flow's native UI settings.
 * Handles: new project creation, zoom, model/ratio/image count selection.
 * Injected as content script alongside utils.js and content.js.
 */

/* ============================================================
   FLOW UI CONFIGURATION
   ============================================================ */

/**
 * Wait for an element to appear in the DOM.
 * @param {string} selector - CSS selector
 * @param {number} timeoutMs - Max wait time
 * @returns {Promise<HTMLElement|null>}
 */
function waitForElement(selector, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  return new Promise((resolve) => {
    const el = document.querySelector(selector);
    if (el && isElementVisible(el)) {
      resolve(el);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el && isElementVisible(el)) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(document.querySelector(selector));
    }, timeoutMs);
  });
}

/**
 * Click an element and wait for UI to update.
 */
async function clickAndWait(el, waitMs) {
  if (!el) return false;
  el.click();
  await new Promise(r => setTimeout(r, waitMs || 500));
  return true;
}

/**
 * Find a button/option by its text content.
 * @param {string} containerSelector - Where to look
 * @param {string} text - Text to match (case-insensitive)
 * @returns {HTMLElement|null}
 */
function findByText(containerSelector, text) {
  const container = containerSelector ? document.querySelector(containerSelector) : document.body;
  if (!container) return null;

  const candidates = container.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], li, div[tabindex], span[tabindex]');
  const lowerText = text.toLowerCase();

  for (const el of candidates) {
    const elText = (el.textContent || '').trim().toLowerCase();
    if (elText === lowerText || elText.includes(lowerText)) {
      if (isElementVisible(el)) return el;
    }
  }
  return null;
}

/**
 * Auto zoom out the browser window for better overview.
 * @param {number} zoomLevel - Zoom level (e.g., 0.8 for 80%)
 */
function autoZoomOut(zoomLevel) {
  zoomLevel = zoomLevel || 0.8;
  document.body.style.zoom = String(zoomLevel);
  addLog(`Zoomed page to ${Math.round(zoomLevel * 100)}%`, 'info');
}

/**
 * Reset zoom to default.
 */
function resetZoom() {
  document.body.style.zoom = '1';
}

/**
 * Create a new Flow project by navigating to the new project URL.
 * @returns {Promise<boolean>}
 */
async function createNewProject() {
  try {
    // Check if we're already on a project page
    const currentUrl = window.location.href;
    if (currentUrl.includes('/flow/project/')) {
      addLog('Already on a Flow project page.', 'info');
      return true;
    }

    // Try clicking the "+" new project button if visible
    const newBtn = document.querySelector('[aria-label*="new" i], [aria-label*="create" i]');
    if (newBtn && isElementVisible(newBtn)) {
      newBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      if (window.location.href.includes('/flow/project/')) {
        addLog('Created new project via button click.', 'success');
        return true;
      }
    }

    // Navigate to new project URL
    window.location.href = 'https://labs.google/fx/tools/flow';
    addLog('Navigating to Flow page...', 'info');
    return true;
  } catch (e) {
    addLog('Failed to create new project: ' + e.message, 'error');
    return false;
  }
}

/**
 * Configure the number of images per generation.
 * Flow shows this as "x3" or "x4" near the prompt bar.
 * @param {number} count - Number of images (1-4)
 * @returns {Promise<boolean>}
 */
async function configureImageCount(count) {
  try {
    // Look for the image count selector near the prompt bar
    // It typically shows as "x3" or similar, or as a dropdown/button with a number
    const countSelectors = [
      '[class*="count"]',
      '[class*="batch"]',
      '[class*="num"]',
      '[aria-label*="image" i][aria-label*="count" i]',
      '[aria-label*="number" i]'
    ];

    // Also try finding by text content like "x3", "x4"
    const promptBar = findPromptInput([]);
    if (promptBar) {
      let container = promptBar.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        container = container.parentElement;
      }
      if (container) {
        // Look for text like "x1", "x2", "x3", "x4" or just numbers
        const allEls = container.querySelectorAll('button, [role="button"], span, div');
        for (const el of allEls) {
          const text = (el.textContent || '').trim();
          if (/^[x×]?\s*\d$/.test(text) && isElementVisible(el)) {
            // Found the count selector - click it to open dropdown
            el.click();
            await new Promise(r => setTimeout(r, 500));

            // Now find and click the desired count option
            const option = findByText(null, `x${count}`) || findByText(null, String(count));
            if (option) {
              option.click();
              await new Promise(r => setTimeout(r, 300));
              addLog(`Set image count to ${count}.`, 'success');
              return true;
            }

            // Close the dropdown if we couldn't find the option
            document.body.click();
            break;
          }
        }
      }
    }

    addLog(`Could not find image count selector to set to ${count}.`, 'warn');
    return false;
  } catch (e) {
    addLog('Error configuring image count: ' + e.message, 'error');
    return false;
  }
}

/**
 * Configure the image generation model.
 * @param {string} modelName - Model name (e.g., "Nano Banana Pro")
 * @returns {Promise<boolean>}
 */
async function configureModel(modelName) {
  try {
    // Look for the model selector near the prompt bar
    // It typically shows the model name as a button/dropdown
    const promptBar = findPromptInput([]);
    if (!promptBar) {
      addLog('Cannot find prompt bar for model config.', 'warn');
      return false;
    }

    let container = promptBar.parentElement;
    for (let i = 0; i < 6 && container; i++) {
      container = container.parentElement;
    }
    if (!container) container = document.body;

    // Find button/element containing model name text
    const modelBtn = findByText(null, modelName) ||
                     findByText(null, 'Nano Banana') ||
                     findByText(null, 'model');

    if (modelBtn) {
      modelBtn.click();
      await new Promise(r => setTimeout(r, 500));

      // If this opened a dropdown, find the target model
      const targetOption = findByText(null, modelName);
      if (targetOption && targetOption !== modelBtn) {
        targetOption.click();
        await new Promise(r => setTimeout(r, 300));
        addLog(`Set model to ${modelName}.`, 'success');
        return true;
      }

      // Already selected or dropdown didn't open
      document.body.click();
      addLog(`Model appears to be ${modelName} already.`, 'info');
      return true;
    }

    addLog(`Could not find model selector for "${modelName}".`, 'warn');
    return false;
  } catch (e) {
    addLog('Error configuring model: ' + e.message, 'error');
    return false;
  }
}

/**
 * Configure the image aspect ratio.
 * @param {string} ratio - Ratio string (e.g., "16:9", "9:16", "1:1")
 * @returns {Promise<boolean>}
 */
async function configureRatio(ratio) {
  try {
    // Look for ratio/aspect selector
    const ratioSelectors = [
      '[aria-label*="ratio" i]',
      '[aria-label*="aspect" i]',
      '[class*="ratio"]',
      '[class*="aspect"]'
    ];

    for (const sel of ratioSelectors) {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el)) {
        el.click();
        await new Promise(r => setTimeout(r, 500));

        // Find the ratio option
        const ratioNames = {
          '16:9': ['16:9', 'landscape', 'widescreen'],
          '9:16': ['9:16', 'portrait', 'vertical'],
          '1:1': ['1:1', 'square'],
          '4:3': ['4:3'],
          '3:4': ['3:4']
        };

        const searchTerms = ratioNames[ratio] || [ratio];
        for (const term of searchTerms) {
          const option = findByText(null, term);
          if (option) {
            option.click();
            await new Promise(r => setTimeout(r, 300));
            addLog(`Set ratio to ${ratio}.`, 'success');
            return true;
          }
        }

        document.body.click();
        break;
      }
    }

    addLog(`Could not find ratio selector for "${ratio}".`, 'warn');
    return false;
  } catch (e) {
    addLog('Error configuring ratio: ' + e.message, 'error');
    return false;
  }
}

/**
 * Run all flow configurations based on settings.
 * @param {Object} config - Configuration object
 * @param {number} config.imageCount - Images per task
 * @param {string} config.model - Model name
 * @param {string} config.ratio - Aspect ratio
 * @param {boolean} config.autoZoom - Whether to zoom out
 * @param {number} config.zoomLevel - Zoom level
 * @param {boolean} config.newProject - Whether to create new project
 * @returns {Promise<Object>} Results of each configuration step
 */
async function configureFlow(config) {
  const results = {};

  if (config.newProject) {
    results.newProject = await createNewProject();
    await new Promise(r => setTimeout(r, 1000));
  }

  if (config.autoZoom) {
    autoZoomOut(config.zoomLevel || 0.8);
    results.zoom = true;
  }

  if (config.imageCount) {
    results.imageCount = await configureImageCount(config.imageCount);
  }

  if (config.model) {
    results.model = await configureModel(config.model);
  }

  if (config.ratio) {
    results.ratio = await configureRatio(config.ratio);
  }

  addLog('Flow configuration complete: ' + JSON.stringify(results), 'info');
  return results;
}
