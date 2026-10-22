// Axiomo en el navegador (iPad, Android, PC): interfaz táctil de vigas.
// El modelo vive aquí en el mismo formato del «modelo» de un archivo
// .pystruct del programa de escritorio; el cálculo y el paso a paso los
// hace el motor de Axiomo (Python) en un Web Worker (motor_worker.js).
"use strict";

const VERSION = "web 0.6";
const $ = (id) => document.getElementById(id);
const LISTAS_CARGA = ["cargas_puntuales", "cargas_distribuidas", "cargas_polinomicas", "momentos", "cargas_nodales"];
const NS = "http://www.w3.org/2000/svg";

// ======================================================================= motor
const Motor = (() => {
  let w = null;
  const pendientes = new Map();
  const esperando = [];
  let n = 0, listo = false, fallo = null, llave = null;
  const textos = { python: "Cargando Python", paquetes: "Cargando numpy, sympy y matplotlib",
                   llave: "Esperando la activación", motor: "Abriendo el motor" };
  // sin conexión la primera vez, o el worker se cayó: se avisa y se puede reintentar
  function fallar(error) {
    fallo = String(error || "error desconocido");
    estadoMotor("No cargó · toca para reintentar", "fallo");
    esperando.splice(0).forEach((f) => f());
    for (const p of pendientes.values()) p.error(new Error("El motor se detuvo. Toca el aviso de arriba para reintentar."));
    pendientes.clear();
  }
  function iniciar() {
    if (w) w.terminate();
    listo = false; fallo = null;
    estadoMotor("Preparando el motor…", "");
    // de módulo: Pyodide 314 no corre en workers clásicos
    w = new Worker("motor_worker.js", { type: "module" });
    w.onerror = (e) => { e.preventDefault(); fallar(e.message || "el motor no arrancó"); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.tipo === "estado") { if (!m.hecho) estadoMotor(`${textos[m.etapa]}…`, ""); return; }
      if (m.tipo === "listo") {
        listo = true; estadoMotor("Motor listo", "listo");
        esperando.splice(0).forEach((f) => f());
        guardarSinConexion();
        return;
      }
      if (m.tipo === "fallo") { fallar(m.error); return; }
      const p = pendientes.get(m.id);
      if (!p) return;
      if (m.tipo === "progreso") { if (p.progreso) p.progreso(m.texto, m.f); return; }
      pendientes.delete(m.id);
      if (m.ok) p.ok(m.datos); else p.error(new Error(m.error));
    };
    w.postMessage({ tipo: "iniciar", dpr: Math.min(3, window.devicePixelRatio || 1) });
    if (llave) w.postMessage({ tipo: "llave", llave });
  }
  iniciar();
  return {
    get listo() { return listo; },
    get fallo() { return fallo; },
    reintentar() { if (fallo) iniciar(); },
    // la llave del motor (CryptoKey no exportable) llega cuando el dispositivo está activado
    darLlave(k) { llave = k; w.postMessage({ tipo: "llave", llave: k }); },
    esperar() { return listo || fallo ? Promise.resolve() : new Promise((r) => esperando.push(r)); },
    pedir(tipo, datos = {}, progreso = null) {
      return new Promise((ok, error) => {
        const id = ++n;
        pendientes.set(id, { ok, error, progreso });
        w.postMessage({ id, tipo, ...datos });
      });
    },
  };
})();

function estadoMotor(texto, clase) {
  $("motor-texto").textContent = texto;
  $("motor").className = `motor ${clase || ""}`;
}
$("motor").addEventListener("click", () => Motor.reintentar());

// ======================================================================= sin conexión
// En HTTPS el service worker guarda la app al instalarse; cuando el motor
// ya cargó se le pide guardar también Python y sus paquetes.
let sinConexion = false;

function guardarSinConexion() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.active && reg.active.postMessage({ tipo: "guardar-python" }))
    .catch(() => { /* sin modo sin conexión */ });
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.tipo !== "python-guardado") return;
    sinConexion = !!m.ok;
    if (m.ok && !leerLocal("axiomo.sin-conexion")) {
      escribirLocal("axiomo.sin-conexion", "1");
      aviso("Axiomo quedó guardado en este dispositivo: ya funciona sin internet.");
    }
  };
  navigator.serviceWorker.register("sw.js").catch(() => { /* sin modo sin conexión */ });
}

// ======================================================================= activación
// Cada dispositivo se activa UNA vez con usuario y contraseña. cuentas.json
// (publicado con la app) trae el usuario en hash y la llave del motor
// envuelta con PBKDF2 de la contraseña: lo mismo que arma
// herramientas/cuentas_web.py, y si se cambia allá se cambia aquí. La llave
// queda en IndexedDB envuelta con otra llave del dispositivo que no se puede
// exportar; desde ahí la app abre sin contraseña ni internet.
const PIMIENTA = "axiomo-web:";
let licenciado = "";

const enBytes = (s) => new TextEncoder().encode(s);
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const normalizarUsuario = (u) => String(u).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizarClave = (c) => String(c).replace(/[\s-]/g, "").toLowerCase();

const almacen = {
  abrir() {
    return new Promise((ok, mal) => {
      const r = indexedDB.open("axiomo", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("activacion");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => mal(r.error);
    });
  },
  async leer() {
    const db = await almacen.abrir();
    return new Promise((ok, mal) => {
      const q = db.transaction("activacion").objectStore("activacion").get("actual");
      q.onsuccess = () => ok(q.result || null);
      q.onerror = () => mal(q.error);
    });
  },
  async guardar(valor) {
    const db = await almacen.abrir();
    return new Promise((ok, mal) => {
      const tx = db.transaction("activacion", "readwrite");
      tx.objectStore("activacion").put(valor, "actual");
      tx.oncomplete = () => ok();
      tx.onerror = () => mal(tx.error);
    });
  },
};

async function hexSha256(s) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", enBytes(s)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function abrirSobre(llave, blob, aad) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12), additionalData: enBytes(aad) }, llave, blob.slice(12));
}

async function activar(usuario, clave) {
  if (!window.isSecureContext || !crypto.subtle) {
    throw new Error("Esta dirección no es segura (http): la activación solo funciona en la página oficial, con https.");
  }
  let cuentas;
  try {
    const r = await fetch("cuentas.json", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    cuentas = await r.json();
  } catch (_) {
    throw new Error("Sin conexión: la activación necesita internet una sola vez.");
  }
  const incorrecto = new Error("Usuario o contraseña incorrectos.");
  const c = cuentas.cuentas[await hexSha256(PIMIENTA + normalizarUsuario(usuario))];
  if (!c) throw incorrecto;
  const base = await crypto.subtle.importKey("raw", enBytes(normalizarClave(clave)), "PBKDF2", false, ["deriveKey"]);
  const kek = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: deB64(c.s), iterations: cuentas.iteraciones, hash: "SHA-256" },
                                            base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  let crudo;
  try { crudo = new Uint8Array(await abrirSobre(kek, deB64(c.k), "axiomo-k")); } catch (_) { throw incorrecto; }
  const nombre = new TextDecoder().decode(await abrirSobre(kek, deB64(c.n), "axiomo-n"));
  // se guarda envuelta con una llave del dispositivo que no se puede exportar
  const disp = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const env = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, disp, crudo));
  const k = await crypto.subtle.importKey("raw", crudo, "AES-GCM", false, ["decrypt"]);
  crudo.fill(0);
  try {
    await almacen.guardar({ disp, iv, env, nombre, usuario: normalizarUsuario(usuario), fecha: new Date().toISOString() });
  } catch (_) {
    aviso("Este navegador no deja guardar la activación (¿ventana privada?): habrá que activarlo cada vez.", true);
  }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) { /* no es crítico */ }
  return { k, nombre };
}

async function activacionGuardada() {
  try {
    if (!window.isSecureContext || !crypto.subtle) return null;
    const a = await almacen.leer();
    if (!a) return null;
    const crudo = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: a.iv }, a.disp, a.env));
    const k = await crypto.subtle.importKey("raw", crudo, "AES-GCM", false, ["decrypt"]);
    crudo.fill(0);
    return { k, nombre: a.nombre };
  } catch (_) {
    return null;
  }
}

// en iOS lo que se activa en Safari no pasa a la app instalada: hay que instalar primero
function esIOSSinInstalar() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const instalada = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  return ios && !instalada;
}

$("form-activar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-activar");
  $("act-error").hidden = true;
  btn.disabled = true;
  btn.textContent = "Activando…";
  try {
    const { k, nombre } = await activar($("act-usuario").value, $("act-clave").value);
    licenciado = nombre;
    Motor.darLlave(k);
    $("activacion").hidden = true;
    aviso(`Listo: Axiomo quedó activado para ${nombre}.`);
  } catch (err) {
    $("act-error").textContent = err.message || String(err);
    $("act-error").hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Activar";
  }
});

async function revisarActivacion() {
  const a = await activacionGuardada();
  if (a) {
    licenciado = a.nombre;
    Motor.darLlave(a.k);
    return;
  }
  $("aviso-ios").hidden = !esIOSSinInstalar();
  $("activacion").hidden = false;
}

// ======================================================================= modelo
let modelo = null;
let resultado = null;          // el último cálculo; se borra al editar
const leyes = new Map();       // id de carga con ley → [[X, Q], …] para dibujarla

const PROPIEDADES = { E: 210000000.0, I: 0.00035, A: 0.0112 };   // las del escritorio: kN/m², m⁴, m²

function modeloVacio() {
  return {
    tipo: "Viga", convencion_cargas: "arriba_positivo", siguiente_id: 1, nodos: [], miembros: [], apoyos: [],
    propiedades_globales: { E: null, I: null, A: null }, cargas_nodales: [], cargas_puntuales: [],
    cargas_distribuidas: [], cargas_polinomicas: [], momentos: [], cargas_globales: [], asentamientos: [], temperaturas: [],
  };
}

function vigaInicial(conCargas) {
  modelo = modeloVacio();
  modelo.nodos.push({ etiqueta: "A", x: 0, y: 0, rotula: false, k_rotula: 0 });
  agregarTramo(6);
  if (conCargas) agregarTramo(2);
  ponerApoyo("A", "Articulado");
  ponerApoyo("B", "Rodillo");
  if (conCargas) {
    modelo.cargas_distribuidas.push({ id: nuevoId(), miembro: "M1", x1: 0, x2: 6, w1: -10, w2: -10, direccion: "local" });
    modelo.cargas_puntuales.push({ id: nuevoId(), miembro: "M2", s: 2, fx: 0, fy: -15 });
  }
  return modelo;
}

function normalizar(m) {
  for (const k of ["nodos", "miembros", "apoyos", "cargas_globales", "asentamientos", "temperaturas", ...LISTAS_CARGA]) {
    if (!Array.isArray(m[k])) m[k] = [];
  }
  m.propiedades_globales = m.propiedades_globales || { E: null, I: null, A: null };
  const maxId = Math.max(0, ...LISTAS_CARGA.flatMap((k) => m[k].map((c) => c.id || 0)));
  m.siguiente_id = Math.max(m.siguiente_id || 1, maxId + 1);
  return m;
}

function nuevoId() {
  const id = modelo.siguiente_id || 1;
  modelo.siguiente_id = id + 1;
  return id;
}

const nodo = (et) => modelo.nodos.find((n) => n.etiqueta === et);
const miembro = (et) => modelo.miembros.find((m) => m.etiqueta === et);
const nodosOrdenados = () => [...modelo.nodos].sort((a, b) => a.x - b.x);
const apoyoDe = (et) => modelo.apoyos.find((a) => a.nodo === et);

function geo(m) {
  const a = nodo(m.i), b = nodo(m.j);
  const L = Math.abs(b.x - a.x), sg = b.x >= a.x ? 1 : -1;
  return { xi: a.x, xj: b.x, L, sg, x: (s) => a.x + sg * s, izq: Math.min(a.x, b.x), der: Math.max(a.x, b.x) };
}

const miembrosOrdenados = () => [...modelo.miembros].sort((a, b) => geo(a).izq - geo(b).izq);

function siguienteLetra() {
  const usadas = new Set(modelo.nodos.map((n) => n.etiqueta));
  for (const l of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!usadas.has(l)) return l;
  let k = 1;
  while (usadas.has(`N${k}`)) k++;
  return `N${k}`;
}

