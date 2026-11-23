/* app.js — interface do Achooo!. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.abs(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

  // ------------------------------------------------------------------
  // Abas
  // ------------------------------------------------------------------

  const tabs = [...document.querySelectorAll('.tab')];
  let tabTimer = null;

  function enterPanel(panel) {
    panel.hidden = false;
    panel.classList.remove('leaving', 'entering');
    void panel.offsetWidth; // reinicia a animação
    panel.classList.add('entering');
  }

  function selectTab(tab, focus) {
    const target = $(tab.getAttribute('aria-controls'));
    const current = tabs.map((t) => $(t.getAttribute('aria-controls'))).find((p) => !p.hidden && !p.classList.contains('leaving'));
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    }
    if (focus) tab.focus();
    if (current === target) return;

    clearTimeout(tabTimer);
    for (const t of tabs) {
      const p = $(t.getAttribute('aria-controls'));
      if (p !== current && p !== target) { p.hidden = true; p.classList.remove('leaving', 'entering'); }
    }
    if (!current) { enterPanel(target); return; }
    current.classList.remove('entering');
    current.classList.add('leaving');
    tabTimer = setTimeout(() => {
      current.hidden = true;
      current.classList.remove('leaving');
      enterPanel(target);
    }, 160);
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => selectTab(t));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') selectTab(tabs[(i + 1) % tabs.length], true);
      else if (e.key === 'ArrowLeft') selectTab(tabs[(i - 1 + tabs.length) % tabs.length], true);
    });
  });

  // ------------------------------------------------------------------
  // Configurações
  // ------------------------------------------------------------------

  const S = { straighten: true, perspective: true, color: true, sharpen: true, watermark: true, maxSide: 4096, quality: 92 };
  try { Object.assign(S, JSON.parse(localStorage.getItem('achooo-opts') || '{}')); } catch (e) { /* sem storage */ }
  const saveS = () => { try { localStorage.setItem('achooo-opts', JSON.stringify(S)); } catch (e) { /* ok */ } };

  const optEls = {
    straighten: $('optStraighten'), perspective: $('optPerspective'),
    color: $('optColor'), sharpen: $('optSharpen'), watermark: $('optWatermark'),
  };
  for (const k in optEls) {
    optEls[k].checked = !!S[k];
    optEls[k].addEventListener('change', () => { S[k] = optEls[k].checked; saveS(); scheduleReprocessAll(); });
  }

  $('optSize').value = String(S.maxSide);
  $('optSize').addEventListener('change', (e) => { S.maxSide = +e.target.value; saveS(); scheduleReprocessAll(); });

  const q = $('optQuality');
  function paintRange(el) {
    const p = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', p + '%');
  }
  q.value = S.quality;
  $('optQualityOut').textContent = S.quality + '%';
  paintRange(q);
  q.addEventListener('input', () => { $('optQualityOut').textContent = q.value + '%'; paintRange(q); });
  q.addEventListener('change', () => { S.quality = +q.value; saveS(); scheduleReprocessAll(); });

  // ------------------------------------------------------------------
  // Fila de processamento (workers)
  // ------------------------------------------------------------------

  const items = [];
  let nextId = 1;
  const queue = [];
  const pool = [];
  let useMain = false;
  let mainBusy = false;

  // Estado da detecção de marca d'água em lote
  let wmModel = null;
  let wmEstimatedCount = 0;
  let wmAnalyzed = false;
  let wmBusy = false;
  let wmProgress = 0;
  let wmStatusText = '';
  let wmJobId = 0;
  let wmSlot = null;
  let wmPendingReprocess = null; // null = só os pendentes; 'all' = todos

  function broadcastWatermark(model) {
    wmModel = model || null;
    for (const s of pool) s.w.postMessage({ type: 'setWatermark', model: wmModel });
  }

  function needsWatermarkAnalysis() {
    if (!S.watermark || items.length < 3) return false;
    if (!wmAnalyzed) return true;
    if (!wmModel && items.length !== wmEstimatedCount) return true;
    if (wmModel && wmEstimatedCount < 12 && items.length > wmEstimatedCount) return true;
    return false;
  }

  function startWatermarkAnalysis(reprocessAll) {
    if (!items.length) return;
    const jobId = ++wmJobId;
    wmBusy = true;
    wmProgress = 0.04;
    wmStatusText = 'Procurando marca d’água…';
    wmPendingReprocess = reprocessAll ? 'all' : (wmPendingReprocess || 'queued');
    updateStatus();

    const files = items.map((it) => it.file);
    if (!useMain && pool.length) {
      const slot = pool.find((s) => !s.job && s !== wmSlot) || pool[0];
      wmSlot = slot;
      slot.w.postMessage({ type: 'analyzeWatermark', jobId, files });
    } else {
      runWatermarkAnalysisMain(jobId, files);
    }
  }

  async function runWatermarkAnalysisMain(jobId, files) {
    await new Promise((r) => setTimeout(r, 20));
    try {
      const model = await window.PhotoWatermark.analyzeBatchFiles(files, mainEnv, (p, text) => {
        if (jobId !== wmJobId) return;
        wmProgress = p;
        wmStatusText = text || 'Procurando marca d’água…';
        updateStatus();
      });
      finishWatermarkAnalysis(jobId, model);
    } catch (e) {
      finishWatermarkAnalysis(jobId, null);
    }
  }

  function finishWatermarkAnalysis(jobId, model) {
    if (jobId !== wmJobId) return;
    wmBusy = false;
    wmSlot = null;
    wmProgress = 0;
    wmStatusText = '';
    wmAnalyzed = true;
    wmEstimatedCount = items.length;
    const prevHadModel = !!wmModel;
    broadcastWatermark(model);
    const mode = wmPendingReprocess;
    wmPendingReprocess = null;

    if (mode === 'all' || !!wmModel || prevHadModel) {
      for (const it of items) enqueue(it);
    } else {
      for (const it of items) {
        if (!it.blob && it.status !== 'error') enqueue(it);
      }
    }
    if (viewer.open) renderViewer();
    pump();
  }

  function initPool() {
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker('js/worker.js');
        const slot = { w, job: null };
        w.onmessage = (e) => onWorkerMessage(slot, e.data);
        w.onerror = (e) => { e.preventDefault(); fallbackToMain(slot); };
        pool.push(slot);
      }
    } catch (e) {
      useMain = true;
    }
  }

  function fallbackToMain(slot) {
    const wasWm = wmBusy;
    useMain = true;
    wmSlot = null;
    if (slot && slot.job) { queue.unshift(slot.job); slot.job = null; }
    for (const s of pool) { if (s.job) { queue.unshift(s.job); s.job = null; } s.w.terminate(); }
    pool.length = 0;
    if (wasWm) runWatermarkAnalysisMain(wmJobId, items.map((it) => it.file));
    else pump();
  }

  function optsFor(item) {
    return {
      straighten: S.straighten && item.auto,
      perspective: S.perspective && item.auto,
      color: S.color,
      sharpen: S.sharpen,
      watermark: S.watermark && item.watermark,
      extraRoll: item.extraRoll,
      maxSide: S.maxSide,
      quality: S.quality / 100,
    };
  }

  function enqueue(item, priority) {
    item.version++;
    const i = queue.findIndex((j) => j.item === item);
    if (i >= 0) queue.splice(i, 1);
    const job = { item, version: item.version };
    if (priority) queue.unshift(job); else queue.push(job);
    item.status = item.blob ? 'working' : 'queued';
    updateCard(item);
    pump();
  }

  function pump() {
    if (wmBusy) { updateStatus(); return; }
    if (useMain) {
      if (!mainBusy && queue.length) runMain(queue.shift());
    } else {
      for (const slot of pool) {
        if (slot.job || slot === wmSlot || !queue.length) continue;
        const job = queue.shift();
        slot.job = job;
        job.item.status = 'working';
        updateCard(job.item);
        slot.w.postMessage({ id: job.item.id, file: job.item.file, opts: optsFor(job.item) });
      }
    }
    updateStatus();
  }

  function onWorkerMessage(slot, msg) {
    if (msg.type === 'wmProgress') {
      if (msg.jobId === wmJobId) {
        wmProgress = msg.progress;
        wmStatusText = msg.text || 'Procurando marca d’água…';
        updateStatus();
      }
      return;
    }
    if (msg.type === 'wmDone') {
      if (wmSlot === slot) wmSlot = null;
      if (!msg.ok && msg.code === 'NO_OFFSCREEN') { fallbackToMain(slot); return; }
      finishWatermarkAnalysis(msg.jobId, msg.ok ? msg.model : null);
      return;
    }
    const job = slot.job;
    slot.job = null;
    if (!job) return pump();
    if (!msg.ok && msg.code === 'NO_OFFSCREEN') { queue.unshift(job); fallbackToMain(); return; }
    finish(job, msg);
    pump();
  }

  const mainEnv = {
    createCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    toBlob: (c, type, quality) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), type, quality)),
  };

  async function runMain(job) {
    mainBusy = true;
    job.item.status = 'working';
    updateCard(job.item);
    updateStatus();
    await new Promise((r) => setTimeout(r, 30)); // deixa a tela atualizar
    try {
      const o = optsFor(job.item);
      o.wmModel = o.watermark ? wmModel : null;
      const res = await window.runPipeline(job.item.file, o, mainEnv);
      finish(job, { ok: true, ...res });
    } catch (err) {
      finish(job, { ok: false, code: err.code || 'FAIL', error: String(err.message || err) });
    }
    mainBusy = false;
    pump();
  }

  function finish(job, msg) {
    const item = job.item;
    if (item.removed || item.version !== job.version) return; // resultado velho
    if (msg.ok) {
      if (item.url) URL.revokeObjectURL(item.url);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.blob = msg.blob;
      item.url = URL.createObjectURL(msg.blob);
      item.thumbUrl = URL.createObjectURL(msg.thumb);
      item.info = msg.info;
      item.status = 'done';
      item.error = null;
    } else {
      item.status = 'error';
      item.error = msg.code === 'DECODE'
        ? 'Não consegui abrir esta foto. Se for HEIC (iPhone), exporte como JPG.'
        : 'Algo deu errado com esta foto.';
    }
    updateCard(item);
    if (viewerItem() === item) renderViewer();
    updateStatus();
  }

  let reprocessTimer = null;
  function scheduleReprocessAll() {
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(() => {
      if (!items.length) return;
      if (needsWatermarkAnalysis()) {
        startWatermarkAnalysis(true);
      } else {
        for (const it of items) enqueue(it);
      }
    }, 250);
  }

  // ------------------------------------------------------------------
  // Adicionar / remover fotos
  // ------------------------------------------------------------------

  function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name));
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    const added = [];
    for (const file of files) {
      const item = {
        id: nextId++, file, name: file.name, status: 'queued', version: 0,
        auto: true, watermark: true, extraRoll: 0, blob: null, url: null, thumbUrl: null,
        srcUrl: URL.createObjectURL(file), info: null, error: null,
      };
      items.push(item);
      added.push(item);
      item.el = buildCard(item);
      $('grid').appendChild(item.el);
      updateCard(item);
    }
    $('drop').hidden = true;
    $('work').hidden = false;
    selectTab(tabs[0]);
    if (needsWatermarkAnalysis()) {
      startWatermarkAnalysis(false);
    } else {
      for (const it of added) enqueue(it);
    }
    updateStatus();
  }

  function removeItem(item) {
    item.removed = true;
    const qi = queue.findIndex((j) => j.item === item);
    if (qi >= 0) queue.splice(qi, 1);
    for (const u of [item.url, item.thumbUrl, item.srcUrl]) if (u) URL.revokeObjectURL(u);
    item.el.remove();
    items.splice(items.indexOf(item), 1);
    if (!items.length) {
      wmJobId++;
      wmBusy = false;
      wmSlot = null;
      wmAnalyzed = false;
      wmEstimatedCount = 0;
      wmPendingReprocess = null;
      broadcastWatermark(null);
      $('drop').hidden = false;
      $('work').hidden = true;
    }
    updateStatus();
  }

  function clearAll() {
    for (const it of [...items]) removeItem(it);
  }

  // ------------------------------------------------------------------
  // Cards
  // ------------------------------------------------------------------

  const ICON_DL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M6 10l6 6 6-6M4 20h16"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function buildCard(item) {
    const li = document.createElement('li');
    li.className = 'card';
    li.innerHTML = `
      <button class="card-img" type="button">
        <img alt="" loading="lazy" decoding="async">
        <span class="card-overlay"><i class="spinner"></i><span class="ov-text"></span></span>
      </button>
      <div class="card-foot">
        <div class="card-meta">
          <span class="card-name"></span>
          <span class="badges"></span>
        </div>
        <button class="icon-btn dl" type="button" title="Baixar esta foto">${ICON_DL}</button>
        <button class="icon-btn rm" type="button" title="Remover">${ICON_X}</button>
      </div>`;
    li.querySelector('.card-name').textContent = item.name;
    li.querySelector('.card-name').title = item.name;
    li.querySelector('.card-img').setAttribute('aria-label', 'Abrir ' + item.name);
    li.querySelector('.card-img').addEventListener('click', () => openViewer(item));
    li.querySelector('.dl').setAttribute('aria-label', 'Baixar ' + item.name);
    li.querySelector('.dl').addEventListener('click', () => downloadItem(item));
    li.querySelector('.rm').setAttribute('aria-label', 'Remover ' + item.name);
    li.querySelector('.rm').addEventListener('click', () => removeItem(item));
    return li;
  }

  function badgesFor(item) {
    const out = [];
    const i = item.info;
    if (!i) return out;
    if (i.watermark) out.push(['Sem marca d’água', 'ok']);
    if (i.roll) out.push(['Girada ' + fmt(i.roll) + '°', '']);
    if (i.pitch) out.push(['Perspectiva', '']);
    if (!i.roll && !i.pitch) out.push([item.auto && (S.straighten || S.perspective) ? 'Já estava reta' : 'Ângulo mantido', 'soft']);
    if (i.color) out.push(['Cor e luz', '']);
    return out;
  }

  function updateCard(item) {
    const el = item.el;
    if (!el) return;
    el.classList.toggle('is-queued', item.status === 'queued');
    el.classList.toggle('is-working', item.status === 'working');
    el.classList.toggle('is-error', item.status === 'error');
    const img = el.querySelector('img');
    const want = item.thumbUrl || item.srcUrl;
    if (img.getAttribute('src') !== want) img.src = want;
    const ov = el.querySelector('.ov-text');
    ov.textContent = item.status === 'queued' ? 'Na fila' : item.status === 'working' ? 'Ajustando…' : item.status === 'error' ? item.error : '';
    el.querySelector('.spinner').hidden = item.status === 'error';
    el.querySelector('.dl').disabled = !item.blob;
    const b = el.querySelector('.badges');
    b.innerHTML = '';
    for (const [t, cls] of badgesFor(item)) {
      const s = document.createElement('span');
      s.className = 'badge ' + cls;
      s.textContent = t;
      b.appendChild(s);
    }
  }

  function setZipText(txt) {
    const btn = $('zip');
    const lbl = btn.querySelector('.btn-label');
    if (lbl) lbl.textContent = txt; else btn.textContent = txt;
  }

  function updateStatus() {
    const total = items.length;
    const done = items.filter((i) => i.status === 'done').length;
    const errors = items.filter((i) => i.status === 'error').length;
    const pending = total - done - errors;
    $('tabCount').textContent = total ? String(total) : '';
    if (wmBusy) {
      $('bar').style.width = Math.max(4, wmProgress * 100) + '%';
      $('statusText').textContent = wmStatusText || 'Procurando marca d’água…';
      const zip = $('zip');
      if (!zipping) {
        zip.disabled = true;
        setZipText('Aguarde…');
      }
      return;
    }
    $('bar').style.width = total ? ((done + errors) / total) * 100 + '%' : '0';
    let txt;
    if (!total) txt = '';
    else if (pending) txt = `Ajustando… ${done + errors} de ${total}`;
    else txt = `${done} ${done === 1 ? 'foto pronta' : 'fotos prontas'}` + (errors ? ` · ${errors} com erro` : '');
    $('statusText').textContent = txt;
    const zip = $('zip');
    if (!zipping) {
      zip.disabled = !done || pending > 0;
      setZipText(pending > 0 && done ? 'Aguarde…' : 'Baixar todas (.zip)');
    }
  }

  // ------------------------------------------------------------------
  // Downloads
  // ------------------------------------------------------------------

  function outName(item) {
    const stem = item.name.replace(/\.[^.]+$/, '');
    return stem + ' - ajustada.jpg';
  }

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function downloadItem(item) {
    if (item.blob) saveBlob(item.blob, outName(item));
  }

  let zipping = false;
  async function downloadZip() {
    const ready = items.filter((i) => i.blob && i.status === 'done');
    if (!ready.length) return;
    zipping = true;
    const btn = $('zip');
    btn.disabled = true;
    setZipText('Gerando .zip…');
    try {
      const used = new Map();
      const files = ready.map((it, idx) => {
        let name = String(idx + 1).padStart(2, '0') + ' - ' + outName(it);
        const n = used.get(name) || 0;
        used.set(name, n + 1);
        if (n) name = name.replace(/\.jpg$/, ` (${n + 1}).jpg`);
        return { name, blob: it.blob };
      });
      const blob = await window.makeZip(files);
      saveBlob(blob, 'fotos-achooo.zip');
    } finally {
      zipping = false;
      updateStatus();
    }
  }

  // ------------------------------------------------------------------
  // Visualizador
  // ------------------------------------------------------------------

  const viewer = $('viewer');
  let vIdx = -1;
  let showBefore = false;
  const viewerItem = () => (viewer.open ? items[vIdx] : null);

  function openViewer(item) {
    vIdx = items.indexOf(item);
    showBefore = false;
    renderViewer();
    if (!viewer.open) viewer.showModal();
  }

  function renderViewer() {
    const item = items[vIdx];
    if (!item) { viewer.close(); return; }
    $('vName').textContent = item.name;
    $('vIndex').textContent = `${vIdx + 1} / ${items.length}`;
    const before = showBefore || !item.url;
    const src = before ? item.srcUrl : item.url;
    if ($('vImg').getAttribute('src') !== src) $('vImg').src = src;
    $('vImg').alt = (before ? 'Original: ' : 'Ajustada: ') + item.name;
    const tag = $('vTag');
    tag.textContent = before ? 'Antes' : 'Depois';
    tag.classList.toggle('before', before);
    $('vBefore').setAttribute('aria-pressed', String(showBefore));
    $('vAfter').setAttribute('aria-pressed', String(!showBefore));
    $('vBusy').hidden = !(item.status === 'working' || item.status === 'queued');
    $('vPrev').disabled = vIdx <= 0;
    $('vNext').disabled = vIdx >= items.length - 1;
    $('vRoll').value = item.extraRoll;
    paintRange($('vRoll'));
    $('vRollOut').textContent = (item.extraRoll > 0 ? '+' : item.extraRoll < 0 ? '−' : '') + fmt(item.extraRoll) + '°';
    $('vAuto').checked = item.auto;
    $('vWmWrap').hidden = !wmModel || !S.watermark;
    $('vWm').checked = item.watermark;
    $('vDownload').disabled = !item.blob;

    const parts = [];
    const i = item.info;
    if (item.status === 'error') parts.push(item.error);
    else if (i) {
      if (i.watermark) parts.push('marca d’água removida');
      if (i.roll) parts.push(`Endireitada ${fmt(i.roll)}°`);
      if (i.pitch) parts.push(`perspectiva corrigida (${fmt(i.pitch)}°)`);
      if (!i.roll && !i.pitch) {
        if (!item.auto || (!S.straighten && !S.perspective)) parts.push('Ângulo mantido');
        else if (i.confidence === 'nenhuma' || i.confidence === 'incerta') parts.push('Não achei linhas retas confiáveis — ângulo mantido');
        else parts.push('Já estava reta');
      }
      if (i.color) parts.push('cor e luz ajustadas');
      parts.push(`${i.width} × ${i.height} px`);
    }
    const s = parts.join(' · ');
    $('vInfo').textContent = s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  function step(d) {
    const n = vIdx + d;
    if (n < 0 || n >= items.length) return;
    vIdx = n;
    showBefore = false;
    renderViewer();
  }

  $('vClose').addEventListener('click', () => viewer.close());
  $('vPrev').addEventListener('click', () => step(-1));
  $('vNext').addEventListener('click', () => step(1));
  $('vBefore').addEventListener('click', () => { showBefore = true; renderViewer(); });
  $('vAfter').addEventListener('click', () => { showBefore = false; renderViewer(); });
  $('vDownload').addEventListener('click', () => { const it = items[vIdx]; if (it) downloadItem(it); });
  viewer.addEventListener('click', (e) => {
    if (e.target !== viewer) return;
    const r = viewer.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) viewer.close();
  });
  viewer.addEventListener('close', () => { holding = false; showBefore = false; });
  viewer.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  // segurar a foto mostra o original
  const stage = $('vStage');
  let holding = false;
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    holding = true; showBefore = true; renderViewer();
  });
  const release = () => { if (holding) { holding = false; showBefore = false; renderViewer(); } };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointerleave', release);
  stage.addEventListener('pointercancel', release);

  // deslizar para trocar de foto (celular)
  let touchX = null;
  stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) { release(); step(dx < 0 ? 1 : -1); }
  });

  const vRoll = $('vRoll');
  let rollTimer = null;
  vRoll.addEventListener('input', () => {
    const it = items[vIdx];
    if (!it) return;
    it.extraRoll = +vRoll.value;
    paintRange(vRoll);
    $('vRollOut').textContent = (it.extraRoll > 0 ? '+' : it.extraRoll < 0 ? '−' : '') + fmt(it.extraRoll) + '°';
    clearTimeout(rollTimer);
    rollTimer = setTimeout(() => { enqueue(it, true); renderViewer(); }, 300);
  });
  $('vAuto').addEventListener('change', (e) => {
    const it = items[vIdx];
    if (!it) return;
    it.auto = e.target.checked;
    enqueue(it, true);
    renderViewer();
  });
  $('vWm').addEventListener('change', (e) => {
    const it = items[vIdx];
    if (!it) return;
    it.watermark = e.target.checked;
    enqueue(it, true);
    renderViewer();
  });

  // ------------------------------------------------------------------
  // Entrada de arquivos
  // ------------------------------------------------------------------

  const fileInput = $('file');
  $('pick').addEventListener('click', () => fileInput.click());
  $('add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  $('clear').addEventListener('click', () => {
    if (items.length && confirm('Remover todas as fotos da tela?')) clearAll();
  });
  $('zip').addEventListener('click', downloadZip);

  const veil = $('veil');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; veil.classList.add('on'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) veil.classList.remove('on'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    veil.classList.remove('on');
    if (viewer.open) viewer.close();
    addFiles(e.dataTransfer.files);
  });
  window.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) addFiles(files);
  });
  window.addEventListener('beforeunload', (e) => {
    if (items.some((i) => i.blob)) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------
  enterPanel($('panel-fotos'));
  initPool();
  updateStatus();
})();
