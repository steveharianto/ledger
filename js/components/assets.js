/* ============================================================================
   js/components/assets.js
   Physical & digital asset tracker. API-tracked assets lazily refresh their
   unit price from CoinGecko on mount (with USD fallback conversion and
   free-tier stagger), persisting successful prices to assets.current_unit_price.
   ========================================================================== */

import {
  insertAsset,
  updateAsset,
  deleteAsset,
  countLogsWhere,
  countDebtsWhere,
} from '../supabase.js';
import {
  state,
  refreshData,
  refreshAndRender,
  openModal,
  closeModal,
  confirmAction,
  toast,
  escapeHtml,
} from '../app.js';
import {
  CURRENCIES,
  convertToBase,
  convertBetween,
  getBaseCurrency,
  fmtMoney,
  fmtQty,
} from '../currency.js';

const COINGECKO_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';
const STAGGER_MS = 120;

export function renderAssets(appState, mount) {
  const base = getBaseCurrency();
  const physical = appState.assets.filter((a) => a.is_active && !a.is_digital);
  const digital = appState.assets.filter((a) => a.is_active && a.is_digital);
  const inactive = appState.assets.filter((a) => !a.is_active);

  mount.innerHTML = `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="eyebrow mb-1">Assets</p>
        <h2 class="font-display text-3xl font-medium">Physical &amp; digital holdings</h2>
      </div>
      <button id="btn-add-asset" class="btn-primary">New asset</button>
    </header>

    <section class="mb-8">
      <div class="section-head"><h3>Physical assets</h3><span class="count">${physical.length}</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${physical.length ? physical.map((a) => assetCard(a, base)).join('') : `<p class="text-sm text-muted">No physical assets yet — gold, vehicles, property.</p>`}
      </div>
    </section>

    <section class="mb-8">
      <div class="section-head"><h3>Digital assets</h3><span class="count">${digital.length}</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${digital.length ? digital.map((a) => assetCard(a, base)).join('') : `<p class="text-sm text-muted">No digital assets yet — crypto, tokens, in-game holdings.</p>`}
      </div>
    </section>

    ${inactive.length ? `
    <section>
      <div class="section-head"><h3>Inactive</h3><span class="count">${inactive.length} retained for history</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${inactive.map((a) => `
          <article class="card card-inactive">
            <p class="text-sm font-semibold truncate">${escapeHtml(a.name)}</p>
            <p class="text-xs text-muted mt-1">kept because logs or debts reference it</p>
            <button class="btn-ghost mt-3" data-revive-asset="${a.id}">Revive</button>
          </article>`).join('')}
      </div>
    </section>` : ''}`;

  mount.querySelector('#btn-add-asset').addEventListener('click', () => openAssetForm(null));
  mount.querySelectorAll('[data-edit-asset]').forEach((btn) =>
    btn.addEventListener('click', () => openAssetForm(state.assets.find((a) => a.id === btn.dataset.editAsset)))
  );
  mount.querySelectorAll('[data-delete-asset]').forEach((btn) =>
    btn.addEventListener('click', () => handleDelete(btn.dataset.deleteAsset))
  );
  mount.querySelectorAll('[data-revive-asset]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await updateAsset(btn.dataset.reviveAsset, { is_active: true });
      toast('Asset revived.', 'success');
      await refreshAndRender();
    })
  );

  // Lazy live-price refresh — fire and forget; cards update in place.
  fetchLivePrices(appState, mount, base);
}

/* ----------------------------------------------------------------------------
   Card
---------------------------------------------------------------------------- */