function siguienteMiembro() {
  const usadas = new Set(modelo.miembros.map((m) => m.etiqueta));
  let k = 1;
  while (usadas.has(`M${k}`)) k++;
  return `M${k}`;
}

// las globales del escritorio (panel E/I/A) mandan sobre las de cada tramo; un
// miembro nuevo copia las del último que se creó
function propiedadesActuales() {
  const g = modelo.propiedades_globales || {};
  const m0 = modelo.miembros.at(-1) || PROPIEDADES;
  return { E: g.E ?? m0.E, I: g.I ?? m0.I, A: g.A ?? m0.A };
}

// ======================================================================= E, I y A con su unidad
// En el modelo van en kN/m², m⁴ y m² (como el escritorio); en pantalla, cada una en
// la unidad que se elija, con los factores de interfaz/unidades_app.py. La unidad
// elegida se recuerda en el dispositivo
const UNIDADES_PROP = {
  E: { nombre: "Módulo de elasticidad (E)", defecto: "GPa",
       u: { "GPa": 1e6, "MPa": 1e3, "kN/m²": 1, "Ton/m²": 9.80665, "kgf/cm²": 98.0665, "ksi": 6894.757293, "psi": 6.894757293 } },
  I: { nombre: "Inercia (I)", defecto: "cm⁴", u: { "cm⁴": 1e-8, "m⁴": 1, "mm⁴": 1e-12, "in⁴": 4.162314256e-7 } },
  A: { nombre: "Área (A)", defecto: "cm²", u: { "cm²": 1e-4, "m²": 1, "mm²": 1e-6, "in²": 6.4516e-4 } },
};
// las que pide cada estructura: la viga no trabaja a axial y la armadura no flexiona
const propiedadesDelTipo = () => (modelo.tipo === "Viga" ? ["E", "I"] : modelo.tipo === "Armadura" ? ["E", "A"] : ["E", "I", "A"]);

function unidadProp(k) {
  try { const u = localStorage.getItem(`axiomo.unidad.${k}`); if (u && UNIDADES_PROP[k].u[u]) return u; } catch (_) { /* sin almacenamiento */ }
  return UNIDADES_PROP[k].defecto;
}
// 10 cifras significativas: una inercia son 35 000 cm⁴ pero 0,00035 m⁴
const numProp = (v) => String(Number(Number(v).toPrecision(10)));

// los campos de E, I y A, cada uno con su selector de unidad. `fijadas`: las que
// están puestas para toda la estructura (se ven y no se editan); `marcas`: en la
// hoja de toda la estructura, cada una con su interruptor
function camposPropiedades(valores, { fijadas = {}, marcas = false } = {}) {
  return propiedadesDelTipo().map((k) => {
    const P = UNIDADES_PROP[k], u = unidadProp(k);
    const bloqueada = !marcas && fijadas[k] != null;
    const v = fijadas[k] != null ? fijadas[k] : valores[k];
    const opciones = Object.keys(P.u).map((x) => `<option${x === u ? " selected" : ""}>${x}</option>`).join("");
    const texto = numProp(v / P.u[u]);
    // data-modelo / data-texto: si el número no se toca (solo la unidad), se guarda el valor exacto
    return `<div class="campo"><span>${P.nombre}</span><div class="con-unidad">` +
      `<input id="h-p${k}" inputmode="decimal" autocomplete="off" value="${texto}" data-modelo="${v}" data-texto="${texto}"${bloqueada ? " disabled" : ""}>` +
      `<select id="h-u${k}" data-antes="${u}" aria-label="Unidad de ${k}"${bloqueada ? " disabled" : ""}>${opciones}</select></div>` +
      (marcas ? `<label class="interruptor chico">Para toda la estructura<input type="checkbox" id="h-g${k}"${fijadas[k] != null ? " checked" : ""}></label>` : "") +
      `</div>`;
  }).join("");
}

// al cambiar la unidad, el número se convierte: el valor sigue siendo el mismo
function conectarUnidades() {
  for (const k of propiedadesDelTipo()) {
    const sel = $(`h-u${k}`);
    if (!sel) continue;
    sel.addEventListener("change", () => {
      const f = UNIDADES_PROP[k].u, el = $(`h-p${k}`);
      const v = el.value === el.dataset.texto ? Number(el.dataset.modelo) : parseFloat(String(el.value).trim().replace(",", ".")) * f[sel.dataset.antes];
      if (isFinite(v)) {
        el.value = el.dataset.texto = numProp(v / f[sel.value]);
        el.dataset.modelo = v;
      }
      sel.dataset.antes = sel.value;
      try { localStorage.setItem(`axiomo.unidad.${k}`, sel.value); } catch (_) { /* sin almacenamiento */ }
    });
  }
}

// lo escrito, en las unidades del modelo: {E, I, A} solo de las que están en la hoja
function leerPropiedades() {
  const r = {};
  for (const k of propiedadesDelTipo()) {
    const el = $(`h-p${k}`);
    if (!el || el.disabled) continue;
    if (el.value === el.dataset.texto && Number(el.dataset.modelo) > 0) { r[k] = Number(el.dataset.modelo); continue; }
    const v = leerNumero(`h-p${k}`, { nombre: UNIDADES_PROP[k].nombre });
    if (!(v > 0)) throw new Error(`«${UNIDADES_PROP[k].nombre}» debe ser mayor que cero.`);
    r[k] = v * UNIDADES_PROP[k].u[$(`h-u${k}`).value];
  }
  return r;
}

// lo que dice un miembro de sus propiedades, para la nota de su hoja
function notaPropiedades() {
  const g = modelo.propiedades_globales || {};
  const fijas = propiedadesDelTipo().filter((k) => g[k] != null);
  return fijas.length ? `<p class="nota">${fijas.join(", ")} ${fijas.length > 1 ? "están fijados" : "está fijado"} para toda la estructura ` +
    `(menú › Material y sección). Quita la marca allí para darle a este miembro el suyo.</p>` : "";
}

function agregarTramo(L) {
  const ns = nodosOrdenados();
  const ult = ns[ns.length - 1];
  const et = siguienteLetra();
  modelo.nodos.push({ etiqueta: et, x: redondear(ult.x + L), y: 0, rotula: false, k_rotula: 0 });
  const p = propiedadesActuales();
  modelo.miembros.push({ etiqueta: siguienteMiembro(), i: ult.etiqueta, j: et, tipo: "Viga/Pórtico", E: p.E, I: p.I, A: p.A });
}

function cambiarLargo(et, L) {
  const m = miembro(et);
  const g = geo(m);
  const delta = L - g.L;
  for (const n of modelo.nodos) if (n.x >= g.der - 1e-9) n.x = redondear(n.x + delta);
  // las cargas del tramo que quedan fuera se recortan al nuevo largo
  const recortadas = [];
  for (const c of modelo.cargas_puntuales.filter((c) => c.miembro === et)) if (c.s > L) { c.s = L; recortadas.push(c); }
  for (const c of modelo.momentos.filter((c) => c.miembro === et)) if (c.s > L) { c.s = L; recortadas.push(c); }
  for (const lista of ["cargas_distribuidas", "cargas_polinomicas"]) {
    modelo[lista] = modelo[lista].filter((c) => {
      if (c.miembro !== et) return true;
      if (c.x1 >= L - 1e-9) { recortadas.push(c); return false; }
      if (c.x2 > L) { c.x2 = L; recortadas.push(c); leyes.delete(c.id); }
      return true;
    });
  }
  return recortadas.length;
}

function eliminarTramo(et) {
  const m = miembro(et);
  const g = geo(m);
  const der = [nodo(m.i), nodo(m.j)].find((n) => Math.abs(n.x - g.der) < 1e-9);
  modelo.miembros = modelo.miembros.filter((x) => x.etiqueta !== et);
  for (const k of ["cargas_puntuales", "cargas_distribuidas", "cargas_polinomicas"]) modelo[k] = modelo[k].filter((c) => c.miembro !== et);
  modelo.momentos = modelo.momentos.filter((c) => c.miembro !== et && c.nodo !== der.etiqueta);
  modelo.cargas_nodales = modelo.cargas_nodales.filter((c) => c.nodo !== der.etiqueta);
  modelo.apoyos = modelo.apoyos.filter((a) => a.nodo !== der.etiqueta);
  modelo.nodos = modelo.nodos.filter((n) => n.etiqueta !== der.etiqueta);
}

function ponerApoyo(et, tipo) {
  modelo.apoyos = modelo.apoyos.filter((a) => a.nodo !== et);
  if (tipo && tipo !== "Ninguno") modelo.apoyos.push({ nodo: et, tipo, angulo: 90.0, k: 0.0, etiqueta: et, sentido_k: 1.0 });
}

function buscarCarga(id) {
  for (const lista of LISTAS_CARGA) {
    const c = modelo[lista].find((x) => x.id === id);
    if (c) return [lista, c];
  }
  return [null, null];
}

function quitarCarga(id) {
  for (const lista of LISTAS_CARGA) modelo[lista] = modelo[lista].filter((c) => c.id !== id);
  leyes.delete(id);
}

// incógnitas de reacción menos las ecuaciones (ΣFy, ΣM y una por rótula interna)
function gradoHiperestatico() {
  const ns = nodosOrdenados();
  const interiores = new Set(ns.slice(1, -1).map((n) => n.etiqueta));
  const incognitas = modelo.apoyos.reduce((s, a) => s + (a.tipo === "Empotrado" ? 2 : 1), 0);
  const rotulas = modelo.nodos.filter((n) => n.rotula && interiores.has(n.etiqueta)).length;
  return incognitas - 2 - rotulas;
}

function redondear(v) { return Math.round(v * 1e9) / 1e9; }

function leerLocal(k) {
  try { return localStorage.getItem(k); } catch (_) { return null; }
}

function escribirLocal(k, v) {
  try { localStorage.setItem(k, v); } catch (_) { /* sin almacenamiento */ }
}

// cada tipo de estructura guarda su propio modelo en el dispositivo
const TIPOS = ["Viga", "Pórtico", "Armadura", "Sección"];
const CLAVE_TIPO = { "Viga": "axiomo.viga", "Pórtico": "axiomo.portico", "Armadura": "axiomo.armadura", "Sección": "axiomo.seccion" };
// lo que no es viga lo dibuja y lo edita su módulo: marco.js o seccion.js
const otro = () => (modelo.tipo === "Sección" ? SeccionWeb : Marco);

function guardarLocal() {
  escribirLocal(CLAVE_TIPO[modelo.tipo] || "axiomo.viga", JSON.stringify(modelo));
  escribirLocal("axiomo.tipo", modelo.tipo);
}

function cargarLocal(tipo = "Viga") {
  try {
    const t = leerLocal(CLAVE_TIPO[tipo]);
    if (tipo === "Sección") {
      const s = t ? JSON.parse(t) : null;
      return s && s.tipo === "Sección" && Array.isArray(s.figuras) ? s : null;
    }
    const m = t ? normalizar(JSON.parse(t)) : null;
    if (!m || m.tipo !== tipo || !m.nodos.length) return null;
    return tipo !== "Viga" || (m.nodos.length >= 2 && m.miembros.length) ? m : null;
  } catch (_) { return null; }
}

function modeloInicial(tipo) {
  return tipo === "Viga" ? vigaInicial(true) : tipo === "Sección" ? SeccionWeb.inicial() : Marco.inicial(tipo);
}

function cambio({ encuadrar = false } = {}) {
  resultado = null;
  $("resultados").hidden = true;
  if (encuadrar) vista.auto = true;
  guardarLocal();
  dibujar();
  if ((modelo.cargas_polinomicas || []).some((c) => !leyes.has(c.id))) prepararLeyes();
}

// leyes: un polinomio se evalúa aquí; una expresión (seno, coseno) la evalúa el motor
function muestrasPolinomio(coefs, largo, n = 60) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const X = (largo * k) / n;
    pts.push([X, coefs.reduce((s, c, i) => s + c * X ** i, 0)]);
  }
  return pts;
}

async function prepararLeyes() {
  for (const c of modelo.cargas_polinomicas || []) {
    if (leyes.has(c.id)) continue;
    const largo = c.x2 - c.x1;
    if (!c.expresion && c.coeficientes && c.coeficientes.length) {
      leyes.set(c.id, muestrasPolinomio(c.coeficientes, largo));
    } else if (c.expresion) {
      await Motor.esperar();
      try {
        leyes.set(c.id, await Motor.pedir("muestras", { coeficientes: c.coeficientes || [], expresion: c.expresion, largo }));
      } catch (_) { /* se dibuja sin forma */ }
    }
  }
  dibujar();
}

