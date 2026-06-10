/* ============================================================================
   js/components/logs.js
   The central ledger. A persistent filter bar (date range, type multi-select,
   account, category, notes search — combined with AND logic) sits above the
   feed. Every write routes through the atomic RPC layer; deletes and edits
   run the universal reverse_log procedure first so balances never drift.

   Currency Inheritance Rule: a log's amount/currency always follow the
   funding account. For debt logs whose debt lives in a different currency,
   the debt-native delta is resolved client-side with cached rates and rides
   in logs.asset_quantity_changed as a historical snapshot (commodity debts
   already use that column for raw units), so reversals never re-derive
   values from live rates.
   ========================================================================== */

import {
  listLogs,
  processExpenseLog,
  processIncomeLog,
  processAssetBuyLog,
  processAssetSellLog,
  processDebtAddLog,
  processDebtPayoffLog,
  processTransferLog,
  reverseLog,
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
  nowLocalInputValue,
  currentMonthRange,
} from '../app.js';
import { convertBetween, fmtMoney, fmtQty } from '../currency.js';

const ALL_TYPES = ['expense', 'income', 'debt_add', 'debt_payoff', 'asset_buy', 'asset_sell', 'transfer'];

const TYPE_LABELS = {
  expense: 'Expense',
  income: 'Income',
  debt_add: 'Debt add',
  debt_payoff: 'Debt payoff',
  asset_buy: 'Asset buy',
  asset_sell: 'Asset sell',
  transfer: 'Transfer',
};

/* Sign convention for the feed — purely presentational. */
const TYPE_TONE = {
  expense: 'down',
  income: 'up',
  asset_buy: 'down',
  asset_sell: 'up',
  transfer: 'neutral',
  debt_add: 'neutral',
  debt_payoff: 'neutral',
};

/* ----------------------------------------------------------------------------
   Filter state — survives re-renders and tab switches via state.ui
---------------------------------------------------------------------------- */

function getFilters() {
  if (!state.ui.logFilters) {
    const { start, end } = currentMonthRange(); // defaults to the current calendar month
    state.ui.logFilters = {
      start,
      end,
      types: [...ALL_TYPES], // all seven selected by default
      accountId: '',         // '' = All Accounts
      categoryId: '',        // '' = All
      notes: '',
    };
  }
  return state.ui.logFilters;
}

function rangeToISO(filters) {
  const startISO = filters.start ? new Date(`${filters.start}T00:00:00`).toISOString() : null;
  const endISO = filters.end ? new Date(`${filters.end}T23:59:59.999`).toISOString() : null;
  return { startISO, endISO };
}

/* ----------------------------------------------------------------------------
   Render
---------------------------------------------------------------------------- */

