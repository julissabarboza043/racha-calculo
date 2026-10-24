// Lee el archivo de ejercicios (formato descrito en FORMATO_EJERCICIOS.md)
// y lo convierte en la lista que se guarda en la base de datos.

export const KIND_LABEL = {
  seleccion: 'Selección única',
  numerica: 'Respuesta numérica',
  vf: 'Verdadero o falso',
  completar: 'Completar',
};

const BLOCK_START = /^\s*={3,}\s*EJERCICIO\s*={3,}\s*$/i;
const FIELD = /^\s*([A-Za-zÁÉÍÓÚáéíóúñÑ ]{3,20}?)\s*:\s*(.*)$/;
const KNOWN = new Set(['fecha', 'modalidad', 'tipo', 'tema', 'puntos', 'enunciado', 'opciones',
  'respuesta', 'respuestas', 'tolerancia', 'explicacion']);
export const BLANK = /\[\[\s*([A-Za-z0-9]{1,3})\s*\]\]/g;

const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function parseNumber(t) {
  t = String(t ?? '').replace(/\s+/g, '').replace(/,/g, '.').replace(/−/g, '-');
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  const m = t.match(/^([-+]?(?:\d+\.?\d*|\.\d+))\/([-+]?(?:\d+\.?\d*|\.\d+))$/);
  if (m && Number(m[2]) !== 0) return Number(m[1]) / Number(m[2]);
  return null;
}

function parseDate(v) {
  v = v.trim();
  let m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return iso(+m[3], +m[2], +m[1]);
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  return null;
}

function iso(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseKind(v) {
  const p = plain(v);
  if (p.includes('seleccion') || p.includes('marque')) return 'seleccion';
  if (p.includes('numer')) return 'numerica';
  if (p.includes('verdadero') || p.includes('falso') || p === 'v/f' || p === 'vf') return 'vf';
  if (p.includes('complet')) return 'completar';
  return null;
}

function parseMode(v) {
  const p = plain(v);
  if (p.startsWith('diari')) return 'diario';
  if (p.startsWith('opcion') || p.startsWith('extra')) return 'opcional';
  return null;
}

const alternatives = (s) => s.split('|').map((x) => x.trim()).filter(Boolean);

// Divide el texto en bloques y cada bloque en campos.
function splitBlocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  let field = null;
  lines.forEach((line, i) => {
    if (BLOCK_START.test(line)) {
      cur = { line: i + 1, fields: {} };
      blocks.push(cur);
      field = null;
      return;
    }
    if (!cur) return; // texto antes del primer bloque: se ignora (sirve para notas)
    const m = field !== 'explicacion' && line.match(FIELD);
    const key = m && plain(m[1]).replace(/\s+/g, '_');
    if (m && KNOWN.has(key)) {
      field = key;
      cur.fields[field] = m[2];
    } else if (field) {
      cur.fields[field] += '\n' + line;
    }
  });
  for (const b of blocks) {
    for (const k of Object.keys(b.fields)) b.fields[k] = b.fields[k].trim();
  }
  return blocks;
}

function parseOptions(raw, err) {
  const opts = [];
  let correct = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\*)?\s*([a-hA-H])\s*[\)\.]\s*(.*)$/);
    if (m) {
      if (m[1]) correct.push(opts.length);
      opts.push(m[3].trim());
    } else if (opts.length && line.trim()) {
      opts[opts.length - 1] += '\n' + line.trim();
    }
  }
  if (opts.length < 2) err('La selección única necesita al menos 2 opciones (a), b), …).');
  if (correct.length !== 1) err('Marque exactamente una opción correcta con * al inicio (ej. "*b) …").');
  return { opts, correct: correct[0] };
}

/**
 * @param {string} text contenido del archivo
 * @param {{start_date?:string,end_date?:string}} course para avisos de fechas
 * @returns {{items:object[], errors:string[], warnings:string[]}}
 */
