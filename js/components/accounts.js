/* ============================================================================
   js/components/accounts.js
   Wallets & Credits. Cards are grouped by accounts.type, show native + base
   converted amounts, compute the credit "limit left" and the auto monthly
   interest estimate, and enforce the Data Retention Rule on delete.
   ========================================================================== */

import {
  insertAccount,
  updateAccount,
  deleteAccount,
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
} from '../app.js';
import { CURRENCIES, convertToBase, getBaseCurrency, fmtMoney } from '../currency.js';

export function renderAccounts(appState, mount) {
  const base = getBaseCurrency();
  const wallets = appState.accounts.filter((a) => a.type === 'wallet' && a.is_active);
  const credits = appState.accounts.filter((a) => a.type === 'credit' && a.is_active);
  const inactive = appState.accounts.filter((a) => !a.is_active);

  mount.innerHTML = `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="eyebrow mb-1">Accounts</p>
        <h2 class="font-display text-3xl font-medium">Wallets &amp; credits</h2>
      </div>
      <button id="btn-add-account" class="btn-primary">New account</button>
    </header>

    <section class="mb-8">
      <div class="section-head"><h3>Wallets</h3><span class="count">${wallets.length}</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${wallets.length ? wallets.map((a) => walletCard(a, base)).join('') : `<p class="text-sm text-muted">No wallets yet.</p>`}
      </div>
    </section>

    <section class="mb-8">
      <div class="section-head"><h3>Credits</h3><span class="count">${credits.length}</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${credits.length ? credits.map((a) => creditCard(a, base)).join('') : `<p class="text-sm text-muted">No credit lines yet.</p>`}
      </div>
    </section>

    ${inactive.length ? `
    <section>
      <div class="section-head"><h3>Inactive</h3><span class="count">${inactive.length} retained for history</span></div>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        ${inactive.map((a) => inactiveCard(a)).join('')}
      </div>
    </section>` : ''}`;

  mount.querySelector('#btn-add-account').addEventListener('click', () => openAccountForm(null));
  mount.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openAccountForm(state.accounts.find((a) => a.id === btn.dataset.edit)))
  );
  mount.querySelectorAll('[data-adjust]').forEach((btn) =>
    btn.addEventListener('click', () => openAdjustForm(state.accounts.find((a) => a.id === btn.dataset.adjust)))
  );
  mount.querySelectorAll('[data-delete]').forEach((btn) =>
    btn.addEventListener('click', () => handleDelete(btn.dataset.delete))
  );
  mount.querySelectorAll('[data-revive]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await updateAccount(btn.dataset.revive, { is_active: true });
      toast('Account revived.', 'success');
      await refreshAndRender();
    })
  );
}

/* ----------------------------------------------------------------------------
   Cards
---------------------------------------------------------------------------- */

function convertedBadge(amount, currency, base) {
  if (currency === base) return '';
  return `<span class="badge mt-1">≈ ${fmtMoney(convertToBase(amount, currency, base), base)}</span>`;
}

function cardActions(account) {
  return `
    <div class="flex gap-1">
      <button class="btn-icon" data-adjust="${account.id}" title="Adjust balance">±</button>
      <button class="btn-icon" data-edit="${account.id}" title="Edit">✎</button>
      <button class="btn-icon" data-delete="${account.id}" title="Delete">🗑</button>
    </div>`;
}

function walletCard(account, base) {
  return `
    <article class="card">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm font-semibold truncate">${escapeHtml(account.name)}</p>
          <span class="badge badge-up mt-1">Wallet · ${escapeHtml(account.currency)}</span>
        </div>
        ${cardActions(account)}
      </div>
      <p class="num text-xl mt-4">${fmtMoney(account.balance, account.currency)}</p>
      ${convertedBadge(account.balance, account.currency, base)}
    </article>`;
}

function creditCard(account, base) {
  const limit = Number(account.credit_limit) || 0;
  const used = Number(account.balance) || 0;
  const left = limit - used; // Limit Left = credit_limit − balance
  const autoInterest = !account.is_interest_manual;
  // monthly_interest_estimate = balance × (interest_rate / 100) / 12 — display only
  const estInterest = (used * ((Number(account.interest_rate) || 0) / 100)) / 12;

  return `
    <article class="card">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm font-semibold truncate">${escapeHtml(account.name)}</p>
          <span class="badge badge-down mt-1">Credit · ${escapeHtml(account.currency)}</span>
        </div>
        ${cardActions(account)}
      </div>
      <div class="mt-4 space-y-1.5 text-sm">
        <div class="flex justify-between"><span class="text-muted">Limit</span><span class="num">${fmtMoney(limit, account.currency)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Limit used (unpaid)</span><span class="num text-down">${fmtMoney(used, account.currency)}</span></div>
        <div class="flex justify-between"><span class="text-muted">Limit left</span><span class="num text-up">${fmtMoney(left, account.currency)}</span></div>
        ${autoInterest
          ? `<div class="flex justify-between"><span class="text-muted">Est. monthly interest</span><span class="num">${fmtMoney(estInterest, account.currency)}</span></div>`
          : `<div class="flex justify-between"><span class="text-muted">Interest</span><span class="text-xs text-muted">manual mode</span></div>`}
      </div>
      ${convertedBadge(used, account.currency, base)}
    </article>`;
}

function inactiveCard(account) {
  return `
    <article class="card card-inactive">
      <p class="text-sm font-semibold truncate">${escapeHtml(account.name)}</p>
      <p class="text-xs text-muted mt-1">${account.type === 'wallet' ? 'Wallet' : 'Credit'} · ${escapeHtml(account.currency)} · kept for ledger history</p>
      <button class="btn-ghost mt-3" data-revive="${account.id}">Revive</button>
    </article>`;
}

