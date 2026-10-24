import { api, IS_DEMO } from './api.js';
import { LOGIN_GOOGLE, LOGIN_EMAIL } from './config.js';
import { parseExercises, KIND_LABEL, fmtDate } from './parser.js';
import { RULES, attemptFactor, timingMultiplier, multiplier } from './rules.js';
import { esc, mathHTML, typeset } from './render.js';

const $app = document.getElementById('app');
const state = { me: null, courseId: null, timers: [], charts: [], openExercise: null };

// =============================== utilidades ===============================
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const TZ = 'America/Costa_Rica';
const fmtDateTime = (iso) => new Date(iso).toLocaleString('es-CR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
const fmtDay = (isoDate) => {
  const d = new Date(isoDate + 'T12:00:00Z');
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
};
const fmtMult = (m) => '×' + Number(m).toFixed(2);
const crDate = (date) => new Date(date.getTime() - 6 * 3600e3).toISOString().slice(0, 10);

function toast(msg, ms = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function setView(html) {
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  $app.innerHTML = html;
  typeset($app);
}

function startCountdowns() {
  const tick = () => {
    document.querySelectorAll('[data-until]').forEach((el) => {
      const ms = new Date(el.dataset.until) - nowMs();
      if (ms <= 0) { el.textContent = '¡ya!'; return; }
      const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1e3) % 60;
      el.textContent = h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h ${String(m).padStart(2, '0')} min ${String(s).padStart(2, '0')} s`;
    });
  };
  tick();
  state.timers.push(setInterval(tick, 1000));
}

let demoNowFn = null;
const nowMs = () => (demoNowFn ? demoNowFn().getTime() : Date.now());

async function guard(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message || String(e), 5000); } finally { if (btn) btn.disabled = false; }
}

// =============================== tema ===============================
document.getElementById('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('tema', root.dataset.theme); } catch (e) { /* nada */ }
  if (location.hash.startsWith('#/profe')) route();
});

document.getElementById('logout').addEventListener('click', async () => {
  await api.signOut();
  state.me = null;
  location.hash = '#/';
  route();
});

// =============================== arranque y rutas ===============================
async function boot() {
  if (IS_DEMO) await setupDemoBanner();
  api.onAuthChange(() => { state.me = null; route(); });
  window.addEventListener('hashchange', route);
  if ('serviceWorker' in navigator && !IS_DEMO) navigator.serviceWorker.register('sw.js').catch(() => {});
  route();
}

async function setupDemoBanner() {
  const demo = await import('./demo.js');
  demoNowFn = demo.demoNow;
  const el = document.getElementById('demo-banner');
  const local = new Date(demo.demoNow().getTime() - 6 * 3600e3).toISOString().slice(0, 16);
  el.innerHTML = `MODO DEMO (datos de prueba en este navegador) · Fecha simulada:
    <input type="datetime-local" id="demo-now" value="${local}">
    <button class="btn small secondary" id="demo-reset" type="button">Reiniciar demo</button>`;
  el.hidden = false;
  el.querySelector('#demo-now').addEventListener('change', (ev) => {
    if (!ev.target.value) return;
    demo.setDemoNow(new Date(ev.target.value + ':00-06:00'));
    route();
  });
  el.querySelector('#demo-reset').addEventListener('click', () => { demo.resetDemo(); location.reload(); });
}

async function route() {
  try {
    const session = await api.getSession();
    document.getElementById('logout').hidden = !session;
    if (!session) {
      document.getElementById('tabs').hidden = true;
      document.getElementById('course-select').hidden = true;
      return renderLogin();
    }
    state.session = session;
    if (!state.me) state.me = await api.myState();
    const me = state.me;
    const courses = me.courses;

    // curso elegido
    let saved = null;
    try { saved = localStorage.getItem('curso'); } catch (e) { /* nada */ }
    state.courseId = courses.find((c) => c.id === saved)?.id ?? courses.find((c) => c.enrolled)?.id ?? courses[0]?.id ?? null;
    renderCourseSelect(courses);

    const hash = location.hash || '#/';
    const tabs = document.getElementById('tabs');
    tabs.hidden = !courses.length && !me.is_teacher;
    tabs.querySelector('.tab-profe').hidden = !me.is_teacher;
    const tab = hash.startsWith('#/profe') ? 'profe' : hash.slice(2) || 'hoy';
    tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));

    if (hash.startsWith('#/unirse')) return renderJoin();
    if (hash.startsWith('#/profe')) return me.is_teacher ? renderTeacher(hash) : (location.hash = '#/');
    if (hash === '#/reglas') return renderRules();
    const course = courses.find((c) => c.id === state.courseId);
    if (!course || !course.enrolled) {
      return me.is_teacher && courses.length && hash === '#/ranking' ? renderRanking() : renderJoin();
    }
    if (hash === '#/ranking') return renderRanking();
    if (hash === '#/historial') return renderHistory();
    return renderToday();
  } catch (e) {
    console.error(e);
    setView(`<div class="card"><h2>Algo salió mal</h2><p>${esc(e.message || e)}</p>
      <button class="btn" onclick="location.reload()">Reintentar</button></div>`);
  }
}

function renderCourseSelect(courses) {
  const sel = document.getElementById('course-select');
  sel.hidden = courses.length < 2;
  sel.innerHTML = courses.map((c) => `<option value="${c.id}" ${c.id === state.courseId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  sel.onchange = () => {
    try { localStorage.setItem('curso', sel.value); } catch (e) { /* nada */ }
    route();
  };
}

// =============================== login / unirse ===============================
function renderLogin() {
  setView(`
    <div class="login card">
      <img class="logo" src="icons/icon.svg" alt="">
      <h1>Racha de Cálculo</h1>
      <p class="muted">Un ejercicio al día. Mantenga la racha 🔥, gane puntos y suba en el ranking.</p>
      ${LOGIN_GOOGLE ? `<button class="btn google" id="g"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Entrar con Google</button>` : ''}
      ${LOGIN_GOOGLE && LOGIN_EMAIL ? '<div class="divider">o con correo y contraseña</div>' : ''}
      ${LOGIN_EMAIL ? `
        <form id="f" style="text-align:left">
          <label class="field">Correo<input type="email" name="email" required autocomplete="email"></label>
          <label class="field">Contraseña<input type="password" name="password" required minlength="6" autocomplete="current-password"></label>
          <div class="row"><button class="btn" name="in">Entrar</button><button class="btn secondary" name="up" type="button">Crear cuenta</button></div>
        </form>` : ''}
    </div>`);
  document.getElementById('g')?.addEventListener('click', (ev) => guard(ev.currentTarget, () => api.signInGoogle()));
  const f = document.getElementById('f');
  if (f) {
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      guard(f.in, async () => { await api.signInEmail(f.email.value, f.password.value); state.me = null; route(); });
    });
    f.up.addEventListener('click', () => {
      if (!f.reportValidity()) return;
      guard(f.up, async () => {
        const r = await api.signUpEmail(f.email.value, f.password.value);
        if (r.needsConfirm) toast('Revise su correo para confirmar la cuenta.', 6000);
        else { state.me = null; route(); }
      });
    });
  }
}

function renderJoin() {
  const name = state.me?.full_name || state.session?.user?.user_metadata?.full_name || '';
  const teacherNote = state.me?.is_teacher
    ? `<p class="small muted">Usted es la profesora: el panel está en la pestaña <a href="#/profe">Profe</a>.
       Si quiere probar la vista de estudiante, únase a su propio curso con uno de sus códigos.</p>` : '';
  setView(`
    <div class="card login">
      <h1>Unirse a un curso</h1>
      <p class="muted">Escriba su nombre completo (así aparecerá en el ranking) y el código que le dio la profesora.</p>
      ${teacherNote}
      <form id="j" style="text-align:left">
        <label class="field">Nombre completo<input type="text" name="name" required value="${esc(name)}" autocomplete="name"></label>
        <label class="field">Código del curso<input type="text" name="code" required autocapitalize="characters" placeholder="Ej. K3F9QZ"></label>
        <button class="btn block">Unirme</button>
      </form>
    </div>`);
  const f = document.getElementById('j');
  f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(f.querySelector('button'), async () => {
      const r = await api.joinCourse(f.code.value, f.name.value);
      try { localStorage.setItem('curso', r.course_id); } catch (e) { /* nada */ }
      state.me = null;
      toast('¡Listo! Ya está en el curso.');
      location.hash = '#/';
      route();
    });
  });
}

// =============================== estudiante: hoy ===============================
async function renderToday() {
  const dash = await api.dashboard(state.courseId);
  state.dash = dash;
  const ex = dash.exercises;
  const todayDaily = ex.filter((e) => e.mode === 'diario' && e.timing === 'a_tiempo' && !e.solved);
  const recover = ex.filter((e) => e.mode === 'diario' && e.timing === 'recuperar' && !e.solved);
  const extras = ex.filter((e) => e.mode === 'opcional' && !e.solved);
  const doneRecently = ex.filter((e) => e.solved && (e.timing === 'a_tiempo' || e.id === state.openExercise) && new Date(e.on_time_until) > nowMs());

  let html = statsHTML(dash) + weekHTML(dash);

  html += `<h2 class="section-title">Ejercicio de hoy</h2>`;
  if (todayDaily.length) html += todayDaily.map((e) => exerciseCard(e, dash)).join('');
  else {
    html += `<div class="card empty"><div class="big">${doneRecently.length ? '✅' : '⏳'}</div>
      <p><strong>${doneRecently.length ? '¡Listo por hoy! Su racha está a salvo.' : 'Todavía no hay ejercicio disponible.'}</strong></p>
      ${dash.next_release ? `<p class="small">El próximo ejercicio sale el ${esc(fmtDateTime(dash.next_release))}<br>
        en <span class="countdown" data-until="${dash.next_release}"></span></p>` : ''}</div>`;
  }
  html += doneRecently.map((e) => solvedCard(e, e.id === state.openExercise)).join('');

  if (recover.length) {
    html += `<h2 class="section-title">⚠️ Para salvar su racha</h2>
      <p class="small muted">Estos ejercicios ya pasaron su día, pero todavía puede recuperarlos (la racha baja ${RULES.diasPerdidosRecuperar} días y valen con la mitad del bono)${dash.wildcards_left ? ' o usar su comodín del mes' : ''}.</p>`;
    html += recover.map((e) => exerciseCard(e, dash)).join('');
  }
  if (extras.length) {
    html += `<h2 class="section-title">⭐ Ejercicios extra</h2>
      <p class="small muted">Opcionales: no afectan la racha, pero suman puntos con su multiplicador.</p>`;
    html += extras.map((e) => exerciseCard(e, dash)).join('');
  }
  setView(html);
  bindExerciseCards(dash);
  startCountdowns();
}

function statsHTML(dash) {
  return `<div class="stats">
    <div class="stat flame"><div class="value">🔥 ${dash.streak}</div><div class="label">días de racha</div></div>
    <div class="stat mult"><div class="value">${fmtMult(dash.multiplier)}</div><div class="label">multiplicador</div></div>
    <div class="stat"><div class="value">${dash.total_points}</div><div class="label">puntos</div></div>
    <div class="stat"><div class="value">🃏 ${dash.wildcards_left}</div><div class="label">comodín del mes</div></div>
  </div>`;
}

function weekHTML(dash) {
  const today = crDate(new Date(nowMs()));
  const d = new Date(today + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lunes
  d.setUTCDate(d.getUTCDate() - dow);
  const names = ['L', 'K', 'M', 'J', 'V'];
  const cells = names.map((n, i) => {
    const day = new Date(d.getTime() + i * 86400e3).toISOString().slice(0, 10);
    const daily = dash.exercises.filter((e) => e.mode === 'diario' && e.release_date === day);
    let cls = '', sym = '';
    if (daily.length) {
      if (daily[0].wildcard_used) { cls = 'wild'; sym = '🃏'; }
      else if (daily.every((e) => e.solved && e.timing === 'a_tiempo')) { cls = 'ok'; sym = '✓'; }
      else if (daily.every((e) => e.solved)) { cls = 'rec'; sym = '↺'; }
      else if (daily.some((e) => e.timing === 'tarde')) { cls = 'miss'; sym = '✕'; }
      else sym = '•';
    }
    return `<div class="d">${n}<div class="dot ${cls} ${day === today ? 'today' : ''}">${sym}</div></div>`;
  }).join('');
  return `<div class="card" style="padding:12px 16px"><div class="small muted" style="font-weight:700">Esta semana</div><div class="week">${cells}</div></div>`;
}

function timingChip(e) {
  if (e.solved) {
    const label = { a_tiempo: 'a tiempo', recuperar: 'recuperado', tarde: 'tarde', opcional: 'extra' }[e.timing];
    return `<span class="chip success">✓ ${label}</span>`;
  }
  if (e.timing === 'opcional') return '<span class="chip primary">⭐ extra</span>';
  if (e.timing === 'a_tiempo') return `<span class="chip primary">⏱ <span data-until="${e.on_time_until}"></span></span>`;
  if (e.timing === 'recuperar') return `<span class="chip warning">recuperar · <span data-until="${e.recover_until}"></span></span>`;
  return '<span class="chip">sin racha</span>';
}

function worthHTML(e, dash) {
  const m = timingMultiplier(e.timing, dash.multiplier);
  const f = attemptFactor(e.fails);
  const total = Math.round(+(e.points * f * m).toFixed(6));
  const parts = [`${e.points}`];
  if (f < 1) parts.push(`${Math.round(f * 100)} %`);
  if (m !== 1) parts.push(fmtMult(m));
  return `Si acierta ahora: ${parts.length > 1 ? parts.join(' × ') + ' = ' : ''}<b>${total} pts</b>${e.fails ? ` · ${e.fails} intento${e.fails > 1 ? 's' : ''} fallido${e.fails > 1 ? 's' : ''}` : ''}`;
}

function inputHTML(e) {
  if (e.kind === 'seleccion') {
    return `<div class="choices">${e.options.map((o, i) => `
      <label class="choice"><input type="radio" name="c-${e.id}" value="${i}">
        <span><span class="letter">${'abcdefgh'[i]})</span> ${mathHTML(o)}</span></label>`).join('')}</div>`;
  }
  if (e.kind === 'vf') {
    return `<div class="vf">
      <label class="choice"><input type="radio" name="c-${e.id}" value="true">Verdadero</label>
      <label class="choice"><input type="radio" name="c-${e.id}" value="false">Falso</label></div>`;
  }
  if (e.kind === 'numerica') {
    return `<label class="field">Su respuesta<input type="text" inputmode="decimal" name="v" placeholder="Ej. 0.5, -3 o 1/2" autocomplete="off"></label>
      <div class="small muted">Puede escribir decimales (con punto o coma) o fracciones como 3/4.</div>`;
  }
  return `<div class="blanks">${e.options.map((l) => `
    <div class="blank"><label>${esc(l)} =<input type="text" name="b-${esc(l)}" autocomplete="off" autocapitalize="off"></label></div>`).join('')}</div>
    <div class="small muted" style="margin-top:6px">Complete cada casilla. Números con punto, coma o fracción (3/4).</div>`;
}

function exerciseCard(e, dash) {
  return `<form class="card exercise" data-id="${e.id}">
    <div class="card-head">
      <div class="row">
        <span class="chip">${esc(fmtDay(e.release_date))}</span>
        ${e.topic ? `<span class="chip primary">${esc(e.topic)}</span>` : ''}
        <span class="chip">${esc(KIND_LABEL[e.kind])}</span>
      </div>
      ${timingChip(e)}
    </div>
    <div class="statement">${mathHTML(e.statement)}</div>
    ${inputHTML(e)}
    <div class="answer-row">
      <button class="btn">Revisar</button>
      ${e.timing === 'recuperar' && dash.wildcard_days.includes(e.release_date)
        ? `<button class="btn secondary" type="button" data-wild="${e.release_date}">🃏 Usar comodín</button>` : ''}
    </div>
    <p class="worth" style="margin-top:10px">${worthHTML(e, dash)}</p>
    <div class="fb"></div>
  </form>`;
}

function solvedCard(e, open = false) {
  return `<details class="card solved" ${open ? 'open' : ''}>
    <summary class="card-head">
      <div class="row">
        <span class="chip">${esc(fmtDay(e.release_date))}</span>
        ${e.topic ? `<span class="chip primary">${esc(e.topic)}</span>` : ''}
        <strong>+${e.earned} pts</strong>
      </div>
      ${timingChip(e)}
    </summary>
    <div class="statement">${mathHTML(e.statement)}</div>
    ${e.explanation ? `<div class="explanation"><h4>Solución explicada</h4>${mathHTML(e.explanation)}</div>` : ''}
  </details>`;
}

function readAnswer(form, e) {
  if (e.kind === 'seleccion' || e.kind === 'vf') {
    const v = form.querySelector(`input[name="c-${e.id}"]:checked`)?.value;
    if (v === undefined) return null;
    return e.kind === 'vf' ? { value: v === 'true' } : { choice: Number(v) };
  }
  if (e.kind === 'numerica') {
    const v = form.v.value.trim();
    return v ? { value: v } : null;
  }
  const values = {};
  for (const l of e.options) {
    const v = form.querySelector(`[name="b-${CSS.escape(l)}"]`).value.trim();
    if (!v) return null;
    values[l] = v;
  }
  return { values };
}

function bindExerciseCards(dash, after = route) {
  $app.querySelectorAll('form.exercise').forEach((form) => {
    const e = dash.exercises.find((x) => x.id === form.dataset.id);
    form.querySelectorAll('.choice input').forEach((inp) => inp.addEventListener('change', () => {
      form.querySelectorAll('.choice').forEach((c) => c.classList.toggle('picked', c.contains(form.querySelector('input:checked'))));
    }));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const ans = readAnswer(form, e);
      const fb = form.querySelector('.fb');
      if (!ans) { toast('Primero escriba o elija su respuesta.'); return; }
      guard(form.querySelector('button'), async () => {
        const r = await api.submit(e.id, ans);
        if (r.correct) {
          state.openExercise = e.id;
          toast(r.already ? 'Este ya estaba resuelto.' : `¡Correcto! +${r.points} puntos 🔥`, 3500);
          state.me = null;
          after();
        } else {
          e.fails = r.fails;
          fb.innerHTML = `<div class="feedback bad">No es correcto (intento fallido nº ${r.fails}). ¡Revise y vuelva a intentarlo! Acertar siempre vale más que perder la racha.</div>`;
          form.querySelector('.worth').innerHTML = worthHTML(e, dash);
        }
      });
    });
    form.querySelector('[data-wild]')?.addEventListener('click', (ev) => {
      const day = ev.currentTarget.dataset.wild;
      if (!confirm(`¿Usar su comodín del mes para el ${fmtDay(day)}? Su racha queda intacta, y el ejercicio de ese día se podrá hacer luego solo por los puntos base.`)) return;
      guard(ev.currentTarget, async () => {
        await api.useWildcard(state.courseId, day);
        toast('🃏 Comodín usado: su racha está a salvo.');
        after();
      });
    });
  });
}

