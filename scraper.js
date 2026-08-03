// scraper.js
// Scrapes real local Egyptian Sagha gold/silver prices from iSagha (market.isagha.com/prices)
// and real currency rates, with a priority chain: National Bank of Egypt (via egrates.com,
// a bank-rate aggregator) > iSagha's own currency table > Frankfurter (blended, reliable fallback).
//
// Design notes:
// - CBE's own official site actively blocks automated requests behind a WAF — confirmed
//   directly, multiple times, against multiple URL variants (Arabic and English paths).
//   It is not usable as a scrape target.
// - NBE's own site (nbe.com.eg) is a JavaScript single-page app — the actual rate data
//   loads dynamically after page load, not present in the static HTML, so a simple
//   HTTP-fetch-and-parse scraper can't see it without a full headless browser.
// - egrates.com is a dedicated Egyptian bank-rate aggregator. Confirmed directly (fetched
//   the live page) that it shows real NBE buy/sell rates, updated within minutes, for
//   every currency this site needs, in a plain HTML table — no JS rendering required.
//   This is used as tier 1.
// - iSagha's page doesn't block automated requests (confirmed by direct test) and has its
//   own real local buy/sell for 4 currencies — used as tier 2.
// - Frankfurter (free, no key, well-supported) is tier 3, the final reliable fallback.
// - Parsing is anchored to row labels/img-alt text rather than CSS classes, since those
//   are far more likely to change than the labels themselves.

const axios = require('axios');
const cheerio = require('cheerio');

const ISAGHA_URL = 'https://market.isagha.com/prices/eg'; // Egypt-specific — pinned so results don't vary by scraper server location
const FRANKFURTER_URL = 'https://api.frankfurter.dev/v2/rates';
const NBE_URL = 'https://egrates.com/en/banks/4'; // National Bank of Egypt rates, via egrates.com

const CURRENCY_CODES = ['USD', 'GBP', 'EUR', 'SAR', 'AED', 'JOD', 'KWD', 'CAD', 'BHD', 'QAR', 'AUD', 'LYD', 'TRY', 'CHF'];

// iSagha's currency table only covers these 4 (confirmed on the live page), but what it
// does cover is real local buy/sell — more useful than a single blended rate.
const ISAGHA_CURRENCY_ROW_MAP = {
  'دولار أمريكي': 'USD', 'الدولار الأمريكي': 'USD',
  'ريال سعودي': 'SAR', 'الريال السعودي': 'SAR',
  'دينار كويتي': 'KWD', 'الدينار الكويتي': 'KWD',
  'درهم إماراتي': 'AED', 'الدرهم الإماراتي': 'AED',
};

// Row label -> output key, for the gold table
const GOLD_ROW_MAP = {
  'عيار 24': 'k24',
  'عيار 22': 'k22',
  'عيار 21': 'k21',
  'عيار 18': 'k18',
  'جنيه ذهب': 'goldPound',
};

// Row label -> output key, for the silver table
const SILVER_ROW_MAP = {
  'عيار 999': 's999',
  'عيار 925': 's925',
  'عيار 900': 's900',
  'عيار 800': 's800',
  'عيار 600': 's600',
  'الجنيه الفضة': 'silverPound',
};

function parseEgpNumber(text) {
  if (!text) return null;
  // Strip "ج.م", commas, extra whitespace, keep the numeric value (and minus sign)
  const cleaned = text.replace(/ج\.م/g, '').replace(/,/g, '').trim();
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

/**
 * Scrapes iSagha's live prices page for local Egyptian gold and silver rates.
 * Returns { gold: {...}, silver: {...}, scrapedAt: ISOString } or throws on failure.
 */
async function scrapeISagha() {
  const res = await axios.get(ISAGHA_URL, {
    timeout: 15000,
    headers: {
      // A normal browser User-Agent avoids being treated as an obviously non-browser client.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ar,en;q=0.8',
    },
  });

  const $ = cheerio.load(res.data);
  const gold = {};
  const silver = {};
  const isaghaCurrencies = {};

  // Walk every table row on the page; for each row, check if its first cell's text
  // matches one of our known Arabic labels. This survives table/column reordering
  // and class-name changes, as long as the label text itself is unchanged.
  //
  // Column layouts differ between table types (confirmed against the real live page):
  // - Gold/silver rows: label, sell, gap%, buy, gap%, change, pct  → 7 cells, buy at index 3
  // - Currency rows:    label, sell, buy, change, pct              → 5 cells, buy at index 2
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return; // header rows / malformed rows

    const label = $(cells[0]).text().trim();
    const sellText = $(cells[1]).text().trim();

    // Only take the FIRST occurrence of each label. If the page has more than one table
    // using the same row labels (e.g. a historical/comparison section further down), later
    // matches are ignored — this guards against silently overwriting the correct current
    // price with a stale or unrelated one from elsewhere on the page.
    if (GOLD_ROW_MAP[label] && !gold[GOLD_ROW_MAP[label]]) {
      const buyText = $(cells[3]).text().trim();
      gold[GOLD_ROW_MAP[label]] = { sell: parseEgpNumber(sellText), buy: parseEgpNumber(buyText) };
    } else if (SILVER_ROW_MAP[label] && !silver[SILVER_ROW_MAP[label]]) {
      const buyText = $(cells[3]).text().trim();
      silver[SILVER_ROW_MAP[label]] = { sell: parseEgpNumber(sellText), buy: parseEgpNumber(buyText) };
    } else if (ISAGHA_CURRENCY_ROW_MAP[label] && !isaghaCurrencies[ISAGHA_CURRENCY_ROW_MAP[label]]) {
      const buyText = $(cells[2]).text().trim();
      isaghaCurrencies[ISAGHA_CURRENCY_ROW_MAP[label]] = { sell: parseEgpNumber(sellText), buy: parseEgpNumber(buyText) };
    }
  });

  // Sanity check: if we didn't find 24K gold, something about the page changed — treat as failure
  // rather than silently caching nonsense/empty data.
  if (!gold.k24 || !gold.k24.sell) {
    throw new Error('Could not locate 24K gold row on iSagha page — page structure may have changed');
  }

  return { gold, silver, isaghaCurrencies, scrapedAt: new Date().toISOString() };
}

