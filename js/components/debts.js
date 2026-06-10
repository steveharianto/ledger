/* ============================================================================
   js/components/debts.js
   Dual-direction debt tracker (i_owe / they_owe) supporting monetary and
   commodity records. Creation routes through the process_debt_create RPC;
   payoffs through process_debt_payoff_log. Commodity records render their
   unit_name everywhere and value themselves live via the linked asset.
   ========================================================================== */

import {
  processDebtCreate,
  processDebtPayoffLog,
  updateDebt,
  deleteDebt,
  countLogsWhere,
} from '../supabase.js';
import {
  state,
  refreshAndRender,
  openModal,
  closeModal,
  confirmAction,
  toast,
  escapeHtml,
  nowLocalInputValue,
} from '../app.js';
import {
  CURRENCIES,
  convertToBase,
  convertBetween,
  getBaseCurrency,
  fmtMoney,
  fmtQty,
} from '../currency.js';

export function renderDebts(appState, mount) {
  const base = getBaseCurrency();
  const open = appState.debts.filter((d) => d.is_active && !d.is_settled);
  const settled = appState.debts.filter((d) => d.is_active && d.is_settled);
  const inactive = appState.debts.filter((d) => !d.is_active);

  mount.innerHTML = `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="eyebrow mb-1">Debts</p>
        <h2 class="font-display text-3xl font-medium">Who owes who</h2>
      </div>
      <button id="btn-new-debt" class="btn-primary">New debt</button>
    </header>

    <section class="mb-8">
      <div class="section-head"><h3>Open</h3><span class="count">${open.length} unsettled</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        ${open.length ? open.map((d) => debtCard(d, appState, base, true)).join('') : `<p class="text-sm text-muted">No open debts — nobody owes anybody.</p>`}
      </div>
    </section>

    ${settled.length ? `
    <section class="mb-8">
      <div class="section-head"><h3>Settled</h3><span class="count">${settled.length}</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        ${settled.map((d) => debtCard(d, appState, base, false)).join('')}
      </div>
    </section>` : ''}

    ${inactive.length ? `
    <section>
      <div class="section-head"><h3>Inactive</h3><span class="count">${inactive.length} retained for history</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        ${inactive.map((d) => `
          <article class="card card-inactive">
            <p class="text-sm font-semibold">${escapeHtml(d.person_name)}</p>
            <p class="text-xs text-muted mt-1">kept because ledger entries reference it</p>
            <button class="btn-ghost mt-3" data-revive-debt="${d.id}">Revive</button>
          </article>`).join('')}
      </div>
    </section>` : ''}`;

  mount.querySelector('#btn-new-debt').addEventListener('click', openNewDebtForm);
  mount.querySelectorAll('[data-payoff]').forEach((btn) =>
    btn.addEventListener('click', () => openPayoffForm(state.debts.find((d) => d.id === btn.dataset.payoff)))
  );
  mount.querySelectorAll('[data-delete-debt]').forEach((btn) =>
    btn.addEventListener('click', () => handleDelete(btn.dataset.deleteDebt))
  );
  mount.querySelectorAll('[data-revive-debt]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await updateDebt(btn.dataset.reviveDebt, { is_active: true });
      toast('Debt record revived.', 'success');
      await refreshAndRender();
    })
  );
}

/* ----------------------------------------------------------------------------
   Card
---------------------------------------------------------------------------- */

