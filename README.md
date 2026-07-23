# TinyKittens Chat Timeline Markers (extension scaffold)

Step 1 of the extension conversion: this is a straight port of the
Tampermonkey userscript into a Manifest V3 extension, with no functional
changes yet. Same logic, same behavior - just loaded a different way.

## Loading it (Chrome / Edge / other Chromium browsers)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this folder (`cat-rescue-extension/`).

It installs immediately - no zipping, no upload, no online installer.

After editing any file in here: click the reload icon on the extension's
card in `chrome://extensions`, **then** refresh the YouTube tab (reloading
the extension alone doesn't re-inject into already-open tabs).

## Loading it (Firefox)

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json` directly (not the folder).

Note: Firefox unloads temporary add-ons when the browser closes, so
you'll reload it each session - fine for development.

## What's in here

- `manifest.json` - two content-script entries, matching the userscript's
  original `@match` patterns: one for the watch page, one for the chat
  iframe (`all_frames: true` on that one, since the chat iframe is a
  sub-frame of the watch page's tab and wouldn't otherwise be eligible
  for injection).
- `content-script.js` - the userscript's logic, unchanged, just with the
  Tampermonkey `// ==UserScript==` metadata block stripped (manifest.json
  now covers name/version/description instead). Both content-script
  entries load this same file, and it still uses the internal
  `window.self !== window.top` check to tell which context it's running
  in, exactly as before.
- `icons/` - generated via `generate_icons.py`, reusing the same cat-face
  design as the on-timeline marker bubbles.
- `"permissions": ["storage"]` is already declared in the manifest ahead
  of the settings-panel work, even though nothing reads/writes storage
  yet.

## Verifying parity with the userscript

Before building on top of this, worth confirming it behaves identically
to the Tampermonkey version:

1. Disable/remove the Tampermonkey userscript (or Tampermonkey itself)
   temporarily, so there's no chance of both versions running at once
   and doubling up markers.
2. Load this extension unpacked as above.
3. Open the TinyKittens live stream and check the console (both the
   watch page's console and the chat iframe's console, via the frame
   dropdown in DevTools) for the same `[cat-rescue-markers]` log lines
   as before.
4. Confirm markers appear, clustering/labels look right, and clicking a
   marker still seeks correctly.

## Not done yet (next steps)

- Settings storage layer (`chrome.storage.sync` for global settings,
  `chrome.storage.local` for the per-video enable flag).
- Moderator-only vs. all-users toggle wired into the actual parsing.
- Player button injected into `.ytp-right-controls`, with a
  `MutationObserver` to survive YouTube's own DOM churn.
- The settings panel UI itself (font size +/- buttons, toggles).
