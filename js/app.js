/* app.js — interface do Achooo!. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Math.abs(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

  // ------------------------------------------------------------------
  // Fundo: redemoinho líquido + rabiscos
  // ------------------------------------------------------------------

  function paintSwirl() {
    const w = 400, h = 250;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;

    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const P = new Uint8Array(512);
    for (let i = 0; i < 256; i++) P[i] = i;
    for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [P[i], P[j]] = [P[j], P[i]]; }
    for (let i = 0; i < 256; i++) P[i + 256] = P[i];
    const hash = (x, y) => P[P[x & 255] + (y & 255)] / 255;
    const sstep = (t) => t * t * (3 - 2 * t);
    function noise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = sstep(x - xi), fy = sstep(y - yi);
      const a = hash(xi, yi), b = hash(xi + 1, yi), cc = hash(xi, yi + 1), dd = hash(xi + 1, yi + 1);
      return a + (b - a) * fx + (cc - a) * fy + (a - b - cc + dd) * fx * fy;
    }
    function fbm(x, y) {
      let v = 0, amp = 0.5;
      for (let o = 0; o < 4; o++) { v += amp * noise(x, y); x = x * 2.03 + 11.3; y = y * 2.01 + 7.1; amp *= 0.5; }
      return v / 0.9375;
    }
    const smooth = (a, b, t) => { const x = Math.max(0, Math.min(1, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

    const PURPLE = [90, 165, 209], DEEP = [47, 123, 176], YELLOW = [255, 255, 255],
      LILAC = [220, 30, 32], ORANGE = [232, 238, 243];
    const aspect = w / h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let nx = (x / w - 0.5) * aspect, ny = y / h - 0.5;
        const r = Math.hypot(nx, ny);
        const a = Math.atan2(ny, nx) + 3.2 * Math.exp(-r * 2.6);
        nx = r * Math.cos(a); ny = r * Math.sin(a);
        const qx = fbm(nx * 2.6 + 1.7, ny * 2.6 + 9.2);
        const qy = fbm(nx * 2.6 + 8.3, ny * 2.6 + 2.8);
        const t = fbm(nx * 2.4 + 3.5 * qx, ny * 2.4 + 3.5 * qy);
        const band = 0.5 + 0.5 * Math.sin(t * 15 + r * 5);
        let col = mix(DEEP, PURPLE, smooth(0.1, 0.45, band));
        col = mix(col, YELLOW, smooth(0.6, 0.86, band));
        col = mix(col, LILAC, smooth(0.93, 1.0, band) * 0.85);
        const core = Math.exp(-r * r * 9) * smooth(0.45, 0.7, qx) * (1 - smooth(0.55, 0.8, band));
        col = mix(col, ORANGE, Math.min(1, core * 1.4));
        const i = (y * w + x) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    $('swirl').style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.9)})`;
  }

  // Redemoinho animado em WebGL (shader próprio: torção polar + distorção
  // iterativa, tipo tinta mexida). Sem WebGL, cai no redemoinho estático.
  const SWIRL_VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const SWIRL_FS = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform vec2 uRes;
    uniform vec2 uCenter;
    uniform float uTime;
    const vec3 DEEP   = vec3(0.184, 0.482, 0.690); // #2f7bb0 azul
    const vec3 PURPLE = vec3(0.353, 0.647, 0.820); // #5aa5d1 azul céu
    const vec3 YELLOW = vec3(1.000, 1.000, 1.000); // branco
    const vec3 LILAC  = vec3(0.863, 0.118, 0.125); // #dc1e20 fio vermelho
    const vec3 ORANGE = vec3(0.910, 0.933, 0.953); // #e8eef3 centro claro
    void main() {
      // posição relativa a um centro fixo a partir do topo, escala pela largura:
      // trocar de aba (o palco muda de altura) não mexe no desenho
      vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
      vec2 uv = (fc - uCenter) / uRes.x * 2.0;
      uv.y = -uv.y;
      float t = uTime;
      float r = length(uv);
      float a = atan(uv.y, uv.x);
      // torção: mais forte no centro, girando devagar
      a += t * 0.12 + 3.2 * exp(-r * 1.2);
      vec2 p = vec2(cos(a), sin(a)) * r * 5.0;
      // distorção iterativa (efeito de tinta)
      for (int i = 0; i < 8; i++) {
        float fi = float(i);
        p += 0.8 * vec2(
          sin(p.y * 0.9 + t * 0.35 + fi * 1.3),
          cos(p.x * 0.85 - t * 0.28 + fi * 2.1)
        );
        p = vec2(0.8 * p.x + 0.6 * p.y, -0.6 * p.x + 0.8 * p.y);
      }
      float v = 0.5 + 0.5 * sin(length(p) * 2.2 + p.x * 1.2 - t * 0.6);
      vec3 col = mix(DEEP, PURPLE, smoothstep(0.08, 0.45, v));
      col = mix(col, YELLOW, smoothstep(0.64, 0.80, v));
      col = mix(col, LILAC, smoothstep(0.955, 1.0, v) * 0.8);
      float core = exp(-r * r * 6.0) * smoothstep(0.55, 0.15, v);
      col = mix(col, ORANGE, clamp(core * 1.1, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }`;

  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const swirlEl = $('swirl');
  const stageEl = document.querySelector('.stage');
  let stageW = stageEl.clientWidth, stageH = stageEl.clientHeight;
  // centro do redemoinho: meio da altura mínima do palco (não da altura atual)
  let swirlCenterY = Math.min(window.innerHeight * 0.72, 760) / 2; // = min-height do .stage no CSS
  let drawSwirl = null; // (tempo) => void

  function startShader() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) return false;
    const sh = (type, src) => {
      const o = gl.createShader(type);
      gl.shaderSource(o, src);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, SWIRL_VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, SWIRL_FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      return false;
    }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    const uCenter = gl.getUniformLocation(prog, 'uCenter');
    swirlEl.appendChild(canvas);

    // resolução reduzida: o resultado é suave mesmo ampliado, e leve para a GPU
    const SCALE = 0.5;
    drawSwirl = (t) => {
      const w = Math.max(1, Math.round(stageW * SCALE)), h = Math.max(1, Math.round(stageH * SCALE));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
      gl.uniform2f(uCenter, w / 2, Math.min(swirlCenterY, stageH / 2) * (w / stageW));
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    return true;
  }

  // Rabiscos que flutuam pelo palco e dão a volta pelas bordas.
  const DOODLES = ['house', 'camera', 'frame', 'level', 'key', 'sofa', 'frame', 'house', 'camera', 'level'];
  const doodles = [];
  function placeDoodles() {
    const box = $('doodles');
    const NS = 'http://www.w3.org/2000/svg';
    let seed = 42;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    DOODLES.forEach((id, i) => {
      const size = 64 + rand() * 50;
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 80 80');
      svg.style.width = svg.style.height = size + 'px';
      const use = document.createElementNS(NS, 'use');
      use.setAttribute('href', '#d-' + id);
      svg.appendChild(use);
      box.appendChild(svg);
      const ang = rand() * Math.PI * 2;
      const speed = 10 + rand() * 16; // px/s
      doodles.push({
        el: svg, size,
        x: ((i % 5) / 5 + rand() * 0.15) * stageW,
        y: ((i < 5 ? 0.12 : 0.62) + rand() * 0.25) * stageH,
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        rot: (rand() - 0.5) * 30, spin: (rand() - 0.5) * 14,
        bob: rand() * Math.PI * 2,
      });
    });
    moveDoodles(0, 0);
  }

  function moveDoodles(t, dt) {
    for (const d of doodles) {
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.rot += d.spin * dt;
      const m = d.size;
      if (d.x > stageW + m) d.x = -m; else if (d.x < -m) d.x = stageW + m;
      if (d.y > stageH + m) d.y = -m; else if (d.y < -m) d.y = stageH + m;
      const bob = Math.sin(t * 1.3 + d.bob) * 6;
      const tilt = Math.sin(t * 0.9 + d.bob) * 6;
      d.el.style.transform =
        `translate(${(d.x - m / 2).toFixed(1)}px, ${(d.y - m / 2 + bob).toFixed(1)}px) rotate(${(d.rot + tilt).toFixed(1)}deg)`;
    }
  }

  // traço "fervendo", como desenho à mão
  function boilSketch() {
    const turb = document.querySelector('#sketch feTurbulence');
    if (!turb) return;
    let k = 0;
    setInterval(() => { if (!document.hidden) turb.setAttribute('seed', String(3 + (k++ % 3))); }, 180);
  }

  function startBackground() {
    let shader = false;
    try { shader = startShader(); } catch (e) { shader = false; }
    if (!shader) paintSwirl();
    placeDoodles();

    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        stageW = stageEl.clientWidth; stageH = stageEl.clientHeight;
        swirlCenterY = Math.min(window.innerHeight * 0.72, 760) / 2; // = min-height do .stage no CSS
        if (reduceMotion && drawSwirl) drawSwirl(4);
      }).observe(stageEl);
    }

    if (reduceMotion) {
      if (drawSwirl) drawSwirl(4);
      return;
    }
    boilSketch();
    let last = performance.now();
    const t0 = last;
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      if (drawSwirl) drawSwirl(4 + t * 0.5); // tinta gira devagar
      moveDoodles(t, dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------
  // Abas
  // ------------------------------------------------------------------

  const tabs = [...document.querySelectorAll('.tab')];
  const STAGGER = '.drop-box, .toolbar, .grid > li, .settings > *, .steps > li, .tips';
  let tabTimer = null;

  function enterPanel(panel) {
    panel.hidden = false;
    panel.classList.remove('leaving', 'entering');
    panel.querySelectorAll(STAGGER).forEach((el, i) => {
      el.classList.add('stagger');
      el.style.setProperty('--i', Math.min(i, 12));
    });
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

  const S = { straighten: true, perspective: true, color: true, sharpen: true, maxSide: 4096, quality: 92 };
  try { Object.assign(S, JSON.parse(localStorage.getItem('achooo-opts') || '{}')); } catch (e) { /* sem storage */ }
  const saveS = () => { try { localStorage.setItem('achooo-opts', JSON.stringify(S)); } catch (e) { /* ok */ } };

  const optEls = {
    straighten: $('optStraighten'), perspective: $('optPerspective'),
    color: $('optColor'), sharpen: $('optSharpen'),
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
    useMain = true;
    if (slot && slot.job) { queue.unshift(slot.job); slot.job = null; }
    for (const s of pool) { if (s.job) { queue.unshift(s.job); s.job = null; } s.w.terminate(); }
    pool.length = 0;
    pump();
  }

  function optsFor(item) {
    return {
      straighten: S.straighten && item.auto,
      perspective: S.perspective && item.auto,
      color: S.color,
      sharpen: S.sharpen,
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
    if (useMain) {
      if (!mainBusy && queue.length) runMain(queue.shift());
    } else {
      for (const slot of pool) {
        if (slot.job || !queue.length) continue;
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
      const res = await window.runPipeline(job.item.file, optsFor(job.item), mainEnv);
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
    reprocessTimer = setTimeout(() => { for (const it of items) enqueue(it); }, 250);
  }

  // ------------------------------------------------------------------
  // Adicionar / remover fotos
  // ------------------------------------------------------------------

  function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name));
    if (!files.length) return;
    files.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
    for (const file of files) {
      const item = {
        id: nextId++, file, name: file.name, status: 'queued', version: 0,
        auto: true, extraRoll: 0, blob: null, url: null, thumbUrl: null,
        srcUrl: URL.createObjectURL(file), info: null, error: null,
      };
      items.push(item);
      item.el = buildCard(item);
      $('grid').appendChild(item.el);
      enqueue(item);
    }
    $('drop').hidden = true;
    $('work').hidden = false;
    selectTab(tabs[0]);
    updateStatus();
  }

  function removeItem(item) {
    item.removed = true;
    const qi = queue.findIndex((j) => j.item === item);
    if (qi >= 0) queue.splice(qi, 1);
    for (const u of [item.url, item.thumbUrl, item.srcUrl]) if (u) URL.revokeObjectURL(u);
    item.el.remove();
    items.splice(items.indexOf(item), 1);
    if (!items.length) { $('drop').hidden = false; $('work').hidden = true; }
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

  function updateStatus() {
    const total = items.length;
    const done = items.filter((i) => i.status === 'done').length;
    const errors = items.filter((i) => i.status === 'error').length;
    const pending = total - done - errors;
    $('tabCount').textContent = total ? String(total) : '';
    $('bar').style.width = total ? ((done + errors) / total) * 100 + '%' : '0';
    let txt;
    if (!total) txt = '';
    else if (pending) txt = `Ajustando… ${done + errors} de ${total}`;
    else txt = `${done} ${done === 1 ? 'foto pronta' : 'fotos prontas'}` + (errors ? ` · ${errors} com erro` : '');
    $('statusText').textContent = txt;
    const zip = $('zip');
    if (!zipping) {
      zip.disabled = !done || pending > 0;
      zip.textContent = pending > 0 && done ? 'Aguarde…' : 'Baixar todas (.zip)';
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
    btn.textContent = 'Gerando .zip…';
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
    $('vDownload').disabled = !item.blob;

    const parts = [];
    const i = item.info;
    if (item.status === 'error') parts.push(item.error);
    else if (i) {
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
  startBackground();
  enterPanel($('panel-fotos'));
  initPool();
  updateStatus();
})();