/* ----------------------------------------------------------------------------
   Create / edit form
---------------------------------------------------------------------------- */

function openAccountForm(existing) {
  const isEdit = Boolean(existing);
  const acc = existing || {
    name: '', type: 'wallet', balance: 0, credit_limit: 0,
    interest_rate: 0, is_interest_manual: false, currency: getBaseCurrency(),
  };

  openModal(isEdit ? 'Edit account' : 'New account', `
    <form id="account-form" class="space-y-4">
      <div>
        <label class="field-label" for="acc-name">Name</label>
        <input id="acc-name" class="field-input" required value="${escapeHtml(acc.name)}" placeholder="e.g. BCA Checking" />
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="field-label" for="acc-type">Type</label>
          <select id="acc-type" class="field-select" ${isEdit ? 'disabled' : ''}>
            <option value="wallet" ${acc.type === 'wallet' ? 'selected' : ''}>Wallet</option>
            <option value="credit" ${acc.type === 'credit' ? 'selected' : ''}>Credit</option>
          </select>
        </div>
        <div>
          <label class="field-label" for="acc-currency">Currency</label>
          <select id="acc-currency" class="field-select">
            ${CURRENCIES.map((c) => `<option value="${c}" ${c === acc.currency ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div>
        <label class="field-label" for="acc-balance">${acc.type === 'credit' ? 'Unpaid balance' : 'Balance'}</label>
        <input id="acc-balance" class="field-input num" type="number" step="any" value="${acc.balance ?? 0}" />
      </div>
      <div id="credit-fields" class="${acc.type === 'credit' ? '' : 'hidden'} space-y-4">
        <div>
          <label class="field-label" for="acc-limit">Credit limit</label>
          <input id="acc-limit" class="field-input num" type="number" step="any" min="0" value="${acc.credit_limit ?? 0}" />
        </div>
        <div class="grid grid-cols-2 gap-3 items-end">
          <div>
            <label class="field-label" for="acc-rate">Interest rate (% APR)</label>
            <input id="acc-rate" class="field-input num" type="number" step="any" min="0" value="${acc.interest_rate ?? 0}" />
          </div>
          <label class="flex items-center gap-2 text-sm pb-2 cursor-pointer">
            <input id="acc-manual-interest" type="checkbox" ${acc.is_interest_manual ? 'checked' : ''} />
            Manual interest
          </label>
        </div>
        <p class="text-xs text-muted">Auto mode shows an estimated monthly interest figure on the card; it never changes stored balances.</p>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" class="btn-ghost" data-modal-close-2>Cancel</button>
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Create account'}</button>
      </div>
    </form>`, (card) => {
    const typeSel = card.querySelector('#acc-type');
    typeSel.addEventListener('change', () => {
      card.querySelector('#credit-fields').classList.toggle('hidden', typeSel.value !== 'credit');
      card.querySelector('label[for="acc-balance"]').textContent =
        typeSel.value === 'credit' ? 'Unpaid balance' : 'Balance';
    });
    card.querySelector('[data-modal-close-2]').addEventListener('click', closeModal);

    card.querySelector('#account-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const row = {
        name: card.querySelector('#acc-name').value.trim(),
        type: isEdit ? acc.type : typeSel.value,
        currency: card.querySelector('#acc-currency').value,
        balance: Number(card.querySelector('#acc-balance').value) || 0,
        credit_limit: Number(card.querySelector('#acc-limit').value) || 0,
        interest_rate: Number(card.querySelector('#acc-rate').value) || 0,
        is_interest_manual: card.querySelector('#acc-manual-interest').checked,
      };
      try {
        if (isEdit) {
          await updateAccount(acc.id, row);
          toast('Account updated.', 'success');
        } else {
          await insertAccount({ ...row, user_id: state.user.id, is_active: true });
          toast('Account created.', 'success');
        }
        closeModal();
        await refreshAndRender();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* Quick manual balance adjustment (does not touch the ledger). */
function openAdjustForm(account) {
  openModal(`Adjust — ${account.name}`, `
    <form id="adjust-form" class="space-y-4">
      <div>
        <label class="field-label" for="adj-balance">New ${account.type === 'credit' ? 'unpaid balance' : 'balance'} (${escapeHtml(account.currency)})</label>
        <input id="adj-balance" class="field-input num" type="number" step="any" value="${account.balance}" />
      </div>
      <p class="text-xs text-muted">Manual adjustments set the stored balance directly without writing a ledger entry. Use a Log when the change belongs in your history.</p>
      <div class="flex justify-end gap-2">
        <button type="submit" class="btn-primary">Save balance</button>
      </div>
    </form>`, (card) => {
    card.querySelector('#adjust-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await updateAccount(account.id, { balance: Number(card.querySelector('#adj-balance').value) || 0 });
        toast('Balance adjusted.', 'success');
        closeModal();
        await refreshAndRender();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

/* ----------------------------------------------------------------------------
   Data Retention Rule — pre-flight check against logs before any delete
---------------------------------------------------------------------------- */

async function handleDelete(accountId) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return;

  const ok = await confirmAction(
    `Delete "${account.name}"? If ledger entries reference it, it will be deactivated instead so history stays intact.`,
    'Delete account',
    true
  );
  if (!ok) return;

  try {
    const [asSource, asDestination] = await Promise.all([
      countLogsWhere('account_id', accountId),
      countLogsWhere('destination_account_id', accountId),
    ]);

    if (asSource + asDestination > 0) {
      await updateAccount(accountId, { is_active: false });
      toast('Account has history — deactivated instead of deleted.', 'success');
    } else {
      await deleteAccount(accountId);
      toast('Account deleted.', 'success');
    }
    await refreshAndRender();
  } catch (err) {
    toast(err.message, 'error');
  }
}
