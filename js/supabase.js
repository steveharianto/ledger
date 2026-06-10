/* ============================================================================
   js/supabase.js
   Client initialization + reusable CRUD wrappers for the five direct-access
   tables (profiles, accounts, categories, assets, debts) and named RPC
   transaction wrappers for all 9 atomic stored procedures.

   NOTE — the `logs` table is NEVER mutated via direct INSERT/UPDATE from
   client code. Every write against the ledger routes exclusively through
   the RPC layer below. Reads (SELECT) are permitted and RLS-scoped.
   ========================================================================== */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ----------------------------------------------------------------------------
   CONFIG — edit these two values for your own Supabase project.
   The anon public key is a scoped, RLS-guarded public credential and is safe
   to commit in a public GitHub Pages repository.
---------------------------------------------------------------------------- */
export const CONFIG = {
  SUPABASE_URL: 'https://jvlnhkexsjflcwlgbuoc.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_kqHZHV07UOTJ_3pPT-RQRA_XpkgYqjG',
};

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* Small helper: throw on error so callers can use try/catch uniformly. */
function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

/* ============================================================================
   PROFILES
   ========================================================================== */

export async function getProfile(userId) {
  // maybeSingle → null when no row exists (first-ever login)
  return unwrap(
    await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  );
}

export async function insertProfile(profile) {
  return unwrap(
    await supabase.from('profiles').insert(profile).select().single()
  );
}

export async function updateProfile(userId, patch) {
  return unwrap(
    await supabase.from('profiles').update(patch).eq('id', userId).select().single()
  );
}

/* ============================================================================
   ACCOUNTS  (ordered by created_at ascending)
   ========================================================================== */

export async function listAccounts() {
  return unwrap(
    await supabase.from('accounts').select('*').order('created_at', { ascending: true })
  );
}

export async function insertAccount(row) {
  return unwrap(await supabase.from('accounts').insert(row).select().single());
}

export async function updateAccount(id, patch) {
  return unwrap(
    await supabase.from('accounts').update(patch).eq('id', id).select().single()
  );
}

export async function deleteAccount(id) {
  return unwrap(await supabase.from('accounts').delete().eq('id', id));
}

/* ============================================================================
   CATEGORIES  (ordered by name ascending; tree assembled in memory)
   ========================================================================== */

export async function listCategories() {
  return unwrap(
    await supabase.from('categories').select('*').order('name', { ascending: true })
  );
}

export async function insertCategory(row) {
  return unwrap(await supabase.from('categories').insert(row).select().single());
}

export async function updateCategory(id, patch) {
  return unwrap(
    await supabase.from('categories').update(patch).eq('id', id).select().single()
  );
}

export async function deleteCategory(id) {
  return unwrap(await supabase.from('categories').delete().eq('id', id));
}

/* ============================================================================
   ASSETS  (ordered by created_at ascending; grouped by is_digital in memory)
   ========================================================================== */

export async function listAssets() {
  return unwrap(
    await supabase.from('assets').select('*').order('created_at', { ascending: true })
  );
}

export async function insertAsset(row) {
  return unwrap(await supabase.from('assets').insert(row).select().single());
}

export async function updateAsset(id, patch) {
  return unwrap(
    await supabase.from('assets').update(patch).eq('id', id).select().single()
  );
}

export async function deleteAsset(id) {
  return unwrap(await supabase.from('assets').delete().eq('id', id));
}

/* ============================================================================
   DEBTS  (unsettled first, then created_at ascending)
   Inserts/amount mutations route through RPCs; direct insert is NOT exposed.
   ========================================================================== */

export async function listDebts() {
  return unwrap(
    await supabase
      .from('debts')
      .select('*')
      .order('is_settled', { ascending: true })
      .order('created_at', { ascending: true })
  );
}

export async function updateDebt(id, patch) {
  return unwrap(
    await supabase.from('debts').update(patch).eq('id', id).select().single()
  );
}

export async function deleteDebt(id) {
  return unwrap(await supabase.from('debts').delete().eq('id', id));
}

/* ============================================================================
   LOGS — READ ONLY from the client. All writes go through RPCs.
   ========================================================================== */

/**
 * Fetch ledger entries within [startISO, endISO], newest first.
 * Remaining filters (type/account/category/notes) are applied in memory by
 * the Logs component so the filter bar reacts instantly without refetching.
 */
export async function listLogs(startISO, endISO) {
  let query = supabase.from('logs').select('*').order('date', { ascending: false });
  if (startISO) query = query.gte('date', startISO);
  if (endISO) query = query.lte('date', endISO);
  return unwrap(await query);
}