// =============================== estudiante: historial ===============================
async function renderHistory() {
  const dash = await api.dashboard(state.courseId);
  const ex = dash.exercises;
  if (!ex.length) return setView(statsHTML(dash) + '<div class="card empty"><div class="big">📭</div><p>Todavía no se ha liberado ningún ejercicio.</p></div>');
  const pending = ex.filter((e) => !e.solved);
  const done = ex.filter((e) => e.solved);
  let html = statsHTML(dash);
  if (pending.length) {
    html += `<h2 class="section-title">Pendientes (${pending.length})</h2>
      <p class="small muted">Los que ya no salvan la racha igual se pueden hacer por los puntos base.</p>`;
    html += pending.map((e) => exerciseCard(e, dash)).join('');
  }
  html += `<h2 class="section-title">Resueltos (${done.length})</h2>`;
  html += done.length ? done.map((e) => solvedCard(e, e.id === state.openExercise)).join('') : '<div class="card empty">Aún no ha resuelto ninguno.</div>';
  setView(html);
  bindExerciseCards(dash);
  startCountdowns();
}

// =============================== ranking ===============================
async function renderRanking(group = state.rankGroup ?? 'todos') {
  const rows = await api.leaderboard(state.courseId);
  const groups = [...new Set(rows.map((r) => r.group_name))].sort();
  state.rankGroup = groups.includes(group) ? group : 'todos';
  const shown = state.rankGroup === 'todos' ? rows : rows.filter((r) => r.group_name === state.rankGroup);
  const medal = ['🥇', '🥈', '🥉'];
  let pos = 0, prev = null;
  const items = shown.map((r, i) => {
    if (prev === null || r.points !== prev) pos = i + 1;
    prev = r.points;
    return `<li class="${r.is_me ? 'me' : ''}">
      <div class="pos p${pos}">${pos <= 3 && r.points > 0 ? medal[pos - 1] : pos}</div>
      <div><div class="name">${esc(r.full_name)}${r.is_me ? ' (usted)' : ''}</div>
        <div class="meta">${esc(r.group_name)} · ${r.solved} resuelto${r.solved === 1 ? '' : 's'}</div></div>
      <div class="pts">${r.points}<small>${r.streak > 0 ? '🔥 ' + r.streak : ''}</small></div>
    </li>`;
  }).join('');
  setView(`
    <h1>🏆 Ranking</h1>
    ${groups.length > 1 ? `<div class="filter-row">
      ${['todos', ...groups].map((g) => `<button type="button" data-g="${esc(g)}" class="${g === state.rankGroup ? 'active' : ''}">${g === 'todos' ? 'Todos' : esc(g)}</button>`).join('')}
    </div>` : ''}
    <div class="card" style="padding:8px">${items ? `<ol class="rank">${items}</ol>` : '<div class="empty">Todavía no hay estudiantes.</div>'}</div>
    <p class="small muted">Empates en puntos comparten posición. El número 🔥 es la racha actual.</p>`);
  $app.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => renderRanking(b.dataset.g)));
}

