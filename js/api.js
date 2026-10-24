// Capa de datos: habla con Supabase, o con la base de datos de prueba (modo demo).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const IS_DEMO = !SUPABASE_URL || new URLSearchParams(location.search).has('demo');

function check({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}

// Supabase entrega como máximo 1000 filas por consulta: pedimos por páginas.
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function supabaseApi() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const rpc = async (fn, args) => check(await sb.rpc(fn, args));
  const redirectTo = location.origin + location.pathname;

  return {
    async getSession() { return (await sb.auth.getSession()).data.session; },
    onAuthChange(cb) { sb.auth.onAuthStateChange((event) => { if (event !== 'TOKEN_REFRESHED') cb(event); }); },
    async signInGoogle() { check(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })); },
    async signInEmail(email, password) { check(await sb.auth.signInWithPassword({ email, password })); },
    async signUpEmail(email, password) {
      const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } }));
      return { needsConfirm: !data.session };
    },
    async signOut() { await sb.auth.signOut(); },

    myState: () => rpc('my_state'),
    joinCourse: (code, name) => rpc('join_course', { p_code: code, p_name: name }),
    dashboard: (courseId) => rpc('student_dashboard', { p_course: courseId }),
    submit: (exerciseId, answer) => rpc('submit_answer', { p_exercise: exerciseId, p_answer: answer }),
    useWildcard: (courseId, day) => rpc('use_wildcard', { p_course: courseId, p_day: day }),
    leaderboard: (courseId) => rpc('leaderboard', { p_course: courseId }),

    // --- profesora ---
    importExercises: (courseId, items) => rpc('import_exercises', { p_course: courseId, p_items: items }),
    async listCourses() { return check(await sb.from('courses').select('*').order('created_at', { ascending: false })); },
    async createCourse(c) { return check(await sb.from('courses').insert(c).select().single()); },
    async updateCourse(id, c) { check(await sb.from('courses').update(c).eq('id', id)); },
    async listGroups(courseId) { return check(await sb.from('groups').select('*').eq('course_id', courseId).order('name')); },
    async createGroup(courseId, name) { return check(await sb.from('groups').insert({ course_id: courseId, name }).select().single()); },
    async listExercises(courseId) {
      return check(await sb.from('exercises').select('*, exercise_keys(answer, explanation)')
        .eq('course_id', courseId).order('release_date').order('position'));
    },
    async deleteExercise(id) { check(await sb.from('exercises').delete().eq('id', id)); },
    async statsData(courseId) {
      const exercises = await this.listExercises(courseId);
      const ids = exercises.map((e) => e.id);
      const [attempts, solves, enrollments] = await Promise.all([
        ids.length ? fetchAll(() => sb.from('attempts').select('user_id, exercise_id, answer, correct, created_at').in('exercise_id', ids).order('id')) : [],
        ids.length ? fetchAll(() => sb.from('solves').select('*').in('exercise_id', ids)) : [],
        fetchAll(() => sb.from('enrollments').select('user_id, group_id, profiles(full_name, email), groups(name)').eq('course_id', courseId)),
      ]);
      return { exercises, attempts, solves, enrollments, now: new Date().toISOString() };
    },
  };
}

export const api = IS_DEMO ? (await import('./demo.js')).demoApi : await supabaseApi();
