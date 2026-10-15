// Spotlight: popup widget and lifecycle orchestration
// SPDX-License-Identifier: GPL-3.0-or-later
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import {PopupBackdrop} from '../components/backdrop.js';
import {PopupPositioner} from '../components/positioner.js';
import {OverviewSearchStealer} from '../../overview/searchStealer.js';
import {ThumbnailEnhancer} from '../../overview/thumbnails.js';
import {installCloseDefense, uninstallCloseDefense} from '../behavior/defense.js';
import {applyTheme} from '../behavior/theme.js';
import {scheduleIdle, cancelIdle, trackTextVisibility} from '../behavior/lifecycle.js';
import {connectGlobalSignals, disconnectGlobalSignals} from '../behavior/signals.js';

export const SpotlightPopup = GObject.registerClass(
class SpotlightPopup extends St.Widget {
    _init(settings) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            visible: false,
        });
        this._settings = settings;
        this._backdrop = null;
        this._positioner = new PopupPositioner(this);
        this._ifaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        this._visible = false;
        this._openIdleId = 0;
        this._closeIdleId = 0;
        this._opening = false;
        this._textChangedEventId = 0;
        this._answerTextEventId = 0;
        // The AskController, if any: answers replace the results (lib/ask/).
        this.answers = null;
        // Clicks inside these do not close the popup (they open an answer).
        this._keepOpenActors = [];

        this._content = new St.BoxLayout({
            style_class: 'spotlight-container',
            vertical: true,
            width: 520,
        });
        this.add_child(this._content);

        this._stealer = new OverviewSearchStealer(this);
        this._thumbnailEnhancer = new ThumbnailEnhancer();
        connectGlobalSignals(this, this._settings, this._ifaceSettings);
    }

    stealOverviewSearch() {
        this._stealer.steal();
        this._thumbnailEnhancer.apply();
    }

    get searchResults() {
        return this._stealer.searchResults;
    }

    /** Clicking inside actor keeps Spotlight open (e.g. the Ask row). */
    keepOpenWhenClicking(actor) {
        this._keepOpenActors.push(actor);
    }

    keepsOpenFor(actor) {
        return this._keepOpenActors.some(keep => keep === actor || keep.contains(actor));
    }

    /** Cancel a close that activating a result has just scheduled. */
    keepOpen() {
        cancelIdle(this, '_closeIdleId');
    }

    /**
     * Show an answer where the results are. Only the results list is hidden:
     * hiding GNOME's search controller would unmap it, and it clears the
     * search text whenever it is unmapped.
     */
    showAnswer(widget) {
        if (widget.get_parent() !== this._content) {
            widget.get_parent()?.remove_child(widget);
            this._content.insert_child_at_index(widget, 1);
        }
        if (this.searchResults)
            this.searchResults.visible = false;
    }

    /** Back to the results. */
    hideAnswer(widget) {
        widget.hide();
        if (widget.get_parent())
            widget.get_parent().remove_child(widget);
        if (this.searchResults)
            this.searchResults.visible = true;
    }

    returnOverviewSearch() {
        this._stealer.restore();
        this._thumbnailEnhancer.revert();
    }

    open() {
        if (this._visible || this._opening || this._openIdleId !== 0)
            return;
        if (!this._stealer.entry || !this._stealer.search)
            return;
        this._opening = true;
        scheduleIdle(this, '_openIdleId', () => this._doOpen());
    }

    _doOpen() {
        this._opening = false;
        const entry = this._stealer.entry;
        const search = this._stealer.search;

        if (entry.get_parent())
            entry.get_parent().remove_child(entry);
        entry.visible = true;
        this._content.add_child(entry);

        if (search.get_parent())
            search.get_parent().remove_child(search);
        this._content.add_child(search);

        applyTheme(this._content, this._settings, this._ifaceSettings);

        const monitor = this._positioner.getTargetMonitor();
        this._backdrop = new PopupBackdrop(() => this.close(), monitor);
        this._backdrop.show();

        if (this.get_parent())
            Main.layoutManager.removeChrome(this);
        Main.layoutManager.addChrome(this);

        this._positioner.showCentered(() => entry.grab_key_focus());

        search._text.set_text('');
        search.visible = false;

        if (!this._textChangedEventId)
            this._textChangedEventId = trackTextVisibility(search);
        if (!this._answerTextEventId) {
            this._answerTextEventId = search._text.connect('text-changed', () =>
                this.answers?.textChanged(search._text.get_text()));
        }

        installCloseDefense(this, search, entry);
        this._visible = true;
    }

    close() {
        if ((!this._visible && !this._opening) || this._closeIdleId !== 0)
            return;
        cancelIdle(this, '_openIdleId');
        this._opening = false;
        scheduleIdle(this, '_closeIdleId', () => this._doClose());
    }

    _doClose() {
        this._positioner.stop();
        if (this._backdrop) {
            this._backdrop.destroy();
            this._backdrop = null;
        }

        uninstallCloseDefense(this, this._stealer.search);
        this.answers?.dismiss();

        if (this._textChangedEventId) {
            this._stealer.search._text.disconnect(this._textChangedEventId);
            this._textChangedEventId = 0;
        }
        if (this._answerTextEventId) {
            this._stealer.search._text.disconnect(this._answerTextEventId);
            this._answerTextEventId = 0;
        }

        const entry = this._stealer.entry;
        if (entry && entry.get_parent()) {
            entry.visible = false;
            entry.get_parent().remove_child(entry);
        }

        const search = this._stealer.search;
        if (search && search.get_parent()) {
            search.hide();
            search.get_parent().remove_child(search);
        }

        this._visible = false;
        this._animateClose(() => {
            if (this.get_parent())
                Main.layoutManager.removeChrome(this);
        });
    }

    _syncClose() {
        cancelIdle(this, '_openIdleId');
        cancelIdle(this, '_closeIdleId');
        this._opening = false;
        if (this._visible)
            this._doClose();
    }

    _animateClose(onComplete) {
        const stSettings = St.Settings.get();
        if (stSettings && !stSettings.enable_animations) {
            this.hide();
            this.opacity = 255;
            this.scale_x = 1.0;
            this.scale_y = 1.0;
            onComplete();
            return;
        }
        // Cancel any in-flight open animation.
        this.remove_transition('opacity');
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        this.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.hide();
                // Reset properties so the next open starts from a clean state.
                this.opacity = 255;
                this.scale_x = 1.0;
                this.scale_y = 1.0;
                onComplete();
            },
        });
    }

    destroy() {
        this._syncClose();
        disconnectGlobalSignals(this);
        this._keepOpenActors = [];
        this._content = null;
        this._settings = null;
        super.destroy();
    }
});
