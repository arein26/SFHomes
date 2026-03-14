/**
 * Main application orchestration.
 * Wires together map selection, data fetching, domain checking, and UI.
 */
const App = (() => {
    const STORAGE_KEY = 'sfDomainScout';
    const STORAGE_VERSION = 2; // bump to invalidate old cached sessions

    let currentAddresses = [];
    let allDomainVariations = []; // flat list for batch checking
    let domainIndexMap = {};      // domain -> { addrIdx, domainIdx }
    let domainCache = {};         // domain -> check result (persisted)

    // ── localStorage helpers ──

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const state = JSON.parse(raw);
            // Invalidate stale cache from older code versions
            if (state.version !== STORAGE_VERSION) {
                localStorage.removeItem(STORAGE_KEY);
                return null;
            }
            return state;
        } catch (_) { return null; }
    }

    function saveState() {
        try {
            const bounds = MapManager.getSelectionBounds();
            const state = {
                version: STORAGE_VERSION,
                lastBounds: bounds,
                addresses: currentAddresses,
                domainCache
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) { /* quota exceeded, etc. */ }
    }

    function init() {
        MapManager.init();

        // Wire up button handlers
        document.getElementById('search-btn').addEventListener('click', handleSearch);
        document.getElementById('clear-btn').addEventListener('click', handleClear);
        document.getElementById('check-all-btn').addEventListener('click', handleCheckAll);
        document.getElementById('show-all-btn').addEventListener('click', handleShowAll);
        document.getElementById('export-btn').addEventListener('click', handleExport);

        // Listen for area selection events
        document.addEventListener('areaCleared', () => {
            UI.hideResults();
            UI.hideStatus();
            currentAddresses = [];
            allDomainVariations = [];
        });

        // Save state when leaving the page (handles mid-check tab closes)
        window.addEventListener('beforeunload', () => saveState());

        // Also save when page becomes hidden (mobile tab switch)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveState();
        });

        // Restore last session
        restoreSession();
    }

    function restoreSession() {
        const state = loadState();
        if (!state) return;

        // Restore domain cache
        if (state.domainCache) domainCache = state.domainCache;

        // Restore last search area rectangle on map
        if (state.lastBounds) {
            MapManager.restoreRectangle(state.lastBounds);
        }

        // Restore previous results
        if (state.addresses && state.addresses.length > 0) {
            currentAddresses = state.addresses;
            buildDomainIndex();

            const hasChecked = currentAddresses.some(a =>
                (a.domainVariations || []).some(v => v.status !== 'unchecked')
            );

            if (hasChecked) {
                UI.renderResults(currentAddresses, { filterRegistered: true });
                document.getElementById('show-all-btn').hidden = false;
                document.getElementById('show-all-btn').textContent = 'Show All Addresses';
                const active = countByStatus('active');
                const registered = countByStatus('registered');
                UI.showStatus(`Restored ${currentAddresses.length} addresses. ${active} active, ${registered} registered domains.`);
            } else {
                UI.renderResults(currentAddresses);
                UI.showStatus(`Restored ${currentAddresses.length} addresses. Click "Check All Domains" to check.`);
            }
        }
    }

    function countByStatus(status) {
        let count = 0;
        for (const addr of currentAddresses) {
            for (const v of (addr.domainVariations || [])) {
                if (v.status === status) count++;
            }
        }
        return count;
    }

    function buildDomainIndex() {
        allDomainVariations = [];
        domainIndexMap = {};
        currentAddresses.forEach((addr, addrIdx) => {
            (addr.domainVariations || []).forEach((v, domainIdx) => {
                allDomainVariations.push(v.domain);
                domainIndexMap[v.domain] = { addrIdx, domainIdx };
            });
        });
    }

    /**
     * Handle the main search flow:
     * 1. Get addresses in selected area
     * 2. Generate domain variations
     * 3. Optionally auto-check domains
     */
    async function handleSearch() {
        const bounds = MapManager.getSelectionBounds();
        if (!bounds) {
            UI.showStatus('Please draw an area on the map first.');
            return;
        }

        const maxResults = parseInt(document.getElementById('max-results').value, 10);
        const autoCheck = document.getElementById('auto-check-domains').checked;

        // Disable search button during search
        const searchBtn = document.getElementById('search-btn');
        searchBtn.disabled = true;
        searchBtn.textContent = 'Searching...';

        UI.hideResults();
        UI.showStatus('Starting search...');
        UI.updateProgress(0, 0);

        try {
            // Step 1: Fetch addresses
            const addresses = await SFData.getAddressesInArea(bounds, maxResults, (msg) => {
                UI.showStatus(msg);
            });

            if (addresses.length === 0) {
                UI.showStatus('No single-family homes found in the selected area.');
                UI.renderResults([]);
                return;
            }

            UI.showStatus(`Found ${addresses.length} addresses. Generating domain variations...`);

            // Step 2: Generate domain variations for each address
            currentAddresses = addresses;
            allDomainVariations = [];
            domainIndexMap = {};

            addresses.forEach((addr, addrIdx) => {
                const domains = Domains.generateVariations(addr);
                addr.domainVariations = domains.map(d => ({
                    domain: d,
                    status: 'unchecked'
                }));

                domains.forEach((d, domainIdx) => {
                    allDomainVariations.push(d);
                    domainIndexMap[d] = { addrIdx, domainIdx };
                });
            });

            // Step 3: Render results
            UI.renderResults(addresses);

            // Add markers to map
            MapManager.addAddressMarkers(addresses);

            const totalDomains = allDomainVariations.length;
            UI.showStatus(`Generated ${totalDomains} domain variations for ${addresses.length} addresses.`);

            // Step 4: Auto-check domains if enabled
            if (autoCheck) {
                await runDomainChecks();
            } else {
                saveState();
                UI.showStatus(
                    `${addresses.length} addresses found with ${totalDomains} domain variations. ` +
                    `Click "Check All Domains" to start checking.`
                );
            }

        } catch (err) {
            console.error('Search error:', err);
            UI.showStatus(`Error: ${err.message}. Check the console for details.`);
        } finally {
            searchBtn.disabled = false;
            searchBtn.innerHTML = '<span class="btn-icon">&#x1F50D;</span> Search Selected Area';
        }
    }

    /**
     * Run domain registration checks for all generated variations.
     * Uses cached results for domains already checked in a prior session.
     */
    async function runDomainChecks() {
        if (allDomainVariations.length === 0) return;

        let activeDomains = 0;
        let registeredDomains = 0;

        // Apply cached results first, collect unchecked domains
        const domainsToCheck = [];
        for (const domain of allDomainVariations) {
            const mapping = domainIndexMap[domain];
            if (!mapping) continue;
            const { addrIdx, domainIdx } = mapping;
            const variation = currentAddresses[addrIdx]?.domainVariations?.[domainIdx];
            if (!variation) continue;

            const cached = domainCache[domain];
            if (cached && (cached.status === 'active' || cached.status === 'registered')) {
                // Use cached result
                Object.assign(variation, cached);
                if (cached.status === 'active') activeDomains++;
                if (cached.status === 'registered') registeredDomains++;
            } else {
                domainsToCheck.push(domain);
            }
        }

        const totalNew = domainsToCheck.length;
        const totalCached = allDomainVariations.length - totalNew;

        if (totalNew === 0) {
            UI.renderResults(currentAddresses, { filterRegistered: true });
            document.getElementById('show-all-btn').hidden = false;
            document.getElementById('show-all-btn').textContent = 'Show All Addresses';
            UI.showStatus(
                `All ${allDomainVariations.length} domains already cached. ` +
                `${activeDomains} active, ${registeredDomains} registered.`
            );
            return;
        }

        UI.showStatus(`Checking ${totalNew} domains (${totalCached} cached)...`);
        UI.updateProgress(0, totalNew);

        await Domains.checkDomainsBatch(
            domainsToCheck,
            // onResult callback
            (result, index) => {
                const mapping = domainIndexMap[result.domain];
                if (!mapping) return;

                const { addrIdx, domainIdx } = mapping;

                // Update the address object
                if (currentAddresses[addrIdx] &&
                    currentAddresses[addrIdx].domainVariations[domainIdx]) {
                    Object.assign(
                        currentAddresses[addrIdx].domainVariations[domainIdx],
                        result
                    );
                }

                // Cache registered/active results
                if (result.status === 'active' || result.status === 'registered') {
                    domainCache[result.domain] = {
                        status: result.status,
                        registrar: result.registrar,
                        registrationDate: result.registrationDate,
                        expirationDate: result.expirationDate,
                        hasActiveDNS: result.hasActiveDNS
                    };
                }

                // Update UI
                UI.updateDomainStatus(addrIdx, domainIdx, result);

                if (result.status === 'active') {
                    activeDomains++;
                    MapManager.highlightMarker(currentAddresses[addrIdx]);
                }
                if (result.status === 'registered') {
                    registeredDomains++;
                }
            },
            // onProgress callback
            (completed, total) => {
                UI.updateProgress(completed, total);
                UI.showStatus(
                    `Checking domains: ${completed}/${totalNew}` +
                    (totalCached > 0 ? ` (${totalCached} cached)` : '') +
                    (activeDomains > 0 ? ` | ${activeDomains} active` : '') +
                    (registeredDomains > 0 ? ` | ${registeredDomains} registered` : '')
                );
                // Save progress periodically so tab close doesn't lose work
                if (completed % 20 === 0) saveState();
            }
        );

        // Persist state
        saveState();

        // Re-render sorted/filtered: only show addresses with domains
        UI.renderResults(currentAddresses, { filterRegistered: true });

        // Show the toggle button
        const showAllBtn = document.getElementById('show-all-btn');
        showAllBtn.hidden = false;
        showAllBtn.textContent = 'Show All Addresses';

        UI.showStatus(
            `Done! ${activeDomains} active, ${registeredDomains} registered. ` +
            `Showing addresses with domains (sorted by newest registration).`
        );
    }

    /**
     * Handle "Check All Domains" button.
     */
    async function handleCheckAll() {
        await runDomainChecks();
    }

    /**
     * Handle clearing the map selection.
     */
    function handleClear() {
        MapManager.clearSelection();
        Domains.cancelChecking();
        UI.hideResults();
        UI.hideStatus();
        currentAddresses = [];
        allDomainVariations = [];
        domainIndexMap = {};
    }

    /**
     * Toggle between showing only addresses with domains vs all.
     */
    function handleShowAll() {
        const btn = document.getElementById('show-all-btn');
        if (btn.textContent.includes('Show All')) {
            UI.renderResults(currentAddresses);
            btn.textContent = 'Show Only With Domains';
        } else {
            UI.renderResults(currentAddresses, { filterRegistered: true });
            btn.textContent = 'Show All Addresses';
        }
    }

    /**
     * Handle CSV export.
     */
    function handleExport() {
        if (currentAddresses.length === 0) return;
        UI.exportCSV(currentAddresses);
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        handleSearch,
        handleClear,
        handleCheckAll,
        handleExport
    };
})();
