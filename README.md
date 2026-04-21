# Zillow Sales Research

A small, beginner-friendly Node.js script that uses an **Apify Zillow actor**
to find two specific kinds of sold homes in the United States:

- **Filter A** – New construction homes **sold during 2025**
- **Filter B** – Luxury homes **sold year-to-date with sold price ≥ $3,000,000**

Results are written as both **CSV** and **JSON** under `output/`.

---

## 1. Install dependencies

You need Node.js 18+ installed. From inside this folder:

```bash
cd zillow-sales-research
npm install
```

That installs:

- `apify-client` – official Apify SDK
- `dotenv` – loads secrets from a `.env` file
- `json2csv` – CSV writer

---

## 2. Add your Apify token

1. Copy the example env file:

   ```bash
   cp .env.example .env
   ```

2. Open `.env` and fill in:

   ```
   APIFY_TOKEN=apify_api_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   APIFY_ACTOR_ID=maxcopell/zillow-scraper
   APIFY_DETAIL_ACTOR_ID=maxcopell/zillow-detail-scraper
   ```

   `APIFY_DETAIL_ACTOR_ID` is optional — leave it empty to skip the
   detail-enrichment pass and use only search results.

   Get your token at <https://console.apify.com/account/integrations>.
   **Never commit `.env`** — it is already in `.gitignore`.

---

## 3. Choose an Apify Zillow actor

Go to the Apify Store and search for "Zillow":
<https://apify.com/store?search=zillow>

Pick **one** actor that fits your needs. Common choices include:

- `maxcopell/zillow-scraper`
- `epctex/zillow-scraper`
- `petr_cermak/zillow-detail-scraper`

Open the actor's page and read its **Input schema**. Different actors expect
slightly different inputs (e.g. `startUrls` vs `search` vs `addresses`). Put
the actor's full ID into `APIFY_ACTOR_ID` in your `.env`.

> ⚠️ Important: the adapter in `src/apify.js` (function `buildActorInput`)
> is generic and tries to cover the most popular actors. If your chosen
> actor expects a different shape, **edit only that one function**.
> Look for the `TODO:` comment in `src/apify.js`.

---

## 4. Edit `input/targets.json`

`input/targets.json` is where you tell the script what to search. The default
shape is:

```json
{
  "searchUrls": [],
  "zipCodes": [],
  "cities": [],
  "states": [],
  "addresses": []
}
```

You can fill in any combination of these — leave the others empty. Every
target is run through the actor independently.

### How to use my list

Just paste your list into the matching array. Examples:

```json
{
  "searchUrls": [
    "https://www.zillow.com/austin-tx/sold/?searchQueryState=...",
    "https://www.zillow.com/scottsdale-az/sold/"
  ],
  "zipCodes": ["78704", "85255", "33139"],
  "cities": ["Austin, TX", "Scottsdale, AZ"],
  "states": ["TX", "AZ"],
  "addresses": [
    "123 Main St, Austin, TX 78701",
    "9000 N Hayden Rd, Scottsdale, AZ 85258"
  ]
}
```

You don't have to fill every field. Mix and match whatever you have.

---

## 5. Run the script

```bash
npm start
```

You'll see progress logs like:

```
=== Zillow Sales Research ===
Target sold year (Filter A): 2025
Min luxury sold price (Filter B): $3,000,000
...
--- Target: zip:78704 ---
  -> Calling actor "maxcopell/zillow-scraper" (attempt 1) for zipCode: 78704
     got 217 raw items
     normalized 217 record(s)
...
Filter A (new construction sold 2025): 14 match(es)
Filter B (YTD luxury >= $3,000,000): 6 match(es)
Wrote:
  allJson  -> output/all_normalized_results.json
  aCsv     -> output/2025_new_construction_sold.csv
  ...
Done.
```

---

## 6. Inspect the outputs

After a successful run, the `output/` folder contains:

