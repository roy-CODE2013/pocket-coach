/* Pocket Coach — האזור האישי
   ניהול הפעלה, טעינת ההתקדמות, ספריית התרגילים ויומן האימונים. */

(() => {
  'use strict';

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const SITE_URL = './';

  const state = {
    user: null,
    stats: null,
    drills: [],
    filter: 'הכול',
    timer: null,
  };

  // ───────────────────────────────────────── חיבור ל-Supabase

  const SUPABASE_URL = 'https://nnrgkeesfhfbyjzmcfpk.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_yeFF0gyDzIm_8BJxuTvevA_yjaRRbvY';

  const { CATEGORIES, CATEGORY_TONE, DRILLS, ENCOURAGEMENTS } = window.PC_DATA;
  const DRILL_BY_ID = Object.fromEntries(DRILLS.map(d => [d.id, d]));
  const MILESTONE_EVERY = 5;
  const DEFAULT_TIME = '18:00';
  const DEFAULT_REMINDERS = [60, 1];
  const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  let sb = null;
  const uid = () => state.user && state.user.id;

  function fail(error) {
    const msg = (error && error.message) || 'אירעה שגיאה';
    if (/Invalid login/i.test(msg))      return 'מייל או סיסמה שגויים';
    if (/Email not confirmed/i.test(msg)) return 'יש לאשר את המייל לפני הכניסה';
    if (/already registered/i.test(msg))  return 'כתובת המייל כבר רשומה — אפשר פשוט להתחבר';
    if (/provider is not enabled/i.test(msg)) return 'הכניסה עם גוגל לא מופעלת';
    return msg;
  }

  const check = ({ data, error }) => { if (error) throw new Error(fail(error)); return data; };

  const localDay = d => {
    const x = d instanceof Date ? d : new Date(d);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };

  // ── פרופיל
  async function loadProfile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error('אין הפעלה פעילה');
    let rows = check(await sb.from('profiles').select('*').eq('id', user.id));
    if (!rows.length) {
      const meta = user.user_metadata || {};
      check(await sb.from('profiles').upsert({
        id: user.id,
        email: user.email || '',
        name: meta.full_name || meta.name || (user.email || '').split('@')[0],
      }));
      rows = check(await sb.from('profiles').select('*').eq('id', user.id));
    }
    return rows[0];
  }

  // ── רצף ימי כניסה
  async function visitDays() {
    const rows = check(await sb.from('visits').select('day')
      .eq('user_id', uid()).order('day', { ascending: false }).limit(400));
    return new Set(rows.map(r => r.day));
  }

  function streakFrom(days) {
    if (!days.size) return 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yday = new Date(today); yday.setDate(yday.getDate() - 1);
    if (!days.has(localDay(today)) && !days.has(localDay(yday))) return 0;
    const cursor = days.has(localDay(today)) ? today : yday;
    let count = 0;
    while (days.has(localDay(cursor))) { count++; cursor.setDate(cursor.getDate() - 1); }
    return count;
  }

  async function recordVisit() {
    const today = localDay(new Date());
    const days = await visitDays();
    const firstToday = !days.has(today);
    if (firstToday) {
      await sb.from('visits').upsert({ user_id: uid(), day: today }, { ignoreDuplicates: true });
      days.add(today);
    }
    const streak = streakFrom(days);
    return {
      days: streak,
      first_today: firstToday,
      milestone: firstToday && streak > 0 && streak % MILESTONE_EVERY === 0,
      next_milestone: (Math.floor(streak / MILESTONE_EVERY) + 1) * MILESTONE_EVERY,
    };
  }

  // ── אימונים
  async function loadTrainingSessions() {
    const rows = check(await sb.from('training_sessions')
      .select('id,drill_id,drill_name,category,minutes,rating,done_at')
      .eq('user_id', uid()).order('done_at', { ascending: false }).limit(500));
    return rows.map(r => {
      const when = new Date(r.done_at);
      return {
        id: r.id, drill_id: r.drill_id, name: r.drill_name, cat: r.category,
        minutes: r.minutes, rating: r.rating, ts: when.getTime(),
        at: `${localDay(when)} ${String(when.getHours()).padStart(2,'0')}:${String(when.getMinutes()).padStart(2,'0')}`,
      };
    });
  }

  async function buildStats() {
    const items = await loadTrainingSessions();
    const totalMinutes = items.reduce((a, s) => a + s.minutes, 0);
    const avg = items.length
      ? Math.round(items.reduce((a, s) => a + s.rating, 0) / items.length * 10) / 10 : 0;

    const short = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
    const labels = [], values = [];
    for (let off = 6; off >= 0; off--) {
      const day = new Date(); day.setDate(day.getDate() - off);
      labels.push(off === 0 ? 'היום' : short[day.getDay()]);
      values.push(items.filter(s => localDay(new Date(s.ts)) === localDay(day))
                       .reduce((a, s) => a + s.minutes, 0));
    }

    const byCat = Object.fromEntries(CATEGORIES.map(c => [c, 0]));
    items.forEach(s => { byCat[s.cat] = (byCat[s.cat] || 0) + s.minutes; });
    const top = Math.max(...Object.values(byCat), 1);
    const skills = Object.entries(byCat).sort((a, b) => b[1] - a[1])
      .map(([cat, minutes]) => ({ cat, minutes, pct: Math.round(minutes / top * 100) }));

    const streak = streakFrom(await visitDays());
    return {
      cards: [
        { label: 'תרגילים שהושלמו', value: items.length, icon: 'check' },
        { label: 'רצף ימי כניסה', value: streak, suffix: ' ימים', icon: 'flame' },
        { label: 'סך דקות אימון', value: totalMinutes, icon: 'clock' },
        { label: 'תחושה ממוצעת', value: avg, suffix: ' / 5', icon: 'star' },
      ],
      chart: { labels, values },
      skills,
      week_total: values.reduce((a, b) => a + b, 0),
      streak: {
        days: streak, every: MILESTONE_EVERY,
        next_milestone: (Math.floor(streak / MILESTONE_EVERY) + 1) * MILESTONE_EVERY,
      },
    };
  }

  async function favoriteIds() {
    const rows = check(await sb.from('favorites').select('drill_id').eq('user_id', uid()));
    return new Set(rows.map(r => r.drill_id));
  }

  // ── יומן שבועי
  const validTime = v => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
    if (!m) return DEFAULT_TIME;
    const h = +m[1], mi = +m[2];
    return (h >= 0 && h < 24 && mi >= 0 && mi < 60)
      ? `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}` : DEFAULT_TIME;
  };

  const cleanReminders = v => Array.isArray(v)
    ? [...new Set(v.map(Number).filter(n => n >= 1 && n <= 1440))].sort((a, b) => b - a).slice(0, 3)
    : [...DEFAULT_REMINDERS];

  async function loadScheduleData() {
    const rows = check(await sb.from('schedules').select('target,days,reminders').eq('user_id', uid()));
    const row = rows[0] || { target: 3, days: {}, reminders: [...DEFAULT_REMINDERS] };
    const stored = row.days || {};
    const days = [];
    for (let i = 0; i < 7; i++) {
      const e = stored[String(i)] || {};
      days.push({
        day: i, name: DAY_NAMES[i],
        type: e.type === 'training' ? 'training' : 'rest',
        time: validTime(e.time || DEFAULT_TIME),
      });
    }
    return {
      target: row.target ?? 3, days,
      planned: days.filter(d => d.type === 'training').length,
      reminders: cleanReminders(row.reminders),
    };
  }

  // ───────────────────────────────────────── הודעות צפות

  const ICONS = {
    success: '<svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    error:   '<svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>',
    info:    '<svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/></svg>',
  };

  function dismissToast(el) {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  // ms = 0  →  ההודעה נשארת עד שלוחצים על ×
  function toast(message, type = 'success', ms = 3600) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      ${ICONS[type] || ICONS.info}
      <span class="text-sm font-bold leading-snug">${escapeHtml(message)}</span>
      <button class="toast-x" aria-label="סגירה">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>`;
    el.querySelector('.toast-x').addEventListener('click', () => dismissToast(el));
    $('#toastRoot').appendChild(el);
    if (ms > 0) setTimeout(() => dismissToast(el), ms);
    return el;
  }

  const escapeHtml = str => String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function loading(btn, on) {
    btn.classList.toggle('is-loading', on);
    btn.disabled = on;
  }

  // ───────────────────────────────────────── מודאל

  function openModal(title, html, wide = false) {
    $('#modalTitle').textContent = title;
    $('#modalBody').innerHTML = html;
    $('#modalBox').classList.toggle('max-w-4xl', wide);
    $('#modalBox').classList.toggle('max-w-2xl', !wide);
    $('#modalRoot').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    $('#modalRoot').classList.add('hidden');
    $('#modalBody').innerHTML = '';
    document.body.style.overflow = '';
  }

  $('#modalClose').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modalRoot').classList.contains('hidden')) closeModal();
  });

  // ───────────────────────────────────────── טפסים משותפים

  const markError = (input, bad) => input.classList.toggle('field-error', bad);

  // ───────────────────────────────────────── תצוגות

  function showView(name) {
    if (name === 'site') { window.location.href = SITE_URL; return; }
    const views = { auth: '#authView', dashboard: '#dashboardView' };
    Object.entries(views).forEach(([key, sel]) => $(sel).classList.toggle('hidden', key !== name));
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-goto]');
    if (!trigger) return;
    e.preventDefault();
    showView(trigger.dataset.goto);
  });

  // ── מעבר בין התחברות להרשמה
  function setAuthMode(mode) {
    const isRegister = mode === 'register';
    $('#loginForm').classList.toggle('hidden', isRegister);
    $('#registerForm').classList.toggle('hidden', !isRegister);
    $('#authTitle').textContent = isRegister ? 'נעים להכיר' : 'ברוכים השבים';
    $('#authSubtitle').textContent = isRegister
      ? 'שם, מייל וסיסמה — וזהו'
      : 'מייל וסיסמה, או כניסה מהירה עם Google';
    setTimeout(() => (isRegister ? $('#regName') : $('#loginEmail')).focus(), 60);
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-auth]');
    if (btn) setAuthMode(btn.dataset.auth);
  });

  // ── כניסה לאחר אימות מוצלח
  async function enterWith(session) {
    if (!session) throw new Error('לא התקבלה הפעלה');
    state.user = await loadProfile();
    state.streak = await recordVisit();
    toast(`ברוך שובך, ${state.user.name || ''}!`.replace(' !', '!'), 'success');
    await showDashboard();
  }

  // ── התחברות (מייל וסיסמה)
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#loginForm button[type=submit]');
    const email = $('#loginEmail'), pw = $('#loginPassword');

    [email, pw].forEach(f => markError(f, false));
    if (!/^\S+@\S+\.\S+$/.test(email.value)) { markError(email, true); return toast('כתובת המייל אינה תקינה', 'error'); }
    if (!pw.value)                              { markError(pw, true);    return toast('יש להזין סיסמה', 'error'); }

    loading(btn, true);
    try {
      const { data } = await sb.auth.signInWithPassword({
        email: email.value.trim(), password: pw.value,
      }).then(r => { if (r.error) throw new Error(fail(r.error)); return r; });
      await enterWith(data.session);
    } catch (err) {
      toast(err.message, 'error');
      markError(/הסיסמה שגויה/.test(err.message) ? pw : email, true);
      if (/לא נמצא חשבון/.test(err.message)) {
        setAuthMode('register');
        $('#regEmail').value = email.value.trim();
      }
    } finally {
      loading(btn, false);
    }
  });

  // ── הרשמה (שם, מייל וסיסמה)
  $('#registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#registerForm button[type=submit]');
    const name = $('#regName'), email = $('#regEmail'), pw = $('#regPassword');

    [name, email, pw].forEach(f => markError(f, false));
    if (name.value.trim().length < 2)            { markError(name, true);  return toast('יש להזין שם מלא', 'error'); }
    if (!/^\S+@\S+\.\S+$/.test(email.value)) { markError(email, true); return toast('כתובת המייל אינה תקינה', 'error'); }
    if (!pw.value)                               { markError(pw, true);    return toast('יש לבחור סיסמה', 'error'); }

    loading(btn, true);
    try {
      const { data } = await sb.auth.signUp({
        email: email.value.trim(), password: pw.value,
        options: { data: { full_name: name.value.trim() } },
      }).then(r => { if (r.error) throw new Error(fail(r.error)); return r; });
      if (!data.session) {
        toast('נשלח מייל אימות. יש לאשר אותו ואז להתחבר.', 'info', 9000);
        setAuthMode('login');
        $('#loginEmail').value = email.value.trim();
        return;
      }
      await enterWith(data.session);
    } catch (err) {
      toast(err.message, 'error');
      markError(email, true);
      if (/כבר רשומה/.test(err.message)) {
        setAuthMode('login');
        $('#loginEmail').value = email.value.trim();
      }
    } finally {
      loading(btn, false);
    }
  });

  async function showDashboard() {
    showView('dashboard');
    paintUser();
    await Promise.all([loadStats(), loadRecent(), loadDrills(), initSchedule()]);
    paintStreak(state.streak);
  }

  function endSession() {
    state.user = null;
    closeModal();
    closeSidebar();
    showView('auth');
  }

  function paintUser() {
    const u = state.user;
    if (!u) return;
    const initial = (u.name || '?').trim().charAt(0);
    $('#sideName').textContent = u.name;
    $('#sidePosition').textContent = [u.position, u.team].filter(Boolean).join(' · ') || 'שחקן/ית';
    $('#sideAvatar').textContent = initial;
    $('#topAvatar').textContent = initial;
    $('#topName').textContent = u.name;

    const h = new Date().getHours();
    const greet = h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
    $('#topGreeting').textContent = `${greet}, ${u.name.split(' ')[0]}`;
    $('#topSub').textContent = u.goal ? `המטרה שלך: ${u.goal}` : new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  }


  // ───────────────────────────────────────── חגיגת רצף

  function celebrateStreak(days) {
    openModal('רצף!', `
      <div class="py-4 text-center">
        <div class="streak-flame mx-auto text-7xl">🔥</div>
        <p class="mt-4 font-display text-4xl font-extrabold text-ink">${days} ימים ברצף</p>
        <p class="mt-3 text-lg text-muted">נכנסת לאתר ${days} ימים רצופים. זו בדיוק ההתמדה שמייצרת שיפור.</p>
        <button id="streakClose" class="btn-primary mt-7 w-full"><span class="btn-label">ממשיכים</span></button>
      </div>
    `);
    $('#streakClose').addEventListener('click', closeModal);
  }

  function paintStreak(streak) {
    if (streak && streak.milestone) setTimeout(() => celebrateStreak(streak.days), 700);
  }

  // ───────────────────────────────────────── סרגל צד

  const openSidebar  = () => { $('#sidebar').classList.remove('translate-x-full'); $('#sidebarOverlay').classList.remove('hidden'); };
  const closeSidebar = () => { $('#sidebar').classList.add('translate-x-full');    $('#sidebarOverlay').classList.add('hidden'); };
  $('#sidebarOpen').addEventListener('click', openSidebar);
  $('#sidebarClose').addEventListener('click', closeSidebar);
  $('#sidebarOverlay').addEventListener('click', closeSidebar);

  // ───────────────────────────────────────── מדדים, גרף ותחומים

  const KPI_ICONS = {
    check: '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    flame: '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3s5 4.5 5 9a5 5 0 0 1-10 0c0-1.5.6-2.8 1.4-3.8.3 1.2 1.1 2 2.1 2 0-2.6.9-5.2 1.5-7.2Z"/></svg>',
    clock: '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    star:  '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="m12 3 2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8L12 3Z"/></svg>',
  };
  const KPI_TONES = ['bg-blue/10 text-blue', 'bg-emerald-50 text-emerald-600', 'bg-violet-50 text-violet-600'];

  const CAT_BAR = {
    'קליעה': 'bg-gold', 'כדרור': 'bg-blue', 'מסירה': 'bg-sky-400',
    'הגנה': 'bg-navy', 'כושר': 'bg-emerald-500', 'ראש': 'bg-violet-500',
  };

  async function loadStats() {
    $('#kpiRow').innerHTML = Array.from({ length: 3 }, () =>
      '<div class="skeleton h-32 rounded-[1.5rem]"></div>').join('');
    try {
      const stats = await buildStats();
      state.stats = stats;

      // הרצף מוצג בכרטיס העליון; שאר המדדים בשורת הכרטיסים
      const flame = stats.cards.find(c => c.icon === 'flame');
      const rest  = stats.cards.filter(c => c.icon !== 'flame');

      $('#kpiRow').innerHTML = rest.map((c, i) => `
        <div class="rounded-[1.5rem] bg-white p-6 shadow-sm ring-1 ring-navy/[.06] animate-fadeUp" style="animation-delay:${i * 70}ms">
          <span class="grid h-11 w-11 place-items-center rounded-xl ${KPI_TONES[i % KPI_TONES.length]}">${KPI_ICONS[c.icon] || ''}</span>
          <p class="mt-5 font-display text-[32px] font-extrabold leading-none text-ink">${c.value}<span class="text-lg text-muted">${c.suffix || ''}</span></p>
          <p class="mt-2 text-[13px] text-muted">${escapeHtml(c.label)}</p>
        </div>`).join('');

      // מונה הרצף
      const days = flame ? flame.value : 0;
      const next = stats.streak ? stats.streak.next_milestone : 0;
      const every = stats.streak ? stats.streak.every : 5;
      $('#heroStreak').textContent = days;
      $('#sideStreak').textContent = days;
      $('#sideDrills').textContent = rest[0] ? rest[0].value : 0;
      $('#streakBar').style.width = `${Math.min((days % every) / every * 100, 100) || (days ? 100 : 0)}%`;
      const left = Math.max(next - days, 0);
      $('#heroStreakLabel').textContent = days
        ? `עוד ${left} ${left === 1 ? 'יום' : 'ימים'} ליעד ${next}`
        : 'הכניסה של היום פותחת את הרצף';
      $('#streakNote').textContent = days ? `עוד ${left} ליעד ${next}` : '';

      $('#weekTotal').textContent = `${stats.week_total} דקות השבוע`;
      $('#bannerLine').textContent = stats.week_total
        ? `השבוע כבר צברת ${stats.week_total} דקות אימון. עוד תרגיל אחד?`
        : 'עדיין לא התאמנת השבוע — זה הזמן להתחיל.';

      const max = Math.max(...stats.chart.values, 1);
      $('#weekChart').innerHTML = stats.chart.values.map((v, i) => `
        <div class="flex flex-1 flex-col items-center gap-2">
          <span class="text-[11px] font-bold ${v ? 'text-ink' : 'text-navy/20'}">${v || ''}</span>
          <div class="flex w-full flex-1 items-end">
            <div class="w-full rounded-t-lg ${v ? 'bar-col' : 'bg-navy/[.06]'}" style="height:${v ? (v / max) * 100 : 6}%; animation-delay:${i * 70}ms"></div>
          </div>
          <span class="text-[11px] font-bold ${i === 6 ? 'text-blue' : 'text-muted'}">${stats.chart.labels[i]}</span>
        </div>`).join('');

      $('#skillsList').innerHTML = stats.skills.map(s => `
        <div>
          <div class="mb-1.5 flex items-center justify-between text-[13px]">
            <span class="font-bold text-ink">${escapeHtml(s.cat)}</span>
            <span class="text-muted">${s.minutes} דק׳</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-cloud">
            <div class="h-full rounded-full ${CAT_BAR[s.cat] || 'bg-blue'} transition-all duration-700" style="width:${s.pct}%"></div>
          </div>
        </div>`).join('');
    } catch {
      $('#kpiRow').innerHTML = '<p class="text-sm text-muted">לא ניתן לטעון את הנתונים כרגע.</p>';
    }
  }

  const RATING_FACE = { 1: '😖', 2: '😐', 3: '🙂', 4: '😃', 5: '🔥' };

  async function loadRecent() {
    try {
      const items = await loadTrainingSessions();
      const total = items.length;
      $('#logCount').textContent = total;
      const recent = items.slice(0, 5);
      $('#recentList').innerHTML = recent.length ? recent.map(s => `
        <div class="flex items-center gap-4 px-6 py-4 transition hover:bg-cloud/60">
          <span class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${CAT_BAR[s.cat] || 'bg-blue'} text-sm font-extrabold text-white">${escapeHtml(s.cat.charAt(0))}</span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-bold text-ink">${escapeHtml(s.name)}</p>
            <p class="text-xs text-muted">${escapeHtml(s.cat)} · ${s.minutes} דקות · ${escapeHtml(s.at)}</p>
          </div>
          <span class="text-xl" title="תחושה: ${s.rating} מתוך 5">${RATING_FACE[s.rating] || '🙂'}</span>
        </div>`).join('')
        : '<p class="px-6 py-10 text-center text-muted">עדיין אין אימונים — לחצו על "קבלו תרגיל עכשיו" כדי להתחיל.</p>';
    } catch { /* מטופל בטוסט */ }
  }

  async function loadDrills() {
    try {
      const favs = await favoriteIds();
      const items = DRILLS.map(d => ({ ...d, tone: CATEGORY_TONE[d.cat] || 'blue',
                                       favorite: favs.has(d.id) }));
      state.drills = items;
    } catch { /* שקט */ }
  }

  // ───────────────────────────────────────── תרגיל עכשיו + טיימר

  async function actionSuggest() {
    openModal('התרגיל שלך', '<div class="space-y-3"><div class="skeleton h-32 rounded-2xl"></div><div class="skeleton h-20 rounded-2xl"></div></div>');
    try {
      const recent = new Set((await loadTrainingSessions()).slice(0, 3).map(s => s.drill_id));
      const pool = DRILLS.filter(d => !recent.has(d.id));
      const picked = (pool.length ? pool : DRILLS)[Math.floor(Math.random() * (pool.length || DRILLS.length))];
      const favs2 = await favoriteIds();
      const drill = { ...picked, tone: CATEGORY_TONE[picked.cat] || 'blue', favorite: favs2.has(picked.id) };
      renderDrillCard(drill);
    } catch (err) {
      toast(err.message, 'error');
      closeModal();
    }
  }

  function renderDrillCard(drill) {
    openModal('התרגיל שלך', `
      <div class="rounded-2xl bg-gradient-to-bl from-navy2 to-ink p-6 text-white">
        <span class="inline-block rounded-full bg-gold/20 px-3 py-1 text-xs font-bold text-gold">${escapeHtml(drill.cat)} · ${escapeHtml(drill.level)}</span>
        <h4 class="mt-3 font-display text-2xl font-extrabold">${escapeHtml(drill.name)}</h4>
        <p class="mt-2 leading-relaxed text-bluelt">${escapeHtml(drill.desc)}</p>
        <p class="mt-4 flex items-center gap-2 text-sm text-gold">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          ${drill.minutes} דקות · שימו לב: ${escapeHtml(drill.focus)}
        </p>
      </div>

      <div id="timerBox" class="mt-6 rounded-2xl border border-navy/10 bg-cloud p-6 text-center">
        <p id="timerDisplay" class="font-display text-5xl font-extrabold tabular-nums text-ink">${String(drill.minutes).padStart(2, '0')}:00</p>
        <p class="mt-1 text-sm text-muted">טיימר התרגיל</p>
        <div class="mt-4 flex justify-center gap-3">
          <button id="timerStart" class="rounded-xl bg-navy px-6 py-2.5 font-bold text-white transition hover:bg-navy2">התחלה</button>
          <button id="timerReset" class="rounded-xl border border-navy/15 px-6 py-2.5 font-bold text-muted transition hover:bg-white">איפוס</button>
        </div>
      </div>

      <div class="mt-6">
        <p class="mb-2 text-sm font-bold text-ink">איך הרגשת בתרגיל?</p>
        <div id="ratingRow" class="flex gap-2">
          ${[1, 2, 3, 4, 5].map(r => `<button class="rating-btn ${r === 4 ? 'rating-active' : ''}" data-rating="${r}">${RATING_FACE[r]}</button>`).join('')}
        </div>
      </div>

      <div class="mt-6 flex gap-3">
        <button id="drillDone" class="btn-primary flex-1"><span class="btn-label">סיימתי — רשמו ביומן</span></button>
        <button id="drillSwap" class="rounded-xl border border-navy/15 px-5 font-bold text-muted transition hover:bg-cloud">תרגיל אחר</button>
      </div>
    `);

    // טיימר
    let remaining = drill.minutes * 60;
    const display = $('#timerDisplay');
    const paint = () => {
      const m = Math.floor(remaining / 60), s = remaining % 60;
      display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    const startBtn = $('#timerStart');

    startBtn.addEventListener('click', () => {
      if (state.timer) {                        // עצירה
        clearInterval(state.timer); state.timer = null;
        startBtn.textContent = 'המשך';
        return;
      }
      startBtn.textContent = 'עצירה';
      state.timer = setInterval(() => {
        remaining--;
        paint();
        if (remaining <= 0) {
          clearInterval(state.timer); state.timer = null;
          startBtn.textContent = 'התחלה';
          display.classList.add('text-blue');
          toast('הזמן נגמר — כל הכבוד!', 'success');
        }
      }, 1000);
    });

    $('#timerReset').addEventListener('click', () => {
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      remaining = drill.minutes * 60;
      startBtn.textContent = 'התחלה';
      display.classList.remove('text-blue');
      paint();
    });

    // דירוג
    let rating = 4;
    $$('#ratingRow .rating-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        rating = Number(btn.dataset.rating);
        $$('#ratingRow .rating-btn').forEach(b => b.classList.toggle('rating-active', b === btn));
      });
    });

    $('#drillSwap').addEventListener('click', actionSuggest);

    $('#drillDone').addEventListener('click', async () => {
      const btn = $('#drillDone');
      loading(btn, true);
      try {
        check(await sb.from('training_sessions').insert({
          user_id: uid(), drill_id: drill.id, drill_name: drill.name,
          category: drill.cat, minutes: drill.minutes, rating,
        }));
        const data = { message: ENCOURAGEMENTS[Math.floor(Math.random() * ENCOURAGEMENTS.length)] };
        toast(data.message, 'success');
        closeModal();
        await Promise.all([loadStats(), loadRecent()]);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        loading(btn, false);
      }
    });
  }

  // ───────────────────────────────────────── ספריית התרגילים

  async function actionDrills() {
    if (!state.drills.length) await loadDrills();
    renderDrillLibrary();
  }

  function renderDrillLibrary() {
    const cats = ['הכול', 'מועדפים', ...new Set(state.drills.map(d => d.cat))];
    const visible = state.drills.filter(d =>
      state.filter === 'הכול' ? true : state.filter === 'מועדפים' ? d.favorite : d.cat === state.filter);

    openModal('כל התרגילים', `
      <div class="mb-5 flex flex-wrap gap-2">
        ${cats.map(c => `<button class="chip ${c === state.filter ? 'chip-active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        ${visible.length ? visible.map(d => `
          <div class="rounded-2xl border border-navy/10 p-4 transition hover:border-blue/40 hover:shadow-md">
            <div class="flex items-start gap-2">
              <span class="rounded-full ${CAT_BAR[d.cat] || 'bg-blue'} px-2.5 py-0.5 text-xs font-bold text-white">${escapeHtml(d.cat)}</span>
              <button class="fav-btn mr-auto text-xl leading-none" data-fav="${d.id}" aria-label="מועדף">${d.favorite ? '⭐' : '☆'}</button>
            </div>
            <p class="mt-2 font-bold text-ink">${escapeHtml(d.name)}</p>
            <p class="mt-1 text-sm leading-relaxed text-muted">${escapeHtml(d.desc)}</p>
            <div class="mt-3 flex items-center gap-3">
              <span class="text-xs font-bold text-muted">${d.minutes} דק׳ · ${escapeHtml(d.level)}</span>
              <button class="start-btn mr-auto rounded-lg bg-navy px-4 py-1.5 text-sm font-bold text-white transition hover:bg-navy2" data-start="${d.id}">התחלה</button>
            </div>
          </div>`).join('')
        : '<p class="col-span-2 py-10 text-center text-muted">אין תרגילים בקטגוריה הזו.</p>'}
      </div>
    `, true);

    $$('#modalBody [data-cat]').forEach(btn => btn.addEventListener('click', () => {
      state.filter = btn.dataset.cat;
      renderDrillLibrary();
    }));

    $$('#modalBody [data-start]').forEach(btn => btn.addEventListener('click', () => {
      const drill = state.drills.find(d => d.id === Number(btn.dataset.start));
      if (drill) renderDrillCard(drill);
    }));

    $$('#modalBody [data-fav]').forEach(btn => btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.fav);
      try {
        const on = (await favoriteIds()).has(id);
        if (on) check(await sb.from('favorites').delete().eq('user_id', uid()).eq('drill_id', id));
        else    check(await sb.from('favorites').insert({ user_id: uid(), drill_id: id }));
        const data = { favorite: !on, message: on ? 'הוסר מהמועדפים' : 'נוסף למועדפים' };
        const drill = state.drills.find(d => d.id === id);
        if (drill) drill.favorite = data.favorite;
        btn.textContent = data.favorite ? '⭐' : '☆';
        toast(data.message, 'info', 2000);
        if (state.filter === 'מועדפים') renderDrillLibrary();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  // ───────────────────────────────────────── ההתקדמות שלי

  async function actionProgress() {
    openModal('ההתקדמות שלי', '<div class="space-y-3"><div class="skeleton h-40 rounded-2xl"></div><div class="skeleton h-32 rounded-2xl"></div></div>');
    try {
      const stats = await buildStats();
      const max = Math.max(...stats.chart.values, 1);
      openModal('ההתקדמות שלי', `
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          ${stats.cards.map(c => `
            <div class="rounded-2xl bg-cloud p-4 text-center">
              <p class="font-display text-2xl font-extrabold text-ink">${c.value}${c.suffix || ''}</p>
              <p class="mt-1 text-xs text-muted">${escapeHtml(c.label)}</p>
            </div>`).join('')}
        </div>

        <h4 class="mb-3 mt-6 font-display font-extrabold text-ink">דקות אימון בשבוע האחרון</h4>
        <div class="flex h-44 items-end gap-2 rounded-2xl border border-navy/10 bg-cloud/60 p-4">
          ${stats.chart.values.map((v, i) => `
            <div class="flex flex-1 flex-col items-center gap-2">
              <span class="text-xs font-bold ${v ? 'text-ink' : 'text-navy/25'}">${v || ''}</span>
              <div class="flex w-full flex-1 items-end">
                <div class="w-full rounded-t-lg ${v ? 'bar-col' : 'bg-navy/10'}" style="height:${v ? (v / max) * 100 : 5}%; animation-delay:${i * 70}ms"></div>
              </div>
              <span class="text-[11px] font-bold text-muted">${stats.chart.labels[i]}</span>
            </div>`).join('')}
        </div>

        <h4 class="mb-3 mt-6 font-display font-extrabold text-ink">פילוח לפי תחום</h4>
        <div class="space-y-4">
          ${stats.skills.map(s => `
            <div>
              <div class="mb-1.5 flex items-center justify-between text-sm">
                <span class="font-bold text-ink">${escapeHtml(s.cat)}</span>
                <span class="text-muted">${s.minutes} דק׳</span>
              </div>
              <div class="h-2.5 overflow-hidden rounded-full bg-cloud">
                <div class="h-full rounded-full ${CAT_BAR[s.cat] || 'bg-blue'}" style="width:${s.pct}%"></div>
              </div>
            </div>`).join('')}
        </div>
      `);
    } catch (err) {
      toast(err.message, 'error');
      closeModal();
    }
  }

  // ───────────────────────────────────────── יומן האימונים

  async function actionLog() {
    openModal('יומן האימונים', '<div class="space-y-3">' + '<div class="skeleton h-16 rounded-2xl"></div>'.repeat(4) + '</div>');
    try {
      const items = await loadTrainingSessions();
      const total = items.length;
      openModal('יומן האימונים', `
        <p class="mb-4 text-sm text-muted">${total ? `סה״כ <b class="text-ink">${total}</b> אימונים נרשמו` : 'עדיין לא נרשמו אימונים'}</p>
        <div class="space-y-2">
          ${items.length ? items.map(s => `
            <div class="flex items-center gap-4 rounded-2xl border border-navy/10 p-4">
              <span class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${CAT_BAR[s.cat] || 'bg-blue'} text-sm font-extrabold text-white">${escapeHtml(s.cat.charAt(0))}</span>
              <div class="min-w-0 flex-1">
                <p class="truncate font-bold text-ink">${escapeHtml(s.name)}</p>
                <p class="text-xs text-muted">${escapeHtml(s.cat)} · ${s.minutes} דקות · ${escapeHtml(s.at)}</p>
              </div>
              <span class="text-xl">${RATING_FACE[s.rating] || '🙂'}</span>
            </div>`).join('')
          : '<p class="py-10 text-center text-muted">היומן ריק — כל תרגיל שתסיימו יופיע כאן.</p>'}
        </div>
      `);
    } catch (err) {
      toast(err.message, 'error');
      closeModal();
    }
  }

  // ───────────────────────────────────────── היומן השבועי

  const DAY_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

  // אפשרויות "כמה זמן לפני" לכל תזכורת
  const LEAD_OPTIONS = [
    { v: 0,    label: 'כבוי' },
    { v: 1,    label: 'דקה לפני' },
    { v: 5,    label: '5 דקות לפני' },
    { v: 10,   label: '10 דקות לפני' },
    { v: 15,   label: 'רבע שעה לפני' },
    { v: 30,   label: 'חצי שעה לפני' },
    { v: 60,   label: 'שעה לפני' },
    { v: 120,  label: 'שעתיים לפני' },
    { v: 180,  label: 'שלוש שעות לפני' },
    { v: 1440, label: 'יום לפני' },
  ];

  const leadLabel = m => (LEAD_OPTIONS.find(o => o.v === m) || { label: `${m} דקות לפני` }).label;

  async function actionSchedule() {
    openModal('היומן השבועי', '<div class="space-y-3">' + '<div class="skeleton h-14 rounded-2xl"></div>'.repeat(5) + '</div>');
    try {
      const schedule = await loadScheduleData();
      state.schedule = schedule;
      renderScheduleView(schedule);
    } catch (err) {
      toast(err.message, 'error');
      closeModal();
    }
  }

  // ── מצב תצוגה
  function renderScheduleView(sched) {
    const today = new Date().getDay();
    const rows = sched.days.map(d => {
      const isTraining = d.type === 'training';
      return `
        <div class="flex items-center gap-3 rounded-2xl p-3.5 ${isTraining ? 'bg-navy text-white' : 'bg-cloud'} ${d.day === today ? 'ring-2 ring-gold' : ''}">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl font-display font-extrabold ${isTraining ? 'bg-white/15 text-gold' : 'bg-white text-muted'}">${DAY_SHORT[d.day]}</span>
          <div class="min-w-0">
            <p class="font-bold ${isTraining ? 'text-white' : 'text-ink'}">יום ${escapeHtml(d.name)}</p>
            <p class="text-[13px] ${isTraining ? 'text-bluelt' : 'text-muted'}">${isTraining ? `אימון ב-${d.time}` : 'יום חופש'}</p>
          </div>
          ${d.day === today ? '<span class="mr-auto rounded-full bg-gold px-2.5 py-0.5 text-[11px] font-bold text-navy">היום</span>' : ''}
        </div>`;
    }).join('');

    const gap = sched.planned - sched.target;
    const summary = gap === 0
      ? `<span class="text-emerald-600">בדיוק לפי היעד</span>`
      : gap > 0
        ? `<span class="text-blue">${gap} מעל היעד</span>`
        : `<span class="text-rose-500">${-gap} מתחת ליעד</span>`;

    openModal('היומן השבועי', `
      <div class="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-cloud p-4">
        <div>
          <p class="font-display text-2xl font-extrabold text-ink">${sched.planned} <span class="text-base font-bold text-muted">מתוך ${sched.target}</span></p>
          <p class="text-[13px] text-muted">אימונים מתוכננים השבוע · ${summary}</p>
        </div>
        <button id="schedEdit" class="mr-auto flex items-center gap-2 rounded-xl bg-navy px-5 py-2.5 text-sm font-bold text-white transition hover:bg-navy2">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          עריכה
        </button>
      </div>
      <div class="space-y-2">${rows}</div>
      <div id="notifyBox" class="mt-5"></div>
      <p class="mt-3 rounded-2xl bg-gold/10 p-4 text-[13px] leading-relaxed text-ink ring-1 ring-gold/30">
        🔔 ${(sched.reminders || []).length
          ? `בימי אימון תישלח תזכורת ${sched.reminders.map(m => `<b>${leadLabel(m)}</b>`).join(' ו')}`
          : 'התזכורות כבויות'} — כל עוד הדף פתוח בדפדפן.
      </p>
    `);
    $('#schedEdit').addEventListener('click', () => renderScheduleEdit(sched));
    renderNotifyBox();
  }

  // ── מצב עריכה
  function renderScheduleEdit(sched) {
    const leads = sched.reminders || [];
    const lead0Val = leads[0] !== undefined ? leads[0] : 0;
    const lead1Val = leads[1] !== undefined ? leads[1] : 0;
    const rows = sched.days.map(d => `
      <div class="sched-row" data-day="${d.day}">
        <span class="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cloud font-display font-extrabold text-muted">${DAY_SHORT[d.day]}</span>
        <span class="w-16 shrink-0 text-sm font-bold text-ink">${escapeHtml(d.name)}</span>
        <div class="flex shrink-0 gap-1 rounded-xl bg-cloud p-1">
          <button type="button" class="sched-toggle ${d.type === 'training' ? 'sched-on' : ''}" data-type="training">אימון</button>
          <button type="button" class="sched-toggle ${d.type !== 'training' ? 'sched-on' : ''}" data-type="rest">יום חופש</button>
        </div>
        <input type="time" class="sched-time field mr-auto w-28 ${d.type === 'training' ? '' : 'invisible'}" value="${d.time}">
      </div>`).join('');

    openModal('עריכת היומן', `
      <form id="schedForm" class="space-y-5">
        <div class="rounded-2xl bg-cloud p-4">
          <label class="mb-2 block text-sm font-bold text-ink" for="schedTarget">כמה אימונים בשבוע?</label>
          <div class="flex items-center gap-4">
            <input id="schedTarget" type="range" min="0" max="7" step="1" value="${sched.target}" class="a11y-range flex-1">
            <span id="schedTargetVal" class="grid h-11 w-11 place-items-center rounded-xl bg-navy font-display text-lg font-extrabold text-gold">${sched.target}</span>
          </div>
        </div>

        <div class="rounded-2xl bg-cloud p-4">
          <p class="mb-1 text-sm font-bold text-ink">מתי לקבל תזכורת?</p>
          <p class="mb-3 text-[12px] text-muted">אפשר להגדיר עד שתי תזכורות לכל אימון</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1.5 block text-[12px] font-bold text-muted">תזכורת ראשונה</span>
              <select id="lead0" class="field">${LEAD_OPTIONS.map(o => `<option value="${o.v}" ${o.v === lead0Val ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
            </label>
            <label class="block">
              <span class="mb-1.5 block text-[12px] font-bold text-muted">תזכורת שנייה</span>
              <select id="lead1" class="field">${LEAD_OPTIONS.map(o => `<option value="${o.v}" ${o.v === lead1Val ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
            </label>
          </div>
        </div>

        <div>
          <p class="mb-2 text-sm font-bold text-ink">בחרו לכל יום: אימון או חופש</p>
          <div class="space-y-2">${rows}</div>
          <p id="schedCount" class="mt-3 text-center text-[13px] text-muted"></p>
        </div>

        <button type="submit" class="btn-primary w-full"><span class="btn-label">שמירת היומן</span></button>
      </form>
    `);

    const target = $('#schedTarget');
    const refreshCount = () => {
      const chosen = $$('#schedForm .sched-row').filter(r => r.querySelector('.sched-toggle.sched-on').dataset.type === 'training').length;
      const t = Number(target.value);
      $('#schedCount').innerHTML = chosen === t
        ? `נבחרו <b class="text-emerald-600">${chosen}</b> ימי אימון — בדיוק לפי היעד`
        : `נבחרו <b class="text-ink">${chosen}</b> ימי אימון, היעד הוא <b class="text-ink">${t}</b>`;
    };

    target.addEventListener('input', () => { $('#schedTargetVal').textContent = target.value; refreshCount(); });

    $$('#schedForm .sched-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.sched-row');
        row.querySelectorAll('.sched-toggle').forEach(b => b.classList.toggle('sched-on', b === btn));
        row.querySelector('.sched-time').classList.toggle('invisible', btn.dataset.type !== 'training');
        refreshCount();
      });
    });
    refreshCount();

    $('#schedForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('#schedForm button[type=submit]');
      const days = $$('#schedForm .sched-row').map(row => ({
        day: Number(row.dataset.day),
        type: row.querySelector('.sched-toggle.sched-on').dataset.type,
        time: row.querySelector('.sched-time').value || '18:00',
      }));
      loading(btn, true);
      try {
        const reminders = [Number($('#lead0').value), Number($('#lead1').value)].filter(Boolean);
        const stored = {};
        days.forEach(d => { stored[String(d.day)] = { type: d.type, time: validTime(d.time) }; });
        check(await sb.from('schedules').upsert({
          user_id: uid(), target: Number(target.value), days: stored,
          reminders: cleanReminders(reminders), updated_at: new Date().toISOString(),
        }));
        const view = await loadScheduleData();
        const gap = view.planned - view.target;
        const data = { schedule: view, message:
          gap === 0 ? 'היומן נשמר — בדיוק כמו היעד שלך'
          : gap > 0 ? `היומן נשמר — ${view.planned} אימונים, ${gap} מעל היעד`
                    : `היומן נשמר — ${view.planned} אימונים, ${-gap} מתחת ליעד` };
        state.schedule = data.schedule;
        toast(data.message, 'success');
        askNotificationPermission();
        renderScheduleView(data.schedule);
        paintNextTraining();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        loading(btn, false);
      }
    });
  }

  // ───────────────────────────────────────── מצב ההתראות

  function notifyState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;            // granted | denied | default
  }

  function renderNotifyBox() {
    const box = $('#notifyBox');
    if (!box) return;
    const perm = notifyState();

    const label = {
      granted: '<span class="font-bold text-emerald-700">מאושר</span>',
      denied: '<span class="font-bold text-rose-700">חסום</span>',
      default: '<span class="font-bold text-blue">טרם התבקש</span>',
      unsupported: '<span class="font-bold text-rose-700">לא נתמך</span>',
    }[perm];

    const tone = perm === 'granted' ? 'bg-emerald-50 ring-emerald-200'
               : perm === 'denied' ? 'bg-rose-50 ring-rose-200'
               : 'bg-blue/5 ring-blue/20';

    const help = {
      granted: 'אם ההתראה לא מופיעה על המסך — החסימה היא במערכת ההפעלה, לא באתר. במק: הגדרות המערכת ← התראות ← Chrome ← לאפשר, וסגנון "התראות" (לא "כרזות").',
      denied: 'הדפדפן חוסם. לחצו על סמל המנעול או ההגדרות שליד הכתובת ← התראות ← אפשר, ואז רעננו את הדף.',
      default: 'צריך לאשר פעם אחת. לחצו על הכפתור — הדפדפן ישאל, ויש לבחור "אפשר".',
      unsupported: 'הדפדפן הזה לא תומך בהתראות מערכת. התזכורת תופיע בתוך האתר בלבד.',
    }[perm];

    box.innerHTML = `
      <div class="rounded-2xl p-4 ring-1 ${tone}">
        <p class="text-[13px] text-ink">מצב ההתראות במכשיר: ${label}</p>
        <p class="mt-1.5 text-[12px] leading-relaxed text-muted">${help}</p>
        <div class="mt-3 flex flex-wrap gap-2">
          ${perm === 'default' ? '<button id="notifyAsk" class="rounded-xl bg-navy px-5 py-2.5 text-sm font-bold text-white transition hover:bg-navy2">אישור התראות</button>' : ''}
          ${perm !== 'unsupported' ? '<button id="notifyTest" class="rounded-xl border-2 border-navy px-5 py-2 text-sm font-bold text-navy transition hover:bg-navy hover:text-white">בדיקת התראה למכשיר</button>' : ''}
        </div>
        <p id="notifyResult" class="mt-2.5 text-[12px] font-bold"></p>
      </div>`;

    const say = (msg, ok) => {
      const el = $('#notifyResult');
      el.textContent = msg;
      el.className = `mt-2.5 text-[12px] font-bold ${ok ? 'text-emerald-700' : 'text-rose-700'}`;
    };

    const ask = $('#notifyAsk');
    if (ask) ask.addEventListener('click', async () => {
      const res = await Notification.requestPermission();
      renderNotifyBox();
      if (res === 'granted') { say('אושר. שולחת התראת בדיקה…', true); sendTestNotification(say); }
      else say(`הדפדפן החזיר: ${res}. בלי אישור אין התראות למכשיר.`, false);
    });

    const test = $('#notifyTest');
    if (test) test.addEventListener('click', () => {
      if (notifyState() === 'default') {
        Notification.requestPermission().then(() => { renderNotifyBox(); });
        return;
      }
      if (notifyState() !== 'granted') {
        say('ההרשאה חסומה — ההתראה לא נשלחה. צריך לאפשר בהגדרות הדפדפן.', false);
        return;
      }
      sendTestNotification(say);
    });
  }

  // שולח התראת מערכת אמיתית ומדווח מה קרה
  function sendTestNotification(say) {
    try {
      const n = new Notification('Pocket Coach', {
        body: 'זו התראת בדיקה — ככה תיראה התזכורת',
        icon: 'favicon.ico',
        requireInteraction: true,
      });
      let shown = false;
      n.onshow = () => { shown = true; say('ההתראה נשלחה והוצגה במכשיר ✓', true); };
      n.onerror = () => say('הדפדפן דחה את ההתראה.', false);
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => {
        if (!shown) say('ההתראה נשלחה אך המערכת לא אישרה שהיא הוצגה — כנראה חסומה במערכת ההפעלה.', false);
      }, 1500);
    } catch (err) {
      say(`שגיאה בשליחת ההתראה: ${err.message}`, false);
    }
  }

  // ───────────────────────────────────────── תזכורת שעה לפני

  function askNotificationPermission() {
    if (notifyState() !== 'default') return;
    Notification.requestPermission().then(renderNotifyBox);
  }

  function todayEntry() {
    if (!state.schedule) return null;
    const entry = state.schedule.days.find(d => d.day === new Date().getDay());
    return entry && entry.type === 'training' ? entry : null;
  }

  function paintNextTraining() {
    const el = $('#nextTraining');
    if (!el) return;
    const entry = todayEntry();
    if (entry) {
      el.textContent = `היום יש אימון ב-${entry.time}`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  // חלון הירי: רחב יותר לתזכורות מוקדמות, צמוד לתזכורות של הרגע האחרון
  const leadWindow = m => (m >= 30 ? 5 : m >= 10 ? 3 : 2);

  function fireReminder(text) {
    const el = toast(text, 'info', 0);          // נשארת עד לחיצה על ×
    if (notifyState() !== 'granted') return;
    try {
      const n = new Notification('Pocket Coach', {
        body: text,
        icon: 'favicon.ico',
        requireInteraction: true,               // לא נעלמת מעצמה
        tag: `pc-${Date.now()}`,
        silent: false,
      });
      n.onclick = () => { window.focus(); dismissToast(el); n.close(); };
    } catch (err) {
      console.warn('ההתראה נכשלה:', err);
    }
  }

  function reminderText(minutes, time) {
    if (minutes === 1)    return `יש אימון עוד דקה — ב-${time}. מתחילים!`;
    if (minutes === 60)   return `יש אימון עוד שעה — ב-${time}`;
    if (minutes === 1440) return `מחר יש אימון ב-${time}`;
    if (minutes % 60 === 0) {
      const h = minutes / 60;
      return `יש אימון עוד ${h === 2 ? 'שעתיים' : h + ' שעות'} — ב-${time}`;
    }
    return `יש אימון עוד ${minutes} דקות — ב-${time}`;
  }

  function checkReminder() {
    const entry = todayEntry();
    if (!entry || !state.user || !state.schedule) return;

    const leads = state.schedule.reminders || [];
    if (!leads.length) return;

    const now = new Date();
    const [hh, mm] = entry.time.split(':').map(Number);
    const start = new Date(now);
    start.setHours(hh, mm, 0, 0);

    leads.forEach(minutes => {
      const remindAt = new Date(start.getTime() - minutes * 60000);
      const key = `pc_rem_${state.user.email || uid()}_${now.toDateString()}_${minutes}`;
      if (localStorage.getItem(key)) return;

      const diff = now - remindAt;
      if (diff >= 0 && diff < leadWindow(minutes) * 60000) {
        localStorage.setItem(key, '1');
        fireReminder(reminderText(minutes, entry.time));
      }
    });
  }

  async function initSchedule() {
    try {
      const schedule = await loadScheduleData();
      state.schedule = schedule;
      paintNextTraining();
      checkReminder();
      if (state.reminderTimer) clearInterval(state.reminderTimer);
      state.reminderTimer = setInterval(checkReminder, 30000);
    } catch { /* שקט */ }
  }

  // ───────────────────────────────────────── הפרופיל שלי

  function actionSettings() {
    const u = state.user;
    openModal('הפרופיל שלי', `
      <form id="profileForm" class="space-y-4">
        <div class="mb-5 flex items-center gap-4 rounded-2xl bg-gradient-to-bl from-navy2 to-ink p-5 text-white">
          <div class="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-gold font-display text-2xl font-extrabold text-navy">${escapeHtml((u.name || '?').charAt(0))}</div>
          <div class="min-w-0">
            <p class="font-display text-lg font-extrabold">${escapeHtml(u.name)}</p>
            <p class="text-sm text-bluelt">${escapeHtml(u.email)}</p>
            <p class="mt-1 text-xs text-white/60">מתאמן/ת מאז ${escapeHtml(u.joined)}</p>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1.5 block text-sm font-bold text-ink">שם מלא</label>
            <input id="pfName" class="field" value="${escapeHtml(u.name || '')}">
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-bold text-ink">עמדה</label>
            <input id="pfPosition" class="field" value="${escapeHtml(u.position || '')}" placeholder="גארד מוביל">
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-bold text-ink">קבוצה</label>
            <input id="pfTeam" class="field" value="${escapeHtml(u.team || '')}" placeholder="שם הקבוצה">
          </div>
          <div>
            <label class="mb-1.5 block text-sm font-bold text-ink">רמה</label>
            <select id="pfLevel" class="field">
              ${['מתחיל', 'בינוני', 'מתקדם'].map(l => `<option ${l === u.level ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-bold text-ink">המטרה שלי לעונה</label>
          <input id="pfGoal" class="field" value="${escapeHtml(u.goal || '')}" placeholder="לדוגמה: לשפר אחוזי קליעה מהקשת">
        </div>

        <button type="submit" class="btn-primary w-full"><span class="btn-label">שמירת השינויים</span></button>
      </form>
    `);

    $('#profileForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = $('#profileForm button[type=submit]');
      const name = $('#pfName');
      if (name.value.trim().length < 2) { markError(name, true); return toast('יש להזין שם מלא', 'error'); }
      loading(btn, true);
      try {
        check(await sb.from('profiles').update({
          name: name.value.trim(),
          position: $('#pfPosition').value,
          team: $('#pfTeam').value,
          level: $('#pfLevel').value,
          goal: $('#pfGoal').value,
        }).eq('id', uid()));
        const data = { user: await loadProfile(), message: 'הפרטים נשמרו בהצלחה' };
        state.user = data.user;
        paintUser();
        toast(data.message, 'success');
        closeModal();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        loading(btn, false);
      }
    });
  }

  // ───────────────────────────────────────── התנתקות

  function actionLogout() {
    openModal('התנתקות', `
      <p class="text-muted">להתנתק מהחשבון ולחזור למסך הכניסה? ההתקדמות שלך נשמרת.</p>
      <div class="mt-6 flex gap-3">
        <button id="logoutConfirm" class="flex-1 rounded-xl bg-rose-600 py-3 font-bold text-white transition hover:bg-rose-700">כן, התנתק</button>
        <button id="logoutCancel" class="flex-1 rounded-xl border border-navy/15 py-3 font-bold text-muted transition hover:bg-cloud">ביטול</button>
      </div>
    `);
    $('#logoutCancel').addEventListener('click', closeModal);
    $('#logoutConfirm').addEventListener('click', async () => {
      try { await sb.auth.signOut(); } catch { /* מתנתקים בכל מקרה */ }
      if (sb) { try { await sb.auth.signOut(); } catch { /* לא קריטי */ } }
      endSession();
      toast('התנתקת בהצלחה. נתראה באימון הבא!', 'info');
    });
  }

  // ───────────────────────────────────────── ניתוב פעולות

  const ACTIONS = {
    suggest: actionSuggest,
    drills: actionDrills,
    progress: actionProgress,
    log: actionLog,
    schedule: actionSchedule,
    settings: actionSettings,
    logout: actionLogout,
    overview: () => { loadStats(); loadRecent(); toast('הנתונים רועננו', 'info', 2000); },
  };

  document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;
    const fn = ACTIONS[trigger.dataset.action];
    if (!fn) return;

    if (trigger.classList.contains('nav-item')) {
      $$('.nav-item').forEach(n => n.classList.remove('nav-active'));
      if (trigger.dataset.action !== 'logout') trigger.classList.add('nav-active');
      closeSidebar();
    }
    fn();
  });

  // ───────────────────────────────────────── כניסה עם גוגל (Supabase)

  let sb = null;

  const returningFromGoogle = () =>
    new URL(location.href).searchParams.has('code') || location.hash.includes('access_token');

  function showAuthLoader(on) {
    $('#authLoader').classList.toggle('is-on', on);
    if (!on) document.documentElement.removeAttribute('data-returning');
  }

  async function initGoogleAuth() {
    const buttons = $$('[data-google]');
    if (!buttons.length) return;

    if (returningFromGoogle()) showAuthLoader(true);

    if (!window.supabase) {
      showAuthLoader(false);
      buttons.forEach(b => { b.disabled = true; b.title = 'ספריית Supabase לא נטענה'; });
      return;
    }

    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { detectSessionInUrl: true, persistSession: true, flowType: 'pkce' },
    });

    // חזרה מגוגל — יש כבר הפעלה
    const { data: { session } } = await sb.auth.getSession();
    if (session) return exchangeSupabaseSession(session);

    showAuthLoader(false);
    buttons.forEach(btn => btn.addEventListener('click', () => startGoogleLogin(btn)));
  }

  async function startGoogleLogin(btn) {
    if (!sb) return toast('החיבור ל-Supabase לא זמין', 'error');
    btn.disabled = true;
    const label = btn.querySelector('[data-google-label]');
    const original = label ? label.textContent : '';
    if (label) label.textContent = 'מעביר לגוגל…';

    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/app` },
    });

    if (error) {
      btn.disabled = false;
      if (label) label.textContent = original;
      toast(
        /provider is not enabled/i.test(error.message)
          ? 'הכניסה עם גוגל לא מופעלת עדיין ב-Supabase'
          : `שגיאה בכניסה עם גוגל: ${error.message}`,
        'error', 8000);
    }
  }

  async function exchangeSupabaseSession(session) {
    try {
      history.replaceState({}, '', location.pathname);   // ניקוי הפרמטרים מהכתובת
      await enterWith(session);
      showAuthLoader(false);
    } catch (err) {
      showAuthLoader(false);
      toast(err.message, 'error', 8000);
      if (sb) await sb.auth.signOut();
    }
  }

  // ───────────────────────────────────────── אתחול

  (async function init() {
    // ‎/app?mode=register — מגיעים מכפתור "הרשמה" בסרגל העליון של האתר
    const mode = new URLSearchParams(location.search).get('mode');
    setAuthMode(mode === 'register' ? 'register' : 'login');
    await initGoogleAuth();

    if (!sb) return showView('auth');
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return showView('auth');
      state.user = await loadProfile();
      state.streak = await recordVisit();
      await showDashboard();
    } catch {
      showView('auth');
    }
  })();

})();
