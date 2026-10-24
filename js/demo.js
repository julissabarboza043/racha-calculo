// Modo demo: una copia en JavaScript de las reglas de supabase/schema.sql que guarda
// todo en este navegador. Sirve para probar la app antes de conectar Supabase.
import { parseExercises, parseNumber } from './parser.js';
import { RULES, multiplier, attemptFactor, timingMultiplier } from './rules.js';

const DB_KEY = 'racha-demo-db';
const NOW_KEY = 'racha-demo-now';
const ME = 'demo-yo';
let db = null;
let simulatedNow = null; // solo mientras se generan datos de compañeros falsos

// ---------------- hora simulada ----------------
export function demoNow() {
  try {
    const v = localStorage.getItem(NOW_KEY);
    if (v) return new Date(v);
  } catch (e) { /* sin almacenamiento */ }
  const real = new Date();
  return real < new Date('2026-10-26T07:00:00Z') ? new Date('2026-10-28T09:00:00-06:00') : real;
}
export function setDemoNow(date) {
  try { localStorage.setItem(NOW_KEY, date.toISOString()); } catch (e) { /* nada */ }
}
export function resetDemo() {
  try { localStorage.removeItem(DB_KEY); localStorage.removeItem(NOW_KEY); } catch (e) { /* nada */ }
  db = null;
}
const now = () => simulatedNow ?? demoNow();

// ---------------- utilidades ----------------
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const releaseAt = (d) => new Date(`${d}T01:00:00-06:00`);
function nextWeekday(d) {
  const dt = new Date(d + 'T12:00:00Z');
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() + (dow === 5 ? 3 : dow === 6 ? 2 : 1));
  return dt.toISOString().slice(0, 10);
}
const onTimeEnd = (d) => releaseAt(nextWeekday(d));
const recoverEnd = (d) => releaseAt(nextWeekday(nextWeekday(d)));
const t = (iso) => new Date(iso).getTime();
const normText = (s) => String(s ?? '').replace(/[\s*]+/g, '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/−/g, '-');

function save() {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* nada */ }
}

async function ensure() {
  if (db) return;
  try { db = JSON.parse(localStorage.getItem(DB_KEY)); } catch (e) { db = null; }
  if (!db) await seed();
}

// ---------------- reglas (iguales a schema.sql) ----------------
function matchValue(input, accepted, tol) {
  if (input == null || String(input).trim() === '') return false;
  const x = parseNumber(input);
  return accepted.some((a) => {
    const y = parseNumber(a);
    return x !== null && y !== null ? Math.abs(x - y) <= tol + 1e-12 : normText(input) === normText(a);
  });
}

function checkAnswer(kind, key, ans) {
  const tol = key.tol ?? 0.01;
  if (kind === 'seleccion') return Number(ans.choice) === key.correct;
  if (kind === 'vf') return ans.value === key.value;
  if (kind === 'numerica') return matchValue(ans.value, key.accepted, tol);
  if (kind === 'completar') return Object.entries(key.blanks).every(([l, acc]) => matchValue(ans.values?.[l], acc, tol));
  return false;
}

const solvesOf = (user, at) => db.solves.filter((s) => s.user_id === user && t(s.solved_at) <= at.getTime());
const hasWildcard = (user, course, day, at) => db.wildcards.some((w) => w.user_id === user && w.course_id === course
  && w.day === day && (!at || t(w.used_at) <= at.getTime()));

function streakAt(user, course, at) {
  const solved = new Map(solvesOf(user, at).map((s) => [s.exercise_id, s]));
  const days = new Map();
  for (const e of db.exercises) {
    if (e.course_id !== course || e.mode !== 'diario' || releaseAt(e.release_date) > at) continue;
    if (!days.has(e.release_date)) days.set(e.release_date, []);
    days.get(e.release_date).push(e);
  }
  let s = 0;
  for (const day of [...days.keys()].sort()) {
    const ex = days.get(day);
    const done = ex.map((e) => solved.get(e.id)).filter(Boolean);
    const doneAt = Math.max(...done.map((x) => t(x.solved_at)));
    const all = done.length === ex.length;
    if (hasWildcard(user, course, day, at)) continue;
    if (all && doneAt <= onTimeEnd(day).getTime()) s += 1;
    else if (all && doneAt <= recoverEnd(day).getTime()) s = Math.max(s - RULES.diasPerdidosRecuperar, 0);
    else if (at < recoverEnd(day)) { /* pendiente */ } else s = 0;
  }
  return s;
}