export async function renderLogs(appState, mount) {
  const filters = getFilters();

  mount.innerHTML = `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="eyebrow mb-1">Logs</p>
        <h2 class="font-display text-3xl font-medium">The central ledger</h2>
      </div>
      <button id="btn-add-log" class="btn-primary">New log</button>
    </header>

    <section class="card mb-6" id="filter-bar">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div>
          <label class="field-label" for="flt-start">From</label>
          <input id="flt-start" class="field-input" type="date" value="${filters.start}" />
        </div>
        <div>
          <label class="field-label" for="flt-end">To</label>
          <input id="flt-end" class="field-input" type="date" value="${filters.end}" />
        </div>
        <div>
          <label class="field-label" for="flt-account">Account</label>
          <select id="flt-account" class="field-select">
            <option value="">All Accounts</option>
            ${appState.accounts.map((a) => `
              <option value="${a.id}" ${filters.accountId === a.id ? 'selected' : ''}>
                ${escapeHtml(a.name)}${a.is_active ? '' : ' (inactive)'}
              </option>`).join('')}
          </select>
        </div>
        <div id="flt-category-wrap">
          <label class="field-label" for="flt-category">Category</label>
          <select id="flt-category" class="field-select">
            <option value="">All</option>
            ${appState.categories.map((c) => `
              <option value="${c.id}" ${filters.categoryId === c.id ? 'selected' : ''}>
                ${c.is_income ? '↑' : '↓'} ${escapeHtml(c.name)}${c.is_active ? '' : ' (inactive)'}
              </option>`).join('')}
          </select>
        </div>
      </div>

      <div class="mb-4">
        <p class="field-label">Transaction type</p>
        <div class="flex flex-wrap gap-x-4 gap-y-2">
          ${ALL_TYPES.map((t) => `
            <label class="flex items-center gap-1.5 text-sm cursor-pointer">
              <input type="checkbox" data-type-filter="${t}" ${filters.types.includes(t) ? 'checked' : ''} />
              ${TYPE_LABELS[t]}
            </label>`).join('')}
        </div>
      </div>

      <div class="flex flex-wrap items-end gap-3">
        <div class="flex-1 min-w-[12rem]">
          <label class="field-label" for="flt-notes">Notes search</label>
          <input id="flt-notes" class="field-input" type="search" placeholder="Filter by note text…" value="${escapeHtml(filters.notes)}" />
        </div>
        <button id="flt-reset" class="btn-ghost">Reset filters</button>
      </div>
    </section>

    <section class="card !p-0 overflow-hidden">
      <div id="log-feed"><p class="text-sm text-muted p-4">Loading ledger…</p></div>
    </section>`;

  /* ---- Wire the filter bar ---- */
  const repaintFeed = () => paintFeed(mount, appState);

  mount.querySelector('#flt-start').addEventListener('change', (e) => { filters.start = e.target.value; repaintFeed(); });
  mount.querySelector('#flt-end').addEventListener('change', (e) => { filters.end = e.target.value; repaintFeed(); });
  mount.querySelector('#flt-account').addEventListener('change', (e) => { filters.accountId = e.target.value; applyFeedFilters(mount, appState); });
  mount.querySelector('#flt-category').addEventListener('change', (e) => { filters.categoryId = e.target.value; applyFeedFilters(mount, appState); });
  mount.querySelector('#flt-notes').addEventListener('input', (e) => { filters.notes = e.target.value; applyFeedFilters(mount, appState); });
  mount.querySelectorAll('[data-type-filter]').forEach((box) =>
    box.addEventListener('change', () => {
      filters.types = [...mount.querySelectorAll('[data-type-filter]:checked')].map((b) => b.dataset.typeFilter);
      syncCategoryVisibility(mount, filters);
      applyFeedFilters(mount, appState);
    })
  );
  mount.querySelector('#flt-reset').addEventListener('click', async () => {
    state.ui.logFilters = null;
    await renderLogs(appState, mount);
  });
  mount.querySelector('#btn-add-log').addEventListener('click', () => openLogForm(null));

  syncCategoryVisibility(mount, filters);
  await repaintFeed();
}

/* The Category filter hides automatically when the Type filter excludes both
   expense and income — it can never match anything in that case. */
function syncCategoryVisibility(mount, filters) {
  const relevant = filters.types.includes('expense') || filters.types.includes('income');
  mount.querySelector('#flt-category-wrap').classList.toggle('hidden', !relevant);
}

/* ----------------------------------------------------------------------------
   Feed — date range fetched from the server; remaining filters applied
   in memory so the bar reacts instantly. All conditions combine with AND.
---------------------------------------------------------------------------- */

let fetchedLogs = [];

async function paintFeed(mount, appState) {
  const feed = mount.querySelector('#log-feed');
  const filters = getFilters();
  try {
    const { startISO, endISO } = rangeToISO(filters);
    fetchedLogs = await listLogs(startISO, endISO); // ordered by date descending
  } catch (err) {
    feed.innerHTML = `<p class="text-sm text-down p-4">Couldn't load logs: ${escapeHtml(err.message)}</p>`;
    return;
  }
  applyFeedFilters(mount, appState);
}

function applyFeedFilters(mount, appState) {
  const feed = mount.querySelector('#log-feed');
  if (!feed) return;
  const f = getFilters();
  const needle = f.notes.trim().toLowerCase();

  const rows = fetchedLogs.filter((log) => {
    if (!f.types.includes(log.type)) return false;
    if (f.accountId && log.account_id !== f.accountId && log.destination_account_id !== f.accountId) return false;
    if (f.categoryId && log.category_id !== f.categoryId) return false;
    if (needle && !(log.notes || '').toLowerCase().includes(needle)) return false;
    return true;
  });

  if (rows.length === 0) {
    feed.innerHTML = `<p class="text-sm text-muted p-4">No ledger entries match these filters.</p>`;
    return;
  }

  feed.innerHTML = rows.map((log) => logRow(log, appState)).join('');

  feed.querySelectorAll('[data-reverse]').forEach((btn) =>
    btn.addEventListener('click', () => handleReverse(btn.dataset.reverse, mount, appState))
  );
  feed.querySelectorAll('[data-edit-log]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const log = fetchedLogs.find((l) => l.id === btn.dataset.editLog);
      if (log) openLogForm(log);
    })
  );
}

