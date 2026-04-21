// src/index.js
//
// Entry point. Run with:
//   npm start
//
// Pipeline:
//   1. load .env + targets.json
//   2. for each target, call the Apify Zillow actor
//   3. normalize + dedupe results
//   4. score new construction
//   5. apply Filter A and Filter B
//   6. write CSV + JSON outputs

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeClient, runActorForTarget, runDetailActor } from './apify.js';
import { normalizeItem, dedupe, mergeDetail } from './normalize.js';
import {
  annotateNewConstruction,
  filterNewConstructionSold2025,
  filterLuxurySoldYTD,
  preFilterSoldInYear,
} from './filters.js';
import { writeCsv, writeJson } from './export.js';

// ---- Project paths ---------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INPUT_PATH = path.join(ROOT, 'input', 'targets.json');
const OUTPUT_DIR = path.join(ROOT, 'output');

// ---- CONFIG ----------------------------------------------------------
// All tuning knobs live here. Change values, not code.
const CONFIG = {
  minLuxuryPrice: 3_000_000,
  targetSoldYear: 2025,
  currentYearToDate: new Date(), // dynamically computed each run
  recentYearBuiltThreshold: 2024, // used by the scoring helper
  minYearBuilt: 2024,             // HARD GATE for Filter A -- new development only
  maxItemsPerTarget: Number(process.env.MAX_ITEMS_PER_TARGET) || 500,
  actorTimeoutMinutes: Number(process.env.ACTOR_TIMEOUT_MINUTES) || 15,
  actorId: process.env.APIFY_ACTOR_ID,
  detailActorId: process.env.APIFY_DETAIL_ACTOR_ID || '',
};

/**
 * Convert the targets.json shape into a flat list of target descriptors:
 *   { kind, value, label }
 *
 * `kind` is used by the Apify adapter to build actor input.
 * `label` is what we record on every output row in `source_target`.
 */
function makeTargets(raw) {
  const list = [];

  for (const url of raw.searchUrls || []) {
    list.push({ kind: 'searchUrl', value: url, label: `searchUrl:${url}` });
  }
  for (const zip of raw.zipCodes || []) {
    list.push({ kind: 'zipCode', value: String(zip), label: `zip:${zip}` });
  }
  for (const city of raw.cities || []) {
    list.push({ kind: 'city', value: city, label: `city:${city}` });
  }
  for (const state of raw.states || []) {
    list.push({ kind: 'state', value: state, label: `state:${state}` });
  }
  for (const addr of raw.addresses || []) {
    list.push({ kind: 'address', value: addr, label: `address:${addr}` });
  }

  return list;
}

