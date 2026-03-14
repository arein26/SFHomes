/**
 * Application configuration and constants.
 */
const Config = {
    // San Francisco map center and bounds
    map: {
        center: [37.7749, -122.4194],
        zoom: 13,
        minZoom: 11,
        maxZoom: 18,
        // Rough bounding box for San Francisco
        bounds: [
            [37.7025, -122.5150], // SW corner
            [37.8120, -122.3550]  // NE corner
        ],
        tileUrl: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
                          '&copy; <a href="https://carto.com/attributions">CARTO</a>'
    },

    // SF Open Data (DataSF) SODA API endpoints
    sfdata: {
        // Land Use dataset - has geometry + land use type
        landUseEndpoint: 'https://data.sfgov.org/resource/us3s-fp9q.json',
        landUseGeoEndpoint: 'https://data.sfgov.org/resource/us3s-fp9q.geojson',

        // Assessor Historical Secured Property Tax Rolls - has addresses + property details
        assessorEndpoint: 'https://data.sfgov.org/resource/wv5m-vpq2.json',

        // Parcels Active - has geometry + block/lot
        parcelsEndpoint: 'https://data.sfgov.org/resource/acdm-wktn.json',

        // Fiscal years to try (newest first; the dataset ends at 2022-2023)
        fiscalYears: ['2023', '2022', '2021'],

        // Residential land use codes (for land-use dataset filtering)
        residentialLandUse: ['RESIDENT', 'MIXRES'],

        // Assessor use codes: single-family + TIC (common SF house type)
        singleFamilyUseCodes: ['SRES'],

        // Property class code "D" = Dwelling (excludes condos under SRES)
        dwellingClassCode: 'D',

        // Default query limit
        defaultLimit: 100
    },

    // Domain checking configuration
    domains: {
        // RDAP endpoint for .com domains (VeriSign)
        rdapComEndpoint: 'https://rdap.verisign.com/com/v1/domain/',

        // Google DNS-over-HTTPS for fallback
        dnsEndpoint: 'https://dns.google/resolve',

        // Max concurrent domain checks
        concurrency: 4,

        // Delay between batches (ms)
        batchDelay: 200,

        // TLDs to check
        tlds: ['.com'],

        // Request timeout (ms)
        timeout: 8000
    },

    // Street suffix mappings: full form → abbreviation
    streetSuffixes: {
        'STREET': 'St',
        'AVENUE': 'Ave',
        'BOULEVARD': 'Blvd',
        'DRIVE': 'Dr',
        'LANE': 'Ln',
        'WAY': 'Way',
        'PLACE': 'Pl',
        'COURT': 'Ct',
        'CIRCLE': 'Cir',
        'TERRACE': 'Ter',
        'ROAD': 'Rd',
        'HIGHWAY': 'Hwy',
        'ALLEY': 'Aly',
        'TRAIL': 'Trl',
        'PLAZA': 'Plz',
        'PARKWAY': 'Pkwy',
        'WALK': 'Walk',
        'PATH': 'Path'
    }
};