// =============================== reglas ===============================
function renderRules() {
  const r = RULES;
  const ex = (s) => Math.round(100 * multiplier(s));
  setView(`
    <div class="card">
      <h1>¿Cómo funciona?</h1>
      <ul class="rules-list">
        <li>De <strong>lunes a viernes</strong> sale un ejercicio a la <strong>1:00 a. m.</strong> El fin de semana no rompe la racha.</li>
        <li>Si lo resuelve <strong>a tiempo</strong> (antes de que salga el siguiente), suma un día a su <strong>racha 🔥</strong>.</li>
        <li>Cada día de racha sube su multiplicador <strong>+${Math.round(r.bonoPorDia * 100)} %</strong>, hasta <strong>${fmtMult(multiplier(r.diasTope))}</strong> (${r.diasTope} días).</li>
        <li>¿Se equivocó? Puede <strong>reintentar todas las veces que quiera</strong>. Cada fallo quita ${Math.round(r.castigoFallo * 100)} % de los puntos, pero nunca gana menos del ${Math.round(r.minimo * 100)} %.</li>
        <li>¿Se le pasó un día? Al día siguiente todavía lo puede <strong>recuperar</strong>: la racha sigue, pero baja ${r.diasPerdidosRecuperar} días y ese ejercicio vale con la mitad del bono.</li>
        <li>Tiene <strong>${r.comodinesPorMes} comodín 🃏 por mes</strong>: si se le pasa un día, úselo y su racha queda intacta.</li>
        <li>Si no lo recupera ni usa comodín, la racha vuelve a 0. El ejercicio se puede hacer igual, por los puntos base.</li>
        <li>Los ejercicios <strong>⭐ extra</strong> (cerca de los exámenes) no afectan la racha y suman puntos con su multiplicador.</li>
        <li>Al acertar verá la <strong>solución explicada</strong>.</li>
      </ul>
    </div>
    <div class="card">
      <h2>Ejemplo con un ejercicio de 100 puntos</h2>
      <table class="rules">
        <tr><th>Situación</th><th>Puntos</th></tr>
        <tr><td>Día 1 de racha, primer intento</td><td>100</td></tr>
        <tr><td>Con 5 días de racha, primer intento</td><td>${ex(5)}</td></tr>
        <tr><td>Con 10 días de racha, primer intento</td><td>${ex(10)}</td></tr>
        <tr><td>Con 10 días de racha, al 3er intento</td><td>${Math.round(100 * attemptFactor(2) * multiplier(10))}</td></tr>
        <tr><td>Con 10 días de racha, al 8º intento</td><td>${Math.round(100 * attemptFactor(7) * multiplier(10))}</td></tr>
        <tr><td>No hacerlo</td><td>0 y la racha se cae a ${fmtMult(1)}</td></tr>
      </table>
      <p class="small muted" style="margin-top:8px">Moraleja: siempre conviene más acertarlo tarde que dejarlo.</p>
    </div>
    <div class="card"><h2>Instalar en el teléfono</h2>
      <p><strong>Android (Chrome):</strong> menú ⋮ → <em>Agregar a la pantalla principal</em> / <em>Instalar app</em>.<br>
      <strong>iPhone (Safari):</strong> botón Compartir → <em>Agregar a inicio</em>.</p></div>`);
}

