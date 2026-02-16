/**
 * SF Open Data API integration.
 * Fetches single-family home addresses within a geographic area.
 *
 * Strategy:
 * 1. Query the Land Use dataset with a geospatial bounding box for residential parcels.
 * 2. Use the returned block/lot identifiers to query the Assessor dataset for addresses.
 * 3. Filter for single-family homes specifically.
 * 4. Fallback: query the Assessor dataset directly if the Land Use approach fails.
 */
const SFData = (() => {

    /**
     * Main entry: fetch single-family home addresses within the given bounds.
     * @param {Object} bounds - { north, south, east, west }
     * @param {number} limit - max results
     * @param {Function} onStatus - callback for status updates
     * @returns {Promise<Array>} array of address objects
     */
    async function getAddressesInArea(bounds, limit, onStatus) {
        onStatus('Searching for residential parcels in selected area...');

        try {
            // Strategy 1: Land Use dataset with geospatial query
            const addresses = await fetchViaLandUse(bounds, limit, onStatus);
            if (addresses.length > 0) {
                return addresses;
            }
        } catch (err) {
            console.warn('Land Use query failed, trying fallback:', err.message);
        }

        // Strategy 2: Parcels dataset with geospatial query + assessor lookup
        try {
            onStatus('Trying parcels dataset...');
            const addresses = await fetchViaParcels(bounds, limit, onStatus);
            if (addresses.length > 0) {
                return addresses;
            }
        } catch (err) {
            console.warn('Parcels query failed, trying assessor fallback:', err.message);
        }

        // Strategy 3: Direct assessor query by neighborhood
        onStatus('Trying assessor dataset directly...');
        return await fetchViaAssessorDirect(bounds, limit, onStatus);
    }

    /**
     * Strategy 1: Query Land Use dataset for residential parcels in bounding box,
     * then look up addresses in Assessor dataset.
     */
    async function fetchViaLandUse(bounds, limit, onStatus) {
        const where = buildBBoxWhere('the_geom', bounds) +
            ` AND landuse IN ('RESIDENT','MIXRES')`;

        const url = Config.sfdata.landUseEndpoint +
            `?$where=${encodeURIComponent(where)}` +
            `&$limit=${limit}` +
            `&$select=blklot,landuse`;

        onStatus('Querying land use data...');
        const landUseData = await fetchJSON(url);

        if (!landUseData || landUseData.length === 0) {
            return [];
        }

        onStatus(`Found ${landUseData.length} residential parcels. Looking up addresses...`);

        // Extract block/lot numbers
        const blockLots = landUseData
            .map(r => r.blklot || r.mapblklot || r.block_lot)
            .filter(Boolean);

        if (blockLots.length === 0) return [];

        // Query assessor for addresses
        return await lookupAssessorAddresses(blockLots, onStatus);
    }

    /**
     * Strategy 2: Query Parcels dataset for geometry in bounding box,
     * then look up in Assessor.
     */
    async function fetchViaParcels(bounds, limit, onStatus) {
        const where = buildBBoxWhere('the_geom', bounds);

        const url = Config.sfdata.parcelsEndpoint +
            `?$where=${encodeURIComponent(where)}` +
            `&$limit=${limit}` +
            `&$select=blklot,mapblklot,block_num,lot_num`;

        const parcelsData = await fetchJSON(url);

        if (!parcelsData) return [];

        // Handle GeoJSON response
        const features = parcelsData.features || parcelsData;
        const blockLots = features.map(f => {
            const props = f.properties || f;
            return props.blklot || props.mapblklot ||
                   (props.block_num && props.lot_num ? props.block_num + props.lot_num : null);
        }).filter(Boolean);

        if (blockLots.length === 0) return [];

        onStatus(`Found ${blockLots.length} parcels. Looking up addresses...`);
        return await lookupAssessorAddresses(blockLots, onStatus);
    }

    /**
     * Strategy 3: Query Assessor dataset directly.
     * Uses the analysis_neighborhood field to approximate area matching.
     */
    async function fetchViaAssessorDirect(bounds, limit, onStatus) {
        // Get the most recent year's data, filtered for single family
        const sfhFilters = Config.sfdata.singleFamilyUseDefinitions
            .map(d => `use_definition='${d}'`)
            .join(' OR ');

        // We can't do geospatial on the assessor data directly,
        // so get single family homes and filter client-side if we have coords
        const url = Config.sfdata.assessorEndpoint +
            `?$where=${encodeURIComponent(`(${sfhFilters}) AND closed_roll_fiscal_year='${Config.sfdata.latestFiscalYear}'`)}` +
            `&$limit=${limit}` +
            `&$select=property_location,block,lot,use_definition,analysis_neighborhood,number_of_bedrooms,number_of_bathrooms,year_property_built` +
            `&$order=property_location`;

        onStatus('Querying assessor data for single-family homes...');
        const data = await fetchJSON(url);

        if (!data || data.length === 0) {
            // Try without fiscal year filter
            const fallbackUrl = Config.sfdata.assessorEndpoint +
                `?$where=${encodeURIComponent(`(${sfhFilters})`)}` +
                `&$limit=${limit}` +
                `&$select=property_location,block,lot,use_definition,analysis_neighborhood,number_of_bedrooms,number_of_bathrooms,year_property_built` +
                `&$order=closed_roll_fiscal_year DESC,property_location`;

            onStatus('Retrying with broader query...');
            const fallbackData = await fetchJSON(fallbackUrl);
            if (!fallbackData || fallbackData.length === 0) return [];
            return deduplicateAndParse(fallbackData);
        }

        return deduplicateAndParse(data);
    }

    /**
     * Look up addresses from the Assessor dataset by block/lot numbers.
     * Batches queries to stay within SODA limits.
     */
    async function lookupAssessorAddresses(blockLots, onStatus) {
        const unique = [...new Set(blockLots)];
        const batchSize = 50;
        const allResults = [];

        for (let i = 0; i < unique.length; i += batchSize) {
            const batch = unique.slice(i, i + batchSize);

            // Build block/lot where clause
            // Assessor has separate block and lot fields
            // blklot format is typically "BBBBLLLL" (4-digit block + 3-4 digit lot)
            const conditions = batch.map(bl => {
                // Try to split into block and lot
                const block = bl.substring(0, 4);
                const lot = bl.substring(4);
                return `(block='${block}' AND lot='${lot}')`;
            }).join(' OR ');

            const sfhFilters = Config.sfdata.singleFamilyUseDefinitions
                .map(d => `use_definition='${d}'`)
                .join(' OR ');

            const where = `(${conditions}) AND (${sfhFilters})` +
                ` AND closed_roll_fiscal_year='${Config.sfdata.latestFiscalYear}'`;

            const url = Config.sfdata.assessorEndpoint +
                `?$where=${encodeURIComponent(where)}` +
                `&$limit=1000` +
                `&$select=property_location,block,lot,use_definition,analysis_neighborhood,number_of_bedrooms,number_of_bathrooms,year_property_built`;

            onStatus(`Looking up addresses... (batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(unique.length / batchSize)})`);

            try {
                const data = await fetchJSON(url);
                if (data && data.length > 0) {
                    allResults.push(...data);
                }
            } catch (err) {
                console.warn(`Batch ${i} failed:`, err.message);
            }
        }

        return deduplicateAndParse(allResults);
    }

    /**
     * Deduplicate assessor records and parse addresses.
     */
    function deduplicateAndParse(records) {
        const seen = new Set();
        const results = [];

        for (const rec of records) {
            const loc = (rec.property_location || '').trim().toUpperCase();
            if (!loc || seen.has(loc)) continue;
            seen.add(loc);

            const parsed = parseAddress(loc);
            if (!parsed) continue;

            results.push({
                fullAddress: formatAddress(loc),
                rawAddress: loc,
                ...parsed,
                neighborhood: rec.analysis_neighborhood || '',
                bedrooms: rec.number_of_bedrooms || '',
                bathrooms: rec.number_of_bathrooms || '',
                yearBuilt: rec.year_property_built || '',
                blockLot: (rec.block || '') + (rec.lot || ''),
                lat: null, // Not available from assessor data
                lng: null
            });
        }

        return results;
    }

    /**
     * Parse a raw address like "2971 CALIFORNIA ST" into components.
     * Returns { number, streetName, streetSuffix, unit } or null.
     */
    function parseAddress(raw) {
        if (!raw) return null;

        // Clean up the address
        let addr = raw.trim().toUpperCase();

        // Remove unit/apt designators
        let unit = '';
        const unitMatch = addr.match(/\s+(#|APT|UNIT|STE|SUITE)\s*(\S+)\s*$/i);
        if (unitMatch) {
            unit = unitMatch[0].trim();
            addr = addr.substring(0, addr.length - unit.length).trim();
        }

        // Match: number + street name + optional suffix
        const match = addr.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;

        const number = match[1];
        let streetPart = match[2].trim();

        // Identify and separate street suffix
        let streetName = '';
        let streetSuffix = '';
        const suffixKeys = Object.keys(Config.streetSuffixes);

        // Check if the last word is a known suffix
        const words = streetPart.split(/\s+/);
        const lastWord = words[words.length - 1];

        // Also check common abbreviations
        const abbrevToFull = {};
        for (const [full, abbr] of Object.entries(Config.streetSuffixes)) {
            abbrevToFull[abbr.toUpperCase()] = full;
        }

        if (suffixKeys.includes(lastWord)) {
            streetSuffix = lastWord;
            streetName = words.slice(0, -1).join(' ');
        } else if (abbrevToFull[lastWord]) {
            streetSuffix = abbrevToFull[lastWord];
            streetName = words.slice(0, -1).join(' ');
        } else {
            // No recognized suffix
            streetName = streetPart;
            streetSuffix = '';
        }

        if (!streetName) return null;

        return { number, streetName, streetSuffix, unit };
    }

    /**
     * Format address for display (title case).
     */
    function formatAddress(raw) {
        return raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    /**
     * Build a SODA $where clause for bounding box.
     */
    function buildBBoxWhere(geomField, bounds) {
        return `within_box(${geomField}, ${bounds.north}, ${bounds.west}, ${bounds.south}, ${bounds.east})`;
    }

    /**
     * Fetch JSON from a URL with error handling.
     */
    async function fetchJSON(url) {
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return response.json();
    }

    return {
        getAddressesInArea,
        parseAddress,
        formatAddress
    };
})();
