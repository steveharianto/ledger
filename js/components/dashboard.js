/* ============================================================================
   js/components/dashboard.js
   Unified net worth view. Every figure is converted into the chosen Base
   Currency with cached live rates BEFORE cards render or sums run.

   Total Net Worth =
     (Wallets − Unpaid Credit Balances)
     + Assets Total Value
     + Debts Owed To Me − Debts I Owe
   ========================================================================== */

import { state, rerender, escapeHtml } from '../app.js';
import {
  CURRENCIES,
  convertToBase,
  getBaseCurrency,
  setBaseCurrency,
  fmtMoney,
  fmtQty,
  ratesReady,
  ratesTimestamp,
} from '../currency.js';

/* ----------------------------------------------------------------------------
   Net worth computation — all terms returned in the Base Currency.
---------------------------------------------------------------------------- */
export function computeNetWorth(appState, base) {
  // Wallets: Σ accounts.balance where type = 'wallet'
  const wallets = appState.accounts
    .filter((a) => a.type === 'wallet' && a.is_active)
    .reduce((sum, a) => sum + convertToBase(a.balance, a.currency, base), 0);

  // Unpaid Credit Balances: Σ accounts.balance where type = 'credit'
  const credits = appState.accounts
    .filter((a) => a.type === 'credit' && a.is_active)
    .reduce((sum, a) => sum + convertToBase(a.balance, a.currency, base), 0);

  // Assets Total Value: Σ quantity × current_unit_price per active asset
  const assets = appState.assets
    .filter((a) => a.is_active)
    .reduce(
      (sum, a) => sum + convertToBase((Number(a.quantity) || 0) * (Number(a.current_unit_price) || 0), a.currency, base),
      0
    );

  // Debts — dual-path monetary / commodity valuation
  let owedToMe = 0;
  let iOwe = 0;
  for (const debt of appState.debts) {
    if (debt.is_settled || !debt.is_active) continue;
    let value = 0;
    if (debt.is_monetary) {
      value = convertToBase(debt.remaining_amount, debt.currency, base);
    } else {
      // Commodity: remaining units × linked asset's live unit price
      const linked = appState.assets.find((a) => a.id === debt.linked_asset_id);
      if (linked) {
        value = convertToBase(
          (Number(debt.remaining_amount) || 0) * (Number(linked.current_unit_price) || 0),
          linked.currency,
          base
        );
      }
    }
    if (debt.direction === 'they_owe') owedToMe += value;
    else iOwe += value;
  }

  return {
    wallets,
    credits,
    assets,
    owedToMe,
    iOwe,
    net: wallets - credits + assets + owedToMe - iOwe,
  };
}

