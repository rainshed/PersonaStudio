document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("[data-material-import-form]");
  if (!form) return;
  const choices = [...form.querySelectorAll("[data-import-kind]")];
  const panels = [...form.querySelectorAll("[data-import-panel]")];
  const update = () => {
    const selected = choices.find((item) => item.checked)?.value || "arxiv";
    panels.forEach((panel) => {
      const active = panel.dataset.importPanel === selected;
      panel.hidden = !active;
      panel.querySelectorAll("[data-import-control]").forEach((control) => {
        control.disabled = !active;
        control.required = active;
      });
    });
  };
  choices.forEach((choice) => choice.addEventListener("change", update));
  form.addEventListener("submit", () => {
    const button = form.querySelector("[data-import-submit]");
    const progress = form.querySelector("[data-import-progress]");
    if (button) button.disabled = true;
    if (progress) progress.hidden = false;
  });
  update();
});
