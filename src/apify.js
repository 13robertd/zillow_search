// src/apify.js
import { ApifyClient } from 'apify-client';

export function makeClient() {
  const token = process.env.APIFY_TOKEN;
  if (!token || token === 'your_apify_token_here') {
    throw new Error('APIFY_TOKEN is missing. Copy .env.example to .env and add your token.');
  }
  return new ApifyClient({ token });
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/,\s*/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildSearchUrls(target) {
  switch (target.kind) {
    case 'searchUrl':
      return [String(target.value)];
    case 'zipCode':
      return [`https://www.zillow.com/homes/sold/${encodeURIComponent(String(target.value))}_rb/`];
    case 'city':
      return [`https://www.zillow.com/${slugify(target.value)}/sold/`];
    case 'state':
      return [`https://www.zillow.com/${slugify(target.value)}/sold/`];
    case 'address':
      return [`https://www.zillow.com/homes/${encodeURIComponent(String(target.value))}_rb/`];
    default:
      return [];
  }
}

export function buildActorInput(target, { maxItems }) {
  const urls = buildSearchUrls(target);
  return {
    searchUrls: urls.map((url) => ({ url })),
    maxItems: Number(maxItems) || 500,
  };
}

export function buildDetailActorInput(urls, opts = {}) {
  const input = {
    startUrls: urls.map((u) => ({ url: u })),
    maxConcurrency: 5,
  };
  if (opts.maxItems) input.maxItems = opts.maxItems;
  return input;
}

export async function runDetailActor(client, detailActorId, urls, options = {}) {
  const { timeoutMinutes = 20, maxRetries = 2, maxItems } = options;
  if (!urls || urls.length === 0) return { items: [], usageUsd: 0 };
  const input = buildDetailActorInput(urls, { maxItems });
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`  -> Calling detail actor "${detailActorId}" (attempt ${attempt}) for ${urls.length} URL(s)`);
      const run = await client.actor(detailActorId).call(input, { timeout: timeoutMinutes * 60, memory: 4096 });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const usageUsd = Number(run.usageTotalUsd) || 0;
      console.log(`     got ${items.length} detail record(s) (run cost ~$${usageUsd.toFixed(4)})`);
      return { items, usageUsd };
    } catch (err) {
      lastError = err;
      console.warn(`     detail attempt ${attempt} failed: ${err.message || err}. ` + (attempt <= maxRetries ? 'Retrying...' : 'Giving up.'));
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
      console.log(`  -> Calling actor "${actorId}" (attempt ${attempt}) for ${target.kind}: ${target.value}`);
      const run = await client.actor(actorId).call(input, { timeout: (Number(timeoutMinutes) || 15) * 60, memory: 4096 });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const usageUsd = Number(run.usageTotalUsd) || 0;
      console.log(`     got ${items.length} raw items (run cost ~$${usageUsd.toFixed(4)})`);
      return { items, usageUsd };
    } catch (err) {
      lastError = err;
      console.warn(`     attempt ${attempt} failed: ${err.message || err}. ` + (attempt <= maxRetries ? 'Retrying...' : 'Giving up.'));
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}
