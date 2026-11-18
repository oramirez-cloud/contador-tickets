// ---------- utilidades ----------
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const money = n => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n || 0);
const fdate = s => s ? new Date(s).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '';
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const val = id => document.getElementById(id).value.trim();
let ocupado = 0;
async function conCarga(msg, fn) {
  ocupado++; document.getElementById('loadmsg').textContent = msg; document.getElementById('loader').classList.add('show');
  try { return await fn(); } finally { if (--ocupado === 0) document.getElementById('loader').classList.remove('show'); }
}
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.className = 'show'; setTimeout(() => t.className = '', 2800); }

async function hash(salt, pass) {
  const s = salt + pass;
  if (crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0; return 'x' + h; // fallback
}

// ---------- estado ----------
let db = Store.empty();
let user = null;
let tab = 'inventario';

const lote = id => db.lotes.find(l => l.id === id);
const lotesVivos = () => db.lotes.filter(l => !l.borrado);

// ---------- multiusuario: varias personas sobre la misma carpeta compartida ----------
// Cada registro lleva "mod" (marca de tiempo). Al guardar se relee el archivo, se combinan
// los cambios de ambos por registro (gana el más reciente) y recién entonces se escribe.
const colecciones = ['usuarios', 'lotes', 'ventas'];
let snap = new Map(), ultimoMod = 0;
function tomaSnap() { snap = new Map(); for (const c of colecciones) for (const r of db[c]) snap.set(r.id, JSON.stringify(r)); }
function merge(local, remoto) {
  const out = Store.empty();
  for (const c of colecciones) {
    const m = new Map((remoto?.[c] || []).map(r => [r.id, r]));
    for (const r of local[c] || []) { const o = m.get(r.id); if (!o || (r.mod || 0) >= (o.mod || 0)) m.set(r.id, r); }
    out[c] = [...m.values()];
  }
  return out;
}
async function save() {
  return conCarga('Guardando…', _save);
}
async function _save() {
  try {
    for (const c of colecciones) for (const r of db[c]) if (snap.get(r.id) !== JSON.stringify(r)) r.mod = Date.now();
    if (Store.compartido()) {
      const remoto = await Store.leerDisco();
      if (remoto) db = merge(db, remoto);
    }
    const merged = await Store.guardar(db); if (Store.modo() === 'hoja' && merged) db = merged;
    tomaSnap();
    if (Store.compartido()) ultimoMod = await Store.modificado();
    if (user) user = db.usuarios.find(u => u.id === user.id) || user;
  } catch (e) { toast('Error al guardar: ' + e.message); }
}
// Trae cambios hechos por la otra persona. true si había algo nuevo.
async function sync() {
  if (!Store.compartido()) return false;
  const m = await Store.modificado();
  if (m === ultimoMod) return false;
  const remoto = await Store.leerDisco();
  if (remoto) { db = merge(db, remoto); tomaSnap(); }
  ultimoMod = m;
  if (user) user = db.usuarios.find(u => u.id === user.id && u.activo) || null;
  return true;
}
setInterval(async () => {
  try {
    if (modalAbierto()) return;
    const a = document.activeElement;
    if (a && /INPUT|SELECT/.test(a.tagName) && a.type !== 'file') return; // no interrumpir mientras escribe
    if (await sync()) render();
  } catch (e) { }
}, 8000);
const vendidos = id => db.ventas.filter(v => v.loteId === id && !v.anulada).reduce((a, v) => a + v.cantidad, 0);
const disponibles = id => lote(id).cantidad - vendidos(id);
const nombreUser = id => db.usuarios.find(u => u.id === id)?.nombre ?? '—';

async function guardarArchivoPdf(inputId, prefijo) {
  const f = document.getElementById(inputId)?.files[0];
  if (!f) return null;
  if (!Store.compartido()) { toast('El PDF solo se guarda si conectas una hoja o carpeta (pestaña Datos)'); return null; }
  try { return await Store.guardarPdf(`${prefijo}_${Date.now()}_${f.name.replace(/[^\w.\-]+/g, '_')}`, f); }
  catch (e) { toast('No se pudo guardar el PDF: ' + e.message); return null; }
}
async function verPdf(ruta) {
  if (/^https?:/.test(ruta)) return void window.open(ruta, '_blank');
  try {
    const url = URL.createObjectURL(await Store.abrirPdf(ruta));
    window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast('No se encontró el PDF en la carpeta'); }
}
const pdfBtn = r => r ? `<button class="sec" onclick="verPdf('${esc(r)}')">PDF</button>` : '';

// ---------- arranque ----------
async function boot() {
  const r = await Store.recordada();
  if (r === 'ok') { db = await conCarga('Cargando datos…', () => Store.cargar()).catch(e => { toast('No se pudo cargar: ' + e.message); return Store.empty(); }); return afterLoad(); }
  if (r === 'permiso') return renderSetup('reconectar');
  if (localStorage.getItem('boletos.datos.v2')) { db = await Store.cargar(); return afterLoad(); }
  renderSetup('nuevo');
}
async function afterLoad() {
  tomaSnap(); if (Store.compartido()) ultimoMod = await Store.modificado();
  const u = sessionStorage.getItem('sesion');
  user = u ? db.usuarios.find(x => x.id === u && x.activo) : null;
  render();
}
function renderSetup(modo) {
  const hoja = `<h2>Conectar Google Sheets</h2>
  <p class="mut">Datos compartidos entre varias personas. Pega la URL de la aplicación web (termina en /exec) y la clave que pusiste en el script.</p>
  <label>URL del script<input id="hu" value="${esc(typeof CONFIG !== 'undefined' ? CONFIG.url : '')}" placeholder="https://script.google.com/macros/s/.../exec"></label>
  <label>Clave<input id="hk" type="password"></label>
  <button class="btn" onclick="conectarHoja()">Conectar</button>`;
  $app.innerHTML = `<div class="card login" style="max-width:460px">${hoja}
  <hr style="border:0;border-top:1px solid var(--bd);margin:18px 0">
  <h2>Otras opciones</h2>
  ${modo === 'reconectar'
      ? `<button class="btn" onclick="reconectar()">Reconectar carpeta "${esc(Store.nombreCarpeta())}"</button> `
      : ''}
  ${Store.soportaCarpeta() ? '<button class="sec" onclick="elegirCarpeta()">Usar una carpeta (datos.json)</button> ' : ''}
  <button class="sec" onclick="soloNavegador()">Solo este navegador</button></div>`;
}
async function conectarHoja() {
  try {
    const u = val('hu'), k = document.getElementById('hk').value;
    const d = await conCarga('Conectando…', async () => { await Store.conectarHoja(u, k); return Store.cargar(); });
    if (d.usuarios.length || !db.usuarios.length) db = d; else await save();
    afterLoad();
  } catch (e) { toast(e.message); }
}
async function reconectar() { try { await Store.reconectar(); db = await Store.cargar(); afterLoad(); } catch (e) { toast(e.message); } }
async function elegirCarpeta() {
  try {
    await Store.elegirCarpeta();
    const d = await Store.cargar();
    if (d.usuarios.length || !db.usuarios.length) db = d; else await save();
    afterLoad();
  } catch (e) { if (e.name !== 'AbortError') toast(e.message); }
}
async function soloNavegador() { Store.usarNavegador(); db = await Store.cargar(); afterLoad(); }

// ---------- render raíz ----------
function render() {
  if (!db.usuarios.length) return renderPrimerAdmin();
  if (!user) return renderLogin();
  const admin = user.rol === 'admin';
  const tabs = admin ? [['inventario', 'Boletos'], ['ventas', 'Ventas'], ['usuarios', 'Usuarios'], ['datos', 'Datos']] : [['ventas', 'Ventas']];
  if (!tabs.some(t => t[0] === tab)) tab = tabs[0][0]; // el rol usuario solo ve Ventas
  $app.innerHTML = `<header><h1>🎟️ Control de Boletos</h1>
    <nav>${tabs.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" onclick="go('${k}')">${l}</button>`).join('')}</nav>
    <span class="mut">${esc(user.nombre)} (${user.rol})</span><button class="sec" onclick="logout()">Salir</button></header>
    <main id="view"></main>`;
  ({ inventario: vInventario, ventas: vVentas, usuarios: vUsuarios, datos: vDatos })[tab]();
}
const go = t => { tab = t; render(); };

// ---------- sesión ----------
function renderPrimerAdmin() {
  $app.innerHTML = `<div class="card login"><h2>Crear administrador</h2><p class="mut">Primer uso: crea la cuenta principal.</p>
  <label>Nombre<input id="n"></label><label>Usuario<input id="u"></label><label>Contraseña<input id="p" type="password"></label>
  <button class="btn" onclick="crearAdmin()">Crear y entrar</button></div>`;
}
async function crearAdmin() {
  if (!val('n') || !val('u') || !document.getElementById('p').value) return toast('Completa todos los campos');
  const u = await nuevoUsuario(val('n'), val('u'), document.getElementById('p').value, 'admin');
  db.usuarios.push(u); await save(); user = u; sessionStorage.setItem('sesion', u.id); render();
}
function renderLogin() {
  $app.innerHTML = `<div class="card login"><h2>Iniciar sesión</h2>
  <label>Usuario<input id="u" autofocus></label><label>Contraseña<input id="p" type="password" onkeydown="if(event.key==='Enter')login()"></label>
  <button class="btn" onclick="login()">Entrar</button></div>`;
}
async function login() {
  if (Store.compartido()) await conCarga('Entrando…', async () => { await sync().catch(() => { }); });
  const u = db.usuarios.find(x => x.usuario.toLowerCase() === val('u').toLowerCase() && x.activo);
  if (!u || u.hash !== await hash(u.salt, document.getElementById('p').value)) return toast('Usuario o contraseña incorrectos');
  user = u; sessionStorage.setItem('sesion', u.id); tab = u.rol === 'admin' ? 'inventario' : 'ventas'; render();
}
function logout() { user = null; sessionStorage.removeItem('sesion'); render(); }
async function nuevoUsuario(nombre, usuario, pass, rol) {
  const salt = uid();
  return { id: uid(), nombre, usuario, rol, salt, hash: await hash(salt, pass), activo: true };
}

// ---------- inventario: ingresar boletos ----------
function vInventario(edit) {
  const l = edit ? lote(edit) : {};
  const artistas = [...new Set(lotesVivos().map(x => x.artista))], zonas = [...new Set(lotesVivos().map(x => x.zona))];
  const act = db.ventas.filter(v => !v.anulada);
  const invertido = lotesVivos().reduce((a, x) => a + x.costo * x.cantidad, 0);
  const disp = lotesVivos().reduce((a, x) => a + disponibles(x.id), 0);
  document.getElementById('view').innerHTML = `
  <div class="stats">
    <div class="stat"><span class="mut">Disponibles</span><b>${disp}</b></div>
    <div class="stat"><span class="mut">Invertido</span><b>${money(invertido)}</b></div>
    <div class="stat"><span class="mut">Vendido</span><b>${money(act.reduce((a, v) => a + v.precio * v.cantidad, 0))}</b></div>
    <div class="stat"><span class="mut">Utilidad (vendidos)</span><b>${money(act.reduce((a, v) => a + (v.precio - (lote(v.loteId)?.costo ?? 0)) * v.cantidad, 0))}</b></div>
  </div>
  <div class="card"><h2>${edit ? 'Editar' : 'Ingresar'} boletos</h2>
  <datalist id="dl-a">${artistas.map(a => `<option value="${esc(a)}">`).join('')}</datalist><datalist id="dl-z">${zonas.map(a => `<option value="${esc(a)}">`).join('')}</datalist>
  <div class="row"><label>Artista / evento<input id="la" list="dl-a" value="${esc(l.artista)}"></label><label>Zona<input id="lz" list="dl-z" value="${esc(l.zona)}"></label>
  <label>Cantidad<input id="lc" type="number" min="1" value="${l.cantidad ?? ''}"></label>
  <label>Costo por boleto<input id="lk" type="number" min="0" step="0.01" value="${l.costo ?? ''}"></label>
  <label>Precio sugerido de venta<input id="ls" type="number" min="0" step="0.01" value="${l.sugerido ?? ''}"></label>
  <label>Fecha de ingreso<input id="lf" type="datetime-local" value="${esc(l.fecha || nowLocal())}"></label>
  <label>PDF de los boletos (opcional)<input id="lp" type="file" accept="application/pdf"></label></div>
  <button class="btn" onclick="guardarLote('${edit || ''}')">Guardar</button> ${edit ? '<button class="sec" onclick="vInventario()">Cancelar</button>' : ''}</div>
  <div class="card"><h2>Inventario</h2><table><tr><th>Artista</th><th>Zona</th><th>Disp.</th><th>Costo</th><th>Sugerido</th><th>Ingreso</th><th></th></tr>
  ${[...lotesVivos()].reverse().map(x => `<tr><td>${esc(x.artista)}</td><td>${esc(x.zona)}</td><td>${disponibles(x.id)} / ${x.cantidad}</td><td>${money(x.costo)}</td><td>${money(x.sugerido)}</td>
  <td>${fdate(x.fecha)}<br><span class="mut">${esc(nombreUser(x.usuarioId))}</span></td>
  <td class="acts">${pdfBtn(x.pdf)} <button class="sec" onclick="vInventario('${x.id}')">Editar</button>
  <button class="sec danger" onclick="borrarLote('${x.id}')">Borrar</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Sin boletos ingresados</td></tr>'}</table></div>`;
}
async function guardarLote(id) {
  const o = { artista: val('la'), zona: val('lz'), cantidad: parseInt(val('lc')), costo: parseFloat(val('lk')), sugerido: parseFloat(val('ls')), fecha: val('lf') || nowLocal() };
  if (!o.artista || !o.zona || !(o.cantidad > 0) || isNaN(o.costo) || isNaN(o.sugerido)) return toast('Completa artista, zona, cantidad, costo y precio sugerido');
  if (id && o.cantidad < vendidos(id)) return toast('La cantidad no puede ser menor a lo ya vendido (' + vendidos(id) + ')');
  const pdf = await guardarArchivoPdf('lp', 'ingreso');
  if (id) { const l = lote(id); Object.assign(l, o); if (pdf) l.pdf = pdf; }
  else db.lotes.push({ id: uid(), ...o, pdf, usuarioId: user.id });
  await save(); toast('Guardado'); vInventario();
}
async function borrarLote(id) {
  if (db.ventas.some(v => v.loteId === id)) return toast('Tiene ventas registradas; no se puede borrar');
  if (!confirm('¿Borrar este ingreso de boletos?')) return;
  lote(id).borrado = true; await save(); vInventario();
}

// ---------- ventas ----------
function vVentas() {
  const con = lotesVivos().filter(l => disponibles(l.id) > 0);
  document.getElementById('view').innerHTML = `
  <div class="card"><div class="head"><h2>Boletos disponibles</h2><button class="btn" onclick="abrirVenta()" ${con.length ? '' : 'disabled'}>Vender</button></div>
  <table><tr><th>Artista</th><th>Zona</th><th>Disponibles</th><th>Precio sugerido</th><th></th></tr>
  ${con.map(l => `<tr><td>${esc(l.artista)}</td><td>${esc(l.zona)}</td><td>${disponibles(l.id)}</td><td class="sug">${money(l.sugerido)}</td>
    <td class="acts"><button class="btn sm" onclick="abrirVenta('${l.id}')">Vender</button></td></tr>`).join('') || '<tr><td colspan="5" class="mut">No hay boletos disponibles.</td></tr>'}</table></div>
  <div class="card"><h2>Historial de ventas</h2>
  <table><tr><th>Fecha</th><th>Boleto</th><th>Cant.</th><th>Precio</th><th>Total</th>${user.rol === 'admin' ? '<th>Utilidad</th>' : ''}<th>Comentarios</th><th></th></tr>
  ${[...db.ventas].sort((a, b) => b.fecha.localeCompare(a.fecha)).map(v => {
    const l = lote(v.loteId);
    return `<tr><td>${fdate(v.fecha)}<br><span class="mut">${esc(nombreUser(v.vendedorId))}</span></td><td>${esc(l?.artista)}<br><span class="mut">${esc(l?.zona)}</span></td>
    <td>${v.cantidad}</td><td>${money(v.precio)}</td><td>${money(v.precio * v.cantidad)}</td>${user.rol === 'admin' ? `<td>${money((v.precio - (l?.costo ?? 0)) * v.cantidad)}</td>` : ''}<td>${esc(v.comentario)}</td>
    <td class="acts">${v.anulada ? '<span class="tag err">Anulada</span>' : `${pdfBtn(v.pdf)} ${user.rol === 'admin' ? `<button class="sec danger" onclick="anular('${v.id}')">Anular</button>` : ''}`}</td></tr>`;
  }).join('') || '<tr><td colspan="8" class="mut">Sin ventas</td></tr>'}</table></div>`;
}

// ----- modal de venta -----
const modalAbierto = () => document.getElementById('modal').classList.contains('show');
function abrirVenta(id) {
  const con = lotesVivos().filter(l => disponibles(l.id) > 0);
  if (!con.length) return toast('No hay boletos disponibles');
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="dlg" role="dialog" aria-modal="true"><h2>Vender boletos</h2>
    <label>Artista y zona<select id="vl" onchange="detalleVenta()"><option value="">Selecciona…</option>
      ${con.map(l => `<option value="${l.id}">${esc(l.artista)} — ${esc(l.zona)}</option>`).join('')}</select></label>
    <div id="vdet"></div>
    <div id="vform" hidden>
      <div class="row"><label>Cantidad<input id="vq" type="number" min="1" value="1" oninput="calcVenta()"></label>
      <label>Precio de venta (por boleto)<input id="vp" type="number" min="0" step="0.01" placeholder="0.00" oninput="calcVenta()"></label></div>
      <label>Fecha de venta<input id="vf" type="datetime-local" value="${nowLocal()}"></label>
      <label>Comentarios (opcional)<input id="vc" placeholder="Vendido a…"></label>
      <label>PDF (opcional)<input id="vpdf" type="file" accept="application/pdf"></label>
      <div id="vtot" class="vtot"></div>
    </div>
    <div class="dlg-act"><button class="sec" onclick="cerrarVenta()">Cancelar</button><button class="btn" onclick="vender()">Registrar venta</button></div></div>`;
  m.classList.add('show');
  if (id) { document.getElementById('vl').value = id; detalleVenta(); }
}
function cerrarVenta() { document.getElementById('modal').classList.remove('show'); }
function detalleVenta() {
  const id = val('vl'), d = document.getElementById('vdet'), f = document.getElementById('vform');
  if (!id) { d.innerHTML = ''; f.hidden = true; return; }
  const l = lote(id), n = disponibles(id);
  d.innerHTML = `<div class="detalle"><div><span>Artista</span><b>${esc(l.artista)}</b></div><div><span>Zona</span><b>${esc(l.zona)}</b></div>
    <div><span>Disponibles</span><b>${n}</b></div><div><span>Precio sugerido</span><b class="sug">${money(l.sugerido)}</b></div></div>`;
  document.getElementById('vq').max = n; f.hidden = false; calcVenta();
}
function calcVenta() {
  const l = lote(val('vl')), q = +val('vq') || 0, p = parseFloat(val('vp'));
  document.getElementById('vtot').textContent = isNaN(p) ? '' : `Total: ${money(p * q)}` + (user.rol === 'admin' ? ` · Utilidad: ${money((p - l.costo) * q)}` : '');
}
async function vender() {
  if (!val('vl')) return toast('Selecciona artista y zona');
  await sync();
  const l = lote(val('vl')), q = parseInt(val('vq')), p = parseFloat(val('vp'));
  if (!(q > 0)) return toast('Cantidad inválida');
  if (q > disponibles(l.id)) return toast('Solo hay ' + disponibles(l.id) + ' disponibles');
  if (isNaN(p) || p < 0) return toast('Escribe el precio de venta');
  const pdf = await guardarArchivoPdf('vpdf', 'venta');
  db.ventas.push({ id: uid(), loteId: l.id, cantidad: q, precio: p, fecha: val('vf') || nowLocal(), comentario: val('vc'), pdf, vendedorId: user.id });
  cerrarVenta(); await save(); toast('Venta registrada'); vVentas();
}
async function anular(id) {
  if (!confirm('¿Anular esta venta? Los boletos volverán a estar disponibles.')) return;
  db.ventas.find(x => x.id === id).anulada = true; await save(); vVentas();
}

// ---------- usuarios (admin) ----------
function vUsuarios() {
  document.getElementById('view').innerHTML = `<div class="card"><h2>Nuevo usuario</h2>
  <div class="row"><label>Nombre<input id="n"></label><label>Usuario<input id="u"></label><label>Contraseña<input id="p" type="password"></label>
  <label>Rol<select id="r"><option value="usuario">Usuario</option><option value="admin">Administrador</option></select></label></div>
  <button class="btn" onclick="addUsuario()">Crear</button></div>
  <div class="card"><h2>Usuarios</h2><table><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Estado</th><th></th></tr>
  ${db.usuarios.map(u => `<tr><td>${esc(u.nombre)}</td><td>${esc(u.usuario)}</td><td>${u.rol}</td><td>${u.activo ? '<span class="tag ok">Activo</span>' : '<span class="tag err">Inactivo</span>'}</td>
  <td class="acts"><button class="sec" onclick="resetPass('${u.id}')">Cambiar clave</button>
  ${u.id !== user.id ? `<button class="sec" onclick="toggleUsuario('${u.id}')">${u.activo ? 'Desactivar' : 'Activar'}</button>` : ''}</td></tr>`).join('')}</table></div>`;
}
async function addUsuario() {
  const p = document.getElementById('p').value;
  if (!val('n') || !val('u') || !p) return toast('Completa todos los campos');
  if (db.usuarios.some(x => x.usuario.toLowerCase() === val('u').toLowerCase())) return toast('Ese usuario ya existe');
  db.usuarios.push(await nuevoUsuario(val('n'), val('u'), p, val('r'))); await save(); vUsuarios();
}
async function toggleUsuario(id) { const u = db.usuarios.find(x => x.id === id); u.activo = !u.activo; await save(); vUsuarios(); }
async function resetPass(id) {
  const p = prompt('Nueva contraseña:'); if (!p) return;
  const u = db.usuarios.find(x => x.id === id); u.salt = uid(); u.hash = await hash(u.salt, p); await save(); toast('Contraseña actualizada');
}

// ---------- datos ----------
function vDatos() {
  document.getElementById('view').innerHTML = `<div class="card"><h2>Almacenamiento</h2>
  <p>Modo actual: <b>${Store.modo() === 'hoja' ? 'Google Sheets (datos y PDFs en tu Drive)' : Store.modo() === 'carpeta' ? 'Carpeta "' + esc(Store.nombreCarpeta()) + '" (datos.json + pdfs/)' : 'Solo navegador (localStorage, sin PDFs)'}</b></p>
  <button class="sec" onclick="renderSetup()">Cambiar almacenamiento</button> 
  ${Store.soportaCarpeta() ? '<button class="sec" onclick="elegirCarpeta()">Cambiar / elegir carpeta</button>' : '<p class="mut">Tu navegador no permite elegir carpeta; usa Chrome o Edge para guardar en archivos.</p>'}</div>
  <div class="card"><h2>Respaldo</h2>
  <button class="sec" onclick="exportar()">Exportar datos.json</button>
  ${user.rol === 'admin' ? ' <label style="display:inline-block;margin:0 0 0 8px"><span class="sec" style="padding:6px 10px;border:1px solid var(--bd);border-radius:6px;cursor:pointer">Importar y combinar<input type="file" accept=".json" hidden onchange="importar(this.files[0])"></span></label>' : ''}</div>`;
}
const exportar = () => Store.descargar('datos.json', new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
async function importar(f) {
  if (!f || !confirm('Esto se combina con los datos actuales. ¿Continuar?')) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.usuarios) || !Array.isArray(d.lotes) || !Array.isArray(d.ventas)) throw new Error('Formato inválido');
    db = d; for (const c of colecciones) db[c].forEach(r => r.mod = Date.now()); await save(); logout(); toast('Datos importados y combinados, inicia sesión');
  } catch (e) { toast(e.message); }
}

boot();

// Etiqueta cada celda con el nombre de su columna (para mostrar las tablas como tarjetas en móvil)
function etiquetar() {
  document.querySelectorAll('table').forEach(t => {
    const heads = [...t.querySelectorAll('tr:first-child th')].map(h => h.textContent);
    t.querySelectorAll('tr').forEach(tr => [...tr.children].forEach((td, i) => {
      if (td.tagName === 'TD' && !td.hasAttribute('colspan') && heads[i] !== undefined) td.dataset.label = heads[i];
    }));
  });
}
new MutationObserver(etiquetar).observe(document.getElementById('app'), { childList: true, subtree: true });
