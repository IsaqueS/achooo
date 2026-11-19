/*
 * core.js — processamento de imagem puro (sem DOM).
 * Funciona no navegador (worker) e no Node (testes).
 *
 * Pipeline:
 *   1. Detecta segmentos de reta numa versão reduzida da foto.
 *   2. Estima o ponto de fuga vertical (RANSAC) → inclinação (roll) e
 *      perspectiva vertical (pitch).
 *   3. Gira a "câmera virtual" para deixar as verticais retas e recorta
 *      o maior retângulo possível (mesma proporção da foto).
 *   4. Corrige balanço de branco, níveis, brilho, contraste, vibração
 *      e aplica uma nitidez leve.
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;

  // ------------------------------------------------------------------
  // Utilidades
  // ------------------------------------------------------------------

  function downscale(src, maxDim) {
    const W = src.width, H = src.height, d = src.data;
    const s = Math.min(1, maxDim / Math.max(W, H));
    const w = Math.max(1, Math.round(W * s));
    const h = Math.max(1, Math.round(H * s));
    if (w === W && h === H) return src;
    const acc = new Float32Array(w * h * 3);
    const cnt = new Float32Array(w * h);
    const xm = new Int32Array(W);
    for (let x = 0; x < W; x++) xm[x] = Math.min(w - 1, ((x * w) / W) | 0);
    for (let y = 0; y < H; y++) {
      const ty = Math.min(h - 1, ((y * h) / H) | 0);
      const row = ty * w;
      let si = y * W * 4;
      for (let x = 0; x < W; x++, si += 4) {
        const ti = row + xm[x];
        acc[ti * 3] += d[si];
        acc[ti * 3 + 1] += d[si + 1];
        acc[ti * 3 + 2] += d[si + 2];
        cnt[ti] += 1;
      }
    }
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = cnt[i] || 1;
      out[i * 4] = acc[i * 3] / c;
      out[i * 4 + 1] = acc[i * 3 + 1] / c;
      out[i * 4 + 2] = acc[i * 3 + 2] / c;
      out[i * 4 + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  function toGray(img) {
    const n = img.width * img.height, d = img.data;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    return g;
  }

  function blur121(src, w, h) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const l = x > 0 ? x - 1 : x, rr = x < w - 1 ? x + 1 : x;
        tmp[r + x] = (src[r + l] + 2 * src[r + x] + src[r + rr]) * 0.25;
      }
    }
    for (let y = 0; y < h; y++) {
      const u = (y > 0 ? y - 1 : y) * w, c = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
      for (let x = 0; x < w; x++) {
        out[c + x] = (tmp[u + x] + 2 * tmp[c + x] + tmp[dn + x]) * 0.25;
      }
    }
    return out;
  }

  // PRNG determinístico (mulberry32) — mesmo resultado sempre.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------
  // 1. Detecção de segmentos (versão simplificada do LSD)
  // ------------------------------------------------------------------

  function detectSegments(gray, w, h) {
    const g = blur121(gray, w, h);
    const n = w * h;
    const mag = new Float32Array(n);
    const ang = new Float32Array(n);
    let maxMag = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1];
        const d = g[i - 1], f = g[i + 1];
        const p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
        const gx = (c + 2 * f + r) - (a + 2 * d + p);
        const gy = (p + 2 * q + r) - (a + 2 * b + c);
        const m = Math.sqrt(gx * gx + gy * gy);
        mag[i] = m;
        // ângulo da linha de nível (perpendicular ao gradiente), mod π
        let t = Math.atan2(gx, -gy);
        if (t < 0) t += Math.PI;
        if (t >= Math.PI) t -= Math.PI;
        ang[i] = t;
        if (m > maxMag) maxMag = m;
      }
    }

    const thr = 28; // Sobel em escala 0..255 (≈ 7 níveis de diferença)
    const tol = 20 * DEG;

    // ordena pixels por magnitude (bucket sort, decrescente)
    const BINS = 1024;
    const scale = maxMag > 0 ? (BINS - 1) / maxMag : 0;
    const counts = new Int32Array(BINS);
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (mag[i] >= thr) { counts[(mag[i] * scale) | 0]++; total++; }
    }
    const start = new Int32Array(BINS);
    let acc = 0;
    for (let b = BINS - 1; b >= 0; b--) { start[b] = acc; acc += counts[b]; }
    const order = new Int32Array(total);
    for (let i = 0; i < n; i++) {
      if (mag[i] >= thr) order[start[(mag[i] * scale) | 0]++] = i;
    }

    const used = new Uint8Array(n);
    const region = new Int32Array(n);
    const minLen = Math.max(12, 0.04 * Math.max(w, h));
    const segs = [];
    const nb = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

    function angDiff(a, b) {
      let d = Math.abs(a - b);
      if (d > Math.PI / 2) d = Math.PI - d;
      return d;
    }

    for (let k = 0; k < total; k++) {
      const seed = order[k];
      if (used[seed]) continue;
      let len = 0;
      region[len++] = seed;
      used[seed] = 1;
      let sc = Math.cos(2 * ang[seed]), ss = Math.sin(2 * ang[seed]);
      let regAng = ang[seed];
      for (let ri = 0; ri < len; ri++) {
        const p = region[ri];
        const px = p % w, py = (p / w) | 0;
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
        for (let j = 0; j < 8; j++) {
          const q = p + nb[j];
          if (used[q] || mag[q] < thr) continue;
          if (angDiff(ang[q], regAng) > tol) continue;
          used[q] = 1;
          region[len++] = q;
          sc += Math.cos(2 * ang[q]);
          ss += Math.sin(2 * ang[q]);
          regAng = 0.5 * Math.atan2(ss, sc);
          if (regAng < 0) regAng += Math.PI;
        }
      }
      if (len < minLen) continue;

      // ajuste de reta por PCA ponderada
      let sw = 0, mx = 0, my = 0;
      for (let ri = 0; ri < len; ri++) {
        const p = region[ri], wt = mag[p];
        sw += wt; mx += wt * (p % w); my += wt * ((p / w) | 0);
      }
      mx /= sw; my /= sw;
      let cxx = 0, cyy = 0, cxy = 0;
      for (let ri = 0; ri < len; ri++) {
        const p = region[ri], wt = mag[p];
        const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
        cxx += wt * dx * dx; cyy += wt * dy * dy; cxy += wt * dx * dy;
      }
      const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      const ux = Math.cos(theta), uy = Math.sin(theta);
      let tmin = Infinity, tmax = -Infinity, nvar = 0;
      for (let ri = 0; ri < len; ri++) {
        const p = region[ri];
        const dx = (p % w) - mx, dy = ((p / w) | 0) - my;
        const t = dx * ux + dy * uy;
        const s = -dx * uy + dy * ux;
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
        nvar += s * s;
      }
      const L = tmax - tmin;
      const width = Math.sqrt(nvar / len);
      if (L < minLen || width > 1.6) continue;
      segs.push({
        x1: mx + tmin * ux, y1: my + tmin * uy,
        x2: mx + tmax * ux, y2: my + tmax * uy,
        len: L, mx: mx, my: my, ux: ux, uy: uy,
      });
    }
    return segs;
  }

  // ------------------------------------------------------------------
  // 2. Ponto de fuga vertical
  // ------------------------------------------------------------------

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  // Menor autovetor de matriz simétrica 3x3 (Jacobi).
  function smallestEigvec(M) {
    const a = [M[0].slice(), M[1].slice(), M[2].slice()];
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-14) break;
      for (let p = 0; p < 2; p++) {
        for (let q = p + 1; q < 3; q++) {
          if (Math.abs(a[p][q]) < 1e-18) continue;
          const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < 3; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq;
            a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < 3; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk;
            a[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < 3; k++) {
            const vkp = v[k][p], vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    let idx = 0;
    if (a[1][1] < a[idx][idx]) idx = 1;
    if (a[2][2] < a[idx][idx]) idx = 2;
    return [v[0][idx], v[1][idx], v[2][idx]];
  }

  /**
   * Estima o ponto de fuga vertical em coordenadas normalizadas
   * (x - cx)/f, (y - cy)/f. Retorna { V, inliers, inlierLen } ou null.
   */
  function verticalVanishingPoint(segs, w, h, f, minAbsY) {
    minAbsY = minAbsY || 1.3;
    const cx = w / 2, cy = h / 2;
    const maxTilt = 32 * DEG;
    const cand = [];
    for (const s of segs) {
      // ângulo em relação à vertical
      const tilt = Math.atan2(Math.abs(s.ux), Math.abs(s.uy));
      if (tilt > maxTilt) continue;
      const p1 = [(s.x1 - cx) / f, (s.y1 - cy) / f, 1];
      const p2 = [(s.x2 - cx) / f, (s.y2 - cy) / f, 1];
      const l = cross(p1, p2);
      const nrm = Math.hypot(l[0], l[1]);
      if (nrm < 1e-12) continue;
      cand.push({
        l: [l[0] / nrm, l[1] / nrm, l[2] / nrm],
        mx: (s.mx - cx) / f, my: (s.my - cy) / f,
        ux: s.ux, uy: s.uy,
        len: s.len / f,
      });
    }
    if (cand.length < 2) return null;

    const sinTol = Math.sin(1.5 * DEG);
    function inlierSet(V) {
      const res = [];
      let sum = 0;
      for (const c of cand) {
        const dx = V[0] - c.mx * V[2], dy = V[1] - c.my * V[2];
        const dn = Math.hypot(dx, dy);
        if (dn < 1e-12) continue;
        const sn = Math.abs(c.ux * dy - c.uy * dx) / dn;
        if (sn <= sinTol) { res.push(c); sum += c.len; }
      }
      return { res, sum };
    }
    function plausible(V) {
      // ponto de fuga precisa estar bem acima/abaixo da imagem
      // (ou no infinito): |y| > 1.3 f  ⇔  inclinação < ~37°
      if (Math.abs(V[2]) < 1e-9) return Math.abs(V[1]) > Math.abs(V[0]);
      const x = V[0] / V[2], y = V[1] / V[2];
      return Math.abs(y) > minAbsY && Math.abs(x) < Math.abs(y) * 0.6;
    }

    const rand = rng(1234567);
    // amostragem ponderada por comprimento
    const cum = [];
    let tot = 0;
    for (const c of cand) { tot += c.len; cum.push(tot); }
    function pick() {
      const r = rand() * tot;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
      return lo;
    }

    let best = null;
    const iters = Math.min(600, cand.length * cand.length);
    for (let it = 0; it < iters; it++) {
      const i = pick();
      let j = pick();
      if (i === j) { j = (i + 1 + ((rand() * (cand.length - 1)) | 0)) % cand.length; }
      if (i === j) continue;
      let V = cross(cand[i].l, cand[j].l);
      const nv = Math.hypot(V[0], V[1], V[2]);
      if (nv < 1e-12) continue;
      V = [V[0] / nv, V[1] / nv, V[2] / nv];
      if (!plausible(V)) continue;
      const s = inlierSet(V);
      if (!best || s.sum > best.sum) best = { V, sum: s.sum, res: s.res };
    }
    if (!best || best.res.length < 2) return null;

    // refinamento por mínimos quadrados (2 passadas)
    let V = best.V, set = best;
    for (let pass = 0; pass < 2; pass++) {
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const c of set.res) {
        const l = c.l, wt = c.len;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += wt * l[a] * l[b];
      }
      const Vn = smallestEigvec(M);
      if (!plausible(Vn)) break;
      const s2 = inlierSet(Vn);
      if (s2.res.length < 2) break;
      V = Vn; set = s2;
    }
    return { V, inliers: set.res.length, inlierLen: set.sum, candidates: cand.length };
  }

  // ------------------------------------------------------------------
  // 3. Geometria (rotação da câmera virtual + recorte)
  // ------------------------------------------------------------------

  function matMul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    }
    return C;
  }

  function matInv(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const k = 1 / det;
    return [
      [A * k, -(b * i - c * h) * k, (b * f - c * e) * k],
      [B * k, (a * i - c * g) * k, -(a * f - c * d) * k],
      [C * k, -(a * h - b * g) * k, (a * e - b * d) * k],
    ];
  }

  function applyH(H, x, y) {
    const X = H[0][0] * x + H[0][1] * y + H[0][2];
    const Y = H[1][0] * x + H[1][1] * y + H[1][2];
    const Z = H[2][0] * x + H[2][1] * y + H[2][2];
    return [X / Z, Y / Z];
  }

  function homographyFor(W, H, f, roll, pitch) {
    const K = [[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]];
    const Ki = [[1 / f, 0, -W / (2 * f)], [0, 1 / f, -H / (2 * f)], [0, 0, 1]];
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const Rz = [[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]];
    const Rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
    return matMul(K, matMul(matMul(Rx, Rz), Ki));
  }

  /**
   * Maior retângulo (proporção W:H) dentro do quadrilátero convexo `quad`.
   * Programação linear em (px, py, s) por enumeração de vértices.
   */
  function inscribedRect(quad, W, H, target) {
    // orientação
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const sgn = area > 0 ? 1 : -1;
    const cons = []; // n·p - s*k >= c
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len = Math.hypot(ex, ey);
      // normal interna
      const nx = (-ey * sgn) / len, ny = (ex * sgn) / len;
      const k = Math.abs(nx) * W / 2 + Math.abs(ny) * H / 2;
      cons.push({ nx, ny, k, c: nx * a[0] + ny * a[1] });
    }
    let best = null;
    for (let skip = 0; skip < 4; skip++) {
      const cs = cons.filter((_, i) => i !== skip);
      const M = cs.map((q) => [q.nx, q.ny, -q.k]);
      const det =
        M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
        M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
        M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      if (Math.abs(det) < 1e-9) continue;
      const Mi = matInv(M);
      const rhs = cs.map((q) => q.c);
      const sol = [0, 1, 2].map((r) => Mi[r][0] * rhs[0] + Mi[r][1] * rhs[1] + Mi[r][2] * rhs[2]);
      const [px, py, s] = sol;
      if (!(s > 0)) continue;
      const ok = cons.every((q) => q.nx * px + q.ny * py - s * q.k >= q.c - 1e-6 * W);
      if (ok && (!best || s > best.s)) best = { px, py, s };
    }
    if (best && target) {
      // com o tamanho máximo fixo, o retângulo ainda pode deslizar (comum na
      // correção de perspectiva). Mantém o enquadramento: centra no ponto onde
      // foi parar o centro da foto original.
      const s = best.s * (1 - 1e-6);
      const slide = (axis, other) => {
        let lo = -Infinity, hi = Infinity;
        for (const q of cons) {
          const a = axis === 0 ? q.nx : q.ny, o = axis === 0 ? q.ny : q.nx;
          const rest = q.c + s * q.k - o * other;
          if (Math.abs(a) < 1e-12) continue;
          if (a > 0) lo = Math.max(lo, rest / a); else hi = Math.min(hi, rest / a);
        }
        return lo <= hi ? Math.min(hi, Math.max(lo, target[axis])) : null;
      };
      let px = best.px, py = best.py;
      for (let it = 0; it < 3; it++) {
        const ny = slide(1, px); if (ny !== null) py = ny;
        const nx = slide(0, py); if (nx !== null) px = nx;
      }
      if (cons.every((q) => q.nx * px + q.ny * py - s * q.k >= q.c - 1e-6 * W)) best = { px, py, s };
    }
    return best;
  }

  function planGeometry(W, H, f, roll, pitch) {
    const Hm = homographyFor(W, H, f, roll, pitch);
    const quad = [[0, 0], [W, 0], [W, H], [0, H]].map((p) => applyH(Hm, p[0], p[1]));
    const r = inscribedRect(quad, W, H, applyH(Hm, W / 2, H / 2));
    if (!r) return null;
    return { Hm, rect: r };
  }

  // ------------------------------------------------------------------
  // Análise completa
  // ------------------------------------------------------------------

  const SRGB2LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    SRGB2LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function lin2srgb(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  function analyzeGeometry(small, W, H, opts) {
    const w = small.width, h = small.height;
    const gray = toGray(small);
    const segs = detectSegments(gray, w, h);
    // distância focal estimada (câmera de celular ~26mm equiv.)
    const f = 0.75 * Math.max(w, h);
    const info = { segments: segs.length, roll: 0, pitch: 0, confidence: 'nenhuma' };
    // busca livre (até ~37°) e busca restrita a inclinações plausíveis (até ~17°)
    const vpAny = verticalVanishingPoint(segs, w, h, f, 1.3);
    const vp = verticalVanishingPoint(segs, w, h, f, 1 / Math.tan(17 * DEG));
    if (vpAny && (!vp || vpAny.inlierLen > 1.6 * vp.inlierLen)) {
      // a hipótese dominante é "câmera muito inclinada" (ex.: foto do piso)
      const V = vpAny.V;
      const pitchAny = Math.atan2(Math.abs(V[2]), Math.hypot(V[0], V[1]));
      if (pitchAny > 16 * DEG) { info.confidence = 'incerta'; return info; }
    }
    if (!vp) return info;

    let [dx, dy, dz] = vp.V;
    if (dy < 0) { dx = -dx; dy = -dy; dz = -dz; }
    const roll = Math.atan2(dx, dy);
    const dy1 = Math.hypot(dx, dy);
    const pitch = Math.atan2(-dz, dy1);

    const heightN = h / f;
    const strong = vp.inliers >= 4 && vp.inlierLen >= 0.6 * heightN;
    const medium = vp.inliers >= 2 && vp.inlierLen >= 0.3 * heightN;
    info.inliers = vp.inliers;
    info.inlierLen = vp.inlierLen / heightN;
    if (!medium) return info;

    // câmera apontada muito para cima/baixo (ex.: foto do piso):
    // as "verticais" provavelmente são linhas do chão — não mexe.
    if (Math.abs(pitch) > 16 * DEG) { info.confidence = 'incerta'; return info; }

    // fotos de celular raramente ficam mais de ~10° tortas; acima disso
    // (ou acima de 5° com pouca evidência) é mais provável erro de detecção
    if (Math.abs(roll) > 10 * DEG || (!strong && Math.abs(roll) > 5 * DEG)) {
      info.confidence = 'incerta';
      return info;
    }

    info.confidence = strong ? 'alta' : 'média';
    info.roll = roll;
    // perspectiva só com evidência forte
    info.pitch = strong ? pitch : 0;
    info.fRatio = f / Math.max(w, h);
    return info;
  }

  function srgb2lin(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  // Estilo de "foto de imobiliária", medido nas fotos de referência
  // (antes → depois): paredes claras (~221/255 no percentil 80), brancos sem
  // estourar (ombro suave), um "S" de contraste, branco levemente quente,
  // cores mais vivas e bastante contraste local.
  const LOOK = {
    keyP: 0.8, // percentil da luminância usado como "parede"
    keyTarget: 217 / 255, // onde a parede deve cair (sRGB)
    white: 10, // ponto branco do Reinhard estendido (ombro)
    contrast: 1.2, // força do "S" (1 = nenhum)
    pivot: 0.5,
    maxGain: 8, // limite de exposição (3 stops)
    minGain: 0.6,
    tint: [1.025, 1, 0.975], // branco levemente quente
    saturation: 0.4,
    whiten: 0.5, // quanto da cor sai das paredes claras
    vibrance: 0,
    clarity: 0.5, // contraste local (raio ~2% do lado maior)
  };

  // luminância linear -> luminância linear
  function toneCurve(y, gain) {
    const t = y * gain, w2 = LOOK.white * LOOK.white;
    let v = (t * (1 + t / w2)) / (1 + t);
    let s = lin2srgb(v);
    const p = LOOK.pivot, a = LOOK.contrast;
    s = s < p ? p * Math.pow(s / p, a) : 1 - (1 - p) * Math.pow((1 - s) / (1 - p), a);
    return srgb2lin(s);
  }

  function analyzeColor(small) {
    const n = small.width * small.height, d = small.data;
    // --- balanço de branco: "white patch" nos pixels neutros mais claros
    const lums = [];
    const cands = [];
    for (let i = 0; i < n; i++) {
      const r = SRGB2LIN[d[i * 4]], g = SRGB2LIN[d[i * 4 + 1]], b = SRGB2LIN[d[i * 4 + 2]];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 0.97 || mx < 0.04) continue;
      if ((mx - mn) / mx > 0.32) continue;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lums.push(L);
      cands.push(i);
    }
    let gains = [1, 1, 1];
    let wbSource = 'nenhum';
    if (cands.length > n * 0.01) {
      const sorted = Float32Array.from(lums).sort();
      const cut = sorted[Math.floor(sorted.length * 0.5)];
      const top = sorted[Math.floor(sorted.length * 0.97)];
      let R = 0, G = 0, B = 0, c = 0;
      for (let k = 0; k < cands.length; k++) {
        if (lums[k] < cut || lums[k] > top) continue;
        const i = cands[k];
        R += SRGB2LIN[d[i * 4]]; G += SRGB2LIN[d[i * 4 + 1]]; B += SRGB2LIN[d[i * 4 + 2]];
        c++;
      }
      if (c > 0) {
        const m = (R + G + B) / 3;
        gains = [m / R, m / G, m / B];
        wbSource = 'neutros';
      }
    }
    // esfriar (tirar o amarelado) é bem-vindo; esquentar raramente é —
    // em luz mista (janela + lâmpada) o branco "neutro" engana.
    const warming = gains[0] > gains[2];
    const strength = warming ? 0.25 : 0.8;
    gains = gains.map((g, i) => Math.min(1.25, Math.max(0.8, 1 + (g - 1) * strength)) * LOOK.tint[i]);
    const norm = 0.2126 * gains[0] + 0.7152 * gains[1] + 0.0722 * gains[2];
    gains = gains.map((g) => g / norm);

    // --- exposição: leva a "parede" (percentil 80) até o alvo
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      Y[i] = 0.2126 * SRGB2LIN[d[i * 4]] * gains[0] + 0.7152 * SRGB2LIN[d[i * 4 + 1]] * gains[1] +
        0.0722 * SRGB2LIN[d[i * 4 + 2]] * gains[2];
    }
    Y.sort();
    const key = Math.max(1e-4, Y[Math.floor(n * LOOK.keyP)]);
    let lo = LOOK.minGain, hi = LOOK.maxGain;
    const want = srgb2lin(LOOK.keyTarget);
    if (toneCurve(key, hi) < want) lo = hi;
    else if (toneCurve(key, lo) > want) hi = lo;
    else for (let it = 0; it < 30; it++) {
      const m = (lo + hi) / 2;
      if (toneCurve(key, m) < want) lo = m; else hi = m;
    }
    const gain = (lo + hi) / 2;

    return {
      gains, gain, wbSource, key: lin2srgb(key),
      saturation: LOOK.saturation, vibrance: LOOK.vibrance, clarity: LOOK.clarity,
    };
  }

  // razão tom(Y)/Y indexada por sqrt(Y / 1.5)
  const TONE_N = 4096, TONE_MAX = 1.5;
  function buildToneLUT(gain) {
    const lut = new Float32Array(TONE_N + 1);
    for (let i = 0; i <= TONE_N; i++) {
      const y = Math.max(1e-6, (i / TONE_N) * (i / TONE_N) * TONE_MAX);
      lut[i] = toneCurve(y, gain) / y;
    }
    return lut;
  }
  let LIN2SRGB8 = null;
  function lin2srgb8() {
    if (!LIN2SRGB8) {
      LIN2SRGB8 = new Uint8ClampedArray(65536);
      for (let i = 0; i < 65536; i++) LIN2SRGB8[i] = Math.round(lin2srgb(i / 65535) * 255);
    }
    return LIN2SRGB8;
  }

  // ------------------------------------------------------------------
  // 4. Renderização
  // ------------------------------------------------------------------

  function warp(src, Hm, rect, outW, outH) {
    const W = src.width, H = src.height, sd = src.data;
    const out = new Uint8ClampedArray(outW * outH * 4);
    const Hi = matInv(Hm);
    // ponto do plano corrigido para o pixel (u, v) da saída
    const s = (rect.s * W) / outW;
    const ox = rect.px - (rect.s * W) / 2, oy = rect.py - (rect.s * H) / 2;
    // composição: src = Hi * T, T(u,v) = (ox + (u+.5)s, oy + (v+.5)s)
    const a = Hi[0][0] * s, b = Hi[0][1] * s, c = Hi[0][0] * (ox + 0.5 * s) + Hi[0][1] * (oy + 0.5 * s) + Hi[0][2];
    const d = Hi[1][0] * s, e = Hi[1][1] * s, f = Hi[1][0] * (ox + 0.5 * s) + Hi[1][1] * (oy + 0.5 * s) + Hi[1][2];
    const g = Hi[2][0] * s, h = Hi[2][1] * s, k = Hi[2][0] * (ox + 0.5 * s) + Hi[2][1] * (oy + 0.5 * s) + Hi[2][2];
    const W1 = W - 1, H1 = H - 1, rowStride = W * 4;
    let o = 0;
    for (let v = 0; v < outH; v++) {
      let X = b * v + c, Y = e * v + f, Z = h * v + k;
      for (let u = 0; u < outW; u++, o += 4) {
        const iz = 1 / Z;
        let x = X * iz - 0.5, y = Y * iz - 0.5;
        X += a; Y += d; Z += g;
        if (x < 0) x = 0; else if (x > W1) x = W1;
        if (y < 0) y = 0; else if (y > H1) y = H1;
        const x0 = x | 0, y0 = y | 0;
        const fx = x - x0, fy = y - y0;
        const x1 = x0 < W1 ? 4 : 0, y1 = y0 < H1 ? rowStride : 0;
        const i00 = y0 * rowStride + x0 * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o] = sd[i00] * w00 + sd[i00 + x1] * w10 + sd[i00 + y1] * w01 + sd[i00 + y1 + x1] * w11;
        out[o + 1] = sd[i00 + 1] * w00 + sd[i00 + x1 + 1] * w10 + sd[i00 + y1 + 1] * w01 + sd[i00 + y1 + x1 + 1] * w11;
        out[o + 2] = sd[i00 + 2] * w00 + sd[i00 + x1 + 2] * w10 + sd[i00 + y1 + 2] * w01 + sd[i00 + y1 + x1 + 2] * w11;
        out[o + 3] = 255;
      }
    }
    return { width: outW, height: outH, data: out };
  }

  // 1) balanço de branco + curva tonal na luminância (preserva o matiz)
  function applyTone(img, col) {
    const d = img.data, n = img.width * img.height;
    const lut = buildToneLUT(col.gain), out8 = lin2srgb8();
    const g0 = col.gains[0], g1 = col.gains[1], g2 = col.gains[2];
    const sc = TONE_N / Math.sqrt(TONE_MAX);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      let r = SRGB2LIN[d[o]], g = SRGB2LIN[d[o + 1]], b = SRGB2LIN[d[o + 2]];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      // brancos estourados (janela, lâmpada) continuam brancos
      let gr = g0, gg = g1, gb = g2;
      if (mx > 0.8) {
        const w = mx >= 1 ? 1 : (mx - 0.8) / 0.2;
        gr += (1 - gr) * w; gg += (1 - gg) * w; gb += (1 - gb) * w;
      }
      r *= gr; g *= gg; b *= gb;
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      let k = (Math.sqrt(y) * sc) | 0;
      if (k > TONE_N) k = TONE_N;
      const ratio = lut[k];
      r *= ratio; g *= ratio; b *= ratio;
      const y2 = y * ratio;
      const m2 = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (m2 > 1) {
        // cor forte demais para o brilho: puxa para o branco mantendo a luminância
        const s = y2 >= 1 ? 0 : (1 - y2) / (m2 - y2);
        r = y2 + (r - y2) * s; g = y2 + (g - y2) * s; b = y2 + (b - y2) * s;
      }
      d[o] = out8[(r >= 1 ? 65535 : r <= 0 ? 0 : (r * 65535) | 0)];
      d[o + 1] = out8[(g >= 1 ? 65535 : g <= 0 ? 0 : (g * 65535) | 0)];
      d[o + 2] = out8[(b >= 1 ? 65535 : b <= 0 ? 0 : (b * 65535) | 0)];
    }
  }

  // desfoque de caixa separável (3 passadas ≈ gaussiana)
  function boxBlur(src, w, h, r) {
    const a = new Float32Array(src), t = new Float32Array(w * h);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let s = 0;
        for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          t[row + x] = s / (2 * r + 1);
          s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = s / (2 * r + 1);
          s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  // 2) contraste local ("clareza") + saturação/vibração
  function applyLocal(img, col) {
    const W = img.width, H = img.height, d = img.data;
    const clarity = col.clarity || 0;
    let base = null, bw = 0, bh = 0, f = 1;
    if (clarity > 0) {
      // mapa de luminância reduzido (~400 px) e desfocado
      f = Math.max(1, Math.round(Math.max(W, H) / 400));
      bw = Math.ceil(W / f); bh = Math.ceil(H / f);
      const sum = new Float32Array(bw * bh), cnt = new Float32Array(bw * bh);
      for (let y = 0; y < H; y++) {
        const by = ((y / f) | 0) * bw;
        for (let x = 0, o = y * W * 4; x < W; x++, o += 4) {
          const k = by + ((x / f) | 0);
          sum[k] += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
          cnt[k]++;
        }
      }
      for (let k = 0; k < sum.length; k++) sum[k] /= cnt[k];
      const r = Math.max(2, Math.round(Math.max(bw, bh) * 0.012));
      base = boxBlur(sum, bw, bh, r);
    }
    const sat = col.saturation || 0, vib = col.vibrance || 0;
    for (let y = 0, o = 0; y < H; y++) {
      // coordenada no mapa reduzido (centros de célula)
      let fy = (y + 0.5) / f - 0.5, y0 = Math.floor(fy);
      let ty = fy - y0;
      if (y0 < 0) { y0 = 0; ty = 0; }
      if (y0 >= bh - 1) { y0 = bh - 1; ty = 0; }
      const y1 = Math.min(bh - 1, y0 + 1);
      for (let x = 0; x < W; x++, o += 4) {
        let r = d[o], g = d[o + 1], b = d[o + 2];
        if (base) {
          let fx = (x + 0.5) / f - 0.5, x0 = Math.floor(fx);
          let tx = fx - x0;
          if (x0 < 0) { x0 = 0; tx = 0; }
          if (x0 >= bw - 1) { x0 = bw - 1; tx = 0; }
          const x1 = Math.min(bw - 1, x0 + 1);
          const B = (base[y0 * bw + x0] * (1 - tx) + base[y0 * bw + x1] * tx) * (1 - ty) +
            (base[y1 * bw + x0] * (1 - tx) + base[y1 * bw + x1] * tx) * ty;
          const L = 0.299 * r + 0.587 * g + 0.114 * b;
          const diff = L - B, ln = L / 255;
          // mais forte nos meios-tons; contido em bordas fortes (evita halo)
          const w = clarity * (0.35 + 2.6 * ln * (1 - ln)) / (1 + (diff * diff) / 1600);
          let delta = diff * w;
          if (delta > 28) delta = 28; else if (delta < -28) delta = -28;
          r += delta; g += delta; b += delta;
        }
        if (sat || vib) {
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
          const s = mx > 0 ? (mx - mn) / Math.max(mx, 1) : 0;
          // satura as cores fortes (porta, madeira, quadros); tons quase
          // neutros (parede sob luz amarela) ficam como estão
          let ramp = (s - 0.12) / 0.3;
          ramp = ramp < 0 ? 0 : ramp > 1 ? 1 : ramp;
          // amarelo satura fácil demais (madeira clara, luz de lâmpada)
          const yel = mx > mn ? ((r < g ? r : g) - b) / (mx - mn) : 0;
          let amt = sat * ramp * (yel > 0 ? 1 - 0.6 * yel : 1) + vib * (1 - s) * (1 - s);
          // paredes claras ficam brancas: tira parte da cor de tons claros e pouco saturados
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          let wt = (lum - 0.5) / 0.3;
          wt = wt < 0 ? 0 : wt > 1 ? 1 : wt;
          let pale = 1 - (s - 0.25) / 0.3;
          pale = pale < 0 ? 0 : pale > 1 ? 1 : pale;
          amt -= LOOK.whiten * wt * pale;
          const yy = 0.299 * r + 0.587 * g + 0.114 * b;
          r = yy + (r - yy) * (1 + amt);
          g = yy + (g - yy) * (1 + amt);
          b = yy + (b - yy) * (1 + amt);
        }
        d[o] = r; d[o + 1] = g; d[o + 2] = b;
      }
    }
  }

  function sharpen(img, amount) {
    const w = img.width, h = img.height, d = img.data;
    const src = new Uint8ClampedArray(d);
    const rs = w * 4;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * rs + x * 4;
        for (let c = 0; c < 3; c++) {
          const p = i + c;
          const blur =
            (src[p - rs - 4] + 2 * src[p - rs] + src[p - rs + 4] +
              2 * src[p - 4] + 4 * src[p] + 2 * src[p + 4] +
              src[p + rs - 4] + 2 * src[p + rs] + src[p + rs + 4]) / 16;
          // "coring": ignora diferenças mínimas (ruído/JPEG)
          let diff = src[p] - blur;
          diff = diff > 3 ? diff - 3 : diff < -3 ? diff + 3 : 0;
          d[p] = src[p] + amount * diff;
        }
      }
    }
  }

  /**
   * Processa uma foto.
   * @param src    {width, height, data: Uint8ClampedArray RGBA} — resolução final
   * @param small  versão reduzida (~900px) para análise (opcional)
   * @param opts   { straighten, perspective, color, sharpen, extraRoll (graus) }
   */
  function processImage(src, small, opts) {
    opts = Object.assign(
      { straighten: true, perspective: true, color: true, sharpen: true, extraRoll: 0 },
      opts || {}
    );
    if (!small) small = downscale(src, 900);
    const W = src.width, H = src.height;
    const info = { width: W, height: H };

    // --- geometria
    let roll = 0, pitch = 0;
    if (opts.straighten || opts.perspective || opts.extraRoll) {
      const g = analyzeGeometry(small, W, H, opts);
      info.detection = g;
      if (opts.straighten) roll = g.roll;
      if (opts.perspective) pitch = g.pitch;
      roll = Math.max(-10 * DEG, Math.min(10 * DEG, roll));
      pitch = Math.max(-16 * DEG, Math.min(16 * DEG, pitch));
      if (Math.abs(roll) < 0.1 * DEG) roll = 0;
      if (Math.abs(pitch) < 0.6 * DEG) pitch = 0;
      roll += (opts.extraRoll || 0) * DEG;
    }
    let out;
    info.roll = 0; info.pitch = 0; info.crop = 1;
    if (roll !== 0 || pitch !== 0) {
      const f = 0.75 * Math.max(W, H);
      // reduz a intensidade se o recorte ficar grande demais
      let k = 1, plan = planGeometry(W, H, f, roll, pitch);
      const minScale = 0.82;
      if (!plan || plan.rect.s < minScale) {
        let lo = 0, hi = 1;
        for (let it = 0; it < 18; it++) {
          const mid = (lo + hi) / 2;
          const p = planGeometry(W, H, f, roll * mid, pitch * mid);
          if (p && p.rect.s >= minScale) lo = mid; else hi = mid;
        }
        k = lo;
        plan = planGeometry(W, H, f, roll * k, pitch * k);
      }
      if (plan && k > 0.05) {
        out = warp(src, plan.Hm, plan.rect, W, H);
        info.roll = (roll * k) / DEG;
        info.pitch = (pitch * k) / DEG;
        info.crop = plan.rect.s;
        info.strength = k;
      }
    }
    if (!out) out = { width: W, height: H, data: new Uint8ClampedArray(src.data) };

    // --- cor e luz
    if (opts.color) {
      const col = analyzeColor(small);
      info.color = col;
      applyTone(out, col);
      applyLocal(out, col);
    }
    if (opts.sharpen) sharpen(out, 1.1);
    return { image: out, info };
  }

  const api = { processImage, downscale, detectSegments, verticalVanishingPoint, toGray, LOOK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PhotoCore = api;
})(typeof self !== 'undefined' ? self : this);
