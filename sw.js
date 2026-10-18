// sw.js — Axiomo sin conexión.
// Al instalarse guarda la página y el motor. Cuando el motor termina de
// cargar por primera vez, la página le pide guardar también Python y sus
// paquetes (del CDN de Pyodide, con la versión en la dirección, así que
// nunca cambian). Desde ahí todo sale del dispositivo: la app abre y
// calcula sin internet. Solo funciona en HTTPS (o en localhost).
"use strict";

const VERSION = "9e4508c1c37d";               // construir.py pone aquí la huella de los archivos
const CACHE_APP = `axiomo-app-${VERSION}`;
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const CACHE_PY = "axiomo-python-v314.0.7";
// cuentas.json no se guarda: solo se usa al activar, y siempre se pide fresco
const APP = ["./", "index.html", "app.js", "marco.js", "estilo.css", "logo.png", "motor_worker.js", "axiomo_core.bin",
             "manifest.webmanifest", "icono-180.png", "icono-192.png", "icono-512.png", "icono-mascara.png"];
const NUCLEO_PY = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PAQUETES = ["numpy", "sympy", "matplotlib"];

self.addEventListener("install", (e) => {
  // «reload»: que no se cuele en la versión nueva un archivo viejo de la caché HTTP
  e.waitUntil(caches.open(CACHE_APP)
    .then((c) => c.addAll(APP.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("axiomo-app-") && k !== CACHE_APP) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

async function dePython(url) {
  const c = await caches.open(CACHE_PY);
  const guardada = await c.match(url);
  if (guardada) return guardada;
  const r = await fetch(url, { mode: "cors", credentials: "omit" });
  if (r.ok) await c.put(url, r.clone());
  return r;
}

async function deApp(req) {
  const c = await caches.open(CACHE_APP);
  let r = await c.match(req, { ignoreSearch: true });
  if (!r && req.mode === "navigate") r = (await c.match("./")) || (await c.match("index.html"));
  return r || fetch(req);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.url.startsWith(PYODIDE)) e.respondWith(dePython(req.url));
  else if (new URL(req.url).origin === self.location.origin) e.respondWith(deApp(req));
});

// Python y los paquetes que usa el motor, con sus dependencias según el
// pyodide-lock.json. Casi siempre salen de la caché HTTP: el motor los
// acaba de descargar.
async function guardarPython() {
  const lock = await (await dePython(PYODIDE + "pyodide-lock.json")).json();
  const nombres = new Set();
  const agregar = (n) => {
    const k = String(n).toLowerCase();
    if (nombres.has(k) || !lock.packages[k]) return;
    nombres.add(k);
    for (const d of lock.packages[k].depends || []) agregar(d);
  };
  PAQUETES.forEach(agregar);
  const urls = [...NUCLEO_PY, ...[...nombres].map((n) => lock.packages[n].file_name)].map((f) => PYODIDE + f);
  for (const u of urls) {
    const r = await dePython(u);
    if (!r.ok) throw new Error(`${u}: ${r.status}`);
  }
  return urls.length;
}

self.addEventListener("message", (e) => {
  if (!e.data || e.data.tipo !== "guardar-python") return;
  const responder = (m) => { if (e.source) e.source.postMessage(m); };
  e.waitUntil(guardarPython()
    .then((n) => responder({ tipo: "python-guardado", ok: true, n }))
    .catch((err) => responder({ tipo: "python-guardado", ok: false, error: String(err) })));
});
