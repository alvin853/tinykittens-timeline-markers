// Runs in the ISOLATED world (the default for content scripts - no
// "world" key needed in the manifest for this one). This is the only
// piece of the extension with access to chrome.storage; content-script.js
// runs in the MAIN world (required for page-context access like
// window.ytInitialPlayerResponse and hooking window.fetch) and MAIN-world
// scripts cannot call chrome.* APIs at all. So this file's only job is
// bridging: read chrome.storage, relay values into the MAIN world via
// window.postMessage, and relay save-requests back the other way.
//
// This same file is injected into both the watch page and the live_chat
// iframe (see manifest.json), so each frame gets its own independent
// bridge + relay pair, communicating only with its own frame's MAIN-world
// script (postMessage without a target frame only reaches listeners in
// the same frame, regardless of which "world" registered them).
(function () {
  'use strict';

  const GLOBAL_KEYS = ['moderatorOnly', 'fontSizePx', 'showLabels', 'showHourlyMarkers', 'debug'];
  // Kept in sync with content-script.js's own CONFIG defaults - these are
  // what a fresh install (empty chrome.storage) falls back to.
  const DEFAULTS = {
    moderatorOnly: true,
    fontSizePx: 14,
    showLabels: true,
    showHourlyMarkers: true,
    debug: false,
  };

  function getVideoIdFromUrl(href) {
    try {
      const url = new URL(href);
      const fromQuery = url.searchParams.get('v');
      if (fromQuery) return fromQuery;
      const fromLivePath = url.pathname.match(/^\/live\/([\w-]+)/);
      return fromLivePath ? fromLivePath[1] : null;
    } catch (e) {
      return null;
    }
  }

  const inIframe = window.self !== window.top;

  // Same approach as content-script.js's resolveVideoId - duplicated here
  // since the two files can't share code without a build step, and this
  // is small enough not to warrant one.
  function resolveVideoId() {
    if (!inIframe) return getVideoIdFromUrl(location.href);
    try {
      const fromTop = getVideoIdFromUrl(window.top.location.href);
      if (fromTop) return fromTop;
    } catch (e) {
      // Blocked (cross-origin embed) - fall through to referrer.
    }
    return getVideoIdFromUrl(document.referrer);
  }

  const videoId = resolveVideoId();
  // `let`: on URLs with no video ID in them (/@handle/live) this starts
  // out null and is filled in by a 'videoId' message from content-script.js
  // (which can read the page's player response; this isolated-world script
  // can't) - see the message listener below.
  let perVideoKey = videoId ? `perVideoEnabled:${videoId}` : null;

  async function readPerVideoEnabled() {
    // null = no manual override, use automatic live+channel detection
    if (!perVideoKey) return null;
    const localStored = await chrome.storage.local.get(perVideoKey);
    return Object.prototype.hasOwnProperty.call(localStored, perVideoKey) ? localStored[perVideoKey] : null;
  }

  function post(message) {
    window.postMessage({ source: 'cat-rescue-bridge', ...message }, location.origin);
  }

  async function sendInitial() {
    const stored = await chrome.storage.sync.get(GLOBAL_KEYS);
    const settings = { ...DEFAULTS, ...stored };

    const perVideoEnabled = await readPerVideoEnabled();

    // videoIdKnown: false tells content-script.js that it needs to supply
    // the video ID itself (see the 'videoId' message below).
    post({ type: 'init', settings, perVideoEnabled, videoIdKnown: !!perVideoKey });
  }

  // Push live updates to the page whenever storage changes elsewhere
  // (e.g. the settings panel, or a synced change from another device).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      const relevant = {};
      let any = false;
      for (const key of GLOBAL_KEYS) {
        if (changes[key]) {
          relevant[key] = changes[key].newValue;
          any = true;
        }
      }
      if (any) post({ type: 'update', settings: relevant });
    } else if (area === 'local' && perVideoKey && changes[perVideoKey]) {
      post({ type: 'update', perVideoEnabled: changes[perVideoKey].newValue ?? null });
    }
  });

  // The page (MAIN world) asks us to persist a change - e.g. the settings
  // panel writing a new fontSizePx, or the per-video toggle being flipped.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== 'cat-rescue-page') return;

    // The page telling us which video this is, for URLs where we couldn't
    // tell ourselves. A URL-derived ID is never overridden; either way,
    // answer with the override stored for this video.
    if (msg.type === 'videoId') {
      if (!perVideoKey && typeof msg.videoId === 'string' && /^[\w-]+$/.test(msg.videoId)) {
        perVideoKey = `perVideoEnabled:${msg.videoId}`;
      }
      readPerVideoEnabled().then((perVideoEnabled) => post({ type: 'update', perVideoEnabled }));
      return;
    }

    if (msg.type !== 'save') return;

    if (msg.settings) chrome.storage.sync.set(msg.settings);
    if (perVideoKey && Object.prototype.hasOwnProperty.call(msg, 'perVideoEnabled')) {
      chrome.storage.local.set({ [perVideoKey]: msg.perVideoEnabled });
    }
  });

  sendInitial();
})();