async function main() {
  console.log('=== Zillow Sales Research ===');
  console.log(`Target sold year (Filter A): ${CONFIG.targetSoldYear}`);
  console.log(`Min luxury sold price (Filter B): $${CONFIG.minLuxuryPrice.toLocaleString()}`);
  console.log(`Year-to-date cutoff: ${CONFIG.currentYearToDate.toISOString().slice(0, 10)}`);

  if (!CONFIG.actorId || CONFIG.actorId === 'replace_with_selected_actor') {
    throw new Error(
      'APIFY_ACTOR_ID is missing. Set it in .env (e.g. maxcopell/zillow-scraper).'
    );
  }

  // 1. Load targets
  const rawTargets = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));
  const targets = makeTargets(rawTargets);

  if (targets.length === 0) {
    console.warn(
      'No targets found in input/targets.json. Add searchUrls / zipCodes / cities / states / addresses and try again.'
    );
    return;
  }
  console.log(`Loaded ${targets.length} target(s) from ${path.relative(ROOT, INPUT_PATH)}`);

  // 2. Run actor for each target
  const client = makeClient();
  const allNormalized = [];
  const failed = [];

  for (const target of targets) {
    console.log(`\n--- Target: ${target.label} ---`);
    try {
      const items = await runActorForTarget(client, CONFIG.actorId, target, {
        maxItems: CONFIG.maxItemsPerTarget,
        timeoutMinutes: CONFIG.actorTimeoutMinutes,
        maxRetries: 2,
      });

      const normalized = items.map((it) => normalizeItem(it, target));
      console.log(`     normalized ${normalized.length} record(s)`);
      allNormalized.push(...normalized);
    } catch (err) {
      console.error(`  !! Failed target ${target.label}: ${err.message || err}`);
      failed.push({ target, error: String(err.message || err) });
    }
  }

  // 3. Dedupe
  const beforeDedupe = allNormalized.length;
  let deduped = dedupe(allNormalized);
  console.log(`\nDeduplicated ${beforeDedupe} -> ${deduped.length} record(s)`);

  // 3b. OPTIONAL Stage 2: enrich with detail actor.
  // Pre-filter to sold-in-target-year so we only pay to enrich records that
  // could possibly survive Filter A.
  if (CONFIG.detailActorId) {
    const candidates = preFilterSoldInYear(deduped, {
      targetSoldYear: CONFIG.targetSoldYear,
    });
    const urls = candidates.map((r) => r.property_url).filter(Boolean);
    console.log(
      `\n--- Stage 2: detail enrichment ---\n` +
        `  pre-filter survivors: ${candidates.length}, URLs to enrich: ${urls.length}`
    );

    if (urls.length > 0) {
      try {
        const detailItems = await runDetailActor(client, CONFIG.detailActorId, urls, {
          timeoutMinutes: CONFIG.actorTimeoutMinutes,
          maxRetries: 2,
        });

        // Normalize each detail item and index by zpid / url for fast merge.
        const detailByZpid = new Map();
        const detailByUrl = new Map();
        for (const raw of detailItems) {
          const n = normalizeItem(raw, {
            kind: 'detail',
            value: raw?.url || raw?.zpid || '',
            label: 'detail-enrichment',
          });
          if (n.zpid) detailByZpid.set(String(n.zpid), n);
          if (n.property_url) detailByUrl.set(n.property_url, n);
        }

        let mergedCount = 0;
        deduped = deduped.map((r) => {
          const match =
            (r.zpid && detailByZpid.get(String(r.zpid))) ||
            (r.property_url && detailByUrl.get(r.property_url));
          if (match) {
            mergedCount++;
            return mergeDetail(r, match);
          }
          return r;
        });
        console.log(`  merged detail data into ${mergedCount} record(s)`);
      } catch (err) {
        console.error(`  !! Detail actor failed, continuing with search-only data: ${err.message || err}`);
      }
    }
  } else {
    console.log('\n(Skipping Stage 2: APIFY_DETAIL_ACTOR_ID not set)');
  }

  // 4. Score new construction (annotates in place, using the now-enriched data)
  annotateNewConstruction(deduped, {
    recentYearBuilt: CONFIG.recentYearBuiltThreshold,
  });

  // 5. Apply filters
  const filterA = filterNewConstructionSold2025(deduped, {
    targetSoldYear: CONFIG.targetSoldYear,
    minYearBuilt: CONFIG.minYearBuilt,
  });
  const filterB = filterLuxurySoldYTD(deduped, {
    minLuxuryPrice: CONFIG.minLuxuryPrice,
    now: CONFIG.currentYearToDate,
  });

  console.log(`\nFilter A (new construction sold ${CONFIG.targetSoldYear}): ${filterA.length} match(es)`);
  console.log(`Filter B (YTD luxury >= $${CONFIG.minLuxuryPrice.toLocaleString()}): ${filterB.length} match(es)`);

  // 6. Write outputs
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const paths = {
    allJson: path.join(OUTPUT_DIR, 'all_normalized_results.json'),
    aCsv: path.join(OUTPUT_DIR, '2025_new_construction_sold.csv'),
    aJson: path.join(OUTPUT_DIR, '2025_new_construction_sold.json'),
    bCsv: path.join(OUTPUT_DIR, 'ytd_luxury_3m_sold.csv'),
    bJson: path.join(OUTPUT_DIR, 'ytd_luxury_3m_sold.json'),
    failed: path.join(OUTPUT_DIR, 'failed_targets.json'),
  };

  await Promise.all([
    writeJson(paths.allJson, deduped),
    writeCsv(paths.aCsv, filterA),
    writeJson(paths.aJson, filterA),
    writeCsv(paths.bCsv, filterB),
    writeJson(paths.bJson, filterB),
    writeJson(paths.failed, failed),
  ]);

  console.log('\nWrote:');
  for (const [k, p] of Object.entries(paths)) {
    console.log(`  ${k.padEnd(8)} -> ${path.relative(ROOT, p)}`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