function debtCard(debt, appState, base, actionable) {
  const theyOwe = debt.direction === 'they_owe';
  const linked = appState.assets.find((a) => a.id === debt.linked_asset_id);

  let remainingLine;
  let totalLine;
  if (debt.is_monetary) {
    remainingLine = `${fmtMoney(debt.remaining_amount, debt.currency)} <span class="badge ml-1">≈ ${fmtMoney(convertToBase(debt.remaining_amount, debt.currency, base), base)}</span>`;
    totalLine = fmtMoney(debt.total_amount, debt.currency);
  } else {
    const unit = escapeHtml(debt.unit_name || 'units');
    remainingLine = `${fmtQty(debt.remaining_amount)} ${unit}`;
    if (linked) {
      const liveValue = (Number(debt.remaining_amount) || 0) * (Number(linked.current_unit_price) || 0);
      remainingLine += ` <span class="badge ml-1">≈ ${fmtMoney(convertToBase(liveValue, linked.currency, base), base)}</span>`;
    }
    totalLine = `${fmtQty(debt.total_amount)} ${unit}`;
  }

  return `
    <article class="card ${debt.is_settled ? 'opacity-60' : ''}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm font-semibold truncate">${escapeHtml(debt.person_name)}</p>
          <span class="badge ${theyOwe ? 'badge-up' : 'badge-down'} mt-1">${theyOwe ? '← Owes you' : '→ You owe'}</span>
          <span class="badge mt-1 ml-1">${debt.is_monetary ? `Monetary · ${escapeHtml(debt.currency)}` : `Commodity · ${escapeHtml(debt.unit_name || 'units')}`}</span>
          ${linked ? `<span class="badge badge-brass mt-1 ml-1">linked: ${escapeHtml(linked.name)}</span>` : ''}
        </div>
        ${actionable ? `<button class="btn-icon" data-delete-debt="${debt.id}" title="Delete">🗑</button>` : ''}
      </div>
      ${debt.description ? `<p class="text-xs text-muted mt-2">${escapeHtml(debt.description)}</p>` : ''}
      <div class="mt-4 space-y-1.5 text-sm">
        <div class="flex justify-between"><span class="text-muted">Original</span><span class="num">${totalLine}</span></div>
        <div class="flex justify-between"><span class="text-muted">Remaining</span><span class="num font-medium">${remainingLine}</span></div>
      </div>
      ${actionable
        ? `<button class="btn-ghost w-full mt-4" data-payoff="${debt.id}">Pay off…</button>`
        : debt.is_settled ? `<p class="text-xs text-up mt-4">Fully settled ✓</p>` : ''}
    </article>`;
}

/* ----------------------------------------------------------------------------
   New Debt form  →  process_debt_create RPC (atomic: debts row + initial
   debt_add log + optional account mutation)
---------------------------------------------------------------------------- */

