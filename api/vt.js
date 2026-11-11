/* =====================================================================
   VITUMA · Base de datos (función de Vercel)
   - Datos (pedidos, clientes, pagos, gastos, usuarios): Upstash Redis
   - Imágenes (mockups, piezas, logos, comprobantes): Vercel Blob (privado)
   Todo entra por /api/vt?a=<acción>. Si Redis no está conectado, la app
   sigue en "modo muestra" (datos en el navegador).
   ===================================================================== */
import crypto from "node:crypto";

/* ---------- ENTORNO: producción o pruebas ----------
   - Producción = solo cuando Vercel dice VERCEL_ENV=production (la rama main). Usa las variables de siempre (KV_*, BLOB_READ_WRITE_TOKEN, OPENAI_API_KEY).
   - Cualquier otro caso (Preview de la rama desarrollo, local) = PRUEBAS: ignora por completo las variables de producción y usa SOLO
     las que empiezan con PRUEBAS_ (otra base Upstash y otro almacenamiento Blob). La IA queda apagada salvo PRUEBAS_IA=1.
   - CANDADO: en pruebas no se lee ni se escribe nada si la base no está marcada como "pruebas" (o vacía, y entonces se marca),
     si su dirección o su token coinciden con los de producción, o si faltan las variables PRUEBAS_. */
const ENTORNO = process.env.VERCEL_ENV === "production" ? "produccion" : "pruebas", PRUEBAS = ENTORNO === "pruebas";
const envDe = re => { const k = Object.keys(process.env).sort().find(n => re.test(n) && process.env[n]); return k ? process.env[k] : ""; };
const P_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "", P_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "", P_BLOB = process.env.BLOB_READ_WRITE_TOKEN || "";
const R_URL = PRUEBAS ? envDe(/^PRUEBAS_\w*REST_API_URL$/) : P_URL;
const R_TOK = PRUEBAS ? envDe(/^PRUEBAS_(?!\w*READ_ONLY)\w*REST_API_TOKEN$/) : P_TOK;
const BLOB_TOK = PRUEBAS ? envDe(/^PRUEBAS_\w*READ_WRITE_TOKEN$/) : P_BLOB;
const IA_KEY = PRUEBAS ? (process.env.PRUEBAS_IA === "1" ? process.env.PRUEBAS_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "" : "") : process.env.OPENAI_API_KEY || "";
const mismaBase = (a, b) => !!a && !!b && a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
let CANDADO = !PRUEBAS ? "" : !R_URL || !R_TOK ? "Faltan las variables PRUEBAS_ de la base de pruebas (Upstash)."
  : mismaBase(R_URL, P_URL) || (R_TOK && R_TOK === P_TOK) ? "La base de pruebas apunta a la base de PRODUCCIÓN." : "";
const BLOB_MAL = PRUEBAS && !!BLOB_TOK && !!P_BLOB && BLOB_TOK === P_BLOB;
const HAY_DB = !!(R_URL && R_TOK) && !CANDADO;
const HAY_BLOB = (!!BLOB_TOK && !BLOB_MAL) || !!process.env.VT_BLOB_DIR;
const BLOB_OP = BLOB_TOK && !BLOB_MAL ? { token: BLOB_TOK } : {};
/* marca de la base: la de pruebas lleva vt:entorno = "pruebas"; una base vacía se marca al primer uso; una base con datos y sin marca NO se toca */
let _marca = null;
async function revisarMarca(){
  if (_marca) return _marca;
  const [m, n] = await rp([["GET", "vt:entorno"], ["DBSIZE"]]);
  if (PRUEBAS){
    if (m === "pruebas") return (_marca = "ok");
    if (m == null && +n === 0){ await rp([["SET", "vt:entorno", "pruebas"], ["SET", "vt:entorno:desde", new Date().toISOString()]]); return (_marca = "ok"); }
    CANDADO = m ? `La base está marcada como "${m}", no como pruebas.` : "La base tiene datos y no está marcada como de pruebas: podría ser producción.";
    return (_marca = "candado");
  }
  if (m === "pruebas"){ CANDADO = "Producción está conectada a la base de PRUEBAS."; return (_marca = "candado"); }   // al revés también se protege
  return (_marca = "ok");
}
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
const blob = async () => _blob || (_blob = await import(process.env.VT_BLOB_FAKE || "@vercel/blob"));   // VT_BLOB_FAKE: solo para pruebas locales
/* ---------- CANDADO DE IMÁGENES (solo en pruebas) ----------
   La tienda Blob se identifica por el id que viene dentro de su token (vercel_blob_rw_<TIENDA>_<secreto>).
   En pruebas solo se usa la tienda si: no es la de producción (ni el mismo token ni la misma tienda), coincide con la registrada en la base de pruebas
   y lleva el archivo-marca _vituma/entorno-pruebas.json. Una tienda VACÍA se marca al primer uso; una con archivos y sin marca NO se toca. */
const BLOB_MARCA = "_vituma/entorno-pruebas.json";
const tiendaDe = t => { const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(t || ""); return m ? m[1] : ""; };
let _bmarca = null, BLOB_CANDADO = "";
async function revisarBlob(){
  if (!PRUEBAS || process.env.VT_BLOB_DIR) return "ok";
  if (_bmarca) return _bmarca;
  const no = m => { BLOB_CANDADO = m; return (_bmarca = "candado"); };
  if (!BLOB_TOK) return no("Falta la variable PRUEBAS_…READ_WRITE_TOKEN del almacenamiento de pruebas.");
  const t = tiendaDe(BLOB_TOK), tp = tiendaDe(P_BLOB);
  if (!t) return no("No se reconoce la tienda del token de pruebas.");
  if (BLOB_TOK === P_BLOB || (tp && t === tp)) return no("El almacenamiento de pruebas es la tienda de PRODUCCIÓN.");
  const reg = await r1("GET", "vt:entorno:tienda");
  if (reg && reg !== t) return no("La tienda conectada no es la registrada para pruebas.");
  const { head, list, put } = await blob(), op = { token: BLOB_TOK };
  let marca = false;
  try { await head(BLOB_MARCA, op); marca = true; } catch(e){ if (!/not.?found|404|does not exist/i.test(String(e && (e.name + " " + e.message)))) throw e; }
  if (!marca){
    const L = await list({ limit: 5, ...op });
    if ((L.blobs || []).length) return no("La tienda tiene archivos y no está marcada como de pruebas: podría ser producción.");
    const cuerpo = JSON.stringify({ entorno: "pruebas", tienda: t, desde: new Date().toISOString() });
    let acceso = (await r1("GET", "vt:cfg:blob")) || "private";
    try { await put(BLOB_MARCA, cuerpo, { access: acceso, contentType: "application/json", addRandomSuffix: false, ...op }); }
    catch(e){ if (acceso === "private" && /public|access/i.test(String(e && e.message))){ acceso = "public"; await r1("SET", "vt:cfg:blob", acceso); await put(BLOB_MARCA, cuerpo, { access: acceso, contentType: "application/json", addRandomSuffix: false, ...op }); } else throw e; }
  }
  if (!reg) await r1("SET", "vt:entorno:tienda", t);
  return (_bmarca = "ok");
}

/* =====================================================================
   ORIGINALES DE STUDIO (alta resolución): el navegador los sube DIRECTO a Vercel Blob con un permiso
   de un solo uso que da este servidor (ruta fija, tipo y tamaño exactos, vence en 1 hora). Después el servidor
   comprueba el archivo (que exista, tamaño, firma real del formato y medidas) y lo registra. Los SVG pasan por
   este servidor para limpiarlos. Nada de esto toca las demás imágenes de VITUMA.
   ===================================================================== */
