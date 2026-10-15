// Spotlight: adding our own sections to GNOME's search results
// SPDX-License-Identifier: GPL-3.0-or-later

// Inserts an in-shell search provider into GNOME's search view at a given
// position (sections are shown, and win Enter, in this order). GNOME's own
// _registerProvider is skipped on purpose: it runs the parental-controls app
// filter, which expects a real installed GAppInfo, not a section header.
export function insertSection(searchResults, provider, index) {
    provider.searchInProgress = false;
    searchResults._providers.splice(index, 0, provider);
    searchResults._ensureProviderDisplay(provider);
    searchResults._content.set_child_at_index(provider.display, index);
    // The header would launch the provider's app, and there is none.
    const header = provider.display.providerInfo;
    if (header) {
        header.reactive = false;
        header.can_focus = false;
    }
}

export function removeSection(searchResults, provider) {
    searchResults._unregisterProvider(provider);
    provider.display = null;
}