/* ---- Row partial — names resolve by id, including inactive resources ---- */

function logRow(log, appState) {
  const account = appState.accounts.find((a) => a.id === log.account_id);
  const destination = appState.accounts.find((a) => a.id === log.destination_account_id);
  const category = appState.categories.find((c) => c.id === log.category_id);
  const asset = appState.assets.find((a) => a.id === log.asset_id);
  const debt = appState.debts.find((d) => d.id === log.debt_id);

  const bits = [];
  if (account) bits.push(escapeHtml(account.name) + (account.is_active ? '' : ' (inactive)'));
  if (destination) bits.push('→ ' + escapeHtml(destination.name));
  if (category) bits.push(escapeHtml(category.name));
  if (asset) bits.push(escapeHtml(asset.name));
  if (debt) bits.push(escapeHtml(debt.person_name));

  const tone = TYPE_TONE[log.type];
  const sign = tone === 'down' ? '−' : tone === 'up' ? '+' : '';
  let amountHtml = `<span class="num ${tone === 'down' ? 'text-down' : tone === 'up' ? 'text-up' : ''}">${sign}${fmtMoney(log.amount, log.currency)}</span>`;
  if (log.type === 'transfer' && destination) {
    amountHtml += `<span class="num text-xs text-muted block">→ ${fmtMoney(log.destination_amount, destination.currency)}</span>`;
  }
  if ((log.type === 'asset_buy' || log.type === 'asset_sell') && Number(log.asset_quantity_changed)) {
    amountHtml += `<span class="num text-xs text-muted block">${log.type === 'asset_buy' ? '+' : '−'}${fmtQty(log.asset_quantity_changed)} units</span>`;
  }
  if ((log.type === 'debt_add' || log.type === 'debt_payoff') && debt && !debt.is_monetary && Number(log.asset_quantity_changed)) {
    amountHtml += `<span class="num text-xs text-muted block">${log.type === 'debt_add' ? '+' : '−'}${fmtQty(log.asset_quantity_changed)} ${escapeHtml(debt.unit_name || 'units')}</span>`;
  }

  return `
    <div class="ledger-row">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge ${tone === 'up' ? 'badge-up' : tone === 'down' ? 'badge-down' : 'badge-brass'}">${TYPE_LABELS[log.type]}</span>
          <span class="text-xs text-muted num">${new Date(log.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </div>
        <p class="text-sm mt-1 truncate">${bits.join(' · ') || '<span class="text-muted">—</span>'}</p>
        ${log.notes ? `<p class="text-xs text-muted mt-0.5 truncate">${escapeHtml(log.notes)}</p>` : ''}
      </div>
      <div class="flex items-start gap-1 justify-end text-right">
        <div>${amountHtml}</div>
        <button class="btn-icon" data-edit-log="${log.id}" title="Edit (reverse &amp; re-book)">✎</button>
        <button class="btn-icon" data-reverse="${log.id}" title="Delete (reverse)">🗑</button>
      </div>
    </div>`;
}

/* ----------------------------------------------------------------------------
   Reversal & Correction Rule
   Delete → reverse_log RPC runs the exact inverse arithmetic atomically,
   then drops the row. Works even when referenced resources are inactive.
   Edit  → reverse the original, then re-book the corrected entry.
---------------------------------------------------------------------------- */