// =============================== profesora ===============================
async function renderTeacher(hash) {
  const sub = hash.split('/')[2] || 'estadisticas';
  const courses = await api.listCourses();
  if (!courses.length && sub !== 'cursos') { location.hash = '#/profe/cursos'; return; }
  const course = courses.find((c) => c.id === state.courseId) ?? courses[0];
  const nav = `<div class="subtabs">
    ${[['estadisticas', '📊 Estadísticas'], ['subir', '⬆️ Subir ejercicios'], ['ejercicios', '📚 Ejercicios'], ['cursos', '🎓 Cursos y grupos']]
      .map(([k, l]) => `<a class="btn small ${k === sub ? '' : 'secondary'}" href="#/profe/${k}">${l}</a>`).join('')}
  </div>`;
  if (sub === 'cursos') return renderCourses(nav, courses);
  if (sub === 'subir') return renderUpload(nav, course);
  if (sub === 'ejercicios') return renderExerciseList(nav, course);
  return renderStats(nav, course);
}

async function renderCourses(nav, courses) {
  const groupsBy = Object.fromEntries(await Promise.all(courses.map(async (c) => [c.id, await api.listGroups(c.id)])));
  setView(`${nav}
    ${courses.map((c) => `<div class="card">
      <div class="card-head"><h2>${esc(c.name)}</h2><span class="chip">${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</span></div>
      <p class="small muted">Comparta con cada grupo su código y el enlace de la app.</p>
      ${groupsBy[c.id].map((g) => `<p>${esc(g.name)}: <span class="code-box">${esc(g.join_code)}</span></p>`).join('') || '<p class="muted">Sin grupos todavía.</p>'}
      <form class="row add-group" data-course="${c.id}">
        <input type="text" name="name" placeholder="Nombre del grupo (ej. Grupo 03)" required style="flex:1;min-width:180px">
        <button class="btn small">Agregar grupo</button>
      </form>
    </div>`).join('')}
    <div class="card"><h2>Crear curso nuevo</h2>
      <p class="small muted">Cada curso tiene sus propios ejercicios, rachas y ranking. Úselo cada semestre o para cursos distintos.</p>
      <form id="nc">
        <label class="field">Nombre<input type="text" name="name" required placeholder="MA1002 Cálculo II · I-2027"></label>
        <div class="row">
          <label class="field" style="flex:1">Inicio<input type="date" name="start" required></label>
          <label class="field" style="flex:1">Fin<input type="date" name="end" required></label>
        </div>
        <label class="field">Primer grupo<input type="text" name="group" required value="Grupo 01"></label>
        <button class="btn">Crear curso</button>
      </form></div>`);
  $app.querySelectorAll('.add-group').forEach((f) => f.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(f.querySelector('button'), async () => { await api.createGroup(f.dataset.course, f.name.value.trim()); route(); });
  }));
  const nc = document.getElementById('nc');
  nc.addEventListener('submit', (ev) => {
    ev.preventDefault();
    guard(nc.querySelector('button'), async () => {
      const c = await api.createCourse({ name: nc.name.value.trim(), start_date: nc.start.value, end_date: nc.end.value });
      await api.createGroup(c.id, nc.group.value.trim());
      try { localStorage.setItem('curso', c.id); } catch (e) { /* nada */ }
      state.me = null;
      toast('Curso creado.');
      route();
    });
  });
}

