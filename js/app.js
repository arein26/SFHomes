/**
 * Main application orchestration.
 * Wires together map selection, data fetching, domain checking, and UI.
 */
const App = (() => {
    let currentAddresses = [];
    let allDomainVariations = []; // flat list for batch checking
    let domainIndexMap = {};      // domain -> { addrIdx, domainIdx }

    function init() {
        MapManager.init();

        // Wire up button handlers
        document.getElementById('search-btn').addEventListener('click', handleSearch);
        document.getElementById('clear-btn').addEventListener('click', handleClear);
        document.getElementById('check-all-btn').addEventListener('click', handleCheckAll);
        document.getElementById('export-btn').addEventListener('click', handleExport);

        // Listen for area selection events
        document.addEventListener('areaCleared', () => {
            UI.hideResults();
            UI.hideStatus();
            currentAddresses = [];
            allDomainVariations = [];
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
     */
    async function runDomainChecks() {
        if (allDomainVariations.length === 0) return;

        const total = allDomainVariations.length;
        let activeDomains = 0;
        let registeredDomains = 0;

        UI.showStatus(`Checking ${total} domains...`);
        UI.updateProgress(0, total);

        await Domains.checkDomainsBatch(
            allDomainVariations,
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
                    `Checking domains: ${completed}/${total}` +
                    (activeDomains > 0 ? ` | ${activeDomains} active` : '') +
                    (registeredDomains > 0 ? ` | ${registeredDomains} registered` : '')
                );
            }
        );

        UI.showStatus(
            `Done! Checked ${total} domains. ` +
            `${activeDomains} active, ${registeredDomains} registered (no DNS), ` +
            `${total - activeDomains - registeredDomains} not found.`
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
