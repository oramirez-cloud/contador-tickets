/**
 * Puente entre la app de boletos y esta hoja de Google.
 * Pegar en: Extensiones > Apps Script (dentro de la hoja).
 * 1) Cambia CLAVE por una contraseña larga que solo conozcan ustedes dos.
 * 2) Implementar > Nueva implementación > Aplicación web
 *      Ejecutar como: Yo   |   Quién tiene acceso: Cualquier persona
 * 3) Copia la URL que termina en /exec y pégala en la app junto con la clave.
 * Si cambias este código después, hay que hacer una NUEVA implementación (versión nueva).
 */
const CLAVE = 'CAMBIA-ESTA-CLAVE';
const CARPETA_PDF = 'BoletosPDF';

// id | mod | json son la fuente de verdad; las demás columnas son solo para que tú leas la hoja.
const HOJAS = {
  usuarios: ['id', 'mod', 'json', 'usuario', 'nombre', 'rol', 'activo'],
  lotes: ['id', 'mod', 'json', 'artista', 'zona', 'cantidad', 'costo', 'sugerido', 'fecha', 'borrado'],
  ventas: ['id', 'mod', 'json', 'loteId', 'cantidad', 'precio', 'fecha', 'comentario', 'anulada']
};

function doGet() { return salida({ ok: true, mensaje: 'Funcionando' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000); // evita que dos escrituras se pisen
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.clave !== CLAVE) return salida({ error: 'Clave incorrecta' });
    switch (p.accion) {
      case 'leer': return salida({ data: leer() });
      case 'version': return salida({ v: version() });
      case 'guardar': { const m = fusionar(leer(), p.data); escribir(m); return salida({ data: m }); }
      case 'pdf': return salida(guardarPdf(p));
    }
    return salida({ error: 'Acción desconocida' });
  } catch (err) {
    return salida({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

const salida = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

function hoja(nombre) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.getRange(1, 1, 1, HOJAS[nombre].length).setValues([HOJAS[nombre]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function leer() {
  const out = { version: 2 };
  for (const nombre in HOJAS) {
    const sh = hoja(nombre);
    const n = sh.getLastRow() - 1;
    out[nombre] = n < 1 ? [] : sh.getRange(2, 1, n, 3).getValues().filter(r => r[0] && r[2]).map(r => JSON.parse(r[2]));
  }
  return out;
}

function version() {
  let v = 0;
  for (const nombre in HOJAS) {
    const sh = hoja(nombre), n = sh.getLastRow() - 1;
    if (n < 1) continue;
    sh.getRange(2, 2, n, 1).getValues().forEach(r => { v = Math.max(v, Number(r[0]) || 0); });
  }
  return v;
}

function fusionar(a, b) {
  const out = { version: 2 };
  for (const nombre in HOJAS) {
    const m = new Map((a[nombre] || []).map(r => [r.id, r]));
    for (const r of (b && b[nombre]) || []) {
      const o = m.get(r.id);
      if (!o || (r.mod || 0) >= (o.mod || 0)) m.set(r.id, r); // gana el más reciente
    }
    out[nombre] = [...m.values()];
  }
  return out;
}

function escribir(d) {
  for (const nombre in HOJAS) {
    const cols = HOJAS[nombre], sh = hoja(nombre);
    const extra = cols.slice(3);
    const filas = d[nombre].map(r => [r.id, r.mod || 0, JSON.stringify(r)].concat(extra.map(k => r[k] === undefined ? '' : r[k])));
    const viejas = sh.getLastRow() - 1;
    if (viejas > 0) sh.getRange(2, 1, viejas, cols.length).clearContent();
    if (filas.length) sh.getRange(2, 1, filas.length, cols.length).setValues(filas);
  }
}

function guardarPdf(p) {
  const it = DriveApp.getFoldersByName(CARPETA_PDF);
  const carpeta = it.hasNext() ? it.next() : DriveApp.createFolder(CARPETA_PDF);
  const blob = Utilities.newBlob(Utilities.base64Decode(p.base64), 'application/pdf', p.nombre);
  return { url: carpeta.createFile(blob).getUrl() };
}