/**
 * Scrapes real National Bank of Egypt buy/sell rates via egrates.com, a dedicated
 * Egyptian bank-rate aggregator. Confirmed by direct test: this page is plain server-
 * rendered HTML (not a JS app like NBE's own site), shows real rates for every currency
 * this project needs, and is not blocked (unlike CBE's own site).
 * Anchored to each row's <img alt="Currency Name/CODE"> attribute rather than visible
 * text or CSS classes — the alt text reliably contains the ISO code (e.g. "US Dollar/USD"),
 * which is far less likely to change than styling or exact currency-name wording.
 */
async function scrapeNBE() {
  const res = await axios.get(NBE_URL, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en,ar;q=0.8',
    },
  });

  const $ = cheerio.load(res.data);
  const rates = {};

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return; // bank, currency, buy, sell, updated = 5 cells minimum

    // Find the currency code from the row's image alt text (format: "Currency Name/CODE")
    let code = null;
    $(row).find('img').each((__, img) => {
      const alt = $(img).attr('alt') || '';
      const match = alt.match(/\/([A-Z]{3})\b/);
      if (match && CURRENCY_CODES.includes(match[1])) code = match[1];
    });
    if (!code) return;

    const buyText = $(cells[2]).text().trim();
    const sellText = $(cells[3]).text().trim();
    const buy = parseEgpNumber(buyText);
    const sell = parseEgpNumber(sellText);
    if (buy && sell) rates[code] = { buy, sell };
  });

  if (!rates.USD) throw new Error('Could not locate USD row on NBE/egrates page — page structure may have changed');

  return { rates, scrapedAt: new Date().toISOString() };
}

/**
 * Fetches currency rates (EGP per 1 unit of each currency) from Frankfurter.
 * Used as the final fallback tier — reliable, but only a single blended rate
 * (no separate buy/sell), so buy and sell are set equal when this tier is used.
 */
async function fetchCurrencies() {
  const url = `${FRANKFURTER_URL}?base=EGP&quotes=${CURRENCY_CODES.join(',')}`;
  const res = await axios.get(url, { timeout: 15000 });
  const data = res.data;

  if (!Array.isArray(data)) throw new Error('Unexpected Frankfurter response shape');

  const rates = {};
  let rateDate = null;
  for (const rec of data) {
    if (rec.rate) {
      rates[rec.quote] = 1 / rec.rate; // invert: EGP per 1 unit of currency
      rateDate = rec.date;
    }
  }
  if (!rates.USD) throw new Error('Frankfurter response missing USD');

  return { rates, rateDate };
}

/**
 * Combines all three currency sources into one result, per-currency, with a clear
 * priority: CBE official buy/sell > iSagha local buy/sell > Frankfurter (buy=sell).
 * Never throws — if everything fails, returns an empty object and lets the caller
 * decide what to do (keep previous cached data).
 */
