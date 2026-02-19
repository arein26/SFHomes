/**
 * UI rendering and updates for search results.
 */
const UI = (() => {

    const statusSection = () => document.getElementById('status-section');
    const statusText = () => document.getElementById('status-text');
    const progressFill = () => document.getElementById('progress-fill');
    const progressText = () => document.getElementById('progress-text');
    const resultsSection = () => document.getElementById('results-section');
    const resultsList = () => document.getElementById('results-list');
    const resultsCount = () => document.getElementById('results-count');

    /**
     * Show status bar with a message.
     */
    function showStatus(message) {
        statusSection().hidden = false;
        statusText().textContent = message;
    }

    /**
     * Hide status bar.
     */
    function hideStatus() {
        statusSection().hidden = true;
        updateProgress(0, 0);
    }

    /**
     * Update progress bar.
     */
    function updateProgress(current, total) {
        const pct = total > 0 ? Math.round((current / total) * 100) : 0;
        progressFill().style.width = pct + '%';
        progressText().textContent = total > 0 ? `${current}/${total}` : '';
    }

    // Track whether we're showing all addresses or only those with domains
    let showingAll = true;

    /**
     * Render address results with domain variations.
     * @param {Array} addresses - address objects with domainVariations
     * @param {Object} options - { filterRegistered: bool }
     */
    function renderResults(addresses, options) {
        const list = resultsList();
        list.innerHTML = '';

        if (addresses.length === 0) {
            list.innerHTML = '<div class="no-results">No single-family homes found in the selected area. Try expanding your selection.</div>';
            resultsSection().hidden = false;
            resultsCount().textContent = '(0 addresses)';
            return;
        }

        const opts = options || {};
        let displayAddresses = addresses;

        if (opts.filterRegistered) {
            displayAddresses = addresses.filter(addr => {
                const vars = addr.domainVariations || [];
                return vars.some(v => v.status === 'active' || v.status === 'registered');
            });
            showingAll = false;
        } else {
            showingAll = true;
        }

        // Sort: addresses with active/registered domains first, by newest registration date
        displayAddresses = [...displayAddresses].sort((a, b) => {
            const aDate = newestRegistrationDate(a);
            const bDate = newestRegistrationDate(b);
            const aHas = hasRegisteredDomain(a);
            const bHas = hasRegisteredDomain(b);
            // Addresses with domains first
            if (aHas && !bHas) return -1;
            if (!aHas && bHas) return 1;
            // Among those with domains, sort by newest registration date
            if (aDate && bDate) return bDate - aDate; // newest first
            if (aDate) return -1;
            if (bDate) return 1;
            return 0;
        });

        const totalWithDomains = addresses.filter(a => hasRegisteredDomain(a)).length;
        const countText = opts.filterRegistered
            ? `(${displayAddresses.length} with domains, ${addresses.length} total)`
            : `(${addresses.length} address${addresses.length !== 1 ? 'es' : ''})`;
        resultsCount().textContent = countText;

        displayAddresses.forEach((addr, idx) => {
            const card = createAddressCard(addr, idx);
            // Auto-expand cards that have active/registered domains
            if (hasRegisteredDomain(addr)) {
                card.classList.add('expanded');
            }
            list.appendChild(card);
        });

        resultsSection().hidden = false;
    }

    function hasRegisteredDomain(addr) {
        const vars = addr.domainVariations || [];
        return vars.some(v => v.status === 'active' || v.status === 'registered');
    }

    function newestRegistrationDate(addr) {
        const vars = addr.domainVariations || [];
        let newest = null;
        for (const v of vars) {
            if (v.registrationDate) {
                const d = new Date(v.registrationDate);
                if (!newest || d > newest) newest = d;
            }
        }
        return newest;
    }

    /**
     * Create a single address card element.
     */
    function createAddressCard(addr, idx) {
        const card = document.createElement('div');
        card.className = 'address-card';
        card.id = `addr-${idx}`;
        card.dataset.address = addr.fullAddress;

        const variations = addr.domainVariations || [];
        const activeDomains = variations.filter(v => v.status === 'active').length;
        const registeredDomains = variations.filter(v => v.status === 'registered').length;

        // Header
        const header = document.createElement('div');
        header.className = 'address-header';
        header.onclick = () => toggleCard(card);

        const leftSide = document.createElement('div');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'address-name';
        nameSpan.textContent = addr.fullAddress;
        leftSide.appendChild(nameSpan);

        if (addr.neighborhood) {
            const meta = document.createElement('span');
            meta.className = 'address-meta';
            meta.textContent = addr.neighborhood;
            leftSide.appendChild(meta);
        }

        // Show newest registration date on card header
        const newest = newestRegistrationDate(addr);
        if (newest) {
            const dateMeta = document.createElement('span');
            dateMeta.className = 'address-meta address-reg-date';
            dateMeta.textContent = 'Reg: ' + newest.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            leftSide.appendChild(dateMeta);
        }

        const rightSide = document.createElement('div');
        rightSide.className = 'address-badges';

        if (activeDomains > 0) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-active';
            badge.textContent = `${activeDomains} active`;
            rightSide.appendChild(badge);
            card.classList.add('has-active');
        }

        if (registeredDomains > 0) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-count';
            badge.textContent = `${registeredDomains} registered`;
            rightSide.appendChild(badge);
        }

        const countBadge = document.createElement('span');
        countBadge.className = 'badge badge-count';
        countBadge.textContent = `${variations.length} domains`;
        rightSide.appendChild(countBadge);

        const expandIcon = document.createElement('span');
        expandIcon.className = 'expand-icon';
        expandIcon.innerHTML = '&#9660;';
        rightSide.appendChild(expandIcon);

        header.appendChild(leftSide);
        header.appendChild(rightSide);
        card.appendChild(header);

        // Domain list (hidden by default)
        const domainList = document.createElement('div');
        domainList.className = 'domain-list';
        domainList.id = `domains-${idx}`;

        variations.forEach((v, di) => {
            const row = createDomainRow(v, idx, di);
            domainList.appendChild(row);
        });

        card.appendChild(domainList);
        return card;
    }

    /**
     * Create a domain row element.
     */
    function createDomainRow(variation, addrIdx, domainIdx) {
        const row = document.createElement('div');
        row.className = 'domain-row';
        row.id = `domain-${addrIdx}-${domainIdx}`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'domain-name';
        nameSpan.textContent = variation.domain;
        row.appendChild(nameSpan);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'domain-status';
        statusSpan.id = `status-${addrIdx}-${domainIdx}`;
        updateDomainStatusEl(statusSpan, variation);
        row.appendChild(statusSpan);

        return row;
    }

    /**
     * Format registration metadata (registrar, dates) for display.
     */
    function formatRegMeta(variation) {
        const parts = [];
        if (variation.registrar) parts.push(variation.registrar);
        if (variation.registrationDate) {
            const d = new Date(variation.registrationDate);
            parts.push('reg ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
        }
        if (parts.length === 0) return '';
        return ` <span class="status-meta">(${parts.join(' | ')})</span>`;
    }

    /**
     * Update a domain status element based on check result.
     */
    function updateDomainStatusEl(el, variation) {
        el.innerHTML = '';
        el.className = 'domain-status';

        switch (variation.status) {
            case 'active':
                el.innerHTML = '<span class="status-active">DNS Active</span>';
                el.innerHTML += formatRegMeta(variation);
                break;

            case 'registered':
                el.innerHTML = '<span class="status-registered">Registered</span>';
                el.innerHTML += formatRegMeta(variation);
                break;

            case 'available':
                el.innerHTML = '<span class="status-available">Available</span>';
                break;

            case 'no_dns':
                el.innerHTML = '<span class="status-available">No DNS</span>';
                break;

            case 'checking':
                el.innerHTML = '<span class="spinner"></span> <span class="status-checking">Checking...</span>';
                break;

            case 'error':
                el.innerHTML = `<span class="status-error">Error${variation.error ? ': ' + variation.error : ''}</span>`;
                break;

            default:
                el.innerHTML = '<span class="status-unchecked">Unchecked</span>';
        }
    }

    /**
     * Update the status of a single domain.
     * @param {number} addrIdx - address index
     * @param {number} domainIdx - domain index within address
     * @param {Object} result - check result
     */
    function updateDomainStatus(addrIdx, domainIdx, result) {
        const statusEl = document.getElementById(`status-${addrIdx}-${domainIdx}`);
        if (statusEl) {
            updateDomainStatusEl(statusEl, result);
        }

        // Update the card header badges
        updateCardBadges(addrIdx);
    }

    /**
     * Mark a domain as "checking".
     */
    function markDomainChecking(addrIdx, domainIdx) {
        const statusEl = document.getElementById(`status-${addrIdx}-${domainIdx}`);
        if (statusEl) {
            updateDomainStatusEl(statusEl, { status: 'checking' });
        }
    }

    /**
     * Update the badge counts on an address card.
     */
    function updateCardBadges(addrIdx) {
        const card = document.getElementById(`addr-${addrIdx}`);
        if (!card) return;

        const domainList = card.querySelector('.domain-list');
        if (!domainList) return;

        const rows = domainList.querySelectorAll('.domain-row');
        let active = 0;
        let registered = 0;

        rows.forEach(row => {
            const statusEl = row.querySelector('.domain-status');
            if (!statusEl) return;
            if (statusEl.querySelector('.status-active')) active++;
            if (statusEl.querySelector('.status-registered')) registered++;
        });

        // Update badges in header
        const badges = card.querySelector('.address-badges');
        if (!badges) return;

        // Remove existing active/registered badges
        badges.querySelectorAll('.badge-active, .badge-count').forEach(b => {
            if (b.textContent.includes('active') || b.textContent.includes('registered')) {
                b.remove();
            }
        });

        const countBadge = badges.querySelector('.badge-count');

        if (active > 0) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-active';
            badge.textContent = `${active} active`;
            badges.insertBefore(badge, countBadge);
            card.classList.add('has-active');
        }

        if (registered > 0) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-count';
            badge.textContent = `${registered} registered`;
            badges.insertBefore(badge, countBadge);
        }
    }

    /**
     * Toggle address card expansion.
     */
    function toggleCard(card) {
        card.classList.toggle('expanded');
    }

    /**
     * Show results section.
     */
    function showResults() {
        resultsSection().hidden = false;
    }

    /**
     * Hide results section.
     */
    function hideResults() {
        resultsSection().hidden = true;
        resultsList().innerHTML = '';
    }

    /**
     * Export results as CSV.
     */
    function exportCSV(addresses) {
        const rows = [['Address', 'Neighborhood', 'Domain', 'Status', 'Registrar', 'Registration Date']];

        addresses.forEach(addr => {
            (addr.domainVariations || []).forEach(v => {
                rows.push([
                    addr.fullAddress,
                    addr.neighborhood || '',
                    v.domain,
                    v.status || 'unchecked',
                    v.registrar || '',
                    v.registrationDate || ''
                ]);
            });
        });

        const csv = rows.map(r =>
            r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        ).join('\n');

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sf-domain-scout-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return {
        showStatus,
        hideStatus,
        updateProgress,
        renderResults,
        updateDomainStatus,
        markDomainChecking,
        showResults,
        hideResults,
        exportCSV,
        toggleCard
    };
})();
