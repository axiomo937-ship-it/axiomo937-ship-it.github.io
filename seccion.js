// seccion.js — Sección transversal en la app web: figuras (rectángulo, triángulo,
// círculo, semicírculo, y cualquiera como hueco), propiedades (ȳc, Īc, Q, t) y
// esfuerzos τ y σ con V y M escritos o tomados de la viga de la app, y el paso a
// paso del escritorio (core/seccion). El modelo es el archivo .seccion.json del
// escritorio más "tipo": "Sección" y "vm" (de dónde salen V y M).
// Se carga ANTES de app.js: aquí solo se definen funciones.
"use strict";

const SeccionWeb = (() => {
  const TIPOS_FIG = [["rectangulo", "Rectángulo"], ["triangulo", "Triángulo"], ["circulo", "Círculo"], ["semicirculo", "Semicírculo"]];
  const NOMBRE_TIPO = Object.fromEntries(TIPOS_FIG);
  const u = () => modelo.unidad || "cm";

  // ===================================================================== geometría (como core/seccion/figuras.py)
  function vertices(f) {
    const { x, y, b, h } = f;
    if (f.tipo === "rectangulo") return [[x, y], [x + b, y], [x + b, y + h], [x, y + h]];
    const xa = { izquierda: x, derecha: x + b, centro: x + b / 2 }[f.vertice] ?? x;
    return f.lado_horizontal === "arriba" ? [[x, y + h], [xa, y], [x + b, y + h]] : [[x, y], [x + b, y], [xa, y + h]];
  }
  function contorno(f, n = 48) {
    if (f.tipo === "rectangulo" || f.tipo === "triangulo") return vertices(f);
    if (f.tipo === "circulo") {
      const r = f.d / 2;
      return Array.from({ length: n }, (_, k) => [f.x + r * Math.cos((2 * Math.PI * k) / n), f.y + r * Math.sin((2 * Math.PI * k) / n)]);
    }
    const s = f.hacia === "abajo" ? -1 : 1;
    return Array.from({ length: n + 1 }, (_, k) => [f.x + f.r * Math.cos((Math.PI * k) / n), f.y + s * f.r * Math.sin((Math.PI * k) / n)]);
  }
  function caja(f) {
    const p = contorno(f);
    return [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
  }
  function centroide(f) {
    if (f.tipo === "rectangulo") return [f.x + f.b / 2, f.y + f.h / 2];
    if (f.tipo === "triangulo") { const v = vertices(f); return [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3]; }
    if (f.tipo === "circulo") return [f.x, f.y];
    return [f.x, f.y + (f.hacia === "abajo" ? -1 : 1) * (4 * f.r) / (3 * Math.PI)];
  }
  const nueva = (tipo, nombre, campos) => ({ tipo, nombre, hueco: false, x: 0, y: 0, b: 1, h: 1, d: 1, r: 1,
    lado_horizontal: "abajo", vertice: "izquierda", hacia: "arriba", ...campos });

  // ===================================================================== plantillas (las del escritorio)
  const PLANTILLAS = [["rectangular", "Rectangular"], ["I", "Sección en I"], ["T", "Sección en T"], ["cajon", "Cajón"],
                      ["tubo", "Tubo circular"], ["referencia", "Referencia (I con cartelas)"], ["blanco", "En blanco"]];
  function plantilla(cual) {
    const R = (nombre, x, y, b, h, extra = {}) => nueva("rectangulo", nombre, { x, y, b, h, ...extra });
    const T = (nombre, x, y, b, h, lado, vertice) => nueva("triangulo", nombre, { x, y, b, h, lado_horizontal: lado, vertice });
    switch (cual) {
      case "rectangular": return [R("Rectángulo", 0, 0, 30, 50)];
      case "I": return [R("Patín inferior", 0, 0, 30, 4), R("Alma", 14, 4, 2, 42), R("Patín superior", 0, 46, 30, 4)];
      case "T": return [R("Alma", 10, 0, 10, 40), R("Patín", 0, 40, 30, 8)];
      case "cajon": return [R("Exterior", 0, 0, 40, 60), R("Hueco", 5, 5, 30, 50, { hueco: true })];
      case "tubo": return [nueva("circulo", "Exterior", { x: 20, y: 20, d: 40 }), nueva("circulo", "Hueco", { x: 20, y: 20, d: 32, hueco: true })];
      case "referencia": return [
        R("Patín inferior", 0, 0, 40, 20), R("Alma", 10, 20, 20, 85),
        T("Cartela izquierda", -2, 90, 12, 15, "arriba", "derecha"), T("Cartela derecha", 30, 90, 12, 15, "arriba", "izquierda"),
        T("Talud izquierdo del patín", -35, 105, 33, 6, "arriba", "derecha"), T("Talud derecho del patín", 42, 105, 33, 6, "arriba", "izquierda"),
        R("Patín superior, izquierda", -35, 111, 33, 20), R("Patín superior, derecha", 42, 111, 33, 20),
        R("Patín superior, centro", -2, 105, 44, 26)];
      default: return [];
    }
  }

  function inicial() {
    modelo = { tipo: "Sección", unidad: "cm", nombre: "", figuras: plantilla("T"), vm: { modo: "escribir", V: 40, Mp: 60, Mn: 0 } };
    return modelo;
  }

  // ===================================================================== dibujo
  function layout() {
    const r = svg.getBoundingClientRect();
    const W = Math.max(280, r.width), H = Math.max(220, r.height);
    const cajas = modelo.figuras.map(caja);
    const xmin = cajas.length ? Math.min(...cajas.map((c) => c[0])) : 0, xmax = cajas.length ? Math.max(...cajas.map((c) => c[2])) : 30;
    const ymin = cajas.length ? Math.min(...cajas.map((c) => c[1])) : 0, ymax = cajas.length ? Math.max(...cajas.map((c) => c[3])) : 30;
    const m = 60;
    const esc = Math.min((W - 2 * m) / Math.max(xmax - xmin, 1e-6), (H - 2 * m) / Math.max(ymax - ymin, 1e-6));
    const ox = W / 2 - (esc * (xmin + xmax)) / 2, oy = H / 2 + (esc * (ymin + ymax)) / 2;
    return { W, H, esc, xmin, xmax, ymin, ymax, X: (x) => ox + esc * x, Y: (y) => oy - esc * y };
  }

  function dibujar() {
    const L = layout();
    const { W, H, X, Y, esc } = L;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    ocupados = [];
    segmentos = [];
    const pts = (f) => contorno(f).map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
    let llenas = "", huecos = "", numeros = "", toque = "";
    modelo.figuras.forEach((f, k) => {
      const forma = f.tipo === "circulo"
        ? (cls) => `<circle cx="${X(f.x)}" cy="${Y(f.y)}" r="${(esc * f.d) / 2}" class="${cls}"/>`
        : (cls) => `<polygon points="${pts(f)}" class="${cls}"/>`;
      if (f.hueco) huecos += forma("fig-hueco");
      else llenas += forma("fig-llena");
      toque += `<g data-tipo="figura" data-id="${k}">${forma("fig-toque")}</g>`;
      const [cx, cy] = centroide(f);
      numeros += `<g class="fig-numero"><circle cx="${X(cx)}" cy="${Y(cy)}" r="9"/><text x="${X(cx)}" y="${Y(cy) + 4}" text-anchor="middle">${k + 1}</text></g>`;
    });
    // cotas: ancho total abajo y alto total a la izquierda
    let cotas = "";
    if (modelo.figuras.length) {
      const yb = Y(L.ymin) + 26, xa = X(L.xmin) - 26;
      cotas += `<line x1="${X(L.xmin)}" y1="${yb}" x2="${X(L.xmax)}" y2="${yb}" class="cota"/>` +
        `<line x1="${X(L.xmin)}" y1="${yb - 5}" x2="${X(L.xmin)}" y2="${yb + 5}" class="cota"/><line x1="${X(L.xmax)}" y1="${yb - 5}" x2="${X(L.xmax)}" y2="${yb + 5}" class="cota"/>` +
        texto((X(L.xmin) + X(L.xmax)) / 2, yb + 16, `${fmt(L.xmax - L.xmin, 3)} ${u()}`, "etq-cota") +
        `<line x1="${xa}" y1="${Y(L.ymin)}" x2="${xa}" y2="${Y(L.ymax)}" class="cota"/>` +
        `<line x1="${xa - 5}" y1="${Y(L.ymin)}" x2="${xa + 5}" y2="${Y(L.ymin)}" class="cota"/><line x1="${xa - 5}" y1="${Y(L.ymax)}" x2="${xa + 5}" y2="${Y(L.ymax)}" class="cota"/>` +
        `<text x="${xa - 8}" y="${(Y(L.ymin) + Y(L.ymax)) / 2}" class="etq-cota" text-anchor="middle" transform="rotate(-90 ${xa - 8} ${(Y(L.ymin) + Y(L.ymax)) / 2})">${fmt(L.ymax - L.ymin, 3)} ${u()}</text>`;
    }
    // el eje neutro y el centroide, cuando ya se calculó
    let en = "";
    const r = resultado && resultado.tipo === "Sección" ? resultado : null;
    if (r) {
      const yc = Y(r.y_c + r.y_min), xc = X(r.x_c + r.x_min);
      en = `<line x1="${X(L.xmin) - 14}" y1="${yc}" x2="${X(L.xmax) + 14}" y2="${yc}" class="eje-neutro"/>` +
        `<circle cx="${xc}" cy="${yc}" r="4.5" class="centroide"/>` +
        texto(X(L.xmax) + 16, yc - 6, `E.N. · ȳc = ${fmt(r.y_c, 3)} ${u()}`, "etq-en", "end");
    }
    svg.innerHTML = `<g id="mundo" transform="translate(${vista.tx} ${vista.ty}) scale(${vista.k})">${llenas}${huecos}${cotas}${en}${numeros}${toque}</g>`;
    if (vista.auto) encuadrar();
    $("ayuda").textContent = modelo.figuras.length
      ? "Toca una figura para editarla. Las medidas van en cm, con y desde abajo hacia arriba."
      : "Agrega la primera figura con «Figura», o elige una forma en «Nuevo modelo».";
  }

  // ===================================================================== toques y herramientas
  function tocar(el) {
    if (el && el.dataset.tipo === "figura") hojaFigura(Number(el.dataset.id));
  }

  const herramientas = () => [
    ["figura", "Figura", `<rect x="4" y="5" width="10" height="8"/><path d="M14 19l6-10v10z"/>`],
    ["lista", "Figuras", `<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>`],
    ["fuerzas", "V y M", `<path d="M4 18c4-10 12-10 16 0"/><path d="M12 3v6M9 6l3 3 3-3"/>`],
  ];

  function accion(a) {
    if (a === "figura") hojaFigura(null);
    else if (a === "lista") hojaLista();
    else if (a === "fuerzas") hojaFuerzas();
  }

  function hojaLista() {
    if (!modelo.figuras.length) { hojaFigura(null); return; }
    const lista = modelo.figuras.map((f, k) => `<button class="metodo" data-k="${k}"><b>${k + 1}. ${escapar(f.nombre || NOMBRE_TIPO[f.tipo])}${f.hueco ? " · hueco" : ""}</b>` +
      `<small>${describir(f)}</small></button>`).join("");
    abrirHoja("Figuras de la sección", `<div class="lista-metodos">${lista}</div>`, [
      { texto: "Cerrar", clase: "secundario", accion: () => true },
      { texto: "+ Figura", accion: () => { hojaFigura(null); return false; } },
    ], () => {
      for (const b of $("hoja-cuerpo").querySelectorAll("[data-k]")) b.addEventListener("click", () => hojaFigura(Number(b.dataset.k)));
    });
  }

  function describir(f) {
    const n = (v) => fmt(v, 3), pos = `en (${n(f.x)}, ${n(f.y)})`;
    if (f.tipo === "rectangulo") return `${NOMBRE_TIPO[f.tipo]} ${n(f.b)} × ${n(f.h)} ${pos}`;
    if (f.tipo === "triangulo") return `Triángulo b = ${n(f.b)}, h = ${n(f.h)}, lado horizontal ${f.lado_horizontal}, vértice ${f.vertice} ${pos}`;
    if (f.tipo === "circulo") return `Círculo d = ${n(f.d)} ${pos}`;
    return `Semicírculo r = ${n(f.r)}, hacia ${f.hacia} ${pos}`;
  }

  const NOTAS = {
    rectangulo: "x, y: la esquina inferior izquierda.",
    triangulo: "x, y: la esquina inferior izquierda del rectángulo que lo encierra.",
    circulo: "x, y: el centro.",
    semicirculo: "x, y: el centro del diámetro (el lado recto).",
  };

  function hojaFigura(k) {
    const f = k === null ? nueva("rectangulo", "", siguientePosicion()) : modelo.figuras[k];
    const cm = u();
    const html = `<label class="campo"><span>Forma</span></label>${chips("tipo", TIPOS_FIG, f.tipo)}
      ${campo("h-nombre", "Nombre (opcional)", f.nombre, { modo: "text" })}
      <label class="interruptor">Es un hueco (resta área)<input type="checkbox" id="h-hueco"${f.hueco ? " checked" : ""}></label>
      <div class="fila">${campo("h-x", `x (${cm})`, numCampo(f.x))}${campo("h-y", `y (${cm})`, numCampo(f.y))}</div>
      <p class="nota" id="h-nota"></p>
      <div id="h-bh" class="fila">${campo("h-b", `Base b (${cm})`, numCampo(f.b))}${campo("h-h", `Altura h (${cm})`, numCampo(f.h))}</div>
      <div id="h-d">${campo("h-dd", `Diámetro d (${cm})`, numCampo(f.d))}</div>
      <div id="h-r">${campo("h-rr", `Radio r (${cm})`, numCampo(f.r))}</div>
      <div id="h-tri"><label class="campo"><span>Lado horizontal</span></label>${chips("lado", [["abajo", "Abajo (vértice arriba)"], ["arriba", "Arriba (vértice abajo)"]], f.lado_horizontal)}
        <label class="campo"><span>Vértice</span></label>${chips("vertice", [["izquierda", "A la izquierda"], ["derecha", "A la derecha"], ["centro", "Centrado"]], f.vertice)}</div>
      <div id="h-semi"><label class="campo"><span>Curva</span></label>${chips("hacia", [["arriba", "Hacia arriba"], ["abajo", "Hacia abajo"]], f.hacia)}</div>`;
    const botones = [
      { texto: "Cancelar", clase: "secundario", accion: () => true },
      { texto: k === null ? "Agregar" : "Guardar", accion: () => {
        const tipo = valorChip("tipo");
        const pos = (id, nombre) => leerNumero(id, { nombre });
        const med = (id, nombre) => { const v = leerNumero(id, { nombre }); if (!(v > 0)) throw new Error(`«${nombre}» debe ser mayor que cero.`); return v; };
        const g = { ...f, tipo, nombre: $("h-nombre").value.trim(), hueco: $("h-hueco").checked, x: pos("h-x", "x"), y: pos("h-y", "y") };
        if (tipo === "rectangulo" || tipo === "triangulo") { g.b = med("h-b", "Base b"); g.h = med("h-h", "Altura h"); }
        if (tipo === "circulo") g.d = med("h-dd", "Diámetro d");
        if (tipo === "semicirculo") g.r = med("h-rr", "Radio r");
        if (tipo === "triangulo") { g.lado_horizontal = valorChip("lado"); g.vertice = valorChip("vertice"); }
        if (tipo === "semicirculo") g.hacia = valorChip("hacia");
        if (k === null) modelo.figuras.push(g); else modelo.figuras[k] = g;
        cambio({ encuadrar: true });
      } },
    ];
    if (k !== null) botones.unshift({ texto: "Eliminar", clase: "peligro", accion: () => { modelo.figuras.splice(k, 1); cambio({ encuadrar: true }); } });
    abrirHoja(k === null ? "Nueva figura" : `Figura ${k + 1}`, html, botones, () => {
      const mostrar = (tipo) => {
        $("h-bh").style.display = tipo === "rectangulo" || tipo === "triangulo" ? "" : "none";
        $("h-d").style.display = tipo === "circulo" ? "" : "none";
        $("h-r").style.display = tipo === "semicirculo" ? "" : "none";
        $("h-tri").style.display = tipo === "triangulo" ? "" : "none";
        $("h-semi").style.display = tipo === "semicirculo" ? "" : "none";
        $("h-nota").textContent = NOTAS[tipo];
      };
      alElegir = (grupo, valor) => { if (grupo === "tipo") mostrar(valor); };
      mostrar(f.tipo);
    });
  }

  // una figura nueva arranca encima de lo que ya hay
  function siguientePosicion() {
    if (!modelo.figuras.length) return { x: 0, y: 0, b: 30, h: 10 };
    const c = modelo.figuras.map(caja);
    return { x: Math.min(...c.map((q) => q[0])), y: Math.max(...c.map((q) => q[3])), b: 10, h: 10 };
  }

  // ===================================================================== V y M
  function hojaFuerzas() {
    const vm = modelo.vm || { modo: "nada" };
    const html = `<p class="nota">Para los esfuerzos: τ = VQ/(It) con la cortante máxima, y σ = Mc/I con los momentos máximos positivo y negativo.</p>
      ${chips("modo", [["escribir", "Escribir V y M"], ["viga", "De la viga de la app"], ["nada", "Solo propiedades"]], vm.modo)}
      <div id="h-escribir">${campo("h-V", "V máx (kN)", numCampo(vm.V || 0))}
        <div class="fila">${campo("h-Mp", "M(+) máx (kN·m)", numCampo(vm.Mp || 0))}${campo("h-Mn", "M(−) máx (kN·m)", numCampo(Math.abs(vm.Mn || 0)))}</div>
        <p class="nota">Deja en 0 lo que no quieras calcular.</p></div>
      <div id="h-viga"><p class="nota" id="h-viga-texto">${vm.modo === "viga" && vm.origen ? escapar(vm.origen) : "Se resuelve la viga que tienes en «Viga» y se toman su cortante máxima y sus momentos máximos."}</p></div>`;
    abrirHoja("Fuerzas internas para los esfuerzos", html, [
      { texto: "Cancelar", clase: "secundario", accion: () => true },
      { texto: "Aplicar", accion: async () => {
        const modo = valorChip("modo");
        if (modo === "escribir") {
          const V = Math.abs(leerNumero("h-V", { nombre: "V máx" })), Mp = Math.abs(leerNumero("h-Mp", { nombre: "M(+) máx" }));
          const Mn = Math.abs(leerNumero("h-Mn", { nombre: "M(−) máx" }));
          modelo.vm = { modo, V, Mp, Mn, origen: "dados por el usuario" };
        } else if (modo === "viga") {
          modelo.vm = await desdeLaViga();
        } else modelo.vm = { modo: "nada" };
        cambio();
      } },
    ], () => {
      const mostrar = (modo) => {
        $("h-escribir").style.display = modo === "escribir" ? "" : "none";
        $("h-viga").style.display = modo === "viga" ? "" : "none";
      };
      alElegir = (grupo, valor) => { if (grupo === "modo") mostrar(valor); };
      mostrar(vm.modo);
    });
  }

  // la cortante máxima y los momentos máximos de la viga guardada en «Viga»
  async function desdeLaViga() {
    const viga = cargarLocal("Viga");
    if (!viga) throw new Error("No hay una viga guardada: arma una en «Viga» y vuelve.");
    await Motor.esperar();
    if (Motor.fallo) throw new Error("El motor no cargó.");
    $("hoja-error").hidden = false;
    $("hoja-error").textContent = "Resolviendo la viga…";
    const r = await Motor.pedir("calcular", { modelo: viga });
    if (!r.ok) throw new Error(`La viga no se pudo resolver: ${r.error}`);
    const valores = (nombre) => Object.values((r.diagramas || {})[nombre] || {}).flatMap((c) => c.map((p) => p[1]));
    const Vs = valores("Cortante (DFC)"), Ms = valores("Momento (DMF)");
    if (!Vs.length || !Ms.length) throw new Error("La viga no tiene diagramas: revisa sus apoyos y cargas.");
    const V = Math.max(...Vs.map(Math.abs)), Mp = Math.max(0, ...Ms), Mn = Math.abs(Math.min(0, ...Ms));
    return { modo: "viga", V, Mp, Mn,
      origen: `tomados del análisis de la viga de la app (V máx = ${fmt(V, 3)} kN, M(+) = ${fmt(Mp, 3)} kN·m, M(−) = ${fmt(Mn, 3)} kN·m)` };
  }

  // ===================================================================== resultados
  function mostrarResultados() {
    const r = resultado, c = u();
    $("res-metodo").textContent = "Propiedades de la sección";
    $("res-notas").textContent = r.V !== null || r.M_pos !== null || r.M_neg !== null ? `V y M ${r.origen}.` : "Sin V ni M: solo propiedades geométricas (cámbialo en «V y M»).";
    const filas = [
      ["Área A", `${fmt(r.A, 4)} ${c}²`],
      ["ȳc (desde la cara inferior)", `${fmt(r.y_c, 4)} ${c}`],
      ["c superior", `${fmt(r.c_sup, 4)} ${c}`],
      ...(r.simetrica ? [] : [["x̄c (desde el borde izquierdo)", `${fmt(r.x_c, 4)} ${c}`]]),
      ["Īc (eje neutro)", `${fmt(r.I_c, 4)} ${c}⁴`],
      ["", `${Number(r.I_c_m4).toPrecision(6)} m⁴`],
      ["Q en el eje neutro", `${fmt(r.Q, 4)} ${c}³`],
      ["t en el eje neutro", `${fmt(r.t, 4)} ${c}`],
    ];
    if (r.tau_max !== null) {
      filas.push(["τ en el eje neutro", `${fmt(r.tau_max, 2)} kN/m² = ${fmt(r.tau_max / 1000, 4)} MPa`]);
      if (r.tau_critico) filas.push([`τ máx (y = ${fmt(r.tau_critico.y, 3)} ${c})`, `${fmt(r.tau_critico.tau, 2)} kN/m² = ${fmt(r.tau_critico.tau / 1000, 4)} MPa`]);
    }
    const lado = { inf: "fibra inferior", sup: "fibra superior" }, letra = { T: "tracción", C: "compresión" };
    for (const [clave, nombre] of [["pos", "M(+)"], ["neg", "M(−)"]]) {
      const s = (r.sigmas || {})[clave];
      if (!s) continue;
      for (const l of ["inf", "sup"]) filas.push([`σ con ${nombre}, ${lado[l]}`, `${fmt(s[l][0], 2)} kN/m² (${letra[s[l][1]]})`]);
    }
    $("res-reacciones").innerHTML = `<tr><th>Propiedad</th><th class="num">Valor</th></tr>` +
      filas.map(([a, b]) => `<tr><td>${a}</td><td class="num">${b}</td></tr>`).join("");
    $("resultados").hidden = false;
    dibujarDiagramas();
  }

  // τ(y) y σ(y) junto a la sección, a la misma altura
  function dibujarDiagramas() {
    const caja_ = $("diagramas"), r = resultado;
    caja_._marco = null;
    const tau = r.tau_y || [], s = (r.sigmas || {}).pos || (r.sigmas || {}).neg;
    if (!tau.length && !s) { caja_.innerHTML = `<p class="nota">Con V y M aparecen aquí las distribuciones de τ y σ.</p>`; return; }
    const W = Math.max(300, caja_.clientWidth || 340), H = 300, m = 34, alto = H - 2 * m;
    const Y = (y) => H - m - (alto * y) / r.h;
    const col = (k, n) => [12 + ((W - 24) / n) * k, 12 + ((W - 24) / n) * (k + 1)];
    const paneles = [];
    if (tau.length) paneles.push("tau");
    if (s) paneles.push("sigma");
    let svgTxt = "";
    paneles.forEach((p, k) => {
      const [x0, x1] = col(k, paneles.length), x_eje = p === "tau" ? x0 + 16 : (x0 + x1) / 2, ancho = p === "tau" ? x1 - x0 - 78 : (x1 - x0) / 2 - 22;
      svgTxt += `<line x1="${x_eje}" y1="${Y(0)}" x2="${x_eje}" y2="${Y(r.h)}" class="diag-estructura"/>` +
        `<line x1="${x0 + 4}" y1="${Y(r.y_c)}" x2="${x1 - 4}" y2="${Y(r.y_c)}" class="eje-neutro"/>`;
      if (p === "tau") {
        const tmax = Math.max(1e-12, ...tau.map((q) => q[1]));
        const puntos = tau.map(([y, t]) => `${(x_eje + (ancho * t) / tmax).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
        svgTxt += `<polygon points="${x_eje},${Y(0)} ${puntos} ${x_eje},${Y(r.h)}" class="diag-marco" style="fill:#2563eb22;stroke:#2563eb"/>` +
          `<text x="${x0 + 4}" y="16" class="diag-titulo" fill="#2563eb">τ (kN/m²)</text>`;
        const [yM, tM] = tau.reduce((a, q) => (q[1] > a[1] ? q : a), [0, 0]);
        // el máximo, a la derecha de la punta (si no cabe, a la izquierda, por dentro)
        const xp = x_eje + (ancho * tM) / tmax, cabe = xp + 8 + fmt(tM, 1).length * 6.9 < x1;
        svgTxt += `<circle cx="${xp}" cy="${Y(yM)}" r="3" fill="#2563eb"/>` +
          `<text x="${cabe ? xp + 6 : xp - 6}" y="${Y(yM) + 4}" text-anchor="${cabe ? "start" : "end"}" class="diag-valor" fill="#2563eb">${fmt(tM, 1)}</text>`;
      } else {
        const smax = Math.max(1e-12, s.inf[0], s.sup[0]);
        const xs = x_eje + (ancho * s.sup[0]) / smax * (s.sup[1] === "T" ? 1 : -1), xi = x_eje + (ancho * s.inf[0]) / smax * (s.inf[1] === "T" ? 1 : -1);
        svgTxt += `<polygon points="${x_eje},${Y(r.h)} ${xs},${Y(r.h)} ${xi},${Y(0)} ${x_eje},${Y(0)}" class="diag-marco" style="fill:#dc262622;stroke:#dc2626"/>` +
          `<text x="${x0 + 4}" y="16" class="diag-titulo" fill="#dc2626">σ con ${(r.sigmas || {}).pos ? "M(+)" : "M(−)"} (kN/m²)</text>` +
          `<text x="${xs}" y="${Y(r.h) - 6}" text-anchor="middle" class="diag-valor" fill="#dc2626">${fmt(s.sup[0], 1)} ${s.sup[1]}</text>` +
          `<text x="${xi}" y="${Y(0) + 15}" text-anchor="middle" class="diag-valor" fill="#dc2626">${fmt(s.inf[0], 1)} ${s.inf[1]}</text>`;
      }
    });
    caja_.innerHTML = "";
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", `0 0 ${W} ${H}`);
    el.innerHTML = svgTxt;
    caja_.appendChild(el);
  }

  function leer() { /* los diagramas de la sección no tienen lectura al tocar */ }

  // ===================================================================== paso a paso y nuevo
  function hojaPasoAPaso() {
    if (!modelo.figuras.length) { aviso("Agrega al menos una figura.", true); return; }
    const vm = modelo.vm || { modo: "nada" };
    const dice = vm.modo === "nada" ? "solo las propiedades geométricas (sin V ni M)"
      : `las propiedades y los esfuerzos con V = ${fmt(vm.V || 0, 3)} kN, M(+) = ${fmt(vm.Mp || 0, 3)} kN·m y M(−) = ${fmt(vm.Mn || 0, 3)} kN·m`;
    abrirHoja("Paso a paso de la sección", `<p>Centroide por figuras, inercia con Steiner, Q por los dos lados, ${dice}, como en las notas de referencia.</p>
      <p class="nota">Cambia V y M en la herramienta «V y M».</p>`, [
      { texto: "Cerrar", clase: "secundario", accion: () => true },
      { texto: "Generar", accion: () => { cerrarHoja(); generarReporte("Sección Transversal", {}); } },
    ]);
  }

  function hojaNuevo() {
    abrirHoja("Nueva sección", `<p class="nota">Se reemplaza la sección actual (guárdala antes si la quieres conservar).</p>
      <label class="campo"><span>Forma de arranque</span></label>${chips("forma", PLANTILLAS, "I")}`, [
      { texto: "Cancelar", clase: "secundario", accion: () => true },
      { texto: "Crear", accion: () => { modelo.figuras = plantilla(valorChip("forma")); cambio({ encuadrar: true }); } },
    ]);
  }

  return { dibujar, tocar, accion, herramientas, mostrarResultados, dibujarDiagramas, leer, hojaPasoAPaso, hojaNuevo,
           inicial, salirModoBarra() {}, modoBarra: null };
})();