async function handleReverse(logId, mount, appState) {
  const ok = await confirmAction(
    'Delete this ledger entry? Its balance effects are reversed exactly — transfers restore the destination from the stored snapshot, never from today\'s rates.',
    'Reverse & delete',
    true
  );
  if (!ok) return;
  try {
    await reverseLog(logId);
    toast('Entry reversed and removed.', 'success');
    await refreshData();
    await renderLogs(state, mount);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ----------------------------------------------------------------------------
   Polymorphic New Log / Edit form
   Dropdown Selector Sanitization Rule: accounts/categories/assets must be
   is_active = true; debts additionally is_settled = false. Categories filter
   by is_income to match the transaction direction.
---------------------------------------------------------------------------- */

function openLogForm(editingLog) {
  const isEdit = Boolean(editingLog);
  const accounts = state.accounts.filter((a) => a.is_active);
  const assets = state.assets.filter((a) => a.is_active);
  const debts = state.debts.filter((d) => d.is_active && !d.is_settled);

  const accountOptions = (selectedId, { optional = false, excludeId = null } = {}) =>
    (optional ? `<option value="">— no cash movement —</option>` : '') +
    accounts
      .filter((a) => a.id !== excludeId)
      .map((a) => `<option value="${a.id}" data-currency="${escapeHtml(a.currency)}" data-acc-type="${a.type}" ${a.id === selectedId ? 'selected' : ''}>${escapeHtml(a.name)} (${a.type} · ${escapeHtml(a.currency)})</option>`)
      .join('');

  openModal(isEdit ? 'Edit ledger entry' : 'New ledger entry', `
    <form id="log-form" class="space-y-4">
      <div>
        <label class="field-label" for="log-type">Type</label>
        <select id="log-type" class="field-select" ${isEdit ? 'disabled' : ''}>
          ${ALL_TYPES.map((t) => `<option value="${t}" ${editingLog?.type === t ? 'selected' : ''}>${TYPE_LABELS[t]}</option>`).join('')}
        </select>
        ${isEdit ? `<p class="text-xs text-muted mt-1">Editing reverses the original entry, then books the corrected one atomically after it.</p>` : ''}
      </div>

      <div id="dyn-fields" class="space-y-4"></div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="log-date">Date</label>
          <input id="log-date" class="field-input" type="datetime-local"
            value="${isEdit ? toLocalInput(editingLog.date) : nowLocalInputValue()}" />
        </div>
        <div>
          <label class="field-label" for="log-notes">Notes</label>
          <input id="log-notes" class="field-input" placeholder="(optional)" value="${escapeHtml(editingLog?.notes || '')}" />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <button type="submit" class="btn-primary">${isEdit ? 'Reverse & re-book' : 'Book entry'}</button>
      </div>
    </form>`, (card) => {
    const typeSel = card.querySelector('#log-type');
    const dyn = card.querySelector('#dyn-fields');

    const paintFields = () => {
      const type = typeSel.value;
      dyn.innerHTML = fieldsForType(type, editingLog, { accounts, assets, debts, accountOptions });
      wireDynamicBehavior(card, type, { accounts, assets, debts });
    };

    typeSel.addEventListener('change', paintFields);
    paintFields();

    card.querySelector('#log-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = card.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const payload = collectPayload(card, typeSel.value, { accounts, assets, debts });
        if (isEdit) await reverseLog(editingLog.id); // Correction Rule: inverse first
        await dispatchRpc(typeSel.value, payload);
        toast(isEdit ? 'Entry corrected.' : 'Entry booked.', 'success');
        closeModal();
        await refreshAndRender();
      } catch (err) {
        toast(err.message, 'error');
        submitBtn.disabled = false;
      }
    });
  });
}

