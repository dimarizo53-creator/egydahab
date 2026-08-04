// update-prices.js
// Run by a GitHub Actions scheduled workflow every 15 minutes. No server, no hosting,
// no subscription — GitHub runs this for free and commits the result back to the repo.
//
// Reads the existing prices.json (if any), tries to refresh gold/silver (iSagha) and
// currencies (Frankfurter) independently, and only overwrites a section if that
// section's fetch succeeded — so a temporary failure on one source never wipes out
// good data, it just leaves that section's timestamp/status showing it's stale.

const fs = require('fs');
const path = require('path');
const { scrapeISagha, resolveCurrencies, scrapeSaudiGold, resolveSaudiCurrencies, scrapeSaudiSilver, CURRENCY_CODES, SAUDI_CURRENCY_CODES } = require('./scraper');

const OUTPUT_FILE = path.join(__dirname, 'prices.json');

// Safety net: enforce sell >= buy on every {buy, sell} pair before it's written,
// no matter which scraper produced it. This is the one invariant that holds
// everywhere on this site (a shop always sells higher than it buys back) — the
// exact rule that Saudi gold/silver broke because a source site's column order
// was misread. If any source (current or future) ever gets misread the same
// way, this silently corrects it here instead of shipping an inverted price.
function normalizeSpread(obj) {
  if (!obj) return obj;
  const out = {};
  for (const key of Object.keys(obj)) {
    const entry = obj[key];
    if (entry && typeof entry.buy === 'number' && typeof entry.sell === 'number' && entry.buy > entry.sell) {
      console.warn(`normalizeSpread: swapped inverted buy/sell for "${key}" (buy=${entry.buy} > sell=${entry.sell})`);
      out[key] = { ...entry, buy: entry.sell, sell: entry.buy };
    } else {
      out[key] = entry;
    }
  }
  return out;
}

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch {
    return {
      gold: null, silver: null, currencies: null,
      goldSilverUpdatedAt: null, currenciesUpdatedAt: null,
      goldSilverStatus: 'never_fetched', currenciesStatus: 'never_fetched',
    };
  }
}

async function main() {
  const data = loadExisting();

  try {
    const { gold, silver, scrapedAt } = await scrapeISagha();
    // Keep whatever was live before this run so the frontend can show a
    // "change since last update" percentage next to each price.
    if (data.gold) data.previousGold = data.gold;
    if (data.silver) data.previousSilver = data.silver;
    data.gold = normalizeSpread(gold);
    data.silver = normalizeSpread(silver);
    data.goldSilverUpdatedAt = scrapedAt;
    data.goldSilverStatus = 'live';
    console.log('Gold/silver refreshed OK at', scrapedAt, '— 24K sell:', gold.k24.sell);
  } catch (err) {
    data.goldSilverStatus = 'stale_fallback';
    console.error('Gold/silver refresh FAILED, keeping previous data:', err.message);
  }

  try {
    const { rates, sources } = await resolveCurrencies();
    if (!rates.USD) throw new Error('No currency source returned USD data');
    if (data.currencies) data.previousCurrencies = data.currencies;
    // Merge on top of whatever was already live, instead of replacing wholesale —
    // if this run's fetch only came back with a subset of currencies (one tier
    // failing, e.g. a network hiccup), the codes it didn't get keep their last
    // known-good value instead of silently disappearing from the site.
    data.currencies = normalizeSpread(Object.assign({}, data.currencies, rates));
    data.currencySources = Object.assign({}, data.currencySources, sources);
    data.currenciesUpdatedAt = new Date().toISOString();
    data.currenciesStatus = Object.keys(rates).length >= CURRENCY_CODES.length ? 'live' : 'partial';
    console.log('Currencies refreshed OK —', Object.keys(rates).length, '/', CURRENCY_CODES.length, 'codes — USD:', JSON.stringify(rates.USD), 'sources:', JSON.stringify(sources));
  } catch (err) {
    data.currenciesStatus = 'stale_fallback';
    console.error('Currency refresh FAILED, keeping previous data:', err.message);
  }

  try {
    const { gold, scrapedAt } = await scrapeSaudiGold();
    data.saudi = data.saudi || {};
    if (data.saudi.gold) data.saudi.previousGold = data.saudi.gold;
    data.saudi.gold = normalizeSpread(gold);
    data.saudi.goldUpdatedAt = scrapedAt;
    data.saudi.goldStatus = 'live';
    console.log('Saudi gold refreshed OK at', scrapedAt, '— 24K sell:', gold.k24.sell);
  } catch (err) {
    data.saudi = data.saudi || {};
    data.saudi.goldStatus = 'stale_fallback';
    console.error('Saudi gold refresh FAILED, keeping previous data:', err.message);
  }

  try {
    const { rates, sources } = await resolveSaudiCurrencies();
    if (!rates.USD) throw new Error('No Saudi currency source returned USD data');
    data.saudi = data.saudi || {};
    if (data.saudi.currencies) data.saudi.previousCurrencies = data.saudi.currencies;
    data.saudi.currencies = normalizeSpread(Object.assign({}, data.saudi.currencies, rates));
    data.saudi.currencySources = Object.assign({}, data.saudi.currencySources, sources);
    data.saudi.currenciesUpdatedAt = new Date().toISOString();
    data.saudi.currenciesStatus = Object.keys(rates).length >= SAUDI_CURRENCY_CODES.length ? 'live' : 'partial';
    console.log('Saudi currencies refreshed OK —', Object.keys(rates).length, '/', SAUDI_CURRENCY_CODES.length, 'codes — USD:', JSON.stringify(rates.USD));
  } catch (err) {
    data.saudi = data.saudi || {};
    data.saudi.currenciesStatus = 'stale_fallback';
    console.error('Saudi currency refresh FAILED, keeping previous data:', err.message);
  }

  try {
    const { silver, scrapedAt } = await scrapeSaudiSilver();
    data.saudi = data.saudi || {};
    if (data.saudi.silver) data.saudi.previousSilver = data.saudi.silver;
    data.saudi.silver = normalizeSpread(silver);
    data.saudi.silverUpdatedAt = scrapedAt;
    data.saudi.silverStatus = 'live';
    console.log('Saudi silver refreshed OK at', scrapedAt, '— 999 sell:', silver.s999.sell);
  } catch (err) {
    data.saudi = data.saudi || {};
    data.saudi.silverStatus = 'stale_fallback';
    console.error('Saudi silver refresh FAILED, keeping previous data:', err.message);
  }

  data.lastRunAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log('Wrote', OUTPUT_FILE);
}

main();
