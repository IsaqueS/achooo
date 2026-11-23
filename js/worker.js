/* worker.js — processa fotos e estima marca d'água fora da thread principal. */
importScripts('watermark.js', 'core.js', 'pipeline.js');

const env = {
  createCanvas: (w, h) => new OffscreenCanvas(w, h),
  toBlob: (c, type, quality) => c.convertToBlob({ type, quality }),
};

let cachedWmModel = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'setWatermark') {
    cachedWmModel = msg.model || null;
    return;
  }
  if (typeof OffscreenCanvas === 'undefined') {
    if (msg.type === 'analyzeWatermark') {
      self.postMessage({ type: 'wmDone', jobId: msg.jobId, ok: false, code: 'NO_OFFSCREEN' });
    } else {
      self.postMessage({ id: msg.id, ok: false, code: 'NO_OFFSCREEN' });
    }
    return;
  }
  if (msg.type === 'analyzeWatermark') {
    try {
      const model = await self.PhotoWatermark.analyzeBatchFiles(msg.files, env, (progress, text) => {
        self.postMessage({ type: 'wmProgress', jobId: msg.jobId, progress, text });
      });
      cachedWmModel = model || null;
      self.postMessage({ type: 'wmDone', jobId: msg.jobId, ok: true, model });
    } catch (err) {
      self.postMessage({ type: 'wmDone', jobId: msg.jobId, ok: false, code: err.code || 'FAIL', error: String((err && err.message) || err) });
    }
    return;
  }

  const { id, file, opts } = msg;
  try {
    const runOpts = Object.assign({}, opts, { wmModel: opts && opts.watermark ? cachedWmModel : null });
    const res = await self.runPipeline(file, runOpts, env);
    self.postMessage({ id, ok: true, ...res });
  } catch (err) {
    self.postMessage({ id, ok: false, code: err.code || 'FAIL', error: String((err && err.message) || err) });
  }
};