// ======================================================================= formato
function fmt(v, dec = 2) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const a = Math.abs(v) < 1e-9 ? 0 : v;
  return Number(a.toFixed(dec)).toLocaleString("es-CO", { maximumFractionDigits: dec });
}
const fmtL = (v) => `${fmt(v, 3)} m`;
// el valor que se pone en un campo: punto decimal y sin separador de miles
const numCampo = (v) => String(Number(Number(v).toFixed(4)));

function leerNumero(id, { minimo, maximo, nombre } = {}) {
  const el = $(id);
  const v = parseFloat(String(el.value).trim().replace(",", "."));
  if (!isFinite(v)) throw new Error(`Escribe un número en «${nombre || id}».`);
  if (minimo !== undefined && v < minimo) throw new Error(`«${nombre || id}» debe ser al menos ${fmt(minimo, 3)}.`);
  if (maximo !== undefined && v > maximo + 1e-9) throw new Error(`«${nombre || id}» no puede pasar de ${fmt(maximo, 3)}.`);
  return v;
}

let avisoTimer = null;
function aviso(texto, error = false) {
  const a = $("aviso");
  a.textContent = texto;
  a.className = `aviso${error ? " error" : ""}`;
  a.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (a.hidden = true), error ? 6000 : 3500);
}

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ======================================================================= dibujo de la viga
const svg = $("lienzo");
const vista = { k: 1, tx: 0, ty: 0, auto: true };   // auto: se encuadra solo hasta que el usuario mueva el dibujo
let lay = null;

function calcularLayout() {
  const r = svg.getBoundingClientRect();
  const W = Math.max(280, r.width), H = Math.max(220, r.height);
  const xs = modelo.nodos.map((n) => n.x);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const margen = Math.max(38, Math.min(70, W * 0.08));
  const esc = (W - 2 * margen) / Math.max(xmax - xmin, 1e-6);
  return { W, H, margen, y0: H * 0.5, X: (x) => margen + (x - xmin) * esc };
}

