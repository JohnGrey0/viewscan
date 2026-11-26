// localstore.js — remembers folders opened with "Open folder…" (or dropped on
// the window) in the browser's own storage (IndexedDB), so they are still there
// after a reload. A copy of each scan file is kept; nothing leaves this computer.
//
//   folders  { id, name (shown), folder (as opened), added, format, complete, summaries }
//   files    key [folderId, fileIndex] → File
//
// A folder only counts once `complete` is set, so a copy that was interrupted
// (tab closed half-way) is thrown away on the next start instead of half-loading.

const DB_NAME = 'viewscan';
/** Bump when the summary format of series.js changes (with CACHE_VERSION in server.js). */
export const SUMMARY_FORMAT = 5;
const BATCH_BYTES = 48e6, BATCH_FILES = 200;

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('This browser has no storage for opened folders'));
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        rq.result.createObjectStore('folders', { keyPath: 'id' });
        rq.result.createObjectStore('files');
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}
const ask = (rq) => new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = tx.onerror = () => reject(tx.error || new Error('Storage write failed'));
});
const rangeOf = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);

/**
 * Copy a folder into browser storage.
 * @param {{id:string, name:string, folder?:string, summaries:object[], files:File[]}} folder  `files` is indexed by summary.file
 * @param {(done:number, total:number)=>void} [onProgress]
 */
export async function saveFolder(folder, onProgress) {
  const d = await db();
  const record = { id: folder.id, name: folder.name, folder: folder.folder || folder.name, added: Date.now(), format: SUMMARY_FORMAT, complete: false, summaries: folder.summaries };
  let tx = d.transaction('folders', 'readwrite');
  tx.objectStore('folders').put(record);
  await finished(tx);
  const wanted = [...new Set(folder.summaries.map((s) => s.file))];
  try {
    let done = 0;
    while (done < wanted.length) {
      tx = d.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      let bytes = 0, n = 0;
      while (done < wanted.length && n < BATCH_FILES && bytes < BATCH_BYTES) {
        const i = wanted[done++], f = folder.files[i];
        store.put(f, [folder.id, i]);
        bytes += f.size; n++;
      }
      await finished(tx);
      if (onProgress) onProgress(done, wanted.length);
    }
    tx = d.transaction('folders', 'readwrite');
    tx.objectStore('folders').put({ ...record, complete: true });
    await finished(tx);
  } catch (err) {
    await removeFolder(folder.id).catch(() => {});
    throw err;
  }
  // ask the browser not to clear this storage when the disk gets full (best effort)
  try { await navigator.storage?.persist?.(); } catch { /* not available here */ }
}

/** Forget a folder and its copied files. */
export async function removeFolder(id) {
  const d = await db();
  const tx = d.transaction(['folders', 'files'], 'readwrite');
  tx.objectStore('folders').delete(id);
  tx.objectStore('files').delete(rangeOf(id));
  await finished(tx);
}

/** Replace the stored summaries of a folder (after re-reading its headers). */
export async function updateSummaries(id, summaries) {
  const d = await db();
  const tx = d.transaction('folders', 'readwrite');
  const store = tx.objectStore('folders');
  const rec = await ask(store.get(id));
  if (rec) store.put({ ...rec, summaries, format: SUMMARY_FORMAT });
  await finished(tx);
}

/**
 * Every folder kept from earlier visits, oldest first.
 * @returns {Promise<Array<{id:string, name:string, added:number, format:number, summaries:object[], files:File[]}>>}
 */
export async function loadFolders() {
  const d = await db();
  const records = await ask(d.transaction('folders').objectStore('folders').getAll());
  const out = [];
  for (const rec of records.sort((a, b) => a.added - b.added)) {
    if (!rec.complete) { await removeFolder(rec.id).catch(() => {}); continue; }
    const tx = d.transaction('files');
    const store = tx.objectStore('files');
    const [keys, values] = await Promise.all([ask(store.getAllKeys(rangeOf(rec.id))), ask(store.getAll(rangeOf(rec.id)))]);
    const files = [];
    keys.forEach((k, i) => { files[k[1]] = values[i]; });
    out.push({ ...rec, files });
  }
  return out;
}
