/**
 * SF Open Data API integration.
 * Fetches single-family home addresses within a geographic area.
 */
const SFData = (() => {

    // ── On-page debug helper (no console needed) ──
    let _debugEl = null;
    function dbg(msg) {
        if (!_debugEl) {
            _debugEl = document.createElement('pre');
            _debugEl.id = 'api-debug';
            _debugEl.style.cssText = 'background:#111;color:#0f0;font-size:11px;' +
                'padding:10px;margin:10px;max-height:300px;overflow:auto;' +
                'white-space:pre-wrap;word-break:break-all;border-radius:6px;';
            const main = document.querySelector('main');
            if (main) main.appendChild(_debugEl);
        }
        _debugEl.textContent += msg + '\n';
    }

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
     * Additional suffix abbreviations used by SF assessor data that differ
     * from the canonical abbreviations in Config.streetSuffixes.
     */
    const EXTRA_SUFFIX_MAP = {
        'AV': 'AVENUE',
        'AVE': 'AVENUE',
        'STRT': 'STREET',
        'BL': 'BOULEVARD',
        'BLV': 'BOULEVARD',
        'CR': 'CIRCLE',
        'TR': 'TERRACE',
        'WY': 'WAY',
        'LA': 'LANE',
        'HY': 'HIGHWAY',
    };

    /**
     * Main entry: fetch single-family home addresses within the given bounds.
     */
    async function getAddressesInArea(bounds, limit, onStatus) {
        if (_debugEl) _debugEl.textContent = '';
        dbg('=== SEARCH DEBUG ===');
        dbg('Bounds: ' + JSON.stringify(bounds));

        onStatus('Searching for residential parcels in selected area...');

        // Strategy 1: Land Use dataset (has landuse type + geometry)
        try {
            const addresses = await fetchViaLandUse(bounds, limit, onStatus);
            if (addresses.length > 0) return addresses;
        } catch (err) {
            dbg('Strategy 1 FAILED: ' + err.message);
        }

        // Strategy 2: Parcels dataset (confirmed geometry column = "shape")
        try {
            onStatus('Trying parcels dataset...');
            const addresses = await fetchViaParcels(bounds, limit, onStatus);
            if (addresses.length > 0) return addresses;
        } catch (err) {
            dbg('Strategy 2 FAILED: ' + err.message);
        }

        // Strategy 3: Assessor dataset directly (has the_geom for geo filtering)
        onStatus('Trying assessor dataset directly...');
        return await fetchViaAssessorDirect(bounds, limit, onStatus);
    }

    /**
     * Strategy 1: Land Use dataset with intersects().
     * Geometry column may be "the_geom" or "shape".
     */
    async function fetchViaLandUse(bounds, limit, onStatus) {
        const poly = boundsToWKT(bounds);

        // Try "the_geom" first, then "shape" as fallback
        for (const geoCol of ['the_geom', 'shape']) {
            const where = `intersects(${geoCol}, '${poly}') AND landuse IN ('RESIDENT','MIXRES')`;
            const url = Config.sfdata.landUseEndpoint +
                `?$where=${encodeURIComponent(where)}` +
                `&$limit=${limit}` +
                `&$select=blklot,landuse`;

            onStatus('Querying land use data...');
            dbg(`Strategy 1 (${geoCol}): ${url}`);

            try {
                const landUseData = await fetchJSON(url);
                dbg(`Strategy 1 (${geoCol}) rows: ${landUseData ? landUseData.length : 0}`);
                if (landUseData && landUseData[0]) dbg('Sample: ' + JSON.stringify(landUseData[0]));

                if (!landUseData || landUseData.length === 0) continue;

                onStatus(`Found ${landUseData.length} residential parcels. Looking up addresses...`);
                const blockLots = landUseData
                    .map(r => r.blklot || r.mapblklot || r.block_lot)
                    .filter(Boolean);

                if (blockLots.length === 0) continue;
                return await lookupAssessorAddresses(blockLots, onStatus);
            } catch (err) {
                dbg(`Strategy 1 (${geoCol}) error: ${err.message}`);
            }
        }
        return [];
    }

    /**
     * Strategy 2: Parcels dataset with intersects().
     * Geometry column is confirmed as "shape".
     */
    async function fetchViaParcels(bounds, limit, onStatus) {
        const poly = boundsToWKT(bounds);
        const where = `intersects(shape, '${poly}')`;

        const url = Config.sfdata.parcelsEndpoint +
            `?$where=${encodeURIComponent(where)}` +
            `&$limit=${limit}` +
            `&$select=blklot,mapblklot,block_num,lot_num`;

        dbg('Strategy 2 URL: ' + url);
        const parcelsData = await fetchJSON(url);
        const features = parcelsData ? (parcelsData.features || parcelsData) : [];
        dbg('Strategy 2 rows: ' + features.length);
        if (!features || features.length === 0) return [];
        if (features[0]) dbg('Sample: ' + JSON.stringify(features[0]).slice(0, 300));

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
     * Strategy 3: Query Assessor directly with geographic bounds.
     * The assessor dataset has a "the_geom" column for spatial filtering.
     */
    async function fetchViaAssessorDirect(bounds, limit, onStatus) {
        // Probe: fetch 1 unfiltered row to see real field names
        try {
            const probeUrl = Config.sfdata.assessorEndpoint + '?$limit=1';
            dbg('Assessor probe URL: ' + probeUrl);
            const probeData = await fetchJSON(probeUrl);
            if (probeData && probeData[0]) {
                dbg('Assessor FIELDS: ' + Object.keys(probeData[0]).join(', '));
                dbg('Assessor SAMPLE: ' + JSON.stringify(probeData[0]).slice(0, 600));
            }
        } catch (e) {
            dbg('Assessor probe FAILED: ' + e.message);
        }

        const useFilter = buildUseCodeFilter();
        const poly = boundsToWKT(bounds);
        const geoFilter = `intersects(the_geom, '${poly}')`;
        dbg('useFilter: ' + useFilter);
        dbg('geoFilter: ' + geoFilter);

        // Try with geographic bounds + fiscal year
        for (const fy of Config.sfdata.fiscalYears) {
            const where = `(${useFilter}) AND closed_roll_year='${fy}' AND ${geoFilter}`;
            const url = Config.sfdata.assessorEndpoint +
                `?$where=${encodeURIComponent(where)}` +
                `&$limit=${limit}` +
                `&$select=${ASSESSOR_SELECT}` +
                `&$order=property_location`;

            onStatus(`Querying assessor for single-family homes (FY ${fy})...`);
            dbg('Strategy 3 FY ' + fy + ': ' + url);

            try {
                const data = await fetchJSON(url);
                dbg('Strategy 3 FY ' + fy + ' rows: ' + (data ? data.length : 0));
                if (data && data.length > 0) return deduplicateAndParse(data);
            } catch (err) {
                dbg('Strategy 3 FY ' + fy + ' FAILED: ' + err.message);
            }
        }

        // Fallback: geographic bounds but no fiscal year filter
        const fallbackWhere = `(${useFilter}) AND ${geoFilter}`;
        const fallbackUrl = Config.sfdata.assessorEndpoint +
            `?$where=${encodeURIComponent(fallbackWhere)}` +
            `&$limit=${limit}` +
            `&$select=${ASSESSOR_SELECT}` +
            `&$order=closed_roll_year DESC,property_location`;

        onStatus('Retrying with broader query...');
        dbg('Strategy 3 fallback: ' + fallbackUrl);
        try {
            const fallbackData = await fetchJSON(fallbackUrl);
            dbg('Strategy 3 fallback rows: ' + (fallbackData ? fallbackData.length : 0));
            if (!fallbackData || fallbackData.length === 0) return [];
            return deduplicateAndParse(fallbackData);
        } catch (err) {
            dbg('Strategy 3 fallback FAILED: ' + err.message);
            return [];
        }
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
                    dbg(`Batch ${i} FY ${fy} FAILED: ${err.message}`);
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
                    dbg(`Batch ${i} fallback FAILED: ${err.message}`);
                }
            }
        }

        dbg('Assessor lookup total results: ' + allResults.length);
        return deduplicateAndParse(allResults);
    }

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
     * Handles SF assessor abbreviations like "AV" for Avenue.
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

        // Build abbreviation → full form lookup from config
        const abbrevToFull = {};
        for (const [full, abbr] of Object.entries(Config.streetSuffixes)) {
            abbrevToFull[abbr.toUpperCase()] = full;
        }
        // Merge extra abbreviations (e.g. "AV" → "AVENUE")
        Object.assign(abbrevToFull, EXTRA_SUFFIX_MAP);

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
     * Convert bounds to a WKT POLYGON string for intersects().
     * WKT uses longitude-latitude order (x y).
     * Ring is counterclockwise (exterior).
     */
    function boundsToWKT(bounds) {
        const { north, south, east, west } = bounds;
        return `POLYGON((${west} ${south}, ${east} ${south}, ${east} ${north}, ${west} ${north}, ${west} ${south}))`;
    }

    async function fetchJSON(url) {
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            dbg('API ERROR ' + response.status + ': ' + body.slice(0, 300));
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