function flecha(x1, y1, x2, y2, clase, marca) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="${clase}" marker-end="url(#${marca})"/>`;
}

function texto(x, y, t, clase, ancla = "middle") {
  return `<text x="${x}" y="${y}" class="${clase}" text-anchor="${ancla}">${t}</text>`;
}

// rótulos sin choques: cada texto (y cada repartida dibujada) ocupa una caja, y
// las barras ocupan su segmento; un rótulo nuevo prueba sus posiciones y, si
// todas chocan, sube un renglón
let ocupados = [];
let segmentos = [];                      // [x1, y1, x2, y2] en pantalla: las barras dibujadas

// ¿el segmento pasa por la caja? (recorte de Liang-Barsky)
function segmentoEnCaja([x1, y1, x2, y2], [a, b, c, d]) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - a], [dx, c - x1], [-dy, y1 - b], [dy, d - y1]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

function rotulo(candidatos, t, clase, tam = 12) {
  const ancho = t.length * tam * 0.6 + 4, alto = tam + 2;
  const choca = (c) => ocupados.some((o) => c[0] < o[2] && c[2] > o[0] && c[1] < o[3] && c[3] > o[1]) ||
    segmentos.some((s) => segmentoEnCaja(s, c));
  // cada rótulo va en su sitio aunque se salga del lienzo: el encuadre automático
  // achica el dibujo lo justo para que quepa (correrlo hacia adentro lo montaba en su flecha)
  const probar = (x, y, ancla) => {
    const x1 = ancla === "start" ? x : ancla === "end" ? x - ancho : x - ancho / 2;
    return { caja: [x1, y - alto + 2, x1 + ancho, y + 3], x, ancla, y };
  };
  let elegido = null;
  for (let subida = 0; subida < 10 && !elegido; subida++) {
    for (const [x, y, ancla] of candidatos) {
      const r = probar(x, y - subida * (alto + 2), ancla);
      if (!choca(r.caja)) { elegido = r; break; }
    }
  }
  elegido = elegido || probar(...candidatos[0]);
  ocupados.push(elegido.caja);
  return { svg: texto(elegido.x, elegido.y, escapar(t), clase, elegido.ancla), y: elegido.y };
}

function suelo(X, base) {
  let s = `<line x1="${X - 17}" y1="${base}" x2="${X + 17}" y2="${base}" class="suelo"/>`;
  for (let k = 0; k < 5; k++) s += `<line x1="${X - 14 + k * 7}" y1="${base}" x2="${X - 19 + k * 7}" y2="${base + 6}" class="suelo"/>`;
  return s;
}

function dibujarApoyo(a, X, y0, extremo) {
  let s = "";
  if (a.tipo === "Empotrado") {
    const lado = extremo === "der" ? 1 : -1;
    const xp = X + lado * 3;
    s += `<rect x="${Math.min(xp, xp + lado * 8)}" y="${y0 - 22}" width="8" height="44" class="apoyo"/>`;
    for (let k = 0; k < 6; k++) {
      const yy = y0 - 20 + k * 8;
      s += `<line x1="${xp + lado * 8}" y1="${yy}" x2="${xp + lado * 15}" y2="${yy + 6}" class="suelo"/>`;
    }
    return s;
  }
  if (a.tipo === "Resorte") {
    let d = `M${X} ${y0 + 4} L${X} ${y0 + 9}`;
    for (let k = 0; k < 5; k++) d += ` L${X + (k % 2 ? -7 : 7)} ${y0 + 12 + k * 4.5}`;
    d += ` L${X} ${y0 + 33} L${X} ${y0 + 37}`;
    return `<path d="${d}" class="resorte"/>` + suelo(X, y0 + 37);
  }
  const alto = a.tipo === "Rodillo" ? 15 : 19;
  s += `<polygon points="${X},${y0 + 3} ${X - 12},${y0 + 3 + alto} ${X + 12},${y0 + 3 + alto}" class="apoyo"/>`;
  let base = y0 + 3 + alto;
  if (a.tipo === "Rodillo") {
    s += `<circle cx="${X - 6}" cy="${base + 4}" r="3.5" class="apoyo"/><circle cx="${X + 6}" cy="${base + 4}" r="3.5" class="apoyo"/>`;
    base += 8;
  }
  return s + suelo(X, base);
}

// un momento aplicado: + antihorario; la punta va en el sentido del giro
function dibujarMomentoEn(X, Y, M, id) {
  const r = 17, anti = M >= 0;
  const a0 = anti ? -0.35 : Math.PI + 0.35, a1 = anti ? Math.PI + 0.9 : -0.9;
  const p = (a) => `${X + r * Math.cos(a)} ${Y - r * Math.sin(a)}`;
  return `<g data-tipo="carga" data-id="${id}"><path d="M${p(a0)} A${r} ${r} 0 1 ${anti ? 0 : 1} ${p(a1)}" class="momento" marker-end="url(#fm)"/>` +
    rotulo([[X + 20, Y - 22, "start"], [X - 20, Y - 22, "end"]], `${fmt(Math.abs(M))} kN·m`, "etq-momento").svg +
    `<circle cx="${X}" cy="${Y}" r="24" class="toque-area"/></g>`;
}

// el momento de un empotramiento: un arco por fuera del apoyo
function dibujarMomentoReaccion(X, Y, M, lado) {
  const r = 30, anti = M >= 0;
  const centro = lado > 0 ? 0 : Math.PI;
  const [a0, a1] = anti ? [centro - 1.2, centro + 1.2] : [centro + 1.2, centro - 1.2];
  const p = (a) => `${X + r * Math.cos(a)} ${Y - r * Math.sin(a)}`;
  return `<path d="M${p(a0)} A${r} ${r} 0 0 ${anti ? 0 : 1} ${p(a1)}" class="reaccion" marker-end="url(#fv)"/>` +
    texto(X + lado * (r + 6), Y - r - 4, `${fmt(Math.abs(M))} kN·m`, "etq-reaccion", lado > 0 ? "start" : "end");
}

function interpolar(puntos, t) {
  if (!puntos.length) return 0;
  if (t <= puntos[0][0]) return puntos[0][1];
  for (let i = 1; i < puntos.length; i++) {
    const [a, qa] = puntos[i - 1], [b, qb] = puntos[i];
    if (t <= b) return b - a < 1e-12 ? qb : qa + ((qb - qa) * (t - a)) / (b - a);
  }
  return puntos[puntos.length - 1][1];
}

function dibujar() {
  if (!modelo) return;
  if (modelo.tipo !== "Viga") return otro().dibujar();
  $("ayuda").textContent = "Toca un tramo, un nodo o una carga para editarlo. Pellizca para acercar.";
  lay = calcularLayout();
  const { W, H, X, y0 } = lay;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const ms = miembrosOrdenados(), ns = nodosOrdenados();
  let fondo = "", capaVigas = "", capaRepartidas = "", capaPuntuales = "", capaMomentos = "", capaTramos = "";
  let capaNodos = "", capaRes = "", capaToque = "";
  ocupados = [];
  segmentos = [];
  const defs = `<defs>
    <marker id="fr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#dc2626"/></marker>
    <marker id="fm" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#7c3aed"/></marker>
    <marker id="fv" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#15803d"/></marker>
  </defs>`;

  // ---- cotas de cada tramo, debajo
  const yCota = y0 + 64;
  for (const m of ms) {
    const g = geo(m);
    const xa = X(g.izq), xb = X(g.der);
    fondo += `<line x1="${xa}" y1="${yCota}" x2="${xb}" y2="${yCota}" class="cota"/>`;
    fondo += `<line x1="${xa}" y1="${yCota - 5}" x2="${xa}" y2="${yCota + 5}" class="cota"/><line x1="${xb}" y1="${yCota - 5}" x2="${xb}" y2="${yCota + 5}" class="cota"/>`;
    fondo += texto((xa + xb) / 2, yCota + 16, fmtL(g.L), "etq-cota");
  }

  // ---- tramos (sus nombres se ponen al final, donde no estorben)
  for (const m of ms) {
    const g = geo(m);
    const xa = X(g.izq), xb = X(g.der);
    capaVigas += `<line x1="${xa}" y1="${y0}" x2="${xb}" y2="${y0}" class="viga"/>`;
    capaToque += `<line x1="${xa + 10}" y1="${y0}" x2="${xb - 10}" y2="${y0}" class="toque" data-tipo="miembro" data-id="${m.etiqueta}"/>`;
  }

  // ---- repartidas y con ley: la figura, por niveles en cada tramo
  const todas = [...modelo.cargas_distribuidas.map((c) => ({ c, ley: false })), ...modelo.cargas_polinomicas.map((c) => ({ c, ley: true }))];
  let wmax = 1e-9;
  for (const { c, ley } of todas) {
    if (ley) for (const [, q] of leyes.get(c.id) || []) wmax = Math.max(wmax, Math.abs(q));
    else wmax = Math.max(wmax, Math.abs(c.w1), Math.abs(c.w2));
  }
  const alturaMax = Math.min(40, Math.max(26, H * 0.12));
  const paso = alturaMax + 24;
  const nivelesPorTramo = {};
  const bandas = [];                     // dónde hay repartidas, para que las puntuales pasen por encima
  const repartidas = [];
  for (const { c, ley } of todas) {
    const m = miembro(c.miembro);
    if (!m) continue;
    const g = geo(m);
    const nivel = (nivelesPorTramo[c.miembro] = (nivelesPorTramo[c.miembro] || 0) + 1) - 1;
    const base = y0 - 8 - nivel * paso;
    const xa = X(g.x(c.x1)), xb = X(g.x(c.x2));
    const largo = Math.max(c.x2 - c.x1, 1e-9);
    const muestras = ley ? (leyes.get(c.id) || [[0, 0], [largo, 0]]) : [[0, c.w1], [largo, c.w2]];
    const h = (q) => (Math.abs(q) < 1e-12 ? 0 : Math.max(6, (Math.abs(q) / wmax) * alturaMax));
    const pts = muestras.map(([Xl, q]) => [xa + ((xb - xa) * Xl) / largo, base - h(q)]);
    let fig = `<polygon points="${[[xa, base], ...pts, [xb, base]].map((p) => p.join(",")).join(" ")}" class="${ley ? "carga-ley" : "carga-relleno"}"/>`;
    const nFlechas = Math.max(2, Math.round(Math.abs(xb - xa) / 22));
    const relativas = muestras.map(([Xl, q]) => [Xl / largo, q]);
    for (let k = 0; k <= nFlechas; k++) {
      const t = k / nFlechas;
      const q = interpolar(relativas, t);
      if (Math.abs(q) < 1e-9) continue;
      const xx = xa + (xb - xa) * t, yTop = base - h(q);
      const clase = ley ? "carga-ley-flecha" : "carga", marca = ley ? "fm" : "fr";
      fig += q < 0 ? flecha(xx, yTop, xx, base - 1, clase, marca) : flecha(xx, base - 1, xx, yTop, clase, marca);
    }
    const yFig = Math.min(...pts.map((p) => p[1]), base);
    const izq = Math.min(xa, xb), der = Math.max(xa, xb);
    ocupados.push([izq, yFig - 2, der, base]);
    const toque = `<rect x="${izq}" y="${yFig - 18}" width="${der - izq}" height="${base - yFig + 14}" class="toque-area"/>`;
    repartidas.push({ c, ley, izq, der, wIzq: xa <= xb ? c.w1 : c.w2, wDer: xa <= xb ? c.w2 : c.w1, yTexto: base - alturaMax - 6, fig, toque });
    bandas.push([izq, der, nivel]);
  }

  // ---- puntuales, en un tramo o en un nodo: sus flechas apartan primero su columna
  const flechas = [
    ...modelo.cargas_puntuales.filter((c) => miembro(c.miembro)).map((c) => ({ id: c.id, x: geo(miembro(c.miembro)).x(c.s), fy: c.fy })),
    ...modelo.cargas_nodales.filter((c) => nodo(c.nodo) && Math.abs(c.fy) > 1e-12).map((c) => ({ id: c.id, x: nodo(c.nodo).x, fy: c.fy })),
  ].map((p) => {
    const xx = X(p.x);
    // sobre una repartida (no en su borde) la flecha arranca por encima de ella
    const encima = bandas.filter(([a, b]) => xx > a + 3 && xx < b - 3).reduce((mx, [, , nv]) => Math.max(mx, nv + 1), 0);
    const yTop = y0 - 51 - encima * paso;
    ocupados.push([xx - 4, yTop, xx + 4, y0 - 5]);
    return { ...p, xx, yTop };
  });
  for (const f of flechas) {
    const y = f.yTop - 6;
    const r = rotulo([[f.xx, y, "middle"], [f.xx + 6, y, "start"], [f.xx - 6, y, "end"]], `${fmt(Math.abs(f.fy))} kN`, "etq-carga");
    const yTop = Math.min(f.yTop, r.y + 6);             // si el rótulo subió, la flecha lo alcanza
    if (yTop < f.yTop) ocupados.push([f.xx - 4, yTop, f.xx + 4, f.yTop]);
    capaPuntuales += `<g data-tipo="carga" data-id="${f.id}">` +
      (f.fy <= 0 ? flecha(f.xx, yTop, f.xx, y0 - 5, "carga", "fr") : flecha(f.xx, y0 - 5, f.xx, yTop, "carga", "fr")) + r.svg +
      `<rect x="${f.xx - 18}" y="${r.y - 16}" width="36" height="${y0 - 9 - (r.y - 16)}" class="toque-area"/></g>`;
  }

  // ---- rótulos de las repartidas: al centro, o a un lado si ahí pasa una flecha
  for (const d of repartidas) {
    const xm = (d.izq + d.der) / 2, y = d.yTexto, c = d.c;
    const centrado = [[xm, y, "middle"], [xm - 6, y, "end"], [xm + 6, y, "start"]];
    let et;
    if (d.ley) et = rotulo(centrado, `Q(X) = ${c.funcion_texto || "ley del escritorio"}`, "etq-ley").svg;
    else if (Math.abs(c.w1 - c.w2) < 1e-9) et = rotulo(centrado, `${fmt(Math.abs(c.w1))} kN/m`, "etq-carga").svg;
    else et = rotulo([[d.izq + 5, y, "start"]], fmt(Math.abs(d.wIzq)), "etq-carga").svg +
      rotulo([[d.der - 5, y, "end"]], `${fmt(Math.abs(d.wDer))} kN/m`, "etq-carga").svg;
    capaRepartidas += `<g data-tipo="carga" data-id="${c.id}">${d.fig}${et}${d.toque}</g>`;
  }

  // ---- momentos
  for (const c of modelo.momentos) {
    let x = null;
    if (c.nodo && nodo(c.nodo)) x = nodo(c.nodo).x;
    else if (miembro(c.miembro)) x = geo(miembro(c.miembro)).x(c.s);
    if (x === null) continue;
    capaMomentos += dibujarMomentoEn(X(x), y0, c.M, c.id);
    ocupados.push([X(x) - 19, y0 - 19, X(x) + 19, y0 + 19]);
  }

  // ---- nombres de los tramos: al centro, corridos o un renglón más abajo si ahí hay un momento o un apoyo
  for (const n of ns) {
    const a = apoyoDe(n.etiqueta);
    ocupados.push(a ? [X(n.x) - 19, y0 + 2, X(n.x) + 19, y0 + 54] : [X(n.x) - 9, y0 + 20, X(n.x) + 9, y0 + 36]);
  }
  for (const m of ms) {
    const g = geo(m);
    const xa = X(g.izq), xb = X(g.der), xm = (xa + xb) / 2, cuarto = (xb - xa) / 4;
    const libre = ([x, dy]) => !ocupados.some((o) => x - 17 < o[2] && x + 17 > o[0] && y0 + dy < o[3] && y0 + dy + 16 > o[1]);
    const opciones = [[xm, 9], [xm - cuarto, 9], [xm + cuarto, 9], [xm, 24], [xm - cuarto, 24], [xm + cuarto, 24]];
    const [xe, dy] = opciones.filter(([x]) => x - 15 > xa + 2 && x + 15 < xb - 2).find(libre) ?? [xm, 9];
    capaTramos += `<rect x="${xe - 15}" y="${y0 + dy}" width="30" height="16" rx="5" class="caja-tramo"/>` + texto(xe, y0 + dy + 12, m.etiqueta, "etq-tramo");
  }

  // ---- apoyos, rótulas, nodos y sus nombres
  for (const [k, n] of ns.entries()) {
    const xx = X(n.x);
    const a = apoyoDe(n.etiqueta);
    if (a) capaNodos += dibujarApoyo(a, xx, y0, k === ns.length - 1 && k > 0 ? "der" : "izq");
    capaNodos += n.rotula ? `<circle cx="${xx}" cy="${y0}" r="6" class="rotula"/>` : `<circle cx="${xx}" cy="${y0}" r="4" class="nodo"/>`;
    capaNodos += texto(xx, y0 + (a ? 50 : 32), n.etiqueta, "etq-nodo");
    capaToque += `<circle cx="${xx}" cy="${y0 + 8}" r="21" class="toque-area" data-tipo="nodo" data-id="${n.etiqueta}"/>`;
  }

  // ---- reacciones del último cálculo
  if (resultado) {
    for (const [et, r] of Object.entries(resultado.reacciones || {})) {
      const a = modelo.apoyos.find((x) => x.etiqueta === et) || apoyoDe(et);
      if (!a || !nodo(a.nodo)) continue;
      const xx = X(nodo(a.nodo).x);
      if (r.Ry !== null && r.Ry !== undefined && Math.abs(r.Ry) > 1e-9) {
        const ya = y0 + 92, yb = y0 + 126;
        capaRes += r.Ry > 0 ? flecha(xx, yb, xx, ya, "reaccion", "fv") : flecha(xx, ya, xx, yb, "reaccion", "fv");
        capaRes += texto(xx, yb + 15, `${fmt(Math.abs(r.Ry))} kN`, "etq-reaccion");
      }
      if (r.M !== null && r.M !== undefined && Math.abs(r.M) > 1e-9) {
        const esDer = nodo(a.nodo) === ns[ns.length - 1] && ns.length > 1;
        capaRes += dibujarMomentoReaccion(xx, y0, r.M, esDer ? 1 : -1);
      }
    }
  }

  svg.innerHTML = `${defs}<g id="mundo" transform="translate(${vista.tx} ${vista.ty}) scale(${vista.k})">` +
    `${fondo}${capaVigas}${capaRepartidas}${capaPuntuales}${capaMomentos}${capaTramos}${capaNodos}${capaRes}${capaToque}</g>`;
  if (vista.auto) encuadrar();
}

function aplicarVista() {
  const g = $("mundo");
  if (g) g.setAttribute("transform", `translate(${vista.tx} ${vista.ty}) scale(${vista.k})`);
}

// todo el dibujo a la vista: se centra y, si no cabe, se achica (nunca se agranda)
function encuadrar() {
  const g = $("mundo");
  if (!g || !lay) return;
  let b;
  try { b = g.getBBox(); } catch (_) { return; }
  if (!b || !(b.width > 0) || !(b.height > 0)) return;
  const abajo = ($("ayuda").offsetHeight || 18) + 10, m = 10;
  const k = Math.min(1, (lay.W - 2 * m) / b.width, (lay.H - abajo - m) / b.height);
  vista.k = k;
  vista.tx = (lay.W - k * b.width) / 2 - k * b.x;
  vista.ty = m + (lay.H - abajo - m - k * b.height) / 2 - k * b.y;
  aplicarVista();
}

function ajustarVista() {
  vista.auto = true;
  encuadrar();
}

// ======================================================================= gestos sobre el dibujo
const toques = new Map();
let gesto = null;

function puntoSvg(e) {
  const r = svg.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

svg.addEventListener("pointerdown", (e) => {
  svg.setPointerCapture(e.pointerId);
  toques.set(e.pointerId, puntoSvg(e));
  if (toques.size === 1) {
    const p = puntoSvg(e);
    gesto = { tipo: "uno", x0: p.x, y0: p.y, tx: vista.tx, ty: vista.ty, movido: false, objetivo: e.target.closest("[data-tipo]") };
  } else if (toques.size === 2) {
    const [a, b] = [...toques.values()];
    gesto = { tipo: "dos", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: vista.k, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx: vista.tx, ty: vista.ty };
    vista.auto = false;
  }
});

svg.addEventListener("pointermove", (e) => {
  if (!toques.has(e.pointerId) || !gesto) return;
  toques.set(e.pointerId, puntoSvg(e));
  if (gesto.tipo === "uno" && toques.size === 1) {
    const p = puntoSvg(e);
    const dx = p.x - gesto.x0, dy = p.y - gesto.y0;
    if (!gesto.movido && Math.hypot(dx, dy) > 8) { gesto.movido = true; vista.auto = false; }
    if (gesto.movido) { vista.tx = gesto.tx + dx; vista.ty = gesto.ty + dy; aplicarVista(); }
  } else if (gesto.tipo === "dos" && toques.size === 2) {
    const [a, b] = [...toques.values()];
    const k = Math.max(0.3, Math.min(6, (gesto.k0 * Math.hypot(a.x - b.x, a.y - b.y)) / gesto.d0));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const wx = (gesto.mx - gesto.tx) / gesto.k0, wy = (gesto.my - gesto.ty) / gesto.k0;
    vista.k = k; vista.tx = mx - wx * k; vista.ty = my - wy * k;
    aplicarVista();
  }
});

function soltar(e) {
  if (!toques.has(e.pointerId)) return;
  toques.delete(e.pointerId);
  if (gesto && gesto.tipo === "uno" && !gesto.movido && e.type === "pointerup" && toques.size === 0) tocar(gesto.objetivo);
  if (toques.size === 0) gesto = null;
  else if (toques.size === 1) {
    const p = [...toques.values()][0];
    gesto = { tipo: "uno", x0: p.x, y0: p.y, tx: vista.tx, ty: vista.ty, movido: true, objetivo: null };
  }
}
svg.addEventListener("pointerup", soltar);
svg.addEventListener("pointercancel", soltar);
// el toque ya se atendió en pointerup: sin esto, el «click» que el navegador manda
// después cae en el fondo del panel recién abierto y lo cierra
svg.addEventListener("touchend", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = puntoSvg(e);
  const k = Math.max(0.3, Math.min(6, vista.k * Math.exp(-e.deltaY * 0.0015)));
  const wx = (p.x - vista.tx) / vista.k, wy = (p.y - vista.ty) / vista.k;
  vista.k = k; vista.tx = p.x - wx * k; vista.ty = p.y - wy * k; vista.auto = false;
  aplicarVista();
}, { passive: false });

function tocar(el) {
  if (modelo.tipo !== "Viga") return otro().tocar(el);
  if (!el) return;
  const tipo = el.dataset.tipo, id = el.dataset.id;
  if (tipo === "miembro") hojaTramo(id);
  else if (tipo === "nodo") hojaApoyo(id);
  else if (tipo === "carga") {
    const [lista] = buscarCarga(Number(id));
    if (lista === "momentos") hojaMomento({ id: Number(id) });
    else if (lista) hojaCarga({ id: Number(id) });
  }
}

// ======================================================================= hojas (paneles desde abajo)
let alElegir = null;      // lo que hace la hoja abierta cuando se toca uno de sus chips
let hojaAbiertaEn = 0;

function abrirHoja(titulo, cuerpo, botones, alAbrir) {
  alElegir = null;
  hojaAbiertaEn = performance.now();
  $("hoja-titulo").textContent = titulo;
  $("hoja-cuerpo").innerHTML = cuerpo;
  $("hoja-error").hidden = true;
  const caja = $("hoja-botones");
  caja.innerHTML = "";
  for (const b of botones) {
    const el = document.createElement("button");
    el.textContent = b.texto;
    if (b.clase) el.className = b.clase;
    el.addEventListener("click", async () => {
      try {
        if ((await b.accion()) !== false) cerrarHoja();
      } catch (err) {
        $("hoja-error").textContent = String(err.message || err);
        $("hoja-error").hidden = false;
      }
    });
    caja.appendChild(el);
  }
  $("hoja").hidden = false;
  $("hoja").querySelector(".hoja-panel").scrollTop = 0;
  if (alAbrir) alAbrir();
}

function cerrarHoja() {
  $("hoja").hidden = true;
  alElegir = null;
}
// un clic que llega en el primer medio segundo es el mismo toque que abrió la hoja
$("hoja-fondo").addEventListener("click", () => { if (performance.now() - hojaAbiertaEn > 450) cerrarHoja(); });

// en cada grupo de chips queda uno solo activo
$("hoja-cuerpo").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip[data-grupo]");
  if (!chip) return;
  for (const c of $("hoja-cuerpo").querySelectorAll(`.chip[data-grupo="${chip.dataset.grupo}"]`)) c.classList.toggle("activo", c === chip);
  if (alElegir) alElegir(chip.dataset.grupo, chip.dataset.valor);
});

const chips = (grupo, opciones, activo) => `<div class="chips">${opciones.map(([v, t]) =>
  `<button type="button" class="chip${String(v) === String(activo) ? " activo" : ""}" data-grupo="${grupo}" data-valor="${escapar(v)}">${t}</button>`).join("")}</div>`;
const valorChip = (grupo) => { const c = $("hoja-cuerpo").querySelector(`.chip.activo[data-grupo="${grupo}"]`); return c ? c.dataset.valor : null; };
const campo = (id, rotulo, valor, { modo = "decimal", extra = "" } = {}) =>
  `<label class="campo"><span>${rotulo}</span><input id="${id}" inputmode="${modo}" autocomplete="off" value="${escapar(valor)}" ${extra}></label>`;
const opcionesTramos = () => miembrosOrdenados().map((m) => [m.etiqueta, `${m.etiqueta} · ${fmtL(geo(m).L)}`]);

function hojaNuevoTramo() {
  abrirHoja("Agregar un tramo a la derecha", campo("h-largo", "Longitud del tramo (m)", "4"), [
    { texto: "Cancelar", clase: "secundario", accion: () => true },
    { texto: "Agregar", accion: () => { agregarTramo(leerNumero("h-largo", { minimo: 0.1, nombre: "Longitud" })); cambio({ encuadrar: true }); } },
  ]);
}

function hojaTramo(et) {
  const m = miembro(et);
  const g = geo(m);
  const esUltimo = miembrosOrdenados().at(-1) === m && modelo.miembros.length > 1;
  const botones = [
    { texto: "Cerrar", clase: "secundario", accion: () => true },
    { texto: "Guardar", accion: () => {
      const L = leerNumero("h-largo", { minimo: 0.1, nombre: "Longitud" });
      Object.assign(m, leerPropiedades());
      const n = Math.abs(L - g.L) < 1e-9 ? 0 : cambiarLargo(et, L);
      cambio({ encuadrar: true });
      if (n) aviso(`${n} carga${n > 1 ? "s se ajustaron" : " se ajustó"} al nuevo largo.`);
    } },
  ];
  if (esUltimo) botones.unshift({ texto: "Eliminar", clase: "peligro", accion: () => { eliminarTramo(et); cambio({ encuadrar: true }); } });
  const nota = modelo.miembros.length > 1 && !esUltimo ? `<p class="nota">Solo se puede eliminar el último tramo de la derecha.</p>` : "";
  abrirHoja(`Tramo ${et}`, `${campo("h-largo", "Longitud (m)", numCampo(g.L))}
    ${camposPropiedades(m, { fijadas: modelo.propiedades_globales || {} })}${notaPropiedades()}
    <div class="chips"><button type="button" class="chip" id="h-carga-aqui">+ Carga en ${et}</button>
    <button type="button" class="chip" id="h-momento-aqui">+ Momento en ${et}</button></div>${nota}`, botones, () => {
    conectarUnidades();
    $("h-carga-aqui").addEventListener("click", () => hojaCarga({ tramo: et }));
    $("h-momento-aqui").addEventListener("click", () => hojaMomento({ tramo: et }));
  });
}

function hojaApoyo(etInicial) {
  const ns = nodosOrdenados();
  const et0 = etInicial || (ns.find((n) => !apoyoDe(n.etiqueta)) || ns[0]).etiqueta;
  const tipos = [["Ninguno", "Ninguno"], ["Articulado", "Articulado"], ["Rodillo", "Rodillo"], ["Empotrado", "Empotrado"]];
  const html = `<label class="campo"><span>Nodo</span></label>${chips("nodo", ns.map((n) => [n.etiqueta, n.etiqueta]), et0)}
    <label class="campo"><span>Tipo de apoyo</span></label>${chips("tipo", tipos, (apoyoDe(et0) || { tipo: "Ninguno" }).tipo)}
    <div id="h-rotula"></div>`;
  abrirHoja("Apoyos y rótulas", html, [
    { texto: "Cerrar", clase: "secundario", accion: () => true },
    { texto: "Aplicar", accion: () => {
      const n = nodo(valorChip("nodo") || et0);
      const tipo = valorChip("tipo");
      const actual = apoyoDe(n.etiqueta);
      // un resorte del escritorio no tiene chip: si no se elige otro tipo, se conserva
      if (tipo && tipo !== (actual ? actual.tipo : "Ninguno")) ponerApoyo(n.etiqueta, tipo);
      if ($("h-rot")) n.rotula = $("h-rot").checked;
      cambio();
    } },
  ], () => {
    const refrescar = () => {
      const n = nodo(valorChip("nodo") || et0);
      const a = apoyoDe(n.etiqueta);
      for (const c of $("hoja-cuerpo").querySelectorAll('.chip[data-grupo="tipo"]')) c.classList.toggle("activo", c.dataset.valor === (a ? a.tipo : "Ninguno"));
      const interior = ns[0] !== n && ns[ns.length - 1] !== n;
      $("h-rotula").innerHTML = (a && a.tipo === "Resorte" ? `<p class="nota">Este nodo tiene un resorte (k = ${fmt(a.k, 2)} kN/m) hecho en el escritorio.</p>` : "") +
        (interior ? `<label class="interruptor">Rótula interna en ${n.etiqueta} (M = 0)<input type="checkbox" id="h-rot" ${n.rotula ? "checked" : ""}></label>`
                  : `<p class="nota">Una rótula interna va en un nodo intermedio.</p>`);
    };
    alElegir = (grupo) => { if (grupo === "nodo") refrescar(); };
    refrescar();
  });
}

function textoPolinomio(coefs) {
  const t = [];
  (coefs || []).forEach((k, i) => {
    if (Math.abs(k) < 1e-12) return;
    const v = String(Number(Math.abs(k).toPrecision(10)));
    const pot = i === 0 ? "" : i === 1 ? "X" : `X^${i}`;
    const cuerpo = i === 0 ? v : v === "1" ? pot : `${v}*${pot}`;
    t.push(k < 0 ? `- ${cuerpo}` : t.length ? `+ ${cuerpo}` : cuerpo);
  });
  return t.join(" ") || "0";
}

function hojaCarga({ id = null, tipo = null, tramo = null } = {}) {
  const [lista, c] = id !== null ? buscarCarga(id) : [null, null];
  const ms = miembrosOrdenados();
  const tipoIni = c ? { cargas_puntuales: "puntual", cargas_nodales: "puntual", cargas_distribuidas: "repartida",
                        cargas_polinomicas: "funcion" }[lista] : (tipo || "repartida");
  let tramoIni = tramo || (c && c.miembro) || ms[0].etiqueta;
  let a0 = 0, b0 = geo(miembro(tramoIni)).L, P = 10, w1 = 10, w2 = 10, sentido = "abajo", ley = "2.5X^2 - 15X";
  if (c && lista === "cargas_nodales") {
    // una puntual en un nodo se edita como puntual en el tramo que llega a ese nodo
    const n = nodo(c.nodo);
    const m = ms.find((mm) => Math.abs(geo(mm).der - n.x) < 1e-9) || ms.find((mm) => Math.abs(geo(mm).izq - n.x) < 1e-9);
    tramoIni = m.etiqueta;
    a0 = Math.abs(n.x - geo(m).xi);
    P = Math.abs(c.fy); sentido = c.fy > 0 ? "arriba" : "abajo";
  } else if (c && lista === "cargas_puntuales") {
    a0 = c.s; P = Math.abs(c.fy); sentido = c.fy > 0 ? "arriba" : "abajo";
  } else if (c && lista === "cargas_distribuidas") {
    a0 = c.x1; b0 = c.x2;
    sentido = (Math.abs(c.w1) >= Math.abs(c.w2) ? c.w1 : c.w2) > 0 ? "arriba" : "abajo";
    const sg = sentido === "arriba" ? 1 : -1;
    w1 = c.w1 * sg; w2 = c.w2 * sg;      // en el sentido elegido: si uno queda negativo, va al revés
  } else if (c && lista === "cargas_polinomicas") {
    a0 = c.x1; b0 = c.x2; ley = c.funcion_texto || c.expresion || textoPolinomio(c.coeficientes);
  }
  const leyInicial = ley;
  const html = `
    <label class="campo"><span>Tipo de carga</span></label>
    ${chips("tipo", [["puntual", "Puntual"], ["repartida", "Repartida"], ["funcion", "Función Q(X)"]], tipoIni)}
    <label class="campo"><span>Tramo</span></label>
    ${chips("tramo", opcionesTramos(), tramoIni)}
    <div id="h-campos"></div>`;
  const botones = [
    { texto: "Cancelar", clase: "secundario", accion: () => true },
    { texto: c ? "Guardar" : "Agregar", accion: () => aplicarCarga(c ? id : null, lista === "cargas_polinomicas" ? c : null, leyInicial) },
  ];
  if (c) botones.unshift({ texto: "Eliminar", clase: "peligro", accion: () => { quitarCarga(id); cambio(); } });
  abrirHoja(c ? "Editar carga" : "Agregar carga", html, botones, () => {
    // lo escrito se conserva al cambiar de tipo o de tramo
    const recordar = () => {
      const v = (k) => { const el = $(k); if (!el) return null; const x = parseFloat(el.value.replace(",", ".")); return isFinite(x) ? x : null; };
      a0 = v("h-a") ?? a0; b0 = v("h-b") ?? b0; P = v("h-P") ?? P; w1 = v("h-w1") ?? w1; w2 = v("h-w2") ?? w2;
      if ($("h-ley")) ley = $("h-ley").value;
      sentido = valorChip("sentido") || sentido;
    };
    const pintar = () => {
      const t = valorChip("tipo");
      const L = geo(miembro(valorChip("tramo"))).L;
      const desdeHasta = `<div class="fila">${campo("h-a", "Desde (m)", numCampo(Math.min(a0, L)))}${campo("h-b", "Hasta (m)", numCampo(Math.min(b0, L)))}</div>`;
      const sent = chips("sentido", [["abajo", "↓ Hacia abajo"], ["arriba", "↑ Hacia arriba"]], sentido);
      if (t === "puntual") {
        $("h-campos").innerHTML = `${campo("h-a", `Distancia desde el inicio del tramo (0 a ${fmt(L, 3)} m)`, numCampo(Math.min(a0, L)))}
          ${campo("h-P", "Valor (kN)", numCampo(P))}${sent}`;
      } else if (t === "repartida") {
        $("h-campos").innerHTML = `${desdeHasta}
          <div class="fila">${campo("h-w1", "Al inicio (kN/m)", numCampo(w1))}${campo("h-w2", "Al final (kN/m)", numCampo(w2))}</div>${sent}
          <p class="nota">Iguales: uniforme. Distintas: trapezoidal; con cero en un extremo: triangular.</p>`;
      } else {
        $("h-campos").innerHTML = `${desdeHasta}
          ${campo("h-ley", "Q(X) en kN/m, con X desde el inicio de la carga", ley, { modo: "text", extra: 'autocapitalize="off" autocorrect="off" spellcheck="false"' })}
          <p class="texto-ley" id="h-ley-texto"></p><svg class="vista-previa" id="h-ley-vista" viewBox="0 0 300 90"></svg>
          <p class="nota">Negativo = hacia abajo. Ejemplos: <b>2.5X^2 - 15X</b>, <b>-10</b>, <b>-6*sin(pi*X/6)</b>.</p>`;
        const actualizar = debounce(vistaPreviaLey, 450);
        for (const k of ["h-ley", "h-a", "h-b"]) $(k).addEventListener("input", actualizar);
        vistaPreviaLey();
      }
    };
    alElegir = (grupo, valor) => {
      if (grupo === "tipo") { recordar(); pintar(); }
      else if (grupo === "tramo") { recordar(); a0 = 0; b0 = geo(miembro(valor)).L; pintar(); }
    };
    pintar();
  });
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function vistaPreviaLey() {
  const etq = $("h-ley-texto");
  if (!etq) return;
  let largo;
  try { largo = leerNumero("h-b") - leerNumero("h-a"); } catch (_) { return; }
  if (!(largo > 0)) { etq.textContent = "«Hasta» debe ser mayor que «Desde»."; return; }
  if (!Motor.listo) { etq.textContent = "El motor está cargando: la vista previa aparece en un momento…"; await Motor.esperar(); }
  if (!$("h-ley")) return;                 // se cerró la hoja mientras tanto
  const r = await Motor.pedir("ley", { texto: $("h-ley").value, largo }).catch((e) => ({ ok: false, error: String(e.message || e) }));
  const caja = $("h-ley-vista");
  if (!caja) return;
  if (!r.ok) { $("h-ley-texto").textContent = r.error; caja.innerHTML = ""; return; }
  $("h-ley-texto").textContent = `Q(X) = ${r.texto}`;
  const qs = r.muestras.map((p) => p[1]);
  const qmax = Math.max(1e-9, ...qs.map(Math.abs));
  const y = (q) => 45 - (q / qmax) * 38;
  const pts = r.muestras.map(([X, q]) => `${10 + (280 * X) / largo},${y(q)}`).join(" ");
  // se rotula el valor de mayor magnitud, donde ocurre
  const k = qs.reduce((mejor, q, i) => (Math.abs(q) > Math.abs(qs[mejor]) ? i : mejor), 0);
  const xk = 10 + (280 * r.muestras[k][0]) / largo, qk = qs[k];
  const ancla = xk < 40 ? "start" : xk > 260 ? "end" : "middle";
  caja.innerHTML = `<line x1="10" y1="45" x2="290" y2="45" stroke="#94a3b8"/><polygon points="10,45 ${pts} 290,45" class="carga-ley"/>` +
    `<text x="${xk}" y="${qk >= 0 ? y(qk) + 15 : y(qk) - 6}" text-anchor="${ancla}" class="etq-ley">${fmt(qk)}</text>`;
}

async function aplicarCarga(idEditado, original, leyInicial) {
  const t = valorChip("tipo"), et = valorChip("tramo");
  const L = geo(miembro(et)).L;
  const signo = valorChip("sentido") === "arriba" ? 1 : -1;
  let lista, datos, muestras = null;
  if (t === "puntual") {
    const a = leerNumero("h-a", { minimo: 0, maximo: L, nombre: "Distancia" });
    const P = leerNumero("h-P", { minimo: 0, nombre: "Valor" });
    if (P === 0) throw new Error("La carga no puede valer cero.");
    lista = "cargas_puntuales";
    datos = { miembro: et, s: a, fx: 0, fy: signo * P };
  } else {
    const a = leerNumero("h-a", { minimo: 0, maximo: L, nombre: "Desde" });
    const b = leerNumero("h-b", { minimo: 0, maximo: L, nombre: "Hasta" });
    if (b - a < 1e-6) throw new Error("«Hasta» debe ser mayor que «Desde».");
    if (t === "repartida") {
      const w1 = leerNumero("h-w1", { nombre: "Al inicio" }), w2 = leerNumero("h-w2", { nombre: "Al final" });
      if (w1 === 0 && w2 === 0) throw new Error("La carga no puede ser cero en los dos extremos.");
      lista = "cargas_distribuidas";
      datos = { miembro: et, x1: a, x2: b, w1: signo * w1, w2: signo * w2, direccion: "local" };
    } else {
      const textoLey = $("h-ley").value.trim();
      if (!textoLey) throw new Error("Escribe la función Q(X).");
      lista = "cargas_polinomicas";
      if (original && textoLey === leyInicial.trim()) {
        // la misma ley de antes: se conserva tal como vino (coeficientes, condiciones)
        datos = { ...original, miembro: et, x1: a, x2: b };
        delete datos.id;
      } else {
        await Motor.esperar();
        const r = await Motor.pedir("ley", { texto: textoLey, largo: b - a });
        if (!r.ok) throw new Error(r.error);
        datos = { miembro: et, x1: a, x2: b, grado: r.grado, condiciones: [], coeficientes: r.coeficientes,
                  funcion_texto: textoLey, expresion: r.expresion };
        muestras = r.muestras;
      }
    }
  }
  const id = idEditado !== null ? idEditado : nuevoId();
  if (idEditado !== null) quitarCarga(idEditado);
  modelo[lista].push({ id, ...datos });
  if (muestras) leyes.set(id, muestras);
  cambio();
}

function hojaMomento({ id = null, tramo = null } = {}) {
  const [, c] = id !== null ? buscarCarga(id) : [null, null];
  const ms = miembrosOrdenados();
  let tramoIni = tramo || ms[0].etiqueta, a0 = 0, M = 10, sentido = "anti";
  if (c) {
    M = Math.abs(c.M); sentido = c.M >= 0 ? "anti" : "horario";
    if (c.nodo && nodo(c.nodo)) {
      const n = nodo(c.nodo);
      const m = ms.find((mm) => Math.abs(geo(mm).izq - n.x) < 1e-9) || ms.find((mm) => Math.abs(geo(mm).der - n.x) < 1e-9);
      tramoIni = m.etiqueta; a0 = Math.abs(n.x - geo(m).xi);
    } else { tramoIni = c.miembro; a0 = c.s; }
  }
  const html = `<label class="campo"><span>Tramo</span></label>${chips("tramo", opcionesTramos(), tramoIni)}
    ${campo("h-a", "Distancia desde el inicio del tramo (m)", numCampo(a0))}${campo("h-M", "Valor (kN·m)", numCampo(M))}
    ${chips("sentido", [["anti", "↺ Antihorario"], ["horario", "↻ Horario"]], sentido)}`;
  const botones = [
    { texto: "Cancelar", clase: "secundario", accion: () => true },
    { texto: c ? "Guardar" : "Agregar", accion: () => {
      const et = valorChip("tramo");
      const a = leerNumero("h-a", { minimo: 0, maximo: geo(miembro(et)).L, nombre: "Distancia" });
      const valor = leerNumero("h-M", { minimo: 0, nombre: "Valor" });
      if (valor === 0) throw new Error("El momento no puede valer cero.");
      const nid = c ? id : nuevoId();
      if (c) quitarCarga(id);
      modelo.momentos.push({ id: nid, M: valor * (valorChip("sentido") === "horario" ? -1 : 1), miembro: et, s: a, nodo: "" });
      cambio();
    } },
  ];
  if (c) botones.unshift({ texto: "Eliminar", clase: "peligro", accion: () => { quitarCarga(id); cambio(); } });
  abrirHoja(c ? "Editar momento" : "Agregar momento", html, botones);
}

// como el panel Propiedades del escritorio: cada una con su marca «para toda la
// estructura». Lo marcado se escribe en todos los miembros, los de ahora y los
// nuevos, y en la hoja de cada miembro se ve bloqueado; lo que no, lo lleva cada uno
function hojaMaterial() {
  const g = modelo.propiedades_globales || {};
  const quien = modelo.tipo === "Viga" ? "tramo" : "barra";
  abrirHoja("Material y sección", `
    <p class="nota">Marca una propiedad para fijarla en toda la estructura. Sin marcar, cada ${quien} lleva la suya: ${quien === "tramo" ? "tócalo" : "tócala"} en el dibujo para cambiarla.</p>
    ${camposPropiedades(propiedadesActuales(), { fijadas: g, marcas: true })}
    <p class="nota">Cambian los desplazamientos y las estructuras hiperestáticas; en una isostática las reacciones no dependen de ellas.</p>`, [
    { texto: "Cancelar", clase: "secundario", accion: () => true },
    { texto: "Aplicar", accion: () => {
      const valores = leerPropiedades();
      const nuevas = { ...g };
      for (const k of propiedadesDelTipo()) {
        if ($(`h-g${k}`).checked) {
          nuevas[k] = valores[k];
          for (const m of modelo.miembros) m[k] = valores[k];
        } else nuevas[k] = null;      // cada miembro conserva el valor que tenía
      }
      modelo.propiedades_globales = nuevas;
      cambio();
    } },
  ], conectarUnidades);
}

// ======================================================================= calcular y resultados
async function calcular() {
  const btn = $("btn-calcular");
  if (!Motor.listo && !Motor.fallo) aviso("El motor está terminando de cargar; calculo en cuanto esté listo…");
  btn.disabled = true;
  btn.querySelector("span").textContent = "…";
  try {
    await Motor.esperar();
    if (Motor.fallo) throw new Error("El motor no cargó. Revisa la conexión a internet y vuelve a abrir la app.");
    const r = await Motor.pedir("calcular", { modelo });
    if (!r.ok) throw new Error(r.error);
    resultado = r;
    dibujar();
    mostrarResultados();
    $("resultados").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    aviso(String(err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.querySelector("span").textContent = "Calcular";
  }
}

function mostrarResultados() {
  $("nota-diagramas").textContent = modelo.tipo === "Sección"
    ? "τ y σ a lo alto de la sección; la línea roja es el eje neutro."
    : "Toca o desliza sobre los diagramas para leer los valores.";
  if (modelo.tipo !== "Viga") return otro().mostrarResultados();
  const r = resultado;
  $("res-metodo").textContent = r.metodo;
  $("res-notas").textContent = [...(r.notas || []), ...(r.avisos || [])].join(" ");
  const conM = Object.values(r.reacciones).some((v) => v.M !== null && v.M !== undefined);
  const filas = Object.entries(r.reacciones).map(([et, v]) => {
    const a = modelo.apoyos.find((x) => x.etiqueta === et) || apoyoDe(et);
    return `<tr><td><b>${escapar(a ? a.nodo : et)}</b></td><td class="num">${fmt(v.Ry, 3)}</td>` +
      (conM ? `<td class="num">${v.M === null || v.M === undefined ? "—" : fmt(v.M, 3)}</td>` : "") + `</tr>`;
  }).join("");
  $("res-reacciones").innerHTML = `<tr><th>Apoyo</th><th class="num">Ry (kN) ↑+</th>${conM ? `<th class="num">M (kN·m) ↺+</th>` : ""}</tr>${filas}`;
  $("resultados").hidden = false;
  dibujarDiagramas();
}

function serie(nombre, factor = 1) {
  const por = resultado && resultado.diagramas && resultado.diagramas[nombre];
  if (!por) return null;
  const segmentos = [];
  for (const m of miembrosOrdenados()) {
    const c = por[m.etiqueta];
    if (!c || !c.length) continue;
    const g = geo(m);
    segmentos.push(c.map(([s, v]) => [g.x(s), v * factor]).sort((p, q) => p[0] - q[0]));
  }
  return segmentos.length ? segmentos : null;
}

const PANELES = [
  { nombre: "Cortante (DFC)", titulo: "Cortante V (kN)", clase: "diag-v", color: "#2563eb", unidad: "kN", factor: 1 },
  { nombre: "Momento (DMF)", titulo: "Momento M (kN·m)", clase: "diag-m", color: "#dc2626", unidad: "kN·m", factor: 1 },
  { nombre: "Desplazamiento Vertical", titulo: "Flecha (mm)", clase: "diag-d", color: "#15803d", unidad: "mm", factor: 1000 },
];

function dibujarDiagramas() {
  if (modelo.tipo !== "Viga") return otro().dibujarDiagramas();
  const caja = $("diagramas");
  const W = Math.max(280, caja.clientWidth || 340);
  const H = 150;
  const xs = modelo.nodos.map((n) => n.x);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const margen = Math.max(38, Math.min(70, W * 0.08));
  const X = (x) => margen + ((x - xmin) * (W - 2 * margen)) / Math.max(xmax - xmin, 1e-9);
  caja.innerHTML = "";
  caja._paneles = [];
  for (const p of PANELES) {
    const seg = serie(p.nombre, p.factor);
    if (!seg) continue;
    const vals = seg.flat().map((q) => q[1]);
    const vmax = Math.max(...vals), vmin = Math.min(...vals);
    const amp = Math.max(Math.abs(vmax), Math.abs(vmin), 1e-9);
    const y0 = H / 2 + 6, esc = (H / 2 - 24) / amp;
    const Y = (v) => y0 - v * esc;
    let s = `<text x="6" y="14" class="diag-titulo" fill="${p.color}">${p.titulo}</text>`;
    for (const n of modelo.nodos) s += `<line x1="${X(n.x)}" y1="18" x2="${X(n.x)}" y2="${H - 4}" class="diag-rejilla"/>`;
    s += `<line x1="${X(xmin)}" y1="${y0}" x2="${X(xmax)}" y2="${y0}" class="diag-eje"/>`;
    for (const sg of seg) {
      const pts = sg.map(([x, v]) => `${X(x)},${Y(v)}`).join(" ");
      s += `<polygon points="${X(sg[0][0])},${y0} ${pts} ${X(sg[sg.length - 1][0])},${y0}" class="${p.clase}"/>`;
    }
    // el máximo y el mínimo con su valor
    const usados = [];
    for (const sg of seg) for (const [x, v] of sg) {
      const esExtremo = (Math.abs(v - vmax) < 1e-9 * amp && Math.abs(vmax) > 1e-9) || (Math.abs(v - vmin) < 1e-9 * amp && Math.abs(vmin) > 1e-9);
      if (!esExtremo || usados.some(([ux, uv]) => Math.abs(X(ux) - X(x)) < 44 && Math.sign(uv) === Math.sign(v))) continue;
      usados.push([x, v]);
      const ancla = X(x) < 50 ? "start" : X(x) > W - 50 ? "end" : "middle";
      s += `<circle cx="${X(x)}" cy="${Y(v)}" r="3" fill="${p.color}"/>`;
      s += `<text x="${X(x)}" y="${v >= 0 ? Y(v) - 6 : Y(v) + 15}" text-anchor="${ancla}" class="diag-valor" fill="${p.color}">${fmt(v)}</text>`;
    }
    s += `<g class="cursor"></g>`;
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", `0 0 ${W} ${H}`);
    el.innerHTML = s;
    caja.appendChild(el);
    caja._paneles.push({ el, seg, X, Y, W, H, p, xmin, xmax, margen });
  }
}

function valorEn(seg, x) {
  for (const sg of seg) {
    if (x >= sg[0][0] - 1e-9 && x <= sg[sg.length - 1][0] + 1e-9) return interpolar(sg, x);
  }
  return null;
}

// el mismo x en los tres diagramas, con su valor
function moverCursor(e) {
  if (modelo.tipo !== "Viga") { if (e.type === "pointerdown") otro().leer(e); return; }
  const caja = $("diagramas");
  if (!caja._paneles || !caja._paneles.length) return;
  for (const pan of caja._paneles) {
    const r = pan.el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * pan.W;
    const x = pan.xmin + ((px - pan.margen) * (pan.xmax - pan.xmin)) / (pan.W - 2 * pan.margen);
    const g = pan.el.querySelector(".cursor");
    const v = x < pan.xmin - 1e-9 || x > pan.xmax + 1e-9 ? null : valorEn(pan.seg, x);
    if (v === null) { g.innerHTML = ""; continue; }
    const X = pan.X(x), Y = pan.Y(v);
    const etiqueta = `x = ${fmt(x, 2)} m · ${fmt(v, 2)} ${pan.p.unidad}`;
    const ancho = etiqueta.length * 6.6 + 14;
    const bx = Math.min(Math.max(X - ancho / 2, 2), pan.W - ancho - 2);
    g.innerHTML = `<line x1="${X}" y1="18" x2="${X}" y2="${pan.H - 4}" class="cursor-linea"/><circle cx="${X}" cy="${Y}" r="4" fill="${pan.p.color}"/>
      <rect x="${bx}" y="20" width="${ancho}" height="20" rx="6" class="cursor-caja"/><text x="${bx + ancho / 2}" y="34" text-anchor="middle" class="cursor-texto">${etiqueta}</text>`;
  }
}
$("diagramas").addEventListener("pointerdown", moverCursor);
$("diagramas").addEventListener("pointermove", moverCursor);

// ======================================================================= paso a paso
// iso: solo vigas isostáticas; hiper: solo hiperestáticas (el motor lo vuelve a revisar)
const METODOS = [
  { m: "Reacciones (Estática)", tema: "Mecánica de Sólidos", desc: "Reacciones por equilibrio, cortes por tramos y diagramas.", pide: null, iso: true },
  { m: "Fuerzas Internas en un Punto", tema: "Mecánica de Sólidos", desc: "V y M en un punto, por los dos lados del corte.", pide: "punto", iso: true },
  { m: "Doble Integración", tema: "Mecánica de Sólidos", desc: "La elástica integrando M/EI, con sus constantes.", pide: "alcance", iso: true },
  { m: "Superposición", tema: "Análisis Clásico", desc: "Flechas y giros sumando casos de tabla.", pide: "alcance", iso: true },
  { m: "Viga Conjugada", tema: "Análisis Clásico", desc: "La conjugada cargada con M/EI.", pide: "alcance", iso: true },
  { m: "Área-Momento", tema: "Análisis Clásico", desc: "Los dos teoremas sobre el diagrama M/EI.", pide: "alcance", iso: true },
  { m: "Trabajo Virtual", tema: "Análisis Clásico", desc: "Flecha o giro en un punto con la carga unitaria.", pide: "energia", iso: true },
  { m: "Castigliano", tema: "Análisis Clásico", desc: "Flecha o giro en un punto derivando la energía.", pide: "energia", iso: true },
  { m: "Tres Momentos", tema: "Análisis Clásico", desc: "Vigas continuas: la ecuación de Clapeyron.", pide: "flecha", hiper: true },
  { m: "Pendiente-Deflexión", tema: "Análisis Clásico", desc: "Giros en los nudos y momentos en los extremos.", pide: "flecha" },
  { m: "Método de Cross", tema: "Análisis Clásico", desc: "Distribución de momentos por iteraciones.", pide: null },
  { m: "Matricial de Rigidez", tema: "Análisis Matricial", desc: "Matrices de cada tramo, ensamble y solución.", pide: "mep" },
];

// la razón corta va en la lista (el encabezado ya dice el grado); la larga, en el aviso al tocarlo
function noAplica(met, grado, larga = false) {
  if (grado < 0) return "La viga es inestable: le faltan apoyos.";
  if (met.iso && grado > 0) return larga ? `Es para vigas isostáticas y esta es hiperestática de grado ${grado}.` : "Solo para vigas isostáticas.";
  if (met.hiper && grado === 0) return larga ? "Es para vigas continuas hiperestáticas y esta es isostática." : "Solo para vigas hiperestáticas.";
  return "";
}

function hojaPasoAPaso() {
  if (modelo.tipo !== "Viga") return otro().hojaPasoAPaso();
  const grado = gradoHiperestatico();
  const estado = grado < 0 ? "La viga es inestable: le faltan apoyos." : grado === 0 ? "Viga isostática." : `Viga hiperestática de grado ${grado}.`;
  const algunoNo = METODOS.some((x) => noAplica(x, grado));
  let html = `<p class="nota">${estado}${algunoNo ? " Los métodos en gris no aplican a esta viga." : ""}</p><div class="lista-metodos">`;
  for (const tema of ["Mecánica de Sólidos", "Análisis Clásico", "Análisis Matricial"]) {
    html += `<h4>${tema}</h4>`;
    for (const [i, x] of METODOS.entries()) {
      if (x.tema !== tema) continue;
      const razon = noAplica(x, grado);
      html += `<button class="metodo${razon ? " no-aplica" : ""}" data-i="${i}"><b>${x.m}</b><small>${razon || x.desc}</small></button>`;
    }
  }
  html += `</div>`;
  abrirHoja("Paso a paso: elige el método", html, [{ texto: "Cerrar", clase: "secundario", accion: () => true }], () => {
    for (const b of $("hoja-cuerpo").querySelectorAll(".metodo")) {
      b.addEventListener("click", () => {
        const met = METODOS[Number(b.dataset.i)];
        const razon = noAplica(met, grado, true);
        if (razon) aviso(razon, true);
        else if (met.pide) hojaOpciones(met);
        else { cerrarHoja(); generarReporte(met.m, {}); }
      });
    }
  });
}

function hojaOpciones(met) {
  const ms = miembrosOrdenados();
  const punto = `<div id="h-punto"><label class="campo"><span>Tramo del punto</span></label>${chips("tramo", opcionesTramos(), ms[0].etiqueta)}
    ${campo("h-s", "Distancia desde el inicio del tramo (m)", numCampo(geo(ms[0]).L / 2))}</div>`;
  let html = "";
  if (met.pide === "punto") html = punto;
  else if (met.pide === "energia") html = `<label class="campo"><span>Qué calcular</span></label>${chips("tipo", [["deflexion", "Flecha"], ["rotacion", "Giro"]], "deflexion")}${punto}`;
  else if (met.pide === "alcance") html = `<label class="campo"><span>Qué desarrolla el reporte</span></label>` +
    chips("alcance", [["ambos", "El punto y los puntos clave"], ["todos", "Solo los puntos clave"], ["pedido", "Solo el punto"]], "ambos") + punto;
  else if (met.pide === "flecha") html = `<label class="interruptor">Calcular también la flecha en un punto<input type="checkbox" id="h-con-punto"></label>${punto}`;
  else if (met.pide === "mep") html = `<label class="campo"><span>Momentos de empotramiento</span></label>${chips("mep", [["integrales", "Por integrales"], ["tablas", "Por tablas"]], "integrales")}`;
  const usaPunto = () => (met.pide === "flecha" ? $("h-con-punto").checked
    : met.pide === "alcance" ? valorChip("alcance") !== "todos" : ["punto", "energia"].includes(met.pide));
  abrirHoja(met.m, html, [
    { texto: "Atrás", clase: "secundario", accion: () => { hojaPasoAPaso(); return false; } },
    { texto: "Generar", accion: () => {
      const op = {};
      if (usaPunto()) {
        const et = valorChip("tramo");
        op.miembro = et;
        op.s = leerNumero("h-s", { minimo: 0, maximo: geo(miembro(et)).L, nombre: "Distancia" });
      }
      if (met.pide === "energia") op.tipo = valorChip("tipo");
      if (met.pide === "alcance") op.alcance = valorChip("alcance");
      if (met.pide === "mep") op.mep = valorChip("mep");
      cerrarHoja();
      generarReporte(met.m, op);
    } },
  ], () => {
    const mostrarPunto = () => { if ($("h-punto")) $("h-punto").style.display = usaPunto() ? "" : "none"; };
    if ($("h-con-punto")) $("h-con-punto").addEventListener("change", mostrarPunto);
    alElegir = (grupo, valor) => {
      if (grupo === "alcance") mostrarPunto();
      if (grupo === "tramo") $("h-s").value = numCampo(geo(miembro(valor)).L / 2);
    };
    mostrarPunto();
  });
}

let reporteActual = 0;     // si se pide otro, el anterior ya no toca la pantalla

async function generarReporte(metodo, opciones) {
  const yo = ++reporteActual;
  const vigente = () => yo === reporteActual && !$("vista-reporte").hidden;
  $("reporte-titulo").textContent = metodo;
  $("reporte-html").innerHTML = "";
  $("reporte-progreso").hidden = false;
  $("reporte-barra").style.width = "3%";
  $("reporte-estado").textContent = Motor.listo ? "Preparando…" : "Esperando a que termine de cargar el motor…";
  $("vista-reporte").hidden = false;
  try {
    await Motor.esperar();
    if (Motor.fallo) throw new Error("El motor no cargó. Revisa la conexión a internet y vuelve a abrir la app.");
    const r = await Motor.pedir("reporte", { modelo, metodo, opciones }, (texto, f) => {
      if (!vigente()) return;
      $("reporte-barra").style.width = `${Math.max(3, Math.min(100, f * 100))}%`;
      $("reporte-estado").textContent = texto;
    });
    if (!vigente()) return;
    if (!r.ok) throw new Error(r.error);
    $("reporte-progreso").hidden = true;
    $("reporte-html").innerHTML = r.html + (licenciado ? `<p class="licencia">Axiomo · Licenciado a ${escapar(licenciado)}</p>` : "");
    $("reporte-html").scrollTop = 0;
    ajustarImpresion();
  } catch (err) {
    if (!vigente()) return;
    $("reporte-progreso").hidden = true;
    $("reporte-html").innerHTML = `<div class="sin-reporte"><h3>No se pudo aplicar el método</h3><p>${escapar(err.message || err)}</p></div>`;
  }
}
// Al imprimir o guardar en PDF, la hoja útil mide unos 700 px. Las matrices del
// Matricial vienen armadas para la hoja del escritorio (unos 1040 px) y van de a
// varias en una fila (matrices_en_fila): al imprimir, la fila se parte y cada
// matriz baja al renglón siguiente si no cabe, y la que sola sigue sin caber se
// reduce con zoom. En pantalla nada cambia: tamaño completo, desplazable de lado
const ANCHO_HOJA = 680;
function ajustarImpresion() {
  const reducir = (el, ancho) => {
    if (!(ancho > 0)) return;                    // la vista está cerrada: no se puede medir
    const z = ancho > ANCHO_HOJA ? ANCHO_HOJA / ancho : 1;
    el.classList.toggle("reducir-al-imprimir", z < 1);
    el.style.setProperty("--zoom-hoja", z.toFixed(3));
  };
  // una celda que es un solo número no se parte ("-7.30533e-" arriba y "06" abajo)
  for (const td of $("reporte-html").querySelectorAll("td")) {
    const t = td.textContent.trim();
    if (t && !/\s/.test(t) && !td.querySelector("table")) td.style.whiteSpace = "nowrap";
  }
  for (const t of $("reporte-html").querySelectorAll("table")) {
    if (t.parentElement.closest("table")) continue;                   // la de afuera decide
    const celdas = t.rows.length === 1 ? [...t.rows[0].cells] : [];
    if (celdas.length > 1 && celdas.some((c) => c.querySelector("table"))) {
      t.classList.add("fila-matrices");
      for (const c of celdas) reducir(c, c.getBoundingClientRect().width);
    } else if (/%$/.test(t.style.width) && t.scrollWidth <= t.clientWidth + 1) {
      reducir(t, 1);                             // ancho en %: se acomoda sola a la hoja
    } else {
      // el ancho del contenido: la tabla en sí ocupa todo el renglón (display: block)
      reducir(t, (t.tBodies[0] || t).getBoundingClientRect().width);
    }
  }
}
window.addEventListener("beforeprint", ajustarImpresion);
$("btn-cerrar-reporte").addEventListener("click", () => { $("vista-reporte").hidden = true; });
$("btn-imprimir").addEventListener("click", () => { ajustarImpresion(); window.print(); });

// ======================================================================= archivos
function guardarArchivo() {
  // la sección va en el formato .seccion.json del programa de escritorio
  const esSeccion = modelo.tipo === "Sección";
  const datos = esSeccion
    ? { programa: "Axiomo - Seccion", version: 1, unidad: modelo.unidad || "cm", nombre: modelo.nombre || "", figuras: modelo.figuras }
    : { programa: "Axiomo", version: 1, modelo };
  const blob = new Blob([JSON.stringify(datos, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const nombre = { "Viga": "viga", "Pórtico": "portico", "Armadura": "armadura", "Sección": "seccion" }[modelo.tipo] || "modelo";
  a.download = `${nombre}-${new Date().toISOString().slice(0, 10)}${esSeccion ? ".seccion.json" : ".pystruct"}`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

$("archivo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    let d;
    try { d = JSON.parse(await f.text()); } catch (_) { throw new Error("Ese archivo no es un modelo de Axiomo (.pystruct)."); }
    if (modelo.tipo !== "Viga" && otro().modoBarra) otro().salirModoBarra();
    if (Array.isArray(d.figuras)) {
      // una sección del escritorio (.seccion.json); V y M se conservan de la que había
      const vm = modelo.tipo === "Sección" ? modelo.vm : (cargarLocal("Sección") || {}).vm;
      guardarLocal();
      modelo = { tipo: "Sección", unidad: d.unidad || "cm", nombre: d.nombre || "", figuras: d.figuras, vm: vm || { modo: "nada" } };
    } else {
      const m = d.modelo || d;
      if (!TIPOS.includes(m.tipo) || m.tipo === "Sección") throw new Error("Ese archivo no es un modelo de Axiomo.");
      if (!Array.isArray(m.nodos) || m.nodos.length < (m.tipo === "Viga" ? 2 : 1)) throw new Error("El archivo no tiene una estructura completa.");
      modelo = normalizar(m);
    }
    leyes.clear();
    pintarHerramientas();
    cambio({ encuadrar: true });
    aviso(`Abierto: ${f.name}`);
  } catch (err) {
    aviso(String(err.message || err), true);
  }
});

// ======================================================================= menú y herramientas
$("btn-menu").addEventListener("click", () => ($("menu").hidden = false));
$("menu-fondo").addEventListener("click", () => ($("menu").hidden = true));
for (const b of document.querySelectorAll("[data-menu]")) {
  b.addEventListener("click", () => {
    $("menu").hidden = true;
    const accion = b.dataset.menu;
    if (accion === "nuevo" && modelo.tipo !== "Viga") otro().hojaNuevo();
    else if (accion === "nuevo") {
      abrirHoja("Nueva viga", `<p>Se borra la viga actual y se empieza con un tramo de 6 m apoyado en sus extremos.</p>`, [
        { texto: "Cancelar", clase: "secundario", accion: () => true },
        { texto: "Empezar de nuevo", clase: "peligro", accion: () => { vigaInicial(false); leyes.clear(); cambio({ encuadrar: true }); } },
      ]);
    } else if (accion === "abrir") $("archivo").click();
    else if (accion === "guardar") guardarArchivo();
    else if (accion === "material" && modelo.tipo === "Sección") aviso("En la sección, las medidas de cada figura se editan tocándola; V y M, en «V y M».");
    else if (accion === "material") hojaMaterial();
    else if (accion === "paso") hojaPasoAPaso();
    else if (accion === "acerca") {
      abrirHoja("Axiomo", `<p>Análisis estructural con el procedimiento completo, paso a paso.</p>
        <p class="nota">Versión para tablet y celular (${VERSION}). El cálculo se hace en este dispositivo con el mismo motor del programa de escritorio.</p>
        <p class="nota">${sinConexion ? "Guardada en este dispositivo: funciona sin internet." : "Necesita internet para cargar el motor."}</p>
        ${licenciado ? `<p><b>Licenciado a:</b> ${escapar(licenciado)}</p>` : ""}
        <p class="nota">axiomo937@gmail.com · WhatsApp +57 301 497 2754</p>`, [{ texto: "Cerrar", accion: () => true }]);
    }
  });
}

const HERRAMIENTAS_VIGA = [
  ["tramo", "Tramo", `<path d="M3 14h18M12 6v6M9 9h6"/>`],
  ["apoyo", "Apoyo", `<path d="M12 6l-6 9h12z"/><path d="M5 19h14"/>`],
  ["carga", "Carga", `<path d="M12 3v14M7 12l5 5 5-5"/><path d="M4 21h16"/>`],
  ["momento", "Momento", `<path d="M18 12a6 6 0 1 1-3-5.2"/><path d="M15 3l1 4-4 1"/>`],
];
const ICONO_CALCULAR = `<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M16 11v6"/>`;

