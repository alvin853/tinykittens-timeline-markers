# TinyKittens HQ Timeline Markers

Adds clickable timeline markers to the TinyKittens HQ live stream on
YouTube, built from the timestamps moderators post in chat. Available as
a browser extension or a userscript - see Installing below.

TinyKittens moderators regularly post messages like `⏪ 8:14 PM - Auntie
Jade in for dinner` to mark notable moments during the 24/7 stream. This
extension reads those timestamps and turns them into clickable markers
right on the video's progress bar, so you can jump straight to a moment
instead of scrolling back through chat looking for it.

## Features

- Clickable markers on the timeline for every mod-posted event
- Labels showing what happened and when
- Optional hourly markers, for jumping to a rough time even without a
  chat timestamp
- Adjustable text size
- Choice of moderator-only or all-chat parsing
- Per-video on/off switch, and all settings sync across your signed-in
  Chrome browsers

## Installing

There are two ways to use this: as a browser extension (Chrome, Edge, and
other Chromium-based browsers), or as a userscript (works in basically
any browser, including Firefox).

### Option 1: Browser extension

**Chrome Web Store:** [link coming soon]

**Manual install (until then, or if you prefer):**

1. Download or clone this repository.
2. Go to `chrome://extensions` in Chrome (or the equivalent page in an
   Edge/Chromium-based browser).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension` folder from this
   repository (not the repository's top-level folder).

### Option 2: Userscript (any browser, including Firefox)

New to userscripts? A userscript is a small script that a browser
extension called a "userscript manager" runs on specific websites for
you - in this case, on YouTube, to add the timeline markers. It's a
lightweight alternative to a full browser extension, and it's how this
project supports browsers (like Firefox) that don't have a dedicated
extension yet.

1. Install a userscript manager first - it's what actually runs the
   script below. [Tampermonkey](https://www.tampermonkey.net/) supports
   Chrome, Edge, Firefox, Safari, and most other browsers;
   [Violentmonkey](https://violentmonkey.github.io/) is a popular
   alternative, especially on Firefox. Either works.
2. Open the userscript file itself:
   [cat-rescue-chat-markers.user.js](https://raw.githubusercontent.com/alvin853/tinykittens-timeline-markers/main/userscript/cat-rescue-chat-markers.user.js).
   Your userscript manager should automatically detect it and prompt
   you to install it.
3. Confirm the install in the prompt that appears.

The userscript has the same features as the extension. One difference:
settings are stored per-browser rather than synced through your Google
account - Tampermonkey and Violentmonkey each have their own separate
sync options (Google Drive, WebDAV, etc.) in their own settings if you
want that across devices.

## Using it

Once installed, open the [TinyKittens HQ live stream](https://www.youtube.com/@TinyKittens/live).
A small cat-face icon appears in the video player's control bar - click
it to adjust settings like text size, which marker types to show, and
whether to parse timestamps from moderators only or from all chat
messages.

## A note on affiliation

This is an independent, unofficial fan project, built by a viewer of the
stream. It is not affiliated with, endorsed by, or operated by TinyKittens
HQ. It only adds this one feature to the YouTube player during their live
streams, and does not modify, collect, or share any video or chat content
- everything happens locally in your own browser. See
[privacy-policy.html](https://alvin853.github.io/tinykittens-timeline-markers/privacy-policy.html) for details.

Made with love for the cats and the community that shows up for them
every day.