/*
 * watermark.js — detecção e remoção automática de marca d'água em lote (sem DOM).
 * Funciona no navegador (worker ou página) e em testes CLI (Node / GJS).
 *
 * Como funciona (genérico para qualquer marca d'água repetida no lote):
 *   1. Pass 1 (detecção rápida em baixa resolução, memória O(1)):
 *      Acumula consistência de sinal e magnitude do gradiente entre as fotos
 *      do grupo de resolução dominante para localizar a(s) região(ões) onde
 *      existe uma marca estática repetida (centro, cantos ou múltiplas).
 *   2. Pass 2 (estimação em resolução total apenas nos recortes encontrados):
 *      - Integração de Poisson com atenuação (screened Poisson) para isolar a
 *        máscara exata dos traços e letras sem vazar para o fundo.
 *      - Regressão robusta (Berkson IRLS) separada em Y (luma em resolução
 *        cheia) e Cb/Cr (croma, lidando com subamostragem 4:2:0 do JPEG),
 *        em 2 rodadas, descartando pixels saturados.
 *      - Suavização bilateral leve do modelo estimado (aY, cY, aC, cCb, cCr)
 *        para eliminar ruído de estimação mantendo bordas nítidas.
 *   3. Aplicação por foto:
 *      - Localiza e valida a presença da marca por correlação de gradientes
 *        (NCC), suportando fotos com resoluções/proporções diferentes e pulando
 *        fotos sem marca.
 *      - Calibração fina de resíduo de borda por foto + inversão exata do
 *        alpha blending em YCbCr (com fallback harmônico para regiões opacas
 *        ou estouradas).
 *      - Polimento direcional nas bordas de 1 px (anelamento DCT do JPEG) e
 *        suavização bilateral leve preservando bordas reais da cena.
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Utilidades de imagem e cor (YCbCr BT.601, Cb/Cr centrados em 0)
  // ------------------------------------------------------------------

  function cropRGBA(img, x0, y0, cw, ch) {
    const out = new Uint8ClampedArray(cw * ch * 4);
    const iw = img.width, ih = img.height, d = img.data;
    for (let y = 0; y < ch; y++) {
      let sy = y0 + y;
      if (sy < 0) sy = 0; else if (sy >= ih) sy = ih - 1;
      const srow = sy * iw, drow = y * cw;
      for (let x = 0; x < cw; x++) {
        let sx = x0 + x;
        if (sx < 0) sx = 0; else if (sx >= iw) sx = iw - 1;
        const si = (srow + sx) * 4, di = (drow + x) * 4;
        out[di] = d[si];
        out[di + 1] = d[si + 1];
        out[di + 2] = d[si + 2];
        out[di + 3] = 255;
      }
    }
    return out;
  }

  function rgbaToYCbCr(rgba, n) {
    const Y = new Float32Array(n);
    const Cb = new Float32Array(n);
    const Cr = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      Y[i]  =  0.299 * r + 0.587 * g + 0.114 * b;
      Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      Cr[i] =  0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    return { Y, Cb, Cr };
  }

  function dilate(m, w, h, radius) {
    let cur = m;
    for (let r = 0; r < radius; r++) {
      const nxt = new Uint8Array(cur);
      for (let y = 1; y < h - 1; y++) {
        const row = y * w;
        for (let x = 1; x < w - 1; x++) {
          const i = row + x;
          if (cur[i] || cur[i - 1] || cur[i + 1] || cur[i - w] || cur[i + w] ||
              cur[i - w - 1] || cur[i - w + 1] || cur[i + w - 1] || cur[i + w + 1]) {
            nxt[i] = 1;
          }
        }
      }
      cur = nxt;
    }
    return cur;
  }

  function clearBorder(m, w, h, b) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (x < b || x >= w - b || y < b || y >= h - b) m[row + x] = 0;
      }
    }
  }

  // Interpolação harmônica (Laplace = 0) em Y, Cb, Cr para pixels mascarados
  function harmonicFillYCC(ycc, m, w, h, iters) {
    const n = w * h;
    const fY = new Float32Array(ycc.Y);
    const fCb = new Float32Array(ycc.Cb);
    const fCr = new Float32Array(ycc.Cr);
    const maskIdx = [];
    const known = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (m[i]) maskIdx.push(i);
      else known[i] = 1;
    }
    // Inicialização em camadas a partir da borda limpa (acelera muito o SOR)
    let rem = maskIdx.length;
    while (rem > 0) {
      let prog = 0;
      const added = [];
      for (let k = 0; k < maskIdx.length; k++) {
        const i = maskIdx[k];
        if (known[i]) continue;
        let sy = 0, sb = 0, sr = 0, cnt = 0;
        if (known[i - 1]) { sy += fY[i - 1]; sb += fCb[i - 1]; sr += fCr[i - 1]; cnt++; }
        if (known[i + 1]) { sy += fY[i + 1]; sb += fCb[i + 1]; sr += fCr[i + 1]; cnt++; }
        if (known[i - w]) { sy += fY[i - w]; sb += fCb[i - w]; sr += fCr[i - w]; cnt++; }
        if (known[i + w]) { sy += fY[i + w]; sb += fCb[i + w]; sr += fCr[i + w]; cnt++; }
        if (cnt > 0) {
          const ic = 1 / cnt;
          fY[i] = sy * ic; fCb[i] = sb * ic; fCr[i] = sr * ic;
          added.push(i); prog++;
        }
      }
      for (let k = 0; k < added.length; k++) known[added[k]] = 1;
      rem -= prog;
      if (!prog) break;
    }
    const om = 1.65;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < maskIdx.length; k++) {
        const i = maskIdx[k];
        fY[i]  += om * (0.25 * (fY[i - 1]  + fY[i + 1]  + fY[i - w]  + fY[i + w])  - fY[i]);
        fCb[i] += om * (0.25 * (fCb[i - 1] + fCb[i + 1] + fCb[i - w] + fCb[i + w]) - fCb[i]);
        fCr[i] += om * (0.25 * (fCr[i - 1] + fCr[i + 1] + fCr[i - w] + fCr[i + w]) - fCr[i]);
      }
    }
    return { Y: fY, Cb: fCb, Cr: fCr };
  }

  // ------------------------------------------------------------------
  // Pass 1: Detector incremental (memória O(1) em resolução reduzida)
  // ------------------------------------------------------------------

  function createDetector(refW, refH) {
    const detScale = Math.min(1, 720 / Math.max(refW, refH));
    const dw = Math.max(32, Math.round(refW * detScale));
    const dh = Math.max(32, Math.round(refH * detScale));
    const sumSx = new Float32Array(dw * dh);
    const sumSy = new Float32Array(dw * dh);
    const sumGx = new Float32Array(dw * dh);
    const sumGy = new Float32Array(dw * dh);
    const lum = new Float32Array(dw * dh);
    let count = 0;

    function addFrameRGBA(rgba) {
      for (let i = 0, p = 0; i < dw * dh; i++, p += 4) {
        lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      }
      for (let y = 0; y < dh - 1; y++) {
        const r = y * dw;
        for (let x = 0; x < dw - 1; x++) {
          const i = r + x;
          const gx = lum[i + 1] - lum[i];
          const gy = lum[i + dw] - lum[i];
          sumSx[i] += gx / Math.sqrt(gx * gx + 16);
          sumSy[i] += gy / Math.sqrt(gy * gy + 16);
          sumGx[i] += gx > 45 ? 45 : gx < -45 ? -45 : gx;
          sumGy[i] += gy > 45 ? 45 : gy < -45 ? -45 : gy;
        }
      }
      count++;
    }

    // Extrai caixas delimitadoras (em coordenadas full-res) de todas as marcas detectadas
    function finalize() {
      if (count < 3) return [];
      const invN = 1 / count;
      // Limiar adaptativo ao número de fotos (evita falso positivo com poucas fotos)
      const minSign = count >= 14 ? 0.38 : count >= 8 ? 0.44 : count >= 5 ? 0.52 : 0.64;
      const minGrad = count >= 8 ? 2.6 : 3.4;
      const minSign2 = minSign * minSign;
      const minGrad2 = minGrad * minGrad;

      const rawHit = new Uint8Array(dw * dh);
      for (let y = 2; y < dh - 2; y++) {
        const r = y * dw;
        for (let x = 2; x < dw - 2; x++) {
          const i = r + x;
          const sx = sumSx[i] * invN, sy = sumSy[i] * invN;
          const gx = sumGx[i] * invN, gy = sumGy[i] * invN;
          if (sx * sx + sy * sy > minSign2 && gx * gx + gy * gy > minGrad2) rawHit[i] = 1;
        }
      }

      // Filtro de densidade 5x5: elimina pixels isolados de ruído/gradiente de teto-chão
      const cleanHit = new Uint8Array(dw * dh);
      let totalClean = 0;
      for (let y = 3; y < dh - 3; y++) {
        const r = y * dw;
        for (let x = 3; x < dw - 3; x++) {
          if (!rawHit[r + x]) continue;
          let nb = 0;
          for (let dy = -2; dy <= 2; dy++) {
            const rr = (y + dy) * dw;
            for (let dx = -2; dx <= 2; dx++) nb += rawHit[rr + x + dx];
          }
          if (nb >= 4) { cleanHit[r + x] = 1; totalClean++; }
        }
      }
      if (totalClean < 25) return [];

      // Componentes conectados dilatados para agrupar letras/traços de cada marca
      const grouped = dilate(cleanHit, dw, dh, 8);
      const vis = new Uint8Array(dw * dh);
      const boxes = [];
      const qx = new Int32Array(dw * dh);
      const qy = new Int32Array(dw * dh);

      for (let y = 2; y < dh - 2; y++) {
        for (let x = 2; x < dw - 2; x++) {
          const start = y * dw + x;
          if (!grouped[start] || vis[start]) continue;
          let head = 0, tail = 0;
          qx[tail] = x; qy[tail] = y; tail++;
          vis[start] = 1;
          let x0 = dw, x1 = -1, y0 = dh, y1 = -1, hits = 0;
          while (head < tail) {
            const cx = qx[head], cy = qy[head]; head++;
            const ci = cy * dw + cx;
            if (cleanHit[ci]) {
              hits++;
              if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
              if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
            }
            if (cx > 1 && grouped[ci - 1] && !vis[ci - 1]) { vis[ci - 1] = 1; qx[tail] = cx - 1; qy[tail] = cy; tail++; }
            if (cx < dw - 2 && grouped[ci + 1] && !vis[ci + 1]) { vis[ci + 1] = 1; qx[tail] = cx + 1; qy[tail] = cy; tail++; }
            if (cy > 1 && grouped[ci - dw] && !vis[ci - dw]) { vis[ci - dw] = 1; qx[tail] = cx; qy[tail] = cy - 1; tail++; }
            if (cy < dh - 2 && grouped[ci + dw] && !vis[ci + dw]) { vis[ci + dw] = 1; qx[tail] = cx; qy[tail] = cy + 1; tail++; }
          }
          if (hits >= 25 && x1 >= x0 && y1 >= y0) {
            boxes.push({ x0, y0, x1, y1, hits });
          }
        }
      }

      if (!boxes.length) return [];

      // Mescla caixas muito próximas (ex.: ícone acima do texto)
      const mergeGap = Math.max(10, Math.round(Math.min(dw, dh) * 0.045));
      let merged = true;
      while (merged) {
        merged = false;
        for (let i = 0; i < boxes.length && !merged; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            if (a.x0 - mergeGap <= b.x1 && b.x0 - mergeGap <= a.x1 &&
                a.y0 - mergeGap <= b.y1 && b.y0 - mergeGap <= a.y1) {
              a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
              a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
              a.hits += b.hits;
              boxes.splice(j, 1);
              merged = true;
              break;
            }
          }
        }
      }

      // Converte para coordenadas full-res com margem de segurança
      const sxInv = refW / dw, syInv = refH / dh;
      const pad = Math.max(16, Math.round(Math.max(refW, refH) * 0.015));
      const out = [];
      for (const b of boxes) {
        const fx0 = Math.max(0, Math.floor(b.x0 * sxInv) - pad);
        const fy0 = Math.max(0, Math.floor(b.y0 * syInv) - pad);
        const fx1 = Math.min(refW, Math.ceil((b.x1 + 1) * sxInv) + pad);
        const fy1 = Math.min(refH, Math.ceil((b.y1 + 1) * syInv) + pad);
        const bw = fx1 - fx0, bh = fy1 - fy0;
        // Ignora regiões absurdamente grandes (> 65% da foto = provável moldura/erro)
        if (bw < 16 || bh < 16) continue;
        if (bw * bh > refW * refH * 0.65) continue;
        out.push({ x0: fx0, y0: fy0, bw, bh, hits: b.hits });
      }
      out.sort((a, b) => b.hits - a.hits);
      return out.slice(0, 4); // no máximo 4 marcas distintas por foto
    }

    return { dw, dh, detScale, addFrameRGBA, finalize };
  }

  // ------------------------------------------------------------------
  // Pass 2: Estimação YCbCr Berkson IRLS em resolução total
  // ------------------------------------------------------------------

  function estimateYCC(cropsYCC, cropsRGBA, m, w, h) {
    const n = cropsYCC.length;
    const fills = cropsYCC.map((c) => harmonicFillYCC(c, m, w, h, 35));
    const sz = w * h;
    const aY = new Float32Array(sz); aY.fill(1);
    const cY = new Float32Array(sz);
    const aC = new Float32Array(sz); aC.fill(1);
    const cCb = new Float32Array(sz);
    const cCr = new Float32Array(sz);
    const wY = new Float32Array(n);
    const wC = new Float32Array(n);

    for (let i = 0; i < sz; i++) {
      if (!m[i]) continue;
      let valid = 0;
      for (let k = 0; k < n; k++) {
        const d = cropsRGBA[k], p = i * 4;
        const clipped = (d[p] >= 253 || d[p + 1] >= 253 || d[p + 2] >= 253 ||
                         d[p] <= 2   || d[p + 1] <= 2   || d[p + 2] <= 2);
        wY[k] = clipped ? 0 : 1;
        wC[k] = clipped ? 0 : 1;
        if (!clipped) valid++;
      }
      const useClipFilter = valid >= Math.max(3, n * 0.25);
      if (!useClipFilter) { wY.fill(1); wC.fill(1); }

      let ay = 1, cy = 0;
      for (let ir = 0; ir < 5; ir++) {
        let sw = 0, sx = 0, sy = 0;
        for (let k = 0; k < n; k++) {
          const wk = wY[k]; if (!wk) continue;
          sw += wk; sx += wk * fills[k].Y[i]; sy += wk * cropsYCC[k].Y[i];
        }
        if (sw < 1e-3) break;
        const mx = sx / sw, my = sy / sw;
        let num = 0, den = 0;
        for (let k = 0; k < n; k++) {
          const wk = wY[k]; if (!wk) continue;
          const dx = fills[k].Y[i] - mx;
          num += wk * dx * (cropsYCC[k].Y[i] - my);
          den += wk * dx * dx;
        }
        ay = den > 20 ? num / den : 1;
        if (ay < 0.02) ay = 0.02;
        if (ay > 1) ay = 1;
        cy = my - ay * mx;
        const maxC = 255 * (1 - ay);
        if (cy < 0) cy = 0; else if (cy > maxC) cy = maxC;

        const delta = 6.0;
        for (let k = 0; k < n; k++) {
          if (useClipFilter && wY[k] === 0) continue;
          const r = Math.abs(cropsYCC[k].Y[i] - (ay * fills[k].Y[i] + cy));
          wY[k] = r <= delta ? 1 : delta / r;
        }
      }

      // Validação estatística: rejeita pixels de fundo sem deslocamento consistente
      let posDiff = 0, negDiff = 0, errId = 0, errFit = 0, cnt = 0;
      for (let k = 0; k < n; k++) {
        if (useClipFilter && wY[k] === 0) continue;
        const diff = cropsYCC[k].Y[i] - fills[k].Y[i];
        const fitErr = cropsYCC[k].Y[i] - (ay * fills[k].Y[i] + cy);
        if (diff > 1.5) posDiff++;
        else if (diff < -1.5) negDiff++;
        errId += Math.min(40, Math.abs(diff));
        errFit += Math.min(40, Math.abs(fitErr));
        cnt++;
      }
      const signCons = Math.abs(posDiff - negDiff) / (cnt || 1);
      const meanImp = (errId - errFit) / (cnt || 1);
      const alphaY = 1 - ay;

      let ac = 1, cb0 = 0, cr0 = 0;
      const isLumaWm = (alphaY > 0.03 && meanImp > 1.8 && signCons > 0.45) ||
                       (alphaY > 0.10 && meanImp > 3.0);

      if (isLumaWm || alphaY > 0.02) {
        for (let ir = 0; ir < 4; ir++) {
          let sw = 0, sxb = 0, syb = 0, sxr = 0, syr = 0;
          for (let k = 0; k < n; k++) {
            const wk = wC[k]; if (!wk) continue;
            sw += wk;
            sxb += wk * fills[k].Cb[i]; syb += wk * cropsYCC[k].Cb[i];
            sxr += wk * fills[k].Cr[i]; syr += wk * cropsYCC[k].Cr[i];
          }
          if (sw < 1e-3) break;
          const mxb = sxb / sw, myb = syb / sw;
          const mxr = sxr / sw, myr = syr / sw;
          let num = 0, den = 0;
          for (let k = 0; k < n; k++) {
            const wk = wC[k]; if (!wk) continue;
            const dxb = fills[k].Cb[i] - mxb;
            const dxr = fills[k].Cr[i] - mxr;
            num += wk * (dxb * (cropsYCC[k].Cb[i] - myb) + dxr * (cropsYCC[k].Cr[i] - myr));
            den += wk * (dxb * dxb + dxr * dxr);
          }
          const priorW = 140;
          const priorA = Math.min(1, Math.max(ay, 0.5 * (ay + 1)));
          ac = (num + priorW * priorA) / (den + priorW);
          if (ac < Math.max(0.05, ay * 0.92)) ac = Math.max(0.05, ay * 0.92);
          if (ac > 1) ac = 1;
          cb0 = myb - ac * mxb;
          cr0 = myr - ac * mxr;
          const maxCh = 128 * (1 - Math.min(ay, ac));
          cb0 = Math.max(-maxCh, Math.min(maxCh, cb0));
          cr0 = Math.max(-maxCh, Math.min(maxCh, cr0));

          const delta = 4.0;
          for (let k = 0; k < n; k++) {
            if (useClipFilter && wC[k] === 0) continue;
            const rb = cropsYCC[k].Cb[i] - (ac * fills[k].Cb[i] + cb0);
            const rr = cropsYCC[k].Cr[i] - (ac * fills[k].Cr[i] + cr0);
            const r = Math.sqrt(rb * rb + rr * rr);
            wC[k] = r <= delta ? 1 : delta / r;
          }
        }
      }

      const strongColorShift = Math.sqrt(cb0 * cb0 + cr0 * cr0) > 4.5;
      if (!isLumaWm && !strongColorShift) {
        aY[i] = 1; cY[i] = 0; aC[i] = 1; cCb[i] = 0; cCr[i] = 0;
      } else {
        aY[i] = ay; cY[i] = cy; aC[i] = ac; cCb[i] = cb0; cCr[i] = cr0;
      }
    }
    return { aY, cY, aC, cCb, cCr };
  }

  // Suavização bilateral leve do modelo estimado (elimina granulado estático nas letras)
  function smoothModel(est, w, h) {
    const { aY, cY, aC, cCb, cCr } = est;
    const oAY = new Float32Array(aY), oCY = new Float32Array(cY);
    const oAC = new Float32Array(aC), oCB = new Float32Array(cCb), oCR = new Float32Array(cCr);
    const sigA2 = 0.08 * 0.08;
    const sigC2 = 16 * 16;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (1 - aY[i] < 0.05) continue;
        const ay0 = aY[i], cy0 = cY[i];
        let wSum = 0, sAY = 0, sCY = 0, sAC = 0, sCB = 0, sCR = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (y + dy) * w + (x + dx);
            if (1 - aY[j] < 0.03) continue;
            const da = aY[j] - ay0;
            const dc = cY[j] - cy0;
            const sp = (dx === 0 && dy === 0) ? 1.0 : (dx === 0 || dy === 0) ? 0.7 : 0.45;
            const wt = sp * Math.exp(-(da * da) / (2 * sigA2) - (dc * dc) / (2 * sigC2));
            wSum += wt;
            sAY += wt * aY[j]; sCY += wt * cY[j];
            sAC += wt * aC[j]; sCB += wt * cCb[j]; sCR += wt * cCr[j];
          }
        }
        if (wSum > 0) {
          oAY[i] = sAY / wSum; oCY[i] = sCY / wSum;
          oAC[i] = sAC / wSum; oCB[i] = sCB / wSum; oCR[i] = sCR / wSum;
        }
      }
    }
    est.aY = oAY; est.cY = oCY; est.aC = oAC; est.cCb = oCB; est.cCr = oCR;
  }

  function computeRimWeights(aY, w, h) {
    const rim = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const al = 1 - aY[i];
        const dl = Math.abs(aY[i] - aY[i - 1]);
        const dr = Math.abs(aY[i] - aY[i + 1]);
        const du = Math.abs(aY[i] - aY[i - w]);
        const dd = Math.abs(aY[i] - aY[i + w]);
        const g = Math.max(dl, dr, du, dd);
        if (al < 0.02) {
          if (g > 0.22) rim[i] = Math.min(0.55, (g - 0.18) * 1.1);
          continue;
        }
        const thinH = (1 - aY[i - 1] < al * 0.55) && (1 - aY[i + 1] < al * 0.55);
        const thinV = (1 - aY[i - w] < al * 0.55) && (1 - aY[i + w] < al * 0.55);
        if (thinH || thinV) {
          rim[i] = 0.90;
        } else if (g > 0.12) {
          rim[i] = Math.min(0.82, (g - 0.10) * 1.7);
        }
      }
    }
    return rim;
  }

  function extractEdgePoints(est, w, h) {
    const pts = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (est.aY[i + 1] - est.aY[i - 1]) * 0.5;
        const gy = (est.aY[i + w] - est.aY[i - w]) * 0.5;
        if (gx * gx + gy * gy > 0.01) {
          const ex = ((est.aY[i + 1] * 140 + est.cY[i + 1]) - (est.aY[i - 1] * 140 + est.cY[i - 1])) * 0.5;
          const ey = ((est.aY[i + w] * 140 + est.cY[i + w]) - (est.aY[i - w] * 140 + est.cY[i - w])) * 0.5;
          if (ex * ex + ey * ey > 4) pts.push(x, y, ex, ey);
        }
      }
    }
    // Subamostra se houver pontos demais (mantém busca ultra-rápida < 1 ms)
    const maxPts = 1800;
    if (pts.length > maxPts * 4) {
      const step = Math.ceil((pts.length / 4) / maxPts);
      const sub = [];
      for (let k = 0; k < pts.length; k += step * 4) {
        sub.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3]);
      }
      return new Float32Array(sub);
    }
    return new Float32Array(pts);
  }

  // Pares (interior da marca, exterior limpo próximo) para calibração fina por foto
  function extractBoundaryPairs(aY, rim, w, h) {
    const pairs = [];
    for (let y = 3; y < h - 3; y++) {
      for (let x = 3; x < w - 3; x++) {
        const i = y * w + x;
        const al = 1 - aY[i];
        if (al < 0.25 || rim[i] > 0.45) continue;
        // Procura um pixel limpo a 2-3 px de distância em uma das 4 direções
        const offsets = [-3, 3, -3 * w, 3 * w];
        for (let d = 0; d < 4; d++) {
          const j = i + offsets[d];
          if (1 - aY[j] < 0.02 && rim[j] < 0.05) {
            pairs.push(i, j);
            break;
          }
        }
      }
    }
    if (pairs.length > 2400) {
      const step = Math.ceil((pairs.length / 2) / 1200);
      const sub = [];
      for (let k = 0; k < pairs.length; k += step * 2) sub.push(pairs[k], pairs[k + 1]);
      return new Int32Array(sub);
    }
    return new Int32Array(pairs);
  }

  function classifyAnchor(x0, y0, bw, bh, refW, refH) {
    const cx = x0 + bw * 0.5;
    const cy = y0 + bh * 0.5;
    const ax = Math.abs(cx - refW * 0.5) < refW * 0.14 ? 'center'
      : cx < refW * 0.35 ? 'left' : cx > refW * 0.65 ? 'right' : 'rel';
    const ay = Math.abs(cy - refH * 0.5) < refH * 0.14 ? 'center'
      : cy < refH * 0.35 ? 'top' : cy > refH * 0.65 ? 'bottom' : 'rel';
    return { ax, ay };
  }

  function estimateRegion(cropsRGBA, box, refW, refH) {
    const bw = box.bw, bh = box.bh;
    const N = cropsRGBA.length;
    if (N < 3) return null;
    const cropsYCC = cropsRGBA.map((d) => rgbaToYCbCr(d, bw * bh));

    // Consistência de gradientes em resolução cheia dentro da caixa
    const bSx = new Float32Array(bw * bh), bSy = new Float32Array(bw * bh);
    const bGx = new Float32Array(bw * bh), bGy = new Float32Array(bw * bh);
    for (let k = 0; k < N; k++) {
      const Y = cropsYCC[k].Y;
      for (let y = 0; y < bh - 1; y++) {
        const r = y * bw;
        for (let x = 0; x < bw - 1; x++) {
          const i = r + x;
          const gx = Y[i + 1] - Y[i];
          const gy = Y[i + bw] - Y[i];
          bSx[i] += gx / Math.sqrt(gx * gx + 16);
          bSy[i] += gy / Math.sqrt(gy * gy + 16);
          bGx[i] += gx > 45 ? 45 : gx < -45 ? -45 : gx;
          bGy[i] += gy > 45 ? 45 : gy < -45 ? -45 : gy;
        }
      }
    }
    const invN = 1 / N;
    const minSign = N >= 12 ? 0.40 : N >= 6 ? 0.48 : 0.58;
    const gxB = new Float32Array(bw * bh), gyB = new Float32Array(bw * bh);
    const edgeHit = new Uint8Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) {
      const sx = bSx[i] * invN, sy = bSy[i] * invN;
      const gx = bGx[i] * invN, gy = bGy[i] * invN;
      const wx = Math.max(0, Math.min(1, (Math.abs(sx) - 0.30) / 0.18));
      const wy = Math.max(0, Math.min(1, (Math.abs(sy) - 0.30) / 0.18));
      gxB[i] = gx * wx; gyB[i] = gy * wy;
      if (sx * sx + sy * sy > minSign * minSign && gx * gx + gy * gy > 3.5 * 3.5) edgeHit[i] = 1;
    }

    // Screened Poisson: preenche interior sólido das letras sem vazar para áreas vazias
    const div = new Float32Array(bw * bh);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        div[i] = (gxB[i] - gxB[i - 1]) + (gyB[i] - gyB[i - bw]);
      }
    }
    const u = new Float32Array(bw * bh);
    const invDen = 1 / (4 + 0.015);
    const omega = 1.65;
    for (let it = 0; it < 120; it++) {
      for (let y = 1; y < bh - 1; y++) {
        const r = y * bw;
        for (let x = 1; x < bw - 1; x++) {
          const i = r + x;
          u[i] += omega * ((u[i - 1] + u[i + 1] + u[i - bw] + u[i + bw] - div[i]) * invDen - u[i]);
        }
      }
    }

    let maxU = 0;
    for (let i = 0; i < u.length; i++) if (Math.abs(u[i]) > maxU) maxU = Math.abs(u[i]);
    if (maxU < 6.0) return null;

    const uThresh = Math.max(6.0, 0.14 * maxU);
    let mask = new Uint8Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) {
      if (Math.abs(u[i]) > uThresh || edgeHit[i]) mask[i] = 1;
    }
    mask = dilate(mask, bw, bh, 2);
    clearBorder(mask, bw, bh, 2);

    // Rodada 1 + Rodada 2 (máscara justa) de YCbCr Berkson IRLS
    let est = estimateYCC(cropsYCC, cropsRGBA, mask, bw, bh);
    const tightMask = new Uint8Array(bw * bh);
    let activeCount = 0;
    for (let i = 0; i < bw * bh; i++) {
      if (1 - est.aY[i] > 0.03 || Math.abs(est.cY[i]) > 3 ||
          Math.abs(est.cCb[i]) > 4 || Math.abs(est.cCr[i]) > 4) {
        tightMask[i] = 1;
        activeCount++;
      }
    }
    if (activeCount < 40) return null;

    const refinedMask = dilate(tightMask, bw, bh, 1);
    clearBorder(refinedMask, bw, bh, 2);
    est = estimateYCC(cropsYCC, cropsRGBA, refinedMask, bw, bh);
    smoothModel(est, bw, bh);

    // Verifica novamente após suavização
    let strongCount = 0;
    for (let i = 0; i < bw * bh; i++) {
      if (1 - est.aY[i] > 0.06 || Math.abs(est.cCb[i]) > 5 || Math.abs(est.cCr[i]) > 5) strongCount++;
    }
    if (strongCount < 35) return null;

    const rim = computeRimWeights(est.aY, bw, bh);
    const edgePts = extractEdgePoints(est, bw, bh);
    if (edgePts.length < 40) return null;
    const boundPairs = extractBoundaryPairs(est.aY, rim, bw, bh);

    return {
      x0: box.x0, y0: box.y0, bw, bh,
      anchor: classifyAnchor(box.x0, box.y0, bw, bh, refW, refH),
      aY: est.aY, cY: est.cY, aC: est.aC, cCb: est.cCb, cCr: est.cCr,
      mask: refinedMask, rim, edgePts, boundPairs,
    };
  }

  // ------------------------------------------------------------------
  // Aplicação por foto (alinhamento + calibração fina + inversão + polimento)
  // ------------------------------------------------------------------

  function evalNCC(img, edgePts, x0, y0, scale, searchR) {
    const iw = img.width, ih = img.height, d = img.data;
    let tNorm2 = 0;
    for (let k = 0; k < edgePts.length; k += 4) {
      tNorm2 += edgePts[k + 2] * edgePts[k + 2] + edgePts[k + 3] * edgePts[k + 3];
    }
    const tNorm = Math.sqrt(tNorm2) + 1e-6;
    const lumAt = (px, py) => {
      const cx = px < 0 ? 0 : px >= iw ? iw - 1 : px;
      const cy = py < 0 ? 0 : py >= ih ? ih - 1 : py;
      const o = (cy * iw + cx) * 4;
      return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
    };

    let bestScore = -1e9, bestDx = 0, bestDy = 0;
    for (let dy = -searchR; dy <= searchR; dy++) {
      for (let dx = -searchR; dx <= searchR; dx++) {
        let dot = 0, gNorm2 = 0;
        for (let k = 0; k < edgePts.length; k += 4) {
          const tx = Math.round(x0 + dx + edgePts[k] * scale);
          const ty = Math.round(y0 + dy + edgePts[k + 1] * scale);
          if (tx < 1 || tx >= iw - 1 || ty < 1 || ty >= ih - 1) continue;
          const igx = (lumAt(tx + 1, ty) - lumAt(tx - 1, ty)) * 0.5;
          const igy = (lumAt(tx, ty + 1) - lumAt(tx, ty - 1)) * 0.5;
          dot += igx * edgePts[k + 2] + igy * edgePts[k + 3];
          gNorm2 += igx * igx + igy * igy;
        }
        const ncc = dot / (tNorm * Math.sqrt(gNorm2) + 1e-6);
        if (ncc > bestScore) { bestScore = ncc; bestDx = dx; bestDy = dy; }
      }
    }
    return { dx: bestDx, dy: bestDy, ncc: bestScore };
  }

  function anchoredPosition(reg, refW, refH, W, H, scale) {
    const sw = reg.bw * scale, sh = reg.bh * scale;
    const { ax, ay } = reg.anchor;
    let x0, y0;
    if (ax === 'center') {
      const refOffX = (reg.x0 + reg.bw * 0.5) - refW * 0.5;
      x0 = W * 0.5 + refOffX * scale - sw * 0.5;
    } else if (ax === 'left') {
      x0 = reg.x0 * scale;
    } else if (ax === 'right') {
      const marginR = refW - (reg.x0 + reg.bw);
      x0 = W - marginR * scale - sw;
    } else {
      x0 = (reg.x0 / refW) * W;
    }

    if (ay === 'center') {
      const refOffY = (reg.y0 + reg.bh * 0.5) - refH * 0.5;
      y0 = H * 0.5 + refOffY * scale - sh * 0.5;
    } else if (ay === 'top') {
      y0 = reg.y0 * scale;
    } else if (ay === 'bottom') {
      const marginB = refH - (reg.y0 + reg.bh);
      y0 = H - marginB * scale - sh;
    } else {
      y0 = (reg.y0 / refH) * H;
    }
    return { x0: Math.round(x0), y0: Math.round(y0) };
  }

  // Reamostragem bilinear de uma região do modelo quando a foto tem escala diferente
  function resampleRegion(reg, scale) {
    if (Math.abs(scale - 1) < 0.008) return reg;
    const nw = Math.max(8, Math.round(reg.bw * scale));
    const nh = Math.max(8, Math.round(reg.bh * scale));
    const ow = reg.bw, oh = reg.bh;
    const aY = new Float32Array(nw * nh);
    const cY = new Float32Array(nw * nh);
    const aC = new Float32Array(nw * nh);
    const cCb = new Float32Array(nw * nh);
    const cCr = new Float32Array(nw * nh);
    const mask = new Uint8Array(nw * nh);

    for (let y = 0; y < nh; y++) {
      const sy = (y + 0.5) / scale - 0.5;
      const y0 = Math.max(0, Math.min(oh - 2, Math.floor(sy)));
      const fy = Math.max(0, Math.min(1, sy - y0));
      for (let x = 0; x < nw; x++) {
        const sx = (x + 0.5) / scale - 0.5;
        const x0 = Math.max(0, Math.min(ow - 2, Math.floor(sx)));
        const fx = Math.max(0, Math.min(1, sx - x0));
        const i00 = y0 * ow + x0, i10 = i00 + 1, i01 = i00 + ow, i11 = i01 + 1;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const di = y * nw + x;
        aY[di]  = w00 * reg.aY[i00]  + w10 * reg.aY[i10]  + w01 * reg.aY[i01]  + w11 * reg.aY[i11];
        cY[di]  = w00 * reg.cY[i00]  + w10 * reg.cY[i10]  + w01 * reg.cY[i01]  + w11 * reg.cY[i11];
        aC[di]  = w00 * reg.aC[i00]  + w10 * reg.aC[i10]  + w01 * reg.aC[i01]  + w11 * reg.aC[i11];
        cCb[di] = w00 * reg.cCb[i00] + w10 * reg.cCb[i10] + w01 * reg.cCb[i01] + w11 * reg.cCb[i11];
        cCr[di] = w00 * reg.cCr[i00] + w10 * reg.cCr[i10] + w01 * reg.cCr[i01] + w11 * reg.cCr[i11];
        mask[di] = (1 - aY[di] > 0.03 || Math.abs(cY[di]) > 3) ? 1 : 0;
      }
    }
    const dMask = dilate(mask, nw, nh, 1);
    clearBorder(dMask, nw, nh, 2);
    const rim = computeRimWeights(aY, nw, nh);
    const boundPairs = extractBoundaryPairs(aY, rim, nw, nh);
    return { bw: nw, bh: nh, aY, cY, aC, cCb, cCr, mask: dMask, rim, boundPairs };
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  }

  function polishRim(outY, outCb, outCr, rim, aY, w, h) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    // 1) Polimento direcional 4-eixos nas bordas de 1 px (tira anelamento JPEG preservando arestas)
    for (let pass = 0; pass < 2; pass++) {
      const dstY = new Float32Array(outY);
      const dstCb = new Float32Array(outCb);
      const dstCr = new Float32Array(outCr);
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const i = y * w + x;
          const rw = rim[i];
          if (rw <= 0.02) continue;

          let wySum = 0, ySum = 0, cbSum = 0, crSum = 0;
          for (let d = 0; d < 4; d++) {
            const dx = dirs[d][0], dy = dirs[d][1];
            let s1 = 1, s2 = 1;
            if (rim[(y - dy) * w + (x - dx)] > 0.45) s1 = 2;
            if (rim[(y + dy) * w + (x + dx)] > 0.45) s2 = 2;
            const i1 = (y - dy * s1) * w + (x - dx * s1);
            const i2 = (y + dy * s2) * w + (x + dx * s2);
            const diffY = outY[i1] - outY[i2];
            const diffC = (outCb[i1] - outCb[i2]) + (outCr[i1] - outCr[i2]);
            const cleanBoost = (1 - 0.65 * rim[i1]) * (1 - 0.65 * rim[i2]);
            const wDir = cleanBoost / (diffY * diffY + 0.25 * diffC * diffC + 20);
            wySum += wDir;
            ySum  += wDir * 0.5 * (outY[i1]  + outY[i2]);
            cbSum += wDir * 0.5 * (outCb[i1] + outCb[i2]);
            crSum += wDir * 0.5 * (outCr[i1] + outCr[i2]);
          }
          if (wySum > 0) {
            const pY = ySum / wySum, pCb = cbSum / wySum, pCr = crSum / wySum;
            const spike = Math.abs(outY[i] - pY);
            const amt = Math.min(0.95, rw * (0.72 + 0.28 * Math.min(1, spike / 10)));
            dstY[i]  = outY[i]  * (1 - amt) + pY  * amt;
            dstCb[i] = outCb[i] * (1 - amt) + pCb * amt;
            dstCr[i] = outCr[i] * (1 - amt) + pCr * amt;
          }
        }
      }
      outY.set(dstY); outCb.set(dstCb); outCr.set(dstCr);
    }

    // 2) Bilateral leve no interior da marca (limpa amplificação de ruído JPEG sem borrar detalhes)
    const bY = new Float32Array(outY), bCb = new Float32Array(outCb), bCr = new Float32Array(outCr);
    const sigY2 = 2 * 13 * 13;
    const sigC2 = 2 * 10 * 10;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const al = 1 - aY[i];
        if (al < 0.08 && rim[i] < 0.15) continue;
        const yc = outY[i], bc = outCb[i], rc = outCr[i];
        let wY = 0, sY = 0, wC = 0, sCb = 0, sCr = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (y + dy) * w + (x + dx);
            const dY = outY[j] - yc;
            const dCb = outCb[j] - bc, dCr = outCr[j] - rc;
            const sp = (dx === 0 && dy === 0) ? 1.0 : (dx === 0 || dy === 0) ? 0.75 : 0.5;
            const cleanPref = 1.0 + 0.5 * aY[j];
            const wy = sp * cleanPref * Math.exp(-(dY * dY) / sigY2);
            const wc = sp * cleanPref * Math.exp(-(dY * dY) / (sigY2 * 1.4) - (dCb * dCb + dCr * dCr) / sigC2);
            wY += wy; sY += wy * outY[j];
            wC += wc; sCb += wc * outCb[j]; sCr += wc * outCr[j];
          }
        }
        const mix = Math.min(1, Math.max(al * 1.3, rim[i]));
        bY[i]  = yc * (1 - mix * 0.75) + (sY / wY) * (mix * 0.75);
        bCb[i] = bc * (1 - mix * 0.90) + (sCb / wC) * (mix * 0.90);
        bCr[i] = rc * (1 - mix * 0.90) + (sCr / wC) * (mix * 0.90);
      }
    }
    outY.set(bY); outCb.set(bCb); outCr.set(bCr);
  }

  function applyRegionInPlace(img, reg, x0, y0) {
    const bw = reg.bw, bh = reg.bh;
    const crop = cropRGBA(img, x0, y0, bw, bh);
    const cropYCC = rgbaToYCbCr(crop, bw * bh);
    const harm = harmonicFillYCC(cropYCC, reg.mask, bw, bh, 35);

    const resY = new Float32Array(cropYCC.Y);
    const resCb = new Float32Array(cropYCC.Cb);
    const resCr = new Float32Array(cropYCC.Cr);

    for (let y = 0; y < bh; y++) {
      const ty = y0 + y;
      if (ty < 0 || ty >= img.height) continue;
      for (let x = 0; x < bw; x++) {
        const tx = x0 + x;
        if (tx < 0 || tx >= img.width) continue;
        const bi = y * bw + x;
        const ay = reg.aY[bi];
        const ac = reg.aC[bi];
        if (ay >= 0.99 && ac >= 0.99 && Math.abs(reg.cY[bi]) < 1 && Math.abs(reg.cCb[bi]) < 1 && Math.abs(reg.cCr[bi]) < 1) continue;

        const oi = (ty * img.width + tx) * 4;
        const r0 = img.data[oi], g0 = img.data[oi + 1], b0 = img.data[oi + 2];
        const clippedHi = (r0 >= 254 || g0 >= 254 || b0 >= 254);
        const clippedLo = (r0 <= 1   || g0 <= 1   || b0 <= 1);

        const baseTrustY = ay >= 0.22 ? 1.0 : Math.max(0, (ay - 0.06) / 0.16);
        const invY = (cropYCC.Y[bi] - reg.cY[bi]) / ay;
        let trustY = baseTrustY;
        if (clippedHi && reg.cY[bi] > 8 && harm.Y[bi] > invY) trustY *= 0.25;
        else if (clippedLo && (1 - ay) * 255 - reg.cY[bi] > 8 && harm.Y[bi] < invY) trustY *= 0.25;
        resY[bi] = trustY * Math.max(0, Math.min(255, invY)) + (1 - trustY) * harm.Y[bi];

        const baseTrustC = ac >= 0.30 ? 1.0 : Math.max(0, (ac - 0.12) / 0.18);
        const trustC = (clippedHi || clippedLo) ? baseTrustC * 0.3 : baseTrustC;
        const invCb = (cropYCC.Cb[bi] - reg.cCb[bi]) / ac;
        const invCr = (cropYCC.Cr[bi] - reg.cCr[bi]) / ac;
        resCb[bi] = trustC * Math.max(-128, Math.min(128, invCb)) + (1 - trustC) * harm.Cb[bi];
        resCr[bi] = trustC * Math.max(-128, Math.min(128, invCr)) + (1 - trustC) * harm.Cr[bi];
      }
    }

    // Calibração fina de resíduo de borda por foto (zera eventual fantasma de +-2..6 luma)
    const bp = reg.boundPairs;
    if (bp && bp.length >= 40) {
      const dYs = [], dCbs = [], dCrs = [];
      let sumAlpha = 0, cntA = 0;
      for (let k = 0; k < bp.length; k += 2) {
        const iIn = bp[k], iOut = bp[k + 1];
        // Ignora pares em regiões saturadas
        const pIn = iIn * 4;
        if (crop[pIn] >= 253 || crop[pIn + 1] >= 253 || crop[pIn + 2] >= 253) continue;
        dYs.push(resY[iIn] - resY[iOut]);
        dCbs.push(resCb[iIn] - resCb[iOut]);
        dCrs.push(resCr[iIn] - resCr[iOut]);
        sumAlpha += (1 - reg.aY[iIn]);
        cntA++;
      }
      if (dYs.length >= 25) {
        const meanA = Math.max(0.25, sumAlpha / cntA);
        const biasY  = Math.max(-12, Math.min(12, medianOf(dYs)));
        const biasCb = Math.max(-6,  Math.min(6,  medianOf(dCbs)));
        const biasCr = Math.max(-6,  Math.min(6,  medianOf(dCrs)));
        if (Math.abs(biasY) > 0.5 || Math.abs(biasCb) > 0.4 || Math.abs(biasCr) > 0.4) {
          for (let i = 0; i < bw * bh; i++) {
            const al = 1 - reg.aY[i];
            if (al < 0.03) continue;
            const f = Math.min(1.3, al / meanA);
            resY[i]  = Math.max(0, Math.min(255, resY[i]  - biasY  * f));
            resCb[i] = Math.max(-128, Math.min(128, resCb[i] - biasCb * f));
            resCr[i] = Math.max(-128, Math.min(128, resCr[i] - biasCr * f));
          }
        }
      }
    }

    polishRim(resY, resCb, resCr, reg.rim, reg.aY, bw, bh);

    for (let y = 0; y < bh; y++) {
      const ty = y0 + y;
      if (ty < 0 || ty >= img.height) continue;
      for (let x = 0; x < bw; x++) {
        const tx = x0 + x;
        if (tx < 0 || tx >= img.width) continue;
        const bi = y * bw + x;
        if (reg.aY[bi] >= 0.99 && reg.rim[bi] <= 0.02 && Math.abs(reg.cCb[bi]) < 1 && Math.abs(reg.cCr[bi]) < 1) continue;
        const oi = (ty * img.width + tx) * 4;
        const Y = resY[bi], Cb = resCb[bi], Cr = resCr[bi];
        img.data[oi]     = Y + 1.402 * Cr;
        img.data[oi + 1] = Y - 0.344136 * Cb - 0.714136 * Cr;
        img.data[oi + 2] = Y + 1.772 * Cb;
      }
    }
  }

  /**
   * Remove as marcas d'água do modelo em `img` (in-place).
   * @param img   { width, height, data: Uint8ClampedArray }
   * @param model modelo retornado por analyzeBatch / estimateModel
   * @param opts  { srcScale?: number } escala aplicada pela redução maxSide
   */
  function removeFromImage(img, model, opts) {
    if (!model || !model.regions || !model.regions.length) {
      return { removed: false, regionsApplied: 0, maxNcc: 0 };
    }
    const W = img.width, H = img.height;
    const refW = model.refW, refH = model.refH;
    const srcScale = (opts && opts.srcScale) || 1;
    const sameRes = Math.abs(W - refW) <= 8 && Math.abs(H - refH) <= 8;

    let applied = 0, maxNcc = 0;
    for (const reg of model.regions) {
      // Escalas candidatas: fixa (1.0 ou srcScale), proporcional à largura, altura ou menor lado
      const candScales = [srcScale];
      if (!sameRes) {
        const extras = [1.0, W / refW, H / refH, Math.min(W, H) / Math.min(refW, refH)];
        for (const sc of extras) {
          if (sc < 0.35 || sc > 2.5) continue;
          if (!candScales.some((e) => Math.abs(e - sc) < 0.015)) candScales.push(sc);
        }
      }

      let best = { ncc: -1, x0: 0, y0: 0, scale: 1 };
      const searchR = sameRes ? 3 : 5;
      for (const sc of candScales) {
        const pos = anchoredPosition(reg, refW, refH, W, H, sc);
        const m = evalNCC(img, reg.edgePts, pos.x0, pos.y0, sc, searchR);
        if (m.ncc > best.ncc) {
          best = { ncc: m.ncc, x0: pos.x0 + m.dx, y0: pos.y0 + m.dy, scale: sc };
        }
      }

      if (best.ncc > maxNcc) maxNcc = best.ncc;
      // Limiar rígido de presença: evita mexer em fotos sem marca d'água
      if (best.ncc < 0.24) continue;

      const useReg = resampleRegion(reg, best.scale);
      applyRegionInPlace(img, useReg, best.x0, best.y0);
      applied++;
    }
    return { removed: applied > 0, regionsApplied: applied, maxNcc };
  }

  // ------------------------------------------------------------------
  // Orquestrador para o navegador (stream de Files via createImageBitmap)
  // ------------------------------------------------------------------

  async function analyzeBatchFiles(files, env, onProgress) {
    if (!files || files.length < 3) return null;
    const report = (p, text) => { if (onProgress) onProgress(p, text); };

    // Amostra no máximo 36 fotos espalhadas igualmente pelo lote
    const maxSample = 36;
    const sampled = [];
    if (files.length <= maxSample) {
      for (let i = 0; i < files.length; i++) sampled.push(files[i]);
    } else {
      for (let i = 0; i < maxSample; i++) {
        sampled.push(files[Math.floor((i * files.length) / maxSample)]);
      }
    }

    // 1. Lê dimensões para descobrir o grupo de resolução dominante
    report(0.05, 'Analisando lote…');
    const metas = [];
    for (let i = 0; i < sampled.length; i++) {
      let bmp;
      try {
        bmp = await createImageBitmap(sampled[i], { imageOrientation: 'from-image' });
        metas.push({ file: sampled[i], w: bmp.width, h: bmp.height });
      } catch (e) { /* pula arquivo inválido */ }
      if (bmp && bmp.close) bmp.close();
    }
    if (metas.length < 3) return null;

    // Agrupa resoluções iguais (+-6 px)
    const groups = [];
    for (const m of metas) {
      let g = groups.find((gr) => Math.abs(gr.w - m.w) <= 6 && Math.abs(gr.h - m.h) <= 6);
      if (!g) { g = { w: m.w, h: m.h, items: [] }; groups.push(g); }
      g.items.push(m);
    }
    groups.sort((a, b) => b.items.length - a.items.length);

    let refW, refH, cluster;
    if (groups[0].items.length >= 3) {
      refW = groups[0].w;
      refH = groups[0].h;
      cluster = groups[0].items;
    } else {
      // Todas resoluções diferentes: usa recorte central comum (menor largura x menor altura)
      refW = Math.min(...metas.map((m) => m.w));
      refH = Math.min(...metas.map((m) => m.h));
      cluster = metas;
    }

    // 2. Pass 1: acumula gradientes em baixa resolução (um bitmap por vez!)
    const det = createDetector(refW, refH);
    const detCanvas = env.createCanvas(det.dw, det.dh);
    const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
    detCtx.imageSmoothingQuality = 'medium';

    for (let i = 0; i < cluster.length; i++) {
      let bmp;
      try {
        bmp = await createImageBitmap(cluster[i].file, { imageOrientation: 'from-image' });
        const ox = Math.round((bmp.width - refW) / 2);
        const oy = Math.round((bmp.height - refH) / 2);
        detCtx.clearRect(0, 0, det.dw, det.dh);
        detCtx.drawImage(bmp, ox, oy, refW, refH, 0, 0, det.dw, det.dh);
        det.addFrameRGBA(detCtx.getImageData(0, 0, det.dw, det.dh).data);
      } catch (e) { /* pula */ }
      if (bmp && bmp.close) bmp.close();
      report(0.1 + 0.45 * ((i + 1) / cluster.length), 'Procurando marca d\'água…');
    }

    const boxes = det.finalize();
    if (!boxes.length) return null;

    // 3. Pass 2: extrai APENAS os recortes das caixas detectadas em resolução cheia
    const regionCrops = boxes.map(() => []);
    const cropCanvases = boxes.map((b) => {
      const c = env.createCanvas(b.bw, b.bh);
      return { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
    });

    for (let i = 0; i < cluster.length; i++) {
      let bmp;
      try {
        bmp = await createImageBitmap(cluster[i].file, { imageOrientation: 'from-image' });
        const ox = Math.round((bmp.width - refW) / 2);
        const oy = Math.round((bmp.height - refH) / 2);
        for (let bIdx = 0; bIdx < boxes.length; bIdx++) {
          const b = boxes[bIdx];
          const { ctx } = cropCanvases[bIdx];
          ctx.drawImage(bmp, ox + b.x0, oy + b.y0, b.bw, b.bh, 0, 0, b.bw, b.bh);
          regionCrops[bIdx].push(ctx.getImageData(0, 0, b.bw, b.bh).data);
        }
      } catch (e) { /* pula */ }
      if (bmp && bmp.close) bmp.close();
      report(0.55 + 0.25 * ((i + 1) / cluster.length), 'Lendo transparência da marca…');
    }

    report(0.85, 'Estimando modelo da marca…');
    const regions = [];
    for (let bIdx = 0; bIdx < boxes.length; bIdx++) {
      const reg = estimateRegion(regionCrops[bIdx], boxes[bIdx], refW, refH);
      if (reg) regions.push(reg);
    }
    report(1.0, '');
    if (!regions.length) return null;
    return { refW, refH, regions };
  }

  const api = {
    createDetector,
    estimateRegion,
    removeFromImage,
    analyzeBatchFiles,
    cropRGBA,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PhotoWatermark = api;
})(typeof self !== 'undefined' ? self : this);
