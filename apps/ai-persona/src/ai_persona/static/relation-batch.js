let comboboxSequence = 0;

function relationConstraint(combobox) {
  const row = combobox.closest("[data-relation-row]");
  const relationType = combobox.dataset.fixedRelationType
    || row?.querySelector(`[name="${combobox.dataset.relationTypeSource}"]`)?.value
    || "";
  const knowledgeRole = row?.querySelector(
    `[name="${combobox.dataset.knowledgeRoleSource}"]`,
  )?.value || "";
  return { relationType, knowledgeRole };
}

function relationSelectionKey(combobox, knowledgeId) {
  const { relationType, knowledgeRole } = relationConstraint(combobox);
  const qualifier = relationType === "covers" ? knowledgeRole : relationType;
  return `${knowledgeId}\u0000${qualifier}`;
}

function selectedElsewhere(combobox, knowledgeId) {
  const form = combobox.closest("[data-relation-batch-form]");
  const key = relationSelectionKey(combobox, knowledgeId);
  return [...form.querySelectorAll("[data-knowledge-combobox]")].some((other) => {
    if (other === combobox) return false;
    const otherId = other.querySelector("[data-knowledge-id]")?.value;
    return otherId && relationSelectionKey(other, otherId) === key;
  });
}

function setComboboxOpen(combobox, open) {
  const input = combobox.querySelector("[data-knowledge-search]");
  const suggestions = combobox.querySelector("[data-knowledge-suggestions]");
  input.setAttribute("aria-expanded", String(open));
  suggestions.hidden = !open;
  if (!open) {
    combobox.activeIndex = -1;
    suggestions.querySelectorAll(".is-active").forEach((item) => {
      item.classList.remove("is-active");
    });
  }
}

function renderMessage(combobox, message) {
  const suggestions = combobox.querySelector("[data-knowledge-suggestions]");
  suggestions.replaceChildren();
  const item = document.createElement("p");
  item.className = "knowledge-suggestion-message";
  item.textContent = message;
  suggestions.append(item);
  setComboboxOpen(combobox, true);
}

function suggestionMeta(item) {
  return [...item.path, item.role].filter(Boolean).join(" › ");
}

function chooseSuggestion(combobox, item) {
  const input = combobox.querySelector("[data-knowledge-search]");
  const hidden = combobox.querySelector("[data-knowledge-id]");
  const selection = combobox.querySelector("[data-knowledge-selection]");
  input.value = item.title;
  input.setCustomValidity("");
  hidden.value = item.id;
  hidden.setAttribute("value", item.id);
  combobox.selectedTitle = item.title;
  const details = [suggestionMeta(item), item.aliases.join(" / ")].filter(Boolean);
  selection.textContent = details.join(" · ");
  setComboboxOpen(combobox, false);
}

function renderSuggestions(combobox, items) {
  const suggestions = combobox.querySelector("[data-knowledge-suggestions]");
  suggestions.replaceChildren();
  combobox.activeIndex = -1;
  if (!items.length) {
    renderMessage(combobox, combobox.dataset.noResults);
    return;
  }

  items.forEach((item) => {
    const selected = selectedElsewhere(combobox, item.id);
    const option = document.createElement("button");
    option.type = "button";
    option.className = "knowledge-suggestion";
    option.setAttribute("role", "option");
    option.disabled = item.disabled || selected;

    const heading = document.createElement("span");
    heading.className = "knowledge-suggestion-heading";
    const title = document.createElement("strong");
    title.textContent = item.title;
    heading.append(title);
    if (item.disabled || selected) {
      const badge = document.createElement("i");
      badge.textContent = item.disabled
        ? combobox.dataset.existing
        : combobox.dataset.selected;
      heading.append(badge);
    }
    option.append(heading);

    const meta = document.createElement("small");
    meta.textContent = suggestionMeta(item);
    option.append(meta);
    if (item.aliases.length) {
      const aliases = document.createElement("small");
      aliases.className = "knowledge-suggestion-aliases";
      aliases.textContent = item.aliases.join(" / ");
      option.append(aliases);
    }
    option.addEventListener("click", () => chooseSuggestion(combobox, item));
    suggestions.append(option);
  });
  setComboboxOpen(combobox, true);
}

