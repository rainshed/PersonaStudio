(() => {
  const form = document.querySelector('[data-sample-upload-form]');
  if (!form) return;
  const root = form.querySelector('[data-sample-upload]');
  const fileInput = form.elements.sample_file;
  const folderInput = form.elements.folder_files;
  const titleInput = form.elements.title;
  const preview = root.querySelector('[data-upload-preview]');
  const error = root.querySelector('[data-upload-error]');
  let lastAutoTitle = '';
  function refresh() {
    const folder = form.elements.upload_kind.value === 'folder';
    fileInput.disabled = folder;
    fileInput.required = !folder;
    folderInput.disabled = !folder;
    folderInput.required = folder;
    root.querySelector('[data-file-picker]').hidden = folder;
    root.querySelector('[data-folder-picker]').hidden = !folder;
    const input = folder ? folderInput : fileInput;
    const files = [...input.files];
    const paths = files.map(file => folder ? file.webkitRelativePath : file.name);
    form.elements.folder_paths.value = JSON.stringify(folder ? paths : []);
    preview.hidden = files.length === 0;
    const size = files.reduce((total, file) => total + file.size, 0);
    const invalid = size > 50 * 1024 * 1024 || files.length > 500;
    input.setCustomValidity(invalid ? root.dataset.limitMessage : '');
    error.hidden = !invalid;
    error.textContent = invalid ? root.dataset.limitMessage : '';
    const list = root.querySelector('[data-upload-list]');
    list.replaceChildren();
    if (!files.length) return;
    const name = folder ? paths[0].split('/')[0] : files[0].name;
    if (!titleInput.value.trim() || titleInput.value === lastAutoTitle) {
      titleInput.value = name;
      lastAutoTitle = name;
    }
    root.querySelector('[data-upload-name]').textContent = name;
    root.querySelector('[data-upload-count]').textContent =
      root.dataset.countLabel.replace('{count}', files.length) + ' · ' +
      (size < 1024 * 1024 ? (size / 1024).toFixed(1) + ' KB' : (size / 1024 / 1024).toFixed(1) + ' MB');
    paths.sort((a, b) => a.localeCompare(b)).forEach(path => {
      const item = document.createElement('li');
      item.textContent = path;
      list.appendChild(item);
    });
  }
  if (!('webkitdirectory' in folderInput)) {
    form.querySelector('[name="upload_kind"][value="folder"]').disabled = true;
    form.querySelector('[name="upload_kind"][value="file"]').checked = true;
    root.querySelector('[data-folder-unsupported]').hidden = false;
  }
  root.addEventListener('change', refresh);
  form.addEventListener('submit', event => {
    if (!form.querySelector('[name="context_refs"]:checked')) {
      event.preventDefault();
      error.hidden = false;
      error.textContent = root.dataset.contextError;
      form.querySelector('[name="context_refs"]')?.focus();
    }
  });
  refresh();
})();
