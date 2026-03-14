/**
 * Property database loaded from local JSON (built from ZenList exports).
 * Replaces the old SF Open Data API integration.
 */
const SFData = (() => {

    let _properties = null; // cached after first load

    /**
     * Load the property database from properties.json.
     */
    async function loadDatabase() {
        if (_properties) return _properties;

        const response = await fetch('data/properties.json');
        if (!response.ok) throw new Error('Failed to load property database');
        _properties = await response.json();
        return _properties;
    }

    /**
     * Get all properties, optionally filtered by map bounds.
     * Since our database doesn't have lat/lng, bounds filtering is skipped
     * and all properties are returned. The full database IS the target area.
     */
    async function getAddressesInArea(bounds, limit, onStatus) {
        onStatus('Loading property database...');
        const properties = await loadDatabase();

        onStatus(`Found ${properties.length} single-family homes.`);

        return properties.slice(0, limit).map(prop => ({
            fullAddress: prop.address,
            number: prop.number,
            streetName: extractStreetName(prop.street),
            streetSuffix: extractStreetSuffix(prop.street),
            unit: '',
            // Property details from ZenList
            beds: prop.beds,
            fullBaths: prop.fullBaths,
            halfBaths: prop.halfBaths,
            sqft: prop.sqft,
            lotAcres: prop.lotAcres,
            yearBuilt: prop.yearBuilt,
            listPrice: prop.listPrice,
            closeDate: prop.closeDate,
            closePrice: prop.closePrice,
            pricePerSqft: prop.pricePerSqft,
            soldPricePerSqft: prop.soldPricePerSqft,
            zipCode: prop.zipCode,
            crossStreet: prop.crossStreet,
            garageSpaces: prop.garageSpaces,
            status: prop.status,
            subtype: prop.subtype,
            neighborhood: '',
            lat: null,
            lng: null
        }));
    }

    /**
     * Extract the street name (without suffix) from a street string.
     * "Gough St" → "GOUGH", "California" → "CALIFORNIA"
     */
    function extractStreetName(street) {
        if (!street) return '';
        const upper = street.trim().toUpperCase();
        const words = upper.split(/\s+/);
        const lastWord = words[words.length - 1];

        const suffixes = Object.keys(Config.streetSuffixes);
        const abbrevs = Object.values(Config.streetSuffixes).map(s => s.toUpperCase());
        const extraAbbrevs = ['AV', 'AVE', 'STRT', 'BL', 'BLV', 'CR', 'TR', 'WY', 'LA', 'HY'];
        const allSuffixes = [...suffixes, ...abbrevs, ...extraAbbrevs];

        if (words.length > 1 && allSuffixes.includes(lastWord)) {
            return words.slice(0, -1).join(' ');
        }
        return upper;
    }

    /**
     * Extract the street suffix from a street string.
     * "Gough St" → "STREET", "California" → ""
     */
    function extractStreetSuffix(street) {
        if (!street) return '';
        const upper = street.trim().toUpperCase();
        const words = upper.split(/\s+/);
        const lastWord = words[words.length - 1];

        const suffixMap = {};
        for (const [full, abbr] of Object.entries(Config.streetSuffixes)) {
            suffixMap[abbr.toUpperCase()] = full;
            suffixMap[full] = full;
        }
        // Extra abbreviations
        const extras = { 'AV': 'AVENUE', 'AVE': 'AVENUE', 'STRT': 'STREET', 'BL': 'BOULEVARD', 'BLV': 'BOULEVARD' };
        Object.assign(suffixMap, extras);

        if (words.length > 1 && suffixMap[lastWord]) {
            return suffixMap[lastWord];
        }
        return '';
    }

    return {
        getAddressesInArea,
        loadDatabase
    };
})();
