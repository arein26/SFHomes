/**
 * SF Open Data API integration.
 * Fetches single-family home addresses within a geographic area.
 *
 * Strategy:
 * 1. Query the Land Use dataset with intersects() for residential parcels.
 * 2. Use the returned block/lot identifiers to query the Assessor dataset for addresses.
 * 3. Filter for single-family homes via use_code='SRES'.
 * 4. Fallback: query the Assessor dataset directly if the Land Use approach fails.
 */
const SFData = (() => {

    /** Build the assessor use-code filter clause. */
    function buildUseCodeFilter() {
        return Config.sfdata.singleFamilyUseCodes
            .map(c => `use_code='${c}'`)
            .join(' OR ');
    }

    const ASSESSOR_SELECT = [
        'property_location', 'block', 'lot', 'use_code', 'use_definition',
        'property_class_code', 'analysis_neighborhood',
        'number_of_bedrooms', 'number_of_bathrooms', 'year_property_built'
    ].join(',');

    /**
     * Main entry: fetch single-family home addresses within the given bounds.
     */
    async function getAddressesInArea(bounds, limit, onStatus) {
        onStatus('Searching for residential parcels in selected area...');

        try {
            const addresses = await fetchViaLandUse(bounds, limit, onStatus);
            if (addresses.length > 0) return addresses;
        } catch (err) {
            console.warn('Land Use query failed, trying fallback:', err.message);
        }

        try {
            onStatus('Trying parcels dataset...');
            const addresses = await fetchViaParcels(bounds, limit, onStatus);
            if (addresses.length > 0) return addresses;
        } catch (err) {
            console.warn('Parcels query failed, trying assessor fallback:', err.message);
        }

        onStatus('Trying assessor dataset directly...');
        return await fetchViaAssessorDirect(bounds, limit, onStatus);
    }

    /**
     * Strategy 1: Query Land Use dataset for residential parcels using
     * intersects() (works with polygon geometry), then look up addresses.
     */
    async function fetchViaLandUse(bounds, limit, onStatus) {
        const poly = boundsToWKT(bounds);
        const where = `intersects(the_geom, '${poly}') AND landuse IN ('RESIDENT','MIXRES')`;

        const url = Config.sfdata.landUseEndpoint +
            `?$where=${encodeURIComponent(where)}` +
            `&$limit=${limit}` +
            `&$select=blklot,landuse`;

        onStatus('Querying land use data...');
        const landUseData = await fetchJSON(url);

        if (!landUseData || landUseData.length === 0) return [];

        onStatus(`Found ${landUseData.length} residential parcels. Looking up addresses...`);

        const blockLots = landUseData
            .map(r => r.blklot || r.mapblklot || r.block_lot)
            .filter(Boolean);

        if (blockLots.length === 0) return [];
        return await lookupAssessorAddresses(blockLots, onStatus);
    }

    /**
     * Strategy 2: Query Parcels dataset using intersects(), then look up in Assessor.
     */
    async function fetchViaParcels(bounds, limit, onStatus) {
        const poly = boundsToWKT(bounds);
        const where = `intersects(the_geom, '${poly}')`;

        const url = Config.sfdata.parcelsEndpoint +
            `?$where=${encodeURIComponent(where)}` +
            `&$limit=${limit}` +
            `&$select=blklot,mapblklot,block_num,lot_num`;

        const parcelsData = await fetchJSON(url);
        if (!parcelsData || parcelsData.length === 0) return [];

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
     * Strategy 3: Query Assessor dataset directly by use_code.
     */
    async function fetchViaAssessorDirect(bounds, limit, onStatus) {
        const useFilter = buildUseCodeFilter();

        for (const fy of Config.sfdata.fiscalYears) {
            const where = `(${useFilter}) AND closed_roll_year='${fy}'`;
            const url = Config.sfdata.assessorEndpoint +
                `?$where=${encodeURIComponent(where)}` +
                `&$limit=${limit}` +
                `&$select=${ASSESSOR_SELECT}` +
                `&$order=property_location`;

            onStatus(`Querying assessor data for single-family homes (FY ${fy})...`);

            try {
                const data = await fetchJSON(url);
                if (data && data.length > 0) return deduplicateAndParse(data);
            } catch (err) {
                console.warn(`Assessor query for FY ${fy} failed:`, err.message);
            }
        }

        // Fallback: no fiscal year filter
        const fallbackUrl = Config.sfdata.assessorEndpoint +
            `?$where=${encodeURIComponent(`(${useFilter})`)}` +
            `&$limit=${limit}` +
            `&$select=${ASSESSOR_SELECT}` +
            `&$order=closed_roll_year DESC,property_location`;

        onStatus('Retrying with broader query...');
        const fallbackData = await fetchJSON(fallbackUrl);
        if (!fallbackData || fallbackData.length === 0) return [];
        return deduplicateAndParse(fallbackData);
    }

    /**
     * Look up addresses from the Assessor dataset by block/lot numbers.
     */
    async function lookupAssessorAddresses(blockLots, onStatus) {
        const unique = [...new Set(blockLots)];
        const batchSize = 50;
        const allResults = [];
        const useFilter = buildUseCodeFilter();

        for (let i = 0; i < unique.length; i += batchSize) {
            const batch = unique.slice(i, i + batchSize);

            const conditions = batch.map(bl => {
                const block = bl.substring(0, 4);
                const lot = bl.substring(4);
                return `(block='${block}' AND lot='${lot}')`;
            }).join(' OR ');

            onStatus(`Looking up addresses... (batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(unique.length / batchSize)})`);

            let batchFound = false;
            for (const fy of Config.sfdata.fiscalYears) {
                const where = `(${conditions}) AND (${useFilter}) AND closed_roll_year='${fy}'`;
                const url = Config.sfdata.assessorEndpoint +
                    `?$where=${encodeURIComponent(where)}` +
                    `&$limit=1000` +
                    `&$select=${ASSESSOR_SELECT}`;

                try {
                    const data = await fetchJSON(url);
                    if (data && data.length > 0) {
                        allResults.push(...data);
                        batchFound = true;
                        break;
                    }
                } catch (err) {
                    console.warn(`Batch ${i} FY ${fy} failed:`, err.message);
                }
            }

            if (!batchFound) {
                const where = `(${conditions}) AND (${useFilter})`;
                const url = Config.sfdata.assessorEndpoint +
                    `?$where=${encodeURIComponent(where)}` +
                    `&$limit=1000` +
                    `&$select=${ASSESSOR_SELECT}`;
                try {
                    const data = await fetchJSON(url);
                    if (data && data.length > 0) allResults.push(...data);
                } catch (err) {
                    console.warn(`Batch ${i} fallback failed:`, err.message);
                }
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
                lat: null,
                lng: null
            });
        }

        return results;
    }

    /**
     * Parse a raw address like "2971 CALIFORNIA ST" into components.
     */
    function parseAddress(raw) {
        if (!raw) return null;

        let addr = raw.trim().toUpperCase();

        let unit = '';
        const unitMatch = addr.match(/\s+(#|APT|UNIT|STE|SUITE)\s*(\S+)\s*$/i);
        if (unitMatch) {
            unit = unitMatch[0].trim();
            addr = addr.substring(0, addr.length - unit.length).trim();
        }

        const match = addr.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;

        const number = match[1];
        let streetPart = match[2].trim();

        let streetName = '';
        let streetSuffix = '';
        const suffixKeys = Object.keys(Config.streetSuffixes);

        const words = streetPart.split(/\s+/);
        const lastWord = words[words.length - 1];

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
            streetName = streetPart;
            streetSuffix = '';
        }

        if (!streetName) return null;
        return { number, streetName, streetSuffix, unit };
    }

    function formatAddress(raw) {
        return raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    /**
     * Convert bounds to a WKT MULTIPOLYGON string for intersects().
     * WKT uses longitude-latitude order.
     */
    function boundsToWKT(bounds) {
        const { north, south, east, west } = bounds;
        return `MULTIPOLYGON(((${west} ${north}, ${east} ${north}, ${east} ${south}, ${west} ${south}, ${west} ${north})))`;
    }

    async function fetchJSON(url) {
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            console.error(`API error ${response.status} for ${url}:`, body);
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