const ORIG_MAX = +(process.env.VT_ORIG_MAX_MB || 60) * 1024 * 1024, SVG_MAX = 2 * 1024 * 1024;
const ORIG_TIPOS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const puedeStudio = u => u && (u.rol === "Administrador" || u.rol === "Encargado" || u.rol === "Diseño" || (u.permisos || []).includes("produccion"));
const errS = (m, c) => Object.assign(new Error(m), { code: c });
async function putCrudo(nombre, buf, tipo){
  if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"), f = path.join(process.env.VT_BLOB_DIR, nombre); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); return; }
  await blobOK(); const { put } = await blob(); let acceso = (await r1("GET", "vt:cfg:blob")) || "private";
  try { await put(nombre, buf, { access: acceso, contentType: tipo, addRandomSuffix: false, ...BLOB_OP }); }
  catch(e){ if (acceso === "private" && /public|access/i.test(String(e && e.message))){ acceso = "public"; await r1("SET", "vt:cfg:blob", acceso); await put(nombre, buf, { access: acceso, contentType: tipo, addRandomSuffix: false, ...BLOB_OP }); } else throw e; }
}
/* primeros bytes de un archivo guardado (para revisar su firma y sus medidas) y su tamaño */
async function inicioDe(nombre, n = 262144){
  if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"), f = path.join(process.env.VT_BLOB_DIR, nombre); if (!fs.existsSync(f)) return null; const b = fs.readFileSync(f); return { size: b.length, buf: b.subarray(0, n) }; }
  await blobOK(); const { get } = await blob(), acceso = (await r1("GET", "vt:cfg:blob")) || "private", r = await get(nombre, { access: acceso, ...BLOB_OP });
  if (!r || r.statusCode !== 200) return null;
  const rd = r.stream.getReader(), partes = []; let t = 0;
  while (t < n){ const { done, value } = await rd.read(); if (done) break; partes.push(Buffer.from(value)); t += value.length; }
  try { await rd.cancel(); } catch(e){}
  return { size: r.blob.size || null, buf: Buffer.concat(partes).subarray(0, n) };
}
/* firma real del formato y medidas en píxeles (no se confía en lo que diga el navegador) */
function medidasDe(b){
  if (!b || b.length < 16) return null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return { tipo: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xFF && b[1] === 0xD8){ let i = 2;
    while (i + 9 < b.length){ if (b[i] !== 0xFF){ i++; continue; } const m = b[i + 1], L = b.readUInt16BE(i + 2);
      if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return { tipo: "image/jpeg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + L; }
    return { tipo: "image/jpeg", w: 0, h: 0 }; }
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP"){ const c = b.toString("latin1", 12, 16);
    if (c === "VP8X") return { tipo: "image/webp", w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (c === "VP8 ") return { tipo: "image/webp", w: b.readUInt16LE(26) & 0x3FFF, h: b.readUInt16LE(28) & 0x3FFF };
    if (c === "VP8L"){ const v = b.readUInt32LE(21); return { tipo: "image/webp", w: (v & 0x3FFF) + 1, h: ((v >> 14) & 0x3FFF) + 1 }; } }
  return null;
}
/* ---------- limpieza de SVG: lista blanca de etiquetas y atributos; fuera scripts, eventos, ligas externas, DOCTYPE/ENTITY ---------- */
const SVG_TAGS = new Set("svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textpath title desc lineargradient radialgradient stop clippath mask pattern image filter fegaussianblur feoffset feblend fecolormatrix fecomposite feflood femerge femergenode femorphology fedropshadow".split(" "));
const SVG_ATTR = /^(id|class|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|d|points|width|height|viewbox|preserveaspectratio|transform|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-miterlimit|stroke-dasharray|stroke-dashoffset|opacity|offset|stop-color|stop-opacity|gradientunits|gradienttransform|spreadmethod|fx|fy|clip-path|clip-rule|mask|patternunits|patterncontentunits|patterntransform|font-family|font-size|font-weight|font-style|text-anchor|dominant-baseline|letter-spacing|dx|dy|rotate|textlength|lengthadjust|xmlns|xmlns:xlink|version|href|xlink:href|filter|stddeviation|in|in2|result|mode|values|type|operator|k1|k2|k3|k4|radius|flood-color|flood-opacity|color|display|visibility|vector-effect|shape-rendering|style|maskunits|maskcontentunits|clippathunits|filterunits|primitiveunits|xml:space)$/;
function limpiarSVG(txt){
  const quitado = new Set(); let t = String(txt || "");
  if (Buffer.byteLength(t) > SVG_MAX) throw errS("El SVG pesa más de 2 MB.", 400);
  t = t.replace(/^﻿/, "").replace(/<\?xml[\s\S]*?\?>/gi, "");
  if (/<!DOCTYPE|<!ENTITY/i.test(t)){ quitado.add("DOCTYPE/ENTITY"); t = t.replace(/<!DOCTYPE[\s\S]*?(\[[\s\S]*?\])?\s*>/gi, ""); }
  const fuera = v => /(javascript|vbscript|data:(?!image\/(png|jpe?g|webp|gif);base64,))\s*:?/i.test(v) || /url\(\s*['"]?\s*(?!#)/i.test(v) || /expression\s*\(|@import|behavior\s*:/i.test(v);
  const out = []; let salto = 0, n = 0, raiz = false;
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][\w:.-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|<[^>]*>|[^<]+/g;
  let m;
  while ((m = re.exec(t))){
    const s0 = m[0];
    if (s0.startsWith("<!--")) continue;
    if (s0.startsWith("<![CDATA[")){ quitado.add("CDATA"); continue; }
    if (!m[1]){ if (s0.startsWith("<")){ quitado.add("etiqueta inválida"); continue; } if (!salto) out.push(s0.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;")); continue; }
    const tag = m[1].toLowerCase().replace(/^svg:/, ""), cierre = s0.startsWith("</"), vacia = m[3] === "/";
    if (++n > 20000) throw errS("El SVG es demasiado complejo.", 400);
    if (salto){ if (!vacia && !SVG_TAGS.has(tag)){ salto += cierre ? -1 : 1; } continue; }
    if (!SVG_TAGS.has(tag)){ quitado.add("<" + tag + ">"); if (!cierre && !vacia) salto = 1; continue; }
    if (cierre){ out.push(`</${tag}>`); continue; }
    if (tag === "svg") raiz = true;
    const attrs = []; const ra = /([^\s=>\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g; let a;
    while ((a = ra.exec(m[2] || ""))){
      const nom = a[1].toLowerCase(), val = a[3] != null ? a[3] : a[4] != null ? a[4] : a[5] != null ? a[5] : "";
      if (/^on/.test(nom)){ quitado.add("eventos (on…)"); continue; }
      if (!SVG_ATTR.test(nom)){ quitado.add("atributo " + nom); continue; }
      if (nom === "href" || nom === "xlink:href"){ const ok = val.startsWith("#") || (tag === "image" && /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+\/=\s]+$/i.test(val)); if (!ok){ quitado.add("liga externa"); continue; } }
      else if (fuera(val)){ quitado.add("contenido ejecutable o externo"); continue; }
      attrs.push(`${nom}="${val.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`);
    }
    out.push(`<${tag}${attrs.length ? " " + attrs.join(" ") : ""}${vacia ? "/" : ""}>`);
  }
  if (!raiz) throw errS("El archivo no es un SVG válido.", 400);
  let limpio = out.join("");
  if (!/^\s*<svg[\s>]/i.test(limpio)) limpio = limpio.slice(limpio.search(/<svg[\s>]/i));
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(limpio)) limpio = limpio.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  /* medidas: width/height o viewBox */
  const tagS = (limpio.match(/<svg[^>]*>/i) || [""])[0], num = n2 => { const x = (tagS.match(new RegExp(`\\s${n2}="([\\d.]+)(px)?"`)) || [])[1]; return x ? +x : 0; };
  const vb = (tagS.match(/viewbox="([^"]+)"/i) || [])[1], vbn = vb ? vb.trim().split(/[\s,]+/).map(Number) : null;
  let w = num("width"), h = num("height"); if ((!w || !h) && vbn && vbn.length === 4){ w = w || vbn[2]; h = h || vbn[3]; }
  if (!w || !h) throw errS("El SVG no tiene medidas (width/height o viewBox).", 400);
  if (!num("width") || !num("height")) limpio = limpio.replace(/<svg/i, `<svg width="${w}" height="${h}"`);
  return { svg: limpio, w: Math.round(w), h: Math.round(h), quitado: [...quitado] };
}
async function blobOK(){ if ((await revisarBlob()) !== "ok") throw Object.assign(new Error("🔒 Candado de imágenes: " + BLOB_CANDADO), { code: 503 }); }
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
  if (!HAY_BLOB) throw Object.assign(new Error(PRUEBAS ? "Imágenes desactivadas en pruebas (falta la variable PRUEBAS_…READ_WRITE_TOKEN o es la de producción)." : "Falta el almacenamiento de imágenes"), { code: 503 });
  await blobOK();
  const { put } = await blob();
  let acceso = (await r1("GET", "vt:cfg:blob")) || "private";
  try { await put(nombre, buf, { access: acceso, contentType: tipo, addRandomSuffix: false, ...BLOB_OP }); }
  catch(e){   // la tienda se creó pública: se usa así
    if (acceso === "private" && /public|access/i.test(String(e && e.message))){ acceso = "public"; await r1("SET", "vt:cfg:blob", acceso); await put(nombre, buf, { access: acceso, contentType: tipo, addRandomSuffix: false, ...BLOB_OP }); }
    else throw e;
  }
  return "/api/vt?a=img&p=" + encodeURIComponent(nombre);
}
/* lee una imagen guardada (para mandarla a la IA) */
async function leerImagen(ref){
  const m = /[?&]p=([^&]+)/.exec(String(ref || "")); if (!m) throw Object.assign(new Error("Imagen no encontrada"), { code: 400 });
  const p = decodeURIComponent(m[1]); if (!/^[\w-]+\/[\w.-]+$/.test(p)) throw Object.assign(new Error("Imagen no válida"), { code: 400 });
  const tipo = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[p.split(".").pop()] || "image/png";
  if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"); if (!fs.existsSync(path.join(process.env.VT_BLOB_DIR, p))) await restaurarSiSeUsa(null, p, "Se usó en la IA y algún registro lo usa"); return { buf: fs.readFileSync(path.join(process.env.VT_BLOB_DIR, p)), tipo }; }
  await blobOK();
  const { get } = await blob(), acceso = (await r1("GET", "vt:cfg:blob")) || "private"; let r = await get(p, { access: acceso, ...BLOB_OP });
  if ((!r || r.statusCode !== 200) && await restaurarSiSeUsa(null, p, "Se usó en la IA y algún registro lo usa")) r = await get(p, { access: acceso, ...BLOB_OP });
  if (!r || r.statusCode !== 200) throw Object.assign(new Error("Imagen no encontrada"), { code: 404 });
  return { buf: Buffer.from(await new Response(r.stream).arrayBuffer()), tipo: r.blob.contentType || tipo };
}

/* ---------- IA de OpenAI (solo para el panel: Diseño / Producción) ---------- */
const OAI = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const puedeIA = u => u && (u.rol === "Administrador" || u.rol === "Encargado" || u.rol === "Diseño" || (u.permisos || []).includes("produccion"));
async function oai(ruta, cuerpo, json = true){
  if (!IA_KEY) throw Object.assign(new Error(PRUEBAS ? "La IA está apagada en el entorno de pruebas." : "La IA no está conectada (falta OPENAI_API_KEY en Vercel)."), { code: 503 });
  const r = await fetch(OAI + ruta, { method: "POST", headers: { Authorization: "Bearer " + IA_KEY, ...(json ? { "Content-Type": "application/json" } : {}) }, body: json ? JSON.stringify(cuerpo) : cuerpo });
  const d = await r.json().catch(() => ({}));
  if (!r.ok){ const m = (d.error && d.error.message) || ("OpenAI " + r.status);
    const txt = /verif/i.test(m) ? "OpenAI pide verificar la organización para generar imágenes (Settings → Organization → Verify)." : /quota|billing|credit|balance/i.test(m) ? "Se acabó el saldo de OpenAI o se llegó al tope de gasto." : /rate/i.test(m) ? "La IA está saturada. Espera un minuto e intenta de nuevo." : "La IA respondió: " + m;
    throw Object.assign(new Error(txt), { code: r.status === 401 ? 503 : 502 }); }
  return d;
}
async function contarIA(campo, n = 1){ try { await rp([["HINCRBY", "vt:ia:" + new Date().toISOString().slice(0, 7), campo, n]]); } catch(e){} }

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
  else { await blobOK(); const { del } = await blob(); for (let i = 0; i < rutas.length; i += 100) await del(rutas.slice(i, i + 100), BLOB_OP); }
  await rp([["HDEL", "vt:img", ...rutas], ["DECRBY", "vt:uso:bytes", total], ["HDEL", "vt:limp:espera", ...rutas], ...rutas.map(r => ["DEL", "vt:orig:" + r])]);
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

/* ---------- LIMPIEZA DE ARCHIVOS HUÉRFANOS ----------
   simular → lista de espera (7 días) → papelera (30 días, se recupera sola si algo la vuelve a usar) → eliminación definitiva.
   Cada paso pide confirmación del administrador y vuelve a revisar TODO. Si falla cualquier lectura, se detiene sin clasificar. */
const LIMP_K = "vt:limp:espera", LIMP_PAP = "vt:limp:papelera", LIMP_LOG = "vt:limp:registro";
/* plazos cortos SOLO en Preview: requiere PRUEBAS_LIMPIEZA_RAPIDA=1 y el servidor lo ignora siempre en Production */
const LIMP_RAPIDA = PRUEBAS && process.env.VERCEL_ENV !== "production" && process.env.PRUEBAS_LIMPIEZA_RAPIDA === "1";
const PLAZO = LIMP_RAPIDA ? { gracia: 2 * 60e3, espera: 5 * 60e3, papelera: 10 * 60e3, texto: "2 minutos / 5 minutos / 10 minutos (PLAZOS CORTOS DE PRUEBA)" }
                          : { gracia: 24 * 3600e3, espera: 7 * 86400e3, papelera: 30 * 86400e3, texto: "24 horas / 7 días / 30 días" };
const LIMP_TIPO = { panel: "Imagen del panel (vista previa, mockup o lámina)", pedidos: "Imagen enviada por el cliente", clientes: "Imagen de la ficha de un cliente", datos: "Imagen de catálogos o configuración", app: "Imagen subida por la app", img: "Imagen subida por la app", ia: "Imagen generada por IA" };
/* solo nombres que la app genera; la parte aleatoria (16 o 18 hex) es la huella del archivo. Lo demás se protege. */
const LIMP_NOMBRE = /^(?:originales\/[\w-]{1,20}-[0-9a-z]{6,12}-([0-9a-f]{16})\.(?:png|jpg|webp|svg)|(?:panel|pedidos|clientes|datos|app|img|ia)\/[0-9a-z]{6,12}-([0-9a-f]{18})\.(?:png|jpg|webp|gif))$/;
const huellaDe = p => { const m = LIMP_NOMBRE.exec(String(p)); return m ? (m[1] || m[2]).toLowerCase() : null; };
/* una referencia en CUALQUIER forma (liga normal, %2F o %2f, doble codificación, URL directa, texto dentro de versiones…) contiene "-<huella>" */
const LIMP_HUELLA = /-([0-9a-f]{18}|[0-9a-f]{16})(?![0-9a-f])/gi;
const huellasDe = t => new Set([...String(t).matchAll(LIMP_HUELLA)].map(m => m[1].toLowerCase()));
const rutaPapelera = p => "papelera/" + p.replace("/", "__");
const detener = m => errS("Se detuvo sin borrar ni clasificar nada: " + m, 503);
async function scanTodo(pat){ const out = new Set(); let c = "0", vueltas = 0;
  do { const r = await r1("SCAN", c, "MATCH", pat, "COUNT", 1000); if (!Array.isArray(r) || !Array.isArray(r[1])) throw detener("la base no respondió al buscar " + pat);
    r[1].forEach(k => out.add(k)); c = String(r[0]); if (++vueltas > 100000) throw detener("búsqueda interminable"); } while (c !== "0");
  return out; }
async function listarArchivos(){
  const out = [];
  if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"), raiz = process.env.VT_BLOB_DIR;
    const rec = d => { for (const f of fs.readdirSync(path.join(raiz, d), { withFileTypes: true })){ const r = d ? d + "/" + f.name : f.name; if (f.isDirectory()) rec(r); else { const st = fs.statSync(path.join(raiz, r)); out.push({ pathname: r, size: st.size, uploadedAt: st.mtime }); } } };
    if (fs.existsSync(raiz)) rec(""); return out; }
  await blobOK(); const { list } = await blob(); let cursor;
  try { do { const r = await list({ cursor, limit: 1000, ...BLOB_OP }); if (!r || !Array.isArray(r.blobs)) throw new Error("respuesta incompleta"); out.push(...r.blobs);
      if (r.hasMore && !r.cursor) throw new Error("listado incompleto"); cursor = r.hasMore ? r.cursor : null; } while (cursor); }
  catch(e){ throw detener("no se pudo leer completo el almacenamiento (" + (e.message || e) + ")"); }
  return out;
}
/* lee TODO lo que puede tener una referencia: todos los pedidos (también cancelados), clientes y colecciones (configuración, catálogos, usuarios…).
   Devuelve huella → conjunto de "dónde se usa". En los pedidos se separa el DISEÑO (items) del resto (pagos, cliente…) para la opción de cancelados. */
async function mapaDeReferencias(){
  const [iv, ic, ik] = await rp([["SMEMBERS", "vt:iv"], ["SMEMBERS", "vt:ic"], ["SMEMBERS", "vt:ik"]]);
  if (!Array.isArray(iv) || !Array.isArray(ic) || !Array.isArray(ik)) throw detener("no se pudo leer el índice de pedidos, clientes o configuración");
  const llaves = new Set([...await scanTodo("vt:v:*"), ...await scanTodo("vt:c:*"), ...await scanTodo("vt:col:*")]), obligatorias = new Set([...iv.map(f => "vt:v:" + f), ...ic.map(c => "vt:c:" + c), ...ik.map(k => "vt:col:" + k)]);
  obligatorias.forEach(k => llaves.add(k));
  const L = [...llaves], usos = new Map(), ventas = new Map(); let leidos = 0;
  const anota = (t, donde) => { for (const h of huellasDe(t)){ let s = usos.get(h); if (!s) usos.set(h, s = new Set()); s.add(donde); } };
  for (let i = 0; i < L.length; i += 200){ const parte = L.slice(i, i + 200), vals = await r1("MGET", ...parte);
    if (!Array.isArray(vals) || vals.length !== parte.length) throw detener("la base no devolvió todos los registros");
    vals.forEach((t, j) => { const k = parte[j];
      if (t == null){ if (obligatorias.has(k)) throw detener("falta el registro " + k + " que sí está en el índice"); return; }
      if (typeof t !== "string") throw detener("registro ilegible " + k);
      let o; try { o = JSON.parse(t); } catch(e){ throw detener("registro dañado " + k); }
      leidos++;
      if (k.startsWith("vt:v:")){ const f = k.slice(5); ventas.set(f, o); anota(JSON.stringify(o && o.items), "dis:" + f); anota(JSON.stringify({ ...(o || {}), items: null }), "Pedido " + f); }
      else anota(t, k.startsWith("vt:c:") ? "Cliente" : "Configuración (" + k.slice(7) + ")"); }); }
  if (iv.some(f => !ventas.has(f))) throw detener("no se leyeron todos los pedidos del índice");
  return { usos, ventas, registros: leidos };
}
const textoUso = s => [...s].map(x => x.startsWith("dis:") ? "Pedido " + x.slice(4) : x).filter((x, i, a) => a.indexOf(x) === i);
async function scanSubidas(){ return new Set([...await scanTodo("vt:subida:*")].map(k => k.slice(10))); }
/* estado de cada archivo; NO escribe nada */
async function estadoLimpieza(){
  const ahora = Date.now(), archivos = await listarArchivos(), ref = await mapaDeReferencias(), [esp, pap] = await rp([["HGETALL", LIMP_K], ["HGETALL", LIMP_PAP]]), pend = await scanSubidas();
  if (!Array.isArray(esp) || !Array.isArray(pap)) throw detener("no se pudo leer la lista de espera o la papelera");
  const aMapa = a => { const m = new Map(); for (let i = 0; i < a.length; i += 2) m.set(a[i], J(a[i + 1]) || {}); return m; }, espera = aMapa(esp), papel = aMapa(pap);
  const existe = new Set(archivos.map(a => a.pathname)), origs = archivos.map(a => a.pathname.startsWith("papelera/") ? a.pathname.slice(9).replace("__", "/") : a.pathname).filter(p => p.startsWith("originales/")), regs = new Map();
  for (let i = 0; i < origs.length; i += 200){ const v = await r1("MGET", ...origs.slice(i, i + 200).map(p => "vt:orig:" + p)); if (!Array.isArray(v)) throw detener("no se pudieron leer los registros de originales"); v.forEach((x, j) => { if (x) regs.set(origs[i + j], J(x)); }); }
  const tipoDe = p => { const c = p.split("/")[0], reg = regs.get(p);
    return c === "originales" ? (reg ? (reg.clase === "edicion" ? "Edición de STUDIO" : reg.clase === "original" ? "Original de STUDIO" : "Original o edición de STUDIO") + (reg.folio ? " · " + reg.folio : "") : "Original sin registrar (subida interrumpida)")
      : c === "_vituma" ? "Marca del entorno" : c === "comprobantes" ? "Comprobante de pago" : LIMP_TIPO[c] || "Desconocido"; };
  const filas = archivos.map(a => {
    const p = a.pathname, fecha = a.uploadedAt ? new Date(a.uploadedAt).toISOString() : null, edad = fecha ? ahora - Date.parse(fecha) : 0;
    if (p.startsWith("papelera/")){ const o = p.slice(9).replace("__", "/"), e = papel.get(o), h = huellaDe(o), f = { ruta: o, enPapelera: p, tipo: tipoDe(o), bytes: a.size, fecha: e && e.subido || fecha };
      if (!e) return { ...f, estado: "protegido", motivo: "Está en la papelera pero sin registro: se conserva" };
      if (existe.has(o)) return { ...f, estado: "protegido", motivo: "Copia de seguridad: el archivo original todavía existe" };
      const us = h && ref.usos.get(h); if (us) return { ...f, estado: "rescatar", usadoEn: textoUso(us), motivo: "Se volvió a usar: se recupera al abrirlo o al actualizar" };
      const prog = e.desde + PLAZO.papelera; return { ...f, estado: prog <= ahora ? "eliminable" : "papelera", motivo: e.motivo || "", enPapeleraDesde: new Date(e.desde).toISOString(), programado: new Date(prog).toISOString() }; }
    const carpeta = p.split("/")[0], h = huellaDe(p), f = { ruta: p, tipo: tipoDe(p), bytes: a.size, fecha }, e = espera.get(p);
    if (carpeta === "_vituma") return { ...f, estado: "protegido", motivo: "Archivo del sistema (_vituma)" };
    if (carpeta === "comprobantes") return { ...f, estado: "protegido", motivo: "Los comprobantes de pago siempre se conservan" };
    if (!h) return { ...f, estado: "protegido", motivo: "No se reconoce su procedencia (carpeta o nombre no generados por la app)" };
    if (pend.has(p)) return { ...f, estado: "protegido", motivo: "Subida en curso" };
    const us = ref.usos.get(h); if (us) return { ...f, estado: e ? "recuperado" : "en_uso", usadoEn: textoUso(us), motivo: e ? "Volvió a usarse: sale de la lista de espera" : "En uso" };
    if (!fecha) return { ...f, estado: "protegido", motivo: "Sin fecha de subida" };
    if (!e && edad < PLAZO.gracia) return { ...f, estado: "reciente", motivo: "Todavía dentro del periodo de protección", programado: new Date(Date.parse(fecha) + PLAZO.gracia + PLAZO.espera).toISOString() };
    const motivo = carpeta === "originales" && !regs.get(p) ? "La subida nunca se registró y ningún registro lo usa" : "Ningún pedido, cliente, configuración ni versión de STUDIO lo usa";
    if (!e) return { ...f, estado: "huerfano", motivo, programado: new Date(ahora + PLAZO.espera).toISOString() };
    const prog = Math.max(e.desde + PLAZO.espera, Date.parse(fecha) + PLAZO.gracia);
    return { ...f, estado: prog <= ahora ? "listo" : "espera", motivo: e.motivo || motivo, enEsperaDesde: new Date(e.desde).toISOString(), programado: new Date(prog).toISOString() };
  });
  const faltanEnEspera = [...espera.keys()].filter(p => !existe.has(p)), faltanEnPapelera = [...papel.keys()].filter(p => !existe.has(rutaPapelera(p)) && !existe.has(p));
  const resumen = {}; for (const x of filas){ const r = resumen[x.estado] = resumen[x.estado] || { archivos: 0, bytes: 0 }; r.archivos++; r.bytes += x.bytes || 0; }
  return { filas, resumen, registros: ref.registros, faltanEnEspera, faltanEnPapelera, generado: new Date(ahora).toISOString(), plazos: PLAZO.texto, rapida: LIMP_RAPIDA, _ref: ref };
}
/* mueve un archivo dentro del almacenamiento (copia, comprueba la copia y después borra el de origen) */
async function moverArchivo(desde, hacia){
  if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"), a = path.join(process.env.VT_BLOB_DIR, desde), b = path.join(process.env.VT_BLOB_DIR, hacia);
    fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); if (fs.statSync(a).size !== fs.statSync(b).size) throw new Error("la copia no coincide"); fs.unlinkSync(a); return fs.statSync(b).size; }
  await blobOK(); const { get, put, head, del } = await blob(), acceso = (await r1("GET", "vt:cfg:blob")) || "private";
  const r = await get(desde, { access: acceso, ...BLOB_OP }); if (!r || r.statusCode !== 200) throw new Error("no existe " + desde);
  const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
  await put(hacia, buf, { access: acceso, contentType: r.blob.contentType || "application/octet-stream", addRandomSuffix: false, allowOverwrite: true, ...BLOB_OP });
  const h = await head(hacia, BLOB_OP); if (!h || +h.size !== buf.length) throw new Error("la copia no coincide");
  await del([desde], BLOB_OP); return buf.length;
}
const limpLog = o => rp([["LPUSH", LIMP_LOG, JSON.stringify({ fecha: new Date().toISOString(), ...o })], ["LTRIM", LIMP_LOG, 0, 4999]]);
/* saca un archivo de la papelera y lo regresa a su lugar (con candado para que no se haga dos veces a la vez) */
async function restaurar(p, quien, motivo){
  const e = J(await r1("HGET", LIMP_PAP, p)); if (!e) return false;
  if ((await r1("SET", "vt:limp:rest:" + p, "1", "NX", "EX", 120)) !== "OK") return false;
  try { const b = await moverArchivo(rutaPapelera(p), p);
    await rp([["HDEL", LIMP_PAP, p], ["HDEL", "vt:img", rutaPapelera(p)], ["HSET", "vt:img", p, b], ["HDEL", LIMP_K, p]]);
    await limpLog({ por: quien || "sistema", accion: "recuperado", ruta: p, bytes: b, motivo: motivo || "" }); return true; }
  finally { await r1("DEL", "vt:limp:rest:" + p).catch(() => {}); }
}
/* al ABRIR una liga de un archivo que está en la papelera: solo se recupera si algún pedido, cliente, configuración o versión de STUDIO
   lo usa (revisión completa). Si nadie lo usa, NO se recupera y la liga responde 404. Con límite de intentos por equipo. */
async function restaurarSiSeUsa(req, p, motivo){
  try {
    if (!(await r1("HEXISTS", LIMP_PAP, p))) return false;
    if (req && !(await limite(req, "imgpap", 30, 3600))) return false;
    const h = huellaDe(p); if (!h) return false;
    const ref = await mapaDeReferencias(); if (!ref.usos.has(h)) return false;
    return await restaurar(p, "sistema", motivo);
  } catch(e){ console.error("restaurarSiSeUsa", e); return false; }
}
/* cada vez que se GUARDA algo (panel, pedido, pago): si usa archivos en espera, salen de la lista; si usa archivos en la papelera, se recuperan */
async function rescatar(obj, quien){
  try { const [ne, np] = await rp([["HLEN", LIMP_K], ["HLEN", LIMP_PAP]]); if (!ne && !np) return;
    const hs = huellasDe(JSON.stringify(obj || {})); if (!hs.size) return;
    if (ne){ const q = (await r1("HKEYS", LIMP_K) || []).filter(p => hs.has(huellaDe(p))); if (q.length){ await r1("HDEL", LIMP_K, ...q); await limpLog({ por: quien || "sistema", accion: "salen_espera", rutas: q, motivo: "Se volvieron a usar al guardar" }); } }
    if (np) for (const p of (await r1("HKEYS", LIMP_PAP) || []).filter(p => hs.has(huellaDe(p)))) await restaurar(p, quien, "Se volvió a usar al guardar");
  } catch(e){ console.error("rescatar", e); }
}

/* ---------- utilidades ---------- */
const ip = req => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "x").split(",")[0].trim();
async function limite(req, clave, max, seg){
  const k = `vt:rl:${clave}:${ip(req)}`, [n] = await rp([["INCR", k], ["EXPIRE", k, seg, "NX"]]);
  return n <= max;
}
const sha = t => crypto.createHash("sha256").update("vituma::" + t).digest("hex");
/* contraseñas nuevas: scrypt con sal (el navegador manda su huella SHA-256; aquí se vuelve a proteger). Las cuentas anteriores siguen funcionando igual. */
const passSegura = h => { const sal = crypto.randomBytes(16).toString("hex"); return "scrypt$" + sal + "$" + crypto.scryptSync(String(h), sal, 32, { N: 16384, r: 8, p: 1 }).toString("hex"); };
function passOk(guardada, h){
  const g = String(guardada || ""), x = String(h || "");
  if (g.startsWith("scrypt$")){ const [, sal, dig] = g.split("$"), b = crypto.scryptSync(x, sal, 32, { N: 16384, r: 8, p: 1 }), a = Buffer.from(dig, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); }
  const a = Buffer.from(g), b = Buffer.from(x); return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* debe cambiar la contraseña: la cuenta inicial (marcada al crearse) y, en PRUEBAS, cualquier cuenta que siga con la contraseña de fábrica */
const debeCambiar = u => !!u && (!!u.debeCambiar || (PRUEBAS && passOk(u.pass, sha("vituma"))));
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

/* misma regla que en comun.js (VT.autorizarVenta): autoriza → la orden pasa a producción; cambios → regresa a diseño */
function autorizarVenta(v, ok, comentario){
  const ahora = new Date().toISOString(), A = v.autorizacion;
  A.estado = ok ? "autorizado" : "cambios"; A.respuesta = ahora; A.comentario = ok ? "" : comentario;
  (A.rondas = A.rondas || []).push({ enviado: A.enviado, respuesta: ahora, ok, comentario: ok ? "" : comentario });
  const orden = ["diseno","autorizacion","produccion","listo","entregado"], AV = { "En diseño":"diseno", "Esperando autorización":"autorizacion", "En producción":"produccion", "En tienda para entregar":"listo", "Entregado":"entregado" };
  for (const ot of ((v.produccion || {}).ots || [])){
    if (ot.estado !== "Esperando autorización") continue;
    ot.estado = ok ? "En producción" : "En diseño";
    (ot.updates = ot.updates || []).push({ fecha: ahora, usuario: "Cliente (app)", texto: ok ? "✅ El cliente autorizó su diseño desde la app." : "✏️ El cliente pidió cambios desde la app:\n" + comentario });
  }
  if (v.produccion && v.estado !== "cancelada"){ const ests = v.produccion.ots.map(o => AV[o.estado] || "diseno"); v.estado = ests.reduce((a, b) => orden.indexOf(b) < orden.indexOf(a) ? b : a, "entregado"); }
  (v.historial = v.historial || []).unshift({ fecha: ahora, usuario: "Cliente (app)", accion: ok ? "Diseño autorizado por el cliente" : "El cliente pidió cambios al diseño", detalle: ok ? "" : comentario });
  return v;
}

/* ---------- acciones ---------- */
const A = {
  async estado(){
    if (HAY_DB){ try { await revisarMarca(); } catch(e){ return { db: false, imagenes: false, ia: false, entorno: ENTORNO, candado: "No se pudo revisar la base: " + e.message, version: 1 }; } }
    const ok = HAY_DB && !CANDADO;
    let img = ok && HAY_BLOB, cimg = BLOB_MAL ? "El almacenamiento de imágenes de pruebas es el de PRODUCCIÓN: imágenes desactivadas." : "";
    if (ok && PRUEBAS && !process.env.VT_BLOB_DIR){ try { if ((await revisarBlob()) !== "ok"){ img = false; cimg = BLOB_CANDADO; } } catch(e){ img = false; cimg = "No se pudo revisar el almacenamiento de pruebas: " + e.message; } }
    return { db: ok, imagenes: img, ia: ok && !!IA_KEY, entorno: ENTORNO, candado: CANDADO || cimg, candadoImagenes: cimg, version: 1, ...(LIMP_RAPIDA ? { limpiezaRapida: true } : {}) };
  },

  /* --- panel --- */
  async login(req){
    if (!(await limite(req, "login", 20, 900))) throw Object.assign(new Error("Demasiados intentos. Espera unos minutos."), { code: 429 });
    const { usuario, pass } = req.body || {};
    let us = await usuarios();
    if (!us.length){   // primera vez: se crea el administrador (usuario admin, contraseña vituma; cámbiala al entrar)
      us = [{ id: "U1", nombre: "Administrador", usuario: "admin", rol: "Administrador", sucursal: "", permisos: [], activo: true, pass: sha("vituma"), debeCambiar: true, alta: new Date().toISOString() }];
      await r1("SET", "vt:col:usuarios", JSON.stringify(us)); await r1("SADD", "vt:ik", "usuarios"); await marcar(["k:usuarios"]);
    }
    const u = us.find(x => x.usuario === String(usuario || "").trim().toLowerCase());
    if (!u || !u.activo || !passOk(u.pass, pass)) throw Object.assign(new Error("Usuario o contraseña incorrectos."), { code: 401 });
    const tok = crypto.randomBytes(24).toString("hex");
    u.ultimo = new Date().toISOString();
    await rp([["SET", "vt:ses:" + tok, u.id, "EX", SES_HORAS * 3600], ["SET", "vt:col:usuarios", JSON.stringify(us)]]);
    return { token: tok, usuario: { ...sinPass(u), debeCambiar: debeCambiar(u) } };
  },
  /* cambio de contraseña (obligatorio en el primer ingreso). La nueva llega una sola vez por HTTPS para poder revisar su largo; se guarda con scrypt. */
  async cambiar_pass(req, u){
    if (!(await limite(req, "cpass", 10, 900))) throw Object.assign(new Error("Demasiados intentos. Espera unos minutos."), { code: 429 });
    const { actual, nueva } = req.body || {}, n = String(nueva || "");
    const us = await usuarios(), yo = us.find(x => x.id === u.id); if (!yo) throw Object.assign(new Error("Usuario no encontrado"), { code: 404 });
    if (!passOk(yo.pass, actual)) throw Object.assign(new Error("La contraseña actual no es correcta."), { code: 401 });
    if (n.length < 8) throw Object.assign(new Error("La contraseña nueva debe tener al menos 8 caracteres."), { code: 400 });
    if (/^vituma$/i.test(n) || n.toLowerCase().includes(yo.usuario.toLowerCase()) || passOk(yo.pass, sha(n))) throw Object.assign(new Error("Elige una contraseña distinta: no puede ser la anterior, «vituma» ni contener tu usuario."), { code: 400 });
    yo.pass = passSegura(sha(n)); yo.debeCambiar = false; yo.passCambio = new Date().toISOString();
    await r1("SET", "vt:col:usuarios", JSON.stringify(us)); await marcar(["k:usuarios"]);
    return { ok: true, usuario: { ...sinPass(yo), debeCambiar: false } };
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
        const antes = await usuarios(); x = x.map(u => { const a = antes.find(y => y.id === u.id), { debeCambiar: _ign, ...v } = u;
          const nuevaPass = v.pass && (!a || v.pass !== a.pass) && !String(v.pass).startsWith("scrypt$");
          return v.pass ? { ...v, pass: nuevaPass ? passSegura(v.pass) : v.pass, ...(a && a.debeCambiar ? { debeCambiar: true } : {}) }
            : { ...v, pass: a ? a.pass : sha("vituma"), ...(a ? (a.debeCambiar ? { debeCambiar: true } : {}) : { debeCambiar: true }) }; });
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
    await blobOK(); const { list } = await blob(); let cursor, total = 0; const mapa = [];
    do { const r = await list({ cursor, limit: 1000, ...BLOB_OP }); for (const x of r.blobs){ total += x.size; mapa.push(x.pathname, x.size); } cursor = r.hasMore ? r.cursor : null; } while (cursor);
    const cmds = [["DEL", "vt:img"], ["SET", "vt:uso:bytes", total], ["SET", "vt:uso:recalc", new Date().toISOString()]];
    for (let i = 0; i < mapa.length; i += 400) cmds.push(["HSET", "vt:img", ...mapa.slice(i, i + 400)]);
    await rp(cmds); return A.uso(req, u);
  },
  /* libera espacio: borra las imágenes SOLO de pedidos ya entregados hace tiempo (nunca de los que siguen en proceso) (los datos del pedido se quedan) */
  async depurar(req, u){
    await blobOK();
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
  /* existencias de lo que se maneja en inventario (sin costos) */
  async existencias(){ const d = J(await r1("GET", "vt:col:provInv")) || {}; return { prods: d.prods || [], stock: d.stock || {} }; },
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
  /* el cliente autoriza su diseño o pide cambios desde la app */
  async autorizar(req){
    if (!(await limite(req, "autorizar", 30, 3600))) throw Object.assign(new Error("Demasiados intentos. Intenta más tarde."), { code: 429 });
    const { folio, tel, ok, comentario } = req.body || {};
    const v = J(await r1("GET", "vt:v:" + String(folio || "")));
    if (!v || !v.cliente || v.cliente.tel !== tel) throw Object.assign(new Error("No encontramos ese pedido"), { code: 404 });
    if (!v.autorizacion || v.autorizacion.estado !== "pendiente") throw Object.assign(new Error("Este diseño ya no está esperando tu autorización. Actualiza la página."), { code: 409 });
    autorizarVenta(v, !!ok, String(comentario || "").slice(0, 1000));
    await r1("SET", "vt:v:" + v.folio, JSON.stringify(v)); await marcar(["v:" + v.folio]);
    return { venta: paraCliente(v) };
  },

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

  /* IA: lista de elementos del mockup */
  async ia_lista(req, u){
    if (!puedeIA(u)) throw Object.assign(new Error("Sin permiso para usar la IA"), { code: 403 });
    const { mockup, prompt } = req.body || {};
    const im = await leerImagen(mockup);
    const d = await oai("/chat/completions", { model: process.env.OPENAI_TEXT_MODEL || "gpt-4.1", temperature: .2, max_tokens: 1200,
      messages: [{ role: "user", content: [{ type: "text", text: String(prompt || "").slice(0, 6000) }, { type: "image_url", image_url: { url: `data:${im.tipo};base64,${im.buf.toString("base64")}`, detail: "high" } }] }] });
    await contarIA("listas");
    return { texto: ((d.choices || [])[0] || {}).message ? d.choices[0].message.content : "" };
  },
  /* IA: genera un elemento a partir del mockup (PNG transparente o textura) y lo guarda */
  async ia_elemento(req, u){
    if (!puedeIA(u)) throw Object.assign(new Error("Sin permiso para usar la IA"), { code: 403 });
    const { mockup, prompt, transparente, tam } = req.body || {};
    const im = await leerImagen(mockup), f = new FormData();
    f.append("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-1");
    f.append("image[]", new Blob([im.buf], { type: im.tipo }), "mockup." + (im.tipo.split("/")[1] || "png"));
    f.append("prompt", String(prompt || "").slice(0, 4000));
    f.append("size", ["1024x1024", "1536x1024", "1024x1536"].includes(tam) ? tam : "1024x1024");
    f.append("quality", process.env.OPENAI_IMAGE_QUALITY || "medium");
    f.append("background", transparente ? "transparent" : "opaque");
    f.append("output_format", "png");
    const d = await oai("/images/edits", f, false), b64 = ((d.data || [])[0] || {}).b64_json;
    if (!b64) throw Object.assign(new Error("La IA no regresó imagen. Intenta de nuevo."), { code: 502 });
    await contarIA("imagenes");
    return { src: await guardarImagen("data:image/png;base64," + b64, "ia") };
  },
  async ia_uso(req, u){ const h = await r1("HGETALL", "vt:ia:" + new Date().toISOString().slice(0, 7)) || []; const o = {}; for (let i = 0; i < h.length; i += 2) o[h[i]] = +h[i + 1]; return o; },


  /* ---------- ORIGINALES DE STUDIO ---------- */
  async orig_token(req, u){
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    if (!(await limite(req, "orig", 120, 3600))) throw errS("Demasiadas subidas. Intenta más tarde.", 429);
    const { tipo, bytes, folio, clase } = req.body || {}, n = +bytes;
    if (!ORIG_TIPOS[tipo]) throw errS("Formato no permitido (PNG, JPG o WEBP; SVG va aparte).", 400);
    if (!(n > 0) || n > ORIG_MAX) throw errS(`El archivo pasa del límite de ${Math.round(ORIG_MAX / 1048576)} MB.`, 400);
    const usado = +(await r1("GET", "vt:uso:bytes") || 0); if (usado + n > LIM.bytes) throw errS("No hay espacio suficiente en el almacenamiento. Libera espacio primero.", 507);
    await blobOK();
    const nombre = `originales/${String(folio || "SINFOLIO").replace(/[^\w-]/g, "").slice(0, 20)}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}.${ORIG_TIPOS[tipo]}`;
    await r1("SET", "vt:subida:" + nombre, JSON.stringify({ u: u.id, tipo, bytes: n, clase: clase === "edicion" ? "edicion" : "original" }), "EX", 3600);
    if ((process.env.VT_BLOB_DIR || process.env.VT_BLOB_FAKE) && !process.env.VT_BLOB_FAKE_DIRECTO) return { modo: "api", pathname: nombre };   // VT_BLOB_FAKE_DIRECTO: prueba local del camino directo
    const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
    const clientToken = await generateClientTokenFromReadWriteToken({ token: BLOB_TOK || process.env.BLOB_READ_WRITE_TOKEN, pathname: nombre, allowedContentTypes: [tipo], maximumSizeInBytes: n, validUntil: Date.now() + 3600e3, addRandomSuffix: false, allowOverwrite: false });
    return { modo: "directo", pathname: nombre, clientToken, access: (await r1("GET", "vt:cfg:blob")) || "private" };
  },
  /* solo en pruebas locales (sin Vercel): el archivo pasa por aquí */
  async orig_subir_local(req, u){
    if (!process.env.VT_BLOB_DIR && !process.env.VT_BLOB_FAKE) throw errS("No disponible", 404);
    const { pathname, data } = req.body || {}, pend = J(await r1("GET", "vt:subida:" + pathname)); if (!pend || pend.u !== u.id) throw errS("Permiso de subida inválido", 403);
    const m = /^data:[\w/+.-]+;base64,(.*)$/s.exec(data || ""); if (!m) throw errS("Archivo inválido", 400); const buf = Buffer.from(m[1], "base64");
    if (buf.length > pend.bytes) throw errS("El archivo no coincide con el tamaño autorizado", 400);
    await putCrudo(pathname, buf, pend.tipo); return { ok: true };
  },
  async orig_registrar(req, u){
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    const { pathname, folio } = req.body || {}, pend = J(await r1("GET", "vt:subida:" + pathname));
    if (!pend || pend.u !== u.id) throw errS("Esta subida no fue autorizada o ya venció.", 403);
    const ini = await inicioDe(pathname); if (!ini) throw errS("El archivo no llegó al almacenamiento.", 400);
    const md = medidasDe(ini.buf), tam = ini.size || pend.bytes;
    if (!md || md.tipo !== pend.tipo || !md.w || !md.h || tam > pend.bytes){ await borrarImagenes([pathname]).catch(() => {}); await r1("DEL", "vt:subida:" + pathname); throw errS("El archivo no es una imagen válida del tipo declarado. Se eliminó.", 400); }
    const reg = { u: u.id, folio: String(folio || ""), tipo: md.tipo, bytes: tam, w: md.w, h: md.h, clase: pend.clase || "original", fecha: new Date().toISOString() };
    await rp([["HSET", "vt:img", pathname, tam], ["INCRBY", "vt:uso:bytes", tam], ["SET", "vt:orig:" + pathname, JSON.stringify(reg)], ["DEL", "vt:subida:" + pathname]]);
    await contarIA("originales").catch(() => {});
    return { ref: "/api/vt?a=img&p=" + encodeURIComponent(pathname), ...reg };
  },
  async svg_subir(req, u){
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    if (!(await limite(req, "orig", 120, 3600))) throw errS("Demasiadas subidas. Intenta más tarde.", 429);
    const { svg, folio } = req.body || {}, L = limpiarSVG(svg), buf = Buffer.from(L.svg, "utf8");
    const usado = +(await r1("GET", "vt:uso:bytes") || 0); if (usado + buf.length > LIM.bytes) throw errS("No hay espacio suficiente en el almacenamiento.", 507);
    const nombre = `originales/${String(folio || "SINFOLIO").replace(/[^\w-]/g, "").slice(0, 20)}-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}.svg`;
    await putCrudo(nombre, buf, "image/svg+xml");
    const reg = { u: u.id, folio: String(folio || ""), tipo: "image/svg+xml", bytes: buf.length, w: L.w, h: L.h, vector: true, clase: "original", fecha: new Date().toISOString() };
    await rp([["HSET", "vt:img", nombre, buf.length], ["INCRBY", "vt:uso:bytes", buf.length], ["SET", "vt:orig:" + nombre, JSON.stringify(reg)]]);
    return { ref: "/api/vt?a=img&p=" + encodeURIComponent(nombre), ...reg, quitado: L.quitado };
  },
  /* el elemento ya no usa estos originales: pasan a la lista de espera (no se borran al momento; el barrido revisa que nadie más los use).
     Excepción: los archivos de la AUTOPRUEBA (solo en pruebas, del mismo usuario) se borran enseguida. */
  async orig_borrar(req, u){
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    const refs = [].concat((req.body || {}).refs || []).slice(0, 50), ya = [], espera = [];
    for (const r of refs){ const m = /[?&]p=([^&]+)/.exec(String(r)); if (!m) continue; const p = decodeURIComponent(m[1]); if (!p.startsWith("originales/")) continue;
      const reg = J(await r1("GET", "vt:orig:" + p)); if (!reg) continue;
      if (PRUEBAS && reg.folio === "AUTOPRUEBA" && reg.u === u.id) ya.push(p); else espera.push(p); }
    if (ya.length) await borrarImagenes(ya);
    if (espera.length){ const ahora = Date.now(); await rp(espera.map(p => ["HSETNX", LIMP_K, p, JSON.stringify({ desde: ahora, por: u.nombre || u.usuario, motivo: "El elemento de STUDIO/Taller dejó de usarlo" })])); }
    return { borrados: ya.length, enEspera: espera.length };
  },
  /* ---- SOLO EN PRUEBAS, para la autoprueba: nunca existen en producción ---- */
  /* pregunta DIRECTO al almacenamiento (sin caché) si existen un original y su copia en la papelera */
  async prueba_existe(req, u){
    if (!PRUEBAS) throw errS("Solo en el entorno de pruebas", 403);
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    const out = []; await blobOK();
    const existe = async q => { if (process.env.VT_BLOB_DIR){ const fs = await import("node:fs"), path = await import("node:path"); return fs.existsSync(path.join(process.env.VT_BLOB_DIR, q)); }
      const { head } = await blob(); try { return !!(await head(q, BLOB_OP)); } catch(e){ if (/not.?found|404/i.test(String(e && (e.name + e.message)))) return false; throw e; } };
    for (const r of [].concat((req.body || {}).refs || []).slice(0, 50)){ const m = /[?&]p=([^&]+)/.exec(String(r)); if (!m) continue; const p = decodeURIComponent(m[1]); if (!p.startsWith("originales/")) continue;
      out.push({ ruta: p, existe: await existe(p), enPapelera: await existe(rutaPapelera(p)), registroPapelera: !!(await r1("HEXISTS", LIMP_PAP, p)) }); }
    return { archivos: out };
  },
  /* manda un original de la AUTOPRUEBA (del mismo usuario) directo a la papelera, sin esperar los plazos */
  async prueba_papelera(req, u){
    if (!PRUEBAS) throw errS("Solo en el entorno de pruebas", 403);
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    const m = /[?&]p=([^&]+)/.exec(String((req.body || {}).ref || "")); const p = m && decodeURIComponent(m[1]);
    if (!p || !p.startsWith("originales/")) throw errS("Ruta inválida", 400);
    const reg = J(await r1("GET", "vt:orig:" + p)); if (!reg || reg.folio !== "AUTOPRUEBA" || reg.u !== u.id) throw errS("Solo archivos de la autoprueba", 403);
    await r1("HSET", LIMP_PAP, p, JSON.stringify({ desde: Date.now(), por: u.nombre || u.usuario, motivo: "Autoprueba", tipo: "Autoprueba", bytes: reg.bytes, subido: reg.fecha }));
    const n = await moverArchivo(p, rutaPapelera(p)); await rp([["HDEL", "vt:img", p], ["HSET", "vt:img", rutaPapelera(p), n], ["HDEL", LIMP_K, p]]);
    return { ok: true };
  },
  /* pone o quita una referencia de prueba (colección "autoprueba") para comprobar la recuperación con referencia válida */
  async prueba_referencia(req, u){
    if (!PRUEBAS) throw errS("Solo en el entorno de pruebas", 403);
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    const refs = [].concat((req.body || {}).refs || []).map(String).filter(r => /^\/api\/vt\?a=img&p=originales%2F[\w.-]+$/.test(r)).slice(0, 10);
    if ((req.body || {}).quitar || !refs.length){ await rp([["SREM", "vt:ik", "autoprueba"], ["DEL", "vt:col:autoprueba"]]); return { ok: true, refs: 0 }; }
    await rp([["SET", "vt:col:autoprueba", JSON.stringify({ nota: "Referencia temporal de la autoprueba", refs })], ["SADD", "vt:ik", "autoprueba"]]);
    return { ok: true, refs: refs.length };
  },
  /* eliminación definitiva de un original de la AUTOPRUEBA que está en la papelera (mismas operaciones que la eliminación real) */
  async prueba_eliminar(req, u){
    if (!PRUEBAS) throw errS("Solo en el entorno de pruebas", 403);
    if (!puedeStudio(u)) throw errS("Sin permiso", 403);
    const m = /[?&]p=([^&]+)/.exec(String((req.body || {}).ref || "")); const p = m && decodeURIComponent(m[1]);
    if (!p || !p.startsWith("originales/")) throw errS("Ruta inválida", 400);
    const reg = J(await r1("GET", "vt:orig:" + p)); if (!reg || reg.folio !== "AUTOPRUEBA" || reg.u !== u.id) throw errS("Solo archivos de la autoprueba", 403);
    if (!(await r1("HDEL", LIMP_PAP, p))) throw errS("No está en la papelera", 400);
    await borrarImagenes([rutaPapelera(p)]); await rp([["DEL", "vt:orig:" + p]]);
    return { ok: true };
  },
  /* ---- barrido de huérfanos (solo administrador) ---- */
  async limpieza_simular(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    const E = await estadoLimpieza(); delete E._ref; return E;
  },
  async limpieza_espera(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    if ((req.body || {}).confirmar !== "PASAR A ESPERA") throw errS("Falta la confirmación", 400);
    const E = await estadoLimpieza(), ahora = Date.now(), quien = u.nombre || u.usuario, nuevos = E.filas.filter(x => x.estado === "huerfano"), salen = E.filas.filter(x => x.estado === "recuperado").map(x => x.ruta).concat(E.faltanEnEspera);
    const cmds = nuevos.map(x => ["HSET", LIMP_K, x.ruta, JSON.stringify({ desde: ahora, por: quien, motivo: x.motivo })]); if (salen.length) cmds.push(["HDEL", LIMP_K, ...salen]);
    if (cmds.length) await rp(cmds);
    let rec = 0; for (const x of E.filas.filter(x => x.estado === "rescatar")) if (await restaurar(x.ruta, quien, "Se volvió a usar (revisión)")) rec++;
    await limpLog({ por: quien, accion: "espera", archivos: nuevos.length, bytes: nuevos.reduce((a, x) => a + x.bytes, 0), salen: salen.length, recuperados: rec, rutas: nuevos.map(x => x.ruta) });
    return { enEspera: nuevos.length, salieron: salen.length, recuperados: rec, bytes: nuevos.reduce((a, x) => a + x.bytes, 0) };
  },
  /* "borrar" = MOVER A LA PAPELERA: se vuelve a revisar todo, se reclama el archivo de la lista de espera y se mueve. No se elimina nada todavía. */
  async limpieza_papelera(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    const b = req.body || {}; if (b.confirmar !== "MOVER A PAPELERA") throw errS("Falta la confirmación", 400);
    const pedidas = [...new Set([].concat(b.rutas || []).map(String))].slice(0, 200); if (!pedidas.length) return { movidos: 0, omitidos: [] };
    const E = await estadoLimpieza(), por = new Map(E.filas.filter(x => !x.enPapelera).map(x => [x.ruta, x])), quien = u.nombre || u.usuario, movidos = [], omitidos = [];
    for (const p of pedidas){ const x = por.get(p);
      if (!x || x.estado !== "listo"){ omitidos.push({ ruta: p, motivo: x ? x.motivo + " (" + x.estado + ")" : "Ya no existe" }); continue; }
      if (!(await r1("HDEL", LIMP_K, p))){ omitidos.push({ ruta: p, motivo: "Salió de la lista de espera en este momento (se volvió a usar)" }); continue; }   // reclamo: si alguien lo rescató, no se toca
      await r1("HSET", LIMP_PAP, p, JSON.stringify({ desde: Date.now(), por: quien, motivo: x.motivo, tipo: x.tipo, bytes: x.bytes, subido: x.fecha, enEsperaDesde: x.enEsperaDesde }));
      try { const n = await moverArchivo(p, rutaPapelera(p)); await rp([["HDEL", "vt:img", p], ["HSET", "vt:img", rutaPapelera(p), n]]); movidos.push(x);
        await limpLog({ por: quien, accion: "papelera", ruta: p, tipo: x.tipo, bytes: x.bytes, subido: x.fecha, enEsperaDesde: x.enEsperaDesde, motivo: x.motivo }); }
      catch(e){ await rp([["HDEL", LIMP_PAP, p], ["HSET", LIMP_K, p, JSON.stringify({ desde: Date.parse(x.enEsperaDesde) || Date.now(), por: quien, motivo: x.motivo })]]); omitidos.push({ ruta: p, motivo: "No se pudo mover: " + (e.message || e) }); } }
    return { movidos: movidos.length, bytes: movidos.reduce((a, x) => a + x.bytes, 0), omitidos };
  },
  async limpieza_restaurar(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    const rutas = [...new Set([].concat((req.body || {}).rutas || []).map(String))].slice(0, 200), ok = [], no = [];
    for (const p of rutas) ((await restaurar(p, u.nombre || u.usuario, "Restaurado a mano")) ? ok : no).push(p);
    return { restaurados: ok.length, noEncontrados: no };
  },
  /* eliminación DEFINITIVA: solo lo que lleva los 30 días en la papelera, con una revisión completa nueva justo antes */
  async limpieza_eliminar(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    const b = req.body || {}; if (b.confirmar !== "ELIMINAR DEFINITIVAMENTE") throw errS("Falta la confirmación", 400);
    const pedidas = [...new Set([].concat(b.rutas || []).map(String))].slice(0, 200); if (!pedidas.length) return { eliminados: 0, omitidos: [] };
    const E = await estadoLimpieza(), por = new Map(E.filas.filter(x => x.enPapelera).map(x => [x.ruta, x])), quien = u.nombre || u.usuario, ok = [], omitidos = [];
    for (const p of pedidas){ const x = por.get(p);
      if (!x || x.estado !== "eliminable"){ omitidos.push({ ruta: p, motivo: x ? (x.estado === "rescatar" ? "Se volvió a usar: se recupera en lugar de eliminarse" : x.motivo + " (" + x.estado + ")") : "No está en la papelera" }); if (x && x.estado === "rescatar") await restaurar(p, quien, "Se volvió a usar (revisión antes de eliminar)"); continue; }
      if ((await r1("SET", "vt:limp:rest:" + p, "1", "NX", "EX", 120)) !== "OK"){ omitidos.push({ ruta: p, motivo: "Se está recuperando en este momento" }); continue; }
      try { if (!(await r1("HDEL", LIMP_PAP, p))){ omitidos.push({ ruta: p, motivo: "Ya no está en la papelera" }); continue; }
        await borrarImagenes([rutaPapelera(p)]); await rp([["DEL", "vt:orig:" + p]]); ok.push(x);
        await limpLog({ por: quien, accion: "eliminado", ruta: p, tipo: x.tipo, bytes: x.bytes, subido: x.fecha, enPapeleraDesde: x.enPapeleraDesde, motivo: x.motivo }); }
      finally { await r1("DEL", "vt:limp:rest:" + p).catch(() => {}); } }
    return { eliminados: ok.length, bytes: ok.reduce((a, x) => a + x.bytes, 0), omitidos };
  },
  async limpieza_registro(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    return { registro: ((await r1("LRANGE", LIMP_LOG, 0, 299)) || []).map(J) };
  },
  /* ---- pedidos cancelados: MISMO sistema de búsqueda que el barrido. Solo los folios que el administrador marque.
     Quita las ligas del diseño y manda los archivos a la LISTA DE ESPERA (no los borra). No cambia el estado ni elimina el pedido. ---- */
  async canceladas_simular(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    const E = await estadoLimpieza(), ref = E._ref, porH = new Map(E.filas.filter(x => !x.enPapelera).map(x => [huellaDe(x.ruta), x]));
    const out = []; for (const [f, v] of ref.ventas){ if (!v || v.estado !== "cancelada") continue;
      const propios = [...huellasDe(JSON.stringify(v.items))].filter(h => { const us = ref.usos.get(h), x = porH.get(h); return x && us && [...us].every(d => d === "dis:" + f) && !["protegido"].includes(x.estado); }).map(h => porH.get(h));
      const h = (v.historial || []).find(x => /cancelad/i.test(x.accion || "")) || {};
      out.push({ folio: f, cliente: (v.cliente || {}).nombre || "", fecha: v.fecha, cancelada: h.fecha || null, imagenes: propios.length, bytes: propios.reduce((a, x) => a + (x.bytes || 0), 0), depuradas: v.imagenesDepuradas || null }); }
    return { pedidos: out.sort((a, b) => String(b.cancelada || b.fecha).localeCompare(String(a.cancelada || a.fecha))) };
  },
  async canceladas_liberar(req, u){
    if (u.rol !== "Administrador") throw errS("Solo un administrador", 403);
    const b = req.body || {}; if (b.confirmar !== "LIBERAR") throw errS("Falta la confirmación", 400);
    const folios = new Set([].concat(b.folios || []).map(String)); if (!folios.size) return { pedidos: 0, imagenes: 0, bytes: 0, conservadas: 0 };
    const E = await estadoLimpieza(), ref = E._ref, porH = new Map(E.filas.filter(x => !x.enPapelera).map(x => [huellaDe(x.ruta), x])), quien = u.nombre || u.usuario;
    const elegidas = [...ref.ventas.entries()].filter(([f, v]) => folios.has(f) && v && v.estado === "cancelada"), dis = new Set(elegidas.map(([f]) => "dis:" + f));
    /* un archivo solo se libera si TODO lo que lo usa es el diseño de los pedidos elegidos (no otros pedidos, ni pagos, clientes, configuración o versiones de otros) */
    const libres = new Set(); for (const [, v] of elegidas) for (const h of huellasDe(JSON.stringify(v.items))){ const us = ref.usos.get(h), x = porH.get(h);
      if (x && us && [...us].every(d => dis.has(d)) && x.estado !== "protegido") libres.add(h); }
    const cmds = [], marcas = [], aEspera = new Map(); let conservadas = 0;
    for (const [f, v] of elegidas){ let t = JSON.stringify(v.items), cambio = false;
      for (const h of huellasDe(t)){ if (!libres.has(h)) continue;
        const re = new RegExp(`(?:/api/vt\\?a=img&p=|https?://)[^"\\\\\\s&]*-${h}[^"\\\\\\s&]*`, "gi"), t2 = t.replace(re, ""); if (t2 !== t){ t = t2; cambio = true; } }
      const quedan = huellasDe(t); for (const h of libres) if (quedan.has(h)) { libres.delete(h); conservadas++; }   // si la liga sigue en otra forma, el archivo NO se libera
      if (cambio){ v.items = JSON.parse(t); v.imagenesDepuradas = new Date().toISOString(); cmds.push(["SET", "vt:v:" + f, JSON.stringify(v)]); marcas.push("v:" + f); } }
    for (const h of libres){ const x = porH.get(h); aEspera.set(x.ruta, x); }
    const ahora = Date.now(); for (const [p, x] of aEspera) cmds.push(["HSET", LIMP_K, p, JSON.stringify({ desde: ahora, por: quien, motivo: "Imagen liberada de un pedido cancelado" })]);
    if (cmds.length) await rp(cmds); await marcar(marcas);
    const bytes = [...aEspera.values()].reduce((a, x) => a + (x.bytes || 0), 0);
    if (elegidas.length) await limpLog({ por: quien, accion: "canceladas", folios: elegidas.map(([f]) => f), archivos: aEspera.size, bytes, rutas: [...aEspera.keys()] });
    return { pedidos: marcas.length, imagenes: aEspera.size, bytes, conservadas };
  },
  /* muestra una imagen guardada */
  async img(req, u, res){
    const p = String(req.query.p || "");
    if (!/^[\w-]+\/[\w.-]+$/.test(p)) { res.status(400).end(); return null; }
    if (/^(papelera|_vituma)\//i.test(p)){ res.setHeader("Cache-Control", "no-store"); res.setHeader("CDN-Cache-Control", "no-store"); res.setHeader("Vercel-CDN-Cache-Control", "no-store"); res.status(404).end(); return null; }   // rutas internas: nunca por liga
    const tipo = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", svg: "image/svg+xml" }[p.split(".").pop()] || "application/octet-stream";
    if (p.startsWith("originales/")){ res.setHeader("Cache-Control", "no-store"); res.setHeader("CDN-Cache-Control", "no-store"); res.setHeader("Vercel-CDN-Cache-Control", "no-store"); }   // originales de STUDIO: sin copia en el navegador ni en la red de Vercel (también en 404)
    else res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");   // demás imágenes: igual que antes
    if (tipo === "image/svg+xml"){ res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"); res.setHeader("X-Content-Type-Options", "nosniff"); }
    if (process.env.VT_BLOB_DIR){
      const fs = await import("node:fs"), path = await import("node:path"); const f = path.join(process.env.VT_BLOB_DIR, p);
      if (!fs.existsSync(f) && !(await restaurarSiSeUsa(req, p, "Se abrió una liga y algún registro lo usa"))) { res.status(404).end(); return null; }
      res.setHeader("Content-Type", tipo); res.end(fs.readFileSync(f)); return null;
    }
    await blobOK();
    const { get } = await blob(), acceso = (await r1("GET", "vt:cfg:blob")) || "private";
    let r = await get(p, { access: acceso, ...BLOB_OP });
    if ((!r || r.statusCode !== 200) && await restaurarSiSeUsa(req, p, "Se abrió una liga y algún registro lo usa")) r = await get(p, { access: acceso, ...BLOB_OP });   // estaba en la papelera y algo lo usa: regresa
    if (!r || r.statusCode !== 200) { res.status(404).end(); return null; }
    res.setHeader("Content-Type", tipo === "image/svg+xml" ? tipo : r.blob.contentType || tipo);
    if (p.startsWith("originales/")){ const rd = r.stream.getReader(); for (;;){ const { done, value } = await rd.read(); if (done) break; res.write(Buffer.from(value)); } res.end(); return null; }   // originales grandes: se envían por partes
    const buf = Buffer.from(await new Response(r.stream).arrayBuffer());
    res.end(buf); return null;
  }
};
const RESCATE = new Set(["guardar", "pedido", "pago"]);
const PUBLICAS = new Set(["estado", "existencias", "login", "imagen", "pedido", "mis", "buscar", "pago", "autorizar", "img"]);

export default async function handler(req, res){
  const a = String((req.query && req.query.a) || "");
  try {
    if (!A[a]) return res.status(404).json({ error: "acción desconocida" });
    if (a !== "estado" && CANDADO) return res.status(503).json({ error: "🔒 Candado del entorno de pruebas: " + CANDADO });
    if (a !== "estado" && !HAY_DB) return res.status(503).json({ error: PRUEBAS ? "Entorno de pruebas sin base de datos propia (faltan las variables PRUEBAS_)." : "La base de datos no está conectada" });
    if (a !== "estado" && (await revisarMarca()) !== "ok") return res.status(503).json({ error: "🔒 Candado del entorno de pruebas: " + CANDADO });
    if (req.method !== "GET" && typeof req.body === "string"){ try { req.body = JSON.parse(req.body); } catch(e){ req.body = {}; } }
    let u = null;
    if (!PUBLICAS.has(a)){ u = await sesion(req); if (!u) return res.status(401).json({ error: "Tu sesión terminó. Vuelve a entrar." });
      if (debeCambiar(u) && a !== "cambiar_pass" && a !== "salir") return res.status(403).json({ error: "Debes crear una contraseña nueva antes de continuar.", debeCambiar: true }); }
    const resc = RESCATE.has(a) && req.body ? req.body : null; if (resc) await rescatar(resc, u ? u.nombre : "cliente");
    const out = await A[a](req, u, res);
    if (resc) await rescatar(resc, u ? u.nombre : "cliente");   // otra vez después de guardar (cierra la carrera con un borrado en curso)
    if (out !== null){ res.setHeader("Cache-Control", "no-store"); res.status(200).json(out); }
  } catch(e){
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    if (code === 500) console.error(a, e);
    if (!res.headersSent) res.status(code).json({ error: code === 500 ? "Error del servidor. Intenta de nuevo." : e.message });
  }
}
