<h1 align="center">Spotlight</h1>

<p align="center">
  <strong>The main input and output of the genolabs agentic desktop. A compact, keyboard-driven launcher for GNOME Shell.</strong>
</p>

<p align="center">
  <strong>Shortcut:</strong> <code>Super + Space</code>
  &nbsp;•&nbsp;
  Forked from <a href="https://github.com/itsnin/spotlight">Spotlight by itsnin</a>
</p>

<img width="1366" height="768" alt="Screenshot" src="https://github.com/user-attachments/assets/7d3d6cfb-86eb-44a7-83a0-f9810ded63f8" />

## What this fork adds

- **Memories.** A section right after Applications that searches what you chose to
  remember with ScreenVision, through the genolabs agent (`net.genolabs.Agent` on the
  session bus). Enter copies the memory's text; the best match also offers its links
  and its screenshot one arrow key away. When the agent is not running the section
  simply stays hidden.
- **Super+Space**, like Cmd+Space on a Mac (see below if it is taken).
- Keyboard activation fix: arrowing to any result and pressing Enter now always runs it.
- Development setup: unit tests, a headless end-to-end smoke test, ESLint and CI.
  See [DEVELOPING.md](DEVELOPING.md).

## Installation

```bash
make install
gnome-extensions disable spotlight@nin   # if the original Spotlight is installed: both cannot run at once
# Log out and back in (Wayland cannot reload extensions), then:
gnome-extensions enable spotlight@genolabs.net
```

### Super+Space is taken

Stock GNOME uses Super+Space to switch keyboard layouts. While that binding exists,
Spotlight cannot take the key and says so in the log (`make logs`). Free it, keeping
the dedicated layout key, with:

```bash
gsettings set org.gnome.desktop.wm.keybindings switch-input-source "['XF86Keyboard']"
```

Shift+Super+Space still switches layouts backwards. Or choose another shortcut in
the preferences.

## Preferences

```bash
gnome-extensions prefs spotlight@genolabs.net
```

- Toggle keyboard shortcut (default `Super+Space`)
- Visual theme: Default (follows system), Dark, or Light


## Features

- Reuses GNOME's built-in search infrastructure
- Results from apps, calculator, files, system actions, settings, web search, and memories
- Positioned 25% from top, grows downward, never drifts. Subtle ease on open and close matching GNOME conventions.
- Translucent glass appearance, dark and light modes
- Live system theme following when set to Default

## Usage

| Action | Input |
|---|---|
| Open Spotlight | `Super + Space` |
| Launch app | Type name, `Enter` |
| Evaluate expression | Type math, `Enter` |
| Lock screen | Type `lock`, `Enter` |
| Open Wi-Fi settings | Type `wifi`, `Enter` |
| Search the web | Type query, `Enter` |
| Copy a remembered text | Type a word from it, `Enter` |
| Traverse results | `↑` / `↓` |
| Dismiss | `Esc`, `Super + Space`, or click outside |

## Architecture

Spotlight permanently takes over GNOME Overview's search infrastructure. On enable, it steals the Overview's search entry and search controller widgets and hides them. When the popup opens, these already-stolen widgets are reparented into the popup. When the popup closes, they're removed from the popup but kept stolen and hidden. They're only returned to the Overview on disable.

This approach means Spotlight automatically benefits from every search provider registered with GNOME Shell. The Memories section is one more provider of that kind, living inside GNOME Shell (`lib/memories/provider.js`) and asking the agent over D-Bus (`lib/agent/client.js`).

## Contributing

Contributions of all types are welcome — bug fixes, new features, documentation improvements, design proposals. Before starting, please read the [contributor guide](./CONTRIBUTING.md) and the [agent standards](./AGENTS.md) which describe the project's design philosophy, architecture, code style, and verification discipline.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Security

For security vulnerabilities, please do not open a public issue. See the [security policy](./SECURITY.md) for the private reporting process.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