function pintarHerramientas() {
  const lista = modelo.tipo === "Viga" ? HERRAMIENTAS_VIGA : otro().herramientas();
  $("herramientas").innerHTML = lista.map(([a, t, ico]) => `<button data-accion="${a}"><svg viewBox="0 0 24 24">${ico}</svg><span>${t}</span></button>`).join("") +
    `<button data-accion="calcular" class="principal" id="btn-calcular"><svg viewBox="0 0 24 24">${ICONO_CALCULAR}</svg><span>Calcular</span></button>`;
  $("tipo-texto").textContent = modelo.tipo;
}

$("herramientas").addEventListener("click", (e) => {
  const b = e.target.closest("[data-accion]");
  if (!b) return;
  const a = b.dataset.accion;
  if (a === "calcular") calcular();
  else if (modelo.tipo !== "Viga") otro().accion(a);
  else if (a === "tramo") hojaNuevoTramo();
  else if (a === "apoyo") hojaApoyo();
  else if (a === "carga") hojaCarga();
  else if (a === "momento") hojaMomento();
});

function cambiarTipo(tipo) {
  if (tipo === modelo.tipo) return;
  if (modelo.tipo !== "Viga" && otro().modoBarra) otro().salirModoBarra();
  guardarLocal();
  modelo = cargarLocal(tipo) || modeloInicial(tipo);
  leyes.clear();
  pintarHerramientas();
  cambio({ encuadrar: true });
}

