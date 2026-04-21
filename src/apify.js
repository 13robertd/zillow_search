// src/apify.js
//
// Thin wrapper around the official Apify client.
// This is the ONLY file you should need to edit if you switch to a
// different Zillow Apify actor: change the `buildActorInput` function
// to match whatever input schema your chosen actor expects.

import { ApifyClient } from 'apify-client';

/**
 * Create a configured Apify client.
 * Reads APIFY_TOKEN from environment.
 */
export function makeClient() {
  const token = process.env.APIFY_TOKEN;
  if (!token || token === 'your_apify_token_here') {
    throw new Error(
      'APIFY_TOKEN is missing. Copy .env.example to .env and add your token.'
    );
  }
  return new ApifyClient({ token });
}

/**
 * ============================================================
 *  ADAPTER LAYER  -- EDIT THIS WHEN YOU PICK YOUR ACTOR
 * ============================================================
 *
 * Different Zillow actors expect different input shapes. The job
 * of this function is to take ONE of our normalized target objects
 * (see makeTargets in src/index.js) and return the JSON payload
 * the actor wants.
 *
 * The default below is generic and tries to cover the most popular
 * Zillow scrapers (maxcopell, epctex, petr_cermak). It passes:
 *   - startUrls (list of {url})
 *   - search (free-text city/state/zip)
 *   - addresses (list of strings)
 *   - searchType ("ForSale" / "Sold" / "ForRent")
 *   - maxItems
 *   - extendOutputFunction (passthrough)
 *
 * TODO: Customize this for your chosen actor.
 *       Read the actor's input schema on its Apify Store page.
 */
export function buildActorInput(target, { maxItems }) {
  const input = {
    // We are doing SOLD research. Most actors accept "Sold" / "RecentlySold".
    searchType: 'Sold',
    maxItems: Number(maxItems) || 500,
  };

  switch (target.kind) {
    case 'searchUrl':
      input.startUrls = [{ url: target.value }];
      break;
    case 'zipCode':
      input.search = String(target.value);
      break;
    case 'city':
      input.search = String(target.value);
      break;
    case 'state':
      input.search = String(target.value);
      break;
    case 'address':
      // Some actors take a list of addresses; others want them as searches.
      input.addresses = [String(target.value)];
      input.search = String(target.value);
      break;
    default:
      input.search = String(target.value);
  }

  return input;
}

/**
 * ============================================================
 *  DETAIL ACTOR ADAPTER  -- EDIT IF YOU USE A DIFFERENT DETAIL ACTOR
 * ============================================================
 *
 * The detail actor takes a list of Zillow property URLs (or ZPIDs)
 * and returns full property data per page.
 *
 * Default shape matches maxcopell/zillow-detail-scraper, which
 * accepts `startUrls: [{ url }]`. If your detail actor wants
 * `zpids` or `urls` instead, tweak here.
 *
 * TODO: Customize this for your chosen detail actor.
 */
export function buildDetailActorInput(urls, opts = {}) {
  const input = {
    startUrls: urls.map((u) => ({ url: u })),
    maxConcurrency: 5,
  };
  if (opts.maxItems) input.maxItems = opts.maxItems;
  return input;
}

/**
 * Run the detail actor once for a batch of URLs.
 * Returns raw dataset items.
 */
export async function runDetailActor(client, detailActorId, urls, options = {}) {
  const { timeoutMinutes = 20, maxRetries = 2, maxItems } = options;
  if (!urls || urls.length === 0) return { items: [], usageUsd: 0 };

  const input = buildDetailActorInput(urls, { maxItems });
  let lastError;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(
        `  -> Calling detail actor "${detailActorId}" (attempt ${attempt}) for ${urls.length} URL(s)`
      );
      const run = await client.actor(detailActorId).call(input, {
        timeout: timeoutMinutes * 60,
        memory: 4096,
      });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const usageUsd = Number(run.usageTotalUsd) || 0;
      console.log(`     got ${items.length} detail record(s) (run cost ~$${usageUsd.toFixed(4)})`);
      return { items, usageUsd };
    } catch (err) {
      lastError = err;
      console.warn(
        `     detail attempt ${attempt} failed: ${err.message || err}. ` +
          (attempt <= maxRetries ? 'Retrying...' : 'Giving up.')
      );
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}
export async function runActorForTarget(client, actorId, target, options) {
  const { maxItems, timeoutMinutes, maxRetries = 2 } = options;
  const input = buildActorInput(target, { maxItems });

  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(
        `  -> Calling actor "${actorId}" (attempt ${attempt}) for ${target.kind}: ${target.value}`
      );

      const run = await client.actor(actorId).call(input, {
        timeout: (Number(timeoutMinutes) || 15) * 60, // seconds
        memory: 4096,
      });

      // Pull every item from the resulting dataset.
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const usageUsd = Number(run.usageTotalUsd) || 0;
      console.log(`     got ${items.length} raw items (run cost ~$${usageUsd.toFixed(4)})`);
      return { items, usageUsd };
    } catch (err) {
      lastError = err;
      console.warn(
        `     attempt ${attempt} failed: ${err.message || err}. ` +
          (attempt <= maxRetries ? 'Retrying...' : 'Giving up.')
      );
      // Tiny backoff between retries
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}
