/**
 * options.js — Advanced settings page for Google Flow Prompt Automation.
 */

(function () {
  'use strict';

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

  /* DOM references */
  const urlPatternsEl = document.getElementById('url-patterns');
  const inputSelectorsEl = document.getElementById('input-selectors');
  const submitSelectorsEl = document.getElementById('submit-selectors');
  const timeoutEl = document.getElementById('opt-timeout');
  const retriesEl = document.getElementById('opt-retries');
  const overlayEl = document.getElementById('opt-overlay');
  const autoReattachEl = document.getElementById('opt-auto-reattach');
  const btnSave = document.getElementById('btn-save');
  const btnRestore = document.getElementById('btn-restore');
  const saveMsg = document.getElementById('save-msg');

  /**
   * Parse textarea lines into array, filtering empty lines.
   */
  function linesToArray(text) {
    return (text || '').split('\n').map(s => s.trim()).filter(s => s.length > 0);
  }

  /**
   * Load settings from storage and populate form.
   */
  function loadSettings() {
    chrome.storage.local.get('settings', (data) => {
      const s = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };

      urlPatternsEl.value = (s.urlPatterns || []).join('\n');
      inputSelectorsEl.value = (s.customInputSelectors || []).join('\n');
      submitSelectorsEl.value = (s.customSubmitSelectors || []).join('\n');

      // Submit method radio
      const submitRadio = document.querySelector(`input[name="submit-method"][value="${s.submitMethod}"]`);
      if (submitRadio) submitRadio.checked = true;

      // Detection strategy radio
      const detectionRadio = document.querySelector(`input[name="detection-strategy"][value="${s.detectionStrategy}"]`);
      if (detectionRadio) detectionRadio.checked = true;

      timeoutEl.value = s.waitTimeout || 15000;
      retriesEl.value = s.maxRetries || 2;
      overlayEl.checked = s.overlayEnabled !== false;
      autoReattachEl.checked = s.autoReattachAfterReload !== false;
    });
  }

  /**
   * Save form values to storage.
   */
  function saveSettings() {
    const submitMethod = document.querySelector('input[name="submit-method"]:checked')?.value || 'auto';
    const detectionStrategy = document.querySelector('input[name="detection-strategy"]:checked')?.value || 'hybrid';

    const settings = {
      urlPatterns: linesToArray(urlPatternsEl.value),
      customInputSelectors: linesToArray(inputSelectorsEl.value),
      customSubmitSelectors: linesToArray(submitSelectorsEl.value),
      submitMethod: submitMethod,
      detectionStrategy: detectionStrategy,
      waitTimeout: parseInt(timeoutEl.value, 10) || 15000,
      maxRetries: parseInt(retriesEl.value, 10) || 2,
      overlayEnabled: overlayEl.checked,
      autoReattachAfterReload: autoReattachEl.checked
    };

    chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: settings }, () => {
      saveMsg.style.display = '';
      setTimeout(() => { saveMsg.style.display = 'none'; }, 2000);
    });
  }

  /**
   * Restore defaults.
   */
  function restoreDefaults() {
    if (!confirm('Restore all settings to defaults?')) return;

    chrome.runtime.sendMessage({ action: 'SAVE_SETTINGS', settings: DEFAULT_SETTINGS }, () => {
      loadSettings();
      saveMsg.textContent = 'Defaults restored.';
      saveMsg.style.display = '';
      setTimeout(() => {
        saveMsg.textContent = 'Settings saved.';
        saveMsg.style.display = 'none';
      }, 2000);
    });
  }

  /* Event bindings */
  btnSave.addEventListener('click', saveSettings);
  btnRestore.addEventListener('click', restoreDefaults);

  /* Init */
  document.addEventListener('DOMContentLoaded', loadSettings);

})();