| File                                       | What it is                              |
| ------------------------------------------ | --------------------------------------- |
| `output/all_normalized_results.json`       | Every deduped, normalized record        |
| `output/2025_new_construction_sold.csv`    | Filter A matches, spreadsheet-friendly  |
| `output/2025_new_construction_sold.json`   | Filter A matches, JSON                  |
| `output/ytd_luxury_3m_sold.csv`            | Filter B matches, spreadsheet-friendly  |
| `output/ytd_luxury_3m_sold.json`           | Filter B matches, JSON                  |
| `output/failed_targets.json`               | Any target whose actor run failed       |

Open the CSVs in Excel, Numbers, or Google Sheets.

---

## How the filtering logic works

The pipeline runs in **two stages** to keep detail-scraper costs down:

```
  search actor (per city)
         |
         v
  normalize + dedupe
         |
         v
  PRE-FILTER: sold + sold_date in target year
         |
         v
  detail actor (one run, all surviving URLs)
         |
         v
  merge detail fields back by zpid / URL
         |
         v
  score new construction + apply Filter A / Filter B
         |
         v
  write CSV + JSON
```

1. **Normalize** – Every raw record from the actor is converted into a
   single consistent schema (see `src/normalize.js`). This handles cases
   where actors use different keys like `zpid` vs `zpId`.

2. **Dedupe** – Records are deduplicated by `zpid` first, then `property_url`.

3. **Pre-filter + detail enrichment** – Before spending money on the
   detail scraper, records are cut down to "sold in the target year".
   Only survivors get enriched. This keeps the detail bill proportional
   to useful data, not to the full search haul.

4. **Score new construction** – Each record gets a `new_construction_score`
   based on weak signals:
   - "new construction" / "newly built" in description → +5
   - listing status or home type flagged as new construction → +5
   - `year_built >= 2024` → +2
   - has builder/community/subdivision name → +1 each (max +3)

   When score ≥ 5 we mark `is_new_construction_match = true` and write the
   reasons into `new_construction_reason`.

5. **Filter A** keeps records where:
   - The listing is sold (status text matches `sold/closed/recently_sold`,
     OR the record has a `sold_date` and `sold_price`)
   - The `sold_date` falls in calendar year **2025**
   - `year_built >= 2024` (hard gate — "new development only")

6. **Filter B** keeps records where:
   - The listing is sold
   - The `sold_date` is between Jan 1 of the current year and today
   - `sold_price >= $3,000,000`

All thresholds live in the `CONFIG` object at the top of `src/index.js`,
so you can tune them without hunting through the code.

---

## Notes on actor field names

Different Zillow actors return slightly different field names. The
`normalizeItem` function in `src/normalize.js` already tries multiple
common aliases for each field. If your actor returns something exotic:

- Open `src/normalize.js`
- Find the `pick(raw, [...])` call for the field that's missing
- Add the actor-specific key to the array

Example: if your actor returns `propertyZpid` instead of `zpid`:

```js
const zpid = pick(raw, ['zpid', 'zpId', 'id', 'propertyZpid', 'hdpData.homeInfo.zpid']);
```

---

## Project structure

```
zillow-sales-research/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── input/
│   └── targets.json          # your search inputs
├── src/
│   ├── index.js              # entry point + CONFIG
│   ├── apify.js              # Apify client + actor adapter
│   ├── normalize.js          # raw -> consistent schema, dedupe
│   ├── filters.js            # Filter A, Filter B, scoring
│   └── export.js             # CSV + JSON writers
└── output/                   # created on first run (git-ignored)
```

---

## Extending later

The pipeline is small and modular on purpose:

- To add **Redfin** or **Realtor.com**: copy `src/apify.js`, swap in a
  Redfin/Realtor actor, and reuse `normalize.js` / `filters.js`.
- To add a **third filter**: write a new function in `src/filters.js`
  and add it to the writer block in `src/index.js`.
- To change thresholds (e.g. `minLuxuryPrice = 5_000_000`): edit the
  `CONFIG` object at the top of `src/index.js`.
