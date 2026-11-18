/* worker.js — processa fotos fora da thread principal. */
importScripts('core.js', 'pipeline.js');

const env = {
  createCanvas: (w, h) => new OffscreenCanvas(w, h),
  toBlob: (c, type, quality) => c.convertToBlob({ type, quality }),
};

self.onmessage = async (e) => {
  const { id, file, opts } = e.data;
  if (typeof OffscreenCanvas === 'undefined') {
    self.postMessage({ id, ok: false, code: 'NO_OFFSCREEN' });
    return;
  }
  try {
    const res = await self.runPipeline(file, opts, env);
    self.postMessage({ id, ok: true, ...res });
  } catch (err) {
    self.postMessage({ id, ok: false, code: err.code || 'FAIL', error: String((err && err.message) || err) });
  }
};