function assetCard(asset, base) {
  const qty = Number(asset.quantity) || 0;
  const price = Number(asset.current_unit_price) || 0;
  const total = qty * price;
  return `
    <article class="card" data-asset-card="${asset.id}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm font-semibold truncate">${escapeHtml(asset.name)}</p>
          <span class="badge ${asset.is_digital ? 'badge-brass' : ''} mt-1">${asset.is_digital ? 'Digital' : 'Physical'} · ${escapeHtml(asset.currency)}</span>
          ${asset.is_api_tracked && asset.api_ticker_or_url
            ? `<span class="badge badge-up mt-1 ml-1" data-price-status="${asset.id}">live · ${escapeHtml(asset.api_ticker_or_url)}</span>`
            : ''}
        </div>
        <div class="flex gap-1">
          <button class="btn-icon" data-edit-asset="${asset.id}" title="Edit">✎</button>
          <button class="btn-icon" data-delete-asset="${asset.id}" title="Delete">🗑</button>
        </div>
      </div>
      <div class="mt-4 space-y-1.5 text-sm">
        <div class="flex justify-between"><span class="text-muted">Quantity</span><span class="num">${fmtQty(qty)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Unit price</span><span class="num" data-unit-price="${asset.id}">${fmtMoney(price, asset.currency)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Total value</span><span class="num font-medium" data-total-value="${asset.id}">${fmtMoney(total, asset.currency)}</span></div>
      </div>
      <span class="badge mt-2" data-base-value="${asset.id}">≈ ${fmtMoney(convertToBase(total, asset.currency, base), base)}</span>
    </article>`;
}

/* ----------------------------------------------------------------------------
   CoinGecko lazy load
---------------------------------------------------------------------------- */

async function fetchLivePrices(appState, mount, base) {
  const tracked = appState.assets.filter(
    (a) => a.is_active && a.is_api_tracked && a.api_ticker_or_url && a.api_ticker_or_url.trim() !== ''
  );
  if (tracked.length === 0) return;

  // Respect the free-tier rate limit (~30 req/min): stagger when >10 calls.
  const stagger = tracked.length > 10;
  let updatedAny = false;

  for (const asset of tracked) {
    const coinId = asset.api_ticker_or_url.trim().toLowerCase();
    const vs = (asset.currency || 'usd').toLowerCase();
    try {
      let livePrice = null;

      const url = `${COINGECKO_ENDPOINT}?ids=${encodeURIComponent(coinId)}&vs_currencies=${encodeURIComponent(vs)},usd`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
      const data = await res.json();
      const entry = data[coinId];
      if (!entry) throw new Error(`Unrecognized coin id "${coinId}"`);

      if (entry[vs] !== undefined) {
        livePrice = entry[vs];
      } else if (entry.usd !== undefined) {
        // Native currency unsupported as a vs_currency → fall back to USD
        // and convert with cached ExchangeRate-API rates.
        livePrice = convertBetween(entry.usd, 'USD', asset.currency);
      } else {
        throw new Error(`No usable price returned for "${coinId}"`);
      }

      await updateAsset(asset.id, { current_unit_price: livePrice });
      updatedAny = true;

      // Patch the card in place if the user is still on this view.
      const local = state.assets.find((a) => a.id === asset.id);
      if (local) local.current_unit_price = livePrice;
      patchCard(mount, asset.id, livePrice, base);
    } catch (err) {
      // Preserve the stored price; surface a subtle indicator on the card.
      console.warn(`[assets] Live price fetch failed for "${coinId}":`, err);
      const statusEl = mount.querySelector(`[data-price-status="${asset.id}"]`);
      if (statusEl) {
        statusEl.className = 'badge badge-down mt-1 ml-1';
        statusEl.textContent = '⚠ Price unavailable';
      }
    }

    if (stagger) await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
  }

  // Keep global state coherent for the dashboard's next paint.
  if (updatedAny && state.route !== 'assets') await refreshData();
}

function patchCard(mount, assetId, livePrice, base) {
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return;
  const total = (Number(asset.quantity) || 0) * livePrice;
  const unitEl = mount.querySelector(`[data-unit-price="${assetId}"]`);
  const totalEl = mount.querySelector(`[data-total-value="${assetId}"]`);
  const baseEl = mount.querySelector(`[data-base-value="${assetId}"]`);
  if (unitEl) unitEl.textContent = fmtMoney(livePrice, asset.currency);
  if (totalEl) totalEl.textContent = fmtMoney(total, asset.currency);
  if (baseEl) baseEl.textContent = `≈ ${fmtMoney(convertToBase(total, asset.currency, base), base)}`;
}

/* ----------------------------------------------------------------------------
   Create / edit form
---------------------------------------------------------------------------- */

