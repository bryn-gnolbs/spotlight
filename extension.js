// Spotlight: a compact launcher for GNOME Shell
// SPDX-License-Identifier: GPL-3.0-or-later
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {SpotlightPopup} from './lib/popup/widget/spotlightPopup.js';
import {KeybindingManager} from './lib/core/keybinding.js';
import {removeSection} from './lib/core/sections.js';
import {CalculatorDeduplicator, MathSearchProvider, addMathSection} from './lib/math/provider.js';
import {MemorySearchProvider, addMemoriesSection} from './lib/memories/provider.js';
import {AskController} from './lib/ask/controller.js';
import {AskSearchProvider, addAskSection} from './lib/ask/provider.js';

// Entry point. Keeping enable and disable adjacent makes the cleanup symmetry obvious at a glance.
export default class SpotlightExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._popup = new SpotlightPopup(this._settings);
        // Steal the overview search widgets permanently. The overview search stays gone
        // for as long as Spotlight is loaded, which is the whole point of the extension.
        this._popup.stealOverviewSearch();
        this._math = new MathSearchProvider();
        addMathSection(this._popup.searchResults, this._math);
        this._calculatorDeduplicator = new CalculatorDeduplicator(this._popup.searchResults);
        this._memories = new MemorySearchProvider();
        addMemoriesSection(this._popup.searchResults, this._memories);
        this._answers = new AskController(this._popup);
        this._popup.answers = this._answers;
        this._ask = new AskSearchProvider({
            onAsk: question => this._answers.ask(question),
            available: () => this._answers.available,
            classify: (text, cancellable) => this._answers.intent(text, cancellable),
        });
        addAskSection(this._popup.searchResults, this._ask);
        this._popup.keepOpenWhenClicking(this._ask.display);
        this._keybindingManager = new KeybindingManager();
        this._keybindingManager.enable();
        const shortcuts = this._settings.get_strv('toggle-shortcut');
        const accelerator = shortcuts.length > 0 ? shortcuts[0] : '<Super>space';
        if (shortcuts.length === 0)
            this._settings.set_strv('toggle-shortcut', [accelerator]);
        this._grabShortcut(accelerator);
        this._settings.connectObject('changed::toggle-shortcut', () => {
            this._keybindingManager.unlisten();
            const arr = this._settings.get_strv('toggle-shortcut');
            if (arr.length > 0)
                this._grabShortcut(arr[0]);
        }, this);
    }
    _grabShortcut(accelerator) {
        const grabbed = this._keybindingManager.listenFor(accelerator, () => {
            if (this._popup.visible)
                this._popup.close();
            else
                this._popup.open();
        });
        // Mutter refuses keys another shortcut already owns. On stock GNOME
        // that is Super+Space, which switches input sources.
        if (!grabbed) {
            console.warn(`Spotlight: ${accelerator} is already used by another shortcut. ` +
                'If it is input-source switching, free it with: gsettings set ' +
                "org.gnome.desktop.wm.keybindings switch-input-source \"['XF86Keyboard']\"");
        }
    }
    disable() {
        this._settings.disconnectObject(this);
        this._keybindingManager.disable();
        this._keybindingManager = null;
        removeSection(this._popup.searchResults, this._ask);
        this._ask.destroy();
        this._ask = null;
        this._popup.answers = null;
        this._answers.destroy();
        this._answers = null;
        removeSection(this._popup.searchResults, this._memories);
        this._memories.destroy();
        this._memories = null;
        this._calculatorDeduplicator.destroy();
        this._calculatorDeduplicator = null;
        removeSection(this._popup.searchResults, this._math);
        this._math.destroy();
        this._math = null;
        // Return the stolen widgets to the overview before destroying things so nothing leaks.
        this._popup.returnOverviewSearch();
        this._popup.destroy();
        this._popup = null;
        this._settings = null;
    }
}