/* ----------------------------------------------------------------------------
   Render
---------------------------------------------------------------------------- */
export function renderDashboard(appState, mount) {
  const base = getBaseCurrency();
  const totals = computeNetWorth(appState, base);
  const stamp = ratesTimestamp();

  const walletAccounts = appState.accounts.filter((a) => a.type === 'wallet' && a.is_active);
  const creditAccounts = appState.accounts.filter((a) => a.type === 'credit' && a.is_active);
  const activeAssets = appState.assets.filter((a) => a.is_active);
  const openDebts = appState.debts.filter((d) => d.is_active && !d.is_settled);

  mount.innerHTML = `
    <header class="mb-8">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="eyebrow mb-2">Total net worth · all holdings converted</p>
          <p class="networth-figure ${totals.net < 0 ? 'text-down' : ''}">${fmtMoney(totals.net, base)}</p>
        </div>
        <div class="min-w-[10rem]">
          <label for="base-currency" class="field-label">Base currency</label>
          <select id="base-currency" class="field-select">
            ${CURRENCIES.map((c) => `<option value="${c}" ${c === base ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <p class="mt-3 text-xs text-muted">
        ${ratesReady()
          ? `Live rates cached ${stamp ? stamp.toLocaleTimeString() : ''} · ExchangeRate-API`
          : '⚠ Live rates unavailable — foreign amounts shown unconverted.'}
      </p>
    </header>

    <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      ${summaryCard('Wallets', totals.wallets, base, `${walletAccounts.length} pocket${walletAccounts.length === 1 ? '' : 's'}`, 'up')}
      ${summaryCard('Unpaid credit', totals.credits, base, `${creditAccounts.length} line${creditAccounts.length === 1 ? '' : 's'} of credit`, 'down')}
      ${summaryCard('Assets', totals.assets, base, `${activeAssets.length} holding${activeAssets.length === 1 ? '' : 's'}`, 'up')}
      ${summaryCard('Debts (net)', totals.owedToMe - totals.iOwe, base, `${openDebts.length} open record${openDebts.length === 1 ? '' : 's'}`, totals.owedToMe - totals.iOwe >= 0 ? 'up' : 'down')}
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section class="card">
        <div class="section-head"><h3>Pockets at a glance</h3><span class="count">${walletAccounts.length + creditAccounts.length} active</span></div>
        ${walletAccounts.length + creditAccounts.length === 0
          ? `<p class="text-sm text-muted">No accounts yet — add your first wallet in the Accounts tab.</p>`
          : [...walletAccounts, ...creditAccounts].map((a) => pocketRow(a, base)).join('')}
      </section>

      <section class="card">
        <div class="section-head"><h3>Open debts</h3><span class="count">${openDebts.length} unsettled</span></div>
        ${openDebts.length === 0
          ? `<p class="text-sm text-muted">Nothing owed in either direction. Clean slate.</p>`
          : openDebts.map((d) => debtRow(d, appState, base)).join('')}
      </section>
    </div>`;

  // Base Currency Selector — persists to profiles.preferred_base_currency
  mount.querySelector('#base-currency').addEventListener('change', async (e) => {
    await setBaseCurrency(e.target.value, appState.user.id);
    await rerender();
  });
}

/* ----------------------------------------------------------------------------
   Partials
---------------------------------------------------------------------------- */

function summaryCard(label, value, base, sub, tone) {
  return `
    <article class="card">
      <p class="eyebrow mb-2">${escapeHtml(label)}</p>
      <p class="num text-lg font-medium ${tone === 'down' && value !== 0 ? 'text-down' : ''}">${fmtMoney(value, base)}</p>
      <p class="mt-1 text-xs text-muted">${escapeHtml(sub)}</p>
    </article>`;
}

function pocketRow(account, base) {
  const native = fmtMoney(account.balance, account.currency);
  const converted = account.currency === base ? '' : `<span class="badge ml-2">≈ ${fmtMoney(convertToBase(account.balance, account.currency, base), base)}</span>`;
  return `
    <div class="flex items-center justify-between py-2 border-b border-line last:border-b-0">
      <div class="min-w-0">
        <p class="text-sm font-medium truncate">${escapeHtml(account.name)}</p>
        <p class="text-xs text-muted">${account.type === 'wallet' ? 'Wallet' : 'Credit · unpaid balance'}</p>
      </div>
      <p class="num text-sm ${account.type === 'credit' && account.balance > 0 ? 'text-down' : ''}">${native}${converted}</p>
    </div>`;
}

function debtRow(debt, appState, base) {
  const dir = debt.direction === 'they_owe';
  let valueLine;
  if (debt.is_monetary) {
    valueLine = `${fmtMoney(debt.remaining_amount, debt.currency)} <span class="badge ml-1">≈ ${fmtMoney(convertToBase(debt.remaining_amount, debt.currency, base), base)}</span>`;
  } else {
    const linked = appState.assets.find((a) => a.id === debt.linked_asset_id);
    const units = `${fmtQty(debt.remaining_amount)} ${escapeHtml(debt.unit_name || 'units')}`;
    valueLine = linked
      ? `${units} <span class="badge ml-1">≈ ${fmtMoney(convertToBase(debt.remaining_amount * (linked.current_unit_price || 0), linked.currency, base), base)}</span>`
      : `${units} <span class="badge ml-1">no linked asset</span>`;
  }
  return `
    <div class="flex items-center justify-between py-2 border-b border-line last:border-b-0">
      <div class="min-w-0">
        <p class="text-sm font-medium truncate">${escapeHtml(debt.person_name)}</p>
        <p class="text-xs ${dir ? 'text-up' : 'text-down'}">${dir ? 'Owes you' : 'You owe'}</p>
      </div>
      <p class="num text-sm text-right">${valueLine}</p>
    </div>`;
}
