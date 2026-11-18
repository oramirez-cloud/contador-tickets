// Persistencia lado cliente. Tres modos:
//  - 'hoja'      : Google Sheets vía Apps Script (compartido entre varias personas, sin carpeta)
//  - 'carpeta'   : datos.json + pdfs/ en una carpeta (Chrome/Edge)
//  - 'navegador' : localStorage (solo ese navegador)
const Store = (() => {
  const LS = 'boletos.datos.v2', LSH = 'boletos.hoja', DB = 'boletos-handles';
  let dir = null, hoja = null;
  try { hoja = JSON.parse(localStorage.getItem(LSH)); } catch (e) { }
  if (typeof CONFIG !== 'undefined' && CONFIG.url && CONFIG.clave) hoja = { url: CONFIG.url, clave: CONFIG.clave }; // config.js manda
  const empty = () => ({ version: 2, usuarios: [], lotes: [], ventas: [], apartados: [], abonos: [] });

  // text/plain evita el preflight CORS que Apps Script no soporta
  async function llamar(accion, extra = {}) {
    const r = await fetch(hoja.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ clave: hoja.clave, accion, ...extra }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  }
  const b64 = blob => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result.split(',')[1]); f.onerror = rej; f.readAsDataURL(blob); });

  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const idbGet = async k => { const d = await idb(); return new Promise(r => { const q = d.transaction('h').objectStore('h').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); };
  const idbSet = async (k, v) => { const d = await idb(); return new Promise(r => { const t = d.transaction('h', 'readwrite'); t.objectStore('h').put(v, k); t.oncomplete = r; }); };

  async function readJson() {
    try { return JSON.parse(await (await (await dir.getFileHandle('datos.json')).getFile()).text()); }
    catch (e) { return null; }
  }

  return {
    soportaCarpeta: () => 'showDirectoryPicker' in window,
    modo: () => (hoja ? 'hoja' : dir ? 'carpeta' : 'navegador'),
    compartido() { return this.modo() !== 'navegador'; },
    nombreCarpeta: () => (hoja ? 'Google Sheets' : dir?.name),

    // Devuelve 'ok' | 'permiso' | 'ninguna'
    async recordada() {
      if (hoja) return 'ok';
      if (!this.soportaCarpeta()) return 'ninguna';
      const h = await idbGet('dir');
      if (!h) return 'ninguna';
      dir = h;
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return 'ok';
      return 'permiso';
    },
    async reconectar() {
      if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permiso denegado');
    },
    async elegirCarpeta() {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'boletos' });
      hoja = null; localStorage.removeItem(LSH);
      await idbSet('dir', dir);
    },
    async conectarHoja(url, clave) {
      const prev = hoja;
      hoja = { url, clave };
      try { await llamar('version'); } catch (e) { hoja = prev; throw new Error('No se pudo conectar: ' + e.message); }
      localStorage.setItem(LSH, JSON.stringify(hoja)); dir = null;
    },
    usarNavegador() { dir = null; hoja = null; localStorage.removeItem(LSH); },

    async cargar() {
      let d = null;
      if (hoja) d = (await llamar('leer')).data;
      else if (dir) d = await readJson();
      else { try { d = JSON.parse(localStorage.getItem(LS)); } catch (e) { } }
      return Object.assign(empty(), d || {}); // asegura arreglos nuevos en datos viejos
    },
    // En modo hoja devuelve los datos ya combinados por el servidor
    async guardar(data) {
      const s = JSON.stringify(data, null, 2);
      try { localStorage.setItem(LS, s); } catch (e) { }
      if (hoja) return (await llamar('guardar', { data })).data;
      if (dir) {
        const w = await (await dir.getFileHandle('datos.json', { create: true })).createWritable();
        await w.write(s); await w.close();
      }
      return data;
    },
    async leerDisco() {
      if (hoja) return (await llamar('leer')).data;
      return dir ? readJson() : null;
    },
    async modificado() {
      if (hoja) return (await llamar('version')).v;
      try { return (await (await dir.getFileHandle('datos.json')).getFile()).lastModified; } catch (e) { return 0; }
    },

    // Devuelve ruta (carpeta) o URL de Drive (hoja); null si no hay dónde guardar
    async guardarPdf(nombre, blob) {
      if (hoja) return (await llamar('pdf', { nombre, base64: await b64(blob) })).url;
      if (!dir) return null;
      const sub = await dir.getDirectoryHandle('pdfs', { create: true });
      const w = await (await sub.getFileHandle(nombre, { create: true })).createWritable();
      await w.write(blob); await w.close();
      return 'pdfs/' + nombre;
    },
    async abrirPdf(ruta) {
      const sub = await dir.getDirectoryHandle('pdfs');
      return (await (await sub.getFileHandle(ruta.replace('pdfs/', ''))).getFile());
    },
    descargar(nombre, blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
    empty
  };
})();
