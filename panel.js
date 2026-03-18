/**
 * panel.js — Side panel UI for Flow Automation v2.
 * Injected as content script on Google Flow pages.
 * Replaces both popup.html and the overlay widget.
 */

(function () {
  'use strict';

  if (document.getElementById('gflow-panel')) return; // Already injected

  /* ============================================================
     STATE
     ============================================================ */
  let panelVisible = true;
  let activeTab = 'control';
  let currentState = {};
  let promptList = [];
  let capturedImages = [];

  /* ============================================================
     PANEL CREATION
     ============================================================ */

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'gflow-panel';
    panel.innerHTML = getPanelHTML();
    document.body.appendChild(panel);

    // Push page content left
    adjustPageLayout(true);

    // Create toggle button (visible when panel is collapsed)
    const toggle = document.createElement('div');
    toggle.id = 'gflow-panel-toggle';
    toggle.innerHTML = '⚡';
    toggle.title = 'Open Flow Automation';
    toggle.addEventListener('click', () => togglePanel());
    document.body.appendChild(toggle);

    setupEventListeners();
    loadStateFromStorage();
  }

  function getPanelHTML() {
    return `
      <div class="gflow-panel-header">
        <div class="gflow-header-left">
          <span class="gflow-logo">⚡</span>
          <span class="gflow-title">Flow Automation</span>
          <span class="gflow-version">v2.0</span>
        </div>
        <div class="gflow-header-right">
          <button class="gflow-header-btn" id="gflow-pin" title="Pin panel">📌</button>
          <button class="gflow-header-btn" id="gflow-minimize" title="Minimize">—</button>
        </div>
      </div>

      <div class="gflow-tabs">
        <button class="gflow-tab active" data-tab="control">▶ Control</button>
        <button class="gflow-tab" data-tab="gallery">🖼 Gallery</button>
        <button class="gflow-tab" data-tab="settings">⚙ Settings</button>
        <button class="gflow-tab" data-tab="logs">📋 Logs</button>
      </div>

      <div class="gflow-tab-content" id="gflow-content-control">
        ${getControlTabHTML()}
      </div>

      <div class="gflow-tab-content" id="gflow-content-gallery" style="display:none;">
        ${getGalleryTabHTML()}
      </div>

      <div class="gflow-tab-content" id="gflow-content-settings" style="display:none;">
        ${getSettingsTabHTML()}
      </div>

      <div class="gflow-tab-content" id="gflow-content-logs" style="display:none;">
        ${getLogsTabHTML()}
      </div>
    `;
  }

  /* ============================================================
     TAB HTML GENERATORS
     ============================================================ */

  function getControlTabHTML() {
    return `
      <div class="gflow-section">
        <div class="gflow-mode-grid">
          <button class="gflow-mode-btn active" data-mode="text-to-image">
            <span class="gflow-mode-icon">✨</span>
            <span>Create Image</span>
          </button>
          <button class="gflow-mode-btn" data-mode="text-to-video">
            <span class="gflow-mode-icon">🎬</span>
            <span>Text-to-Video</span>
          </button>
          <button class="gflow-mode-btn" data-mode="frame-to-video">
            <span class="gflow-mode-icon">🖼</span>
            <span>Frame-to-Video</span>
          </button>
          <button class="gflow-mode-btn" data-mode="ingredients">
            <span class="gflow-mode-icon">🧩</span>
            <span>Ingredients</span>
          </button>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">INPUT</div>
        <div class="gflow-row">
          <span>Prompt List</span>
          <button class="gflow-btn gflow-btn-sm" id="gflow-import-btn">📁 Import .txt</button>
          <input type="file" id="gflow-file-input" accept=".txt" style="display:none;">
        </div>
        <div class="gflow-row">
          <label class="gflow-radio-group">
            <input type="radio" name="parseMode" value="line" checked> Line
            <input type="radio" name="parseMode" value="paragraph"> Paragraph
          </label>
        </div>
        <textarea class="gflow-input gflow-textarea" id="gflow-prompt-textarea"
          placeholder="Paste prompts here (one per line) or import a .txt file..."></textarea>
        <div class="gflow-prompt-count" id="gflow-prompt-count">0 prompts loaded</div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">FLOW CONFIGURATION</div>
        <div class="gflow-form-row">
          <label>Images per task</label>
          <select class="gflow-select" id="gflow-images-per-task">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4" selected>4</option>
          </select>
        </div>
        <div class="gflow-form-row">
          <label>Image Model</label>
          <select class="gflow-select" id="gflow-image-model">
            <option value="nano_banana_pro">Nano Banana Pro</option>
          </select>
        </div>
        <div class="gflow-form-row">
          <label>Image Ratio</label>
          <select class="gflow-select" id="gflow-image-ratio">
            <option value="16:9">Landscape (16:9)</option>
            <option value="9:16">Portrait (9:16)</option>
            <option value="1:1">Square (1:1)</option>
            <option value="4:3">Standard (4:3)</option>
            <option value="3:4">Portrait (3:4)</option>
          </select>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">PROMPT LIST</div>
        <div class="gflow-prompt-table" id="gflow-prompt-table">
          <div class="gflow-prompt-table-empty">No prompts loaded yet.</div>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-queue-controls">
          <button class="gflow-btn gflow-btn-primary gflow-btn-lg" id="gflow-start-queue">
            ▶ Start Queue
          </button>
          <div class="gflow-btn-row">
            <button class="gflow-btn gflow-btn-secondary" id="gflow-pause" style="display:none;">⏸ Pause</button>
            <button class="gflow-btn gflow-btn-secondary" id="gflow-resume" style="display:none;">▶ Resume</button>
            <button class="gflow-btn gflow-btn-secondary" id="gflow-skip">⏭ Skip</button>
            <button class="gflow-btn gflow-btn-danger" id="gflow-stop">⏹ Stop</button>
          </div>
        </div>
        <div class="gflow-form-row">
          <label>Auto-start next job</label>
          <input type="checkbox" class="gflow-toggle" id="gflow-auto-start" checked>
        </div>
        <div class="gflow-form-row">
          <label>Auto retry failed (max 12 rounds)</label>
          <input type="checkbox" class="gflow-toggle" id="gflow-auto-retry">
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-live-status" id="gflow-live-status" style="display:none;">
          <div class="gflow-status-header">
            <span class="gflow-status-dot"></span>
            <span id="gflow-status-text">Idle</span>
          </div>
          <div class="gflow-progress-bar">
            <div class="gflow-progress-fill" id="gflow-progress-fill" style="width:0%"></div>
          </div>
          <div class="gflow-status-details" id="gflow-status-details"></div>
        </div>
      </div>
    `;
  }

  function getGalleryTabHTML() {
    return `
      <div class="gflow-section">
        <div class="gflow-live-status" id="gflow-gallery-status">
          <div class="gflow-status-header">
            <span>LIVE RUN STATUS</span>
          </div>
          <div class="gflow-progress-bar">
            <div class="gflow-progress-fill" id="gflow-gallery-progress" style="width:0%"></div>
          </div>
          <div id="gflow-gallery-status-text" class="gflow-status-details">No active job.</div>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">Failed Tasks (<span id="gflow-failed-count">0</span>)</div>
        <div id="gflow-failed-list" class="gflow-failed-list">
          <div class="gflow-empty-state">No failed prompts yet.</div>
        </div>
        <div class="gflow-btn-row">
          <button class="gflow-btn gflow-btn-sm" id="gflow-copy-failed">Copy Failed</button>
          <button class="gflow-btn gflow-btn-sm" id="gflow-retry-all-failed">Retry All Failed</button>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-btn-row">
          <button class="gflow-btn gflow-btn-secondary active" id="gflow-gallery-images">🖼 Images</button>
          <button class="gflow-btn gflow-btn-secondary" id="gflow-gallery-videos">🎬 Videos</button>
        </div>
        <div class="gflow-gallery-controls">
          <div class="gflow-btn-row">
            <span>VIEW</span>
            <button class="gflow-btn gflow-btn-sm active" data-view="grid">▦</button>
            <button class="gflow-btn gflow-btn-sm" data-view="list">☰</button>
            <span style="margin-left:auto;">SIZE</span>
            <button class="gflow-btn gflow-btn-sm" data-size="s">S</button>
            <button class="gflow-btn gflow-btn-sm active" data-size="m">M</button>
          </div>
          <div class="gflow-btn-row">
            <select class="gflow-select gflow-select-sm" id="gflow-gallery-resolution">
              <option value="1K">1K</option>
              <option value="2K">2K</option>
              <option value="4K">4K</option>
            </select>
            <button class="gflow-btn gflow-btn-warning gflow-btn-sm" id="gflow-scan-all">🔍 Scan All</button>
            <select class="gflow-select gflow-select-sm" id="gflow-gallery-sort">
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
            </select>
            <span id="gflow-image-count">0 images</span>
          </div>
        </div>
        <div class="gflow-btn-row">
          <button class="gflow-btn gflow-btn-sm" id="gflow-random-pick">🎲 Random Pick</button>
          <button class="gflow-btn gflow-btn-sm" id="gflow-select-all">Select All</button>
          <button class="gflow-btn gflow-btn-sm" id="gflow-deselect-all">Deselect All</button>
        </div>
        <button class="gflow-btn gflow-btn-secondary gflow-btn-lg" id="gflow-download-selected">
          ⬇ Download (<span id="gflow-download-count">0</span>)
        </button>
      </div>

      <div class="gflow-section">
        <div class="gflow-gallery-grid" id="gflow-gallery-grid">
          <div class="gflow-empty-state">No images captured yet. Start automation to generate images.</div>
        </div>
      </div>
    `;
  }

  function getSettingsTabHTML() {
    return `
      <div class="gflow-section">
        <div class="gflow-section-label">GENERAL SETTINGS</div>
        <div class="gflow-form-row">
          <label>Images per task</label>
          <select class="gflow-select" id="gflow-s-images-per-task">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4" selected>4</option>
          </select>
        </div>
        <div class="gflow-form-row">
          <label>Image Model</label>
          <select class="gflow-select" id="gflow-s-model">
            <option value="nano_banana_pro">Nano Banana Pro (Default)</option>
          </select>
        </div>
        <div class="gflow-form-row">
          <label>Image Ratio</label>
          <select class="gflow-select" id="gflow-s-ratio">
            <option value="16:9">Landscape (16:9)</option>
            <option value="9:16">Portrait (9:16)</option>
            <option value="1:1">Square (1:1)</option>
          </select>
        </div>
        <div class="gflow-form-row">
          <label>Start from (Prompt #)</label>
          <input type="number" class="gflow-input gflow-input-sm" id="gflow-s-start-from" value="1" min="1">
        </div>
        <div class="gflow-form-row">
          <label>Submit Path Preference</label>
          <select class="gflow-select" id="gflow-s-submit-path">
            <option value="dom_first">DOM first</option>
            <option value="api_first">API first</option>
            <option value="api_only">API only</option>
            <option value="dom_only">DOM only</option>
          </select>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">TIMING</div>
        <div class="gflow-form-row">
          <label>Batch cooldown (sec)</label>
          <input type="number" class="gflow-input gflow-input-sm" id="gflow-s-cooldown" value="60" min="1">
        </div>
        <div class="gflow-form-row">
          <label>Intra-prompt gap (sec)</label>
          <input type="number" class="gflow-input gflow-input-sm" id="gflow-s-gap" value="3" min="1">
        </div>
        <div class="gflow-form-row">
          <label>Batch size</label>
          <input type="number" class="gflow-input gflow-input-sm" id="gflow-s-batch-size" value="4" min="1" max="50">
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">DOWNLOAD SETTINGS</div>
        <div class="gflow-form-row">
          <label>Auto-download images</label>
          <input type="checkbox" class="gflow-toggle" id="gflow-s-auto-dl-images">
          <select class="gflow-select gflow-select-sm" id="gflow-s-dl-resolution">
            <option value="1K">1K</option>
            <option value="2K">2K</option>
            <option value="4K">4K</option>
          </select>
        </div>
        <div class="gflow-form-row">
          <label>Download Folder</label>
          <input type="text" class="gflow-input gflow-input-sm" id="gflow-s-dl-folder" value="flowautomation" placeholder="folder name">
          <label style="font-size:11px;">
            <input type="checkbox" id="gflow-s-dl-auto-num" checked> Auto-number
          </label>
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">AUTOMATION</div>
        <div class="gflow-form-row">
          <label>Auto zoom out</label>
          <input type="checkbox" class="gflow-toggle" id="gflow-s-auto-zoom">
        </div>
        <div class="gflow-form-row">
          <label>Auto new project</label>
          <input type="checkbox" class="gflow-toggle" id="gflow-s-auto-new-project">
        </div>
      </div>

      <div class="gflow-section">
        <div class="gflow-section-label">MAINTENANCE</div>
        <button class="gflow-btn gflow-btn-danger" id="gflow-clear-cache">🗑 Clear Flow Cache</button>
      </div>
    `;
  }

  function getLogsTabHTML() {
    return `
      <div class="gflow-section">
        <div class="gflow-btn-row">
          <button class="gflow-btn gflow-btn-sm" id="gflow-export-bundle">📦 Export Site Bundle</button>
          <button class="gflow-btn gflow-btn-sm" id="gflow-export-report">📄 Export Report</button>
        </div>
      </div>
      <div class="gflow-section">
        <div class="gflow-section-label">Detailed Log</div>
        <div class="gflow-log-container" id="gflow-log-container">
          <div class="gflow-empty-state">No log entries yet.</div>
        </div>
      </div>
    `;
  }

  /* ============================================================
     EVENT LISTENERS
     ============================================================ */

  function setupEventListeners() {
    const panel = document.getElementById('gflow-panel');
    if (!panel) return;

    // Tab switching
    panel.querySelectorAll('.gflow-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        switchTab(tab.dataset.tab);
      });
    });

    // Minimize
    document.getElementById('gflow-minimize')?.addEventListener('click', () => {
      togglePanel();
    });

    // Mode selector
    panel.querySelectorAll('.gflow-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('.gflow-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        saveSetting('mode', btn.dataset.mode);
      });
    });

    // File import
    document.getElementById('gflow-import-btn')?.addEventListener('click', () => {
      document.getElementById('gflow-file-input')?.click();
    });

    document.getElementById('gflow-file-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        const textarea = document.getElementById('gflow-prompt-textarea');
        if (textarea) textarea.value = text;
        loadPromptsFromText(text);
      };
      reader.readAsText(file);
    });

    // Prompt textarea — load on change
    document.getElementById('gflow-prompt-textarea')?.addEventListener('change', () => {
      const text = document.getElementById('gflow-prompt-textarea')?.value || '';
      loadPromptsFromText(text);
    });

    // Queue controls
    document.getElementById('gflow-start-queue')?.addEventListener('click', startQueue);
    document.getElementById('gflow-pause')?.addEventListener('click', () => sendAction('PAUSE'));
    document.getElementById('gflow-resume')?.addEventListener('click', () => sendAction('RESUME'));
    document.getElementById('gflow-skip')?.addEventListener('click', () => sendAction('SKIP'));
    document.getElementById('gflow-stop')?.addEventListener('click', () => sendAction('STOP'));

    // Auto toggles
    document.getElementById('gflow-auto-start')?.addEventListener('change', (e) => {
      saveSetting('autoStartNext', e.target.checked);
    });
    document.getElementById('gflow-auto-retry')?.addEventListener('change', (e) => {
      saveSetting('autoRetryFailed', e.target.checked);
    });

    // Gallery controls
    document.getElementById('gflow-scan-all')?.addEventListener('click', scanAllImages);
    document.getElementById('gflow-retry-all-failed')?.addEventListener('click', () => sendAction('RETRY_FAILED'));
    document.getElementById('gflow-clear-cache')?.addEventListener('click', () => sendAction('CLEAR_GALLERY'));

    // Settings — auto-save on change
    setupSettingsListeners();

    // Export buttons
    document.getElementById('gflow-export-report')?.addEventListener('click', exportReport);

    // Gallery view controls
    panel.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    panel.querySelectorAll('[data-size]').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('[data-size]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  function setupSettingsListeners() {
    const settingsMap = {
      'gflow-s-images-per-task': { key: 'imagesPerTask', type: 'number' },
      'gflow-s-model': { key: 'imageModel', type: 'string' },
      'gflow-s-ratio': { key: 'imageRatio', type: 'string' },
      'gflow-s-start-from': { key: 'startFrom', type: 'number' },
      'gflow-s-submit-path': { key: 'submitPath', type: 'string' },
      'gflow-s-cooldown': { key: 'batchCooldownMs', type: 'seconds' },
      'gflow-s-gap': { key: 'intraPromptGapMs', type: 'seconds' },
      'gflow-s-batch-size': { key: 'batchSize', type: 'number' },
      'gflow-s-auto-zoom': { key: 'autoZoom', type: 'boolean' },
      'gflow-s-auto-new-project': { key: 'autoNewProject', type: 'boolean' },
      'gflow-s-auto-dl-images': { key: 'downloadSettings.autoDownloadImages', type: 'boolean' },
      'gflow-s-dl-folder': { key: 'downloadSettings.folder', type: 'string' },
    };

    Object.entries(settingsMap).forEach(([id, config]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        let value;
        if (config.type === 'boolean') value = el.checked;
        else if (config.type === 'number') value = parseInt(el.value) || 0;
        else if (config.type === 'seconds') value = (parseInt(el.value) || 0) * 1000;
        else value = el.value;
        saveSetting(config.key, value);
      });
    });
  }

  /* ============================================================
     ACTIONS
     ============================================================ */

  function sendAction(action, data) {
    chrome.runtime.sendMessage({ action, ...data });
  }

  function saveSetting(key, value) {
    chrome.storage.local.get('settings', (data) => {
      const settings = data.settings || {};
      // Handle nested keys like 'downloadSettings.folder'
      if (key.includes('.')) {
        const parts = key.split('.');
        if (!settings[parts[0]]) settings[parts[0]] = {};
        settings[parts[0]][parts[1]] = value;
      } else {
        settings[key] = value;
      }
      chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings });
    });
  }

  function loadPromptsFromText(text) {
    const modeEl = document.querySelector('input[name="parseMode"]:checked');
    const mode = modeEl ? modeEl.value : 'line';
    const prompts = parsePrompts(text, mode);
    promptList = prompts;

    chrome.runtime.sendMessage({ action: 'LOAD_PROMPTS', prompts }, () => {
      updatePromptCount(prompts.length);
      updatePromptTable(prompts);
    });
  }

  function startQueue() {
    // First ensure prompts are loaded from textarea if not already
    const textarea = document.getElementById('gflow-prompt-textarea');
    if (textarea && textarea.value.trim() && promptList.length === 0) {
      loadPromptsFromText(textarea.value);
    }
    sendAction('START');
  }

  function scanAllImages() {
    // Scan page DOM for any generated images
    const imgs = document.querySelectorAll('img');
    const found = [];
    imgs.forEach(img => {
      const rect = img.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 100 && img.src) {
        found.push({
          url: img.src,
          promptText: '',
          timestamp: Date.now(),
          resolution: '1K'
        });
      }
    });
    if (found.length > 0) {
      chrome.runtime.sendMessage({
        action: 'IMAGES_CAPTURED',
        images: found.map(f => f.url),
        promptText: 'scanned'
      });
    }
  }

  function exportReport() {
    chrome.storage.local.get(['logs', 'prompts', 'capturedImages', 'settings'], (data) => {
      const report = {
        exportedAt: new Date().toISOString(),
        prompts: data.prompts || [],
        logs: data.logs || [],
        capturedImages: data.capturedImages || [],
        settings: data.settings || {}
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `flowautomation-report-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  /* ============================================================
     UI UPDATES
     ============================================================ */

  function switchTab(tabName) {
    activeTab = tabName;
    const panel = document.getElementById('gflow-panel');
    if (!panel) return;

    panel.querySelectorAll('.gflow-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tabName);
    });
    panel.querySelectorAll('.gflow-tab-content').forEach(c => {
      c.style.display = c.id === `gflow-content-${tabName}` ? '' : 'none';
    });
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    const panel = document.getElementById('gflow-panel');
    const toggle = document.getElementById('gflow-panel-toggle');
    if (panel) panel.style.display = panelVisible ? '' : 'none';
    if (toggle) toggle.style.display = panelVisible ? 'none' : '';
    adjustPageLayout(panelVisible);
  }

  // Make togglePanel globally accessible for content.js
  window.togglePanel = togglePanel;

  function adjustPageLayout(panelOpen) {
    // Find Flow's main content container and push it left
    const selectors = ['main', '#__next > div', '[class*="layout"]', 'body > div:first-child'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.style.marginRight = panelOpen ? '380px' : '';
        el.style.transition = 'margin-right 0.3s ease';
        break;
      }
    }
  }

  function updatePromptCount(count) {
    const el = document.getElementById('gflow-prompt-count');
    if (el) el.textContent = `${count} prompts loaded`;
  }

  function updatePromptTable(prompts, statuses) {
    const table = document.getElementById('gflow-prompt-table');
    if (!table) return;

    if (!prompts || prompts.length === 0) {
      table.innerHTML = '<div class="gflow-prompt-table-empty">No prompts loaded yet.</div>';
      return;
    }

    const currentIndex = currentState.currentIndex || 0;
    const status = currentState.status || 'idle';

    table.innerHTML = prompts.slice(0, 200).map((prompt, i) => {
      let badge = 'pending';
      let badgeText = 'PENDING';
      if (i < currentIndex) { badge = 'generated'; badgeText = 'DONE'; }
      else if (i === currentIndex && status === 'running') { badge = 'generating'; badgeText = 'GENERATING'; }

      const truncated = prompt.length > 45 ? prompt.substring(0, 45) + '...' : prompt;
      return `
        <div class="gflow-prompt-row">
          <span class="gflow-prompt-num">${i + 1}</span>
          <span class="gflow-prompt-text" title="${escapeHTML(prompt)}">${escapeHTML(truncated)}</span>
          <span class="gflow-badge gflow-badge-${badge}">${badgeText}</span>
        </div>
      `;
    }).join('');
  }

  function updateLiveStatus(state) {
    const statusEl = document.getElementById('gflow-live-status');
    const statusText = document.getElementById('gflow-status-text');
    const progressFill = document.getElementById('gflow-progress-fill');
    const statusDetails = document.getElementById('gflow-status-details');
    const pauseBtn = document.getElementById('gflow-pause');
    const resumeBtn = document.getElementById('gflow-resume');
    const startBtn = document.getElementById('gflow-start-queue');

    if (!statusEl) return;

    const isActive = state.status && state.status !== 'idle' && state.status !== 'completed';
    statusEl.style.display = isActive || state.status === 'completed' ? '' : 'none';

    if (statusText) {
      const total = (state.prompts || []).length;
      const current = (state.currentIndex || 0) + 1;
      const statusLabels = {
        'idle': 'Idle',
        'running': `Generating prompt ${current} of ${total}...`,
        'paused': 'Paused',
        'waiting_cooldown': 'Waiting cooldown...',
        'completed': 'Completed!',
        'error': 'Error'
      };
      statusText.textContent = statusLabels[state.status] || state.status;
    }

    if (progressFill) {
      const total = (state.prompts || []).length;
      const pct = total > 0 ? ((state.currentIndex || 0) / total * 100) : 0;
      progressFill.style.width = pct + '%';
    }

    if (statusDetails && state.countdownEnd) {
      const remaining = Math.max(0, Math.ceil((state.countdownEnd - Date.now()) / 1000));
      statusDetails.textContent = `Next batch in: ${remaining}s`;
    }

    // Button visibility
    if (pauseBtn) pauseBtn.style.display = state.status === 'running' ? '' : 'none';
    if (resumeBtn) resumeBtn.style.display = state.status === 'paused' ? '' : 'none';
    if (startBtn) {
      startBtn.textContent = state.status === 'completed' ? '↻ Restart Queue' : '▶ Start Queue';
    }

    // Gallery status
    const galleryStatus = document.getElementById('gflow-gallery-status-text');
    const galleryProgress = document.getElementById('gflow-gallery-progress');
    if (galleryStatus) {
      galleryStatus.textContent = statusText ? statusText.textContent : '';
    }
    if (galleryProgress) {
      galleryProgress.style.width = progressFill ? progressFill.style.width : '0%';
    }
  }

  function updateGallery(images) {
    const grid = document.getElementById('gflow-gallery-grid');
    const countEl = document.getElementById('gflow-image-count');
    if (!grid) return;

    capturedImages = images || [];
    if (countEl) countEl.textContent = `${capturedImages.length} images`;

    if (capturedImages.length === 0) {
      grid.innerHTML = '<div class="gflow-empty-state">No images captured yet.</div>';
      return;
    }

    grid.innerHTML = capturedImages.map((img, i) => `
      <div class="gflow-gallery-item" data-index="${i}">
        <img src="${escapeHTML(img.url)}" alt="Generated image" loading="lazy">
        <div class="gflow-gallery-item-overlay">
          <span class="gflow-gallery-item-label">${escapeHTML((img.promptText || '').substring(0, 30))}</span>
        </div>
      </div>
    `).join('');
  }

  function updateLogs(logs) {
    const container = document.getElementById('gflow-log-container');
    if (!container) return;

    if (!logs || logs.length === 0) {
      container.innerHTML = '<div class="gflow-empty-state">No log entries yet.</div>';
      return;
    }

    const recentLogs = logs.slice(-100);
    container.innerHTML = recentLogs.map(log => {
      const time = new Date(log.timestamp).toLocaleTimeString();
      const levelColors = {
        info: '#888', warn: '#f0a500', error: '#e74c3c', success: '#4ecca3'
      };
      const color = levelColors[log.level] || '#888';
      return `<div class="gflow-log-entry" style="color:${color}">
        <span class="gflow-log-time">${time}</span>
        <span class="gflow-log-msg">${escapeHTML(log.message)}</span>
      </div>`;
    }).join('');

    container.scrollTop = container.scrollHeight;
  }

  /* ============================================================
     STATE MANAGEMENT
     ============================================================ */

  function loadStateFromStorage() {
    chrome.runtime.sendMessage({ action: 'GET_STATE' }, (response) => {
      if (response?.ok && response.state) {
        currentState = response.state;
        applyStateToUI(response.state);
      }
    });
  }

  function applyStateToUI(state) {
    // Update prompts
    if (state.prompts && state.prompts.length > 0) {
      promptList = state.prompts;
      updatePromptCount(state.prompts.length);
      updatePromptTable(state.prompts);

      const textarea = document.getElementById('gflow-prompt-textarea');
      if (textarea && !textarea.value) {
        textarea.value = state.prompts.join('\n');
      }
    }

    // Update settings UI
    const s = state.settings || {};
    setSelectValue('gflow-images-per-task', s.imagesPerTask);
    setSelectValue('gflow-s-images-per-task', s.imagesPerTask);
    setSelectValue('gflow-image-model', s.imageModel);
    setSelectValue('gflow-s-model', s.imageModel);
    setSelectValue('gflow-image-ratio', s.imageRatio);
    setSelectValue('gflow-s-ratio', s.imageRatio);
    setSelectValue('gflow-s-submit-path', s.submitPath);
    setInputValue('gflow-s-cooldown', (s.batchCooldownMs || 60000) / 1000);
    setInputValue('gflow-s-gap', (s.intraPromptGapMs || 3000) / 1000);
    setInputValue('gflow-s-batch-size', s.batchSize);
    setCheckbox('gflow-auto-start', s.autoStartNext !== false);
    setCheckbox('gflow-auto-retry', s.autoRetryFailed);
    setCheckbox('gflow-s-auto-zoom', s.autoZoom);
    setCheckbox('gflow-s-auto-new-project', s.autoNewProject);

    // Update live status
    updateLiveStatus(state);

    // Update gallery
    if (state.capturedImages) {
      updateGallery(state.capturedImages);
    }

    // Update logs
    if (state.logs) {
      updateLogs(state.logs);
    }

    // Update failed count
    const failedCount = document.getElementById('gflow-failed-count');
    if (failedCount) {
      failedCount.textContent = (state.failedPrompts || []).length;
    }

    // Mode selector
    const mode = s.mode || 'text-to-image';
    document.querySelectorAll('.gflow-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  }

  function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined) el.value = String(value);
  }

  function setInputValue(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined) el.value = value;
  }

  function setCheckbox(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = !!checked;
  }

  /* ============================================================
     STORAGE CHANGE LISTENER — REACTIVE UI
     ============================================================ */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    // Rebuild currentState from changes
    for (const key of Object.keys(changes)) {
      currentState[key] = changes[key].newValue;
    }

    // Update relevant UI sections
    if (changes.status || changes.currentIndex || changes.countdownEnd || changes.prompts) {
      updateLiveStatus(currentState);
      if (currentState.prompts) {
        updatePromptTable(currentState.prompts);
      }
    }

    if (changes.capturedImages) {
      updateGallery(changes.capturedImages.newValue);
    }

    if (changes.logs) {
      updateLogs(changes.logs.newValue);
    }

    if (changes.failedPrompts) {
      const failedCount = document.getElementById('gflow-failed-count');
      if (failedCount) failedCount.textContent = (changes.failedPrompts.newValue || []).length;
    }
  });

  /* ============================================================
     API INTERCEPTOR MESSAGE LISTENER
     ============================================================ */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data.type !== 'string' || !data.type.startsWith('GFLOW_')) return;

    // Update gallery when new images arrive
    if (data.type === 'GFLOW_API_RESPONSE' && data.imageUrls) {
      // Images will come through storage.onChanged after background processes them
    }
  });

  /* ============================================================
     COUNTDOWN TIMER
     ============================================================ */

  setInterval(() => {
    if (currentState.status === 'waiting_cooldown' && currentState.countdownEnd) {
      const remaining = Math.max(0, Math.ceil((currentState.countdownEnd - Date.now()) / 1000));
      const details = document.getElementById('gflow-status-details');
      if (details) details.textContent = `Next batch in: ${remaining}s`;
      const galleryStatus = document.getElementById('gflow-gallery-status-text');
      if (galleryStatus) galleryStatus.textContent = `Cooldown: ${remaining}s remaining`;
    }
  }, 1000);

  /* ============================================================
     UTILITY
     ============================================================ */

  function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ============================================================
     INIT
     ============================================================ */

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    // Small delay to let page render first
    setTimeout(createPanel, 1000);
  }

})();