function keyHTML(e, key) {
  const a = key?.answer ?? {};
  if (e.kind === 'seleccion') return `Correcta: ${'abcdefgh'[a.correct]})`;
  if (e.kind === 'vf') return `Correcta: ${a.value ? 'Verdadero' : 'Falso'}`;
  if (e.kind === 'numerica') return `Acepta: ${esc(a.accepted.join(' | '))} (tolerancia ${a.tol})`;
  return 'Acepta: ' + Object.entries(a.blanks).map(([l, v]) => `${esc(l)} = ${esc(v.join(' | '))}`).join('; ');
}

function previewItem(e, key, extra = '') {
  return `<div class="preview-item">
    <div class="card-head"><div class="row">
      <span class="chip">${e.release_date ? esc(fmtDay(e.release_date)) : '¿fecha?'}</span>
      <span class="chip ${e.mode === 'opcional' ? 'warning' : 'primary'}">${e.mode === 'opcional' ? '⭐ opcional' : 'diario'}</span>
      ${e.topic ? `<span class="chip">${esc(e.topic)}</span>` : ''}
      <span class="chip">${esc(KIND_LABEL[e.kind] ?? '?')}</span>
      <span class="chip">${e.points} pts</span></div>${extra}</div>
    <div class="statement">${mathHTML(e.statement)}</div>
    ${e.kind === 'seleccion' && e.options ? `<ol type="a">${e.options.map((o) => `<li>${mathHTML(o)}</li>`).join('')}</ol>` : ''}
    <p class="key">${keyHTML(e, key)}</p>
    <details><summary class="small">Ver explicación</summary><div class="explanation">${mathHTML(key?.explanation)}</div></details>
  </div>`;
}