function exerciseTiming(user, e, at) {
  if (e.mode === 'opcional') return 'opcional';
  if (hasWildcard(user, e.course_id, e.release_date)) return 'tarde';
  if (at <= onTimeEnd(e.release_date)) return 'a_tiempo';
  if (at <= recoverEnd(e.release_date)) return 'recuperar';
  return 'tarde';
}

function wildcardProblem(user, course, day, at) {
  const ex = db.exercises.filter((e) => e.course_id === course && e.mode === 'diario' && e.release_date === day);
  const solved = ex.filter((e) => db.solves.some((s) => s.user_id === user && s.exercise_id === e.id));
  const month = day.slice(0, 7);
  if (!ex.length || releaseAt(day) > at) return 'Ese día no tiene ejercicio diario.';
  if (hasWildcard(user, course, day)) return 'Ya usó un comodín para ese día.';
  if (solved.length === ex.length) return 'Ese día ya está resuelto.';
  if (at <= onTimeEnd(day)) return 'Todavía está a tiempo de resolverlo.';
  if (at > recoverEnd(day)) return 'Ya pasó el plazo para salvar la racha de ese día.';
  const used = db.wildcards.filter((w) => w.user_id === user && w.course_id === course && w.day.slice(0, 7) === month).length;
  if (used >= RULES.comodinesPorMes) return 'Ya usó su comodín de este mes.';
  return null;
}

function enrolled(user, course) {
  return db.enrollments.some((en) => en.user_id === user && en.course_id === course);
}

function submitAs(user, exerciseId, answer) {
  const at = now();
  const e = db.exercises.find((x) => x.id === exerciseId);
  if (!e) throw new Error('Ejercicio no encontrado.');
  if (!enrolled(user, e.course_id)) throw new Error('No está inscrito en este curso.');
  if (releaseAt(e.release_date) > at) throw new Error('Este ejercicio todavía no se ha liberado.');
  const prev = db.solves.find((s) => s.user_id === user && s.exercise_id === e.id);
  if (prev) return { correct: true, already: true, points: prev.points };

  const key = db.keys[e.id];
  const ok = checkAnswer(e.kind, key.answer, answer);
  let fails = db.attempts.filter((a) => a.user_id === user && a.exercise_id === e.id && !a.correct).length;
  db.attempts.push({ user_id: user, exercise_id: e.id, answer, correct: ok, created_at: at.toISOString() });
  if (!ok) {
    fails += 1;
    save();
    return { correct: false, fails, next_factor: attemptFactor(fails) };
  }
  const timing = exerciseTiming(user, e, at);
  const m = timingMultiplier(timing, multiplier(streakAt(user, e.course_id, at)));
  const points = Math.round(+(e.points * attemptFactor(fails) * m).toFixed(6)); // como round() de PostgreSQL
  db.solves.push({ user_id: user, exercise_id: e.id, solved_at: at.toISOString(), attempts: fails + 1, timing, multiplier: m, points });
  save();
  return { correct: true, points, multiplier: m, attempts: fails + 1, timing, explanation: key.explanation,
    streak: streakAt(user, e.course_id, at) };
}

// ---------------- datos de ejemplo ----------------
const FAKE = [
  ['Valeria Mora', 0.95, 0.05, 1], ['Andrés Solís', 0.85, 0.10, 3], ['Camila Rojas', 0.75, 0.15, 2],
  ['Diego Vargas', 0.6, 0.2, 4], ['Sofía Jiménez', 0.9, 0.0, 2], ['Mateo Chaves', 0.45, 0.25, 5],
  ['Daniela Quesada', 0.7, 0.1, 1], ['José Pablo Arias', 0.55, 0.2, 3], ['Fernanda Calvo', 0.8, 0.1, 2],
  ['Luis Alfaro', 0.4, 0.3, 4],
];

