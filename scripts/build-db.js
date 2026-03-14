#!/usr/bin/env node
/**
 * Merge ZenList CSV exports into a single deduplicated JSON database.
 * Run: node scripts/build-db.js
 * Output: data/properties.json
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUTPUT = path.join(DATA_DIR, 'properties.json');

function parseCSV(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const values = parseCSVLine(line);
        const row = {};
        headers.forEach((h, idx) => {
            row[h] = (values[idx] || '').trim();
        });
        rows.push(row);
    }
    return rows;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
    }
    result.push(current);
    return result;
}

function cleanPrice(s) {
    if (!s) return null;
    const n = parseInt(s.replace(/[$,]/g, ''), 10);
    return isNaN(n) ? null : n;
}

function cleanNum(s) {
    if (!s) return null;
    const n = parseFloat(s.replace(/[,]/g, ''));
    return isNaN(n) ? null : n;
}

function normalizeAddress(addr) {
    // Normalize for dedup: uppercase, collapse spaces, strip unit suffixes
    return addr.trim().toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*(#|APT|UNIT|STE)\s*\S*$/i, '')
        .replace(/,?\s*SAN FRANCISCO.*$/i, '')
        .trim();
}

// Read all CSVs
const csvFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .sort();

console.log(`Found ${csvFiles.length} CSV files`);

const allRows = [];
for (const file of csvFiles) {
    const text = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
    const rows = parseCSV(text);
    console.log(`  ${file}: ${rows.length} rows`);
    allRows.push(...rows);
}

console.log(`Total raw rows: ${allRows.length}`);

// Deduplicate by normalized address, keeping the most recent/complete record
const byAddress = new Map();
for (const row of allRows) {
    const addr = row['Address'];
    if (!addr) continue;
    const key = normalizeAddress(addr);
    if (!key) continue;

    const existing = byAddress.get(key);
    if (!existing) {
        byAddress.set(key, row);
    } else {
        // Prefer rows with close date/price, or higher completeness
        const existingScore = (existing['Close Date'] ? 10 : 0) + (existing['Close Price'] ? 5 : 0);
        const newScore = (row['Close Date'] ? 10 : 0) + (row['Close Price'] ? 5 : 0);
        if (newScore > existingScore) {
            byAddress.set(key, row);
        }
    }
}

console.log(`Unique addresses: ${byAddress.size}`);

// Build JSON database
const properties = [];
for (const [normAddr, row] of byAddress) {
    const addr = row['Address'].trim();

    // Parse address into number + street
    const addrMatch = addr.match(/^(\d+[-\d]*)\s+(.+)$/);
    if (!addrMatch) {
        console.log(`  Skipping unparseable: "${addr}"`);
        continue;
    }

    const prop = {
        address: addr,
        number: addrMatch[1],
        street: addrMatch[2],
        status: row['Status'] || '',
        subtype: row['Property SubType'] || '',
        beds: cleanNum(row['Beds']),
        fullBaths: cleanNum(row['Full baths']),
        halfBaths: cleanNum(row['Half baths']),
        sqft: cleanNum(row['Living area (ft²)']),
        lotAcres: cleanNum(row['Lot size acres']),
        yearBuilt: cleanNum(row['Year Built']),
        listPrice: cleanPrice(row['List Price']),
        closeDate: row['Close Date'] || null,
        closePrice: cleanPrice(row['Close Price']),
        pricePerSqft: cleanNum(row['Price / ft²']),
        soldPricePerSqft: cleanNum(row['Sold Price / ft²']),
        zipCode: row['Zip code'] || '',
        crossStreet: row['Cross street'] || '',
        garageSpaces: cleanNum(row['Garage spaces']),
    };

    properties.push(prop);
}

// Sort by address
properties.sort((a, b) => a.address.localeCompare(b.address));

console.log(`Final database: ${properties.length} properties`);

fs.writeFileSync(OUTPUT, JSON.stringify(properties, null, 2));
console.log(`Written to ${OUTPUT}`);