function renderUpload(nav, course) {
  setView(`${nav}
    <div class="card">
      <h2>Subir ejercicios a: ${esc(course.name)}</h2>
      <p class="small muted">Elija el archivo .txt que armó con Claude (o pegue su contenido abajo). Primero se revisa y se muestra cómo lo verán los estudiantes; nada se guarda hasta que toque <strong>Cargar</strong>.</p>
      <input type="file" id="file" accept=".txt,.md,text/plain" class="input">
      <textarea id="txt" placeholder="=== EJERCICIO ===&#10;fecha: 26/10/2026&#10;modalidad: diario&#10;tipo: seleccion unica&#10;…" style="margin-top:10px"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn" id="check">Revisar</button></div>
    </div>
    <div id="result"></div>`);
  const txt = document.getElementById('txt');
  document.getElementById('file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (f) { txt.value = await f.text(); document.getElementById('check').click(); }
  });
  document.getElementById('check').addEventListener('click', async () => {
    const { items, errors, warnings } = parseExercises(txt.value, course);
    const existing = await api.listExercises(course.id);
    const dupDates = [...new Set(items.filter((it) => it.mode === 'diario' && existing.some((x) => x.mode === 'diario' && x.release_date === it.release_date)).map((it) => it.release_date))];
    if (dupDates.length) warnings.push(`Ya hay ejercicios diarios cargados el ${dupDates.map(fmtDate).join(', ')}. Si está reemplazándolos, borre los viejos en la pestaña Ejercicios.`);
    const res = document.getElementById('result');
    res.innerHTML = `
      ${errors.length ? `<div class="errors card"><strong>Hay que corregir esto antes de cargar:</strong><ul>${errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${warnings.length ? `<div class="warnings card"><strong>Avisos:</strong><ul>${warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="card"><div class="card-head"><h2>Vista previa (${items.length})</h2>
        ${!errors.length && items.length ? `<button class="btn" id="load">Cargar ${items.length} ejercicio${items.length > 1 ? 's' : ''}</button>` : ''}</div>
        ${items.map((it) => previewItem(it, it)).join('')}</div>`;
    typeset(res);
    document.getElementById('load')?.addEventListener('click', (ev) => guard(ev.currentTarget, async () => {
      const n = await api.importExercises(course.id, items);
      toast(`Se cargaron ${n} ejercicios.`);
      location.hash = '#/profe/ejercicios';
    }));
  });
}

async function renderExerciseList(nav, course) {
  const list = await api.listExercises(course.id);
  const key = (e) => (Array.isArray(e.exercise_keys) ? e.exercise_keys[0] : e.exercise_keys);
  setView(`${nav}<h2>Ejercicios de ${esc(course.name)} (${list.length})</h2>
    ${list.length ? list.map((e) => previewItem(e, key(e), `<button class="btn small danger" data-del="${e.id}">Borrar</button>`)).join('')
      : '<div class="card empty">Todavía no hay ejercicios. Vaya a <a href="#/profe/subir">Subir ejercicios</a>.</div>'}`);
  $app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('¿Borrar este ejercicio? También se borran los intentos y puntos que los estudiantes ganaron con él.')) return;
    guard(b, async () => { await api.deleteExercise(b.dataset.del); toast('Ejercicio borrado.'); route(); });
  }));
}

