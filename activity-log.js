/* Durable, append-only activity history and an at-least-once webhook outbox.
 * No credentials or shared-link fragments belong in this store. The app supplies
 * sanitized entries and captures the destination when each entry is recorded.
 */
(() => {
  "use strict";
  const DB_NAME = "visuals-logs-v1", FALLBACK_KEY = "visuals-logs-fallback-v1";
  const BUCKETS = ["records", "outbox", "attempts"];
  let db = null, storageError = "", fallback = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(FALLBACK_KEY) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fallback = parsed;
  } catch (_) {}
  for (const name of BUCKETS) if (!fallback[name] || typeof fallback[name] !== "object" || Array.isArray(fallback[name])) fallback[name] = {};
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const uuid = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  const recordKey = (scope, type, id) => JSON.stringify([scope, type, id]);
  const ready = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const name of BUCKETS) {
          const store = req.result.createObjectStore(name, { keyPath: "id" });
          store.createIndex("scope", "scope");
        }
      };
      req.onsuccess = () => {
        db = req.result;
        db.onversionchange = () => { db.close(); db = null; };
        resolve();
      };
      req.onerror = () => resolve();
      // Another tab may temporarily hold an older schema open. Use the persistent
      // fallback meanwhile instead of leaving library loading stuck indefinitely.
      req.onblocked = () => resolve();
    } catch (_) { resolve(); }
  });

  function saveFallback() {
    try {
      // Merge with other tabs; tombstones prevent acknowledged tasks reappearing.
      const other = JSON.parse(localStorage.getItem(FALLBACK_KEY) || "{}");
      for (const name of BUCKETS) fallback[name] = { ...(other?.[name] || {}), ...fallback[name] };
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(fallback));
      storageError = "";
      return true;
    } catch (_) {
      storageError = "Browser storage is unavailable or full. Some new logs are only in memory; export them before closing this tab.";
      return false;
    }
  }
  async function write(changes) {
    await ready;
    if (db) {
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction([...new Set(changes.map((c) => c.store))], "readwrite");
          tx.oncomplete = resolve;
          tx.onerror = tx.onabort = () => reject(tx.error || new Error("Log storage failed"));
          for (const c of changes) {
            const store = tx.objectStore(c.store);
            if (c.remove) store.delete(c.id);
            else store.put(clone(c.value));
          }
        });
        // A successful write supersedes any earlier emergency fallback value.
        let changed = false;
        for (const c of changes) if (Object.prototype.hasOwnProperty.call(fallback[c.store], c.id)) {
          fallback[c.store][c.id] = { id: c.id, superseded: true };
          changed = true;
        }
        if (changed) saveFallback();
        return true;
      } catch (_) { /* Retain the entry and its task together in the fallback. */ }
    }
    for (const c of changes) fallback[c.store][c.id] = c.remove ? { id: c.id, deleted: true } : clone(c.value);
    return saveFallback();
  }
  async function all(name, scope) {
    await ready;
    let values = [];
    if (db) {
      try {
        values = await new Promise((resolve, reject) => {
          const tx = db.transaction(name, "readonly"), store = tx.objectStore(name);
          const req = scope === undefined ? store.getAll() : store.index("scope").getAll(scope);
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {}
    }
    // Refresh fallback values from other tabs, keeping in-memory emergency writes.
    try {
      const other = JSON.parse(localStorage.getItem(FALLBACK_KEY) || "{}");
      fallback[name] = { ...(other?.[name] || {}), ...fallback[name] };
    } catch (_) {}
    const merged = new Map(values.map((v) => [v.id, v]));
    for (const v of Object.values(fallback[name])) {
      if (!v || typeof v !== "object" || typeof v.id !== "string") continue;
      if (v.superseded) continue;
      if (v.deleted) merged.delete(v.id);
      else if (scope === undefined || v.scope === scope) merged.set(v.id, v);
    }
    return [...merged.values()].filter((v) => scope === undefined || v.scope === scope);
  }
  function record(scope, type, entry) {
    return { id: recordKey(scope, type, entry.id), scope, type, entry: clone(entry) };
  }
  const store = {
    ready,
    get storageError() { return storageError; },
    async append(scope, type, entry, task = null) {
      const value = record(scope, type, entry);
      const changes = [{ store: "records", id: value.id, value }];
      if (task) changes.push({ store: "outbox", id: task.id, value: task });
      return write(changes);
    },
    async importEntries(scope, type, entries) {
      if (!entries.length) return true;
      return write(entries.map((e) => {
        const value = record(scope, type, e);
        return { store: "records", id: value.id, value };
      }));
    },
    async entries(scope, type) {
      return (await all("records", scope)).filter((r) => r.type === type).map((r) => r.entry);
    },
    outbox: () => all("outbox"),
    attempts: (scope) => all("attempts", scope),
    saveTask: (task) => write([{ store: "outbox", id: task.id, value: task }]),
    async updateTask(id, values) {
      await ready;
      let emergency = fallback.outbox[id];
      if (db) {
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction("outbox", "readwrite"), bucket = tx.objectStore("outbox");
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(tx.error);
            const req = bucket.get(id);
            req.onsuccess = () => {
              const current = req.result || (emergency && !emergency.deleted && !emergency.superseded ? emergency : null);
              // Never resurrect a task after its acknowledgement.
              if (current) { emergency = current; bucket.put({ ...current, ...clone(values) }); }
            };
          });
          if (fallback.outbox[id]) { fallback.outbox[id] = { id, superseded: true }; saveFallback(); }
          return true;
        } catch (_) {}
      }
      if (emergency && !emergency.deleted && !emergency.superseded) {
        fallback.outbox[id] = { ...emergency, ...clone(values) };
        return saveFallback();
      }
      return true;
    },
    async finishAttempt(task, result) {
      await ready;
      const attempt = {
        id: "wa-" + uuid(), taskId: task.id, scope: task.scope, entryId: task.entry.id,
        t: Date.now(), ok: result.ok, status: result.status || 0,
        error: result.error || "", attempt: task.attempts, nextAt: result.ok ? 0 : task.nextAt
      };
      const emergency = fallback.outbox[task.id];
      if (db) {
        try {
          await new Promise((resolve, reject) => {
            const tx = db.transaction(["outbox", "attempts"], "readwrite"), bucket = tx.objectStore("outbox");
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = () => reject(tx.error);
            tx.objectStore("attempts").put(attempt);
            if (result.ok) bucket.delete(task.id);
            else {
              const req = bucket.get(task.id);
              req.onsuccess = () => {
                const current = req.result || (emergency && !emergency.deleted && !emergency.superseded ? emergency : null);
                if (current) bucket.put({ ...task, entry: current.entry, scope: current.scope, url: current.url });
              };
            }
          });
          if (emergency) { fallback.outbox[task.id] = { id: task.id, superseded: true }; saveFallback(); }
          return true;
        } catch (_) {}
      }
      const latest = emergency && !emergency.deleted && !emergency.superseded ? { ...task, entry: emergency.entry, scope: emergency.scope, url: emergency.url } : task;
      return write([
        { store: "attempts", id: attempt.id, value: attempt },
        result.ok ? { store: "outbox", id: task.id, remove: true } : { store: "outbox", id: task.id, value: latest }
      ]);
    },
    createDispatcher({ payload, onChange = () => {} }) {
      let timer = 0, timerAt = 0, running = null;
      const notify = () => { try { Promise.resolve(onChange()).catch(() => {}); } catch (_) {} };
      const endpointDue = (tasks) => {
        const barriers = new Map();
        for (const task of tasks) if (task.url && task.attempts > 0 && task.nextAt > Date.now())
          barriers.set(task.url, Math.max(barriers.get(task.url) || 0, task.nextAt));
        return (task) => Math.max(task.nextAt || 0, barriers.get(task.url) || 0);
      };
      function schedule(delay = 300) {
        const wait = Math.min(2147483647, Math.max(0, delay)), at = Date.now() + wait;
        if (timer && timerAt <= at) return; // A continuous stream must not postpone delivery forever.
        clearTimeout(timer); timerAt = at;
        timer = setTimeout(() => { timer = 0; timerAt = 0; flush().catch(() => {}); }, wait);
      }
      async function send(task, keepalive) {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const url = new URL(task.url);
          if (url.protocol !== "https:" || url.username || url.password) return { ok: false, error: "Invalid HTTPS webhook endpoint" };
          const message = payload(task), multipart = message instanceof FormData;
          const response = await fetch(url.href, {
            method: "POST", mode: "cors", credentials: "omit", redirect: "error",
            referrerPolicy: "no-referrer", keepalive, signal: controller.signal,
            // Leave multipart's Content-Type to the browser so its boundary matches.
            ...(multipart ? {} : { headers: { "Content-Type": "application/json" } }),
            body: multipart ? message : JSON.stringify(message)
          });
          // An opaque/no-cors response is NOT an acknowledgement. Only readable
          // HTTP 2xx responses allow an entry to leave the persistent outbox.
          if (response.ok && response.type !== "opaque") return { ok: true, status: response.status };
          let retryAfter = 0;
          const retry = response.headers.get("retry-after");
          if (retry) retryAfter = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now()) || 0;
          if (response.status === 429) {
            try {
              const body = await response.json();
              const seconds = Number(body.retry_after);
              if (Number.isFinite(seconds) && seconds > 0) retryAfter = Math.max(retryAfter, seconds * 1000);
            } catch (_) {}
          }
          if (!Number.isFinite(retryAfter)) retryAfter = 0;
          return { ok: false, status: response.status, retryAfter, error: "Webhook returned HTTP " + response.status };
        } catch (error) {
          return { ok: false, status: 0, error: error.name === "AbortError" ? "Webhook timed out" : "Network or CORS error; no delivery confirmation" };
        } finally { clearTimeout(timeout); }
      }
      async function drain(keepalive) {
        if (navigator.onLine === false) { notify(); return; }
        const tasks = (await store.outbox()).filter((t) => t.url);
        const due = endpointDue(tasks), now = Date.now(), blocked = new Set();
        const batch = tasks.filter((t) => due(t) <= now).sort((a, b) => a.createdAt - b.createdAt).slice(0, 10);
        for (const task of batch) {
          if (blocked.has(task.url) || navigator.onLine === false) continue;
          const result = await send(task, keepalive);
          task.attempts = (task.attempts || 0) + 1;
          task.lastAt = Date.now(); task.lastStatus = result.status || 0; task.lastError = result.error || "";
          if (!result.ok) {
            const backoff = Math.min(300000, 1000 * 2 ** Math.min(task.attempts, 9));
            task.nextAt = Date.now() + Math.max(result.retryAfter || 0, backoff);
            blocked.add(task.url);
          }
          await store.finishAttempt(task, result);
          notify();
        }
      }
      function flush({ keepalive = false } = {}) {
        clearTimeout(timer); timer = 0; timerAt = 0;
        if (running) return running;
        running = (async () => {
          // Avoid simultaneous deliveries from two tabs where Web Locks exists.
          // At-least-once semantics still require endpoint deduplication by entry.id.
          if (navigator.locks?.request) {
            await navigator.locks.request("visuals-webhook-outbox-v1", { ifAvailable: true }, async (lock) => {
              if (lock) await drain(keepalive);
            });
          } else await drain(keepalive);
        })().finally(async () => {
          running = null;
          const pending = (await store.outbox()).filter((t) => t.url);
          notify();
          if (pending.length && navigator.onLine !== false) {
            const due = endpointDue(pending);
            schedule(Math.max(300, pending.reduce((earliest, t) => Math.min(earliest, due(t)), Infinity) - Date.now()));
          }
        });
        return running;
      }
      async function retry(scope) {
        for (const task of await store.outbox()) if (task.scope === scope && task.url) {
          await store.updateTask(task.id, { nextAt: 0 });
        }
        return flush();
      }
      return { schedule, flush, retry };
    }
  };
  window.VisualsLogs = store;
})();
