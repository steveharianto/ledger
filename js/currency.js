/* ============================================================================
   js/currency.js
   State controller for live exchange rates (ExchangeRate-API open endpoint).
   Fetched once on app initialization, cached in module-level global memory,
   and used for every cross-currency conversion in the app.
   ========================================================================== */

import { updateProfile } from './supabase.js';

/** Currencies offered in every selector across the app. */
export const CURRENCIES = ['IDR', 'USD', 'EUR', 'SGD', 'JPY', 'GBP', 'AUD', 'MYR', 'CNY', 'KRW'];

const RATES_ENDPOINT = 'https://open.er-api.com/v6/latest/USD';

/* ----------------------------------------------------------------------------
   Module-level cache (global memory for the lifetime of the page)
---------------------------------------------------------------------------- */
let rates = null;          // { USD: 1, IDR: 16234.5, ... } — all relative to USD
let ratesFetchedAt = null; // Date of last successful fetch
let baseCurrency = 'IDR';  // mirrors profiles.preferred_base_currency

/**
 * Fetch live rates and cache them. Called once during app initialization
 * (and again on manual refresh). Rates are fetched against a USD pivot so a
 * single request supports arbitrary from→to cross-conversion.
 */
export async function loadRates() {
  try {
    const res = await fetch(RATES_ENDPOINT);
    if (!res.ok) throw new Error(`Rate API responded ${res.status}`);
    const json = await res.json();
    if (json.result !== 'success' || !json.rates) throw new Error('Rate API returned a non-success payload');
    rates = json.rates;
    ratesFetchedAt = new Date();
    return true;
  } catch (err) {
    console.warn('[currency] Live rate fetch failed — conversions will pass values through unchanged.', err);
    return false;
  }
}

export function ratesReady() {
  return rates !== null;
}

export function ratesTimestamp() {
  return ratesFetchedAt;
}

/* ----------------------------------------------------------------------------
   Conversion
---------------------------------------------------------------------------- */

/**
 * Convert an amount from one currency into the chosen base currency.
 * Cross-rate math through the USD pivot: amount / rate(from) * rate(to).
 * Degrades gracefully (returns the input) if rates are unavailable.
 */
export function convertToBase(amount, fromCurrency, toBaseCurrency = baseCurrency) {
  const value = Number(amount) || 0;
  if (!fromCurrency || fromCurrency === toBaseCurrency) return value;
  if (!rates || !rates[fromCurrency] || !rates[toBaseCurrency]) return value;
  return (value / rates[fromCurrency]) * rates[toBaseCurrency];
}

/** General from→to conversion (used by transfers and debt currency mapping). */
export function convertBetween(amount, fromCurrency, toCurrency) {
  return convertToBase(amount, fromCurrency, toCurrency);
}

/* ----------------------------------------------------------------------------
   Base currency state — mirrors profiles.preferred_base_currency
---------------------------------------------------------------------------- */

export function getBaseCurrency() {
  return baseCurrency;
}

/** Set the in-memory base without persisting (used while loading the profile). */
export function hydrateBaseCurrency(code) {
  if (code) baseCurrency = code;
}

/**
 * Change the global base currency from the dashboard dropdown.
 * Updates local state immediately and persists the choice to
 * profiles.preferred_base_currency.
 */
export async function setBaseCurrency(code, userId) {
  baseCurrency = code;
  if (userId) {
    try {
      await updateProfile(userId, { preferred_base_currency: code });
    } catch (err) {
      console.warn('[currency] Failed to persist preferred base currency.', err);
    }
  }
}

/* ----------------------------------------------------------------------------
   Formatting
---------------------------------------------------------------------------- */

const ZERO_DECIMAL = new Set(['IDR', 'JPY', 'KRW']);

/** Format a money value with its currency symbol/code. */
export function fmtMoney(amount, currency = baseCurrency) {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : 2,
      maximumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString()}`;
  }
}

/** Format a raw quantity (asset units, commodity units) with smart precision. */
export function fmtQty(quantity) {
  const value = Number(quantity) || 0;
  return value.toLocaleString(undefined, { maximumFractionDigits: 8 });
}