export function parseExercises(text, course = {}) {
  const items = [];
  const errors = [];
  const warnings = [];
  const blocks = splitBlocks(text);
  if (!blocks.length) errors.push('No encontré ningún bloque "=== EJERCICIO ===".');

  blocks.forEach((b, idx) => {
    const f = b.fields;
    const where = `Ejercicio ${idx + 1} (línea ${b.line})`;
    const err = (m) => errors.push(`${where}: ${m}`);
    const warn = (m) => warnings.push(`${where}: ${m}`);

    const release_date = f.fecha ? parseDate(f.fecha) : null;
    if (!release_date) err(`fecha inválida o faltante ("${f.fecha ?? ''}"). Use día/mes/año, ej. 26/10/2026.`);
    const mode = f.modalidad ? parseMode(f.modalidad) : 'diario';
    if (!mode) err(`modalidad debe ser "diario" u "opcional" (decía "${f.modalidad}").`);
    const kind = f.tipo ? parseKind(f.tipo) : null;
    if (!kind) err(`tipo inválido o faltante ("${f.tipo ?? ''}").`);
    const statement = f.enunciado ?? '';
    if (!statement) err('falta el enunciado.');
    const points = f.puntos ? parseInt(f.puntos, 10) : 100;
    if (!(points > 0)) err('puntos debe ser un número entero positivo.');
    const tol = f.tolerancia ? parseNumber(f.tolerancia) : 0.01;
    if (tol === null || tol < 0) err('tolerancia inválida.');
    if (!f.explicacion) warn('no tiene explicación; los estudiantes no verán la solución.');

    let options = null;
    let answer = null;
    if (kind === 'seleccion') {
      const { opts, correct } = parseOptions(f.opciones ?? '', err);
      options = opts;
      answer = { correct };
    } else if (kind === 'numerica') {
      const acc = alternatives(f.respuesta ?? '');
      if (!acc.length) err('falta "respuesta:".');
      for (const a of acc) if (parseNumber(a) === null) err(`"${a}" no es un número (use 0.5, 1/2 o -3).`);
      answer = { accepted: acc, tol };
    } else if (kind === 'vf') {
      const p = plain(f.respuesta ?? '');
      const value = ['verdadero', 'v', 'cierto', 'true'].includes(p) ? true
        : ['falso', 'f', 'false'].includes(p) ? false : null;
      if (value === null) err('la respuesta debe ser "verdadero" o "falso".');
      answer = { value };
    } else if (kind === 'completar') {
      const labels = [...statement.matchAll(BLANK)].map((m) => m[1].toUpperCase());
      const unique = [...new Set(labels)];
      if (!unique.length) err('el enunciado no tiene espacios para completar. Use [[A]], [[B]], …');
      const blanks = {};
      for (const line of (f.respuestas ?? f.respuesta ?? '').split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9]{1,3})\s*[=:]\s*(.+)$/);
        if (m) blanks[m[1].toUpperCase()] = alternatives(m[2]);
      }
      for (const l of unique) if (!blanks[l]?.length) err(`falta la respuesta del espacio ${l} (ej. "${l} = 6").`);
      for (const l of Object.keys(blanks)) if (!unique.includes(l)) err(`la respuesta ${l} no tiene un [[${l}]] en el enunciado.`);
      options = unique;
      answer = { blanks, tol };
    }

    if (release_date) {
      const dow = new Date(release_date + 'T12:00:00Z').getUTCDay();
      if (mode === 'diario' && (dow === 0 || dow === 6)) {
        warn(`el ${fmtDate(release_date)} es fin de semana; los diarios deberían ir de lunes a viernes.`);
      }
      if (course.start_date && release_date < course.start_date) warn(`la fecha ${fmtDate(release_date)} es antes del inicio del curso.`);
      if (course.end_date && release_date > course.end_date) warn(`la fecha ${fmtDate(release_date)} es después del fin del curso.`);
    }

    items.push({
      release_date, mode, kind, topic: f.tema || null, statement, options, points,
      position: idx, answer, explanation: f.explicacion ?? '',
    });
  });

  const daily = {};
  for (const it of items) if (it.mode === 'diario' && it.release_date) daily[it.release_date] = (daily[it.release_date] ?? 0) + 1;
  for (const [d, n] of Object.entries(daily)) {
    if (n > 1) warnings.push(`El ${fmtDate(d)} tiene ${n} ejercicios diarios: para mantener la racha tendrán que hacer todos. ¿Quería que alguno fuera "opcional"?`);
  }
  return { items, errors, warnings };
}

export function fmtDate(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}
