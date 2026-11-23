/*
 * pipeline.js — abre o arquivo, chama o core e gera o JPG final.
 * Usado pelo worker (OffscreenCanvas) e, como plano B, pela página.
 */
(function (g) {
  'use strict';

  async function runPipeline(file, opts, env) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (e) {
      const err = new Error('DECODE');
      err.code = 'DECODE';
      throw err;
    }
    const maxSide = opts.maxSide || 4096;
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const W = Math.max(1, Math.round(bmp.width * s));
    const H = Math.max(1, Math.round(bmp.height * s));

    const canvas = env.createCanvas(W, H);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, W, H);
    if (bmp.close) bmp.close();
    const src = ctx.getImageData(0, 0, W, H);

    // Remove marca d'água ANTES de gerar a versão reduzida, geometria e cor
    let wmRemoved = false;
    if (opts.watermark && opts.wmModel && g.PhotoWatermark) {
      const wm = g.PhotoWatermark.removeFromImage(
        { width: W, height: H, data: src.data },
        opts.wmModel,
        { srcScale: s }
      );
      wmRemoved = !!wm.removed;
      if (wmRemoved) ctx.putImageData(src, 0, 0);
    }

    const ss = Math.min(1, 900 / Math.max(W, H));
    const sw = Math.max(1, Math.round(W * ss)), sh = Math.max(1, Math.round(H * ss));
    const sc = env.createCanvas(sw, sh);
    const sctx = sc.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, sw, sh);
    const small = sctx.getImageData(0, 0, sw, sh);

    const r = g.PhotoCore.processImage(
      { width: W, height: H, data: src.data },
      { width: sw, height: sh, data: small.data },
      opts
    );
    ctx.putImageData(new ImageData(r.image.data, W, H), 0, 0);
    const blob = await env.toBlob(canvas, 'image/jpeg', opts.quality || 0.92);

    const ts = Math.min(1, 640 / Math.max(W, H));
    const tc = env.createCanvas(Math.round(W * ts), Math.round(H * ts));
    const tctx = tc.getContext('2d');
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(canvas, 0, 0, tc.width, tc.height);
    const thumb = await env.toBlob(tc, 'image/jpeg', 0.82);

    const det = r.info.detection || {};
    return {
      blob,
      thumb,
      info: {
        width: W,
        height: H,
        roll: r.info.roll,
        pitch: r.info.pitch,
        crop: r.info.crop,
        confidence: det.confidence || null,
        color: !!r.info.color,
        watermark: wmRemoved,
      },
    };
  }

  g.runPipeline = runPipeline;
})(typeof self !== 'undefined' ? self : this);
