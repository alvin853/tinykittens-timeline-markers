(function () {
  'use strict';

  // Runs in the MAIN world (see manifest.json's "world": "MAIN" on this
  // file's content_scripts entries) - the real page context directly, no
  // Tampermonkey-style sandboxing to work around, so plain `window`
  // (unlike the userscript version of this file, which needs a
  // pageWindow/unsafeWindow indirection specifically for that) is
  // correct here.

  // ---------------------------------------------------------------------
  // CONFIG — edit these for your setup
  // ---------------------------------------------------------------------
  const CONFIG = {
    // IANA timezone the moderators' wall-clock times are posted in.
    // Using the region name (not a fixed abbreviation like "PDT") means DST
    // is handled automatically across the year.
    chatTimezone: 'America/Vancouver',
    // Only run on live streams from this specific channel, so other
    // videos aren't modified and other viewers aren't confused by an
    // overlay that doesn't apply to them. Channel ID is the primary
    // match (stable even if the display name ever changes); the name is
    // a fallback in case videoDetails omits channelId for some reason.
    allowedChannelId: 'UCeL2LSl91k2VccR7XEh5IKg', // TinyKittens HQ, https://www.youtube.com/@TinyKittens
    allowedChannelName: 'TinyKittens HQ',
    // player.seekTo() (the internal player object's own seek method) seeks
    // using the SAME "seconds since actual stream start" coordinate
    // system as aria-valuemax/valuemin. Confirmed reliable via real-world
    // testing (with the pause-aware retry below for the one case it
    // needed help with) - a separate simulated-click fallback existed
    // earlier but was removed after testing never once found it necessary.
    // While paused, the player's own internal notion of its valid seek
    // range can be stale (confirmed via testing: a seek attempted in
    // this state can silently clamp to the stale range's edge instead of
    // landing on the real target, but the seek ATTEMPT itself appears to
    // trigger the player to reconcile its range with reality shortly
    // after). Only relevant while paused - while actively playing, the
    // bar keeps refreshing on its own, so this adds no delay to the
    // common case. See seekToWhilePaused below.
    pausedSeekRefreshPollIntervalMs: 150,
    pausedSeekRefreshMaxWaitMs: 2000,
    // Whether to only trust timestamps posted by moderators/the channel
    // owner, or parse them from any chat author. User-configurable via
    // the settings panel; see TRUSTED_BADGES below for the actual badge
    // list this checks against.
    moderatorOnly: true,
    markerEmoji: '⏪',
    // Re-render markers this often (ms) - duration keeps growing on a live stream.
    renderIntervalMs: 5000,
    // BroadcastChannel name bridging the chat iframe <-> parent watch page.
    channelName: 'cat-rescue-chat-markers-v1',
    // FALLBACK ONLY: used if the true seekable range (aria-valuemin/
    // aria-valuemax) isn't available when pruning runs. Otherwise,
    // pruneOldEvents uses the actual current window size directly - see
    // pruneOldEvents below.
    maxEventAgeMs: 12 * 60 * 60 * 1000,
    // Verbose console logging for every stage of parsing/rendering. Off
    // by default for regular users - toggleable in the settings panel for
    // when debug data is actually needed (e.g. troubleshooting a report).
    debug: false,
    // Persistent (always-visible, not just on hover) label layout tuning.
    // Nearby labels merge into a single multi-line cluster box instead of
    // each getting its own - rotated text's horizontal footprint is small
    // and roughly constant (~font-size) regardless of label length, which
    // is exactly why rotating them makes clustering tractable. Clustering
    // accounts for how wide a cluster GROWS as it absorbs more members,
    // not just the raw distance to a single neighboring point - otherwise
    // a cluster of several tightly packed events can render wide enough
    // to collide with a label that was originally a comfortable distance
    // away.
    //
    // fontSizePx is the ONE value to change for bigger/smaller text (e.g.
    // for viewers on smaller screens) - the cat-face bubble size, stem
    // length, click-target padding, cluster spacing, and label offset all
    // scale proportionally from it via SIZES below, so nothing else needs
    // separate tuning. This is intentionally the single knob the settings
    // panel exposes (as +/- buttons rather than a raw number input).
    fontSizePx: 14,
    // Hourly time-only markers (no description) at the top of every hour,
    // to make jumping to an arbitrary time mentioned in chat (but not
    // mod-timestamped) quicker. Prepared as a flag now for an eventual
    // settings dialog - flip to false to turn them off entirely.
    showHourlyMarkers: true,
    // Skip an hourly marker if a real (mod-timestamped) event falls
    // within this many seconds of it on either side - avoids a redundant
    // hourly tick sitting right next to an event that already marks
    // roughly that time (e.g. an event at 5:59pm made the 6pm tick
    // pointless).
    hourlyMarkerSuppressWindowSeconds: 30 * 60,
    // Whether the always-visible text labels render at all. When false,
    // only the cat-face bubbles/hourly ticks show (still fully clickable
    // via their tooltips) - useful for viewers who find the labels too
    // busy but still want quick-jump markers.
    showLabels: true,
  };

  // ---------------------------------------------------------------------
  // Everything below is derived from CONFIG.fontSizePx, scaled relative
  // to the size these pixel values were originally tuned at (11px). This
  // is what makes fontSizePx the single knob for the whole overlay's
  // scale - change it once and bubble size, stem length, click-target
  // padding, cluster spacing, and label offset all move together instead
  // of drifting out of proportion with each other.
  // ---------------------------------------------------------------------
  const BASE_FONT_SIZE_PX = 11; // the size these pixel ratios were originally tuned against, NOT the default
  function computeSizes() {
    const scale = CONFIG.fontSizePx / BASE_FONT_SIZE_PX;
    const sizes = {
      fontSizePx: CONFIG.fontSizePx,
      mutedFontSizePx: Math.max(8, CONFIG.fontSizePx - 1), // hourly-tick labels render slightly smaller
      catFaceSizePx: Math.round(18 * scale),
      catFaceStemHeightPx: Math.round(7 * scale),
      catMarkerPaddingPx: Math.round(4 * scale), // enlarges the bubble's click target beyond what's visible
      labelPaddingPx: Math.round(3 * scale),
      labelBorderRadiusPx: Math.round(3 * scale),
      labelLineWidthPx: Math.round(18 * scale), // estimated rendered width of one stacked line, incl. its flex gap (measured: ~26px at fontSizePx 16)
      labelBaseOffsetPx: Math.round(32 * scale), // clears the cat-face bubble + stem
      hourTickHitWidthPx: Math.round(9 * scale),
      hourTickHitHeightPx: Math.round(10 * scale),
    };
    // The gap between stacked lines *within* a cluster, and the minimum
    // gap *required to keep two labels as separate clusters*, are the
    // same value on purpose: singles can drift closer together as space
    // allows, and the instant they'd be as close as an already-grouped
    // line's own internal spacing, they naturally become grouped - no
    // separate arbitrary threshold to reason about.
    sizes.labelLineGapPx = Math.max(1, Math.round(2 * scale));
    sizes.labelClusterGapPx = sizes.labelLineGapPx;
    return sizes;
  }
  let SIZES = computeSizes(); // reassigned (not just mutated) when fontSizePx changes - see the settings message listener near the end of this file

  // Keys the settings panel can change - kept in one list so the message
  // listener and save functions near the end of this file don't drift
  // from each other.
  const GLOBAL_SETTING_KEYS = ['moderatorOnly', 'fontSizePx', 'showLabels', 'showHourlyMarkers', 'debug'];

  // The single place a global setting actually takes effect on CONFIG/
  // SIZES, used uniformly whether the change came from this tab's own
  // settings panel, the initial async load from storage-bridge.js, or a
  // synced change relayed from another device.
  function applyGlobalSetting(name, value) {
    const fontSizeChanged = name === 'fontSizePx' && value !== CONFIG.fontSizePx;
    CONFIG[name] = value;
    if (fontSizeChanged) {
      SIZES = computeSizes();
      log(`Settings: fontSizePx changed to ${CONFIG.fontSizePx}, recomputed SIZES.`);
    }
  }

  // Persisted settings load asynchronously here (not synchronously like
  // the userscript version's GM_getValue, which has no equivalent in a
  // Chrome extension) - see the message listener near the end of this
  // file for where storage-bridge.js's 'init' message actually applies
  // the loaded values via applyGlobalSetting above. Until that arrives,
  // CONFIG's hardcoded defaults (and the SIZES computed from them just
  // above) are what's in effect.

  const inIframe = window.self !== window.top;
  // BroadcastChannel is scoped by name *within the whole origin*, not per
  // tab - two tabs both on youtube.com sharing the same literal channel
  // name would cross-talk, which is exactly the multi-stream mixing bug.
  // Scope it to the video ID so each stream gets its own bus.
  //
  // The chat iframe's own URL (?continuation=...&pageId=...) does NOT
  // carry a v= param, so we can't read it off location.href like the
  // parent page. Instead: the iframe is same-origin with the watch page
  // (both www.youtube.com), so a script inside it can synchronously read
  // window.top.location.href directly - no CORS restriction applies to
  // same-origin frames. document.referrer is a fallback in case that
  // access is ever blocked (e.g. a sandboxed embed elsewhere).
  const videoId = resolveVideoId();
  const channelName = videoId ? `${CONFIG.channelName}:${videoId}` : CONFIG.channelName;
  const bc = new BroadcastChannel(channelName);
  const TAG = '[cat-rescue-markers]';
  const TRUSTED_BADGES = ['MODERATOR', 'OWNER']; // what CONFIG.moderatorOnly checks against
  function log(...args) {
    if (CONFIG.debug) console.log(TAG, ...args);
  }
  log(`videoId=${videoId || '(none found)'}  channel=${channelName}`);

  function getVideoIdFromUrl(href) {
    try {
      return new URL(href).searchParams.get('v');
    } catch (e) {
      return null;
    }
  }

  function resolveVideoId() {
    if (!inIframe) return getVideoIdFromUrl(location.href);

    try {
      const fromTop = getVideoIdFromUrl(window.top.location.href);
      if (fromTop) return fromTop;
    } catch (e) {
      // Blocked (cross-origin embed) - fall through to referrer.
    }

    const fromReferrer = getVideoIdFromUrl(document.referrer);
    if (fromReferrer) return fromReferrer;

    return null;
  }

  // YouTube embeds `window.ytInitialPlayerResponse` on every watch page,
  // carrying videoDetails.isLive / .channelId / .author - exactly what's
  // needed to gate the overlay. The chat iframe is same-origin with the
  // watch page, so it can read window.top.ytInitialPlayerResponse
  // directly too (same trick as resolveVideoId above), meaning both
  // contexts can independently make the same enable/disable decision
  // without any extra cross-frame messaging.
  function getVideoDetails() {
    const src = inIframe ? window.top : window;
    try {
      return src?.ytInitialPlayerResponse?.videoDetails || null;
    } catch (e) {
      return null; // blocked (cross-origin embed somewhere unexpected)
    }
  }

  let lastLoggedEnabledState = null;
  // Manual per-video override from the settings panel: null = no
  // override (use automatic live+channel detection below), true/false =
  // force on/off regardless of what detection would say. Loaded
  // asynchronously via storage-bridge.js's 'init' message, and kept in
  // sync by its 'update' messages - see the settings message listener
  // near the end of this file.
  let perVideoEnabledOverride = null;
  // videoId is already computed above (const videoId = resolveVideoId();) -
  // reused here rather than recomputed.
  const perVideoStorageKey = videoId ? `perVideoEnabled:${videoId}` : null;
  // Only ENABLED when the current video is (a) actually live right now,
  // and (b) on the configured channel - unless perVideoEnabledOverride
  // says otherwise. Checked at processing/render time (not just once at
  // script load) so it stays correct even if videoDetails isn't
  // populated yet when the script first runs.
  function isEnabledForThisVideo() {
    if (perVideoEnabledOverride !== null) {
      if (perVideoEnabledOverride !== lastLoggedEnabledState) {
        lastLoggedEnabledState = perVideoEnabledOverride;
        log(`isEnabledForThisVideo: ${perVideoEnabledOverride ? 'ENABLED' : 'disabled'} - manual per-video override.`);
      }
      return perVideoEnabledOverride;
    }

    const details = getVideoDetails();
    const channelMatches =
      !!details &&
      ((CONFIG.allowedChannelId && details.channelId === CONFIG.allowedChannelId) ||
        (CONFIG.allowedChannelName && details.author === CONFIG.allowedChannelName));
    const enabled = !!(details && details.isLive && channelMatches);

    if (enabled !== lastLoggedEnabledState) {
      lastLoggedEnabledState = enabled;
      log(
        `isEnabledForThisVideo: ${enabled ? 'ENABLED' : 'disabled'} - ` +
          (details
            ? `isLive=${details.isLive}, channelId=${details.channelId}, author=${JSON.stringify(details.author)}`
            : 'videoDetails not available yet (page may still be loading)')
      );
    }
    return enabled;
  }

  // =======================================================================
  // CONTEXT A: runs inside the live_chat iframe
  // Responsible for: intercepting the polling requests, extracting events,
  // broadcasting them to the parent page.
  // =======================================================================
  if (inIframe) {
    log('Running inside chat iframe. Hooking fetch + XHR for get_live_chat...');
    hookFetch();
    hookXHR();
    hookInitialData();
  } else {
    log('Running in parent watch page. Waiting for events over BroadcastChannel...');
  }

  // The chat iframe's initial HTML embeds the currently-visible backlog as
  // `window["ytInitialData"] = {...}` in an inline <script>. Since this
  // content script runs at document_start (before the page's own scripts
  // run - see manifest.json), we can define a property setter that fires
  // the moment YouTube assigns it, letting us parse the backlog the same
  // way we parse poll responses.
  function hookInitialData() {
    let captured = false;
    // Closure-scoped, NOT stored on `this` (e.g. this.__ytInitialDataValue).
    // An earlier version of this getter/setter used `this` as the backing
    // store - fragile in general, since it depends on the accessor always
    // being invoked with the expected receiver bound (this script runs in
    // strict mode, where a function called without an explicit receiver
    // gets `this === undefined` rather than falling back to the global
    // object). A plain closure variable has no such dependency, so it's
    // used instead.
    let capturedValue;
    try {
      Object.defineProperty(window, 'ytInitialData', {
        configurable: true,
        enumerable: true,
        get() {
          return capturedValue;
        },
        set(value) {
          capturedValue = value;
          if (!captured) {
            captured = true;
            log('Captured window.ytInitialData (initial chat backlog).');
            handleLiveChatResponse(value);
          }
        },
      });
    } catch (e) {
      log('Could not hook ytInitialData setter, falling back to polling for it.', e);
    }

    // Fallback in case the property was already set before our hook attached
    // (shouldn't normally happen at document-start, but cheap to guard against).
    window.addEventListener('DOMContentLoaded', () => {
      if (!captured && window.ytInitialData) {
        captured = true;
        log('ytInitialData was already present on DOMContentLoaded - parsing it now.');
        handleLiveChatResponse(window.ytInitialData);
      }
    });
  }

  function hookFetch() {
    const nativeFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await nativeFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (url && url.includes('/youtubei/v1/live_chat/get_live_chat')) {
          response
            .clone()
            .json()
            .then(handleLiveChatResponse)
            .catch(() => {});
        }
      } catch (e) {
        /* ignore - never break the real request */
      }
      return response;
    };
  }

  function hookXHR() {
    const nativeOpen = window.XMLHttpRequest.prototype.open;
    const nativeSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__isLiveChat =
        typeof url === 'string' && url.includes('/youtubei/v1/live_chat/get_live_chat');
      return nativeOpen.call(this, method, url, ...rest);
    };
    window.XMLHttpRequest.prototype.send = function (...args) {
      if (this.__isLiveChat) {
        this.addEventListener('load', () => {
          try {
            handleLiveChatResponse(JSON.parse(this.responseText));
          } catch (e) {
            /* ignore */
          }
        });
      }
      return nativeSend.apply(this, args);
    };
  }

  function handleLiveChatResponse(data) {
    if (!isEnabledForThisVideo()) return;

    // Polling responses nest actions under continuationContents.liveChatContinuation.
    // The initial page-load backlog (window.ytInitialData) nests them under
    // contents.liveChatRenderer instead. Check both.
    const actions =
      data?.continuationContents?.liveChatContinuation?.actions ||
      data?.contents?.liveChatRenderer?.actions ||
      [];
    log(`Got live_chat response with ${actions.length} action(s).`);
    const found = [];

    for (const action of actions) {
      const renderer = action?.addChatItemAction?.item?.liveChatTextMessageRenderer;
      if (!renderer) continue;

      const authorName = renderer.authorName?.simpleText || '(unknown)';

      if (CONFIG.moderatorOnly) {
        const badges = renderer.authorBadges || [];
        const badgeTypes = badges.map((b) => b?.liveChatAuthorBadgeRenderer?.icon?.iconType);
        const isTrusted = badgeTypes.some((t) => TRUSTED_BADGES.includes(t));
        if (!isTrusted) {
          log(`Skipping message from ${authorName} - no trusted badge (has: ${badgeTypes.join(', ') || 'none'})`);
          continue;
        }
      }

      const text = extractRunText(renderer.message?.runs);
      log(`Trusted message from ${authorName}:`, JSON.stringify(text));

      if (!text.includes(CONFIG.markerEmoji)) {
        log('  no marker emoji in this message - skipping.');
        continue;
      }

      const sentAtMs = renderer.timestampUsec
        ? Math.floor(Number(renderer.timestampUsec) / 1000)
        : Date.now();
      log(`  message sentAt = ${new Date(sentAtMs).toString()}`);

      const events = extractEvents(text, sentAtMs);
      if (!events.length) {
        log('  no events parsed out of this message - check the regex against the raw text above.');
      }
      for (const evt of events) {
        const secondsAgo = (Date.now() - evt.epochMs) / 1000;
        log(
          `  parsed event: "${evt.label}" @ ${new Date(evt.epochMs).toString()} ` +
            `(~${Math.floor(secondsAgo / 60)} min ago)`
        );
        found.push(evt);
      }
    }

    if (found.length) {
      log(`Broadcasting ${found.length} event(s) to parent page.`);
      bc.postMessage({ type: 'events', events: found });
    }
  }

  // Chat message runs come in two flavors: plain { text } runs, and
  // { emoji } runs for anything rendered as an emoji (including ⏪, which
  // YouTube treats as an emoji rather than embedding its literal unicode
  // character inside a text run). Reconstruct the full string from both.
  function extractRunText(runs) {
    return (runs || [])
      .map((r) => {
        if (typeof r.text === 'string') return r.text;
        if (r.emoji) return r.emoji.emojiId || r.emoji.shortcuts?.[0] || '';
        return '';
      })
      .join('');
  }

  // Splits a message on the rewind emoji since mods sometimes chain several
  // entries in one line, e.g. "⏪ 8:14 PM - dinner⏪ 8:44 PM - post-dinner".
  function extractEvents(text, sentAtMs) {
    const out = [];
    const chunks = text
      .split(CONFIG.markerEmoji)
      .map((c) => c.trim())
      .filter(Boolean);

    for (const chunk of chunks) {
      const match = chunk.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s*-\s*(.+)$/);
      if (!match) continue;
      const [, hh, mm, meridiem, label] = match;
      const eventDate = resolveEventDate(hh, mm, meridiem, sentAtMs);
      out.push({ epochMs: eventDate.getTime(), label: label.trim() });
    }
    return out;
  }

  // Combines a wall-clock time (e.g. "8:14 PM" in chatTimezone) with the date
  // the chat message was actually sent, rolling back a day if the resulting
  // time would be implausibly in the future relative to the message
  // (covers events posted just after midnight referencing "yesterday").
  function resolveEventDate(hh, mm, meridiem, sentAtMs) {
    let hour = parseInt(hh, 10) % 12;
    if (meridiem.toUpperCase() === 'PM') hour += 12;
    const minute = parseInt(mm, 10);

    const sentDate = new Date(sentAtMs);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CONFIG.chatTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(sentDate)
      .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

    const candidate = zonedTimeToUtc(
      Number(parts.year),
      Number(parts.month),
      Number(parts.day),
      hour,
      minute,
      CONFIG.chatTimezone
    );
    log(
      `  resolveEventDate: ${hh}:${mm}${meridiem} in ${CONFIG.chatTimezone} on ${parts.year}-${parts.month}-${parts.day} ` +
        `-> offset=${getUtcOffsetMinutes(candidate, CONFIG.chatTimezone)}min -> ${candidate.toISOString()}`
    );

    if (candidate.getTime() - sentAtMs > 2 * 60 * 60 * 1000) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    return candidate;
  }

  // Builds a UTC Date for a given wall-clock date/time in an IANA timezone.
  // Uses Intl's shortOffset (e.g. "GMT-7") to get the zone's actual UTC
  // offset at that moment directly, rather than the common "format into
  // the zone, then re-parse the string as browser-local time" trick -
  // that trick round-trips through Date string parsing twice and can
  // land on the wrong side of a DST boundary in some environments.
  function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
    // Numbers as if they were UTC - just a scratch value to look up the
    // zone's offset for approximately this date; a day or two of error
    // here would never flip which side of a DST transition we're on.
    const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute);
    const offsetMinutes = getUtcOffsetMinutes(new Date(naiveUtcMs), timeZone);
    // offsetMinutes follows "zoneTime = UTC + offsetMinutes" (so PDT = -420).
    // Solving for UTC: UTC = zoneTime - offsetMinutes.
    return new Date(naiveUtcMs - offsetMinutes * 60000);
  }

  // Returns the timeZone's UTC offset in minutes at the given instant,
  // e.g. -420 for PDT (UTC-7), -480 for PST (UTC-8), 0 for UTC.
  function getUtcOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
    const match = raw.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
    if (!match) return 0;
    const sign = match[1].startsWith('-') ? -1 : 1;
    const hours = Math.abs(parseInt(match[1], 10));
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    return sign * (hours * 60 + minutes);
  }

  // =======================================================================
  // CONTEXT B: runs in the parent watch page
  // Responsible for: collecting broadcast events, drawing markers on the
  // real player progress bar, handling clicks to seek.
  // =======================================================================
  // Exposed at module scope (not just inside the block below) so the
  // settings message listener near the end of this file can force an
  // immediate re-render when a setting changes, without waiting for the
  // next poll/interval tick. Stays null in the chat-iframe context.
  let currentSeenEvents = null;

  if (!inIframe) {
    // Not gated on isEnabledForThisVideo() - the button needs to exist on
    // every watch page regardless of live/channel match, since it's the
    // only way to reach the per-video override that could turn things ON
    // for a video that wouldn't otherwise auto-enable.
    //
    // Wrapped defensively: this whole file runs as one top-level IIFE, so
    // an uncaught error in this comparatively minor UI piece would
    // otherwise halt every synchronous statement after it too, including
    // the marker-rendering setup below (this is exactly what happened
    // with the earlier document.body-at-document_start bug).
    try {
      ensureSettingsButton();
    } catch (e) {
      log('ensureSettingsButton failed (non-fatal, continuing without the player button):', e);
    }

    const seenEvents = new Map(); // key: `${epochMs}|${label}` -> {epochMs, label}
    currentSeenEvents = seenEvents;

    bc.onmessage = (msg) => {
      if (msg.data?.type !== 'events') return;
      log(`Parent received ${msg.data.events.length} event(s) from chat iframe.`);
      for (const evt of msg.data.events) {
        // Keyed by time only (not time+label): mods sometimes re-post the
        // same timestamp with an updated/corrected description, and that
        // should replace the existing marker rather than create a
        // duplicate alongside it.
        seenEvents.set(String(evt.epochMs), evt);
      }
      pruneOldEvents(seenEvents);
      renderMarkers(seenEvents);
    };

    setInterval(() => {
      pruneOldEvents(seenEvents);
      renderMarkers(seenEvents);
    }, CONFIG.renderIntervalMs);
  }

  // Drops any event that's fallen outside the current true seekable range
  // - it can never be placed on the bar, so there's no reason to keep it
  // in memory for a 24/7 stream. Queries a live (non-pause-corrected)
  // reading directly, since pruning only needs a reasonable upper bound
  // on how far back an event could still matter, not split-second
  // precision - falls back to the fixed maxEventAgeMs estimate if the
  // true range isn't available for some reason.
  function pruneOldEvents(seenEvents) {
    const progressBar = document.querySelector('.ytp-progress-bar');
    const trueRange = getTrueSeekableRange(progressBar);
    const maxAgeMs = trueRange ? (trueRange.end - trueRange.start) * 1000 : CONFIG.maxEventAgeMs;

    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [key, evt] of seenEvents) {
      if (evt.epochMs < cutoff) {
        seenEvents.delete(key);
        removed++;
      }
    }
    if (removed) {
      log(
        `pruneOldEvents: dropped ${removed} event(s) older than ${(maxAgeMs / 3600000).toFixed(2)}h ` +
          `(${trueRange ? 'true range' : 'fallback estimate'}). ${seenEvents.size} remaining.`
      );
    }
  }

  // The progress bar's own ARIA slider attributes (aria-valuemin/
  // aria-valuemax) describe the REAL rendered bounds of the bar itself,
  // in a "seconds since the actual stream started" coordinate system
  // (confirmed by decoding aria-valuetext, which matches these numbers
  // exactly, and matches player.getCurrentTime()/getDuration() - a
  // DIFFERENT coordinate system than video.currentTime/video.duration,
  // which are anchored to whatever the currently-loaded media buffer
  // considers its own zero point). This is the authoritative source: no
  // guessing at a nominal window length, no clamping - whatever the bar
  // itself is actually showing right now, including cases where the
  // window runs past the nominal 12h (observed during an extended pause)
  // or is temporarily unusual for some other reason.
  // ---------------------------------------------------------------------
  // Pause correction. YouTube's progress bar (and its aria attributes)
  // appears to stop updating while the LOCAL player is paused - this is a
  // player/UI-level freeze specific to this viewer's own paused state,
  // not a stream-side event (unlike the stream-gap detector above, which
  // handles the feed itself dropping for everyone - a different
  // phenomenon that happens to look similar, kept as a separate
  // mechanism on purpose rather than reused/extended for this).
  //
  // Rather than depending on exactly how that freeze behaves internally,
  // this only relies on two things that are unambiguous: precisely when
  // a pause starts and precisely when it ends, both from native video
  // events. The moment pausing begins, the true range is snapshotted
  // while still fresh; while paused, that snapshot is offset forward by
  // however much real time has elapsed since, instead of re-reading the
  // (possibly stale) DOM at all. The instant playback resumes, the
  // snapshot is dropped and the live DOM is trusted again - this assumes
  // resuming snaps the bar back to the correct position immediately
  // rather than leaving a permanent gap, matching what was observed
  // (worth reconfirming this holds once tested for real).
  // ---------------------------------------------------------------------
  let pauseStartedAtMs = null;
  let pauseSnapshotRange = null;
  let pauseListenersAttached = false;

  // Shared by the 'pause' handler and the 'seeked' handler below - a
  // fresh snapshot is needed at both moments: when a pause begins, and
  // whenever the position changes WHILE paused (see 'seeked' below).
  function refreshPauseSnapshot(progressBar, reason) {
    pauseStartedAtMs = Date.now();
    pauseSnapshotRange = getTrueSeekableRange(progressBar);
    log(
      pauseSnapshotRange
        ? `${reason} - snapshotting true range=[${pauseSnapshotRange.start.toFixed(1)}, ${pauseSnapshotRange.end.toFixed(1)}].`
        : `${reason} - no true range available to snapshot, will fall back to live reads/estimate.`
    );
  }

  function ensurePauseTracking(video, progressBar) {
    if (pauseListenersAttached || !video) return;
    pauseListenersAttached = true;

    video.addEventListener('pause', () => {
      refreshPauseSnapshot(progressBar, 'Paused');
    });

    // Seeking while paused (whether the person manually dragged the
    // scrubber, or clicked one of our own markers) visibly updates the
    // bar even though the passage of time alone doesn't - the person's
    // own testing confirmed this. 'seeked' fires either way, so this
    // covers both without needing to tell them apart: take a fresh
    // snapshot and restart the offset-tracking clock from this new,
    // known-correct point, rather than continuing to extrapolate from
    // the original (now-outdated) pre-seek snapshot.
    video.addEventListener('seeked', () => {
      if (video.paused) {
        refreshPauseSnapshot(progressBar, 'Seeked while paused');
      }
    });

    video.addEventListener('play', () => {
      if (pauseStartedAtMs !== null) {
        const pausedForSec = (Date.now() - pauseStartedAtMs) / 1000;
        log(`Resumed after ~${pausedForSec.toFixed(1)}s paused - trusting live bar values again.`);
      }
      pauseStartedAtMs = null;
      pauseSnapshotRange = null;
    });

    // If the video was ALREADY paused by the time this attached (e.g.
    // the script's first render pass happens mid-pause), the 'pause'
    // event itself already fired and was missed - without this, we'd
    // have no snapshot at all until the NEXT full pause/resume cycle,
    // leaving the current, already-in-progress pause uncorrected. Take
    // a snapshot now as a best-effort catch-up; it may already be
    // slightly stale by this point, but that's strictly better than no
    // correction at all for the remainder of this pause.
    if (video.paused) {
      refreshPauseSnapshot(progressBar, 'Already paused when tracking attached');
    }
  }

  // Returns the true range, correcting for the pause-freeze if currently
  // paused with a valid snapshot; otherwise just the live read.
  function getPauseCorrectedTrueRange(progressBar) {
    if (pauseStartedAtMs !== null && pauseSnapshotRange) {
      const pausedForSec = (Date.now() - pauseStartedAtMs) / 1000;
      return {
        start: pauseSnapshotRange.start + pausedForSec,
        end: pauseSnapshotRange.end + pausedForSec,
      };
    }
    return getTrueSeekableRange(progressBar);
  }

  function getTrueSeekableRange(progressBar) {
    if (!progressBar) return null;
    const minAttr = progressBar.getAttribute('aria-valuemin');
    const maxAttr = progressBar.getAttribute('aria-valuemax');
    if (minAttr === null || maxAttr === null) return null;
    const start = parseFloat(minAttr);
    const end = parseFloat(maxAttr);
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    return { start, end };
  }

  function getPlayerRoot() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  // player.getCurrentTime() reports in the same "seconds since actual
  // stream start" coordinate system as aria-valuemax/valuemin - distinct
  // from video.currentTime, which is anchored to the currently-loaded
  // media buffer's own zero point instead. Wrapped defensively since
  // this is an internal (undocumented) property of the player element,
  // not a stable public API - it could change or be missing in some
  // player builds.
  function tryGetPlayerTrueCurrentTime() {
    try {
      const playerRoot = getPlayerRoot();
      const t = playerRoot && typeof playerRoot.getCurrentTime === 'function' ? playerRoot.getCurrentTime() : null;
      return typeof t === 'number' && isFinite(t) ? t : null;
    } catch (e) {
      return null;
    }
  }

  // Entry point for all seeking. When we have true (aria-derived)
  // coordinates, player.seekTo() - the player's own internal seek method,
  // using the exact same coordinate system aria-valuemax/valuemin do -
  // Entry point for all seeking. player.seekTo() - the player's own
  // internal seek method, using the exact same coordinate system
  // aria-valuemax/valuemin do - confirmed reliable via real-world
  // testing (with the pause-aware retry below for the one case it
  // needed help with). A simulated-click fallback existed here
  // previously but was removed after testing never once found it
  // necessary; logSeekDriftOutcome below is now purely diagnostic
  // rather than triggering a fallback.
  function seekTo(video, progressBar, intendedSeconds) {
    const playerRoot = getPlayerRoot();
    if (!playerRoot || typeof playerRoot.seekTo !== 'function') {
      log('seekTo: player.seekTo not available - cannot seek.');
      return;
    }

    // Only relevant while paused - see seekToWhilePaused for why. While
    // actively playing, the bar keeps refreshing on its own, so the
    // ordinary path below (unchanged) applies with no extra delay.
    if (video.paused) {
      seekToWhilePaused(intendedSeconds, progressBar, playerRoot);
      return;
    }

    try {
      log(`seekTo: trying player.seekTo(${intendedSeconds.toFixed(1)}, true)`);
      playerRoot.seekTo(intendedSeconds, true);
    } catch (e) {
      log('seekTo: player.seekTo threw.', e);
      return;
    }

    setTimeout(() => logSeekDriftOutcome(intendedSeconds), 400);
  }

  // While paused, the player's own internal notion of its valid seek
  // range can go stale (frozen since the pause began, or since the last
  // seek) - a seek attempted in this state can silently clamp to wherever
  // the player still thinks the edge is, rather than landing on the real
  // target. Confirmed via testing: the FIRST seek attempt in this
  // situation both lands wrong AND appears to trigger the player to
  // reconcile its internal range with reality shortly after (visible as
  // aria-valuemax jumping forward within about a second). So: watch for
  // that jump, and if it happens, retry the SAME seek once - this mirrors
  // exactly what manually clicking a marker a second time was already
  // doing to work around this. If no jump is detected within the poll
  // window, nothing was stale to begin with - proceed straight to
  // logging the drift outcome.
  function seekToWhilePaused(intendedSeconds, progressBar, playerRoot) {
    const staleValueMax = progressBar.getAttribute('aria-valuemax');

    try {
      log(`seekTo: trying player.seekTo(${intendedSeconds.toFixed(1)}, true) (paused - watching for a stale-range refresh)`);
      playerRoot.seekTo(intendedSeconds, true);
    } catch (e) {
      log('seekTo: player.seekTo threw.', e);
      return;
    }

    const startedAtMs = Date.now();

    function poll() {
      const currentValueMax = progressBar.getAttribute('aria-valuemax');
      if (currentValueMax !== null && currentValueMax !== staleValueMax) {
        log(`seekTo: detected stale-range refresh (aria-valuemax ${staleValueMax} -> ${currentValueMax}) - retrying seek.`);
        try {
          playerRoot.seekTo(intendedSeconds, true);
        } catch (e) {
          log('seekTo: retry player.seekTo threw.', e);
          return;
        }
        setTimeout(() => logSeekDriftOutcome(intendedSeconds), 400);
        return;
      }

      if (Date.now() - startedAtMs >= CONFIG.pausedSeekRefreshMaxWaitMs) {
        log(`seekTo: no stale-range refresh detected within ${CONFIG.pausedSeekRefreshMaxWaitMs}ms - proceeding to normal drift check.`);
        logSeekDriftOutcome(intendedSeconds);
        return;
      }

      setTimeout(poll, CONFIG.pausedSeekRefreshPollIntervalMs);
    }

    setTimeout(poll, CONFIG.pausedSeekRefreshPollIntervalMs);
  }

  // Purely diagnostic - no fallback left to trigger, and no threshold to
  // pre-filter "acceptable" from "not," since that distinction doesn't
  // actually help once there's no corrective action tied to it. Just logs
  // the real drift amount, unfiltered, for whenever it's actually needed.
  function logSeekDriftOutcome(intendedSeconds) {
    const actualTrue = tryGetPlayerTrueCurrentTime();
    const drift = actualTrue === null ? null : Math.abs(actualTrue - intendedSeconds);
    log(`seekTo: landed ${drift === null ? 'at an unknown position (player.getCurrentTime unavailable)' : `${drift.toFixed(1)}s from intended target`}.`);
  }

  function renderMarkers(seenEvents) {
    if (!isEnabledForThisVideo()) {
      // Clean up any markers left over from a previously-matching video,
      // in case of a client-side (SPA) navigation without a full reload.
      const stale = document.querySelector('#cat-rescue-markers');
      if (stale) {
        stale.remove();
        log('renderMarkers: video no longer matches (not live, or wrong channel) - removed existing markers.');
      }
      return;
    }

    const video = document.querySelector('video');
    const progressBar = document.querySelector('.ytp-progress-bar');
    if (!video || !progressBar) {
      log('renderMarkers: video or progress bar not found yet in DOM.', { video: !!video, progressBar: !!progressBar });
      return;
    }
    if (!video.duration || !isFinite(video.duration)) {
      log('renderMarkers: video.duration not ready yet:', video.duration);
      return;
    }

    ensurePauseTracking(video, progressBar);

    const trueRange = getPauseCorrectedTrueRange(progressBar);
    if (!trueRange) {
      log('renderMarkers: true seekable range not available (aria attributes missing?) - skipping render.');
      return;
    }
    const { start: seekStart, end: seekEnd } = trueRange;
    const seekWindow = seekEnd - seekStart;
    if (!seekWindow || !isFinite(seekWindow) || seekWindow <= 0) {
      log('renderMarkers: invalid seekable window, skipping render.', { seekStart, seekEnd });
      return;
    }
    log(
      `renderMarkers: seekable=[${seekStart.toFixed(1)}, ${seekEnd.toFixed(1)}] ` +
        `(window=${(seekWindow / 3600).toFixed(2)}h, source=aria-valuemin/valuemax, video.duration=${video.duration.toFixed(1)}s for reference)`
    );

    // Attach to the *container*, not .ytp-progress-bar itself - YouTube
    // repaints/resizes the bar on hover (that's what was swallowing the
    // markers), but the container stays stable and sits underneath it.
    const container = progressBar.closest('.ytp-progress-bar-container') || progressBar.parentElement;

    let layer = container.querySelector('#cat-rescue-markers');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'cat-rescue-markers';
      Object.assign(layer.style, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '2147483647', // always paint above the bar and its hover states
      });
      const computedPosition = getComputedStyle(container).position;
      if (computedPosition === 'static') container.style.position = 'relative';
      container.appendChild(layer);
    }
    // NOTE: innerHTML = '' throws under YouTube's Trusted Types CSP
    // ("This document requires 'TrustedHTML' assignment"). textContent/
    // replaceChildren don't go through that sink, so use those to clear.
    layer.textContent = '';

    const now = Date.now();
    const barWidthPx = container.getBoundingClientRect().width;

    // Phase 1: figure out which chat-based events are actually on the bar
    // right now, and where.
    const visible = [];
    for (const { epochMs, label } of seenEvents.values()) {
      const secondsAgo = (now - epochMs) / 1000;
      // seekEnd is the actual live edge (not video.duration - they can
      // differ slightly, but seekEnd is the number the bar itself uses).
      const positionSeconds = seekEnd - secondsAgo;
      if (positionSeconds < seekStart || positionSeconds > seekEnd) {
        log(
          `renderMarkers: "${label}" is out of the seekable window ` +
            `(positionSeconds=${positionSeconds.toFixed(1)}, range=[${seekStart.toFixed(1)}, ${seekEnd.toFixed(1)}]) - not placed.`
        );
        continue;
      }
      const pct = ((positionSeconds - seekStart) / seekWindow) * 100;
      visible.push({ epochMs, label, secondsAgo, positionSeconds, pct, xPx: (pct / 100) * barWidthPx, isHourly: false });
    }

    // Optional hourly time-only markers (no description) - a quick way to
    // jump to roughly a time mentioned in chat that a mod never
    // timestamped. Same window math as chat events, converted from the
    // seekable range back to real wall-clock time: position x corresponds
    // to real time (now - secondsAgo(x)), so the window covers
    // [now - seekWindow, now].
    if (CONFIG.showHourlyMarkers) {
      const hourlyEpochs = getHourlyEpochsInRange(now - seekWindow * 1000, now);
      const suppressMs = CONFIG.hourlyMarkerSuppressWindowSeconds * 1000;
      // `visible` at this point contains only the chat-based events from
      // phase 1 above (hourly markers haven't been added yet), so this
      // checks proximity to real events, not to other hourly ticks.
      for (const epochMs of hourlyEpochs) {
        const nearbyEvent = visible.find((v) => Math.abs(v.epochMs - epochMs) <= suppressMs);
        if (nearbyEvent) {
          log(
            `renderMarkers: suppressing hourly marker at ${formatWallClock(epochMs)} - ` +
              `"${nearbyEvent.label}" is within ${CONFIG.hourlyMarkerSuppressWindowSeconds / 60}min of it.`
          );
          continue;
        }
        const secondsAgo = (now - epochMs) / 1000;
        const positionSeconds = seekEnd - secondsAgo;
        if (positionSeconds < seekStart || positionSeconds > seekEnd) continue;
        const pct = ((positionSeconds - seekStart) / seekWindow) * 100;
        visible.push({ epochMs, label: '', secondsAgo, positionSeconds, pct, xPx: (pct / 100) * barWidthPx, isHourly: true });
      }
    }

    // Phase 2: group labels that are too close together into a single
    // multi-line cluster instead of stacking them into separate rows.
    // Each event still gets its own bubble/tick at its own exact
    // position on the bar - only the *text label* merges, with each
    // line inside the merged box independently clickable to its own
    // timestamp.
    //
    // Each cluster is centered on the average x of its members and
    // estimated to be `members.length * labelLineWidthPx` wide. Two
    // clusters merge if their estimated EDGES would come within
    // labelClusterGapPx of each other - not just if their center points
    // are close - because a cluster that's already absorbed several
    // members can be wide enough to collide with a neighbor that was
    // originally a comfortable distance away. Repeats until a full pass
    // produces no more merges, so a merge that newly overlaps a further
    // neighbor (a cascade) gets caught too.
    visible.sort((a, b) => a.xPx - b.xPx);
    let clusters = visible.map((evt) => ({ members: [evt], centerXPx: evt.xPx }));

    const clusterWidthPx = (cluster) => cluster.members.length * SIZES.labelLineWidthPx;
    const clusterLeftEdge = (cluster) => cluster.centerXPx - clusterWidthPx(cluster) / 2;
    const clusterRightEdge = (cluster) => cluster.centerXPx + clusterWidthPx(cluster) / 2;
    const recenter = (cluster) => {
      cluster.centerXPx = cluster.members.reduce((sum, m) => sum + m.xPx, 0) / cluster.members.length;
    };

    let mergedAny = true;
    while (mergedAny) {
      mergedAny = false;
      const next = [];
      for (const cluster of clusters) {
        const prev = next[next.length - 1];
        if (prev && clusterLeftEdge(cluster) - clusterRightEdge(prev) < SIZES.labelClusterGapPx) {
          prev.members.push(...cluster.members);
          recenter(prev);
          mergedAny = true;
        } else {
          next.push(cluster);
        }
      }
      clusters = next;
    }

    // Phase 3a: bubbles/ticks, one per event, at each event's own position.
    let placed = 0;
    for (const evt of visible) {
      placed++;
      const doSeek = () => seekTo(video, progressBar, evt.positionSeconds);

      if (evt.isHourly) {
        log(`renderMarkers: placing hourly tick at ${evt.pct.toFixed(2)}% (${formatWallClock(evt.epochMs)})`);
        const tick = buildHourTick();
        tick.style.left = `${evt.pct}%`;
        tick.title = formatWallClock(evt.epochMs);
        tick.addEventListener('click', (e) => {
          e.stopPropagation();
          doSeek();
        });
        layer.appendChild(tick);
        continue;
      }

      log(`renderMarkers: placing "${evt.label}" at ${evt.pct.toFixed(2)}% (positionSeconds=${evt.positionSeconds.toFixed(1)})`);
      const marker = buildCatMarker(evt.label, formatAgo(evt.secondsAgo), formatWallClock(evt.epochMs));
      marker.style.left = `${evt.pct}%`;
      marker.addEventListener('click', (e) => {
        e.stopPropagation();
        doSeek();
      });
      layer.appendChild(marker);
    }

    // Phase 3b: one label per cluster, anchored at the cluster's average
    // x position, containing one independently-clickable line per member.
    // Skipped entirely when showLabels is off - bubbles/ticks (and their
    // hover tooltips) still render from Phase 3a above either way.
    if (CONFIG.showLabels) {
      for (const cluster of clusters) {
        const centerXPx = cluster.members.reduce((sum, m) => sum + m.xPx, 0) / cluster.members.length;
        const centerPct = (centerXPx / barWidthPx) * 100;
        if (cluster.members.length > 1) {
          log(`renderMarkers: clustering ${cluster.members.length} label(s) at ${centerPct.toFixed(2)}%: ${cluster.members.map((m) => m.isHourly ? formatWallClock(m.epochMs) : m.label).join(' | ')}`);
        }
        const clusterLabel = buildClusterLabel(cluster.members, video, progressBar);
        clusterLabel.style.left = `${centerPct}%`;
        layer.appendChild(clusterLabel);
      }
    }

    log(`renderMarkers: placed ${placed}/${visible.length} marker(s) in ${clusters.length} label cluster(s) (${seenEvents.size} chat-based event(s) tracked).`);
  }

  // Generates epoch times for every on-the-hour wall-clock boundary (in
  // chatTimezone) within [earliestMs, latestMs], for the optional hourly
  // time-only markers. Walks backward from the current hour in fixed
  // 1-hour steps; this can be off by an hour on the two days per year a
  // DST transition actually happens, which is an acceptable approximation
  // for a "quick jump to roughly this time" aid rather than a precise marker.
  function getHourlyEpochsInRange(earliestMs, latestMs) {
    const epochs = [];
    const nowDate = new Date(latestMs);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CONFIG.chatTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(nowDate)
      .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

    let candidateMs = zonedTimeToUtc(
      Number(parts.year),
      Number(parts.month),
      Number(parts.day),
      Number(parts.hour) % 24,
      0,
      CONFIG.chatTimezone
    ).getTime();

    // Step backward one hour at a time until we're outside the window.
    while (candidateMs >= earliestMs - 3600000) {
      if (candidateMs <= latestMs) epochs.push(candidateMs);
      candidateMs -= 3600000;
    }
    return epochs;
  }

  // The on-screen clock overlay on the stream itself shows wall-clock
  // time, so surfacing that same wall-clock time (not just "N min ago")
  // makes it much easier to cross-reference a marker against what's on
  // screen at that moment.
  function formatWallClock(epochMs) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: CONFIG.chatTimezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(epochMs));
  }

  // Builds a small cat-face bubble on a stem, floating just above the
  // progress bar. Built entirely via DOM/SVG element creation (not
  // innerHTML) so it's unaffected by the page's Trusted Types policy.
  function buildCatMarker(label, agoText, wallClockText) {
    const wrapper = document.createElement('div');
    wrapper.title = `${label} — ${wallClockText} (${agoText})`;
    Object.assign(wrapper.style, {
      position: 'absolute',
      bottom: '2px',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      pointerEvents: 'auto',
      cursor: 'pointer',
      padding: `${SIZES.catMarkerPaddingPx}px ${Math.round(SIZES.catMarkerPaddingPx * 0.75)}px`, // enlarges the click target beyond the visible bubble
    });

    const svg = buildCatFaceSvg();
    wrapper.appendChild(svg);

    const stem = document.createElement('div');
    Object.assign(stem.style, {
      width: '2px',
      height: `${SIZES.catFaceStemHeightPx}px`,
      background: '#ffb703',
    });
    wrapper.appendChild(stem);

    wrapper.addEventListener('mouseenter', () => {
      svg.style.transform = 'scale(1.2)';
    });
    wrapper.addEventListener('mouseleave', () => {
      svg.style.transform = 'scale(1)';
    });

    return wrapper;
  }

  // Always-visible label (not hover-only) so descriptions can be scanned
  // at a glance. Rendered as rotated (vertical) text: since these are
  // short (2-5 words), rotating means the label's horizontal footprint on
  // the bar is just its font-size, regardless of text length.
  //
  // Rotation direction: plain `writing-mode: vertical-rl` reads top-to-
  // bottom (first character at the top). Adding `rotate(180deg)` flips
  // both the reading order AND the glyph orientation together, so the
  // text instead starts at the bottom and reads upward - this is the
  // standard trick for that reading direction, since `sideways-lr` (the
  // "correct" CSS keyword for it) isn't reliably supported across
  // browsers. The 180deg rotation is symmetric around each line's own
  // center, so it doesn't affect the width/height used for layout.
  //
  // One label box per *cluster* of nearby events (see Phase 2 above),
  // not one per event: each cluster member renders as its own line
  // inside a shared flex row. Because each line's native (pre-rotation)
  // layout box is already narrow (vertical-rl's box width is ~ one line
  // of text, its height is the text run length), a plain flexbox row
  // lays multiple rotated lines out side-by-side with no manual
  // measurement or overlap math needed - and each line keeps its own
  // click handler, seeking to its own timestamp independent of its
  // neighbors.
  function buildClusterLabel(members, video, progressBar) {
    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
      position: 'absolute',
      bottom: `${SIZES.labelBaseOffsetPx}px`,
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: `${SIZES.labelLineGapPx}px`,
      pointerEvents: 'none', // wrapper is just a positioning box - each line below opts itself back in
    });

    for (const m of members) {
      const muted = m.isHourly;
      const line = document.createElement('div');
      line.textContent = muted ? formatWallClock(m.epochMs) : `${formatWallClock(m.epochMs)} · ${m.label}`;
      line.title = muted ? formatWallClock(m.epochMs) : `${m.label} — ${formatWallClock(m.epochMs)} (${formatAgo(m.secondsAgo)})`;
      Object.assign(line.style, {
        writingMode: 'vertical-rl',
        // Default text-orientation ('mixed') consults a Unicode table to
        // decide per-character whether to rotate or use a special glyph
        // form - certain punctuation (notably apostrophes/quotes) gets
        // treated differently from surrounding letters under that table,
        // which is exactly what caused the "rotated too far, looks like
        // a dash, weird gap after it" symptom. 'sideways' instead rotates
        // the whole run uniformly, as if it were one continuous strip of
        // normal horizontal text laid on its side - no per-character
        // special-casing, so punctuation renders consistently with the
        // letters around it.
        textOrientation: 'sideways',
        transform: 'rotate(180deg)',
        whiteSpace: 'nowrap',
        fontSize: `${muted ? SIZES.mutedFontSizePx : SIZES.fontSizePx}px`,
        fontFamily: 'Roboto, Arial, sans-serif',
        color: muted ? 'rgba(255, 255, 255, 0.75)' : '#fff',
        background: muted ? 'rgba(0, 0, 0, 0.35)' : 'rgba(0, 0, 0, 0.55)',
        padding: `${SIZES.labelPaddingPx}px ${Math.max(1, SIZES.labelPaddingPx - 1)}px`,
        borderRadius: `${SIZES.labelBorderRadiusPx}px`,
        pointerEvents: 'auto',
        cursor: 'pointer',
        lineHeight: '1.1',
        letterSpacing: '0.2px',
      });
      line.addEventListener('click', (e) => {
        e.stopPropagation();
        seekTo(video, progressBar, m.positionSeconds);
      });
      wrapper.appendChild(line);
    }

    return wrapper;
  }

  // Simple tick mark for hourly time-only markers - deliberately plainer
  // than the cat-face bubble so mod-timestamped events stay visually
  // primary and the hourly grid reads as a background aid, not a
  // competing set of "events." Wrapped in a wider, transparent hit-area
  // so it's still easy to click without visually widening the tick.
  function buildHourTick() {
    const hitArea = document.createElement('div');
    Object.assign(hitArea.style, {
      position: 'absolute',
      bottom: '0',
      transform: 'translateX(-50%)',
      width: `${SIZES.hourTickHitWidthPx}px`,
      height: `${SIZES.hourTickHitHeightPx}px`,
      pointerEvents: 'auto',
      cursor: 'pointer',
    });

    const line = document.createElement('div');
    Object.assign(line.style, {
      position: 'absolute',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '1px',
      height: '100%',
      background: 'rgba(255, 255, 255, 0.5)',
      pointerEvents: 'none',
    });
    hitArea.appendChild(line);

    return hitArea;
  }

  function buildCatFaceSvg() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', String(SIZES.catFaceSizePx));
    svg.setAttribute('height', String(SIZES.catFaceSizePx));
    svg.style.transition = 'transform 0.1s ease-out';
    svg.style.overflow = 'visible';

    const shapes = [
      // left ear, right ear, face, left eye, right eye, nose
      ['polygon', { points: '3,8 6,0 8,8', fill: '#ffb703', stroke: '#7a4a00', 'stroke-width': '0.6' }],
      ['polygon', { points: '17,8 14,0 12,8', fill: '#ffb703', stroke: '#7a4a00', 'stroke-width': '0.6' }],
      ['circle', { cx: '10', cy: '12', r: '7', fill: '#ffb703', stroke: '#7a4a00', 'stroke-width': '1' }],
      ['circle', { cx: '7.3', cy: '11', r: '1', fill: '#3a2100' }],
      ['circle', { cx: '12.7', cy: '11', r: '1', fill: '#3a2100' }],
      ['polygon', { points: '9,13.3 11,13.3 10,14.6', fill: '#3a2100' }],
    ];

    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
    }

    return svg;
  }

  // Flat, single-color variant of the same cat-face design, for the
  // player control button - YouTube's own icons in .ytp-right-controls
  // are all flat white with no strokes/gradients, and the saturated
  // orange used for the on-timeline bubbles would clash badly sitting
  // next to them. Eyes/nose are a dark near-black fill rather than true
  // cutouts (no SVG mask) - simpler, and reads fine against the player
  // chrome's own dark gradient background immediately behind the button.
  function buildMonochromeCatFaceSvg(sizePx) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', String(sizePx));
    svg.setAttribute('height', String(sizePx));

    const shapes = [
      ['polygon', { points: '3,8 6,0 8,8', fill: '#fff' }],
      ['polygon', { points: '17,8 14,0 12,8', fill: '#fff' }],
      ['circle', { cx: '10', cy: '12', r: '7', fill: '#fff' }],
      ['circle', { cx: '7.3', cy: '11', r: '1', fill: '#0f0f0f' }],
      ['circle', { cx: '12.7', cy: '11', r: '1', fill: '#0f0f0f' }],
      ['polygon', { points: '9,13.3 11,13.3 10,14.6', fill: '#0f0f0f' }],
    ];

    for (const [tag, attrs] of shapes) {
      const el = document.createElementNS(svgNS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
    }

    return svg;
  }

  // Injects the settings button as the first child of .ytp-right-controls
  // (to the left of YouTube's own buttons - settings gear, mini-player,
  // fullscreen - rather than disrupting their order). Idempotent: safe
  // to call repeatedly, a no-op if the button's already there.
  function injectSettingsButton() {
    const rightControls = document.querySelector('.ytp-right-controls');
    if (!rightControls) return false;
    if (rightControls.querySelector('#cat-rescue-settings-button')) return true;

    const button = document.createElement('button');
    button.id = 'cat-rescue-settings-button';
    button.className = 'ytp-button'; // inherits YouTube's own sizing/hover/opacity styling for free
    button.title = 'TinyKittens HQ timeline markers';
    button.setAttribute('aria-label', 'TinyKittens HQ timeline markers settings');
    Object.assign(button.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    button.appendChild(buildMonochromeCatFaceSvg(24));

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsPanel();
    });

    rightControls.insertBefore(button, rightControls.firstChild);
    log('Injected settings button into .ytp-right-controls.');
    ensureAutohideWatcher();
    return true;
  }

  // Closes the settings panel whenever YouTube's own controls fade out
  // from inactivity (indicated by a "ytp-autohide" class YouTube itself
  // adds to the player root) - otherwise the panel would be left floating
  // on screen with no controls around it, looking like a stray leftover
  // rather than a normal part of the player chrome. Attached once
  // (guarded by autohideObserverAttached) and re-attempted from
  // injectSettingsButton's own retry cycle, since the player root may not
  // exist yet the first time this is reached.
  let autohideObserverAttached = false;
  function ensureAutohideWatcher() {
    if (autohideObserverAttached) return;
    const playerRoot = getPlayerRoot();
    if (!playerRoot) return;

    autohideObserverAttached = true;
    const observer = new MutationObserver(() => {
      if (settingsPanelEl && settingsPanelEl.style.display !== 'none' && playerRoot.classList.contains('ytp-autohide')) {
        settingsPanelEl.style.display = 'none';
        log('Controls auto-hid - closing settings panel with them.');
      }
    });
    observer.observe(playerRoot, { attributes: true, attributeFilter: ['class'] });
    log('Attached controls-autohide watcher to player root.');
  }

  // YouTube frequently re-renders .ytp-right-controls (quality changes,
  // the live badge appearing, chat panel toggling, etc.), which can
  // silently wipe out a manually-injected button. injectSettingsButton
  // is idempotent, so just re-running it on every mutation and letting it
  // no-op when the button's already present is simpler and more robust
  // than trying to detect specifically when it's been removed.
  function ensureSettingsButton() {
    injectSettingsButton();
    const observer = new MutationObserver(() => {
      injectSettingsButton();
    });
    // documentElement (<html>), unlike <body>, is guaranteed to exist even
    // at document_start - body hasn't been parsed yet at that point, and
    // passing null to observe() throws synchronously (which is what broke
    // everything: this whole file runs as one top-level IIFE, so an
    // uncaught error here previously killed all the code after it too,
    // including the marker rendering that has nothing to do with this
    // button).
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // =======================================================================
  // Settings panel: a flat panel (not a replica of YouTube's native
  // multi-level settings menu - that's a lot of machinery for 5 toggles
  // and a stepper) appended inside #movie_player so it stays visible in
  // fullscreen, matching the same reasoning as the button placement
  // itself. Every control here sends a 'save' message to storage-bridge.js
  // (the only piece of the extension with chrome.storage access, since
  // this file runs in the MAIN world); the actual applying of the new
  // value happens uniformly through applyGlobalSetting in the message
  // listener near the end of this file, once the bridge relays it back -
  // whether the change came from this panel, another tab, or the initial
  // load, one code path, not two.
  // =======================================================================
  let settingsPanelEl = null;
  const panelSyncFns = []; // each control's own "update my visual state from CONFIG" function

  function saveGlobalSetting(partialSettings) {
    window.postMessage({ source: 'cat-rescue-page', type: 'save', settings: partialSettings }, location.origin);
  }
  function savePerVideoEnabled(value) {
    window.postMessage({ source: 'cat-rescue-page', type: 'save', perVideoEnabled: value }, location.origin);
  }

  function buildToggleRow(labelText, getChecked, onToggle) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 12px',
      gap: '12px',
    });

    const label = document.createElement('span');
    label.textContent = labelText;
    Object.assign(label.style, { fontSize: '13px', color: '#fff', fontFamily: 'Roboto, Arial, sans-serif' });
    row.appendChild(label);

    const track = document.createElement('button');
    track.type = 'button';
    Object.assign(track.style, {
      position: 'relative',
      width: '34px',
      height: '18px',
      borderRadius: '9px',
      border: 'none',
      cursor: 'pointer',
      padding: '0',
      flexShrink: '0',
      transition: 'background 0.15s ease',
    });
    const knob = document.createElement('span');
    Object.assign(knob.style, {
      position: 'absolute',
      top: '2px',
      left: '2px',
      width: '14px',
      height: '14px',
      borderRadius: '50%',
      background: '#fff',
      transition: 'left 0.15s ease',
    });
    track.appendChild(knob);

    function sync() {
      const checked = getChecked();
      track.style.background = checked ? '#3ea6ff' : 'rgba(255, 255, 255, 0.3)';
      knob.style.left = checked ? '18px' : '2px';
    }
    sync();

    track.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle(!getChecked());
    });

    row.appendChild(track);
    panelSyncFns.push(sync);
    return row;
  }

  function buildStepperRow(labelText, getValue, onDecrement, onIncrement, formatValue) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 12px',
      gap: '12px',
    });

    const label = document.createElement('span');
    label.textContent = labelText;
    Object.assign(label.style, { fontSize: '13px', color: '#fff', fontFamily: 'Roboto, Arial, sans-serif' });
    row.appendChild(label);

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    function buildStepButton(text, onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      Object.assign(btn.style, {
        width: '22px',
        height: '22px',
        borderRadius: '4px',
        border: 'none',
        background: 'rgba(255, 255, 255, 0.15)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: '14px',
        lineHeight: '1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      return btn;
    }

    const valueSpan = document.createElement('span');
    Object.assign(valueSpan.style, { fontSize: '13px', color: '#fff', minWidth: '32px', textAlign: 'center' });

    controls.appendChild(buildStepButton('−', onDecrement));
    controls.appendChild(valueSpan);
    controls.appendChild(buildStepButton('+', onIncrement));
    row.appendChild(controls);

    function sync() {
      valueSpan.textContent = formatValue(getValue());
    }
    sync();
    panelSyncFns.push(sync);

    return row;
  }

  function buildSettingsPanel() {
    const panel = document.createElement('div');
    panel.id = 'cat-rescue-settings-panel';
    Object.assign(panel.style, {
      position: 'absolute',
      bottom: '50px',
      right: '12px',
      width: '230px',
      background: 'rgba(28, 28, 28, 0.96)',
      borderRadius: '8px',
      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
      zIndex: '2147483647',
      display: 'none',
      fontFamily: 'Roboto, Arial, sans-serif',
      overflow: 'hidden',
    });

    const header = document.createElement('div');
    header.textContent = 'TinyKittens HQ timeline markers';
    Object.assign(header.style, {
      padding: '10px 12px',
      fontSize: '12px',
      fontWeight: '500',
      color: 'rgba(255, 255, 255, 0.7)',
      borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
    });
    panel.appendChild(header);

    panel.appendChild(
      buildToggleRow('Show on this video', () => isEnabledForThisVideo(), (next) => savePerVideoEnabled(next))
    );

    const divider = document.createElement('div');
    Object.assign(divider.style, { height: '1px', background: 'rgba(255, 255, 255, 0.1)', margin: '4px 0' });
    panel.appendChild(divider);

    panel.appendChild(
      buildToggleRow('Moderators only', () => CONFIG.moderatorOnly, (next) => saveGlobalSetting({ moderatorOnly: next }))
    );
    panel.appendChild(
      buildToggleRow('Show labels', () => CONFIG.showLabels, (next) => saveGlobalSetting({ showLabels: next }))
    );
    panel.appendChild(
      buildToggleRow('Hourly markers', () => CONFIG.showHourlyMarkers, (next) => saveGlobalSetting({ showHourlyMarkers: next }))
    );
    panel.appendChild(
      buildToggleRow('Debug logging', () => CONFIG.debug, (next) => saveGlobalSetting({ debug: next }))
    );
    panel.appendChild(
      buildStepperRow(
        'Text size',
        () => CONFIG.fontSizePx,
        () => saveGlobalSetting({ fontSizePx: Math.max(10, CONFIG.fontSizePx - 2) }),
        () => saveGlobalSetting({ fontSizePx: Math.min(24, CONFIG.fontSizePx + 2) }),
        (v) => `${v}px`
      )
    );

    // Without this, a click anywhere in the panel would bubble up to the
    // player and trigger its own click handling (play/pause, etc.).
    panel.addEventListener('click', (e) => e.stopPropagation());

    return panel;
  }

  function refreshSettingsPanel() {
    for (const fn of panelSyncFns) fn();
  }

  function toggleSettingsPanel() {
    const playerRoot = getPlayerRoot();
    if (!playerRoot) return;

    if (!settingsPanelEl) {
      settingsPanelEl = buildSettingsPanel();
      playerRoot.appendChild(settingsPanelEl);
    }

    const isOpen = settingsPanelEl.style.display !== 'none';
    if (isOpen) {
      settingsPanelEl.style.display = 'none';
    } else {
      refreshSettingsPanel();
      settingsPanelEl.style.display = 'block';
    }
  }

  // Close the panel on any click outside it (and outside the button that
  // opens it, so that click doesn't immediately reopen what it just closed).
  document.addEventListener('click', (e) => {
    if (!settingsPanelEl || settingsPanelEl.style.display === 'none') return;
    const button = document.querySelector('#cat-rescue-settings-button');
    if (settingsPanelEl.contains(e.target) || (button && button.contains(e.target))) return;
    settingsPanelEl.style.display = 'none';
  });

  function formatAgo(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m ago` : `${m}m ago`;
  }

  // ---------------------------------------------------------------------
  // Settings bridge: storage-bridge.js (isolated world, same frame) reads
  // chrome.storage - which this MAIN-world script cannot access directly
  // - and relays values here via postMessage. Handles both the initial
  // load (msg.type === 'init') and live updates from the settings panel
  // or a synced change on another device (msg.type === 'update').
  // moderatorOnly and debug matter in the chat-iframe context too (they
  // affect parsing/logging there), so this listener isn't gated on
  // !inIframe - only the render/panel-refresh side effects are.
  // ---------------------------------------------------------------------
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== 'cat-rescue-bridge') return;
    if (msg.type !== 'init' && msg.type !== 'update') return;

    if (msg.settings) {
      for (const [key, value] of Object.entries(msg.settings)) {
        applyGlobalSetting(key, value);
      }
      log(`Settings ${msg.type}:`, msg.settings);
    }

    if ('perVideoEnabled' in msg) {
      perVideoEnabledOverride = msg.perVideoEnabled;
      log(`Settings: per-video override = ${perVideoEnabledOverride}`);
    }

    // Force an immediate visual update rather than waiting for the next
    // poll/interval tick - matters most right after the settings panel
    // changes something, so the person sees the effect right away.
    if (!inIframe && currentSeenEvents) {
      renderMarkers(currentSeenEvents);
    }
    if (!inIframe && settingsPanelEl) {
      refreshSettingsPanel();
    }
  });
})();

