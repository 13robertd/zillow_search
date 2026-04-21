// src/filters.js
//
// Two filter helpers:
//   - filterNewConstructionSold2025  (Filter A)
//   - filterLuxurySoldYTD            (Filter B)
//
// Plus a scoring helper that decides whether a record looks like
// "new construction" based on multiple weak signals.

const SOLD_STATUS_PATTERNS = [
  /sold/i,
  /recently_sold/i,
  /recentlysold/i,
  /closed/i,
];

function isSold(record) {
  if (!record.listing_status && !record.sold_date && !record.sold_price) return false;
  if (record.listing_status && SOLD_STATUS_PATTERNS.some((p) => p.test(String(record.listing_status)))) {
    return true;
  }
  // Even if status text is missing, presence of sold_date + sold_price is a strong signal.
  return Boolean(record.sold_date && record.sold_price);
}

function inYear(isoDate, year) {
  if (!isoDate) return false;
  return String(isoDate).startsWith(String(year));
}

function inYearToDate(isoDate, now = new Date()) {
  if (!isoDate) return false;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return false;
  const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return d >= startOfYear && d <= now;
}

/**
 * Score how likely a record is "new construction" using multiple signals.
 *  - "new construction" / "newly built" text in description or status: +5
 *  - explicit homeType / status flag for new construction: +5
 *  - year_built >= configured recent year (default 2024): +2
 *  - has builder/community/subdivision name: +1 each (max +3)
 *
 * Threshold for `is_new_construction_match` is score >= 5.
 */
export function scoreNewConstruction(record, opts = {}) {
  const recentYear = opts.recentYearBuilt ?? 2024;
  const reasons = [];
  let score = 0;

  const text = [
    record.description,
    record.listing_status,
    record.home_type,
    record.community,
    record.subdivision,
    record.builder_name,
  ]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();

  if (/\bnew construction\b/.test(text) || /\bnewly built\b/.test(text)) {
    score += 5;
    reasons.push('text mentions "new construction" / "newly built"');
  }

  if (/new[_\s-]?construction/i.test(String(record.listing_status || '')) ||
      /new[_\s-]?construction/i.test(String(record.home_type || ''))) {
    score += 5;
    reasons.push('listing_status or home_type flagged as new construction');
  }

  if (record.year_built && record.year_built >= recentYear) {
    score += 2;
    reasons.push(`year_built (${record.year_built}) >= ${recentYear}`);
  }

  let metaCount = 0;
  if (record.builder_name) metaCount++;
  if (record.community) metaCount++;
  if (record.subdivision) metaCount++;
  if (metaCount > 0) {
    const add = Math.min(metaCount, 3);
    score += add;
    reasons.push(`builder/community/subdivision present (+${add})`);
  }

  return {
    score,
    reasons,
    isMatch: score >= 5,
  };
}

/**
 * Annotate every record in-place with new construction score + reason.
 * Call this BEFORE the filter functions below so the fields are populated
 * even on records that don't end up matching Filter A.
 */
export function annotateNewConstruction(records, opts = {}) {
  for (const r of records) {
    const { score, reasons, isMatch } = scoreNewConstruction(r, opts);
    r.new_construction_score = score;
    r.new_construction_reason = reasons.join('; ') || undefined;
    r.is_new_construction_match = isMatch;
  }
  return records;
}

/**
 * FILTER A: 2025 new construction sold.
 *
 * Hard gates:
 *   - must be sold
 *   - sold_date in target year (default 2025)
 *   - year_built >= minYearBuilt (default 2024)   <-- limiting factor for new development
 *
 * The new-construction score + reasons are still computed on every record
 * (see annotateNewConstruction) so you can see WHY something looked like
 * new construction, but the year_built gate is the decisive filter.
 */
export function filterNewConstructionSold2025(records, opts = {}) {
  const year = opts.targetSoldYear ?? 2025;
  const minYearBuilt = opts.minYearBuilt ?? 2024;
  return records.filter((r) => {
    if (!isSold(r)) return false;
    if (!inYear(r.sold_date, year)) return false;
    if (!(r.year_built && r.year_built >= minYearBuilt)) return false;
    return true;
  });
}

/**
 * FILTER B: YTD luxury sold >= minLuxuryPrice (default $3M).
 */
export function filterLuxurySoldYTD(records, opts = {}) {
  const min = opts.minLuxuryPrice ?? 3_000_000;
  const now = opts.now ?? new Date();
  return records.filter((r) => {
    if (!isSold(r)) return false;
    if (!inYearToDate(r.sold_date, now)) return false;
    if (!(r.sold_price >= min)) return false;
    return true;
  });
}
