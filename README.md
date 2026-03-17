# Google Flow Prompt Automation — Chrome Extension (Manifest V3)

Automates prompt submission on the Google Flow image-generation page with batch processing, cooldowns, and full control.

## Features

- Upload a `.txt` file of prompts and auto-submit them one by one
- Batch processing: sends prompts in configurable batches (default 4)
- 60-second cooldown between batches (configurable)
- Simulated realistic typing with per-character delay
- Auto-submit via Enter key simulation or submit button click (with fallback)
- Full control: Start, Pause, Resume, Stop, Skip, Reset
- On-page overlay showing progress, countdown, and quick controls
- State persistence — survives page reloads
- Resilient DOM detection with multiple fallback selectors
- Advanced settings page for custom selectors and behavior

## Setup Instructions

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the root folder of this project (the folder containing `manifest.json`)
6. The extension icon appears in the toolbar

## Usage

1. **Prepare prompts:** Create a `.txt` file with your prompts. In paragraph mode (default), separate prompts with blank lines. In line mode, one prompt per line. Lines starting with `#` are treated as comments and ignored.

2. **Open Google Flow:** Navigate to `https://labs.google/fx/tool/image-fx` (or `https://aitestkitchen.withgoogle.com/tool/image-fx`)

3. **Load prompts:** Click the extension icon, upload your `.txt` file, select parsing mode, and click **Load Prompts**

4. **Configure settings:** Adjust batch size, cooldown time, typing delay, and submit method as needed

5. **Start automation:** Click **Start Automation**. The extension will automatically:
   - Detect the prompt input box
   - Clear any existing text
   - Type each prompt character by character
   - Submit each prompt automatically
   - Wait between prompts
   - Pause for cooldown after each batch
   - Continue until all prompts are processed

6. **Control the automation:** Use Pause/Resume/Stop/Skip/Reset buttons in the popup or the on-page overlay

## Prompt File Format

### Paragraph mode (default)
```
A beautiful sunset over mountains with golden light

A futuristic city at night with neon lights
and flying cars overhead

# This is a comment and will be ignored

A serene lake surrounded by autumn trees
```

### Line mode
```
A beautiful sunset over mountains with golden light
A futuristic city at night with neon lights
A serene lake surrounded by autumn trees
```

## Changing Selectors

If Google Flow updates their UI and the extension can no longer find the input or submit button:

1. Right-click the extension icon → **Options** (or click "Advanced Settings" in the popup)
2. Open Chrome DevTools on the Flow page (F12)
3. Inspect the prompt input element and copy its CSS selector
4. Paste it into **Custom Input Selectors** (one per line)
5. Do the same for the submit/generate button under **Custom Submit Button Selectors**
6. Click **Save Settings**

## Default Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Batch size | 4 | Prompts per batch before cooldown |
| Cooldown | 60000 ms | Wait time between batches |
| Intra-prompt gap | 3000 ms | Wait time between prompts in a batch |
| Typing delay | 20 ms | Delay per character when typing |
| Submit method | Auto | Try Enter key, fallback to button click |
| Max retries | 2 | Retry count for finding input |
| Detection | Hybrid | DOM-based + timing fallback |
| Overlay | Enabled | On-page status overlay |
| Auto-reattach | Enabled | Resume after page reload |

## Common Issues & Fixes

| Problem | Fix |
|---------|-----|
| Extension can't find input | Update custom input selectors in Options |
| Prompts not submitting | Try changing submit method to "Button click" |
| Automation pauses unexpectedly | Check that you're on a matching URL |
| Overlay blocks the page | Drag it to a new position or disable in Options |
| State seems stuck | Click Reset Progress and try again |
| Content script errors | Reload the page and re-start automation |

## File Structure

```
├── manifest.json      # Extension manifest (Manifest V3)
├── background.js      # Service worker — state machine, coordination
├── content.js         # Content script — DOM automation, overlay
├── utils.js           # Shared helpers — selectors, typing, parsing
├── popup.html/css/js  # Extension popup UI
├── options.html/css/js # Advanced settings page
├── icons/             # Extension icons
└── README.md          # This file
```
