// Persistencia: Firebase Firestore (compartido, en tiempo real).
// Si no hay configuración de Firebase, cae a localStorage (solo ese navegador, sin PDFs).
// Los usuarios son una colección más: NO se usa Firebase Auth.
const Store = (() => {
  const LS = 'boletos.datos.v3';
  const COLS = ['usuarios', 'lotes', 'ventas', 'apartados', 'abonos'];
  const CHUNK = 700000;            // caracteres base64 por documento (Firestore: máx. 1 MiB por documento)
  const MAX_PDF = 5 * 1024 * 1024; // 5 MB por PDF
  const empty = () => ({ version: 3, usuarios: [], lotes: [], ventas: [], apartados: [], abonos: [] });

  let fs = null;
  if (typeof firebase !== 'undefined' && typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.projectId) {
    firebase.initializeApp(FIREBASE_CONFIG);
    fs = firebase.firestore();
    fs.settings({ ignoreUndefinedProperties: true });
  }

  const conTiempo = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  const aB64 = blob => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result.split(',')[1]); f.onerror = rej; f.readAsDataURL(blob); });

  return {
    modo: () => (fs ? 'firebase' : 'navegador'),
    empty,

    // Carga inicial + escucha en tiempo real. onCambio(coleccion, [{tipo, r}], esEcoLocal)
    iniciar(onCambio) {
      if (!fs) {
        let d = empty(); try { d = Object.assign(d, JSON.parse(localStorage.getItem(LS)) || {}); } catch (e) { }
        COLS.forEach(c => onCambio(c, d[c].map(r => ({ tipo: 'added', r })), false));
        return Promise.resolve();
      }
      return conTiempo(new Promise((resolve, reject) => {
        const faltan = new Set(COLS);
        COLS.forEach(c => fs.collection(c).onSnapshot(snap => {
          const ch = snap.docChanges().map(x => ({ tipo: x.type, r: x.doc.data() }));
          onCambio(c, ch, snap.metadata.hasPendingWrites);
          if (faltan.delete(c) && !faltan.size) resolve();
        }, err => reject(err)));
      }), 20000, 'Tiempo de espera agotado. Revisa tu conexión y que Firestore esté creado.');
    },

    // cambios: [{c, r}] (solo lo modificado); data: estado completo (para localStorage)
    async guardar(cambios, data) {
      if (!fs) { try { localStorage.setItem(LS, JSON.stringify(data)); } catch (e) { } return; }
      for (let i = 0; i < cambios.length; i += 400) {
        const b = fs.batch();
        cambios.slice(i, i + 400).forEach(({ c, r }) => b.set(fs.collection(c).doc(r.id), r));
        await conTiempo(b.commit(), 15000, 'Sin conexión: no se pudo guardar. Intenta de nuevo.');
      }
    },

    // PDFs como base64, partidos en trozos dentro de la colección "pdfs". Devuelve el id.
    async guardarPdf(nombre, file) {
      if (!fs) throw new Error('Los PDFs requieren Firebase');
      if (file.size > MAX_PDF) throw new Error('El PDF pesa más de 5 MB');
      const b64 = await aB64(file), id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)), n = Math.max(1, Math.ceil(b64.length / CHUNK));
      for (let i = 0; i < n; i += 4) {
        const b = fs.batch();
        for (let j = i; j < Math.min(n, i + 4); j++) b.set(fs.collection('pdfs').doc(id + '_' + j), { pdf: id, i: j, data: b64.slice(j * CHUNK, (j + 1) * CHUNK) });
        await conTiempo(b.commit(), 60000, 'Sin conexión: no se pudo subir el PDF.');
      }
      await conTiempo(fs.collection('pdfs').doc(id).set({ id, nombre, partes: n, tam: file.size, fecha: Date.now() }), 15000, 'Sin conexión: no se pudo subir el PDF.');
      return id;
    },
    async abrirPdf(id) {
      if (!fs) throw new Error('Los PDFs requieren Firebase');
      const meta = await fs.collection('pdfs').doc(id).get();
      if (!meta.exists) throw new Error('El PDF no existe');
      const partes = await Promise.all(Array.from({ length: meta.data().partes }, (_, i) => fs.collection('pdfs').doc(id + '_' + i).get()));
      const bin = atob(partes.map(p => p.data().data).join(''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: 'application/pdf' });
    }
  };
})();