$("btn-tipo").addEventListener("click", () => {
  const tipos = [["Viga", "Vigas continuas, con voladizos, rótulas y cargas con función."],
                 ["Pórtico", "Marcos con barras inclinadas, rótulas y cargas globales entre nodos."],
                 ["Armadura", "Barras articuladas con cargas en los nudos."],
                 ["Sección", "Sección transversal: centroide, inercia, Q y los esfuerzos τ y σ."]];
  abrirHoja("Tipo de estructura", `<div class="lista-metodos">${tipos.map(([t, d]) =>
    `<button class="metodo${t === modelo.tipo ? " elegido" : ""}" data-tipo-estructura="${t}"><b>${t}</b><small>${d}</small></button>`).join("")}</div>` +
    `<p class="nota">Cada tipo guarda su propio modelo en este dispositivo: al volver, sigue como lo dejaste.</p>`,
  [{ texto: "Cerrar", clase: "secundario", accion: () => true }], () => {
    for (const b of $("hoja-cuerpo").querySelectorAll("[data-tipo-estructura]")) {
      b.addEventListener("click", () => { cerrarHoja(); cambiarTipo(b.dataset.tipoEstructura); });
    }
  });
});
$("btn-ajustar").addEventListener("click", ajustarVista);
$("btn-paso-a-paso").addEventListener("click", hojaPasoAPaso);

// al girar la tablet o cambiar el ancho se vuelve a encuadrar; el teclado
// (que en Android solo cambia el alto) no mueve el dibujo
let redimensionar = null, anchoPrevio = window.innerWidth;
window.addEventListener("resize", () => {
  clearTimeout(redimensionar);
  redimensionar = setTimeout(() => {
    if (window.innerWidth !== anchoPrevio) { anchoPrevio = window.innerWidth; vista.auto = true; }
    dibujar();
    if (resultado) dibujarDiagramas();
  }, 120);
});

// ======================================================================= arranque
revisarActivacion();
const tipoGuardado = leerLocal("axiomo.tipo");
const tipoInicial = TIPOS.includes(tipoGuardado) ? tipoGuardado : "Viga";
modelo = cargarLocal(tipoInicial) || modeloInicial(tipoInicial);
pintarHerramientas();
dibujar();
prepararLeyes();
