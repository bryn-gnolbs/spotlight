# Common development tasks. Run `make help` for the list.

UUID := spotlight@genolabs.net
ZIP := build/$(UUID).shell-extension.zip
SOURCES := $(shell git ls-files --cached --others --exclude-standard '*.js' '*.css' '*.json' '*.xml' 2>/dev/null)

.PHONY: help test lint smoke pack install uninstall enable disable prefs logs clean

help:
	@echo "make test      Run unit tests (plain gjs on a private D-Bus, no GNOME Shell needed)"
	@echo "make lint      Check code style with ESLint (needs Node.js: sudo apt install nodejs npm)"
	@echo "make smoke     End-to-end test in a throwaway headless GNOME Shell"
	@echo "make pack      Build $(ZIP)"
	@echo "make install   Pack and install for the current user (log out/in to load on Wayland)"
	@echo "make logs      Follow GNOME Shell's log, where console.log/console.warn output goes"
	@echo "make prefs     Open the preferences window"
	@echo "make enable / disable / uninstall / clean"

# The client tests talk to a fake agent, so they get their own session bus.
# GIO_USE_VFS=local keeps GIO from starting gvfs on that bus.
test:
	GIO_USE_VFS=local dbus-run-session -- gjs -m tests/run.js

lint: node_modules
	npx eslint .

node_modules: package.json
	npm install --no-audit --no-fund
	@touch node_modules

smoke: $(ZIP)
	tests/smoke/run.sh

$(ZIP): $(SOURCES) Makefile
	@mkdir -p build
	gnome-extensions pack --force --out-dir=build --extra-source=lib --extra-source=prefs .
	@# pack does not compile the settings schema; GNOME Shell needs the compiled file.
	@mkdir -p build/schemas
	glib-compile-schemas --strict --targetdir=build/schemas schemas
	cd build && zip -q $(notdir $(ZIP)) schemas/gschemas.compiled

pack: $(ZIP)

install: $(ZIP)
	gnome-extensions install --force $(ZIP)
	@echo "Installed. On Wayland, log out and back in to load the new code."

uninstall:
	gnome-extensions uninstall $(UUID)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

logs:
	journalctl --user -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf build