function toLocalInput(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/* ---- Per-type field templates ---- */

function fieldsForType(type, log, ctx) {
  const { accounts, assets, debts, accountOptions } = ctx;
  const amountField = (label, value) => `
    <div>
      <label class="field-label" for="log-amount">${label}</label>
      <input id="log-amount" class="field-input num" type="number" step="any" min="0" required value="${value ?? ''}" />
      <p id="amount-hint" class="text-xs text-muted mt-1"></p>
    </div>`;

  if (type === 'expense' || type === 'income') {
    const isIncome = type === 'income';
    // Category dropdown pre-filtered: is_income matches the direction.
    const cats = state.categories.filter((c) => c.is_active && c.is_income === isIncome);
    return `
      <div>
        <label class="field-label" for="log-account">Account</label>
        <select id="log-account" class="field-select" required>${accountOptions(log?.account_id)}</select>
      </div>
      ${amountField('Amount (account currency)', log?.amount)}
      <div>
        <label class="field-label" for="log-category">Category (${isIncome ? 'income' : 'expense'})</label>
        <select id="log-category" class="field-select">
          <option value="">— uncategorised —</option>
          ${cats.map((c) => `<option value="${c.id}" ${log?.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>`;
  }

  if (type === 'asset_buy' || type === 'asset_sell') {
    const buying = type === 'asset_buy';
    return `
      <div>
        <label class="field-label" for="log-account">${buying ? 'Funding account (cash out)' : 'Receiving account (cash in)'}</label>
        <select id="log-account" class="field-select" required>${accountOptions(log?.account_id)}</select>
      </div>
      <div>
        <label class="field-label" for="log-asset">Asset</label>
        <select id="log-asset" class="field-select" required>
          ${assets.map((a) => `<option value="${a.id}" ${log?.asset_id === a.id ? 'selected' : ''}>${escapeHtml(a.name)} (${a.is_digital ? 'digital' : 'physical'} · ${escapeHtml(a.currency)})</option>`).join('')}
        </select>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="log-qty">Quantity ${buying ? 'bought' : 'sold'}</label>
          <input id="log-qty" class="field-input num" type="number" step="any" min="0" required value="${log?.asset_quantity_changed ?? ''}" />
        </div>
        <div>
          <label class="field-label" for="log-amount">Cash ${buying ? 'paid' : 'received'}</label>
          <input id="log-amount" class="field-input num" type="number" step="any" min="0" required value="${log?.amount ?? ''}" />
          <p id="amount-hint" class="text-xs text-muted mt-1"></p>
        </div>
      </div>`;
  }

  if (type === 'debt_add' || type === 'debt_payoff') {
    const payoff = type === 'debt_payoff';
    if (debts.length === 0) {
      return `<p class="text-sm text-muted">No active, unsettled debts. New debts are created in the <a class="link-brass" href="#debts">Debts tab</a> — this form only ${payoff ? 'pays off' : 'adds to'} existing records.</p>`;
    }
    return `
      <div>
        <label class="field-label" for="log-debt">Existing debt</label>
        <select id="log-debt" class="field-select" required>
          ${debts.map((d) => `
            <option value="${d.id}" ${log?.debt_id === d.id ? 'selected' : ''}>
              ${escapeHtml(d.person_name)} · ${d.direction === 'i_owe' ? 'you owe' : 'owes you'} ·
              ${d.is_monetary ? `${escapeHtml(d.currency)}` : `${escapeHtml(d.unit_name || 'units')}`}
            </option>`).join('')}
        </select>
        <p class="text-xs text-muted mt-1">${payoff ? '' : 'Adds to an existing record — creating a brand-new debt lives in the Debts tab.'}</p>
      </div>
      <div id="debt-value-wrap"></div>
      <div>
        <label class="field-label" for="log-account">${payoff ? 'Settlement account' : 'Cash account'} ${payoff ? '' : '<span class="text-muted font-normal">(optional — if cash changes hands now)</span>'}</label>
        <select id="log-account" class="field-select" ${payoff ? 'required' : ''}>
          ${accountOptions(log?.account_id, { optional: !payoff })}
        </select>
        <p id="amount-hint" class="text-xs text-muted mt-1"></p>
      </div>`;
  }

  if (type === 'transfer') {
    return `
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="log-account">From account</label>
          <select id="log-account" class="field-select" required>${accountOptions(log?.account_id)}</select>
        </div>
        <div>
          <label class="field-label" for="log-destination">To account</label>
          <select id="log-destination" class="field-select" required>${accountOptions(log?.destination_account_id)}</select>
        </div>
      </div>
      ${amountField('Amount (source account currency)', log?.amount)}
      <p id="transfer-preview" class="text-xs text-muted"></p>`;
  }

  return '';
}

/* ---- Dynamic behavior: hints, currency previews, debt value inputs ---- */

function wireDynamicBehavior(card, type, { accounts, debts }) {
  const accountSel = card.querySelector('#log-account');
  const hint = card.querySelector('#amount-hint');

  const selectedAccount = () => accounts.find((a) => a.id === accountSel?.value);

  if (type === 'expense' || type === 'income' || type === 'asset_buy' || type === 'asset_sell') {
    const refreshHint = () => {
      const acc = selectedAccount();
      if (!acc || !hint) return;
      const verb = type === 'income' || type === 'asset_sell'
        ? (acc.type === 'wallet' ? 'adds to the wallet' : 'pays down the unpaid credit balance')
        : (acc.type === 'wallet' ? 'subtracts from the wallet' : 'increases the unpaid credit balance');
      hint.textContent = `Booked in ${acc.currency} — ${verb}.`;
    };
    accountSel?.addEventListener('change', refreshHint);
    refreshHint();
  }

  if (type === 'transfer') {
    const destSel = card.querySelector('#log-destination');
    const amountInput = card.querySelector('#log-amount');
    const preview = card.querySelector('#transfer-preview');
    const refreshPreview = () => {
      const src = selectedAccount();
      const dst = accounts.find((a) => a.id === destSel.value);
      if (!src || !dst) return;
      if (src.id === dst.id) {
        preview.textContent = 'Source and destination must differ.';
        return;
      }
      const amount = Number(amountInput.value) || 0;
      const converted = convertBetween(amount, src.currency, dst.currency);
      preview.textContent = src.currency === dst.currency
        ? `Moves ${fmtMoney(amount, src.currency)} between pockets.`
        : `Converts via cached live rates: ${fmtMoney(amount, src.currency)} → ${fmtMoney(converted, dst.currency)} (snapshot stored on the log).`;
    };
    [accountSel, destSel, amountInput].forEach((el) => {
      el.addEventListener('change', refreshPreview);
      el.addEventListener('input', refreshPreview);
    });
    refreshPreview();
  }

  if (type === 'debt_add' || type === 'debt_payoff') {
    const debtSel = card.querySelector('#log-debt');
    const valueWrap = card.querySelector('#debt-value-wrap');
    if (!debtSel) return; // empty-state (no eligible debts)

    const selectedDebt = () => debts.find((d) => d.id === debtSel.value);

    const paintValueInputs = () => {
      const debt = selectedDebt();
      if (!debt) { valueWrap.innerHTML = ''; return; }
      if (debt.is_monetary) {
        valueWrap.innerHTML = `
          <div>
            <label class="field-label" for="log-debt-value">${type === 'debt_payoff' ? 'Amount to pay' : 'Amount to add'} (${escapeHtml(debt.currency)})</label>
            <input id="log-debt-value" class="field-input num" type="number" step="any" min="0" required
              ${type === 'debt_payoff' ? `value="${debt.remaining_amount}"` : ''} />
          </div>`;
      } else {
        valueWrap.innerHTML = `
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="field-label" for="log-debt-value">${type === 'debt_payoff' ? 'Units returned' : 'Units added'} (${escapeHtml(debt.unit_name || 'units')})</label>
              <input id="log-debt-value" class="field-input num" type="number" step="any" min="0" required
                ${type === 'debt_payoff' ? `value="${debt.remaining_amount}"` : ''} />
            </div>
            <div>
              <label class="field-label" for="log-debt-cash">Cash leg (account currency)</label>
              <input id="log-debt-cash" class="field-input num" type="number" step="any" min="0" value="0" />
            </div>
          </div>`;
      }
      refreshDebtHint();
    };

    const refreshDebtHint = () => {
      const debt = selectedDebt();
      const acc = selectedAccount();
      if (!hint || !debt) return;
      if (!acc) {
        hint.textContent = debt.is_monetary
          ? `No cash movement — the entry books in the debt's currency (${debt.currency}).`
          : 'No cash movement — only commodity units change.';
        return;
      }
      if (debt.is_monetary && acc.currency !== debt.currency) {
        hint.textContent = `Cross-currency: the log books in ${acc.currency} (account currency), converted from ${debt.currency} with cached rates; the ${debt.currency} figure is snapshotted for exact reversal.`;
      } else {
        hint.textContent = `Booked in ${acc.currency}.`;
      }
    };

    debtSel.addEventListener('change', paintValueInputs);
    accountSel?.addEventListener('change', refreshDebtHint);
    paintValueInputs();
  }
}