async function requestSuggestions(combobox) {
  const input = combobox.querySelector("[data-knowledge-search]");
  const { relationType, knowledgeRole } = relationConstraint(combobox);
  const params = new URLSearchParams({
    q: input.value.trim(),
    source_id: combobox.dataset.sourceId,
    relation_type: relationType,
    knowledge_role: knowledgeRole,
  });
  combobox.abortController?.abort();
  combobox.abortController = new AbortController();
  try {
    const response = await fetch(`/api/knowledge/suggestions?${params}`, {
      signal: combobox.abortController.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderSuggestions(combobox, await response.json());
  } catch (error) {
    if (error.name !== "AbortError") {
      renderMessage(combobox, combobox.dataset.searchError);
    }
  }
}

function scheduleSuggestions(combobox, immediate = false) {
  window.clearTimeout(combobox.searchTimer);
  combobox.searchTimer = window.setTimeout(
    () => requestSuggestions(combobox),
    immediate ? 0 : 150,
  );
}

function moveActiveSuggestion(combobox, direction) {
  const options = [...combobox.querySelectorAll(".knowledge-suggestion:not(:disabled)")];
  if (!options.length) return;
  options.forEach((option) => option.classList.remove("is-active"));
  combobox.activeIndex = (
    (combobox.activeIndex ?? -1) + direction + options.length
  ) % options.length;
  const active = options[combobox.activeIndex];
  active.classList.add("is-active");
  active.scrollIntoView({ block: "nearest" });
}

function initializeCombobox(combobox) {
  if (combobox.dataset.initialized) return;
  combobox.dataset.initialized = "true";
  comboboxSequence += 1;
  const input = combobox.querySelector("[data-knowledge-search]");
  const hidden = combobox.querySelector("[data-knowledge-id]");
  const selection = combobox.querySelector("[data-knowledge-selection]");
  const suggestions = combobox.querySelector("[data-knowledge-suggestions]");
  suggestions.id = `knowledge-suggestions-${comboboxSequence}`;
  input.setAttribute("aria-controls", suggestions.id);

  input.addEventListener("focus", () => scheduleSuggestions(combobox, true));
  input.addEventListener("input", () => {
    if (hidden.value && input.value === combobox.selectedTitle) return;
    hidden.value = "";
    hidden.removeAttribute("value");
    combobox.selectedTitle = "";
    selection.textContent = "";
    input.setCustomValidity("");
    scheduleSuggestions(combobox);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (suggestions.hidden) scheduleSuggestions(combobox, true);
      else moveActiveSuggestion(combobox, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && !suggestions.hidden) {
      const active = suggestions.querySelector(".knowledge-suggestion.is-active");
      if (active) {
        event.preventDefault();
        active.click();
      }
    } else if (event.key === "Escape") {
      setComboboxOpen(combobox, false);
    }
  });

  const row = combobox.closest("[data-relation-row]");
  row.querySelectorAll('select[name="relation_type"], select[name="knowledge_role"]').forEach(
    (select) => select.addEventListener("change", () => {
      if (!suggestions.hidden) scheduleSuggestions(combobox, true);
      input.setCustomValidity("");
    }),
  );
}

function refreshRelationRows(form) {
  const rows = form.querySelectorAll("[data-relation-row]");
  rows.forEach((row, index) => {
    const number = row.querySelector("[data-relation-row-number]");
    const remove = row.querySelector("[data-remove-relation-row]");
    if (number) number.textContent = String(index + 1);
    if (remove) remove.hidden = rows.length === 1;
    row.querySelectorAll("[data-knowledge-combobox]").forEach(initializeCombobox);
  });
}

function validateRelationForm(form) {
  let valid = true;
  const seen = new Set();
  form.querySelectorAll("[data-knowledge-combobox]").forEach((combobox) => {
    const input = combobox.querySelector("[data-knowledge-search]");
    const knowledgeId = combobox.querySelector("[data-knowledge-id]").value;
    input.setCustomValidity("");
    if (!knowledgeId) {
      input.setCustomValidity(combobox.dataset.selectError);
      valid = false;
      return;
    }
    const key = relationSelectionKey(combobox, knowledgeId);
    if (seen.has(key)) {
      input.setCustomValidity(combobox.dataset.selected);
      valid = false;
    }
    seen.add(key);
  });
  if (!valid) form.querySelector(":invalid")?.reportValidity();
  return valid;
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-relation-batch-form]").forEach(refreshRelationRows);
});

document.addEventListener("click", (event) => {
  document.querySelectorAll("[data-knowledge-combobox]").forEach((combobox) => {
    if (!combobox.contains(event.target)) setComboboxOpen(combobox, false);
  });

  const add = event.target.closest("[data-add-relation-row]");
  if (add) {
    const form = add.closest("[data-relation-batch-form]");
    const list = form?.querySelector("[data-relation-batch-list]");
    const template = form?.querySelector("[data-relation-row-template]");
    if (!form || !list || !template) return;
    const fragment = template.content.cloneNode(true);
    const row = fragment.querySelector("[data-relation-row]");
    list.appendChild(fragment);
    refreshRelationRows(form);
    row?.querySelector("[data-knowledge-search]")?.focus();
    return;
  }

  const remove = event.target.closest("[data-remove-relation-row]");
  if (!remove) return;
  const form = remove.closest("[data-relation-batch-form]");
  const rows = form?.querySelectorAll("[data-relation-row]");
  if (!form || !rows || rows.length === 1) return;
  remove.closest("[data-relation-row]")?.remove();
  refreshRelationRows(form);
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-relation-batch-form]");
  if (form && !validateRelationForm(form)) event.preventDefault();
});
