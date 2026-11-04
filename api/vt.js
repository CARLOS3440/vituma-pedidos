/* =====================================================================
   VITUMA · Base de datos (función de Vercel)
   - Datos (pedidos, clientes, pagos, gastos, usuarios): Upstash Redis
   - Imágenes (mockups, piezas, logos, comprobantes): Vercel Blob (privado)
   Todo entra por /api/vt?a=<acción>. Si Redis no está conectado, la app
   sigue en "modo muestra" (datos en el navegador).
   ===================================================================== */
import crypto from "node:crypto";

const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const R_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const HAY_DB = !!(R_URL && R_TOK);
const HAY_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN || !!process.env.VT_BLOB_DIR;
const SES_HORAS = 12;
const IMG_MAX = 4 * 1024 * 1024;   // 4 MB por imagen

/* ---------- Redis (Upstash REST) ---------- */
async function rp(cmds){
  const r = await fetch(R_URL.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: `Bearer ${R_TOK}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error("redis: " + x.error); return x.result; });
}
const r1 = async (...c) => (await rp([c]))[0];
const J = s => { try { return s == null ? null : JSON.parse(s); } catch(e){ return null; } };
async function mget(keys){
  const out = [];
  for (let i = 0; i < keys.length; i += 200){ const part = keys.slice(i, i + 200); if (part.length) out.push(...await r1("MGET", ...part)); }
  return out.map(J);
}

/* ---------- imágenes (Vercel Blob privado; en pruebas locales, una carpeta) ---------- */
let _blob = null;
const blob = async () => _blob || (_blob = await import("@vercel/blob"));
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
async function guardarImagen(dataUrl, carpeta){
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl || ""); if (!m) throw new Error("imagen inválida");
  const tipo = m[1], buf = Buffer.from(m[2], "base64");
  if (!EXT[tipo]) throw new Error("tipo no permitido");
  if (buf.length > IMG_MAX) throw new Error("imagen muy grande");
  const nombre = `${(carpeta || "img").replace(/[^\w-]/g, "")}/${Date.now().toString(36)}-${crypto.randomBytes(9).toString("hex")}.${EXT[tipo]}`;
  await contarSubida(nombre, buf.length);
  if (process.env.VT_BLOB_DIR){   // pruebas locales
    const fs = await import("node:fs"), path = await import("node:path"); const f = path.join(process.env.VT_BLOB_DIR, nombre);
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return "/api/vt?a=img&p=" + encodeURIComponent(nombre);
  }
  const { put } = await blob();
  let acceso = (await r1("GET", "vt:cfg:blob")) || "private";
  try { await put(nombre, buf, { access: acceso, contentType: tipo, addRandomSuffix: false }); }
  catch(e){   // la tienda se creó pública: se usa así
    if (acceso === "private" && /public|access/i.test(String(e && e.message))){ acceso = "public"; await r1("SET", "vt:cfg:blob", acceso); await put(nombre, buf, { access: acceso, contentType: tipo, addRandomSuffix: false }); }
    else throw e;
  }
  return "/api/vt?a=img&p=" + encodeURIComponent(nombre);
}
/* ---------- cuánto espacio se usa (para avisar antes de llegar al límite del plan) ---------- */
const LIM = { bytes: +(process.env.VT_LIMITE_MB || 1024) * 1024 * 1024, subidas: +(process.env.VT_LIMITE_SUBIDAS || 2000) };
const mes = () => new Date().toISOString().slice(0, 7);
async function contarSubida(nombre, n){
  await rp([["HSET", "vt:img", nombre, n], ["INCRBY", "vt:uso:bytes", n], ["INCR", "vt:uso:sub:" + mes()], ["EXPIRE", "vt:uso:sub:" + mes(), 86400 * 70]]);
}
async function borrarImagenes(rutas){
  if (!rutas.length) return 0;
  const tam = await r1("HMGET", "vt:img", ...rutas), total = (tam || []).reduce((a, x) => a + (+x || 0), 0);
  if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"); for (const r of rutas){ try { fs.unlinkSync(path.join(process.env.VT_BLOB_DIR, r)); } catch(e){} } }
  else { const { del } = await blob(); for (let i = 0; i < rutas.length; i += 100) await del(rutas.slice(i, i + 100)); }
  await rp([["HDEL", "vt:img", ...rutas], ["DECRBY", "vt:uso:bytes", total]]);
  return total;
}
const rutasDe = o => { const out = new Set(), rec = x => { if (typeof x === "string"){ const m = x.match(/^\/api\/vt\?a=img&p=([^&"]+)/); if (m) out.add(decodeURIComponent(m[1])); } else if (x && typeof x === "object") Object.values(x).forEach(rec); }; rec(o); return out; };
/* por si llega algún dato con imágenes adentro: se suben y se cambian por su liga */
async function sacarImagenes(o, carpeta){
  if (!o || typeof o !== "object") return;
  for (const k of Object.keys(o)){ const v = o[k];
    if (typeof v === "string" && v.startsWith("data:") && v.length > 3000) o[k] = await guardarImagen(v, carpeta);
    else if (v && typeof v === "object") await sacarImagenes(v, carpeta); }
}

/* ---------- utilidades ---------- */
const ip = req => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "x").split(",")[0].trim();
async function limite(req, clave, max, seg){
  const k = `vt:rl:${clave}:${ip(req)}`, [n] = await rp([["INCR", k], ["EXPIRE", k, seg, "NX"]]);
  return n <= max;
}
const sha = t => crypto.createHash("sha256").update("vituma::" + t).digest("hex");
const sinPass = u => { const { pass, ...r } = u; return r; };
const ahora = () => Date.now();
async function marcar(miembros){ if (!miembros.length) return; const t = ahora(); await rp([["ZADD", "vt:chg", ...miembros.flatMap(m => [t, m])]]); }

async function usuarios(){ return J(await r1("GET", "vt:col:usuarios")) || []; }
async function sesion(req){
  const tok = String(req.headers["x-vt-token"] || ""); if (!/^[a-f0-9]{48}$/.test(tok)) return null;
  const id = await r1("GET", "vt:ses:" + tok); if (!id) return null;
  const u = (await usuarios()).find(x => x.id === id && x.activo); if (!u) return null;
  await r1("EXPIRE", "vt:ses:" + tok, SES_HORAS * 3600);
  return u;
}
const telOk = t => /^\d{10}$/.test(String(t || ""));
const normal = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
/* lo que ve el cliente de su pedido (sin el historial interno) */
const paraCliente = v => { if (!v) return v; const { historial, ...r } = v; return r; };

async function todasLasVentas(){ const ids = await r1("SMEMBERS", "vt:iv") || []; return (await mget(ids.map(f => "vt:v:" + f))).filter(Boolean); }

/* ---------- acciones ---------- */
const A = {
  async estado(){ return { db: HAY_DB, imagenes: HAY_BLOB, version: 1 }; },

  /* --- panel --- */
  async login(req){
    if (!(await limite(req, "login", 20, 900))) throw Object.assign(new Error("Demasiados intentos. Espera unos minutos."), { code: 429 });
    const { usuario, pass } = req.body || {};
    let us = await usuarios();
    if (!us.length){   // primera vez: se crea el administrador (usuario admin, contraseña vituma; cámbiala al entrar)
      us = [{ id: "U1", nombre: "Administrador", usuario: "admin", rol: "Administrador", sucursal: "", permisos: [], activo: true, pass: sha("vituma"), alta: new Date().toISOString() }];
      await r1("SET", "vt:col:usuarios", JSON.stringify(us)); await r1("SADD", "vt:ik", "usuarios"); await marcar(["k:usuarios"]);
    }
    const u = us.find(x => x.usuario === String(usuario || "").trim().toLowerCase());
    if (!u || !u.activo || u.pass !== pass) throw Object.assign(new Error("Usuario o contraseña incorrectos."), { code: 401 });
    const tok = crypto.randomBytes(24).toString("hex");
    u.ultimo = new Date().toISOString();
    await rp([["SET", "vt:ses:" + tok, u.id, "EX", SES_HORAS * 3600], ["SET", "vt:col:usuarios", JSON.stringify(us)]]);
    return { token: tok, usuario: sinPass(u) };
  },
  async salir(req){ const tok = String(req.headers["x-vt-token"] || ""); if (tok) await r1("DEL", "vt:ses:" + tok); return { ok: true }; },
  async yo(req, u){ return { usuario: sinPass(u) }; },

  /* todo (desde = 0) o solo lo que cambió desde una hora */
  async datos(req){
    const desde = +(req.query.desde || 0), t = ahora();
    if (!desde){
      const ventas = await todasLasVentas();
      const cids = await r1("SMEMBERS", "vt:ic") || [], clientes = (await mget(cids.map(c => "vt:c:" + c))).filter(Boolean);
      const ks = await r1("SMEMBERS", "vt:ik") || [], vals = await mget(ks.map(k => "vt:col:" + k)), cols = {};
      ks.forEach((k, i) => { if (vals[i] != null) cols[k] = vals[i]; });
      if (cols.usuarios) cols.usuarios = cols.usuarios.map(sinPass);
      return { completo: true, ventas, clientes, cols, ahora: t };
    }
    const ms = await r1("ZRANGEBYSCORE", "vt:chg", "(" + desde, "+inf") || [];
    const vs = [...new Set(ms.filter(m => m.startsWith("v:")).map(m => m.slice(2)))], cs = [...new Set(ms.filter(m => m.startsWith("c:")).map(m => m.slice(2)))], ks = [...new Set(ms.filter(m => m.startsWith("k:")).map(m => m.slice(2)))];
    const V = await mget(vs.map(f => "vt:v:" + f)), C = await mget(cs.map(c => "vt:c:" + c)), K = await mget(ks.map(k => "vt:col:" + k)), cols = {};
    ks.forEach((k, i) => { if (K[i] != null) cols[k] = k === "usuarios" ? K[i].map(sinPass) : K[i]; });
    return { ventas: V.filter(Boolean), clientes: C.filter(Boolean), cols,
      borradas: { ventas: vs.filter((f, i) => !V[i]), clientes: cs.filter((c, i) => !C[i]) }, ahora: t };
  },

  async guardar(req){
    const b = req.body || {}, cmds = [], marcas = [];
    for (const v of b.ventas || []){ if (!v || !v.folio) continue; await sacarImagenes(v, "pedidos");
      cmds.push(["SET", "vt:v:" + v.folio, JSON.stringify(v)], ["SADD", "vt:iv", v.folio]); marcas.push("v:" + v.folio); }
    for (const c of b.clientes || []){ if (!c || !c.id) continue; await sacarImagenes(c, "clientes");
      cmds.push(["SET", "vt:c:" + c.id, JSON.stringify(c)], ["SADD", "vt:ic", c.id]); if (c.tel) cmds.push(["HSET", "vt:tel", c.tel, c.id]); marcas.push("c:" + c.id); }
    for (const [k, val] of Object.entries(b.cols || {})){
      if (!/^[a-zA-Z]\w{0,30}$/.test(k) || k === "ventas" || k === "clientes") continue;
      let x = val;
      if (k === "usuarios" && Array.isArray(x)){   // las contraseñas no viajan al panel: se conservan las guardadas si no vienen
        const antes = await usuarios(); x = x.map(u => { const a = antes.find(y => y.id === u.id); return u.pass ? u : { ...u, pass: a ? a.pass : sha("vituma") }; });
        if (!x.some(u => u.activo && u.rol === "Administrador")) throw Object.assign(new Error("Debe quedar al menos un administrador activo"), { code: 400 });
      }
      await sacarImagenes(x, "datos");
      cmds.push(["SET", "vt:col:" + k, JSON.stringify(x)], ["SADD", "vt:ik", k]); marcas.push("k:" + k);
    }
    for (const f of (b.borrar && b.borrar.ventas) || []){ cmds.push(["DEL", "vt:v:" + f], ["SREM", "vt:iv", f]); marcas.push("v:" + f); }
    for (const c of (b.borrar && b.borrar.clientes) || []){ cmds.push(["DEL", "vt:c:" + c], ["SREM", "vt:ic", c]); marcas.push("c:" + c); }
    if (cmds.length) await rp(cmds);
    await marcar(marcas);
    return { ok: true, ahora: ahora() };
  },

  /* espacio usado y subidas del mes, contra el límite del plan */
  async uso(req, u){
    const [b, s, n] = await rp([["GET", "vt:uso:bytes"], ["GET", "vt:uso:sub:" + mes()], ["HLEN", "vt:img"]]);
    return { bytes: Math.max(0, +b || 0), subidas: +s || 0, imagenes: +n || 0, limite: LIM, recalculado: await r1("GET", "vt:uso:recalc") };
  },
  /* vuelve a contar el espacio real leyendo la tienda de imágenes (por si hay imágenes de antes) */
  async recalcular(req, u){
    if (u.rol !== "Administrador") throw Object.assign(new Error("Solo un administrador"), { code: 403 });
    if (process.env.VT_BLOB_DIR) return A.uso(req, u);
    const { list } = await blob(); let cursor, total = 0; const mapa = [];
    do { const r = await list({ cursor, limit: 1000 }); for (const x of r.blobs){ total += x.size; mapa.push(x.pathname, x.size); } cursor = r.hasMore ? r.cursor : null; } while (cursor);
    const cmds = [["DEL", "vt:img"], ["SET", "vt:uso:bytes", total], ["SET", "vt:uso:recalc", new Date().toISOString()]];
    for (let i = 0; i < mapa.length; i += 400) cmds.push(["HSET", "vt:img", ...mapa.slice(i, i + 400)]);
    await rp(cmds); return A.uso(req, u);
  },
  /* libera espacio: borra las imágenes SOLO de pedidos ya entregados hace tiempo (nunca de los que siguen en proceso) (los datos del pedido se quedan) */
  async depurar(req, u){
    if (u.rol !== "Administrador") throw Object.assign(new Error("Solo un administrador puede liberar espacio"), { code: 403 });
    const meses = Math.max(0, Math.min(60, +((req.body || {}).meses) || 0)), solo = !!(req.body || {}).simular;
    const limite = Date.now() - meses * 30.4 * 864e5, ventas = await todasLasVentas();
    const viejas = ventas.filter(v => v.estado === "entregado" && new Date(v.entregadoEl || ((v.historial || [])[0] || {}).fecha || v.fecha).getTime() < limite);
    const usadas = new Set(); ventas.filter(v => !viejas.includes(v)).forEach(v => rutasDe(v).forEach(r => usadas.add(r)));
    const quitar = new Set(); viejas.forEach(v => rutasDe(v.items).forEach(r => { if (!usadas.has(r)) quitar.add(r); }));
    const tam = quitar.size ? await r1("HMGET", "vt:img", ...quitar) : [], bytes = (tam || []).reduce((a, x) => a + (+x || 0), 0);
    if (solo) return { pedidos: viejas.filter(v => [...rutasDe(v.items)].some(r => quitar.has(r))).map(v => v.folio), imagenes: quitar.size, bytes };
    const cmds = [], marcas = [];
    for (const v of viejas){ let cambio = false;
      const limpia = x => { if (Array.isArray(x)) return x.map(limpia); if (x && typeof x === "object"){ for (const k of Object.keys(x)){ const y = x[k];
          if (typeof y === "string" && y.startsWith("/api/vt?a=img&p=")){ x[k] = ""; cambio = true; } else limpia(y); } } return x; };
      limpia(v.items); if (cambio){ v.imagenesDepuradas = new Date().toISOString(); cmds.push(["SET", "vt:v:" + v.folio, JSON.stringify(v)]); marcas.push("v:" + v.folio); } }
    if (cmds.length) await rp(cmds); await marcar(marcas);
    const liberado = await borrarImagenes([...quitar]);
    return { pedidos: marcas.length, imagenes: quitar.size, bytes: liberado };
  },

  /* respaldo completo (con contraseñas cifradas) */
  async respaldo(req, u){
    if (u.rol !== "Administrador") throw Object.assign(new Error("Solo un administrador puede descargar el respaldo"), { code: 403 });
    const d = await A.datos({ query: {} }); d.cols.usuarios = await usuarios(); return d;
  },

  /* --- clientes (app) --- */
  async imagen(req){
    if (!(await limite(req, "img", 150, 3600))) throw Object.assign(new Error("Demasiadas imágenes. Intenta más tarde."), { code: 429 });
    const { data, carpeta } = req.body || {};
    return { ref: await guardarImagen(data, carpeta || "app") };
  },

  async pedido(req){
    if (!(await limite(req, "pedido", 30, 3600))) throw Object.assign(new Error("Demasiados pedidos seguidos. Intenta más tarde."), { code: 429 });
    const { venta: v } = req.body || {};
    if (!v || !v.cliente || !telOk(v.cliente.tel) || !String(v.cliente.nombre || "").trim()) throw Object.assign(new Error("Faltan datos del pedido"), { code: 400 });
    const suc = /^[A-Z]{2,6}$/.test(v.sucursal || "") ? v.sucursal : "MAZ";
    const n = await r1("INCR", "vt:fol:" + suc), folio = suc + String(n).padStart(4, "0");
    v.folio = folio; v.sucursal = suc; v.pagos = []; v.estado = "cotizacion";
    await sacarImagenes(v, "pedidos");
    /* cliente: se busca por teléfono */
    const tel = v.cliente.tel, cid = await r1("HGET", "vt:tel", tel);
    let cli = cid ? J(await r1("GET", "vt:c:" + cid)) : null;
    if (!cli) cli = { id: "C" + Date.now(), nombre: v.cliente.nombre, tel, sucursal: suc, alta: v.fecha || new Date().toISOString(), logosPonchados: [], folios: [] };
    cli.nombre = v.cliente.nombre; cli.folios = [folio, ...(cli.folios || []).filter(f => f !== folio)];
    await rp([["SET", "vt:v:" + folio, JSON.stringify(v)], ["SADD", "vt:iv", folio], ["SET", "vt:c:" + cli.id, JSON.stringify(cli)], ["SADD", "vt:ic", cli.id], ["HSET", "vt:tel", tel, cli.id]]);
    await marcar(["v:" + folio, "c:" + cli.id]);
    return { venta: paraCliente(v) };
  },

  /* los pedidos de este celular: cada folio con su teléfono */
  async mis(req){
    const pares = ((req.body || {}).pares || []).filter(p => p && p.folio && telOk(p.tel)).slice(0, 40);
    const V = await mget(pares.map(p => "vt:v:" + String(p.folio).toUpperCase()));
    return { ventas: V.filter((v, i) => v && v.cliente && v.cliente.tel === pares[i].tel).map(paraCliente) };
  },

  /* buscar mis pedidos: siempre con el teléfono (y si quiere, folio o nombre) */
  async buscar(req){
    if (!(await limite(req, "buscar", 40, 3600))) throw Object.assign(new Error("Demasiadas búsquedas. Intenta más tarde."), { code: 429 });
    const { folio, tel, nombre } = req.body || {};
    if (!telOk(tel)) throw Object.assign(new Error("Escribe tu teléfono de 10 dígitos."), { code: 400 });
    const cid = await r1("HGET", "vt:tel", tel), cli = cid ? J(await r1("GET", "vt:c:" + cid)) : null;
    let ventas = cli ? (await mget((cli.folios || []).slice(0, 60).map(f => "vt:v:" + f))).filter(v => v && v.cliente.tel === tel) : [];
    if (folio) ventas = ventas.filter(v => v.folio === String(folio).toUpperCase().replace(/\s/g, ""));
    const pal = normal(nombre).split(" ").filter(w => w.length >= 2);
    if (pal.length) ventas = ventas.filter(v => pal.every(w => normal(v.cliente.nombre).split(" ").includes(w)));
    return { ventas: ventas.map(paraCliente) };
  },

  /* el cliente sube su comprobante: entra como "por validar" */
  async pago(req){
    if (!(await limite(req, "pago", 30, 3600))) throw Object.assign(new Error("Demasiados intentos. Intenta más tarde."), { code: 429 });
    const { folio, tel, pago } = req.body || {};
    const v = J(await r1("GET", "vt:v:" + String(folio || "")));
    if (!v || !v.cliente || v.cliente.tel !== tel) throw Object.assign(new Error("No encontramos ese pedido"), { code: 404 });
    const monto = Math.round(+((pago || {}).monto) * 100) / 100;
    if (!(monto > 0) || monto > 1e7) throw Object.assign(new Error("Monto inválido"), { code: 400 });
    let comp = (pago || {}).comprobante || null;   // { tipo:"img"|"pdf", src, nombre }
    if (comp && typeof comp === "object" && typeof comp.src === "string"){
      if (comp.src.startsWith("data:")) comp = { ...comp, src: await guardarImagen(comp.src, "comprobantes") };
      comp = comp.src.startsWith("/api/vt?a=img&p=") ? { tipo: comp.tipo === "pdf" ? "pdf" : "img", src: comp.src, nombre: String(comp.nombre || "").slice(0, 80) } : null;
    } else comp = null;
    const tipo = ["Anticipo", "Abono", "Liquidación"].includes(pago.tipo) ? pago.tipo : "Abono";
    v.pagos = v.pagos || [];
    v.pagos.push({ id: "P" + Date.now(), fecha: new Date().toISOString(), tipo, monto, forma: "Transferencia", estado: "por_validar", comprobante: comp, registro: pago.registro === "Mostrador" ? "Mostrador" : "Cliente (app)" });
    await r1("SET", "vt:v:" + v.folio, JSON.stringify(v)); await marcar(["v:" + v.folio]);
    return { venta: paraCliente(v) };
  },

  /* muestra una imagen guardada */
  async img(req, u, res){
    const p = String(req.query.p || "");
    if (!/^[\w-]+\/[\w.-]+$/.test(p)) { res.status(400).end(); return null; }
    const tipo = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" }[p.split(".").pop()] || "application/octet-stream";
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    if (process.env.VT_BLOB_DIR){
      const fs = await import("node:fs"), path = await import("node:path"); const f = path.join(process.env.VT_BLOB_DIR, p);
      if (!fs.existsSync(f)) { res.status(404).end(); return null; }
      res.setHeader("Content-Type", tipo); res.end(fs.readFileSync(f)); return null;
    }
    const { get } = await blob(), acceso = (await r1("GET", "vt:cfg:blob")) || "private";
    const r = await get(p, { access: acceso });
    if (!r || r.statusCode !== 200) { res.status(404).end(); return null; }
    res.setHeader("Content-Type", r.blob.contentType || tipo);
    const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
    res.end(buf); return null;
  }
};
const PUBLICAS = new Set(["estado", "login", "imagen", "pedido", "mis", "buscar", "pago", "img"]);

export default async function handler(req, res){
  const a = String((req.query && req.query.a) || "");
  try {
    if (!A[a]) return res.status(404).json({ error: "acción desconocida" });
    if (a !== "estado" && !HAY_DB) return res.status(503).json({ error: "La base de datos no está conectada" });
    if (req.method !== "GET" && typeof req.body === "string"){ try { req.body = JSON.parse(req.body); } catch(e){ req.body = {}; } }
    let u = null;
    if (!PUBLICAS.has(a)){ u = await sesion(req); if (!u) return res.status(401).json({ error: "Tu sesión terminó. Vuelve a entrar." }); }
    const out = await A[a](req, u, res);
    if (out !== null){ res.setHeader("Cache-Control", "no-store"); res.status(200).json(out); }
  } catch(e){
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    if (code === 500) console.error(a, e);
    if (!res.headersSent) res.status(code).json({ error: code === 500 ? "Error del servidor. Intenta de nuevo." : e.message });
  }
}