/** Pre-flight existence checks used by every Data Retention Rule. */
export async function countLogsWhere(column, value) {
  const { count, error } = await supabase
    .from('logs')
    .select('id', { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function countDebtsWhere(column, value) {
  const { count, error } = await supabase
    .from('debts')
    .select('id', { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/* ============================================================================
   RPC TRANSACTION WRAPPERS — the only write path into the ledger.
   Each maps 1:1 to an atomic PostgreSQL stored procedure; if any step inside
   fails, the database engine rolls the whole operation back.
   ========================================================================== */

async function rpc(fn, args) {
  return unwrap(await supabase.rpc(fn, args));
}

/** 1. Expense — inserts log, mutates account balance. Returns new logs.id. */
export function processExpenseLog({ accountId, amount, currency, categoryId, notes, date }) {
  return rpc('process_expense_log', {
    p_account_id: accountId,
    p_amount: amount,
    p_currency: currency,
    p_category_id: categoryId,
    p_notes: notes,
    p_date: date,
  });
}

/** 2. Income — inserts log, mutates account balance. */
export function processIncomeLog({ accountId, amount, currency, categoryId, notes, date }) {
  return rpc('process_income_log', {
    p_account_id: accountId,
    p_amount: amount,
    p_currency: currency,
    p_category_id: categoryId,
    p_notes: notes,
    p_date: date,
  });
}

/** 3. Asset purchase — inserts log, increases asset quantity, debits account. */
export function processAssetBuyLog({ accountId, assetId, amount, currency, assetQuantityChanged, notes, date }) {
  return rpc('process_asset_buy_log', {
    p_account_id: accountId,
    p_asset_id: assetId,
    p_amount: amount,
    p_currency: currency,
    p_asset_quantity_changed: assetQuantityChanged,
    p_notes: notes,
    p_date: date,
  });
}

/** 4. Asset sale — inserts log, decreases asset quantity, credits account. */
export function processAssetSellLog({ accountId, assetId, amount, currency, assetQuantityChanged, notes, date }) {
  return rpc('process_asset_sell_log', {
    p_account_id: accountId,
    p_asset_id: assetId,
    p_amount: amount,
    p_currency: currency,
    p_asset_quantity_changed: assetQuantityChanged,
    p_notes: notes,
    p_date: date,
  });
}

/** 5. New debt creation — inserts debts row + initial debt_add log atomically. */
export function processDebtCreate({
  personName, direction, description, isMonetary, unitName,
  initialAmount, currency, linkedAssetId, accountId, notes, date,
}) {
  return rpc('process_debt_create', {
    p_person_name: personName,
    p_direction: direction,
    p_description: description,
    p_is_monetary: isMonetary,
    p_unit_name: unitName,
    p_initial_amount: initialAmount,
    p_currency: currency,
    p_linked_asset_id: linkedAssetId,
    p_account_id: accountId,
    p_notes: notes,
    p_date: date,
  });
}

/** 6. Add amount to an existing, unsettled debt. */
export function processDebtAddLog({ debtId, accountId, amount, currency, assetQuantityChanged, notes, date }) {
  return rpc('process_debt_add_log', {
    p_debt_id: debtId,
    p_account_id: accountId,
    p_amount: amount,
    p_currency: currency,
    p_asset_quantity_changed: assetQuantityChanged,
    p_notes: notes,
    p_date: date,
  });
}

/** 7. Debt payoff — decreases remaining_amount, settles at zero. */
export function processDebtPayoffLog({ debtId, accountId, amount, currency, assetQuantityChanged, notes, date }) {
  return rpc('process_debt_payoff_log', {
    p_debt_id: debtId,
    p_account_id: accountId,
    p_amount: amount,
    p_currency: currency,
    p_asset_quantity_changed: assetQuantityChanged,
    p_notes: notes,
    p_date: date,
  });
}

/** 8. Cross-account transfer — destination_amount is a client-computed
 *  snapshot persisted into logs.destination_amount (anti-drift). */
export function processTransferLog({ accountId, destinationAccountId, amount, currency, destinationAmount, notes, date }) {
  return rpc('process_transfer_log', {
    p_account_id: accountId,
    p_destination_account_id: destinationAccountId,
    p_amount: amount,
    p_currency: currency,
    p_destination_amount: destinationAmount,
    p_notes: notes,
    p_date: date,
  });
}

/** 9. Universal reversal — inverse arithmetic for every log type, then delete.
 *  Succeeds even when target resources are is_active = false. */
export function reverseLog(logId) {
  return rpc('reverse_log', { p_log_id: logId });
}