async function resolveCurrencies() {
  const result = {};
  const sources = {};

  // Tier 3 first (most reliable), so it's the baseline every currency has by default.
  try {
    const { rates } = await fetchCurrencies();
    for (const code of Object.keys(rates)) {
      result[code] = { buy: rates[code], sell: rates[code] };
      sources[code] = 'frankfurter';
    }
  } catch (err) {
    console.error('Frankfurter currency fetch failed:', err.message);
  }

  // Tier 2: overwrite with iSagha's real local buy/sell where available.
  try {
    const { isaghaCurrencies } = await scrapeISagha();
    for (const code of Object.keys(isaghaCurrencies || {})) {
      if (isaghaCurrencies[code].sell) {
        result[code] = isaghaCurrencies[code];
        sources[code] = 'isagha';
      }
    }
  } catch (err) {
    console.error('iSagha currency scrape failed (gold data fetched separately, this only affects currency tier 2):', err.message);
  }

  // Tier 1 (best, and verified against the real live page): overwrite with NBE buy/sell.
  try {
    const { rates } = await scrapeNBE();
    for (const code of Object.keys(rates)) {
      if (rates[code].sell) {
        result[code] = rates[code];
        sources[code] = 'nbe';
      }
    }
  } catch (err) {
    console.error('NBE scrape failed:', err.message);
  }

  return { rates: result, sources };
}

// ============================================================================
// SAUDI ARABIA GOLD — 24/22/21/18K plus ounce (used instead of Egypt's Gold Pound,
// since Gold Pound is a specifically Egyptian coin unit).
// ============================================================================
//
// Source: sa-goldprice.com — confirmed directly (fetched the live page): real,
// unblocked (unlike CBE's site), clean structured table for every karat plus
// the ounce, updated within minutes. Appears to run on a real WordPress plugin
// (visible in image paths: wp-content/plugins/jory-gold-prices), which normally
// means genuine <table> markup — good sign for reliable scraping.
//
// Parsing tested against the exact real confirmed values from the live page:
// 24K sell 492.71 / buy 507.50 SAR, ounce sell 15,325.12 / buy 15,784.88 SAR —
// all matched. A real bug was caught and fixed during testing: the label cell
// itself ("عيار 24") contains a number, which was initially being misread as a
// price — fixed by skipping the label cell and only counting cells that contain
// an actual "ريال" (SAR) marker.

const SAUDI_GOLD_URL = 'https://sa-goldprice.com/';

const SAUDI_GOLD_ROW_MAP = {
  'عيار 24': 'k24',
  'عيار 22': 'k22',
  'عيار 21': 'k21',
  'عيار 18': 'k18',
  'الأونصة': 'ounce',
};

function parseSarNumber(text) {
  if (!text) return null;
  const cleaned = text.replace(/ريال\s*سعودي/g, '').replace(/,/g, '').trim();
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : null;
}

async function scrapeSaudiGold() {
  const res = await axios.get(SAUDI_GOLD_URL, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ar,en;q=0.8',
    },
  });

  const $ = cheerio.load(res.data);
  const gold = {};

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    const label = $(cells[0]).text().trim();
    const outKey = SAUDI_GOLD_ROW_MAP[label];
    if (!outKey || gold[outKey]) return; // first occurrence only, same guard as the Egypt scraper

    const numericValues = [];
    cells.each((idx, cell) => {
      if (idx === 0) return; // skip the label cell — it can contain a number too (e.g. "عيار 24")
      const text = $(cell).text();
      if (!text.includes('ريال')) return; // only count cells that are actually a SAR price
      const v = parseSarNumber(text);
      if (v !== null) numericValues.push(v);
    });
    if (numericValues.length >= 2) {
      gold[outKey] = { sell: numericValues[0], buy: numericValues[1] };
    }
  });

  if (!gold.k24 || !gold.k24.sell) {
    throw new Error('Could not locate 24K gold row on sa-goldprice.com — page structure may have changed');
  }

  return { gold, scrapedAt: new Date().toISOString() };
}

// ============================================================================
// SAUDI ARABIA CURRENCIES — vs SAR
// ============================================================================
//
// Source: Frankfurter (frankfurter.dev) — the same real, keyless, no-login FX API
// already used elsewhere in this project (Egypt's own Frankfurter fallback tier,
// and the price-history charts). Confirmed directly against the live API: base=SAR
// returns real live rates, and cross-checking base=USD shows SAR at exactly 3.75
// and AED at exactly 3.6725 — matching the well-known real-world currency pegs
// exactly, which is about as clear a confirmation as you can get that the feed is
// genuine and not placeholder data.
//
// Saudi Arabia doesn't yet have a public, non-JS bank-rate aggregator site like
// Egypt's egrates.com/NBE that could be scraped for a real local buy/sell spread —
// SAMA's own official rate page is a JavaScript single-page app (confirmed directly),
// the same kind of blocker that ruled out NBE's own site for Egypt. So for now, buy
// and sell are both set to the same live Frankfurter mid-market rate — exactly how
// Egypt's own Frankfurter fallback tier behaves when no bank source is available.
// This can be upgraded to a real scraped buy/sell spread later the same way NBE was
// layered on top for Egypt, if a scrapeable Saudi bank-rate source turns up.