function openAssetForm(existing) {
  const isEdit = Boolean(existing);
  const asset = existing || {
    name: '', is_digital: false, quantity: 0, current_unit_price: 0,
    is_api_tracked: false, api_ticker_or_url: '', currency: getBaseCurrency(),
  };

  openModal(isEdit ? 'Edit asset' : 'New asset', `
    <form id="asset-form" class="space-y-4">
      <div>
        <label class="field-label" for="ast-name">Name</label>
        <input id="ast-name" class="field-input" required value="${escapeHtml(asset.name)}" placeholder="e.g. Antam Gold, Bitcoin" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="ast-type">Type</label>
          <select id="ast-type" class="field-select">
            <option value="physical" ${asset.is_digital ? '' : 'selected'}>Physical</option>
            <option value="digital" ${asset.is_digital ? 'selected' : ''}>Digital</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="ast-currency">Currency</label>
          <select id="ast-currency" class="field-select">
            ${CURRENCIES.map((c) => `<option value="${c}" ${c === asset.currency ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="ast-qty">Quantity</label>
          <input id="ast-qty" class="field-input num" type="number" step="any" min="0" value="${asset.quantity ?? 0}" />
        </div>
        <div>
          <label class="field-label" for="ast-price">Current unit price</label>
          <input id="ast-price" class="field-input num" type="number" step="any" min="0" value="${asset.current_unit_price ?? 0}" />
        </div>
      </div>
      <label class="flex items-center gap-2 text-sm cursor-pointer">
        <input id="ast-tracked" type="checkbox" ${asset.is_api_tracked ? 'checked' : ''} />
        Track price via API (CoinGecko)
      </label>
      <div id="ticker-field" class="${asset.is_api_tracked ? '' : 'hidden'}">
        <label class="field-label" for="ast-ticker">CoinGecko coin ID</label>
        <input id="ast-ticker" class="field-input" value="${escapeHtml(asset.api_ticker_or_url || '')}" placeholder="bitcoin · ethereum · pax-gold · the-sandbox" />
        <p class="text-xs text-muted mt-1">Use the coin's API id, not its ticker symbol. Prices refresh each time the Assets tab opens.</p>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Create asset'}</button>
      </div>
    </form>`, (card) => {
    card.querySelector('#ast-tracked').addEventListener('change', (e) => {
      card.querySelector('#ticker-field').classList.toggle('hidden', !e.target.checked);
    });

    card.querySelector('#asset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const row = {
        name: card.querySelector('#ast-name').value.trim(),
        is_digital: card.querySelector('#ast-type').value === 'digital',
        currency: card.querySelector('#ast-currency').value,
        quantity: Number(card.querySelector('#ast-qty').value) || 0,
        current_unit_price: Number(card.querySelector('#ast-price').value) || 0,
        is_api_tracked: card.querySelector('#ast-tracked').checked,
        api_ticker_or_url: card.querySelector('#ast-ticker').value.trim(),
      };
      try {
        if (isEdit) {
          await updateAsset(asset.id, row);
          toast('Asset updated.', 'success');
        } else {
          await insertAsset({ ...row, user_id: state.user.id, is_active: true });
          toast('Asset created.', 'success');
        }
        closeModal();
        await refreshAndRender();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ----------------------------------------------------------------------------
   Data Retention Rule — verify against logs AND debts before deleting
---------------------------------------------------------------------------- */

async function handleDelete(assetId) {
  const asset = state.assets.find((a) => a.id === assetId);
  if (!asset) return;

  const ok = await confirmAction(
    `Delete "${asset.name}"? If logs or debts reference it, it is deactivated to preserve accounting history.`,
    'Delete asset',
    true
  );
  if (!ok) return;

  try {
    const [logRefs, debtRefs] = await Promise.all([
      countLogsWhere('asset_id', assetId),
      countDebtsWhere('linked_asset_id', assetId),
    ]);

    if (logRefs + debtRefs > 0) {
      await updateAsset(assetId, { is_active: false });
      toast('Asset has usage traces — deactivated instead of deleted.', 'success');
    } else {
      await deleteAsset(assetId);
      toast('Asset deleted.', 'success');
    }
    await refreshAndRender();
  } catch (err) {
    toast(err.message, 'error');
  }
}