function rng(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

function correctAnswer(kind, key) {
  if (kind === 'seleccion') return { choice: key.correct };
  if (kind === 'vf') return { value: key.value };
  if (kind === 'numerica') return { value: key.accepted[0] };
  return { values: Object.fromEntries(Object.entries(key.blanks).map(([l, a]) => [l, a[0]])) };
}

function wrongAnswer(kind, key, r, nOptions) {
  if (kind === 'seleccion') {
    let c = Math.floor(r() * nOptions);
    if (c === key.correct) c = (c + 1) % nOptions;
    return { choice: c };
  }
  if (kind === 'vf') return { value: !key.value };
  if (kind === 'numerica') return { value: ['0', '1', '-1', '2'][Math.floor(r() * 4)] };
  return { values: Object.fromEntries(Object.keys(key.blanks).map((l) => [l, String(Math.floor(r() * 5))])) };
}

async function seed() {
  db = { courses: [], groups: [], enrollments: [], profiles: [], exercises: [], keys: {}, attempts: [], solves: [], wildcards: [] };
  const course = { id: 'demo-curso', name: 'MA1002 Cálculo II (demo)', start_date: '2026-10-26', end_date: '2026-11-27',
    timezone: 'America/Costa_Rica', release_time: '01:00', archived: false, created_at: new Date().toISOString() };
  db.courses.push(course);
  db.groups.push({ id: 'demo-g1', course_id: course.id, name: 'Grupo 01', join_code: 'DEMO01' });
  db.groups.push({ id: 'demo-g2', course_id: course.id, name: 'Grupo 02', join_code: 'DEMO02' });

  try {
    const text = await (await fetch('ejercicios/semana1.txt', { cache: 'no-store' })).text();
    importItems(course.id, parseExercises(text).items.filter((it) => it.release_date && it.answer));
  } catch (e) {
    console.warn('No se pudieron cargar los ejercicios de ejemplo', e);
  }

  // Compañeros ficticios con distintos hábitos, para ver el ranking y las gráficas.
  const events = [];
  FAKE.forEach(([name, pOnTime, pRecover, maxFails], i) => {
    const id = 'fake-' + i;
    db.profiles.push({ id, full_name: name, email: null });
    db.enrollments.push({ user_id: id, course_id: course.id, group_id: i % 3 === 2 ? 'demo-g2' : 'demo-g1' });
    const r = rng(1000 + i * 77);
    for (const e of db.exercises) {
      const roll = r();
      let when;
      if (e.mode === 'opcional') {
        if (roll > pOnTime - 0.2) continue;
        when = new Date(releaseAt(e.release_date).getTime() + (8 + r() * 14) * 3600e3);
      } else if (roll < pOnTime) {
        when = new Date(releaseAt(e.release_date).getTime() + (6 + r() * 16) * 3600e3);
      } else if (roll < pOnTime + pRecover) {
        when = new Date(onTimeEnd(e.release_date).getTime() + (8 + r() * 12) * 3600e3);
      } else continue;
      const fails = Math.floor(r() * r() * (maxFails + 1));
      for (let k = 0; k < fails; k++) {
        events.push({ user: id, e, at: new Date(when.getTime() + k * 60e3), wrong: true, r });
      }
      events.push({ user: id, e, at: new Date(when.getTime() + fails * 60e3 + 30e3) });
    }
  });
  events.sort((a, b) => a.at - b.at);
  for (const ev of events) {
    simulatedNow = ev.at;
    const key = db.keys[ev.e.id].answer;
    submitAs(ev.user, ev.e.id, ev.wrong ? wrongAnswer(ev.e.kind, key, ev.r, ev.e.options?.length ?? 2) : correctAnswer(ev.e.kind, key));
  }
  simulatedNow = null;
  save();
}

function importItems(courseId, items) {
  for (const it of items) {
    const id = newId();
    db.exercises.push({ id, course_id: courseId, release_date: it.release_date, mode: it.mode, kind: it.kind, topic: it.topic,
      statement: it.statement, options: it.options, points: it.points, position: it.position, created_at: new Date().toISOString() });
    db.keys[id] = { answer: it.answer, explanation: it.explanation };
  }
  return items.length;
}

// ---------------- API (misma forma que la de Supabase) ----------------
const visible = (rows, field) => rows.filter((r) => t(r[field]) <= now().getTime());

export const demoApi = {
  async getSession() { return { user: { email: 'profe@demo', user_metadata: { full_name: '' } } }; },
  onAuthChange() {},
  async signInGoogle() {}, async signInEmail() {}, async signUpEmail() { return {}; },
  async signOut() { resetDemo(); location.reload(); },

  async myState() {
    await ensure();
    const me = db.profiles.find((p) => p.id === ME);
    return {
      is_teacher: true,
      full_name: me?.full_name ?? null,
      courses: db.courses.filter((c) => !c.archived).map((c) => {
        const en = db.enrollments.find((x) => x.user_id === ME && x.course_id === c.id);
        return { id: c.id, name: c.name, start_date: c.start_date, end_date: c.end_date,
          group_name: en ? db.groups.find((g) => g.id === en.group_id)?.name : null, enrolled: !!en };
      }),
    };
  },

  async joinCourse(code, name) {
    await ensure();
    if (!name?.trim()) throw new Error('Escriba su nombre completo.');
    const g = db.groups.find((x) => x.join_code.toUpperCase() === code.trim().toUpperCase());
    if (!g) throw new Error('Ese código no existe. Revíselo con la profesora.');
    const p = db.profiles.find((x) => x.id === ME);
    if (p) p.full_name = name.trim(); else db.profiles.push({ id: ME, full_name: name.trim(), email: 'profe@demo' });
    db.enrollments = db.enrollments.filter((x) => !(x.user_id === ME && x.course_id === g.course_id));
    db.enrollments.push({ user_id: ME, course_id: g.course_id, group_id: g.id });
    save();
    return { course_id: g.course_id };
  },

  async dashboard(courseId) {
    await ensure();
    const at = now();
    const c = db.courses.find((x) => x.id === courseId);
    const s = streakAt(ME, courseId, at);
    const mine = new Map(db.solves.filter((x) => x.user_id === ME).map((x) => [x.exercise_id, x]));
    const exercises = db.exercises
      .filter((e) => e.course_id === courseId && releaseAt(e.release_date) <= at)
      .sort((a, b) => (b.release_date.localeCompare(a.release_date)) || a.position - b.position)
      .map((e) => {
        const sv = mine.get(e.id);
        return { ...e, on_time_until: onTimeEnd(e.release_date).toISOString(), recover_until: recoverEnd(e.release_date).toISOString(),
          timing: sv?.timing ?? exerciseTiming(ME, e, at), solved: !!sv, earned: sv?.points ?? null,
          earned_multiplier: sv?.multiplier ?? null,
          fails: db.attempts.filter((a) => a.user_id === ME && a.exercise_id === e.id && !a.correct).length,
          explanation: sv ? db.keys[e.id].explanation : null, wildcard_used: hasWildcard(ME, courseId, e.release_date) };
      });
    const future = db.exercises.filter((e) => e.course_id === courseId && releaseAt(e.release_date) > at)
      .map((e) => releaseAt(e.release_date)).sort((a, b) => a - b);
    const dailyDays = [...new Set(db.exercises.filter((e) => e.course_id === courseId && e.mode === 'diario').map((e) => e.release_date))];
    const month = new Date(at.getTime() - 6 * 3600e3).toISOString().slice(0, 7);
    return {
      now: at.toISOString(), course: c, streak: s, multiplier: multiplier(s),
      total_points: db.solves.filter((x) => x.user_id === ME).reduce((acc, x) => acc + x.points, 0),
      next_release: future[0]?.toISOString() ?? null,
      exercises,
      wildcard_days: dailyDays.filter((d) => wildcardProblem(ME, courseId, d, at) === null).sort(),
      wildcards_left: Math.max(RULES.comodinesPorMes - db.wildcards.filter((w) => w.user_id === ME && w.course_id === courseId && w.day.slice(0, 7) === month).length, 0),
    };
  },

  async submit(exerciseId, answer) { await ensure(); return submitAs(ME, exerciseId, answer); },

  async useWildcard(courseId, day) {
    await ensure();
    const problem = wildcardProblem(ME, courseId, day, now());
    if (problem) throw new Error(problem);
    db.wildcards.push({ user_id: ME, course_id: courseId, day, used_at: now().toISOString() });
    save();
    return { ok: true, streak: streakAt(ME, courseId, now()) };
  },

  async leaderboard(courseId) {
    await ensure();
    const at = now();
    const ids = new Set(db.exercises.filter((e) => e.course_id === courseId).map((e) => e.id));
    return db.enrollments.filter((en) => en.course_id === courseId).map((en) => {
      const sv = visible(db.solves, 'solved_at').filter((s) => s.user_id === en.user_id && ids.has(s.exercise_id));
      return { user_id: en.user_id, full_name: db.profiles.find((p) => p.id === en.user_id)?.full_name ?? '?',
        group_name: db.groups.find((g) => g.id === en.group_id)?.name, points: sv.reduce((a, s) => a + s.points, 0),
        streak: streakAt(en.user_id, courseId, at), solved: sv.length, is_me: en.user_id === ME };
    }).sort((a, b) => b.points - a.points || b.streak - a.streak || a.full_name.localeCompare(b.full_name));
  },

  // --- profesora ---
  async importExercises(courseId, items) { await ensure(); const n = importItems(courseId, items); save(); return n; },
  async listCourses() { await ensure(); return [...db.courses]; },
  async createCourse(c) {
    await ensure();
    const row = { id: newId(), timezone: 'America/Costa_Rica', release_time: '01:00', archived: false, created_at: new Date().toISOString(), ...c };
    db.courses.unshift(row); save(); return row;
  },
  async updateCourse(id, c) { await ensure(); Object.assign(db.courses.find((x) => x.id === id), c); save(); },
  async listGroups(courseId) { await ensure(); return db.groups.filter((g) => g.course_id === courseId); },
  async createGroup(courseId, name) {
    await ensure();
    const row = { id: newId(), course_id: courseId, name, join_code: Math.random().toString(36).slice(2, 8).toUpperCase() };
    db.groups.push(row); save(); return row;
  },
  async listExercises(courseId) {
    await ensure();
    return db.exercises.filter((e) => e.course_id === courseId)
      .sort((a, b) => a.release_date.localeCompare(b.release_date) || a.position - b.position)
      .map((e) => ({ ...e, exercise_keys: db.keys[e.id] }));
  },
  async deleteExercise(id) {
    await ensure();
    db.exercises = db.exercises.filter((e) => e.id !== id);
    delete db.keys[id];
    db.attempts = db.attempts.filter((a) => a.exercise_id !== id);
    db.solves = db.solves.filter((s) => s.exercise_id !== id);
    save();
  },
  async statsData(courseId) {
    await ensure();
    const exercises = await this.listExercises(courseId);
    const ids = new Set(exercises.map((e) => e.id));
    return {
      exercises,
      attempts: visible(db.attempts, 'created_at').filter((a) => ids.has(a.exercise_id)),
      solves: visible(db.solves, 'solved_at').filter((s) => ids.has(s.exercise_id)),
      enrollments: db.enrollments.filter((en) => en.course_id === courseId).map((en) => ({
        ...en, profiles: db.profiles.find((p) => p.id === en.user_id), groups: db.groups.find((g) => g.id === en.group_id) })),
      now: now().toISOString(),
    };
  },
};
