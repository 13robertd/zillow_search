// src/normalize.js
//
// Different Zillow actors return slightly different field names
// (e.g. `zpid` vs `zpId`, `address` vs `streetAddress`, etc.).
// This file converts whatever an actor returns into ONE consistent
// schema so the rest of the code can stay simple.

/**
 * Helper: pick the first defined value from a list of possible keys
 * on an object. Returns `undefined` if none are present.
 */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj == null) continue;
    const parts = k.split('.');
    let cur = obj;
    let ok = true;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) {
        cur = cur[p];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return undefined;
}

/**
 * Helper: try to parse a number out of a value that might be
 * a string like "$3,250,000" or "3,250 sqft".
 */
function toNumber(v) {
  if (v == null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Helper: parse a date-ish value into an ISO string (YYYY-MM-DD).
 * Accepts unix timestamps (seconds OR milliseconds) and date strings.
 */
function toIsoDate(v) {
  if (v == null || v === '') return undefined;
  let d;
  if (typeof v === 'number') {
    // Heuristic: 10-digit = seconds, 13-digit = ms
    d = new Date(v < 1e12 ? v * 1000 : v);
  } else {
    d = new Date(v);
  }
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * Build a clean, consistent record from a single raw actor item.
 *
 * `source` describes WHICH target produced this row, so we can
 * trace results back to the search that found them.
 */
export function normalizeItem(raw, source) {
  // ---- Identity / URL ------------------------------------------------
  const zpid = pick(raw, ['zpid', 'zpId', 'id', 'hdpData.homeInfo.zpid']);
  const property_url =
    pick(raw, ['url', 'detailUrl', 'hdpUrl', 'propertyUrl']) ||
    (zpid ? `https://www.zillow.com/homedetails/${zpid}_zpid/` : undefined);

  // ---- Address -------------------------------------------------------
  const address =
    pick(raw, ['address', 'addressRaw', 'fullAddress']) ||
    [
      pick(raw, ['streetAddress', 'address.streetAddress']),
      pick(raw, ['city', 'address.city']),
      pick(raw, ['state', 'address.state']),
      pick(raw, ['zipcode', 'zipCode', 'address.zipcode']),
    ]
      .filter(Boolean)
      .join(', ') ||
    undefined;

  const street = pick(raw, ['streetAddress', 'address.streetAddress']);
  const city = pick(raw, ['city', 'address.city']);
  const state = pick(raw, ['state', 'address.state']);
  const zip_code = pick(raw, ['zipcode', 'zipCode', 'address.zipcode', 'postalCode']);
  const county = pick(raw, ['county', 'countyName', 'resoFacts.county']);
  const latitude = toNumber(pick(raw, ['latitude', 'latLong.latitude', 'address.latitude']));
  const longitude = toNumber(pick(raw, ['longitude', 'latLong.longitude', 'address.longitude']));

  // ---- Listing core --------------------------------------------------
  const home_type = pick(raw, ['homeType', 'propertyType', 'hdpData.homeInfo.homeType']);
  const listing_status = pick(raw, [
    'homeStatus',
    'listingStatus',
    'statusType',
    'status',
    'hdpData.homeInfo.homeStatus',
  ]);
  const price = toNumber(pick(raw, ['price', 'listPrice', 'hdpData.homeInfo.price']));
  const sold_price = toNumber(
    pick(raw, [
      'soldPrice',
      'lastSoldPrice',
      'priceHistory.0.price',
      'hdpData.homeInfo.lastSoldPrice',
    ])
  );
  const sold_date = toIsoDate(
    pick(raw, [
      'dateSold',
      'soldDate',
      'lastSoldDate',
      'priceHistory.0.date',
      'hdpData.homeInfo.dateSold',
    ])
  );
  const list_date = toIsoDate(
    pick(raw, ['datePosted', 'listingDate', 'listDate', 'hdpData.homeInfo.datePosted'])
  );

  // ---- Specs ---------------------------------------------------------
  const beds = toNumber(pick(raw, ['bedrooms', 'beds', 'hdpData.homeInfo.bedrooms']));
  const baths = toNumber(pick(raw, ['bathrooms', 'baths', 'hdpData.homeInfo.bathrooms']));
  const sqft = toNumber(
    pick(raw, ['livingArea', 'livingAreaValue', 'sqft', 'area', 'hdpData.homeInfo.livingArea'])
  );
  const lot_size = toNumber(pick(raw, ['lotSize', 'lotAreaValue', 'resoFacts.lotSize']));
  const year_built = toNumber(pick(raw, ['yearBuilt', 'resoFacts.yearBuilt']));
  const hoa_fee = toNumber(pick(raw, ['hoaFee', 'monthlyHoaFee', 'resoFacts.hoaFee']));
  const days_on_zillow = toNumber(
    pick(raw, ['daysOnZillow', 'timeOnZillow', 'hdpData.homeInfo.daysOnZillow'])
  );

  // ---- Listing meta --------------------------------------------------
  const broker_name = pick(raw, ['brokerName', 'brokerageName', 'attributionInfo.brokerName']);
  const agent_name = pick(raw, ['agentName', 'attributionInfo.agentName', 'listedBy.0.name']);
  const office_name = pick(raw, ['officeName', 'attributionInfo.agentLicenseNumber']);
  const listing_id = pick(raw, ['mlsid', 'mlsId', 'listingId', 'attributionInfo.mlsId']);
  const zestimate = toNumber(pick(raw, ['zestimate', 'hdpData.homeInfo.zestimate']));
  const price_per_sqft = toNumber(
    pick(raw, ['pricePerSquareFoot', 'resoFacts.pricePerSquareFoot'])
  );

  // ---- New construction signals -------------------------------------
  const community = pick(raw, ['community', 'communityName', 'resoFacts.communityName']);
  const subdivision = pick(raw, ['subdivision', 'resoFacts.subdivisionName']);
  const builder_name = pick(raw, ['builderName', 'resoFacts.builderName', 'builder']);
  const description = pick(raw, ['description', 'homeDescription', 'resoFacts.description']);

  // ---- Misc ----------------------------------------------------------
  const photos_count = toNumber(
    pick(raw, ['photoCount', 'photos.length', 'imgSrc.length'])
  );

  return {
    source_target: source.label,
    search_type: source.kind,
    zpid: zpid ? String(zpid) : undefined,
    property_url,
    address,
    street,
    city,
    state,
    zip_code: zip_code ? String(zip_code) : undefined,
    county,
    latitude,
    longitude,
    home_type,
    listing_status,
    is_new_construction_match: false,    // filled in by filters.js
    new_construction_reason: undefined,  // filled in by filters.js
    new_construction_score: 0,           // filled in by filters.js
    price,
    sold_price,
    sold_date,
    list_date,
    beds,
    baths,
    sqft,
    lot_size,
    year_built,
    hoa_fee,
    days_on_zillow,
    broker_name,
    agent_name,
    office_name,
    listing_id,
    zestimate,
    price_per_sqft,
    community,
    subdivision,
    builder_name,
    description,
    photos_count,
    raw_search_target: source.value,
  };
}

/**
 * Merge a detail-actor record into a previously normalized search record.
 *
 * Rules:
 *   - preserve origin metadata (source_target, search_type, raw_search_target)
 *     from the search record
 *   - prefer non-empty values from the detail record for everything else
 */
export function mergeDetail(searchRecord, detailRecord) {
  const merged = { ...searchRecord };
  const preserve = new Set(['source_target', 'search_type', 'raw_search_target']);
  for (const [k, v] of Object.entries(detailRecord)) {
    if (preserve.has(k)) continue;
    if (v !== undefined && v !== null && v !== '') merged[k] = v;
  }
  return merged;
}

/**
 * Deduplicate an array of normalized records.
 * Uses ZPID first; falls back to property URL.
 */
export function dedupe(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const key = r.zpid || r.property_url || JSON.stringify([r.address, r.sold_date]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
