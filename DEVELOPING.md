# Developing Spotlight

A field guide for people who know Python but are new to GNOME Shell extensions.
ScreenVision's DEVELOPING.md has the longer introduction; this covers what is
specific to Spotlight.

## The mental model

- **GNOME Shell is a JavaScript program** running on GJS, and an extension is a JS
  module the shell imports into its own process. `import Gio from 'gi://Gio'` is the
  same binding as Python's `from gi.repository import Gio`.
- **Two processes.** `extension.js` and `lib/` run inside `gnome-shell`; `prefs.js`
  and `prefs/` run in a separate GTK 4 app. They share only GSettings
  (`schemas/*.gschema.xml`). CI fails if shell code imports GTK or prefs import St.
- **Never block.** The extension shares one thread with the whole desktop. Every
  D-Bus call is async (callback wrapped in a Promise, like `asyncio` futures).
- **enable() / disable() are exact inverses.** GNOME calls `disable()` on every screen
  lock. Everything added, connected or overridden must be undone.

## How Spotlight works

```
Super+Space ─▶ KeybindingManager (lib/core/keybinding.js, grabs the key through Mutter)
                     │
                     ▼
              SpotlightPopup (lib/popup/widget/spotlightPopup.js)
              a floating St widget holding GNOME's own search entry and results,
              borrowed from the Overview by lib/overview/searchStealer.js
                     │  typing
                     ▼
              GNOME's SearchResultsView asks every search provider:
                Calculator                        lib/math/provider.js (in-process, instant)
                Applications (+ system actions)   built into GNOME Shell
                Memories                          lib/memories/provider.js  ── D-Bus ─▶ genolabs agent
                Settings, Files, Calculator, ...  other apps, over D-Bus
```

- `lib/popup/behavior/` closes the popup at the right moments (Esc, click outside,
  activating a result, another window taking focus) and applies the theme.
- `lib/popup/components/` positions the popup 25% from the top of the monitor under
  the pointer and draws the click-outside backdrop.
- `lib/overview/thumbnails.js` makes the Overview's workspace thumbnails larger.

### The Calculator section

- `lib/math/expression.js` is a recursive-descent parser (think of a tiny hand-written
  `ast` + evaluator; nothing is ever passed to `eval`). It only answers text with at
  least one operation, so "42" or "settings" never show a Calculator row. Percentages
  follow everyday speech: `15% of 80` = 12, `80 + 15%` = 92. Unit-tested.
- `lib/math/provider.js` puts the section first, so Enter copies the answer (plain
  digits; the row shows `1,234,567` grouped). It also stops GNOME Calculator's own
  search provider from repeating an answer Spotlight already gave, by wrapping its
  search methods with GNOME's `InjectionManager` (restored on disable). Everything
  Spotlight does not understand still reaches GNOME Calculator.

### The Memories section

A GNOME search provider is a plain object with a known set of methods (Python would
call it a protocol): `getInitialResultSet(terms, cancellable)` returns result ids,
`getResultMetas(ids)` turns them into rows, `activateResult(id)` runs one.

- `lib/agent/client.js` holds one `Gio.DBusProxy` for `net.genolabs.Agent`. The proxy
  follows the agent starting and stopping (`g_name_owner`); while it is not running,
  searches return nothing without making a call. After a memory's row runs, it
  tells the agent with `Used({"retrieval", "ids"})` (not awaited, errors ignored), so
  the long-term memory learns which memories belong together.
- `lib/core/timing.js` waits for a 120 ms pause in typing. GNOME cancels the search's
  `Gio.Cancellable` on every keystroke, so only the text the user paused on is sent.
- `lib/memories/model.js` validates the agent's JSON and builds rows (pure functions,
  unit-tested): the title is the first line of text, the detail is "App · 2 hours
  ago", Enter copies the text, and the best match is followed by "Open example.com"
  and "Open screenshot" rows. Only http(s) links are ever opened.

## Everyday commands

| Command | What it does |
|---|---|
| `make test` | Unit tests with plain `gjs` on a private D-Bus (a fake agent plays the real one) |
| `make smoke` | Starts a throwaway headless GNOME Shell, opens Spotlight with Super+Space, searches apps and memories, checks Enter, arrow keys, Esc, disable/enable |
| `make lint` | ESLint with GNOME's style (needs Node.js) |
| `make install` | Pack and install for your user; log out and back in to load it |
| `make logs` | Follow GNOME Shell's log (`console.warn` output lands here) |

The smoke test is fully isolated: private session bus, in-memory settings, temporary
XDG data, config, cache and runtime directories. It never touches your session or
your real agent. Screenshots of each run are saved next to its log.

## Trying a change on the real desktop

Wayland cannot reload an extension in place: `make install`, then log out and back in.
Check `make logs` for lines starting with `Spotlight:`.
