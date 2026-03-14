/**
 * Simple Leaflet map showing pins for properties with active domains
 * that haven't sold in the last 12 months.
 */
const MapManager = (() => {
    let map = null;
    let markerGroup = null;
    const geocodeCache = {}; // address -> { lat, lng }

    function init() {
        map = L.map('map', {
            center: Config.map.center,
            zoom: Config.map.zoom,
            minZoom: Config.map.minZoom,
            maxZoom: Config.map.maxZoom
        });

        L.tileLayer(Config.map.tileUrl, {
            attribution: Config.map.tileAttribution,
            maxZoom: Config.map.maxZoom
        }).addTo(map);

        markerGroup = L.layerGroup().addTo(map);
        return map;
    }

    /**
     * Check if a property was sold in the last 12 months.
     */
    function soldRecently(addr) {
        if (!addr.closeDate) return false;
        try {
            const parts = addr.closeDate.split('/');
            const d = new Date(parts[2], parts[0] - 1, parts[1]);
            const cutoff = new Date();
            cutoff.setFullYear(cutoff.getFullYear() - 1);
            return d > cutoff;
        } catch (_) {
            return false;
        }
    }

    /**
     * Geocode an SF address using Nominatim.
     */
    async function geocode(address) {
        if (geocodeCache[address]) return geocodeCache[address];

        const query = `${address}, San Francisco, CA`;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const resp = await fetch(
                `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`,
                { signal: controller.signal }
            );
            clearTimeout(timeout);

            if (!resp.ok) return null;
            const data = await resp.json();
            if (data.length > 0) {
                const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
                geocodeCache[address] = result;
                return result;
            }
        } catch (_) { /* timeout or network error */ }
        return null;
    }

    /**
     * Show pins for properties with active domains that haven't sold recently.
     * @param {Array} addresses - all address objects with domainVariations
     */
    async function showPins(addresses) {
        if (!map) return;
        markerGroup.clearLayers();

        // Filter: has active domain AND not sold in last 12 months
        const candidates = addresses.filter(addr => {
            const hasActive = (addr.domainVariations || []).some(v => v.status === 'active');
            return hasActive && !soldRecently(addr);
        });

        if (candidates.length === 0) return;

        // Geocode and add pins with 1s delay between requests (Nominatim policy)
        for (const addr of candidates) {
            const coords = await geocode(addr.fullAddress);
            if (!coords) continue;

            const activeDomain = (addr.domainVariations || []).find(v => v.status === 'active');
            const domainName = activeDomain ? activeDomain.domain : '';

            const popupParts = [`<strong>${addr.fullAddress}</strong>`];
            if (domainName) popupParts.push(`<a href="https://${domainName}" target="_blank" rel="noopener">${domainName}</a>`);
            if (addr.sqft) popupParts.push(`${addr.sqft.toLocaleString()} sqft`);
            if (addr.beds) popupParts.push(`${addr.beds}bd`);
            if (addr.closePrice && addr.closeDate) {
                popupParts.push(`Sold: $${addr.closePrice.toLocaleString()} (${addr.closeDate})`);
            }

            const marker = L.circleMarker([coords.lat, coords.lng], {
                radius: 7,
                fillColor: '#f59e0b',
                color: '#d97706',
                weight: 2,
                fillOpacity: 0.9
            });
            marker.bindPopup(popupParts.join('<br>'));
            markerGroup.addLayer(marker);

            // Respect Nominatim rate limit: 1 req/sec
            if (!geocodeCache[addr.fullAddress]) {
                await new Promise(r => setTimeout(r, 1100));
            }
        }

        // Fit map to show all pins if we have any
        if (markerGroup.getLayers().length > 0) {
            const bounds = markerGroup.getBounds();
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
        }
    }

    /**
     * Clear all pins.
     */
    function clearPins() {
        if (markerGroup) markerGroup.clearLayers();
    }

    return { init, showPins, clearPins, soldRecently };
})();
