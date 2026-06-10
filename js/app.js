/* ============================================================================
   js/app.js
   Central orchestrator — authentication state, profile load/create rule,
   client-side hash routing, the global state container, and shared UI
   helpers (modal, confirm, toast, escaping) used by every component.
   ========================================================================== */

import {
  supabase,
  getProfile,
  insertProfile,
  listAccounts,
  listCategories,
  listAssets,
  listDebts,
} from './supabase.js';
import { loadRates, hydrateBaseCurrency } from './currency.js';

import { renderDashboard } from './components/dashboard.js';
import { renderAccounts } from './components/accounts.js';
import { renderCategories } from './components/categories.js';
import { renderAssets } from './components/assets.js';
import { renderDebts } from './components/debts.js';
import { renderLogs } from './components/logs.js';

/* ============================================================================
   GLOBAL STATE CONTAINER
   ========================================================================== */

export const state = {
  user: null,
  profile: null,
  accounts: [],
  categories: [],
  assets: [],
  debts: [],
  route: 'dashboard',
  /** Set by logs.js when the user edits a ledger entry (reverse + re-apply). */
  editingLog: null,
  /** Per-view scratch (e.g. logs filter values survive re-renders). */
  ui: {},
};

const ROUTES = {
  dashboard: renderDashboard,
  accounts: renderAccounts,
  categories: renderCategories,
  assets: renderAssets,
  debts: renderDebts,
  logs: renderLogs,
};

/* ============================================================================
   DATA LOADING
   ========================================================================== */

/** Reload the four resource tables in parallel into global state. */
export async function refreshData() {
  const [accounts, categories, assets, debts] = await Promise.all([
    listAccounts(),
    listCategories(),
    listAssets(),
    listDebts(),
  ]);
  state.accounts = accounts;
  state.categories = categories;
  state.assets = assets;
  state.debts = debts;
}

/** Refresh data then repaint the current view — the standard post-write call. */
export async function refreshAndRender() {
  await refreshData();
  await rerender();
}

/* ============================================================================
   ROUTING
   ========================================================================== */

export function navigate(route) {
  if (location.hash !== `#${route}`) {
    location.hash = `#${route}`; // hashchange listener performs the render
  } else {
    handleRouteChange();
  }
}

function currentRouteFromHash() {
  const hash = (location.hash || '#dashboard').replace('#', '');
  return ROUTES[hash] ? hash : 'dashboard';
}

async function handleRouteChange() {
  if (!state.user) return;
  state.route = currentRouteFromHash();
  highlightNav();
  await rerender();
}

function highlightNav() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === state.route);
  });
}

/** Repaint the active view into #view-content. */
export async function rerender() {
  const mount = document.getElementById('view-content');
  mount.innerHTML = '';
  const render = ROUTES[state.route] || renderDashboard;
  await render(state, mount);
  // keep view scrolled to top on tab switches
  mount.closest('main')?.scrollTo?.(0, 0);
}

/* ============================================================================
   AUTHENTICATION LAYER
   ========================================================================== */

let signupMode = false;
let appBooted = false; // guards against INITIAL_SESSION + SIGNED_IN double-fire

function showAuth() {
  document.getElementById('auth-overlay').classList.remove('hidden');
  document.getElementById('auth-overlay').classList.add('flex');
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('md:flex');
}

function showApp() {
  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('auth-overlay').classList.remove('flex');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('md:flex');
}

/**
 * Profile Initialization Rule — query profiles for auth.uid() first; only
 * insert defaults when no row exists, so refreshes never clobber settings.
 */
async function ensureProfile(user) {
  let profile = await getProfile(user.id);
  if (!profile) {
    profile = await insertProfile({
      id: user.id,
      display_name: (user.email || 'user').split('@')[0],
      preferred_base_currency: 'IDR',
    });
  }
  return profile;
}

async function enterApp(user) {
  if (appBooted && state.user?.id === user.id) return;
  appBooted = true;
  state.user = user;

  showApp();
  const mount = document.getElementById('view-content');
  mount.innerHTML = `<p class="text-muted text-sm">Opening your books…</p>`;

  try {
    // 1. Profile (load-or-create), 2. live FX rates, 3. resource tables.
    state.profile = await ensureProfile(user);
    hydrateBaseCurrency(state.profile.preferred_base_currency);
    document.getElementById('sidebar-user').textContent =
      state.profile.display_name || user.email;

    await loadRates();
    await refreshData();

    state.route = currentRouteFromHash();
    highlightNav();
    await rerender();
  } catch (err) {
    console.error(err);
    mount.innerHTML = `<div class="card"><p class="text-down text-sm">Couldn't load your data: ${escapeHtml(err.message)}</p>
      <button class="btn-ghost mt-3" onclick="location.reload()">Retry</button></div>`;
  }
}

