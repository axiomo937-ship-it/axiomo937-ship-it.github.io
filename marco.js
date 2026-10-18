// marco.js — pórticos y armaduras en la app web: editor 2D táctil, dibujo,
// resultados con los diagramas sobre la estructura y el paso a paso.
// Usa lo común de app.js (modelo, hojas, rótulos, motor) y el mismo formato
// de modelo del escritorio. Se carga ANTES de app.js: aquí solo se definen
// funciones, que leen lo de app.js cuando se llaman.
"use strict";

const Marco = (() => {
  const esArmadura = () => modelo.tipo === "Armadura";
  const esPortico = () => modelo.tipo === "Pórtico";
  let modoBarra = null;          // {desde: etiqueta|null} mientras se crean barras tocando nodos
  let diagramaActivo = "Momento (DMF)";

  // ===================================================================== geometría
  const barrasDe = (et) => modelo.miembros.filter((m) => m.i === et || m.j === et);
  function largo(m) { const a = nodo(m.i), b = nodo(m.j); return Math.hypot(b.x - a.x, b.y - a.y); }
  function unitario(m) {
    const a = nodo(m.i), b = nodo(m.j), L = largo(m) || 1;
    return [(b.x - a.x) / L, (b.y - a.y) / L];
  }
  // + de una carga perpendicular del modelo: la normal que apunta a +y (en una barra vertical, a +x)
  function normalPositiva(m) {
    const [ux, uy] = unitario(m);
    let nx = -uy, ny = ux;
    if (ny < -1e-9 || (Math.abs(ny) <= 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
    return [nx, ny];
  }
  function puntoEn(m, s) { const a = nodo(m.i), [ux, uy] = unitario(m); return [a.x + ux * s, a.y + uy * s]; }
  const flechaDe = ([x, y]) => "→↗↑↖←↙↓↘"[Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360 / 45) % 8];

  // el camino de barras entre dos nodos (el de una carga global): lista de [barra, desde, hasta]
  function camino(desde, hasta) {
    const previo = new Map([[desde, null]]);
    const cola = [desde];
    while (cola.length) {
      const n = cola.shift();
      if (n === hasta) break;
      for (const m of barrasDe(n)) {
        const otro = m.i === n ? m.j : m.i;
        if (!previo.has(otro)) { previo.set(otro, [m, n]); cola.push(otro); }
      }
    }
    if (!previo.has(hasta)) return null;
    const tramos = [];
    for (let n = hasta; previo.get(n); n = previo.get(n)[1]) {
      const [m, antes] = previo.get(n);
      tramos.unshift([m, antes, n]);
    }
    return tramos;
  }

  // incógnitas de reacción menos ecuaciones: 3 por nodo (2 en armaduras) y una por cada barra
  // de más que llega a una rótula
  function grado() {
    const r = modelo.apoyos.reduce((s, a) => s + ({ Empotrado: 3, Articulado: 2 }[a.tipo] || 1), 0);
    const n = modelo.nodos.length, m = modelo.miembros.length;
    if (esArmadura()) return m + r - 2 * n;
    const c = modelo.nodos.reduce((s, nd) => s + (nd.rotula ? Math.max(0, barrasDe(nd.etiqueta).length - 1) : 0), 0);
    return 3 * m + r - 3 * n - c;
  }

  // ===================================================================== edición del modelo
  function agregarNodo(x, y) {
    const et = siguienteLetra();
    modelo.nodos.push({ etiqueta: et, x: redondear(x), y: redondear(y), rotula: false, k_rotula: 0 });
    return et;
  }

  function agregarBarra(i, j) {
    if (i === j) throw new Error("Una barra une dos nodos distintos.");
    if (modelo.miembros.some((m) => (m.i === i && m.j === j) || (m.i === j && m.j === i))) {
      throw new Error(`Ya hay una barra entre ${i} y ${j}.`);
    }
    const a = nodo(i), b = nodo(j);
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) throw new Error("Esos dos nodos están en el mismo punto.");
    const p = propiedadesActuales();
    const et = siguienteMiembro();
    modelo.miembros.push({ etiqueta: et, i, j, tipo: esArmadura() ? "Armadura" : "Viga/Pórtico", E: p.E, I: p.I, A: p.A });
    return et;
  }

  function eliminarBarra(et) {
    modelo.miembros = modelo.miembros.filter((m) => m.etiqueta !== et);
    for (const k of ["cargas_puntuales", "cargas_distribuidas", "cargas_polinomicas", "temperaturas"]) {
      modelo[k] = modelo[k].filter((c) => c.miembro !== et);
    }
    modelo.momentos = modelo.momentos.filter((c) => c.miembro !== et);
    modelo.cargas_globales = modelo.cargas_globales.filter((c) => camino(c.nodo_i, c.nodo_f));
  }

  function eliminarNodo(et) {
    for (const m of barrasDe(et)) eliminarBarra(m.etiqueta);
    modelo.nodos = modelo.nodos.filter((n) => n.etiqueta !== et);
    modelo.apoyos = modelo.apoyos.filter((a) => a.nodo !== et);
    modelo.cargas_nodales = modelo.cargas_nodales.filter((c) => c.nodo !== et);
    modelo.momentos = modelo.momentos.filter((c) => c.nodo !== et);
    modelo.asentamientos = modelo.asentamientos.filter((c) => c.nodo !== et);
    modelo.cargas_globales = modelo.cargas_globales.filter((c) => c.nodo_i !== et && c.nodo_f !== et);
  }

  // al mover un nodo las barras cambian de largo: las cargas que quedan fuera se recortan
  function recortarCargas() {
    let n = 0;
    for (const m of modelo.miembros) {
      const L = largo(m);
      for (const c of modelo.cargas_puntuales.filter((c) => c.miembro === m.etiqueta)) if (c.s > L) { c.s = redondear(L); n++; }
      for (const c of modelo.momentos.filter((c) => c.miembro === m.etiqueta)) if (c.s > L) { c.s = redondear(L); n++; }
      for (const k of ["cargas_distribuidas", "cargas_polinomicas"]) {
        modelo[k] = modelo[k].filter((c) => {
          if (c.miembro !== m.etiqueta) return true;
          if (c.x1 >= L - 1e-9) { n++; return false; }
          if (c.x2 > L + 1e-9) { c.x2 = redondear(L); n++; leyes.delete(c.id); }
          return true;
        });
      }
    }
    return n;
  }

  function ponerApoyoMarco(et, valor) {
    modelo.apoyos = modelo.apoyos.filter((a) => a.nodo !== et);
    if (!valor || valor === "Ninguno") return;
    const [tipo, ang] = valor.split(":");
    modelo.apoyos.push({ nodo: et, tipo, angulo: ang ? Number(ang) : 90.0, k: 0.0, etiqueta: et, sentido_k: 1.0 });
  }

  const valorApoyo = (a) => (!a ? "Ninguno" : a.tipo === "Rodillo" ? `Rodillo:${Math.abs(Math.sin((a.angulo * Math.PI) / 180)) > 0.5 ? 90 : 0}` : a.tipo);

  // ===================================================================== plantillas
  const PLANTILLAS = {
    "Pórtico": [["simple", "Pórtico simple"], ["aguas", "A dos aguas"], ["pisos", "Dos pisos"], ["blanco", "En blanco"]],
    "Armadura": [["pratt", "Pratt"], ["howe", "Howe"], ["warren", "Warren"], ["blanco", "En blanco"]],
  };

  function crearPlantilla(tipo, cual, L, H, extra) {
    modelo = modeloVacio();
    modelo.tipo = tipo;
    const N = (x, y) => agregarNodo(x, y);
    const B = (i, j) => agregarBarra(i, j);
    if (tipo === "Pórtico") {
      if (cual === "simple") {
        const a = N(0, 0), b = N(0, H), c = N(L, H), d = N(L, 0);
        B(a, b); B(b, c); B(d, c);
        ponerApoyoMarco(a, "Articulado"); ponerApoyoMarco(d, "Rodillo:90");
      } else if (cual === "aguas") {
        const a = N(0, 0), b = N(0, H), c = N(L / 2, H + extra), d = N(L, H), e = N(L, 0);
        B(a, b); B(b, c); B(c, d); B(e, d);
        nodo(c).rotula = true;                                   // tres articulaciones: isostático
        ponerApoyoMarco(a, "Articulado"); ponerApoyoMarco(e, "Articulado");
      } else if (cual === "pisos") {
        const a = N(0, 0), b = N(0, H), c = N(0, 2 * H), d = N(L, 2 * H), e = N(L, H), f = N(L, 0);
        B(a, b); B(b, c); B(c, d); B(f, e); B(e, d); B(b, e);
        ponerApoyoMarco(a, "Empotrado"); ponerApoyoMarco(f, "Empotrado");
      } else {
        N(0, 0);
      }
    } else {
      const n = Math.max(2, Math.round(extra));
      if (cual === "blanco") {
        N(0, 0);
      } else {
        const abajo = [], arriba = [];
        for (let k = 0; k <= n; k++) abajo.push(N((L * k) / n, 0));
        if (cual === "warren") {
          for (let k = 0; k < n; k++) arriba.push(N((L * (k + 0.5)) / n, H));
          for (let k = 0; k < n; k++) B(abajo[k], abajo[k + 1]);
          for (let k = 0; k < n - 1; k++) B(arriba[k], arriba[k + 1]);
          for (let k = 0; k < n; k++) { B(abajo[k], arriba[k]); B(arriba[k], abajo[k + 1]); }
        } else {
          for (let k = 1; k < n; k++) arriba[k] = N((L * k) / n, H);
          for (let k = 0; k < n; k++) B(abajo[k], abajo[k + 1]);
          for (let k = 1; k < n - 1; k++) B(arriba[k], arriba[k + 1]);
          B(abajo[0], arriba[1]); B(arriba[n - 1], abajo[n]);                       // diagonales de los extremos
          for (let k = 1; k < n; k++) B(abajo[k], arriba[k]);                        // montantes
          for (let k = 1; k < n - 1; k++) {
            const izqMitad = k < n / 2;
            // Pratt: las diagonales bajan hacia el centro; Howe: suben hacia el centro
            if ((cual === "pratt") === izqMitad) B(arriba[k], abajo[k + 1]); else B(abajo[k], arriba[k + 1]);
          }
        }
        ponerApoyoMarco(abajo[0], "Articulado"); ponerApoyoMarco(abajo[n], "Rodillo:90");
      }
    }
    return modelo;
  }

  // el ejemplo que se ve la primera vez
  function inicial(tipo) {
    if (tipo === "Pórtico") {
      crearPlantilla("Pórtico", "simple", 6, 4);
      modelo.cargas_distribuidas.push({ id: nuevoId(), miembro: "M2", x1: 0, x2: 6, w1: -12, w2: -12, direccion: "local" });
      modelo.cargas_nodales.push({ id: nuevoId(), nodo: "B", fx: 10, fy: 0 });
    } else {
      crearPlantilla("Armadura", "pratt", 12, 3, 4);
      for (const et of ["B", "C", "D"]) modelo.cargas_nodales.push({ id: nuevoId(), nodo: et, fx: 0, fy: -10 });
    }
    return modelo;
  }

  // ===================================================================== dibujo
  function layout() {
    const r = svg.getBoundingClientRect();
    const W = Math.max(280, r.width), H = Math.max(220, r.height);
    const xs = modelo.nodos.map((n) => n.x), ys = modelo.nodos.map((n) => n.y);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const m = 70;
    const ex = xmax - xmin > 1e-6 ? (W - 2 * m) / (xmax - xmin) : Infinity;
    const ey = ymax - ymin > 1e-6 ? (H - 2 * m) / (ymax - ymin) : Infinity;
    let esc = Math.min(ex, ey);
    if (!isFinite(esc)) esc = 40;
    const ox = W / 2 - (esc * (xmin + xmax)) / 2, oy = H / 2 + (esc * (ymin + ymax)) / 2;
    return { W, H, esc, X: (x) => ox + esc * x, Y: (y) => oy - esc * y, margen: m };
  }

  // de qué lado del nodo va el apoyo: opuesto a sus barras (en pantalla, y hacia abajo)
  function ladoLibre(et) {
    let sx = 0, sy = 0;
    for (const m of barrasDe(et)) {
      const otro = nodo(m.i === et ? m.j : m.i), n = nodo(et);
      const L = Math.hypot(otro.x - n.x, otro.y - n.y) || 1;
      sx += (otro.x - n.x) / L; sy += (otro.y - n.y) / L;
    }
    return [-sx, -sy];
  }

  // cuánto se gira el dibujo del apoyo «de pie» (base abajo) para que quede del lado libre
  function giroApoyo(a) {
    const [lx, ly] = ladoLibre(a.nodo);
    if (a.tipo === "Rodillo" && Math.abs(Math.cos((a.angulo * Math.PI) / 180)) > 0.5) return lx >= 0 ? -90 : 90;
    if (a.tipo === "Empotrado") return Math.round(((Math.atan2(-ly, lx) * 180) / Math.PI - 90) / 90) * 90;
    return ly > 0.5 ? 180 : 0;                  // colgado de arriba: el apoyo encima
  }

  // la caja que ocupa el apoyo en pantalla (el dibujo de pie mide 40 × 40 bajo el nodo)
  function cajaApoyo(a, X, Y) {
    const r = (giroApoyo(a) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const pts = [[-20, 0], [20, 0], [-20, 40], [20, 40]].map(([x, y]) => [X + x * c - y * s, Y + x * s + y * c]);
    return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  }

  function apoyoMarco(a, X, Y) {
    const rot = giroApoyo(a);
    let g = "";
    if (a.tipo === "Empotrado") {
      g = `<rect x="-22" y="3" width="44" height="7" class="apoyo"/>`;
      for (let k = 0; k < 6; k++) g += `<line x1="${-20 + k * 8}" y1="10" x2="${-26 + k * 8}" y2="17" class="suelo"/>`;
    } else if (a.tipo === "Resorte") {
      let d = "M0 4 L0 9";
      for (let k = 0; k < 5; k++) d += ` L${k % 2 ? -7 : 7} ${12 + k * 4.5}`;
      g = `<path d="${d} L0 33 L0 37" class="resorte"/>` + suelo(0, 37);
    } else {
      const alto = a.tipo === "Rodillo" ? 15 : 19;
      g = `<polygon points="0,3 -12,${3 + alto} 12,${3 + alto}" class="apoyo"/>`;
      let base = 3 + alto;
      if (a.tipo === "Rodillo") { g += `<circle cx="-6" cy="${base + 4}" r="3.5" class="apoyo"/><circle cx="6" cy="${base + 4}" r="3.5" class="apoyo"/>`; base += 8; }
      g += suelo(0, base);
    }
    return `<g transform="translate(${X} ${Y}) rotate(${rot})">${g}</g>`;
  }

  // flechas de una fuerza (componentes globales) que llega a un punto
  function fuerzaEn(X, Y, fx, fy, id, largoF = 46) {
    let s = `<g data-tipo="carga" data-id="${id}">`;
    const comp = [];
    if (Math.abs(fy) > 1e-12) comp.push([0, fy]);
    if (Math.abs(fx) > 1e-12) comp.push([fx, 0]);
    for (const [cx, cy] of comp) {
      const mag = Math.abs(cx || cy);
      const dx = Math.sign(cx), dy = -Math.sign(cy);            // dirección en pantalla
      // llega al nudo desde afuera… salvo que así cruce una barra: entonces sale del nudo
      const cerca = (px, py) => segmentos.some(([x1, y1, x2, y2]) => {
        const lx = x2 - x1, ly = y2 - y1, l2 = lx * lx + ly * ly || 1;
        const u = Math.max(0, Math.min(1, ((px - x1) * lx + (py - y1) * ly) / l2));
        return Math.hypot(x1 + u * lx - px, y1 + u * ly - py) < 7;
      });
      const llega = ![0.25, 0.5, 0.75, 1].some((f) => cerca(X - dx * (12 + f * largoF), Y - dy * (12 + f * largoF)));
      let x0, y0, x1, y1;                                        // cola y punta
      if (llega) { x0 = X - dx * (largoF + 5); y0 = Y - dy * (largoF + 5); x1 = X - dx * 5; y1 = Y - dy * 5; }
      else { x0 = X + dx * 6; y0 = Y + dy * 6; x1 = X + dx * (largoF + 6); y1 = Y + dy * (largoF + 6); }
      s += flecha(x0, y0, x1, y1, "carga", "fr");
      const [ex, ey] = llega ? [x0, y0] : [x1, y1];             // el rótulo, en el extremo libre
      const cand = cx ? [[ex - dx * (llega ? 4 : -4), ey + 4, (dx > 0) === llega ? "end" : "start"], [ex, ey - 8, "middle"], [ex, ey + 18, "middle"]]
                      : [[ex, ey + ((dy > 0) === llega ? -6 : 16), "middle"], [ex + 8, ey, "start"], [ex - 8, ey, "end"]];
      s += rotulo(cand, `${fmt(mag)} kN`, "etq-carga").svg;
      ocupados.push([Math.min(x0, x1) - 4, Math.min(y0, y1) - 4, Math.max(x0, x1) + 4, Math.max(y0, y1) + 4]);
      s += `<rect x="${Math.min(x0, x1) - 14}" y="${Math.min(y0, y1) - 14}" width="${Math.abs(x1 - x0) + 28}" height="${Math.abs(y1 - y0) + 28}" class="toque-area"/>`;
    }
    return s + `</g>`;
  }

  // una carga repartida a lo largo de una barra, entre sa y sb. `dir(s)` da la dirección de
  // empuje (vector unitario global) y `q(s)` la intensidad con signo (+ = hacia dir)
  // `base`: cuánto se aparta de la barra (otra repartida ya ocupa la franja de al lado)
  function repartidaEn(m, sa, sb, q, dir, clase, marca, h, base = 0) {
    const L = largo(m), n = Math.max(2, Math.round(((sb - sa) * lay.esc) / 22)), muestras = Math.max(n, 12);
    const [dx, dy] = dir;
    const punto = (s, v, a) => {
      // en pantalla, del lado de donde vienen las flechas (la figura va detrás de ellas)
      const [px, py] = puntoEn(m, Math.min(s, L)), sgn = v >= 0 ? 1 : -1;
      return [lay.X(px) - dx * sgn * a, lay.Y(py) + dy * sgn * a];
    };
    const pol = [], fondo = [];
    let extremo = null, mayor = -1;
    for (let k = 0; k <= muestras; k++) {
      const s = sa + ((sb - sa) * k) / muestras, v = q(s), alto = h(v);
      pol.push(punto(s, v, base + alto));
      fondo.push(punto(s, v, base));
      if (alto > mayor) { mayor = alto; extremo = { p: punto(s, v, base + alto + 12), sgn: v >= 0 ? 1 : -1 }; }
    }
    let flechas = "";
    for (let k = 0; k <= n; k++) {
      const s = sa + ((sb - sa) * k) / n, v = q(s);
      if (Math.abs(v) < 1e-9) continue;
      const [x0, y0] = punto(s, v, base + h(v)), [x1, y1] = punto(s, v, base + 2);
      flechas += flecha(x0, y0, x1, y1, clase, marca);
    }
    const todos = [...pol, ...fondo.reverse()];
    const puntos = todos.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ");
    const xs = todos.map((p) => p[0]), ys = todos.map((p) => p[1]);
    const caja = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    // hacia dónde se aleja el rótulo del punto más intenso (en pantalla)
    const ex = -dx * extremo.sgn, ey = dy * extremo.sgn;
    return { svg: `<polygon points="${puntos}" class="${clase === "carga" ? "carga-relleno" : "carga-ley"}"/>${flechas}`, caja, extremo: [...extremo.p, ex, ey] };
  }

  // las posiciones para el rótulo de una repartida: más allá de su punto más intenso
  function candidatosRepartida(r) {
    const [px, py, ex, ey] = r.extremo, [x1, y1, x2] = r.caja;
    const lado = Math.abs(ex) > 0.6 ? [[px, py + 4, ex > 0 ? "start" : "end"]] : [[px, ey < 0 ? py : py + 10, "middle"]];
    return [...lado, [(x1 + x2) / 2, y1 - 6, "middle"], [x2 + 6, y1 + 12, "start"], [x1 - 6, y1 + 12, "end"]];
  }

  function dibujar() {
    lay = layout();
    const { W, H, X, Y } = lay;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    ocupados = [];
    segmentos = [];
    let capaBarras = "", capaCargas = "", capaPuntuales = "", capaNodos = "", capaRes = "", capaToque = "";
    const defs = `<defs>
      <marker id="fr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#dc2626"/></marker>
      <marker id="fm" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="#7c3aed"/></marker>
      <marker id="fv" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#15803d"/></marker>
    </defs>`;
    const arm = esArmadura();

    // ---- barras
    for (const m of modelo.miembros) {
      const a = nodo(m.i), b = nodo(m.j);
      if (!a || !b) continue;
      capaBarras += `<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" class="${arm ? "barra-arm" : "viga"}"/>`;
      capaToque += `<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" class="toque" data-tipo="miembro" data-id="${m.etiqueta}"/>`;
      segmentos.push([X(a.x), Y(a.y), X(b.x), Y(b.y)]);
    }
    for (const a of modelo.apoyos) if (nodo(a.nodo)) ocupados.push(cajaApoyo(a, X(nodo(a.nodo).x), Y(nodo(a.nodo).y)));
    for (const c of modelo.momentos) {                       // el arco de cada momento
      const p = c.nodo && nodo(c.nodo) ? [nodo(c.nodo).x, nodo(c.nodo).y] : miembro(c.miembro) ? puntoEn(miembro(c.miembro), c.s) : null;
      if (p) ocupados.push([X(p[0]) - 18, Y(p[1]) - 18, X(p[0]) + 18, Y(p[1]) + 18]);
    }
    const nivel = {};                     // cuántas repartidas lleva ya cada barra
    const tomarNivel = (ets) => { const k = Math.max(0, ...ets.map((e) => nivel[e] || 0)); for (const e of ets) nivel[e] = k + 1; return k; };

    // ---- repartidas, con ley y globales: intensidad común
    let wmax = 1e-9;
    for (const c of modelo.cargas_distribuidas) wmax = Math.max(wmax, Math.abs(c.w1), Math.abs(c.w2));
    for (const c of modelo.cargas_globales) wmax = Math.max(wmax, Math.abs(c.w1), Math.abs(c.w2));
    for (const c of modelo.cargas_polinomicas) for (const [, q] of leyes.get(c.id) || []) wmax = Math.max(wmax, Math.abs(q));
    const hMax = Math.min(38, Math.max(24, H * 0.1));
    const h = (v) => (Math.abs(v) < 1e-12 ? 0 : Math.max(6, (Math.abs(v) / wmax) * hMax));
    const etiquetas = [];                 // los rótulos de las repartidas se ponen después de las flechas puntuales

    for (const c of modelo.cargas_distribuidas) {
      const m = miembro(c.miembro);
      if (!m) continue;
      const largoC = Math.max(c.x2 - c.x1, 1e-9);
      const dirLocal = normalPositiva(m);
      const dir = c.direccion === "global_y" ? [0, 1] : c.direccion === "global_x" ? [1, 0] : dirLocal;
      const q = (s) => c.w1 + ((c.w2 - c.w1) * (s - c.x1)) / largoC;
      const r = repartidaEn(m, c.x1, c.x2, q, dir, "carga", "fr", h, tomarNivel([m.etiqueta]) * (hMax + 16));
      ocupados.push(r.caja);
      const texto = Math.abs(c.w1 - c.w2) < 1e-9 ? `${fmt(Math.abs(c.w1))} kN/m` : `${fmt(Math.abs(c.w1))} a ${fmt(Math.abs(c.w2))} kN/m`;
      etiquetas.push({ id: c.id, fig: r.svg, caja: r.caja, texto, clase: "etq-carga", cand: candidatosRepartida(r) });
    }
    for (const c of modelo.cargas_polinomicas) {
      const m = miembro(c.miembro);
      if (!m) continue;
      const muestras = leyes.get(c.id) || [[0, 0], [c.x2 - c.x1, 0]];
      const largoC = Math.max(c.x2 - c.x1, 1e-9);
      const rel = muestras.map(([Xl, qq]) => [Xl / largoC, qq]);
      const q = (s) => interpolar(rel, (s - c.x1) / largoC);
      const r = repartidaEn(m, c.x1, c.x2, q, normalPositiva(m), "carga-ley-flecha", "fm", h, tomarNivel([m.etiqueta]) * (hMax + 16));
      ocupados.push(r.caja);
      etiquetas.push({ id: c.id, fig: r.svg, caja: r.caja, texto: `Q(X) = ${c.funcion_texto || "ley del escritorio"}`, clase: "etq-ley",
                       cand: candidatosRepartida(r) });
    }
    for (const c of modelo.cargas_globales) {
      const tramos = camino(c.nodo_i, c.nodo_f);
      if (!tramos) continue;
      const eje = c.direccion === "Y" ? "x" : "y";           // la intensidad se mide por la proyección perpendicular
      const total = tramos.reduce((s, [, a, b]) => s + Math.abs(nodo(b)[eje] - nodo(a)[eje]), 0) || 1;
      let acumulado = 0, figs = "", cajas = [], mejor = null;
      const base = tomarNivel(tramos.map(([m]) => m.etiqueta)) * (hMax + 16);
      for (const [m, a, b] of tramos) {
        const proy = Math.abs(nodo(b)[eje] - nodo(a)[eje]);
        const ini = acumulado;
        acumulado += proy;
        if (proy < 1e-9) continue;
        const L = largo(m), sentido = m.i === a ? 1 : -1;
        const q = (s) => { const t = sentido > 0 ? s / L : 1 - s / L; return c.w1 + ((c.w2 - c.w1) * (ini + t * proy)) / total; };
        const r = repartidaEn(m, 0, L, q, c.direccion === "Y" ? [0, 1] : [1, 0], "carga", "fr", h, base);
        figs += r.svg;
        cajas.push(r.caja);
        ocupados.push(r.caja);
        const intensidad = Math.max(Math.abs(q(0)), Math.abs(q(L)));
        if (!mejor || intensidad > mejor[0]) mejor = [intensidad, r];
      }
      if (!cajas.length) continue;
      const caja = [Math.min(...cajas.map((k) => k[0])), Math.min(...cajas.map((k) => k[1])), Math.max(...cajas.map((k) => k[2])), Math.max(...cajas.map((k) => k[3]))];
      const flechaT = c.direccion === "Y" ? (c.w1 + c.w2 <= 0 ? "↓" : "↑") : (c.w1 + c.w2 >= 0 ? "→" : "←");
      const texto = Math.abs(c.w1 - c.w2) < 1e-9 ? `${flechaT} ${fmt(Math.abs(c.w1))} kN/m` : `${flechaT} ${fmt(Math.abs(c.w1))} a ${fmt(Math.abs(c.w2))} kN/m`;
      etiquetas.push({ id: c.id, fig: figs, caja, texto, clase: "etq-carga", cand: candidatosRepartida(mejor[1]) });
    }

    // ---- puntuales en nodos y en barras (componentes globales)
    for (const c of modelo.cargas_nodales) {
      const n = nodo(c.nodo);
      if (n) capaPuntuales += fuerzaEn(X(n.x), Y(n.y), c.fx, c.fy, c.id);
    }
    for (const c of modelo.cargas_puntuales) {
      const m = miembro(c.miembro);
      if (!m) continue;
      const [px, py] = puntoEn(m, c.s);
      capaPuntuales += fuerzaEn(X(px), Y(py), c.fx, c.fy, c.id);
    }

    // ---- rótulos de las repartidas, ya con las flechas puestas
    for (const e of etiquetas) {
      const [x1, y1, x2] = e.caja;
      const r = rotulo(e.cand, e.texto, e.clase);
      capaCargas += `<g data-tipo="carga" data-id="${e.id}">${e.fig}${r.svg}` +
        `<rect x="${x1}" y="${y1 - 4}" width="${Math.max(8, x2 - x1)}" height="${Math.max(8, e.caja[3] - y1 + 4)}" class="toque-area"/></g>`;
    }

    // ---- momentos y temperaturas
    for (const c of modelo.momentos) {
      let p = null;
      if (c.nodo && nodo(c.nodo)) p = [nodo(c.nodo).x, nodo(c.nodo).y];
      else if (miembro(c.miembro)) p = puntoEn(miembro(c.miembro), c.s);
      if (p) capaPuntuales += dibujarMomentoEn(X(p[0]), Y(p[1]), c.M, c.id);
    }
    for (const c of modelo.temperaturas) {
      const m = miembro(c.miembro);
      if (!m) continue;
      const [px, py] = puntoEn(m, largo(m) / 2);
      capaPuntuales += `<g data-tipo="miembro" data-id="${m.etiqueta}">` +
        rotulo([[X(px), Y(py) - 10, "middle"], [X(px), Y(py) + 20, "middle"]], `ΔT ${fmt(c.dT, 1)} °C`, "etq-temp").svg + `</g>`;
    }

    // ---- apoyos, nodos, rótulas y nombres
    for (const n of modelo.nodos) {
      const a = apoyoDe(n.etiqueta);
      const xx = X(n.x), yy = Y(n.y);
      if (a) capaNodos += apoyoMarco(a, xx, yy);
      const resaltado = modoBarra && modoBarra.desde === n.etiqueta;
      capaNodos += n.rotula ? `<circle cx="${xx}" cy="${yy}" r="6" class="rotula"/>`
        : arm ? `<circle cx="${xx}" cy="${yy}" r="5" class="nodo-arm"/>` : `<circle cx="${xx}" cy="${yy}" r="4" class="nodo"/>`;
      if (resaltado) capaNodos += `<circle cx="${xx}" cy="${yy}" r="14" class="seleccion-nodo"/>`;
      const [lx, ly] = ladoLibre(n.etiqueta);
      const nl = Math.hypot(lx, ly) || 1;
      // el nombre va del lado libre del nodo (lejos de sus barras); con apoyo, a un costado
      const libre = barrasDe(n.etiqueta).length ? [xx + (lx / nl) * 17, yy - (ly / nl) * 17 + 5, "middle"] : [xx + 12, yy - 10, "start"];
      const der = [[xx + 16, yy - 8, "start"], [xx + 16, yy + 16, "start"]], izq = [[xx - 16, yy - 8, "end"], [xx - 16, yy + 16, "end"]];
      const costados = lx < 0 ? [...izq, ...der] : [...der, ...izq];
      capaNodos += rotulo(a ? costados : [libre, ...costados], n.etiqueta, "etq-nodo", 13).svg;
      capaToque += `<circle cx="${xx}" cy="${yy}" r="20" class="toque-area" data-tipo="nodo" data-id="${n.etiqueta}"/>`;
    }

    // ---- reacciones del último cálculo
    if (resultado) {
      for (const [et, r] of Object.entries(resultado.reacciones || {})) {
        const a = modelo.apoyos.find((x) => x.etiqueta === et) || apoyoDe(et);
        if (!a || !nodo(a.nodo)) continue;
        const xx = X(nodo(a.nodo).x), yy = Y(nodo(a.nodo).y);
        const [lx, ly] = ladoLibre(a.nodo);
        const abajo = ly <= 0.5;                       // el apoyo está debajo del nodo
        if (r.Ry !== null && r.Ry !== undefined && Math.abs(r.Ry) > 1e-9) {
          const y1 = abajo ? yy + 76 : yy - 76, y2 = abajo ? yy + 42 : yy - 42;
          capaRes += r.Ry > 0 ? flecha(xx, Math.max(y1, y2), xx, Math.min(y1, y2), "reaccion", "fv") : flecha(xx, Math.min(y1, y2), xx, Math.max(y1, y2), "reaccion", "fv");
          capaRes += rotulo([[xx, Math.max(y1, y2) + 15, "middle"], [xx + 8, Math.max(y1, y2), "start"]], `${fmt(Math.abs(r.Ry))} kN`, "etq-reaccion").svg;
        }
        if (r.Rx !== null && r.Rx !== undefined && Math.abs(r.Rx) > 1e-9) {
          const izq = lx <= 0;
          const x1 = izq ? xx - 78 : xx + 78, x2 = izq ? xx - 34 : xx + 34, yb = yy + (abajo ? 20 : -20);
          capaRes += r.Rx > 0 ? flecha(Math.min(x1, x2), yb, Math.max(x1, x2), yb, "reaccion", "fv") : flecha(Math.max(x1, x2), yb, Math.min(x1, x2), yb, "reaccion", "fv");
          ocupados.push([Math.min(x1, x2) - 2, yb - 5, Math.max(x1, x2) + 2, yb + 5]);
          capaRes += rotulo([[(x1 + x2) / 2, yb - 8, "middle"], [(x1 + x2) / 2, yb + 18, "middle"],
                             [izq ? Math.min(x1, x2) - 4 : Math.max(x1, x2) + 4, yb + 4, izq ? "end" : "start"]],
            `${fmt(Math.abs(r.Rx))} kN`, "etq-reaccion").svg;
        }
        if (r.M !== null && r.M !== undefined && Math.abs(r.M) > 1e-9) {
          capaRes += dibujarMomentoReaccion(xx, yy, r.M, lx >= 0 ? 1 : -1);
        }
      }
    }

    svg.innerHTML = `${defs}<g id="mundo" transform="translate(${vista.tx} ${vista.ty}) scale(${vista.k})">` +
      `${capaBarras}${capaCargas}${capaPuntuales}${capaNodos}${capaRes}${capaToque}</g>`;
    if (vista.auto) encuadrar();
    const ayuda = $("ayuda");
    if (modoBarra) ayuda.textContent = modoBarra.desde ? `Barra desde ${modoBarra.desde}: toca el otro nodo. Toca «Barra» abajo para terminar.`
      : "Toca el nodo donde empieza la barra.";
    else ayuda.textContent = "Toca un nodo, una barra o una carga para editarlo. Pellizca para acercar.";
  }

  // ===================================================================== toques y herramientas
  function tocar(el) {
    if (modoBarra) {
      if (el && el.dataset.tipo === "nodo") {
        const et = el.dataset.id;
        if (!modoBarra.desde) { modoBarra.desde = et; dibujar(); return; }
        try {
          agregarBarra(modoBarra.desde, et);
          modoBarra.desde = et;                                 // se encadena desde el último
          cambio();
        } catch (err) { aviso(err.message, true); }
        return;
      }
      if (!el) { salirModoBarra(); return; }
    }
    if (!el) return;
    const tipo = el.dataset.tipo, id = el.dataset.id;
    if (tipo === "nodo") hojaNodo(id);
    else if (tipo === "miembro") hojaBarra(id);
    else if (tipo === "carga") hojaCarga({ id: Number(id) });
  }

  function salirModoBarra() {
    modoBarra = null;
    document.querySelector('#herramientas [data-accion="barra"]')?.classList.remove("activa");
    dibujar();
  }

  const herramientas = () => [
    ["nodo", "Nodo", `<circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>`],
    ["barra", "Barra", `<circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="6" r="2.5"/><path d="M7 16.5 17 7.5"/>`],
    ["apoyo", "Apoyo", `<path d="M12 6l-6 9h12z"/><path d="M5 19h14"/>`],
    ["carga", "Carga", `<path d="M12 3v14M7 12l5 5 5-5"/><path d="M4 21h16"/>`],
  ];

  function accion(a) {
    if (a !== "barra" && modoBarra) salirModoBarra();
    if (a === "nodo") hojaNodo(null);
    else if (a === "barra") {
      if (modoBarra) { salirModoBarra(); return; }
      if (modelo.nodos.length < 2) { aviso("Primero agrega al menos dos nodos con «Nodo».", true); return; }
      modoBarra = { desde: null };
      document.querySelector('#herramientas [data-accion="barra"]')?.classList.add("activa");
      dibujar();
      aviso("Toca dos nodos para unirlos con una barra. Sigue tocando para encadenar más.");
    } else if (a === "apoyo") hojaApoyo();
    else if (a === "carga") hojaCarga({});
  }

  // ===================================================================== hojas
  const opcionesNodos = () => modelo.nodos.map((n) => [n.etiqueta, n.etiqueta]);
  const opcionesBarras = () => modelo.miembros.map((m) => [m.etiqueta, `${m.etiqueta} · ${m.i}–${m.j}`]);

  function opcionesApoyo() {
    const o = [["Ninguno", "Ninguno"], ["Articulado", "Articulado"], ["Rodillo:90", "Rodillo ↕"], ["Rodillo:0", "Rodillo ↔"]];
    if (!esArmadura()) o.push(["Empotrado", "Empotrado"]);
    return o;
  }

  function hojaNodo(et, enfocarApoyo = false) {
    const n = et ? nodo(et) : null;
    const ultimo = modelo.nodos.length ? modelo.nodos[modelo.nodos.length - 1] : null;
    const a = n ? apoyoDe(et) : null;
    let html = `<div class="fila">${campo("h-x", "x (m)", n ? numCampo(n.x) : numCampo(ultimo ? ultimo.x + 3 : 0))}` +
      `${campo("h-y", "y (m)", n ? numCampo(n.y) : numCampo(ultimo ? ultimo.y : 0))}</div>`;
    if (!n && modelo.nodos.length) {
      html += `<label class="campo"><span>Unirlo con una barra al nodo</span></label>${chips("unir", [["", "No"], ...opcionesNodos()], ultimo.etiqueta)}`;
    }
    html += `<label class="campo"><span>Apoyo</span></label>${chips("apoyo", opcionesApoyo(), valorApoyo(a))}`;
    if (a && a.tipo === "Resorte") html += `<p class="nota">Este nodo tiene un resorte (k = ${fmt(a.k, 2)} kN/m) hecho en el escritorio: se conserva si no eliges otro apoyo.</p>`;
    if (esPortico() && n) {
      html += `<label class="interruptor">Rótula en ${et} (las barras giran libres)<input type="checkbox" id="h-rot" ${n.rotula ? "checked" : ""}></label>`;
    }
    if (n) html += `<div class="chips"><button type="button" class="chip" id="h-fuerza-aqui">+ Fuerza en ${et}</button>` +
      `${esArmadura() ? "" : `<button type="button" class="chip" id="h-barra-desde">+ Barra desde ${et}</button>`}</div>`;
    const botones = [
      { texto: "Cancelar", clase: "secundario", accion: () => true },
      { texto: n ? "Guardar" : "Agregar", accion: () => {
        const x = leerNumero("h-x", { nombre: "x" }), y = leerNumero("h-y", { nombre: "y" });
        const otro = modelo.nodos.find((o) => o !== n && Math.hypot(o.x - x, o.y - y) < 1e-6);
        if (otro) throw new Error(`Ya está el nodo ${otro.etiqueta} en ese punto.`);
        let etiqueta = et, recortadas = 0;
        if (n) {
          const movido = Math.hypot(n.x - x, n.y - y) > 1e-9;
          n.x = redondear(x); n.y = redondear(y);
          if (movido) recortadas = recortarCargas();
          if ($("h-rot")) n.rotula = $("h-rot").checked;
        } else {
          etiqueta = agregarNodo(x, y);
          const unir = valorChip("unir");
          if (unir) agregarBarra(unir, etiqueta);
        }
        const ap = valorChip("apoyo"), actual = apoyoDe(etiqueta);
        if (ap && ap !== valorApoyo(actual)) ponerApoyoMarco(etiqueta, ap);
        cambio({ encuadrar: true });
        if (recortadas) aviso(`${recortadas} carga${recortadas > 1 ? "s se ajustaron" : " se ajustó"} al nuevo largo de las barras.`);
      } },
    ];
    if (n) botones.unshift({ texto: "Eliminar", clase: "peligro", accion: () => {
      eliminarNodo(et);
      cambio({ encuadrar: true });
    } });
    abrirHoja(n ? `Nodo ${et}` : "Nuevo nodo", html, botones, () => {
      if ($("h-fuerza-aqui")) $("h-fuerza-aqui").addEventListener("click", () => hojaCarga({ tipo: "nodal", nodoIni: et }));
      if ($("h-barra-desde")) $("h-barra-desde").addEventListener("click", () => {
        cerrarHoja();
        modoBarra = { desde: et };
        document.querySelector('#herramientas [data-accion="barra"]')?.classList.add("activa");
        dibujar();
      });
      if (enfocarApoyo) $("hoja").querySelector(".hoja-panel").scrollTop = 9999;
    });
  }

  function hojaApoyo() {
    const libre = modelo.nodos.find((n) => !apoyoDe(n.etiqueta)) || modelo.nodos[0];
    const html = `<label class="campo"><span>Nodo</span></label>${chips("nodo", opcionesNodos(), libre.etiqueta)}` +
      `<label class="campo"><span>Apoyo</span></label>${chips("apoyo", opcionesApoyo(), valorApoyo(apoyoDe(libre.etiqueta)))}` +
      `<div id="h-rotula"></div>`;
    abrirHoja("Apoyos" + (esPortico() ? " y rótulas" : ""), html, [
      { texto: "Cerrar", clase: "secundario", accion: () => true },
      { texto: "Aplicar", accion: () => {
        const et = valorChip("nodo"), ap = valorChip("apoyo");
        if (ap && ap !== valorApoyo(apoyoDe(et))) ponerApoyoMarco(et, ap);
        if ($("h-rot")) nodo(et).rotula = $("h-rot").checked;
        cambio();
      } },
    ], () => {
      const refrescar = () => {
        const et = valorChip("nodo"), a = apoyoDe(et), val = valorApoyo(a);
        for (const c of $("hoja-cuerpo").querySelectorAll('.chip[data-grupo="apoyo"]')) c.classList.toggle("activo", c.dataset.valor === val);
        $("h-rotula").innerHTML = (a && a.tipo === "Resorte" ? `<p class="nota">Este nodo tiene un resorte (k = ${fmt(a.k, 2)} kN/m) hecho en el escritorio.</p>` : "") +
          (esPortico() ? `<label class="interruptor">Rótula en ${et} (las barras giran libres)<input type="checkbox" id="h-rot" ${nodo(et).rotula ? "checked" : ""}></label>` : "");
      };
      alElegir = (grupo) => { if (grupo === "nodo") refrescar(); };
      refrescar();
    });
  }

  function hojaBarra(et) {
    const m = miembro(et);
    const L = largo(m), [ux, uy] = unitario(m);
    const ang = ((Math.atan2(uy, ux) * 180) / Math.PI + 360) % 360;
    const t = modelo.temperaturas.find((c) => c.miembro === et);
    let html = `<p class="nota">De ${m.i} a ${m.j} · largo ${fmtL(L)} · ángulo ${fmt(ang, 1)}°</p>`;
    if (esArmadura()) {
      html += `<div class="fila">${campo("h-dT", "Cambio de temperatura ΔT (°C)", t ? numCampo(t.dT) : "0")}` +
        `${campo("h-alfa", "Coeficiente α (1/°C)", t ? String(t.alpha) : "0.0000117", { modo: "text" })}</div>` +
        `<p class="nota">La temperatura entra en Trabajo Virtual y Castigliano. Deja ΔT en 0 si no hay.</p>`;
    } else {
      html += `<div class="chips"><button type="button" class="chip" id="h-carga-aqui">+ Carga en ${et}</button>` +
        `<button type="button" class="chip" id="h-momento-aqui">+ Momento en ${et}</button></div>`;
    }
    const botones = [
      { texto: "Eliminar", clase: "peligro", accion: () => { eliminarBarra(et); cambio({ encuadrar: true }); } },
      { texto: "Cerrar", clase: "secundario", accion: () => true },
    ];
    if (esArmadura()) botones.push({ texto: "Guardar", accion: () => {
      const dT = leerNumero("h-dT", { nombre: "ΔT" });
      const alfa = leerNumero("h-alfa", { minimo: 0, nombre: "α" });
      modelo.temperaturas = modelo.temperaturas.filter((c) => c.miembro !== et);
      if (Math.abs(dT) > 1e-12) modelo.temperaturas.push({ id: nuevoId(), miembro: et, alpha: alfa, dT });
      cambio();
    } });
    abrirHoja(`Barra ${et}`, html, botones, () => {
      if ($("h-carga-aqui")) $("h-carga-aqui").addEventListener("click", () => hojaCarga({ tipo: "repartida", barra: et }));
      if ($("h-momento-aqui")) $("h-momento-aqui").addEventListener("click", () => hojaCarga({ tipo: "momento", barra: et }));
    });
  }

  // tipos de carga de cada estructura
  const TIPOS_CARGA = () => esArmadura() || !modelo.miembros.length ? [["nodal", "En un nodo"]]
    : [["nodal", "En un nodo"], ["puntual", "Puntual en barra"], ["repartida", "Repartida"], ["global", "Global entre nodos"],
       ["funcion", "Función Q(X)"], ["momento", "Momento"]];

  function hojaCarga({ id = null, tipo = null, barra = null, nodoIni = null } = {}) {
    const [lista, c] = id !== null ? buscarCarga(id) : [null, null];
    const desdeLista = { cargas_nodales: "nodal", cargas_puntuales: "puntual", cargas_distribuidas: "repartida",
                         cargas_globales: "global", cargas_polinomicas: "funcion", momentos: "momento" };
    let tipoIni = c ? desdeLista[lista] : (tipo || (esArmadura() || !modelo.miembros.length ? "nodal" : "repartida"));
    const primeraBarra = modelo.miembros[0] ? modelo.miembros[0].etiqueta : null;
    // lo que se va escribiendo se conserva al cambiar de tipo o de barra
    const v = {
      nodo: nodoIni || (c && c.nodo) || (modelo.nodos.find((n) => !apoyoDe(n.etiqueta)) || modelo.nodos[0]).etiqueta,
      barra: barra || (c && c.miembro) || primeraBarra, fx: 0, fy: -10, s: 0, a: 0, b: null, w1: 10, w2: 10,
      sentido: "neg", dir: "local", M: 10, msentido: "anti", ley: "2.5X^2 - 15X",
      gi: modelo.nodos[0].etiqueta, gf: modelo.nodos[modelo.nodos.length - 1].etiqueta, gdir: "Y",
    };
    if (c && (lista === "cargas_nodales" || lista === "cargas_puntuales")) { v.fx = c.fx; v.fy = c.fy; v.s = c.s || 0; }
    if (c && lista === "cargas_distribuidas") {
      v.a = c.x1; v.b = c.x2; v.dir = c.direccion || "local";
      v.sentido = (Math.abs(c.w1) >= Math.abs(c.w2) ? c.w1 : c.w2) > 0 ? "pos" : "neg";
      const sg = v.sentido === "pos" ? 1 : -1;
      v.w1 = c.w1 * sg; v.w2 = c.w2 * sg;
    }
    if (c && lista === "cargas_globales") {
      v.gi = c.nodo_i; v.gf = c.nodo_f; v.gdir = c.direccion;
      v.sentido = (Math.abs(c.w1) >= Math.abs(c.w2) ? c.w1 : c.w2) > 0 ? "pos" : "neg";
      const sg = v.sentido === "pos" ? 1 : -1;
      v.w1 = c.w1 * sg; v.w2 = c.w2 * sg;
    }
    if (c && lista === "cargas_polinomicas") { v.a = c.x1; v.b = c.x2; v.ley = c.funcion_texto || c.expresion || textoPolinomio(c.coeficientes); }
    if (c && lista === "momentos") {
      v.M = Math.abs(c.M); v.msentido = c.M >= 0 ? "anti" : "horario";
      if (c.nodo && nodo(c.nodo)) {
        const bs = barrasDe(c.nodo);
        if (bs.length) { v.barra = bs[0].etiqueta; v.s = bs[0].i === c.nodo ? 0 : largo(bs[0]); }
      } else v.s = c.s;
    }
    const leyInicial = v.ley;
    const html = `<label class="campo"><span>Tipo de carga</span></label>${chips("tipo", TIPOS_CARGA(), tipoIni)}<div id="h-campos"></div>`;
    const botones = [
      { texto: "Cancelar", clase: "secundario", accion: () => true },
      { texto: c ? "Guardar" : "Agregar", accion: () => aplicarCarga(c ? id : null, lista === "cargas_polinomicas" ? c : null, leyInicial) },
    ];
    if (c) botones.unshift({ texto: "Eliminar", clase: "peligro", accion: () => { quitarCarga(id); cambio(); } });

    abrirHoja(c ? "Editar carga" : "Agregar carga", html, botones, () => {
      const recordar = () => {
        const n = (k) => { const el = $(k); if (!el) return null; const x = parseFloat(el.value.replace(",", ".")); return isFinite(x) ? x : null; };
        v.fx = n("h-fx") ?? v.fx; v.fy = n("h-fy") ?? v.fy; v.s = n("h-s") ?? v.s; v.a = n("h-a") ?? v.a; v.b = n("h-b") ?? v.b;
        v.w1 = n("h-w1") ?? v.w1; v.w2 = n("h-w2") ?? v.w2; v.M = n("h-M") ?? v.M;
        if ($("h-ley")) v.ley = $("h-ley").value;
        for (const g of ["nodo", "barra", "sentido", "dir", "msentido", "gi", "gf", "gdir"]) v[g] = valorChip(g) || v[g];
      };
      const sentidos = () => {
        // las flechas de los dos sentidos, según la dirección elegida y la barra
        if (tipoIni === "global") return v.gdir === "Y" ? [["neg", "↓ Hacia abajo"], ["pos", "↑ Hacia arriba"]] : [["pos", "→ Derecha"], ["neg", "← Izquierda"]];
        if (v.dir === "global_y") return [["neg", "↓ Hacia abajo"], ["pos", "↑ Hacia arriba"]];
        if (v.dir === "global_x") return [["pos", "→ Derecha"], ["neg", "← Izquierda"]];
        const np = normalPositiva(miembro(v.barra));
        const palabra = { "↑": "arriba", "↓": "abajo", "→": "la derecha", "←": "la izquierda", "↗": "arriba a la derecha",
                          "↖": "arriba a la izquierda", "↘": "abajo a la derecha", "↙": "abajo a la izquierda" };
        const f1 = flechaDe([-np[0], -np[1]]), f2 = flechaDe(np);
        return [["neg", `${f1} Hacia ${palabra[f1]}`], ["pos", `${f2} Hacia ${palabra[f2]}`]];
      };
      const pintar = () => {
        const t = valorChip("tipo") || tipoIni;
        tipoIni = t;
        let h = "";
        const L = v.barra ? largo(miembro(v.barra)) : 0;
        const barraChips = `<label class="campo"><span>Barra</span></label>${chips("barra", opcionesBarras(), v.barra)}`;
        if (t === "nodal") {
          h = `<label class="campo"><span>Nodo</span></label>${chips("nodo", opcionesNodos(), v.nodo)}` +
            `<div class="fila">${campo("h-fx", "Fx (kN) → +", numCampo(v.fx))}${campo("h-fy", "Fy (kN) ↑ +", numCampo(v.fy))}</div>` +
            `<p class="nota">Hacia abajo, Fy negativa; hacia la izquierda, Fx negativa.</p>`;
        } else if (t === "puntual") {
          h = barraChips + campo("h-s", `Distancia desde ${miembro(v.barra).i} (0 a ${fmt(L, 3)} m)`, numCampo(Math.min(v.s, L))) +
            `<div class="fila">${campo("h-fx", "Fx (kN) → +", numCampo(v.fx))}${campo("h-fy", "Fy (kN) ↑ +", numCampo(v.fy))}</div>`;
        } else if (t === "repartida") {
          const b = v.b === null ? L : Math.min(v.b, L);
          h = barraChips + `<label class="campo"><span>Dirección</span></label>` +
            chips("dir", [["local", "Perpendicular a la barra"], ["global_y", "Vertical"], ["global_x", "Horizontal"]], v.dir) +
            `<div class="fila">${campo("h-a", `Desde (m, desde ${miembro(v.barra).i})`, numCampo(Math.min(v.a, L)))}${campo("h-b", "Hasta (m)", numCampo(b))}</div>` +
            `<div class="fila">${campo("h-w1", "Al inicio (kN/m)", numCampo(v.w1))}${campo("h-w2", "Al final (kN/m)", numCampo(v.w2))}</div>` +
            chips("sentido", sentidos(), v.sentido) +
            `<p class="nota">Vertical y horizontal se miden por metro de proyección (como la nieve y el viento).</p>`;
        } else if (t === "global") {
          h = `<label class="campo"><span>Desde el nodo</span></label>${chips("gi", opcionesNodos(), v.gi)}` +
            `<label class="campo"><span>Hasta el nodo</span></label>${chips("gf", opcionesNodos(), v.gf)}` +
            `<label class="campo"><span>Dirección</span></label>${chips("gdir", [["Y", "Vertical (Y)"], ["X", "Horizontal (X)"]], v.gdir)}` +
            `<div class="fila">${campo("h-w1", "En el primer nodo (kN/m)", numCampo(v.w1))}${campo("h-w2", "En el último (kN/m)", numCampo(v.w2))}</div>` +
            chips("sentido", sentidos(), v.sentido) +
            `<p class="nota">Recorre las barras que unen los dos nodos. Se mide por metro de proyección: la vertical por el ancho en planta y la horizontal por la altura.</p>`;
        } else if (t === "funcion") {
          const b = v.b === null ? L : Math.min(v.b, L);
          h = barraChips + `<div class="fila">${campo("h-a", `Desde (m, desde ${miembro(v.barra).i})`, numCampo(Math.min(v.a, L)))}${campo("h-b", "Hasta (m)", numCampo(b))}</div>` +
            campo("h-ley", "Q(X) en kN/m, perpendicular a la barra; X desde el inicio de la carga", v.ley, { modo: "text", extra: 'autocapitalize="off" autocorrect="off" spellcheck="false"' }) +
            `<p class="texto-ley" id="h-ley-texto"></p><svg class="vista-previa" id="h-ley-vista" viewBox="0 0 300 90"></svg>` +
            `<p class="nota">Positivo hacia ${flechaDe(normalPositiva(miembro(v.barra)))} (la normal de la barra que mira hacia arriba). Ejemplos: <b>-2.5X^2</b>, <b>-6*sin(pi*X/6)</b>.</p>`;
        } else if (t === "momento") {
          h = barraChips + campo("h-s", `Distancia desde ${miembro(v.barra).i} (0 o ${fmt(L, 3)} m = en el nodo)`, numCampo(Math.min(v.s, L))) +
            campo("h-M", "Valor (kN·m)", numCampo(v.M)) + chips("msentido", [["anti", "↺ Antihorario"], ["horario", "↻ Horario"]], v.msentido);
        }
        $("h-campos").innerHTML = h;
        if (t === "funcion") {
          const actualizar = debounce(vistaPreviaLey, 450);
          for (const k of ["h-ley", "h-a", "h-b"]) $(k).addEventListener("input", actualizar);
          vistaPreviaLey();
        }
      };
      alElegir = (grupo, valor) => {
        recordar();
        if (grupo === "barra") { v.barra = valor; v.a = 0; v.b = null; v.s = Math.min(v.s, largo(miembro(valor))); }
        if (["tipo", "barra", "dir", "gdir"].includes(grupo)) pintar();
      };
      pintar();
    });
  }

  async function aplicarCarga(idEditado, original, leyInicial) {
    const t = valorChip("tipo");
    const signo = valorChip("sentido") === "pos" ? 1 : -1;
    let lista, datos, muestras = null;
    if (t === "nodal") {
      const fx = leerNumero("h-fx", { nombre: "Fx" }), fy = leerNumero("h-fy", { nombre: "Fy" });
      if (fx === 0 && fy === 0) throw new Error("La fuerza no puede ser cero.");
      lista = "cargas_nodales"; datos = { nodo: valorChip("nodo"), fx, fy };
    } else if (t === "global") {
      // va de nodo a nodo: no tiene una barra propia
      const gi = valorChip("gi"), gf = valorChip("gf");
      if (gi === gf) throw new Error("Elige dos nodos distintos.");
      if (!camino(gi, gf)) throw new Error(`No hay barras que unan ${gi} con ${gf}.`);
      const w1 = leerNumero("h-w1", { nombre: "Primer valor" }), w2 = leerNumero("h-w2", { nombre: "Último valor" });
      if (w1 === 0 && w2 === 0) throw new Error("La carga no puede ser cero en los dos extremos.");
      lista = "cargas_globales"; datos = { nodo_i: gi, nodo_f: gf, direccion: valorChip("gdir"), w1: signo * w1, w2: signo * w2 };
    } else {
      const et = valorChip("barra");
      const m = miembro(et), L = largo(m);
      if (t === "puntual") {
        const s = leerNumero("h-s", { minimo: 0, maximo: L, nombre: "Distancia" });
        const fx = leerNumero("h-fx", { nombre: "Fx" }), fy = leerNumero("h-fy", { nombre: "Fy" });
        if (fx === 0 && fy === 0) throw new Error("La fuerza no puede ser cero.");
        lista = "cargas_puntuales"; datos = { miembro: et, s, fx, fy };
      } else if (t === "momento") {
        const s = leerNumero("h-s", { minimo: 0, maximo: L, nombre: "Distancia" });
        const valor = leerNumero("h-M", { minimo: 0, nombre: "Valor" });
        if (valor === 0) throw new Error("El momento no puede valer cero.");
        lista = "momentos"; datos = { M: valor * (valorChip("msentido") === "horario" ? -1 : 1), miembro: et, s, nodo: "" };
      } else {
        const a = leerNumero("h-a", { minimo: 0, maximo: L, nombre: "Desde" });
        const b = leerNumero("h-b", { minimo: 0, maximo: L, nombre: "Hasta" });
        if (b - a < 1e-6) throw new Error("«Hasta» debe ser mayor que «Desde».");
        if (t === "repartida") {
          const w1 = leerNumero("h-w1", { nombre: "Al inicio" }), w2 = leerNumero("h-w2", { nombre: "Al final" });
          if (w1 === 0 && w2 === 0) throw new Error("La carga no puede ser cero en los dos extremos.");
          lista = "cargas_distribuidas"; datos = { miembro: et, x1: a, x2: b, w1: signo * w1, w2: signo * w2, direccion: valorChip("dir") };
        } else {
          const textoLey = $("h-ley").value.trim();
          if (!textoLey) throw new Error("Escribe la función Q(X).");
          lista = "cargas_polinomicas";
          if (original && textoLey === leyInicial.trim()) {
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
    }
    const id = idEditado !== null ? idEditado : nuevoId();
    if (idEditado !== null) quitarCarga(idEditado);
    modelo[lista].push({ id, ...datos });
    if (muestras) leyes.set(id, muestras);
    cambio();
  }

  // ===================================================================== resultados
  const DIAGRAMAS = () => esArmadura()
    ? [["Axial", "N (kN)"], ["deformada", "Deformada"]]
    : [["Momento (DMF)", "M (kN·m)"], ["Cortante (DFC)", "V (kN)"], ["Axial", "N (kN)"], ["deformada", "Deformada"]];
  const COLOR = { "Axial": "#0f766e", "Cortante (DFC)": "#2563eb", "Momento (DMF)": "#dc2626", deformada: "#15803d" };

  function mostrarResultados() {
    const r = resultado;
    $("res-metodo").textContent = r.metodo;
    $("res-notas").textContent = [...(r.notas || []), ...(r.avisos || [])].join(" ");
    const conM = Object.values(r.reacciones).some((x) => x.M !== null && x.M !== undefined);
    const filas = Object.entries(r.reacciones).map(([et, x]) => {
      const a = modelo.apoyos.find((y) => y.etiqueta === et) || apoyoDe(et);
      const val = (q) => (q === null || q === undefined ? "—" : fmt(q, 3));
      return `<tr><td><b>${escapar(a ? a.nodo : et)}</b></td><td class="num">${val(x.Rx)}</td><td class="num">${val(x.Ry)}</td>` +
        (conM ? `<td class="num">${val(x.M)}</td>` : "") + `</tr>`;
    }).join("");
    $("res-reacciones").innerHTML = `<tr><th>Apoyo</th><th class="num">Rx (kN) →+</th><th class="num">Ry (kN) ↑+</th>` +
      `${conM ? `<th class="num">M (kN·m) ↺+</th>` : ""}</tr>${filas}`;
    if (!DIAGRAMAS().some(([k]) => k === diagramaActivo)) diagramaActivo = DIAGRAMAS()[0][0];
    $("resultados").hidden = false;
    dibujarDiagramas();
  }

  function dibujarDiagramas() {
    const caja = $("diagramas");
    const W = Math.max(280, caja.clientWidth || 340);
    const xs = modelo.nodos.map((n) => n.x), ys = modelo.nodos.map((n) => n.y);
    const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
    const ancho = Math.max(xmax - xmin, 1e-6), alto = Math.max(ymax - ymin, 1e-6);
    const m = esArmadura() ? 28 : 46;
    const esc = Math.min((W - 2 * m) / ancho, ymax - ymin > 1e-6 ? 380 / alto : Infinity);
    // arriba y abajo cabe el diagrama más alto con su valor (y arriba también el título)
    const amp = esArmadura() ? 0 : Math.min(46, 0.12 * esc * Math.max(ancho, alto));
    const mArriba = esArmadura() ? m : 24 + amp + 16, mAbajo = esArmadura() ? m : amp + 18;
    const H = Math.max(160, esc * (ymax - ymin) + mArriba + mAbajo);
    const X = (x) => m + (W - 2 * m - esc * (xmax - xmin)) / 2 + esc * (x - xmin);
    const Y = (y) => H - mAbajo - (H - mArriba - mAbajo - esc * (ymax - ymin)) / 2 - esc * (y - ymin);
    const clave = diagramaActivo;
    let s = "";
    for (const mb of modelo.miembros) {
      const a = nodo(mb.i), b = nodo(mb.j);
      s += `<line x1="${X(a.x)}" y1="${Y(a.y)}" x2="${X(b.x)}" y2="${Y(b.y)}" class="diag-estructura"/>`;
    }
    const lecturas = [];             // para tocar: [barra, s, valor, X, Y]
    if (clave === "Axial" && esArmadura()) {
      // armadura: cada barra de color (azul tracción, rojo compresión), gruesa según la fuerza, con su valor
      const por = resultado.diagramas["Axial"] || {};
      const N = (et) => { const d = por[et]; return d && d.length ? d[Math.floor(d.length / 2)][1] : 0; };
      const nmax = Math.max(1e-12, ...modelo.miembros.map((mb) => Math.abs(N(mb.etiqueta))));
      const color = (n) => (Math.abs(n) < 1e-6 * nmax + 1e-9 ? "#94a3b8" : n > 0 ? "#2563eb" : "#dc2626");
      let lineas = "", textos = "";
      const pantalla = (mb) => { const a = nodo(mb.i), b = nodo(mb.j); return [X(a.x), Y(a.y), X(b.x), Y(b.y)]; };
      for (const mb of modelo.miembros) {
        const n = N(mb.etiqueta), c = color(n), [x1, y1, x2, y2] = pantalla(mb);
        const ancho = c === "#94a3b8" ? 2 : 2.5 + (7 * Math.abs(n)) / nmax;
        lineas += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${ancho.toFixed(1)}" stroke-linecap="round"/>`;
        const L = largo(mb);
        for (const f of [0.25, 0.5, 0.75]) { const [px, py] = puntoEn(mb, f * L); lecturas.push([mb.etiqueta, f * L, n, X(px), Y(py)]); }
      }
      // el valor va sobre su barra: se corre a lo largo de ella hasta que no choque con otro
      // valor, con un nudo ni con otra barra; si no cabe, al lado. Las barras cortas eligen primero
      const cajas = [], pNodos = modelo.nodos.map((q) => [X(q.x), Y(q.y)]);
      const pBarras = modelo.miembros.map((mb) => [mb.etiqueta, pantalla(mb)]);
      const libre = (k, et, estricto) => k[0] > 1 && k[2] < W - 1 && k[1] > 19 && k[3] < H - 1 &&
        !cajas.some((o) => k[0] < o[2] && k[2] > o[0] && k[1] < o[3] && k[3] > o[1]) &&
        !pNodos.some(([x, y]) => x > k[0] - 5 && x < k[2] + 5 && y > k[1] - 5 && y < k[3] + 5) &&
        (!estricto || !pBarras.some(([e2, sg]) => e2 !== et && segmentoEnCaja(sg, k)));
      const porLargo = [...modelo.miembros].sort((p, q) => { const [a1, b1, c1, d1] = pantalla(p), [a2, b2, c2, d2] = pantalla(q);
        return Math.hypot(c1 - a1, d1 - b1) - Math.hypot(c2 - a2, d2 - b2); });
      for (const mb of porLargo) {
        const n = N(mb.etiqueta), c = color(n), [x1, y1, x2, y2] = pantalla(mb);
        const txt = c === "#94a3b8" ? "0" : `${fmt(Math.abs(n))} ${n > 0 ? "T" : "C"}`;
        const w = txt.length * 6.3 + 6, h = 13;
        const lb = Math.hypot(x2 - x1, y2 - y1) || 1, nx = -(y2 - y1) / lb, ny = (x2 - x1) / lb;
        const aparte = (w / 2) * Math.abs(nx) + (h / 2) * Math.abs(ny) + 4;     // lo que hay que salirse para no tocar la barra
        const en = (f, lado = 0) => { const px = x1 + f * (x2 - x1) + lado * aparte * nx, py = y1 + f * (y2 - y1) + lado * aparte * ny;
          return [px, py, [px - w / 2, py - h / 2, px + w / 2, py + h / 2]]; };
        const sobre = [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75, 0.18, 0.82].map((f) => en(f));
        const alLado = [0.5, 0.35, 0.65].flatMap((f) => [en(f, 1), en(f, -1)]);
        const pos = sobre.find((q) => libre(q[2], mb.etiqueta, true)) || sobre.find((q) => libre(q[2], mb.etiqueta, false)) ||
          alLado.find((q) => libre(q[2], mb.etiqueta, false)) || sobre[0];
        cajas.push(pos[2]);
        textos += `<text x="${pos[0].toFixed(1)}" y="${(pos[1] + 4).toFixed(1)}" text-anchor="middle" class="diag-valor-arm" fill="${c}">${txt}</text>`;
      }
      s = lineas + modelo.nodos.map((n) => `<circle cx="${X(n.x)}" cy="${Y(n.y)}" r="3.5" class="nodo-arm"/>`).join("") + textos;
      s += `<text x="8" y="16" class="diag-titulo" fill="#0f172a">N (kN): <tspan fill="#2563eb">T tracción</tspan> · <tspan fill="#dc2626">C compresión</tspan></text>`;
    } else if (clave === "deformada") {
      const dx = resultado.diagramas["Desplazamiento Horizontal"] || {}, dy = resultado.diagramas["Desplazamiento Vertical"] || {};
      let umax = 1e-12;
      for (const mb of modelo.miembros) for (const [k, [, u]] of (dx[mb.etiqueta] || []).entries()) {
        const v = ((dy[mb.etiqueta] || [])[k] || [0, 0])[1];
        umax = Math.max(umax, Math.hypot(u, v));
      }
      const amp = (0.08 * Math.max(ancho, alto)) / umax;
      for (const mb of modelo.miembros) {
        const ux = dx[mb.etiqueta] || [], uy = dy[mb.etiqueta] || [];
        if (!ux.length) continue;
        const pts = ux.map(([sv, u], k) => {
          const [px, py] = puntoEn(mb, sv), v = (uy[k] || [0, 0])[1];
          lecturas.push([mb.etiqueta, sv, Math.hypot(u, v) * 1000, X(px + amp * u), Y(py + amp * v)]);
          return `${X(px + amp * u).toFixed(1)},${Y(py + amp * v).toFixed(1)}`;
        });
        s += `<polyline points="${pts.join(" ")}" class="diag-deformada"/>`;
      }
      s += `<text x="8" y="16" class="diag-titulo" fill="${COLOR.deformada}">Deformada (exagerada ×${fmt(amp, 0)}) · desplazamiento máximo ${fmt(umax * 1000, 2)} mm</text>`;
    } else {
      const por = resultado.diagramas[clave] || {};
      let vmax = 1e-12;
      for (const mb of modelo.miembros) for (const [, v] of por[mb.etiqueta] || []) vmax = Math.max(vmax, Math.abs(v));
      const anchoD = amp;
      const color = COLOR[clave];
      const etqs = [];
      // en el nudo que comparten varias barras el mismo valor se escribe una vez; si hay
      // salto, cada valor se corre hacia adentro de su barra (como el escritorio)
      const extremos = new Map(), porNodo = new Map();
      for (const mb of modelo.miembros) {
        const d = por[mb.etiqueta];
        if (!d || d.length < 2) continue;
        for (const [nd, k, v] of [[mb.i, 0, d[0][1]], [mb.j, d.length - 1, d[d.length - 1][1]]]) {
          if (!porNodo.has(nd)) porNodo.set(nd, []);
          porNodo.get(nd).push([mb.etiqueta, k, v]);
        }
      }
      for (const lista of porNodo.values()) {
        if (lista.length < 2) continue;
        const vs = lista.map((q) => q[2]), igual = Math.max(...vs) - Math.min(...vs) <= 0.02 * vmax;
        lista.forEach(([et, k], idx) => { if (!igual) extremos.set(`${et}:${k}`, "adentro"); else if (idx > 0) extremos.set(`${et}:${k}`, "omitir"); });
      }
      for (const mb of modelo.miembros) {
        const datos = por[mb.etiqueta];
        if (!datos || !datos.length) continue;
        const [ux, uy] = unitario(mb), der = [uy, -ux];          // positivo hacia la derecha de i → j (como el escritorio)
        const eje = [], borde = [];
        for (const [sv, v] of datos) {
          const [px, py] = puntoEn(mb, sv);
          const off = (v / vmax) * anchoD;
          eje.push([X(px), Y(py)]);
          borde.push([X(px) + der[0] * off, Y(py) - der[1] * off]);
          lecturas.push([mb.etiqueta, sv, v, X(px) + der[0] * off, Y(py) - der[1] * off]);
        }
        const pol = [...eje, ...borde.reverse()].map((p) => p.map((q) => q.toFixed(1)).join(",")).join(" ");
        s += `<polygon points="${pol}" class="diag-marco" style="fill:${color}22;stroke:${color}"/>`;
        // el valor en cada extremo y el de mayor magnitud de la barra
        const vals = datos.map((d) => d[1]);
        const kMax = vals.reduce((k, val, i) => (Math.abs(val) > Math.abs(vals[k]) ? i : k), 0);
        const constante = Math.max(...vals) - Math.min(...vals) < 1e-6 * vmax + 1e-9;
        for (const k of constante ? [Math.floor(datos.length / 2)] : new Set([0, datos.length - 1, kMax])) {
          if (Math.abs(vals[k]) < 1e-9 * vmax + 1e-9) continue;
          const modo = extremos.get(`${mb.etiqueta}:${k}`);
          if (modo === "omitir") continue;
          const [px, py] = puntoEn(mb, datos[k][0]);
          const off = (vals[k] / vmax) * anchoD, sg = Math.sign(off || 1);
          const dentro = modo === "adentro" ? (k === 0 ? 16 : -16) : 0;          // px a lo largo de la barra
          const extremo = constante ? 0 : k === 0 ? -1 : k === datos.length - 1 ? 1 : 0;
          etqs.push([X(px) + der[0] * off + ux * dentro, Y(py) - der[1] * off - uy * dentro, der[0] * sg, -der[1] * sg, vals[k], ux, -uy, extremo]);
        }
      }
      // cada valor sale del borde del diagrama hacia afuera (alineado según hacia dónde sale);
      // si ahí no cabe o choca, prueba más allá del nudo o corrido a lo largo de la barra.
      // Primero los mayores; el que no encuentra sitio se omite
      const puestos = [];
      const choca = (k) => puestos.some((o) => k[0] < o[2] && k[2] > o[0] && k[1] < o[3] && k[3] > o[1]);
      const barrasPx = modelo.miembros.map((mb) => { const a = nodo(mb.i), b = nodo(mb.j); return [X(a.x), Y(a.y), X(b.x), Y(b.y)]; });
      const cruza = (k) => barrasPx.some((sg) => segmentoEnCaja(sg, k));
      for (const [bx, by, dx, dy, val, sx, sy, extremo] of etqs.sort((p, q) => Math.abs(q[4]) - Math.abs(p[4]))) {
        const t = fmt(val), w = t.length * 6.9 + 4;
        const pruebas = [[dx * 6, dy * 6, dx, dy]];                     // [corrimiento x, y, dirección de salida]
        if (extremo) {
          const fx = sx * extremo, fy = sy * extremo;                   // más allá del nudo, fuera de la barra
          const l = Math.hypot(dx + 0.7 * fx, dy + 0.7 * fy) || 1, ax = (dx + 0.7 * fx) / l, ay = (dy + 0.7 * fy) / l;
          pruebas.push([ax * 6, ay * 6, ax, ay], [fx * 8, fy * 8, fx, fy], [dx * 6 - fx * 14, dy * 6 - fy * 14, dx, dy]);
        } else pruebas.push([dx * 6 + sx * 14, dy * 6 + sy * 14, dx, dy], [dx * 6 - sx * 14, dy * 6 - sy * 14, dx, dy]);
        pruebas.push([dx * 18, dy * 18, dx, dy]);
        const opciones = pruebas.map(([ox, oy, ddx, ddy]) => {
          const ancla = ddx > 0.38 ? "start" : ddx < -0.38 ? "end" : "middle";
          const y = Math.min(Math.max(by + oy + (ddy > 0.38 ? 10 : ddy < -0.38 ? -2 : 4), 32), H - 4);
          const x = bx + ox, x0 = ancla === "start" ? x : ancla === "end" ? x - w : x - w / 2;
          const corre = Math.max(0, 2 - x0) - Math.max(0, x0 + w - (W - 2));     // sin salirse del dibujo
          return { x: x + corre, y, ancla, corre, k: [x0 + corre, y - 11, x0 + corre + w, y + 3] };
        });
        const cabe = (o) => Math.abs(o.corre) <= 0.35 * w && !choca(o.k);
        const el = opciones.find((o) => cabe(o) && !cruza(o.k)) || opciones.find(cabe) || (!choca(opciones[0].k) && opciones[0]);
        if (!el) continue;
        puestos.push(el.k);
        s += `<text x="${el.x.toFixed(1)}" y="${el.y.toFixed(1)}" text-anchor="${el.ancla}" class="diag-valor" fill="${color}">${t}</text>`;
      }
      const nombre = DIAGRAMAS().find(([k]) => k === clave)[1];
      s += `<text x="8" y="16" class="diag-titulo" fill="${color}">${nombre}${clave === "Axial" ? " · + tracción" : ""}</text>`;
    }
    s += `<g class="cursor"></g>`;
    caja.innerHTML = `<div class="chips chips-diagrama">${DIAGRAMAS().map(([k, t]) =>
      `<button type="button" class="chip${k === clave ? " activo" : ""}" data-diagrama="${k}">${t}</button>`).join("")}</div>`;
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", `0 0 ${W} ${H}`);
    el.innerHTML = s;
    caja.appendChild(el);
    caja._marco = { el, W, H, lecturas, unidad: clave === "deformada" ? "mm" : clave === "Momento (DMF)" ? "kN·m" : "kN" };
    for (const b of caja.querySelectorAll("[data-diagrama]")) b.addEventListener("click", () => { diagramaActivo = b.dataset.diagrama; dibujarDiagramas(); });
  }

  // tocar el diagrama: el valor más cercano
  function leer(e) {
    const caja = $("diagramas");
    const d = caja._marco;
    if (!d || !d.lecturas.length || e.target.closest("[data-diagrama]")) return;
    const r = d.el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * d.W, py = ((e.clientY - r.top) / r.height) * d.H;
    let mejor = null, dist = Infinity;
    for (const l of d.lecturas) { const q = Math.hypot(l[3] - px, l[4] - py); if (q < dist) { dist = q; mejor = l; } }
    const g = d.el.querySelector(".cursor");
    if (!mejor || dist > 40) { g.innerHTML = ""; return; }
    const [et, sv, val, lx, ly] = mejor;
    const texto = `${et} · s = ${fmt(sv, 2)} m · ${fmt(val, 2)} ${d.unidad}`;
    const ancho = texto.length * 6.6 + 14, bx = Math.min(Math.max(lx - ancho / 2, 2), d.W - ancho - 2), by = Math.max(4, ly - 34);
    g.innerHTML = `<circle cx="${lx}" cy="${ly}" r="4.5" fill="#f59e0b"/><rect x="${bx}" y="${by}" width="${ancho}" height="20" rx="6" class="cursor-caja"/>` +
      `<text x="${bx + ancho / 2}" y="${by + 14}" text-anchor="middle" class="cursor-texto">${escapar(texto)}</text>`;
  }

  // ===================================================================== paso a paso
  // iso: solo isostáticas. pide: "punto" (barra y s), "energia", "nudo" (armadura) o "mep"
  const METODOS = () => esArmadura() ? [
    { m: "Reacciones (Estática)", titulo: "Reacciones y método de los nudos", tema: "Mecánica de Sólidos", desc: "Reacciones por equilibrio y la fuerza de cada barra nudo por nudo.", pide: null, iso: true },
    { m: "Trabajo Virtual", tema: "Análisis Clásico", desc: "El desplazamiento de un nudo con la carga unitaria.", pide: "nudo" },
    { m: "Castigliano", tema: "Análisis Clásico", desc: "El desplazamiento de un nudo derivando la energía.", pide: "nudo" },
    { m: "Matricial de Rigidez", tema: "Análisis Matricial", desc: "Matriz de cada barra, ensamble, desplazamientos y fuerzas.", pide: null },
  ] : [
    { m: "Reacciones (Estática)", tema: "Mecánica de Sólidos", desc: "Reacciones por equilibrio, cortes por barra y diagramas.", pide: null, iso: true },
    { m: "Fuerzas Internas en un Punto", tema: "Mecánica de Sólidos", desc: "N, V y M en un punto, por los dos lados del corte.", pide: "punto", iso: true },
    { m: "Trabajo Virtual", tema: "Análisis Clásico", desc: "Un desplazamiento o giro con la carga unitaria.", pide: "energia", iso: true },
    { m: "Castigliano", tema: "Análisis Clásico", desc: "Un desplazamiento o giro derivando la energía.", pide: "energia", iso: true },
    { m: "Pendiente-Deflexión", tema: "Análisis Clásico", desc: "Giros de los nudos y desplazamiento de piso (barras rectas).", pide: null },
    { m: "Matricial de Rigidez", tema: "Análisis Matricial", desc: "Matrices de cada barra, ensamble y solución.", pide: "mep" },
  ];

  function hojaPasoAPaso() {
    const g = grado();
    const estado = g < 0 ? "La estructura es inestable: le faltan apoyos o barras." : g === 0 ? `${modelo.tipo} isostático.` : `${modelo.tipo} hiperestático de grado ${g}.`;
    const noAplica = (x, larga) => (g < 0 ? "Inestable: revisa apoyos y barras." : x.iso && g > 0 ? (larga ? `Es para estructuras isostáticas y esta es hiperestática de grado ${g}.` : "Solo para estructuras isostáticas.") : "");
    let html = `<p class="nota">${estado.replace("Armadura isostático", "Armadura isostática").replace("Armadura hiperestático", "Armadura hiperestática")}</p><div class="lista-metodos">`;
    for (const tema of ["Mecánica de Sólidos", "Análisis Clásico", "Análisis Matricial"]) {
      const delTema = METODOS().filter((x) => x.tema === tema);
      if (!delTema.length) continue;
      html += `<h4>${tema}</h4>`;
      for (const x of delTema) {
        const razon = noAplica(x, false);
        html += `<button class="metodo${razon ? " no-aplica" : ""}" data-m="${escapar(x.m)}"><b>${x.titulo || x.m}</b><small>${razon || x.desc}</small></button>`;
      }
    }
    abrirHoja("Paso a paso: elige el método", html + "</div>", [{ texto: "Cerrar", clase: "secundario", accion: () => true }], () => {
      for (const b of $("hoja-cuerpo").querySelectorAll(".metodo")) {
        b.addEventListener("click", () => {
          const met = METODOS().find((x) => x.m === b.dataset.m);
          const razon = noAplica(met, true);
          if (razon) aviso(razon, true);
          else if (met.pide) hojaOpciones(met);
          else { cerrarHoja(); generarReporte(met.m, {}); }
        });
      }
    });
  }

  function hojaOpciones(met) {
    let html = "";
    const m0 = modelo.miembros[0];
    const punto = `<label class="campo"><span>Barra</span></label>${chips("barra", opcionesBarras(), m0.etiqueta)}` +
      campo("h-s", `Distancia desde el nodo inicial (m)`, numCampo(largo(m0) / 2));
    if (met.pide === "punto") html = punto;
    else if (met.pide === "energia") html = `<label class="campo"><span>Qué calcular</span></label>` +
      chips("tipo", [["vertical", "Desp. vertical"], ["horizontal", "Desp. horizontal"], ["rotacion", "Giro"]], "vertical") + punto;
    else if (met.pide === "nudo") {
      const libre = modelo.nodos.find((n) => !apoyoDe(n.etiqueta)) || modelo.nodos[0];
      html = `<label class="campo"><span>Nudo</span></label>${chips("nudo", opcionesNodos(), libre.etiqueta)}` +
        `<label class="campo"><span>Dirección del desplazamiento</span></label>` +
        chips("dir", [["270", "↓ Vertical"], ["0", "→ Horizontal"], ["otra", "Otro ángulo"]], "270") +
        `<div id="h-angulo" style="display:none">${campo("h-ang", "Ángulo desde +x (°, antihorario)", "45")}</div>`;
    } else if (met.pide === "mep") {
      html = `<label class="campo"><span>Momentos de empotramiento</span></label>${chips("mep", [["integrales", "Por integrales"], ["tablas", "Por tablas"]], "integrales")}`;
    }
    abrirHoja(met.titulo || met.m, html, [
      { texto: "Atrás", clase: "secundario", accion: () => { hojaPasoAPaso(); return false; } },
      { texto: "Generar", accion: () => {
        const op = {};
        if (met.pide === "punto" || met.pide === "energia") {
          const et = valorChip("barra");
          op.miembro = et;
          op.s = leerNumero("h-s", { minimo: 0, maximo: largo(miembro(et)), nombre: "Distancia" });
          if (met.pide === "energia") op.tipo = valorChip("tipo");
        }
        if (met.pide === "nudo") {
          op.nodo = valorChip("nudo");
          op.angulo = valorChip("dir") === "otra" ? leerNumero("h-ang", { nombre: "Ángulo" }) : Number(valorChip("dir"));
        }
        if (met.pide === "mep") op.mep = valorChip("mep");
        cerrarHoja();
        generarReporte(met.m, op);
      } },
    ], () => {
      alElegir = (grupo, valor) => {
        if (grupo === "barra") $("h-s").value = numCampo(largo(miembro(valor)) / 2);
        if (grupo === "dir") $("h-angulo").style.display = valor === "otra" ? "" : "none";
      };
    });
  }

  // ===================================================================== nuevo modelo
  function hojaNuevo() {
    const tipo = modelo.tipo;
    const pl = PLANTILLAS[tipo];
    const html = `<p class="nota">Se reemplaza ${tipo === "Armadura" ? "la armadura" : "el pórtico"} actual (guárdalo antes si lo quieres conservar).</p>` +
      `<label class="campo"><span>Forma</span></label>${chips("forma", pl, pl[0][0])}` +
      `<div id="h-medidas"></div>`;
    abrirHoja(`Nuevo ${tipo === "Armadura" ? "armadura" : "pórtico"}`, html, [
      { texto: "Cancelar", clase: "secundario", accion: () => true },
      { texto: "Crear", accion: () => {
        const cual = valorChip("forma");
        if (cual === "blanco") crearPlantilla(tipo, "blanco");
        else {
          const L = leerNumero("h-L", { minimo: 0.5, nombre: "Claro" }), H = leerNumero("h-H", { minimo: 0.5, nombre: "Altura" });
          const extra = $("h-extra") ? leerNumero("h-extra", { minimo: tipo === "Armadura" ? 2 : 0.1, maximo: tipo === "Armadura" ? 16 : 1e6, nombre: tipo === "Armadura" ? "Paneles" : "Flecha" }) : 0;
          crearPlantilla(tipo, cual, L, H, extra);
        }
        leyes.clear();
        cambio({ encuadrar: true });
      } },
    ], () => {
      const pintar = () => {
        const cual = valorChip("forma");
        if (cual === "blanco") { $("h-medidas").innerHTML = `<p class="nota">Empieza con un nodo en (0, 0): agrega los demás con «Nodo» y únelos con «Barra».</p>`; return; }
        let h = `<div class="fila">${campo("h-L", "Claro (m)", tipo === "Armadura" ? "12" : "6")}${campo("h-H", cual === "pisos" ? "Altura de cada piso (m)" : "Altura (m)", tipo === "Armadura" ? "3" : "4")}</div>`;
        if (cual === "aguas") h += campo("h-extra", "Flecha de la cubierta (m)", "1.5");
        if (tipo === "Armadura") h += campo("h-extra", "Número de paneles", "4");
        $("h-medidas").innerHTML = h;
      };
      alElegir = (grupo) => { if (grupo === "forma") pintar(); };
      pintar();
    });
  }

  return { dibujar, tocar, accion, herramientas, mostrarResultados, dibujarDiagramas, leer, hojaPasoAPaso, hojaNuevo,
           inicial, grado, salirModoBarra, get modoBarra() { return modoBarra; } };
})();
