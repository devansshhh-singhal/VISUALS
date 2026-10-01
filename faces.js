/* On-device face matching for My Visuals.
   Detection runs in vendor/face-api.js. This file also holds the pure
   grouping math so people can be named, merged and tested without a model. */
(function (root) {
  "use strict";
  const DIM = 128;
  // Euclidean distance on L2-normalized 128-d signatures. 0.6 is the
  // face-api / dlib calibration: at or below it, treat two faces as the same person.
  // Bumped from 0.58 → 0.62 to reduce over-segmentation of the same person under
  // different lighting / angles while still keeping different people apart.
  const MATCH_DISTANCE = 0.62;
  const SOFT_MARGIN = 0.10;
  // Minimum detection score. TinyFaceDetector at 0.4 produces many paper /
  // pattern false positives; 0.55 keeps real faces while cutting most noise.
  const MIN_SCORE = 0.55;
  // Aspect-ratio guard: real faces sit between portrait and landscape.
  const MIN_ASPECT = 0.35, MAX_ASPECT = 2.8;
  // Minimum face box area as a fraction of the image (w*h). Below this the
  // detector is usually guessing at texture.
  const MIN_AREA = 0.003;

  function round4(n) { return Math.round(n * 10000) / 10000; }

  function asDescriptor(value) {
    if (!value) return null;
    if (typeof value === "string") return dequantize(value);
    const out = new Float32Array(DIM);
    if (value.length !== DIM) return null;
    let sum = 0;
    for (let i = 0; i < DIM; i++) {
      const n = Number(value[i]);
      if (!Number.isFinite(n)) return null;
      out[i] = n;
      sum += n * n;
    }
    if (sum < 1e-8) return null;
    return out;
  }

  function quantize(value) {
    const desc = asDescriptor(value);
    if (!desc) return "";
    const bytes = new Uint8Array(DIM);
    for (let i = 0; i < DIM; i++) {
      const clamped = Math.max(-1, Math.min(1, desc[i]));
      bytes[i] = Math.round(clamped * 127) + 128;
    }
    let bin = "";
    for (let i = 0; i < DIM; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/=+$/, "");
  }

  function dequantize(b64) {
    if (typeof b64 !== "string" || !b64) return null;
    let s = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    let bin;
    try { bin = atob(s); } catch (e) { return null; }
    if (bin.length !== DIM) return null;
    const out = new Float32Array(DIM);
    for (let i = 0; i < DIM; i++) out[i] = (bin.charCodeAt(i) - 128) / 127;
    return out;
  }

  function l2norm(v) {
    let sum = 0;
    for (let i = 0; i < DIM; i++) sum += v[i] * v[i];
    return Math.sqrt(sum) || 1;
  }

  function distance(a, b) {
    const da = asDescriptor(a), db = asDescriptor(b);
    if (!da || !db) return Infinity;
    // L2-normalize both sides so quantized and raw descriptors compare fairly.
    const na = l2norm(da), nb = l2norm(db);
    let sum = 0;
    for (let i = 0; i < DIM; i++) {
      const d = da[i] / na - db[i] / nb;
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  function centroid(list) {
    const vecs = (list || []).map(asDescriptor).filter(Boolean);
    if (!vecs.length) return null;
    // L2-normalize each input before averaging so one loud vector can't dominate.
    const normed = vecs.map((v) => {
      const n = l2norm(v);
      const out = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) out[i] = v[i] / n;
      return out;
    });
    const out = new Float32Array(DIM);
    for (const v of normed) for (let i = 0; i < DIM; i++) out[i] += v[i];
    let sum = 0;
    for (let i = 0; i < DIM; i++) sum += out[i] * out[i];
    if (sum < 1e-8) return null;
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < DIM; i++) out[i] *= inv;
    return out;
  }

  // Minimum distance from `desc` to any face in `list`. Used as a secondary
  // signal so a new face isn't merged into a cluster just because the centroid
  // drifted close — it must also be close to at least one existing face.
  function minDistanceTo(desc, list) {
    const d0 = asDescriptor(desc);
    if (!d0) return Infinity;
    let best = Infinity;
    for (const raw of list || []) {
      const d = distance(d0, raw);
      if (d < best) best = d;
    }
    return best;
  }

  function cleanBox(box) {
    if (!Array.isArray(box) || box.length < 4) return null;
    let x = Number(box[0]), y = Number(box[1]), w = Number(box[2]), h = Number(box[3]);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    x = Math.min(0.98, Math.max(0, x));
    y = Math.min(0.98, Math.max(0, y));
    w = Math.min(1 - x, Math.max(0, w));
    h = Math.min(1 - y, Math.max(0, h));
    if (w < 0.02 || h < 0.02) return null;
    return [round4(x), round4(y), round4(w), round4(h)];
  }

  function centroidsOf(people, faces) {
    const map = new Map();
    const groups = new Map();
    for (const p of people || []) {
      if (!p || !p.id || p.hidden === "drop") continue;
      const v = p.c ? asDescriptor(p.c) : null;
      if (v) map.set(p.id, v);
    }
    for (const f of faces || []) {
      if (!f || !f.person || f.ignored || !f.d) continue;
      const v = asDescriptor(f.d);
      if (!v) continue;
      if (!groups.has(f.person)) groups.set(f.person, []);
      groups.get(f.person).push(v);
    }
    for (const [id, list] of groups) {
      const mean = centroid(list);
      if (!mean) continue;
      // If we already have a stored centroid, blend it with the computed mean
      // rather than overwriting — stored centroids carry manual corrections.
      map.set(id, map.has(id) ? centroid([map.get(id), mean]) : mean);
    }
    return {centroids: map, groups};
  }

  function matchDescriptor(descriptor, people, faces, threshold = MATCH_DISTANCE) {
    const desc = asDescriptor(descriptor);
    if (!desc) return {personId: null, distance: Infinity};
    const {centroids, groups} = centroidsOf(people, faces);
    let personId = null, best = Infinity, nearestId = null;
    for (const [id, c] of centroids) {
      const cDist = distance(desc, c);
      // Blend centroid distance with min-distance to any face of this person.
      // Centroid-only matching drifts; min-face-only is too noisy. The blend
      // keeps clusters tight around real faces while still being forgiving.
      const faceList = groups.get(id) || [];
      const mDist = faceList.length ? minDistanceTo(desc, faceList) : cDist;
      const score = faceList.length >= 2 ? 0.55 * cDist + 0.45 * mDist : cDist;
      if (score < best) { best = score; personId = id; }
      if (cDist < (nearestId === null ? Infinity : distance(desc, centroids.get(nearestId) || c))) nearestId = id;
    }
    if (!nearestId) nearestId = personId;
    return {personId: best <= threshold ? personId : null, distance: best, nearestId};
  }

  // Group one photo's detections against people already in the library.
  // Returns a copied people list (centroids updated) and only the new face rows.
  function cluster(detections, opts = {}) {
    const people = (opts.people || []).map((p) => ({...p}));
    const faces = (opts.faces || []).slice();
    const added = [];
    const now = opts.now || Date.now();
    const uid = opts.uid || (() => Math.random().toString(36).slice(2, 10));
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : MATCH_DISTANCE;
    const maxPeople = Number.isFinite(opts.maxPeople) ? opts.maxPeople : 2000;
    for (const det of detections || []) {
      const box = cleanBox(det && det.box);
      const desc = asDescriptor(det && det.descriptor);
      if (!box || !desc) continue;
      const score = Math.max(0, Math.min(1, Number(det.score) || 0));
      // Skip low-confidence detections — these are usually paper / texture.
      if (score < MIN_SCORE) continue;
      const match = matchDescriptor(desc, people, faces, threshold);
      let person = match.personId ? people.find((p) => p.id === match.personId) : null;
      // Outlier guard: if we matched a person, check the new face isn't far from
      // most existing faces of that person. This prevents one bad match from
      // pulling a cluster's centroid toward a different person.
      if (person) {
        const existing = faces.filter((f) => f.person === person.id && !f.ignored && f.d);
        if (existing.length >= 3) {
          const dists = existing.map((f) => distance(desc, f.d)).sort((a, b) => a - b);
          const median = dists[Math.floor(dists.length / 2)];
          // If the median distance to existing faces exceeds the threshold,
          // this is probably a different person that happened to match the centroid.
          if (median > threshold) person = null;
        }
      }
      if (!person && people.length >= maxPeople) {
        const unmatched = {
          id: "f-" + uid(), item: String(opts.itemId || ""), person: "",
          box, d: quantize(desc), score: Math.round(score * 1000) / 1000
        };
        faces.push(unmatched);
        added.push(unmatched);
        continue;
      }
      if (!person) {
        person = {id: "p-" + uid(), name: "", hidden: false, createdAt: now, updatedAt: now, c: quantize(desc)};
        people.push(person);
      } else {
        const prev = asDescriptor(person.c);
        person.c = quantize(prev ? centroid([prev, desc]) : desc);
        person.updatedAt = now;
      }
      const face = {
        id: "f-" + uid(), item: String(opts.itemId || ""), person: person.id,
        box, d: quantize(desc), score: Math.round(score * 1000) / 1000
      };
      faces.push(face);
      added.push(face);
    }
    return {people, faces: added};
  }

  let enginePromise = null, engineReady = false, engineError = "";

  function modelBase() {
    return new URL("models/", root.document ? root.document.baseURI : "/").href.replace(/\/$/, "");
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (root.faceapi) { resolve(); return; }
      const s = root.document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Couldn't load face recognition."));
      root.document.head.appendChild(s);
    });
  }

  function load() {
    if (engineReady) return Promise.resolve();
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
      engineError = "";
      await loadScript(new URL("vendor/face-api.js", root.document.baseURI).href);
      const faceapi = root.faceapi;
      if (!faceapi || !faceapi.nets) throw new Error("Face recognition didn't start.");
      const tf = faceapi.tf;
      if (tf) {
        await tf.ready();
        try {
          if (tf.getBackend() !== "webgl") {
            await tf.setBackend("webgl");
            await tf.ready();
          }
        } catch (e) {
          try { await tf.setBackend("cpu"); await tf.ready(); } catch (err) {}
        }
      }
      const base = modelBase();
      await faceapi.nets.tinyFaceDetector.loadFromUri(base);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
      await faceapi.nets.faceRecognitionNet.loadFromUri(base);
      engineReady = true;
    })().catch((e) => {
      enginePromise = null;
      engineError = e && e.message ? e.message : "Couldn't load face recognition.";
      throw e;
    });
    return enginePromise;
  }

  async function elementFrom(source) {
    if (!source) throw new Error("No image to scan.");
    if (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement) return source;
    if (typeof source === "string") {
      const img = new Image();
      img.decoding = "async";
      const done = new Promise((resolve, reject) => {
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Couldn't read this image."));
      });
      img.src = source;
      return done;
    }
    if (typeof createImageBitmap === "function" && (source instanceof Blob || source instanceof HTMLVideoElement)) {
      const bmp = await createImageBitmap(source);
      const c = root.document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return c;
    }
    throw new Error("Couldn't read this image.");
  }

  function downscale(el, maxSide) {
    const w = el.naturalWidth || el.videoWidth || el.width;
    const h = el.naturalHeight || el.videoHeight || el.height;
    if (!w || !h) throw new Error("This image has no pixels to scan.");
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const c = root.document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
    return c;
  }

  async function detect(source, opts = {}) {
    await load();
    const faceapi = root.faceapi;
    const el = await elementFrom(source);
    const canvas = downscale(el, opts.maxSide || 1280);
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: opts.inputSize || 608,
      scoreThreshold: Number.isFinite(opts.scoreThreshold) ? opts.scoreThreshold : MIN_SCORE
    });
    const found = await faceapi.detectAllFaces(canvas, options).withFaceLandmarks(true).withFaceDescriptors();
    const w = canvas.width, h = canvas.height;
    return (found || []).map((r) => {
      const box = r.detection.box;
      return {
        box: [box.x / w, box.y / h, box.width / w, box.height / h],
        score: r.detection.score,
        descriptor: Array.from(r.descriptor)
      };
    }).map((f) => ({...f, box: cleanBox(f.box)})).filter((f) => {
      if (!f.box || !asDescriptor(f.descriptor)) return false;
      // Aspect-ratio guard: real faces aren't extremely wide or extremely tall.
      const bw = f.box[2], bh = f.box[3];
      if (bh < 1e-4) return false;
      const ratio = bw / bh;
      if (ratio < MIN_ASPECT || ratio > MAX_ASPECT) return false;
      // Minimum area: very small boxes are almost always noise.
      if (bw * bh < MIN_AREA) return false;
      // Score guard applied here too for callers that pass their own threshold.
      if (f.score < MIN_SCORE) return false;
      return true;
    })
      .sort((a, b) => (b.box[2] * b.box[3]) - (a.box[2] * a.box[3]))
      .slice(0, 12);
  }

  root.VisualsFaces = {
    DIM, MATCH_DISTANCE, SOFT_MARGIN, MIN_SCORE, MIN_ASPECT, MAX_ASPECT, MIN_AREA,
    quantize, dequantize, distance, centroid, cleanBox, minDistanceTo,
    matchDescriptor, cluster, load, detect,
    ready: () => engineReady,
    error: () => engineError
  };
})(window);
