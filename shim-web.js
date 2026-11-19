// Bridge for the installable web app (GitHub Pages). It gives the page the same window.claude.use()
// capabilities it has on claude.ai and in the Android app:
//   db        every document in one IndexedDB record on this device
//   downloads the share sheet when the browser can share files, otherwise a regular download
//   backup    export / import of every document (same format as the Android app)
// There is no `alarm`: a web page cannot notify when the phone is locked.
(() => {
  const DB_NAME = 'bitacora-gym', STORE = 'kv', KEY = 'docs';
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ---------- IndexedDB, one record ---------- */
  const idb = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = (mode, fn) => idb.then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));

  let store = new Map();
  const subs = new Set();
  const notify = () => setTimeout(() => subs.forEach(f => f()), 0);
  let queue = Promise.resolve();
  const persist = () => (queue = queue.then(() => tx('readwrite', s => s.put(Object.fromEntries(store), KEY))));
  const ready = (async () => {
    try { store = new Map(Object.entries((await tx('readonly', s => s.get(KEY))) || {})); }
    catch (e) { console.error('No se pudo abrir el almacenamiento', e); }
    // Ask the browser not to evict the data under storage pressure
    try { await navigator.storage?.persist?.(); } catch {}
  })();

  const snapDoc = p => {
    const has = store.has(p);
    return { id: p.split('/').pop(), exists: has, data: () => (has ? clone(store.get(p)) : undefined), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const write = async fn => { await ready; fn(); notify(); await persist(); };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const doc = p => ({
    id: p.split('/').pop(), path: p,
    get: async () => { await ready; return snapDoc(p); },
    set: d => write(() => store.set(p, clone(d))),
    update: d => write(() => {
      if (!store.has(p)) throw { code: 'invalid_argument', message: 'El documento no existe.' };
      store.set(p, { ...store.get(p), ...clone(d) });
    }),
    delete: () => write(() => store.delete(p)),
    onSnapshot(next) { const f = () => next(snapDoc(p)); subs.add(f); ready.then(f); return () => subs.delete(f); },
    collection: c => col(`${p}/${c}`),
  });
  const col = c => {
    const depth = c.split('/').length + 1;
    const snap = () => {
      const docs = [...store.keys()].filter(k => k.startsWith(c + '/') && k.split('/').length === depth).sort().map(snapDoc);
      return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      path: c,
      doc: id => doc(`${c}/${id || newId()}`),
      add: async d => { const r = doc(`${c}/${newId()}`); await r.set(d); return r; },
      get: async () => { await ready; return snap(); },
      onSnapshot(next) { const f = () => next(snap()); subs.add(f); ready.then(f); return () => subs.delete(f); },
    };
  };
  const db = Object.freeze({ doc, collection: col });

  /* ---------- downloads ---------- */
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const type = filename.endsWith('.csv') ? 'text/csv' : 'application/json';
      const file = new File([data], filename, { type });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (e) { if (e?.name === 'AbortError') throw { code: 'declined', message: 'Cancelado' }; }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
  });

  /* ---------- backup ---------- */
  const backup = Object.freeze({
    async export() {
      await ready;
      return JSON.stringify({ app: 'bitacora-gym', version: 1, savedAt: new Date().toISOString(), docs: Object.fromEntries(store) });
    },
    async import(text) {
      const docs = JSON.parse(text)?.docs;
      if (!docs || typeof docs !== 'object' || Array.isArray(docs)) throw new Error('No es un respaldo de la Bitácora.');
      await ready;
      store = new Map(Object.entries(docs)); notify(); await persist();
      return store.size;
    },
  });

  const caps = { db, downloads, backup };
  window.claude = Object.freeze({ use: async name => caps[name] ?? null });

  // Offline support
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.error(e)));
})();
