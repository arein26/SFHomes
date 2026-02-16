/**
 * Map initialization and area selection via Leaflet + Leaflet Draw.
 */
const MapManager = (() => {
    let map = null;
    let drawnItems = null;
    let drawControl = null;
    let currentSelection = null;
    let addressMarkers = L.layerGroup();

    function init() {
        map = L.map('map', {
            center: Config.map.center,
            zoom: Config.map.zoom,
            minZoom: Config.map.minZoom,
            maxZoom: Config.map.maxZoom,
            maxBounds: Config.map.bounds,
            maxBoundsViscosity: 0.8
        });

        L.tileLayer(Config.map.tileUrl, {
            attribution: Config.map.tileAttribution,
            maxZoom: Config.map.maxZoom
        }).addTo(map);

        // Layer for drawn selections
        drawnItems = new L.FeatureGroup();
        map.addLayer(drawnItems);
        map.addLayer(addressMarkers);

        // Draw controls - rectangle and polygon
        drawControl = new L.Control.Draw({
            position: 'topright',
            draw: {
                rectangle: {
                    shapeOptions: {
                        color: '#2563eb',
                        weight: 2,
                        fillOpacity: 0.1
                    }
                },
                polygon: {
                    allowIntersection: false,
                    showArea: true,
                    shapeOptions: {
                        color: '#2563eb',
                        weight: 2,
                        fillOpacity: 0.1
                    }
                },
                circle: false,
                circlemarker: false,
                marker: false,
                polyline: false
            },
            edit: {
                featureGroup: drawnItems,
                remove: true
            }
        });
        map.addControl(drawControl);

        // Handle draw events
        map.on(L.Draw.Event.CREATED, (e) => {
            drawnItems.clearLayers();
            addressMarkers.clearLayers();
            drawnItems.addLayer(e.layer);
            currentSelection = e.layer;

            const overlay = document.getElementById('map-overlay');
            if (overlay) overlay.classList.add('hidden');

            // Enable search button
            document.getElementById('search-btn').disabled = false;
            document.getElementById('clear-btn').disabled = false;

            // Fire custom event
            document.dispatchEvent(new CustomEvent('areaSelected', {
                detail: { bounds: getSelectionBounds(), layer: e.layer }
            }));
        });

        map.on(L.Draw.Event.DELETED, () => {
            currentSelection = null;
            addressMarkers.clearLayers();
            document.getElementById('search-btn').disabled = true;
            document.getElementById('clear-btn').disabled = true;

            const overlay = document.getElementById('map-overlay');
            if (overlay) overlay.classList.remove('hidden');

            document.dispatchEvent(new CustomEvent('areaCleared'));
        });

        return map;
    }

    /**
     * Get the bounding box of the current selection.
     * Returns { north, south, east, west } or null.
     */
    function getSelectionBounds() {
        if (!currentSelection) return null;

        const bounds = currentSelection.getBounds();
        return {
            north: bounds.getNorth(),
            south: bounds.getSouth(),
            east: bounds.getEast(),
            west: bounds.getWest()
        };
    }

    /**
     * Get the selection as a WKT polygon string (for SODA intersects queries).
     */
    function getSelectionWKT() {
        if (!currentSelection) return null;

        let coords;
        if (currentSelection instanceof L.Rectangle) {
            const b = currentSelection.getBounds();
            coords = [
                [b.getWest(), b.getNorth()],
                [b.getEast(), b.getNorth()],
                [b.getEast(), b.getSouth()],
                [b.getWest(), b.getSouth()],
                [b.getWest(), b.getNorth()]
            ];
        } else if (currentSelection.getLatLngs) {
            const latLngs = currentSelection.getLatLngs()[0];
            coords = latLngs.map(ll => [ll.lng, ll.lat]);
            // Close the ring
            coords.push(coords[0]);
        } else {
            return null;
        }

        const coordStr = coords.map(c => `${c[0]} ${c[1]}`).join(', ');
        return `MULTIPOLYGON(((${coordStr})))`;
    }

    /**
     * Clear the current selection.
     */
    function clearSelection() {
        drawnItems.clearLayers();
        addressMarkers.clearLayers();
        currentSelection = null;
        document.getElementById('search-btn').disabled = true;
        document.getElementById('clear-btn').disabled = true;
        const overlay = document.getElementById('map-overlay');
        if (overlay) overlay.classList.remove('hidden');
    }

    /**
     * Add address markers to the map.
     */
    function addAddressMarkers(addresses) {
        addressMarkers.clearLayers();
        addresses.forEach(addr => {
            if (addr.lat && addr.lng) {
                const marker = L.circleMarker([addr.lat, addr.lng], {
                    radius: 4,
                    fillColor: '#2563eb',
                    color: '#1d4ed8',
                    weight: 1,
                    fillOpacity: 0.7
                });
                marker.bindPopup(`<strong>${addr.fullAddress}</strong>`);
                addressMarkers.addLayer(marker);
            }
        });
    }

    /**
     * Highlight a specific address marker (when it has active domains).
     */
    function highlightMarker(addr) {
        addressMarkers.eachLayer(layer => {
            if (layer.getPopup &&
                layer.getPopup() &&
                layer.getPopup().getContent().includes(addr.fullAddress)) {
                layer.setStyle({
                    fillColor: '#f59e0b',
                    color: '#d97706',
                    radius: 6,
                    fillOpacity: 0.9
                });
            }
        });
    }

    return {
        init,
        getSelectionBounds,
        getSelectionWKT,
        clearSelection,
        addAddressMarkers,
        highlightMarker
    };
})();
