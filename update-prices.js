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
const { scrapeISagha, resolveCurrencies } = require('./scraper');

const OUTPUT_FILE = path.join(__dirname, 'prices.json');

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
    data.gold = gold;
    data.silver = silver;
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
    data.currencies = rates;
    data.currencySources = sources;
    data.currenciesUpdatedAt = new Date().toISOString();
    data.currenciesStatus = 'live';
    console.log('Currencies refreshed OK — USD:', JSON.stringify(rates.USD), 'sources:', JSON.stringify(sources));
  } catch (err) {
    data.currenciesStatus = 'stale_fallback';
    console.error('Currency refresh FAILED, keeping previous data:', err.message);
  }

  data.lastRunAt = new Date().toISOString();
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log('Wrote', OUTPUT_FILE);
}

main();