function leaveApp() {
  appBooted = false;
  state.user = null;
  state.profile = null;
  state.accounts = [];
  state.categories = [];
  state.assets = [];
  state.debts = [];
  state.editingLog = null;
  state.ui = {};
  showAuth();
}

function bindAuthUI() {
  const form = document.getElementById('auth-form');
  const toggle = document.getElementById('auth-toggle');
  const errorEl = document.getElementById('auth-error');

  toggle.addEventListener('click', () => {
    signupMode = !signupMode;
    document.getElementById('auth-subtitle').textContent = signupMode
      ? 'Create an account to start your ledger.'
      : 'Sign in to open your books.';
    document.getElementById('auth-submit').textContent = signupMode ? 'Create account' : 'Sign in';
    document.getElementById('auth-toggle-label').textContent = signupMode
      ? 'Already have an account?'
      : 'New here?';
    toggle.textContent = signupMode ? 'Sign in instead' : 'Create an account';
    errorEl.classList.add('hidden');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.classList.add('hidden');
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const submit = document.getElementById('auth-submit');
    submit.disabled = true;

    try {
      if (signupMode) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session === null) {
          toast('Account created — check your email to confirm, then sign in.', 'success');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });

  document.getElementById('btn-signout').addEventListener('click', async () => {
    await supabase.auth.signOut();
  });
}

/* ============================================================================
   SHARED UI HELPERS
   ========================================================================== */

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** datetime-local value for "now", used as the default log timestamp. */
export function nowLocalInputValue() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** First / last day of the current calendar month as yyyy-mm-dd. */
export function currentMonthRange() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const end = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
  return { start, end };
}

/* ---------- Modal ---------- */

let modalCleanup = null;

/**
 * Open the shared modal. `bodyHtml` is injected into the card; `onMount`
 * receives the card element to wire events. Returns the card element.
 */
export function openModal(title, bodyHtml, onMount) {
  const root = document.getElementById('modal-root');
  const card = document.getElementById('modal-card');
  card.innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <h3 class="font-display text-xl font-medium">${escapeHtml(title)}</h3>
      <button type="button" class="btn-icon" data-modal-close aria-label="Close">✕</button>
    </div>
    ${bodyHtml}`;
  root.classList.remove('hidden');
  root.classList.add('flex');

  const close = () => closeModal();
  card.querySelector('[data-modal-close]').addEventListener('click', close);
  const backdropHandler = (e) => { if (e.target === root) close(); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  root.addEventListener('click', backdropHandler);
  document.addEventListener('keydown', escHandler);
  modalCleanup = () => {
    root.removeEventListener('click', backdropHandler);
    document.removeEventListener('keydown', escHandler);
  };

  if (onMount) onMount(card);
  return card;
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.add('hidden');
  root.classList.remove('flex');
  document.getElementById('modal-card').innerHTML = '';
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}

/** Promise-based confirm dialog styled to match the app. */
export function confirmAction(message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    openModal('Are you sure?', `
      <p class="text-sm text-muted mb-5">${escapeHtml(message)}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn-ghost" data-cancel>Cancel</button>
        <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(confirmLabel)}</button>
      </div>`, (card) => {
      card.querySelector('[data-cancel]').addEventListener('click', () => { closeModal(); resolve(false); });
      card.querySelector('[data-ok]').addEventListener('click', () => { closeModal(); resolve(true); });
    });
  });
}

/* ---------- Toast ---------- */

export function toast(message, kind = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'toast-error' : kind === 'success' ? 'toast-success' : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ============================================================================
   BOOT
   ========================================================================== */

bindAuthUI();
window.addEventListener('hashchange', handleRouteChange);

/* Persistent login check — fires INITIAL_SESSION on refresh, SIGNED_IN on
   fresh logins, SIGNED_OUT when the session ends. */
supabase.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    enterApp(session.user);
  } else if (event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') {
    leaveApp();
  }
});
