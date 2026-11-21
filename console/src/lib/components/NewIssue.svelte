<script>
  // Raise an issue on the Issues page: title, kind, description and files.
  // The first picture is the issue's main picture (shown on its card); it and
  // any other picture can be marked up like a gallery screenshot. A marked-up
  // picture that is not the main one is sent as an extra file next to it.
  import Icon from './Icon.svelte';
  import MarkupCanvas from './MarkupCanvas.svelte';

  import PrioritySelect from './PrioritySelect.svelte';
  import IssuePicker from './IssuePicker.svelte';

  let { project, issues = [], canFiles = false, canTickets = false, onclose = () => {}, oncreated = () => {} } = $props();

  const MAX_FILES = 8; // besides the main picture: the VM's limit for att/
  const MAX_FILE = 20 * 1024 * 1024;
  const MAX_TOTAL = 15 * 1024 * 1024;
  const MAX_PNG = 7.5 * 1024 * 1024; // the VM takes pictures up to 8 MB
  const IMAGE_RE = /^image\/(png|jpeg|gif|webp|bmp)$/;

  let title = $state('');
  let kind = $state('bug');
  let body = $state('');
  let priority = $state('normal');
  let doneWhen = $state('');
  let related = $state([]); // issue numbers
  let files = $state([]); // {key, file, name, size, image, url, shapes, marked}
  let editing = $state(null); // key of the picture being marked up
  let editShapes = $state([]);
  let drawing = $state();
  let saving = $state(false);
  let err = $state('');
  let over = $state(false);
  let picker = $state();
  let n = 0;

  const main = $derived(files.find((f) => f.image) || null);
  const extras = $derived(files.filter((f) => f !== main));
  const total = $derived(files.reduce((s, f) => s + f.size, 0));
  const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  function add(list) {
    err = '';
    for (const file of list) {
      const image = IMAGE_RE.test(file.type);
      if (file.size > MAX_FILE) {
        err = `${file.name} is over 20 MB.`;
        continue;
      }
      const isMain = image && !files.some((f) => f.image);
      if (!isMain && !canFiles) {
        err = 'This VM takes one picture per issue. More files need kit 0.7 on the VM.';
        continue;
      }
      if (!isMain && files.filter((f) => f !== main).length >= MAX_FILES) {
        err = `At most ${MAX_FILES} files besides the main picture.`;
        continue;
      }
      files.push({ key: ++n, file, name: file.name || `pasted-${n}.png`, size: file.size, image, url: image ? URL.createObjectURL(file) : null, shapes: [], marked: null });
    }
  }

  function remove(f) {
    if (f.url) URL.revokeObjectURL(f.url);
    files = files.filter((x) => x.key !== f.key);
  }

  function makeMain(f) {
    files = [f, ...files.filter((x) => x.key !== f.key)];
  }

  function startMarkup(f) {
    editing = f.key;
    editShapes = $state.snapshot(f.shapes);
  }

  async function doneMarkup() {
    const f = files.find((x) => x.key === editing);
    if (f) {
      f.shapes = $state.snapshot(editShapes);
      f.marked = f.shapes.length ? await drawing.flatten() : null;
    }
    editing = null;
  }

  function paste(e) {
    const got = [...(e.clipboardData?.files || [])];
    if (got.length) {
      e.preventDefault();
      add(got);
    }
  }

  /** Draw an image onto a canvas and return a PNG under MAX_PNG (scaled down if needed). */
  async function fitPng(blob) {
    if (blob.type === 'image/png' && blob.size <= MAX_PNG) return blob;
    const bmp = await createImageBitmap(blob);
    let w = Math.min(bmp.width, 2560);
    for (let tries = 0; tries < 6; tries++) {
      const c = document.createElement('canvas');
      c.width = Math.round(w);
      c.height = Math.round((bmp.height * w) / bmp.width);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = w < bmp.width;
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const png = await new Promise((r) => c.toBlob(r, 'image/png'));
      if (png.size <= MAX_PNG) return png;
      w *= 0.7;
    }
    throw new Error('The picture is too large, even scaled down');
  }

  const b64 = (blob) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read a file'));
      r.readAsDataURL(blob);
    });

  const stem = (name) => name.replace(/\.[^.]+$/, '') || 'picture';

  async function save() {
    err = '';
    if (!title.trim()) {
      err = 'Give the issue a short title';
      return;
    }
    if (total > MAX_TOTAL) {
      err = 'All files together must stay under 15 MB.';
      return;
    }
    saving = true;
    try {
      const payload = { title: title.trim(), kind, body: body.trim(), attachments: [] };
      if (canTickets) Object.assign(payload, { priority, doneWhen: doneWhen.trim(), related: $state.snapshot(related) });
      if (main) {
        payload.picture = { name: main.name, png: await b64(await fitPng(main.file)) };
        payload.markup = $state.snapshot(main.shapes);
        if (main.marked) payload.markupPng = await b64(await fitPng(main.marked));
      }
      for (const f of extras) {
        payload.attachments.push({ name: f.name, data: await b64(f.file) });
        if (f.marked) payload.attachments.push({ name: `${stem(f.name)}-markup.png`, data: await b64(f.marked) });
      }
      const r = await fetch(`/p/${project.id}/issues/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.message || 'Could not raise the issue');
      for (const f of files) if (f.url) URL.revokeObjectURL(f.url);
      oncreated(res);
    } catch (e) {
      err = e.message || 'Could not raise the issue';
    } finally {
      saving = false;
    }
  }

  function key(e) {
    if (e.key === 'Escape') {
      if (editing) editing = null;
      else onclose();
    } else if (editing && (e.ctrlKey || e.metaKey) && e.key === 'z' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      drawing?.undo();
    }
  }
</script>

<svelte:window onkeydown={key} />

<div class="wrap" role="dialog" aria-modal="true" aria-label="New issue">
  <button class="shade" onclick={onclose} aria-label="Cancel"></button>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="box panel lit" class:wide={!!editing} onpaste={paste}>
    <header>
      <h2>{editing ? 'Mark up the picture' : 'New issue'}</h2>
      <button class="btn quiet icon" onclick={editing ? () => (editing = null) : onclose} aria-label="Cancel"><Icon name="x" size={14} /></button>
    </header>

    {#if editing}
      {@const f = files.find((x) => x.key === editing)}
      {#if f}
        <MarkupCanvas bind:this={drawing} src={f.url} bind:shapes={editShapes} maxHeight="calc(100vh - 220px)" />
        <div class="foot">
          <span class="dim small">Draw boxes, ellipses or freehand on {f.name}. Ctrl+Z undoes.</span>
          <button class="btn quiet" onclick={() => (editing = null)}>Cancel</button>
          <button class="btn primary" onclick={doneMarkup}>Done</button>
        </div>
      {/if}
    {:else}
      <label class="fieldrow">
        <span class="lbl">Kind</span>
        <select class="field" bind:value={kind}>
          <option value="bug">Bug</option>
          <option value="polish">Polish</option>
          <option value="idea">Idea</option>
        </select>
      </label>
      <label class="fieldrow">
        <span class="lbl">Title <span class="req">*</span></span>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="field" placeholder="Short, descriptive: The save menu forgets the cursor" bind:value={title} maxlength="200" autofocus />
      </label>
      <label class="fieldrow">
        <span class="lbl">Description</span>
        <textarea class="field" rows="5" placeholder="What is wrong, or what you would like. Where in the game, how to see it, what you expected." bind:value={body} maxlength="20000"></textarea>
      </label>
      {#if canTickets}
        <label class="fieldrow">
          <span class="lbl">Done when <span class="dim">(optional)</span></span>
          <textarea class="field" rows="2" placeholder="What has to be true for this to be fixed" bind:value={doneWhen} maxlength="1000"></textarea>
        </label>
        <div class="grid2">
          <div class="fieldrow">
            <span class="lbl">Priority</span>
            <PrioritySelect value={priority} onchange={(v) => (priority = v)} />
          </div>
          <div class="fieldrow">
            <span class="lbl">Related <span class="dim">(optional)</span></span>
            <IssuePicker {issues} exclude={related} onpick={(i) => (related = [...related, i.number])} />
            {#if related.length}
              <div class="rel">
                {#each related as n (n)}
                  {@const r = issues.find((i) => i.number === n)}
                  <span class="chip small">#{n}{r ? ` ${r.title.slice(0, 24)}${r.title.length > 24 ? '…' : ''}` : ''}<button class="x" aria-label="Remove #{n}" onclick={() => (related = related.filter((x) => x !== n))}>×</button></span>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}
      <span class="lbl">Pictures and files</span>

      <div
        class="drop"
        class:over
        role="group"
        aria-label="Attachments"
        ondragover={(e) => {
          e.preventDefault();
          over = true;
        }}
        ondragleave={() => (over = false)}
        ondrop={(e) => {
          e.preventDefault();
          over = false;
          add([...(e.dataTransfer?.files || [])]);
        }}
      >
        {#if files.length}
          <div class="files">
            {#each files as f (f.key)}
              <div class="file well" class:main={f === main}>
                {#if f.image}
                  <img src={f.url} alt="" />
                  {#if f.marked}<span class="tag small">marked up</span>{/if}
                {:else}
                  <span class="doc mono small">{(f.name.match(/\.([^.]+)$/)?.[1] || 'file').toUpperCase()}</span>
                {/if}
                <span class="name small mono" title={f.name}>{f.name}</span>
                <span class="dim small">{kb(f.size)}{f === main ? ' · main picture' : ''}</span>
                <span class="row">
                  {#if f.image}<button class="btn quiet sm" onclick={() => startMarkup(f)}>{f.shapes.length ? 'Edit markup' : 'Mark up'}</button>{/if}
                  {#if f.image && f !== main && canFiles}<button class="btn quiet sm" onclick={() => makeMain(f)}>Make main</button>{/if}
                  <button class="btn quiet icon sm" onclick={() => remove(f)} aria-label="Remove {f.name}">×</button>
                </span>
              </div>
            {/each}
          </div>
        {/if}
        <p class="dim small">
          Drop files here, paste a screenshot, or
          <button class="link" onclick={() => picker.click()}>choose files</button>.
          {canFiles ? 'The first picture is shown on the card; any picture can be marked up.' : 'One picture per issue on this VM (more files need kit 0.7).'}
        </p>
        <input bind:this={picker} type="file" multiple={canFiles} hidden onchange={(e) => (add([...e.currentTarget.files]), (e.currentTarget.value = ''))} />
      </div>

      {#if err}<div class="s-failed small">{err}</div>{/if}
      <div class="foot">
        <span class="dim small">Goes to the New column. The lead picks it up at the start of its next cycle and moves it as the team works on it.</span>
        <button class="btn quiet" onclick={onclose}>Cancel</button>
        <button class="btn primary" onclick={save} disabled={saving || !title.trim()}>{saving ? 'Sending…' : 'Create'}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .lbl {
    font-size: 12px;
    color: var(--ink-2);
  }
  .req {
    color: var(--critical);
  }
  .rel {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 4px 2px 8px;
  }
  .chip .x {
    border: 0;
    background: none;
    color: var(--ink-2);
    cursor: pointer;
  }
  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    align-items: start;
  }
  textarea.field {
    resize: vertical;
  }
  .wrap {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 32px 16px;
    overflow: auto;
  }
  .shade {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 14, 0.88);
    border: 0;
  }
  .box {
    position: relative;
    width: min(760px, 100%);
    padding: 16px;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .box.wide {
    width: min(1000px, 100%);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  textarea {
    resize: vertical;
    font: inherit;
  }
  .drop {
    border: 1px dashed var(--line-strong);
    border-radius: 8px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .drop.over {
    border-color: var(--accent);
    background: rgba(var(--glow), 0.08);
  }
  .drop p {
    margin: 0;
  }
  .files {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 8px;
  }
  .file {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px;
    border-radius: 6px;
    min-width: 0;
  }
  .file.main {
    border-color: var(--accent);
  }
  .file img {
    width: 100%;
    height: 100px;
    object-fit: cover;
    object-position: top;
    border-radius: 4px;
    image-rendering: pixelated;
  }
  .doc {
    height: 100px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--ink-2);
  }
  .tag {
    position: absolute;
    top: 10px;
    left: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(2, 6, 14, 0.8);
    color: var(--warn);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row {
    display: flex;
    gap: 4px;
    align-items: center;
    flex-wrap: wrap;
  }
  .link {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .foot {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .foot .dim {
    flex: 1;
  }
</style>