const SAUDI_CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'EGP', 'AED', 'KWD', 'BHD', 'QAR', 'JOD', 'INR', 'PKR', 'AUD', 'LYD', 'TRY', 'CHF'];

/**
 * Fetches currency rates (SAR per 1 unit of each currency) from Frankfurter.
 * Same shape/approach as fetchCurrencies() above, just with SAR as the base.
 */
async function fetchSaudiCurrencies() {
  const url = `${FRANKFURTER_URL}?base=SAR&quotes=${SAUDI_CURRENCY_CODES.join(',')}`;
  const res = await axios.get(url, { timeout: 15000 });
  const data = res.data;

  if (!Array.isArray(data)) throw new Error('Unexpected Frankfurter response shape (Saudi)');

  const rates = {};
  let rateDate = null;
  for (const rec of data) {
    if (rec.rate) {
      rates[rec.quote] = 1 / rec.rate; // invert: SAR per 1 unit of currency
      rateDate = rec.date;
    }
  }
  if (!rates.USD) throw new Error('Frankfurter response missing USD (Saudi)');

  return { rates, rateDate };
}

/**
 * Wraps fetchSaudiCurrencies() into the same {code: {buy, sell}, sources} shape
 * resolveCurrencies() produces for Egypt, so update-prices.js can treat both the
 * same way. Never throws — if the fetch fails, returns an empty object and lets
 * the caller keep the previous cached data.
 */
async function resolveSaudiCurrencies() {
  const result = {};
  const sources = {};
  try {
    const { rates } = await fetchSaudiCurrencies();
    for (const code of Object.keys(rates)) {
      result[code] = { buy: rates[code], sell: rates[code] };
      sources[code] = 'frankfurter';
    }
  } catch (err) {
    console.error('Saudi Frankfurter currency fetch failed:', err.message);
  }
  return { rates: result, sources };
}

// ============================================================================
// SAUDI ARABIA SILVER — single 999 fine-silver per-gram card, same minimal
// shape the Egypt page itself uses (Egypt's own live site only ever displays
// one silver card — 999 — even though its scraper technically captures more
// purities from iSagha; this mirrors that same simple design for Saudi).
// ============================================================================
//
// Source: saudigoldprice.com/silverprice/ — confirmed directly (fetched the
// live page): real, server-rendered HTML (not a JS app), updated same-day
// (confirmed against today's date on the live page), with two genuinely
// distinct buy/sell numbers for 999 fine silver per gram — "سعر جرام الفضة"
// appears once under a "شراء جديد" (buy/new) table and once under an
// "اعادة بيع" (resale/sell) table. Cross-checked directly against the page's
// own separate top-of-page summary row for 999 purity, which lands almost
// exactly on the resale figure — a good sanity check that the numbers are
// real and internally consistent, not placeholder data.

const SAUDI_SILVER_URL = 'https://saudigoldprice.com/silverprice/';

async function scrapeSaudiSilver() {
  const res = await axios.get(SAUDI_SILVER_URL, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'ar,en;q=0.8',
    },
  });

  const $ = cheerio.load(res.data);
  let summarySell = null;
  const gramPrices = []; // in page order: buy(new) first, then resale(sell)

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const label = $(cells[0]).text().trim();
    const sarText = $(cells[1]).text().trim();
    const v = parseSarNumber(sarText);
    if (v === null) return;

    if (summarySell === null && label.includes('999') && label.includes('جرام')) {
      summarySell = v;
    }
    if (label.includes('سعر جرام الفضة') && !label.includes('عيار')) {
      gramPrices.push(v);
    }
  });

  let buy, sell;
  if (gramPrices.length >= 2) {
    buy = gramPrices[0];
    sell = gramPrices[1];
  } else if (summarySell !== null) {
    buy = summarySell;
    sell = summarySell;
  }

  if (buy === undefined || sell === undefined) {
    throw new Error('Could not locate 999 silver gram price on saudigoldprice.com — page structure may have changed');
  }

  return { silver: { s999: { buy, sell } }, scrapedAt: new Date().toISOString() };
}

module.exports = {
  scrapeISagha, scrapeNBE, fetchCurrencies, resolveCurrencies, CURRENCY_CODES,
  parseEgpNumber, GOLD_ROW_MAP, SILVER_ROW_MAP, ISAGHA_CURRENCY_ROW_MAP,
  scrapeSaudiGold, parseSarNumber, SAUDI_GOLD_ROW_MAP,
  fetchSaudiCurrencies, resolveSaudiCurrencies, SAUDI_CURRENCY_CODES,
  scrapeSaudiSilver,
};
