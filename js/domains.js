/**
 * Domain name variation generator and registration checker.
 *
 * For a given SF address, generates plausible domain names someone might
 * register when preparing to list their home for sale.
 *
 * Domain checking uses RDAP (for .com) with DNS-over-HTTPS fallback.
 */
const Domains = (() => {

    // Queue and state for throttled checking
    let checkQueue = [];
    let isChecking = false;
    let activeChecks = 0;
    let cancelToken = { cancelled: false };

    /**
     * Generate domain name variations for an address.
     * @param {Object} addr - { number, streetName, streetSuffix }
     * @returns {string[]} array of domain names (e.g., "2971California.com")
     */
    function generateVariations(addr) {
        if (!addr || !addr.number || !addr.streetName) return [];

        // Strip leading zeros from house number (e.g. "0350" → "350")
        const num = addr.number.replace(/^0+(\d)/, '$1');
        const street = cleanStreetName(addr.streetName);
        const suffix = addr.streetSuffix
            ? Config.streetSuffixes[addr.streetSuffix] || addr.streetSuffix
            : '';
        const fullSuffix = addr.streetSuffix
            ? addr.streetSuffix.charAt(0) + addr.streetSuffix.slice(1).toLowerCase()
            : '';

        const variations = new Set();

        for (const tld of Config.domains.tlds) {
            // Core patterns - number + street name
            variations.add(`${num}${street}${tld}`);

            // With abbreviated suffix
            if (suffix) {
                variations.add(`${num}${street}${suffix}${tld}`);
            }

            // With full suffix
            if (fullSuffix && fullSuffix !== suffix) {
                variations.add(`${num}${street}${fullSuffix}${tld}`);
            }

            // With SF / SanFrancisco
            variations.add(`${num}${street}SF${tld}`);
            variations.add(`${num}${street}SanFrancisco${tld}`);

            // Hyphenated variants
            variations.add(`${num}-${street}${tld}`);
            if (suffix) {
                variations.add(`${num}-${street}-${suffix}${tld}`);
            }
            variations.add(`${num}-${street}-SF${tld}`);

            // Multi-word street names joined
            if (street.includes(' ')) {
                const joined = street.replace(/\s+/g, '');
                variations.add(`${num}${joined}${tld}`);
                if (suffix) {
                    variations.add(`${num}${joined}${suffix}${tld}`);
                }
            }
        }

        return [...variations];
    }

    /**
     * Clean a street name for use in a domain.
     * Handles ordinal numbers (03RD → 3rd) and removes special characters.
     */
    function cleanStreetName(name) {
        return name
            .trim()
            .split(/\s+/)
            .map(w => {
                // Handle ordinal numbers: 03RD → 3rd, 22ND → 22nd, 1ST → 1st
                const ordMatch = w.match(/^0*(\d+)(ST|ND|RD|TH)$/i);
                if (ordMatch) {
                    return ordMatch[1] + ordMatch[2].toLowerCase();
                }
                // Regular word: remove non-alpha, title case
                const cleaned = w.replace(/[^A-Za-z]/g, '');
                if (!cleaned) return '';
                return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
            })
            .filter(Boolean)
            .join('');
    }

    /**
     * Check if a single domain is registered.
     * Tries RDAP first, falls back to DNS-over-HTTPS.
     *
     * @param {string} domain - e.g., "2971California.com"
     * @returns {Promise<Object>} { domain, status, registrar?, registrationDate?, dnsRecords? }
     */
    async function checkDomain(domain) {
        const result = { domain, status: 'unknown' };

        try {
            // Try RDAP for .com domains
            if (domain.endsWith('.com')) {
                const rdapResult = await checkViaRDAP(domain);
                if (rdapResult.status !== 'error') {
                    return rdapResult;
                }
            }

            // Fallback: DNS-over-HTTPS
            return await checkViaDNS(domain);

        } catch (err) {
            result.status = 'error';
            result.error = err.message;
            return result;
        }
    }

    /**
     * Check domain via RDAP (Registration Data Access Protocol).
     * For .com domains, uses VeriSign's RDAP server.
     */
    async function checkViaRDAP(domain) {
        const result = { domain, status: 'unknown' };

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), Config.domains.timeout);

            const response = await fetch(
                Config.domains.rdapComEndpoint + encodeURIComponent(domain),
                {
                    signal: controller.signal,
                    headers: { 'Accept': 'application/rdap+json, application/json' }
                }
            );

            clearTimeout(timeout);

            if (response.status === 200) {
                const data = await response.json();
                result.status = 'registered';

                // Extract useful info from RDAP response
                if (data.entities) {
                    const registrar = data.entities.find(e =>
                        e.roles && e.roles.includes('registrar')
                    );
                    if (registrar) {
                        result.registrar = registrar.vcardArray?.[1]?.find(
                            v => v[0] === 'fn'
                        )?.[3] || registrar.handle || '';
                    }
                }

                if (data.events) {
                    const regEvent = data.events.find(e => e.eventAction === 'registration');
                    if (regEvent) {
                        result.registrationDate = regEvent.eventDate;
                    }
                    const expEvent = data.events.find(e => e.eventAction === 'expiration');
                    if (expEvent) {
                        result.expirationDate = expEvent.eventDate;
                    }
                }

                // Also check DNS to see if the domain is actively configured
                try {
                    const dnsResult = await checkViaDNS(domain);
                    result.hasActiveDNS = dnsResult.status === 'active';
                } catch (_) {
                    result.hasActiveDNS = false;
                }

                if (result.hasActiveDNS) {
                    result.status = 'active';
                }

                return result;
            } else if (response.status === 404) {
                result.status = 'available';
                return result;
            } else {
                result.status = 'error';
                result.error = `RDAP returned ${response.status}`;
                return result;
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                result.status = 'error';
                result.error = 'Timeout';
            } else {
                result.status = 'error';
                result.error = err.message;
            }
            return result;
        }
    }

    /**
     * Check domain via Google DNS-over-HTTPS.
     * Resolves to check if the domain has active DNS records.
     */
    async function checkViaDNS(domain) {
        const result = { domain, status: 'unknown' };

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), Config.domains.timeout);

            const response = await fetch(
                `${Config.domains.dnsEndpoint}?name=${encodeURIComponent(domain)}&type=A`,
                {
                    signal: controller.signal,
                    headers: { 'Accept': 'application/dns-json' }
                }
            );

            clearTimeout(timeout);

            if (!response.ok) {
                result.status = 'error';
                result.error = `DNS returned ${response.status}`;
                return result;
            }

            const data = await response.json();

            // Status 0 = NOERROR (domain exists)
            // Status 3 = NXDOMAIN (domain not found)
            if (data.Status === 0 && data.Answer && data.Answer.length > 0) {
                result.status = 'active';
                result.dnsRecords = data.Answer.map(a => ({
                    type: a.type,
                    data: a.data
                }));
            } else if (data.Status === 3) {
                // NXDOMAIN - domain does not exist in DNS
                // This means it's either not registered or registered but has no DNS
                result.status = 'no_dns';
            } else {
                // Has DNS entry but no A records
                result.status = 'no_dns';
            }

            return result;
        } catch (err) {
            if (err.name === 'AbortError') {
                result.status = 'error';
                result.error = 'Timeout';
            } else {
                result.status = 'error';
                result.error = err.message;
            }
            return result;
        }
    }

    /**
     * Check multiple domains with throttled concurrency.
     * @param {string[]} domains - array of domain names
     * @param {Function} onResult - callback for each result
     * @param {Function} onProgress - callback for progress updates
     * @returns {Promise<Object[]>} all results
     */
    async function checkDomainsBatch(domains, onResult, onProgress) {
        cancelToken = { cancelled: false };
        const results = [];
        let completed = 0;
        const total = domains.length;

        // Create a pool of concurrent workers
        const pool = [];
        let index = 0;

        function next() {
            if (cancelToken.cancelled || index >= domains.length) {
                return Promise.resolve();
            }

            const currentIndex = index++;
            const domain = domains[currentIndex];

            return checkDomain(domain).then(result => {
                if (cancelToken.cancelled) return;

                results[currentIndex] = result;
                completed++;

                if (onResult) onResult(result, currentIndex);
                if (onProgress) onProgress(completed, total);

                return next();
            });
        }

        // Start concurrent workers
        const concurrency = Config.domains.concurrency;
        for (let i = 0; i < Math.min(concurrency, domains.length); i++) {
            pool.push(next());
        }

        await Promise.all(pool);
        return results;
    }

    /**
     * Cancel any in-progress batch checking.
     */
    function cancelChecking() {
        cancelToken.cancelled = true;
    }

    return {
        generateVariations,
        checkDomain,
        checkDomainsBatch,
        cancelChecking
    };
})();
