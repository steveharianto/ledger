/* ============================================================================
   js/components/categories.js
   Recursive category trees, split into Income and Expense. Deleting a
   category with ledger history flips is_active = false (soft delete) and
   exposes a Revive button; renames cascade everywhere automatically because
   logs reference categories by id.
   ========================================================================== */

import {
  insertCategory,
  updateCategory,
  deleteCategory,
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

/* Build an in-memory tree: children sorted by name (query order preserved). */
function buildTree(categories, isIncome) {
  const pool = categories.filter((c) => c.is_income === isIncome);
  const byParent = new Map();
  for (const cat of pool) {
    const key = cat.parent_id || 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(cat);
  }
  return { roots: byParent.get('root') || [], childrenOf: (id) => byParent.get(id) || [] };
}

export function renderCategories(appState, mount) {
  mount.innerHTML = `
    <header class="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="eyebrow mb-1">Categories</p>
        <h2 class="font-display text-3xl font-medium">Income &amp; expense trees</h2>
      </div>
      <div class="flex gap-2">
        <button class="btn-ghost" data-new-root="income">+ Income root</button>
        <button class="btn-ghost" data-new-root="expense">+ Expense root</button>
      </div>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section class="card">
        <div class="section-head"><h3 class="text-up">Income</h3><span class="count">money coming in</span></div>
        <div id="tree-income"></div>
      </section>
      <section class="card">
        <div class="section-head"><h3 class="text-down">Expense</h3><span class="count">money going out</span></div>
        <div id="tree-expense"></div>
      </section>
    </div>`;

  paintTree(mount.querySelector('#tree-income'), appState.categories, true);
  paintTree(mount.querySelector('#tree-expense'), appState.categories, false);

  mount.querySelectorAll('[data-new-root]').forEach((btn) =>
    btn.addEventListener('click', () => openCategoryForm(null, btn.dataset.newRoot === 'income', null))
  );
  bindRowActions(mount);
}

function paintTree(container, categories, isIncome) {
  const tree = buildTree(categories, isIncome);
  if (tree.roots.length === 0) {
    container.innerHTML = `<p class="text-sm text-muted">No ${isIncome ? 'income' : 'expense'} categories yet.</p>`;
    return;
  }
  container.innerHTML = tree.roots.map((cat) => nodeHtml(cat, tree)).join('');
}

function nodeHtml(cat, tree) {
  const children = tree.childrenOf(cat.id);
  return `
    <div>
      <div class="tree-row ${cat.is_active ? '' : 'opacity-50'}">
        <span class="text-xs ${cat.is_income ? 'text-up' : 'text-down'}">●</span>
        <span class="text-sm flex-1 truncate">${escapeHtml(cat.name)}${cat.is_active ? '' : ' <span class="badge ml-1">inactive</span>'}</span>
        <span class="tree-actions flex gap-1">
          ${cat.is_active
            ? `<button class="btn-icon" data-add-child="${cat.id}" title="Add subcategory">＋</button>
               <button class="btn-icon" data-rename="${cat.id}" title="Rename">✎</button>
               <button class="btn-icon" data-delete-cat="${cat.id}" title="Delete">🗑</button>`
            : `<button class="btn-ghost !py-1 !px-2 text-xs" data-revive-cat="${cat.id}">Revive</button>`}
        </span>
      </div>
      ${children.length ? `<div class="tree-node">${children.map((c) => nodeHtml(c, tree)).join('')}</div>` : ''}
    </div>`;
}

function bindRowActions(mount) {
  mount.querySelectorAll('[data-add-child]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const parent = state.categories.find((c) => c.id === btn.dataset.addChild);
      openCategoryForm(null, parent.is_income, parent);
    })
  );
  mount.querySelectorAll('[data-rename]').forEach((btn) =>
    btn.addEventListener('click', () =>
      openCategoryForm(state.categories.find((c) => c.id === btn.dataset.rename), null, null)
    )
  );
  mount.querySelectorAll('[data-delete-cat]').forEach((btn) =>
    btn.addEventListener('click', () => handleDelete(btn.dataset.deleteCat))
  );
  mount.querySelectorAll('[data-revive-cat]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await updateCategory(btn.dataset.reviveCat, { is_active: true });
      toast('Category revived — it is selectable in new logs again.', 'success');
      await refreshAndRender();
    })
  );
}

/* ----------------------------------------------------------------------------
   Create / rename form
---------------------------------------------------------------------------- */

function openCategoryForm(existing, isIncome, parent) {
  const isEdit = Boolean(existing);
  const title = isEdit
    ? 'Rename category'
    : parent
      ? `New subcategory of "${parent.name}"`
      : `New ${isIncome ? 'income' : 'expense'} category`;

  openModal(title, `
    <form id="cat-form" class="space-y-4">
      <div>
        <label class="field-label" for="cat-name">Name</label>
        <input id="cat-name" class="field-input" required value="${escapeHtml(existing?.name || '')}" placeholder="e.g. Groceries" />
      </div>
      ${isEdit ? `<p class="text-xs text-muted">Logs reference categories by id, so the new name cascades across every view instantly.</p>` : ''}
      <div class="flex justify-end gap-2">
        <button type="submit" class="btn-primary">${isEdit ? 'Save name' : 'Create category'}</button>
      </div>
    </form>`, (card) => {
    card.querySelector('#cat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = card.querySelector('#cat-name').value.trim();
      try {
        if (isEdit) {
          await updateCategory(existing.id, { name });
          toast('Category renamed.', 'success');
        } else {
          await insertCategory({
            user_id: state.user.id,
            name,
            is_income: isIncome,
            parent_id: parent ? parent.id : null,
            is_active: true,
          });
          toast('Category created.', 'success');
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
   Soft-Delete Rule — check logs linkage before deciding the delete strategy
---------------------------------------------------------------------------- */

async function handleDelete(categoryId) {
  const cat = state.categories.find((c) => c.id === categoryId);
  if (!cat) return;

  const hasChildren = state.categories.some((c) => c.parent_id === categoryId && c.is_active);
  if (hasChildren) {
    toast('This category has active subcategories — delete or move those first.', 'error');
    return;
  }

  const ok = await confirmAction(
    `Delete "${cat.name}"? If any logs are linked to it, it becomes Inactive instead — hidden from new-log selectors while history stays intact.`,
    'Delete category',
    true
  );
  if (!ok) return;

  try {
    const linkedLogs = await countLogsWhere('category_id', categoryId);
    if (linkedLogs > 0) {
      await updateCategory(categoryId, { is_active: false });
      toast(`"${cat.name}" has ${linkedLogs} linked log(s) — set to Inactive.`, 'success');
    } else {
      await deleteCategory(categoryId);
      toast('Category deleted.', 'success');
    }
    await refreshAndRender();
  } catch (err) {
    toast(err.message, 'error');
  }
}