/* ---- Collect a validated payload from the dynamic form ---- */

function collectPayload(card, type, { accounts, debts }) {
  const date = new Date(card.querySelector('#log-date').value).toISOString();
  const notes = card.querySelector('#log-notes').value.trim() || null;
  const account = accounts.find((a) => a.id === card.querySelector('#log-account')?.value) || null;

  if (type === 'expense' || type === 'income') {
    if (!account) throw new Error('Choose an account.');
    const amount = Number(card.querySelector('#log-amount').value) || 0;
    if (amount <= 0) throw new Error('Enter an amount greater than zero.');
    return {
      accountId: account.id,
      amount,
      currency: account.currency, // Currency Inheritance Rule
      categoryId: card.querySelector('#log-category').value || null,
      notes,
      date,
    };
  }

  if (type === 'asset_buy' || type === 'asset_sell') {
    if (!account) throw new Error('Choose an account.');
    const amount = Number(card.querySelector('#log-amount').value) || 0;
    const qty = Number(card.querySelector('#log-qty').value) || 0;
    if (amount <= 0 || qty <= 0) throw new Error('Enter a quantity and cash amount greater than zero.');
    return {
      accountId: account.id,
      assetId: card.querySelector('#log-asset').value,
      amount, // fiat moving through the funding account, in its currency
      currency: account.currency,
      assetQuantityChanged: qty,
      notes,
      date,
    };
  }

  if (type === 'debt_add' || type === 'debt_payoff') {
    const debt = debts.find((d) => d.id === card.querySelector('#log-debt')?.value);
    if (!debt) throw new Error('Choose a debt record.');
    const value = Number(card.querySelector('#log-debt-value').value) || 0;
    if (value <= 0) throw new Error('Enter a value greater than zero.');
    if (type === 'debt_payoff') {
      if (!account) throw new Error('Choose a settlement account.');
      if (value > Number(debt.remaining_amount) + 1e-9) throw new Error('Payoff exceeds the remaining amount.');
    }

    let amount;
    let currency;
    let assetQuantityChanged;
    if (debt.is_monetary) {
      // `value` is entered in the debt's native currency. The log inherits the
      // funding account's currency; the debt-native delta is snapshotted into
      // asset_quantity_changed whenever the two differ (exact reversals).
      if (account) {
        amount = convertBetween(value, debt.currency, account.currency);
        currency = account.currency;
        assetQuantityChanged = account.currency === debt.currency ? 0 : value;
      } else {
        amount = value;
        currency = debt.currency;
        assetQuantityChanged = 0;
      }
    } else {
      // Commodity: units ride in asset_quantity_changed; cash leg optional.
      assetQuantityChanged = value;
      amount = account ? (Number(card.querySelector('#log-debt-cash')?.value) || 0) : 0;
      currency = account ? account.currency : debt.currency;
    }

    return {
      debtId: debt.id,
      accountId: account ? account.id : null,
      amount,
      currency,
      assetQuantityChanged,
      notes,
      date,
    };
  }

  if (type === 'transfer') {
    const destination = accounts.find((a) => a.id === card.querySelector('#log-destination').value);
    if (!account || !destination) throw new Error('Choose both accounts.');
    if (account.id === destination.id) throw new Error('Source and destination must differ.');
    const amount = Number(card.querySelector('#log-amount').value) || 0;
    if (amount <= 0) throw new Error('Enter an amount greater than zero.');
    // Programmatic cross-currency conversion, persisted as a snapshot.
    const destinationAmount = convertBetween(amount, account.currency, destination.currency);
    return {
      accountId: account.id,
      destinationAccountId: destination.id,
      amount,
      currency: account.currency,
      destinationAmount,
      notes,
      date,
    };
  }

  throw new Error(`Unknown transaction type "${type}".`);
}

/* ---- Route the payload to its atomic stored procedure ---- */

function dispatchRpc(type, payload) {
  switch (type) {
    case 'expense':     return processExpenseLog(payload);
    case 'income':      return processIncomeLog(payload);
    case 'asset_buy':   return processAssetBuyLog(payload);
    case 'asset_sell':  return processAssetSellLog(payload);
    case 'debt_add':    return processDebtAddLog(payload);
    case 'debt_payoff': return processDebtPayoffLog(payload);
    case 'transfer':    return processTransferLog(payload);
    default: throw new Error(`No RPC mapped for type "${type}".`);
  }
}
