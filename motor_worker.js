// motor_worker.js — Python y el motor de Axiomo en segundo plano.
// La página nunca se congela: todo el cálculo pasa aquí. Es un worker de
// MÓDULO: Pyodide 314 no corre en workers clásicos («Classic web workers
// are not supported»), así que la página lo crea con {type: "module"} y
// aquí se importa pyodide.mjs.
//
// El motor viaja CIFRADO (axiomo_core.bin, AES-256-GCM). Python y sus
// paquetes, que son públicos, se cargan de una vez; el motor espera la
// llave, que la página manda como CryptoKey no exportable cuando el
// dispositivo está activado. Mensajes:
//   → {tipo: "iniciar", dpr}                         ← {tipo: "estado", etapa, seg}
//   → {tipo: "llave", llave: CryptoKey}               ← {tipo: "listo"} o {tipo: "fallo", error}
//   → {id, tipo: "calcular", modelo, metodo}          ← {id, ok, datos}
//   → {id, tipo: "ley", texto, largo}                 ← {id, ok, datos}
//   → {id, tipo: "muestras", coeficientes, expresion, largo}
//   → {id, tipo: "reporte", modelo, metodo, opciones} ← {id, tipo: "progreso", texto, f} … {id, ok, datos}

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const CABECERA = [65, 88, 77, 49];                          // «AXM1»
const AAD = new TextEncoder().encode("axiomo-core");

let web = null;
let listo = null;
let darLlave = null;
const llave = new Promise((r) => (darLlave = r));

function avisar(mensaje) { self.postMessage(mensaje); }

async function abrirMotor(blob, k) {
  const b = new Uint8Array(blob);
  if (!CABECERA.every((v, i) => b[i] === v)) throw new Error("El motor descargado está dañado.");
  try {
    return await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(4, 16), additionalData: AAD }, k, b.slice(16));
  } catch (_) {
    throw new Error("La activación de este dispositivo no abre el motor. Vuelve a activarlo con tu usuario y contraseña.");
  }
}

async function cargar(dpr) {
  const t = performance.now();
  const paso = async (etapa, fn) => {
    avisar({ tipo: "estado", etapa });
    const t0 = performance.now();
    const r = await fn();
    avisar({ tipo: "estado", etapa, hecho: true, seg: (performance.now() - t0) / 1000 });
    return r;
  };
  const py = await paso("python", async () => {
    const { loadPyodide } = await import(PYODIDE_URL + "pyodide.mjs");
    return loadPyodide({ indexURL: PYODIDE_URL });
  });
  await paso("paquetes", () => py.loadPackage(["numpy", "sympy", "matplotlib"]));
  // el motor se descarga mientras tanto, pero se abre solo con la llave
  const descarga = fetch("axiomo_core.bin").then((r) => {
    if (!r.ok) throw new Error(`No se pudo descargar el motor (${r.status}).`);
    return r.arrayBuffer();
  });
  descarga.catch(() => { /* el error se muestra al usarla, ya con la llave */ });
  avisar({ tipo: "estado", etapa: "llave" });
  const k = await llave;
  await paso("motor", async () => {
    const zip = await abrirMotor(await descarga, k);
    py.unpackArchive(zip, "zip", { extractDir: "/home/pyodide/axiomo" });
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide/axiomo')");
    web = py.pyimport("axiomo_web");
    web.preparar(dpr || 1);
  });
  avisar({ tipo: "listo", seg: (performance.now() - t) / 1000 });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.tipo === "iniciar") {
    listo = cargar(m.dpr).catch((err) => avisar({ tipo: "fallo", error: String(err && err.message || err) }));
    return;
  }
  if (m.tipo === "llave") { darLlave(m.llave); return; }
  await listo;
  if (!web) return avisar({ id: m.id, ok: false, error: "El motor no cargó." });
  const t0 = performance.now();
  try {
    let texto;
    if (m.tipo === "calcular") texto = web.calcular(JSON.stringify(m.modelo), m.metodo || "");
    else if (m.tipo === "ley") texto = web.ley_de_funcion(m.texto, m.largo);
    else if (m.tipo === "muestras") texto = web.muestras_ley(JSON.stringify(m.coeficientes || []), m.expresion || "", m.largo);
    else if (m.tipo === "reporte") {
      const progreso = (texto, f) => avisar({ id: m.id, tipo: "progreso", texto, f });
      texto = web.reporte(JSON.stringify(m.modelo), m.metodo, JSON.stringify(m.opciones || {}), progreso);
    } else throw new Error(`Mensaje desconocido: ${m.tipo}`);
    avisar({ id: m.id, ok: true, datos: JSON.parse(texto), seg: (performance.now() - t0) / 1000 });
  } catch (err) {
    avisar({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
