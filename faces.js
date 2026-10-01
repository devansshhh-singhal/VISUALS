/* On-device face matching for My Visuals.
   Detection runs in vendor/face-api.js. This file also holds the pure
   grouping math so people can be named, merged and tested without a model. */
(function (root) {
  "use strict";
  const DIM = 128;
  // Euclidean distance on L2-normalized 128-d signatures. 0.6 is the
  // face-api / dlib calibration: at or below it, treat two faces as the same person.
  const MATCH_DISTANCE = 0.58;
  const SOFT_MARGIN = 0.08;

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

  function distance(a, b) {
    const da = asDescriptor(a), db = asDescriptor(b);
    if (!da || !db) return Infinity;
    let sum = 0;
    for (let i = 0; i < DIM; i++) {
      const d = da[i] - db[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  function centroid(list) {
    const vecs = (list || []).map(asDescriptor).filter(Boolean);
    if (!vecs.length) return null;
    const out = new Float32Array(DIM);
    for (const v of vecs) for (let i = 0; i < DIM; i++) out[i] += v[i];
    let sum = 0;
    for (let i = 0; i < DIM; i++) sum += out[i] * out[i];
    if (sum < 1e-8) return null;
    const inv = 1 / Math.sqrt(sum);
    for (let i = 0; i < DIM; i++) out[i] *= inv;
    return out;
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
    for (const p of people || []) {
      if (!p || !p.id || p.hidden === "drop") continue;
      const v = p.c ? asDescriptor(p.c) : null;
      if (v) map.set(p.id, v);
    }
    const groups = new Map();
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
      map.set(id, map.has(id) ? centroid([map.get(id), mean]) : mean);
    }
    return map;
  }

  function matchDescriptor(descriptor, people, faces, threshold = MATCH_DISTANCE) {
    const desc = asDescriptor(descriptor);
    if (!desc) return {personId: null, distance: Infinity};
    let personId = null, best = Infinity;
    for (const [id, c] of centroidsOf(people, faces)) {
      const d = distance(desc, c);
      if (d < best) { best = d; personId = id; }
    }
    return {personId: best <= threshold ? personId : null, distance: best, nearestId: personId};
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
      const match = matchDescriptor(desc, people, faces, threshold);
      let person = match.personId ? people.find((p) => p.id === match.personId) : null;
      const score = Math.max(0, Math.min(1, Number(det.score) || 0));
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
      inputSize: opts.inputSize || 512,
      scoreThreshold: Number.isFinite(opts.scoreThreshold) ? opts.scoreThreshold : 0.4
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
    }).map((f) => ({...f, box: cleanBox(f.box)})).filter((f) => f.box && asDescriptor(f.descriptor))
      .sort((a, b) => (b.box[2] * b.box[3]) - (a.box[2] * a.box[3]))
      .slice(0, 12);
  }

  root.VisualsFaces = {
    DIM, MATCH_DISTANCE, SOFT_MARGIN, quantize, dequantize, distance, centroid, cleanBox,
    matchDescriptor, cluster, load, detect,
    ready: () => engineReady,
    error: () => engineError
  };
})(window);
