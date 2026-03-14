/**
 * Main application orchestration.
 * Loads property database, generates domain variations, checks domains.
 */
const App = (() => {
    const STORAGE_KEY = 'sfDomainScout';
    const STORAGE_VERSION = 4; // bump to invalidate old cached sessions

    let currentAddresses = [];
    let allDomainVariations = []; // flat list for batch checking
    let domainIndexMap = {};      // domain -> { addrIdx, domainIdx }
    let domainCache = {};         // domain -> check result (persisted)
    let knownDomains = {};        // address -> { domain, status, registrar, registrationDate, ... }

    // ── localStorage helpers ──

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            const state = JSON.parse(raw);
            if (state.version !== STORAGE_VERSION) {
                localStorage.removeItem(STORAGE_KEY);
                return null;
            }
            return state;
        } catch (_) { return null; }
    }

    function saveState() {
        try {
            const state = {
                version: STORAGE_VERSION,
                addresses: currentAddresses,
                domainCache,
                knownDomains
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (_) { /* quota exceeded, etc. */ }
    }

    function init() {
        // Initialize map
        MapManager.init();

        // Wire up button handlers
        document.getElementById('search-btn').addEventListener('click', handleSearch);
        document.getElementById('check-all-btn').addEventListener('click', handleCheckAll);
        document.getElementById('show-all-btn').addEventListener('click', handleShowAll);
        document.getElementById('export-btn').addEventListener('click', handleExport);

        // Save state when leaving the page
        window.addEventListener('beforeunload', () => saveState());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveState();
        });

        // Restore last session
        restoreSession();
    }

    /**
     * Get the max sqft filter value (0 = no limit).
     */
    function getMaxSqft() {
        return parseInt(document.getElementById('max-sqft').value, 10) || 0;
    }

    /**
     * Apply sqft filter to an address list.
     */
    function applySqftFilter(addresses) {
        const maxSqft = getMaxSqft();
        if (maxSqft <= 0) return addresses;
        return addresses.filter(a => !a.sqft || a.sqft <= maxSqft);
    }

    function restoreSession() {
        const state = loadState();
        if (!state) return;

        if (state.domainCache) domainCache = state.domainCache;
        if (state.knownDomains) knownDomains = state.knownDomains;

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
                MapManager.showPins(currentAddresses);
            } else {
                UI.renderResults(currentAddresses);
                UI.showStatus(`Restored ${currentAddresses.length} addresses. Click "Search All Domains" to check.`);
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
     * Check if a known domain should be re-checked (registered in last 6 months).
     */
    function shouldRecheck(known) {
        if (!known.registrationDate) return false;
        if (known.status === 'active') return false; // already live, no need
        const regDate = new Date(known.registrationDate);
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        return regDate > sixMonthsAgo;
    }

    /**
     * After checking, save any newly found domains to knownDomains.
     */
    function updateKnownDomains() {
        for (const addr of currentAddresses) {
            if (knownDomains[addr.fullAddress]) continue; // already known
            const found = (addr.domainVariations || []).find(
                v => v.status === 'active' || v.status === 'registered'
            );
            if (found) {
                knownDomains[addr.fullAddress] = {
                    domain: found.domain,
                    status: found.status,
                    registrar: found.registrar,
                    registrationDate: found.registrationDate,
                    expirationDate: found.expirationDate,
                    hasActiveDNS: found.hasActiveDNS
                };
            }
        }
    }

    /**
     * Handle the main search flow.
     */
    async function handleSearch() {
        const maxResults = parseInt(document.getElementById('max-results').value, 10);
        const autoCheck = document.getElementById('auto-check-domains').checked;

        const searchBtn = document.getElementById('search-btn');
        searchBtn.disabled = true;
        searchBtn.textContent = 'Loading...';

        UI.hideResults();
        UI.showStatus('Loading property database...');
        UI.updateProgress(0, 0);

        try {
            const addresses = await SFData.getAddressesInArea(null, maxResults, (msg) => {
                UI.showStatus(msg);
            });

            if (addresses.length === 0) {
                UI.showStatus('No properties found.');
                UI.renderResults([]);
                return;
            }

            // Apply sqft filter
            const filtered = applySqftFilter(addresses);
            UI.showStatus(`Loaded ${filtered.length} properties${filtered.length < addresses.length ? ` (${addresses.length - filtered.length} filtered by sqft)` : ''}. Generating domain variations...`);

            currentAddresses = filtered;
            allDomainVariations = [];
            domainIndexMap = {};

            filtered.forEach((addr, addrIdx) => {
                const known = knownDomains[addr.fullAddress];
                if (known) {
                    // Property has a known found domain — only show that one
                    addr.domainVariations = [{
                        domain: known.domain,
                        status: known.status,
                        registrar: known.registrar,
                        registrationDate: known.registrationDate,
                        expirationDate: known.expirationDate,
                        hasActiveDNS: known.hasActiveDNS
                    }];
                    // If registered in last 6 months, still re-check for website going live
                    if (shouldRecheck(known)) {
                        allDomainVariations.push(known.domain);
                        domainIndexMap[known.domain] = { addrIdx, domainIdx: 0 };
                    }
                    return;
                }

                // No known domain — generate all variations
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

            UI.renderResults(filtered);

            const totalDomains = allDomainVariations.length;
            UI.showStatus(`${filtered.length} properties, ${totalDomains} domain variations.`);

            if (autoCheck) {
                await runDomainChecks();
            } else {
                saveState();
                UI.showStatus(
                    `${filtered.length} properties with ${totalDomains} domain variations. ` +
                    `Click "Check All Domains" to start checking.`
                );
            }

        } catch (err) {
            console.error('Search error:', err);
            UI.showStatus(`Error: ${err.message}`);
        } finally {
            searchBtn.disabled = false;
            searchBtn.innerHTML = '<span class="btn-icon">&#x1F50D;</span> Search All Domains';
        }
    }

    /**
     * Run domain registration checks.
     * Uses cached results for domains already checked in a prior session.
     */
    async function runDomainChecks() {
        if (allDomainVariations.length === 0) {
            // All domains are known — just show results
            const active = countByStatus('active');
            const registered = countByStatus('registered');
            UI.renderResults(currentAddresses, { filterRegistered: true });
            document.getElementById('show-all-btn').hidden = false;
            document.getElementById('show-all-btn').textContent = 'Show All Addresses';
            UI.showStatus(`All domains known. ${active} active, ${registered} registered.`);
            MapManager.showPins(currentAddresses);
            return;
        }

        let activeDomains = 0;
        let registeredDomains = 0;

        // Apply cached results first
        const domainsToCheck = [];
        for (const domain of allDomainVariations) {
            const mapping = domainIndexMap[domain];
            if (!mapping) continue;
            const { addrIdx, domainIdx } = mapping;
            const variation = currentAddresses[addrIdx]?.domainVariations?.[domainIdx];
            if (!variation) continue;

            const cached = domainCache[domain];
            if (cached && (cached.status === 'active' || cached.status === 'registered')) {
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
                `All ${allDomainVariations.length} domains cached. ` +
                `${activeDomains} active, ${registeredDomains} registered.`
            );
            MapManager.showPins(currentAddresses);
            return;
        }

        UI.showStatus(`Checking ${totalNew} domains (${totalCached} cached)...`);
        UI.updateProgress(0, totalNew);

        await Domains.checkDomainsBatch(
            domainsToCheck,
            (result, index) => {
                const mapping = domainIndexMap[result.domain];
                if (!mapping) return;
                const { addrIdx, domainIdx } = mapping;

                if (currentAddresses[addrIdx] &&
                    currentAddresses[addrIdx].domainVariations[domainIdx]) {
                    Object.assign(
                        currentAddresses[addrIdx].domainVariations[domainIdx],
                        result
                    );
                }

                if (result.status === 'active' || result.status === 'registered') {
                    domainCache[result.domain] = {
                        status: result.status,
                        registrar: result.registrar,
                        registrationDate: result.registrationDate,
                        expirationDate: result.expirationDate,
                        hasActiveDNS: result.hasActiveDNS
                    };
                }

                UI.updateDomainStatus(addrIdx, domainIdx, result);

                if (result.status === 'active') activeDomains++;
                if (result.status === 'registered') registeredDomains++;
            },
            (completed, total) => {
                UI.updateProgress(completed, total);
                UI.showStatus(
                    `Checking domains: ${completed}/${totalNew}` +
                    (totalCached > 0 ? ` (${totalCached} cached)` : '') +
                    (activeDomains > 0 ? ` | ${activeDomains} active` : '') +
                    (registeredDomains > 0 ? ` | ${registeredDomains} registered` : '')
                );
                if (completed % 20 === 0) saveState();
            }
        );

        // Save newly found domains to knownDomains and update any re-checked ones
        updateKnownDomains();
        // Update known domains that were re-checked (status may have changed)
        for (const addr of currentAddresses) {
            const known = knownDomains[addr.fullAddress];
            if (!known) continue;
            const variation = (addr.domainVariations || []).find(v => v.domain === known.domain);
            if (variation && variation.status !== 'unchecked') {
                knownDomains[addr.fullAddress] = {
                    domain: variation.domain,
                    status: variation.status,
                    registrar: variation.registrar || known.registrar,
                    registrationDate: variation.registrationDate || known.registrationDate,
                    expirationDate: variation.expirationDate || known.expirationDate,
                    hasActiveDNS: variation.hasActiveDNS
                };
            }
        }

        saveState();

        UI.renderResults(currentAddresses, { filterRegistered: true });

        const showAllBtn = document.getElementById('show-all-btn');
        showAllBtn.hidden = false;
        showAllBtn.textContent = 'Show All Addresses';

        const recentCount = Object.values(knownDomains).filter(k => shouldRecheck(k)).length;
        UI.showStatus(
            `Done! ${activeDomains} active, ${registeredDomains} registered.` +
            (recentCount > 0 ? ` ${recentCount} recent domains being monitored.` : '') +
            ` Sorted by newest registration date.`
        );

        // Update map pins
        MapManager.showPins(currentAddresses);
    }

    async function handleCheckAll() {
        await runDomainChecks();
    }

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

    return { handleSearch, handleCheckAll, handleExport };
})();
