// src/export.js
//
// Tiny helpers to write CSV and JSON output.
// We use json2csv's `Parser` because it handles arrays-of-objects
// with mixed/missing fields cleanly.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Parser } from 'json2csv';

// Canonical column order requested in the spec.
export const COLUMNS = [
  'source_target',
  'search_type',
  'zpid',
  'property_url',
  'address',
  'street',
  'city',
  'state',
  'zip_code',
  'county',
  'latitude',
  'longitude',
  'home_type',
  'listing_status',
  'is_new_construction_match',
  'new_construction_reason',
  'new_construction_score',
  'price',
  'sold_price',
  'sold_date',
  'list_date',
  'beds',
  'baths',
  'sqft',
  'lot_size',
  'year_built',
  'hoa_fee',
  'days_on_zillow',
  'broker_name',
  'agent_name',
  'office_name',
  'listing_id',
  'zestimate',
  'price_per_sqft',
  'community',
  'subdivision',
  'builder_name',
  'description',
  'photos_count',
  'raw_search_target',
];

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/** Write an array of objects to CSV using a fixed column order. */
export async function writeCsv(filePath, records) {
  await ensureDir(filePath);
  if (!records || records.length === 0) {
    await fs.writeFile(filePath, COLUMNS.join(',') + '\n', 'utf8');
    return;
  }
  const parser = new Parser({ fields: COLUMNS, defaultValue: '' });
  const csv = parser.parse(records);
  await fs.writeFile(filePath, csv, 'utf8');
}

/** Write an array (or object) as pretty-printed JSON. */
export async function writeJson(filePath, data) {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