function openNewDebtForm() {
  const activeAssets = state.assets.filter((a) => a.is_active);
  const activeAccounts = state.accounts.filter((a) => a.is_active);

  openModal('New debt', `
    <form id="debt-form" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="dbt-person">Person</label>
          <input id="dbt-person" class="field-input" required placeholder="e.g. Rina" />
        </div>
        <div>
          <label class="field-label" for="dbt-direction">Direction</label>
          <select id="dbt-direction" class="field-select">
            <option value="they_owe">They owe me</option>
            <option value="i_owe">I owe them</option>
          </select>
        </div>
      </div>
      <div>
        <label class="field-label" for="dbt-desc">Description <span class="text-muted font-normal">(optional)</span></label>
        <input id="dbt-desc" class="field-input" placeholder="What is this debt for?" />
      </div>

      <label class="flex items-center gap-2 text-sm cursor-pointer">
        <input id="dbt-monetary" type="checkbox" checked />
        Monetary debt (uncheck for commodity, e.g. gold)
      </label>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="dbt-amount"><span id="dbt-amount-label">Amount</span></label>
          <input id="dbt-amount" class="field-input num" type="number" step="any" min="0" required />
        </div>
        <div>
          <label class="field-label" for="dbt-currency">Currency</label>
          <select id="dbt-currency" class="field-select">
            ${CURRENCIES.map((c) => `<option value="${c}" ${c === getBaseCurrency() ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>

      <div id="commodity-fields" class="hidden space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="field-label" for="dbt-unit">Unit name</label>
            <input id="dbt-unit" class="field-input" placeholder="grams · oz · units" />
          </div>
          <div>
            <label class="field-label" for="dbt-linked">Linked asset <span class="text-muted font-normal">(optional)</span></label>
            <select id="dbt-linked" class="field-select">
              <option value="">— none —</option>
              ${activeAssets.map((a) => `<option value="${a.id}" data-currency="${escapeHtml(a.currency)}">${escapeHtml(a.name)} (${escapeHtml(a.currency)})</option>`).join('')}
            </select>
          </div>
        </div>
        <p class="text-xs text-muted">Linking an asset locks the debt's currency to the asset's currency and values the remaining units at its live unit price.</p>
      </div>

      <div id="cash-leg" >
        <label class="field-label" for="dbt-account">Cash account <span class="text-muted font-normal">(optional — if money changes hands now)</span></label>
        <select id="dbt-account" class="field-select"><option value="">— no cash movement —</option></select>
        <p class="text-xs text-muted mt-1">Only accounts in the debt's currency are listed, so the booked log inherits a single consistent currency.</p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="dbt-date">Date</label>
          <input id="dbt-date" class="field-input" type="datetime-local" value="${nowLocalInputValue()}" />
        </div>
        <div>
          <label class="field-label" for="dbt-notes">Notes</label>
          <input id="dbt-notes" class="field-input" placeholder="(optional)" />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <button type="submit" class="btn-primary">Create debt</button>
      </div>
    </form>`, (card) => {
    const monetaryToggle = card.querySelector('#dbt-monetary');
    const currencySel = card.querySelector('#dbt-currency');
    const linkedSel = card.querySelector('#dbt-linked');
    const accountSel = card.querySelector('#dbt-account');
    const cashLeg = card.querySelector('#cash-leg');

    const refreshAccountOptions = () => {
      const debtCurrency = currencySel.value;
      const matching = activeAccounts.filter((a) => a.currency === debtCurrency);
      accountSel.innerHTML =
        `<option value="">— no cash movement —</option>` +
        matching.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${a.type})</option>`).join('');
    };

    const refreshMode = () => {
      const monetary = monetaryToggle.checked;
      card.querySelector('#commodity-fields').classList.toggle('hidden', monetary);
      card.querySelector('#dbt-amount-label').textContent = monetary ? 'Amount' : 'Quantity (commodity units)';
      // Cash-at-creation is only expressible for monetary debts (the RPC's
      // initial amount doubles as the cash amount). Commodity cash legs are
      // logged separately via debt_add in the Logs tab.
      cashLeg.classList.toggle('hidden', !monetary);
      if (!monetary) accountSel.value = '';
      refreshAccountOptions();
    };

    // Commodity Currency Rule — debts.currency mirrors the linked asset.
    linkedSel.addEventListener('change', () => {
      const opt = linkedSel.selectedOptions[0];
      const assetCurrency = opt?.dataset?.currency;
      if (assetCurrency) {
        currencySel.value = assetCurrency;
        currencySel.disabled = true;
      } else {
        currencySel.disabled = false;
      }
      refreshAccountOptions();
    });
    currencySel.addEventListener('change', refreshAccountOptions);
    monetaryToggle.addEventListener('change', refreshMode);
    refreshMode();

    card.querySelector('#debt-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const isMonetary = monetaryToggle.checked;
      const amount = Number(card.querySelector('#dbt-amount').value) || 0;
      if (amount <= 0) { toast('Enter an amount greater than zero.', 'error'); return; }

      try {
        await processDebtCreate({
          personName: card.querySelector('#dbt-person').value.trim(),
          direction: card.querySelector('#dbt-direction').value,
          description: card.querySelector('#dbt-desc').value.trim() || null,
          isMonetary,
          unitName: isMonetary ? null : (card.querySelector('#dbt-unit').value.trim() || 'units'),
          initialAmount: amount,
          currency: currencySel.value,
          linkedAssetId: isMonetary ? null : (linkedSel.value || null),
          accountId: isMonetary ? (accountSel.value || null) : null,
          notes: card.querySelector('#dbt-notes').value.trim() || null,
          date: new Date(card.querySelector('#dbt-date').value).toISOString(),
        });
        toast('Debt created and booked to the ledger.', 'success');
        closeModal();
        await refreshAndRender();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ----------------------------------------------------------------------------
   Pay Off subsystem  →  process_debt_payoff_log RPC
---------------------------------------------------------------------------- */

function openPayoffForm(debt) {
  const activeAccounts = state.accounts.filter((a) => a.is_active);
  const unit = debt.unit_name || 'units';

  openModal(`Pay off — ${debt.person_name}`, `
    <form id="payoff-form" class="space-y-4">
      <p class="text-sm text-muted">
        Remaining: <span class="num text-paper">${debt.is_monetary
          ? fmtMoney(debt.remaining_amount, debt.currency)
          : `${fmtQty(debt.remaining_amount)} ${escapeHtml(unit)}`}</span>
        · ${debt.direction === 'i_owe' ? 'you are paying them back' : 'they are paying you back'}
      </p>

      <div>
        <label class="field-label" for="po-amount">
          ${debt.is_monetary ? `Amount to pay (${escapeHtml(debt.currency)})` : `Units to return (${escapeHtml(unit)})`}
        </label>
        <input id="po-amount" class="field-input num" type="number" step="any" min="0" required value="${debt.remaining_amount}" />
        <button type="button" id="po-full" class="link-brass text-xs mt-1">Pay the full remaining amount</button>
      </div>

      ${debt.is_monetary ? '' : `
      <div>
        <label class="field-label" for="po-cash">Cash changing hands <span class="text-muted font-normal">(account currency; 0 for an in-kind return)</span></label>
        <input id="po-cash" class="field-input num" type="number" step="any" min="0" value="0" />
      </div>`}

      <div>
        <label class="field-label" for="po-account">${debt.direction === 'i_owe' ? 'Pay from account' : 'Receive into account'}</label>
        <select id="po-account" class="field-select" required>
          ${activeAccounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} (${a.type} · ${escapeHtml(a.currency)})</option>`).join('')}
        </select>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="po-date">Date</label>
          <input id="po-date" class="field-input" type="datetime-local" value="${nowLocalInputValue()}" />
        </div>
        <div>
          <label class="field-label" for="po-notes">Notes</label>
          <input id="po-notes" class="field-input" placeholder="(optional)" />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-2">
        <button type="submit" class="btn-primary">Record payoff</button>
      </div>
    </form>`, (card) => {
    card.querySelector('#po-full').addEventListener('click', () => {
      card.querySelector('#po-amount').value = debt.remaining_amount;
    });

    card.querySelector('#payoff-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const slice = Number(card.querySelector('#po-amount').value) || 0;
      if (slice <= 0) { toast('Enter a payoff amount greater than zero.', 'error'); return; }
      if (slice > Number(debt.remaining_amount) + 1e-9) {
        toast('Payoff exceeds the remaining amount.', 'error');
        return;
      }

      const account = state.accounts.find((a) => a.id === card.querySelector('#po-account').value);
      if (!account) { toast('Choose an account.', 'error'); return; }

      let amount;                 // fiat moving through the account, in its currency
      let assetQuantityChanged;   // commodity units OR debt-native fiat carrier
      if (debt.is_monetary) {
        // Currency Inheritance Rule: the log books in the account's currency;
        // any mismatch with the debt's native currency is resolved here with
        // cached rates. The debt-native amount rides in asset_quantity_changed
        // so the RPC (and later reversals) never re-derive it from live rates.
        amount = convertBetween(slice, debt.currency, account.currency);
        assetQuantityChanged = account.currency === debt.currency ? 0 : slice;
      } else {
        amount = Number(card.querySelector('#po-cash').value) || 0;
        assetQuantityChanged = slice;
      }

      try {
        await processDebtPayoffLog({
          debtId: debt.id,
          accountId: account.id,
          amount,
          currency: account.currency,
          assetQuantityChanged,
          notes: card.querySelector('#po-notes').value.trim() || null,
          date: new Date(card.querySelector('#po-date').value).toISOString(),
        });
        toast('Payoff recorded.', 'success');
        closeModal();
        await refreshAndRender();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ----------------------------------------------------------------------------
   Data Retention Rule — verify against logs before deleting
---------------------------------------------------------------------------- */

async function handleDelete(debtId) {
  const debt = state.debts.find((d) => d.id === debtId);
  if (!debt) return;

  const ok = await confirmAction(
    `Delete the debt with "${debt.person_name}"? If payoff or addition logs exist, the record is deactivated to keep the ledger intact.`,
    'Delete debt',
    true
  );
  if (!ok) return;

  try {
    const refs = await countLogsWhere('debt_id', debtId);
    if (refs > 0) {
      await updateDebt(debtId, { is_active: false });
      toast('Debt has ledger history — deactivated instead of deleted.', 'success');
    } else {
      await deleteDebt(debtId);
      toast('Debt deleted.', 'success');
    }
    await refreshAndRender();
  } catch (err) {
    toast(err.message, 'error');
  }
}