// ---------- estadísticas ----------
function answerText(e, a) {
  if (e.kind === 'seleccion') return `${'abcdefgh'[a.choice]})`;
  if (e.kind === 'vf') return a.value ? 'Verdadero' : 'Falso';
  if (e.kind === 'numerica') return String(a.value);
  return Object.entries(a.values ?? {}).map(([l, v]) => `${l}=${v}`).join(', ');
}

function computeStats(data) {
  const now = new Date(data.now);
  const students = data.enrollments.map((en) => ({ id: en.user_id, name: en.profiles?.full_name ?? '?', group: en.groups?.name ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const released = data.exercises.filter((e) => new Date(`${e.release_date}T01:00:00-06:00`) <= now);
  const rows = released.map((e) => {
    const att = data.attempts.filter((a) => a.exercise_id === e.id);
    const sol = data.solves.filter((s) => s.exercise_id === e.id);
    const solvedIds = new Set(sol.map((s) => s.user_id));
    const triedIds = new Set(att.map((a) => a.user_id));
    const first = sol.filter((s) => s.attempts === 1).length;
    const wrong = {};
    const firstAnswers = {};
    const seen = new Set();
    for (const a of att) {
      const txt = answerText(e, a.answer);
      if (!a.correct) wrong[txt] = (wrong[txt] ?? 0) + 1;
      if (!seen.has(a.user_id)) { seen.add(a.user_id); firstAnswers[txt] = (firstAnswers[txt] ?? 0) + 1; }
    }
    const topWrong = Object.entries(wrong).sort((x, y) => y[1] - x[1]);
    return {
      e, n: students.length, first, more: sol.length - first,
      triedNotSolved: [...triedIds].filter((u) => !solvedIds.has(u)).length,
      none: students.length - new Set([...triedIds, ...solvedIds]).size,
      avgAttempts: sol.length ? sol.reduce((acc, s) => acc + s.attempts, 0) / sol.length : null,
      topWrong, firstAnswers,
    };
  });
  return { students, rows };
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

async function renderStats(nav, course) {
  const data = await api.statsData(course.id);
  const { students, rows } = computeStats(data);
  if (!rows.length) {
    return setView(`${nav}<div class="card empty"><div class="big">📊</div><p>Las estadísticas aparecen cuando se libere el primer ejercicio.<br>
      Estudiantes inscritos: <strong>${students.length}</strong>.</p></div>`);
  }
  const label = (r) => `${fmtDate(r.e.release_date).slice(0, 5)}${r.e.mode === 'opcional' ? ' ⭐' : ''}${r.e.topic ? ' · ' + r.e.topic : ''}`;
  const pct = (x, n) => (n ? Math.round((100 * x) / n) : 0);
  const series = [
    ['Al primer intento', 'first', '--c1'], ['Con más intentos', 'more', '--c2'],
    ['Intentó sin acertar', 'triedNotSolved', '--c3'], ['No lo ha intentado', 'none', '--c4'],
  ];
  const daily = rows.filter((r) => r.e.mode === 'diario');
  const firstRate = daily.length ? Math.round(daily.reduce((a, r) => a + pct(r.first, r.n), 0) / daily.length) : 0;
  const solvedRate = daily.length ? Math.round(daily.reduce((a, r) => a + pct(r.first + r.more, r.n), 0) / daily.length) : 0;

  setView(`${nav}
    <div class="stats">
      <div class="stat"><div class="value">${students.length}</div><div class="label">estudiantes</div></div>
      <div class="stat"><div class="value">${rows.length}</div><div class="label">ejercicios liberados</div></div>
      <div class="stat"><div class="value">${solvedRate} %</div><div class="label">resuelven (promedio diarios)</div></div>
      <div class="stat"><div class="value">${firstRate} %</div><div class="label">al primer intento</div></div>
    </div>
    <div class="card">
      <h2>¿Cómo le fue al grupo en cada ejercicio?</h2>
      <div class="legend">${series.map(([l, , c]) => `<span style="--sw:var(${c})">${l}</span>`).join('')}</div>
      <div class="chart-box" style="height:${Math.max(220, rows.length * 44 + 60)}px"><canvas id="ch"></canvas></div>
    </div>
    <div class="card">
      <h2>Resumen por ejercicio</h2>
      <p class="small muted">Toque una fila para ver qué respondieron.</p>
      <div class="table-wrap"><table class="data">
        <tr><th>Fecha</th><th>Tema</th><th>Tipo</th><th>1er intento</th><th>Resolvieron</th><th>Intentos prom.</th><th>Error más común</th></tr>
        ${rows.map((r, i) => `<tr data-row="${i}" style="cursor:pointer">
          <td>${label(r).split(' · ')[0]}</td><td>${esc(r.e.topic ?? '')}</td><td>${esc(KIND_LABEL[r.e.kind])}</td>
          <td class="c">${pct(r.first, r.n)} %</td><td class="c">${r.first + r.more}/${r.n}</td>
          <td class="c">${r.avgAttempts ? r.avgAttempts.toFixed(1) : '—'}</td>
          <td>${r.topWrong[0] ? `${esc(r.topWrong[0][0])} (${r.topWrong[0][1]})` : '—'}</td></tr>`).join('')}
      </table></div>
      <div id="detail"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Estudiantes × ejercicios</h2><button class="btn small secondary" id="csv">Descargar Excel (CSV)</button></div>
      <p class="small muted"><span class="cell-1">✓</span> al primer intento · <span class="cell-n">✓3</span> en 3 intentos · <span class="cell-x">✗2</span> 2 intentos sin acertar · · no lo intentó</p>
      <div class="table-wrap" style="max-height:480px">${matrixHTML(students, rows, data)}</div>
    </div>`);

  const ink = cssVar('--text-2');
  const grid = cssVar('--border');
  const chart = new window.Chart(document.getElementById('ch'), {
    type: 'bar',
    data: {
      labels: rows.map(label),
      datasets: series.map(([l, k, c]) => ({
        label: l, data: rows.map((r) => r[k]), backgroundColor: cssVar(c),
        borderColor: cssVar('--surface'), borderWidth: { right: 2 }, borderSkipped: false, borderRadius: 4, barThickness: 22,
      })),
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw} (${pct(ctx.raw, rows[ctx.dataIndex].n)} %)` } },
      },
      scales: {
        x: { stacked: true, max: students.length || undefined, ticks: { color: ink, precision: 0 }, grid: { color: grid }, title: { display: true, text: 'estudiantes', color: ink } },
        y: { stacked: true, ticks: { color: ink }, grid: { display: false } },
      },
    },
  });
  state.charts.push(chart);

  $app.querySelectorAll('[data-row]').forEach((tr) => tr.addEventListener('click', () => showDetail(rows[+tr.dataset.row], data)));
  document.getElementById('csv').addEventListener('click', () => downloadCSV(students, rows, data, course));
}

function showDetail(r, data) {
  const e = r.e;
  const key = Array.isArray(e.exercise_keys) ? e.exercise_keys[0] : e.exercise_keys;
  const entries = e.kind === 'seleccion'
    ? e.options.map((_, i) => [`${'abcdefgh'[i]})`, r.firstAnswers[`${'abcdefgh'[i]})`] ?? 0])
    : e.kind === 'vf' ? [['Verdadero', r.firstAnswers.Verdadero ?? 0], ['Falso', r.firstAnswers.Falso ?? 0]]
      : Object.entries(r.firstAnswers).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const correctLabel = e.kind === 'seleccion' ? `${'abcdefgh'[key.answer.correct]})` : e.kind === 'vf' ? (key.answer.value ? 'Verdadero' : 'Falso') : null;
  const el = document.getElementById('detail');
  el.innerHTML = `<div class="preview-item" style="margin-top:14px">
    <h3>${esc(fmtDay(e.release_date))} · ${esc(e.topic ?? '')}</h3>
    <div class="statement">${mathHTML(e.statement)}</div>
    <p class="small muted">Primera respuesta de cada estudiante${correctLabel ? ` (la correcta es <strong>${esc(correctLabel)}</strong>)` : ''}:</p>
    <div class="chart-box" style="height:${Math.max(140, entries.length * 36 + 40)}px"><canvas id="ch2"></canvas></div>
    ${r.topWrong.length ? `<p class="small"><strong>Respuestas incorrectas (todas):</strong> ${r.topWrong.map(([t, n]) => `${esc(t)} (${n})`).join(' · ')}</p>` : ''}
  </div>`;
  typeset(el);
  const ink = cssVar('--text-2');
  const c = new window.Chart(document.getElementById('ch2'), {
    type: 'bar',
    data: {
      labels: entries.map(([t]) => t + (t === correctLabel ? ' ✓' : '')),
      datasets: [{ label: 'Estudiantes', data: entries.map(([, n]) => n),
        backgroundColor: entries.map(([t]) => (correctLabel && t !== correctLabel ? cssVar('--c3') : cssVar('--c1'))), borderRadius: 4, barThickness: 20 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: ink, precision: 0 }, grid: { color: cssVar('--border') } }, y: { ticks: { color: ink }, grid: { display: false } } },
    },
  });
  state.charts.push(c);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cellFor(studentId, r, data) {
  const s = data.solves.find((x) => x.user_id === studentId && x.exercise_id === r.e.id);
  if (s) return s.attempts === 1 ? ['✓', 'cell-1'] : [`✓${s.attempts}`, 'cell-n'];
  const n = data.attempts.filter((a) => a.user_id === studentId && a.exercise_id === r.e.id).length;
  return n ? [`✗${n}`, 'cell-x'] : ['·', 'muted'];
}

function matrixHTML(students, rows, data) {
  const pts = (id) => data.solves.filter((s) => s.user_id === id).reduce((a, s) => a + s.points, 0);
  return `<table class="data"><tr><th>Estudiante</th><th>Grupo</th><th>Puntos</th>
    ${rows.map((r) => `<th class="c">${fmtDate(r.e.release_date).slice(0, 5)}${r.e.mode === 'opcional' ? '⭐' : ''}</th>`).join('')}</tr>
    ${students.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.group)}</td><td class="c">${pts(s.id)}</td>
      ${rows.map((r) => { const [t, c] = cellFor(s.id, r, data); return `<td class="c ${c}">${t}</td>`; }).join('')}</tr>`).join('')}
  </table>`;
}

function downloadCSV(students, rows, data, course) {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const head = ['Estudiante', 'Grupo', 'Puntos', ...rows.map((r) => `${fmtDate(r.e.release_date)} ${r.e.topic ?? ''}${r.e.mode === 'opcional' ? ' (extra)' : ''}`)];
  const lines = [head.map(q).join(';')];
  for (const s of students) {
    const pts = data.solves.filter((x) => x.user_id === s.id).reduce((a, x) => a + x.points, 0);
    lines.push([s.name, s.group, pts, ...rows.map((r) => cellFor(s.id, r, data)[0].replace('·', ''))].map(q).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${course.name.replace(/[^\w\- ]+/g, '')} - resultados.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

boot();
