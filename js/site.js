/* Site chrome on every page: logo marks, title-block fields, mobile nav. */
(function () {
  'use strict';

  /* ---- skater-apple mark (static) into every [data-mark-svg] ---- */
  const MARK = `
    <g class="mark-apple">
      <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 9 C 8 8, 4 12, 4 17 C 4 21, 6.5 24, 10 24 L 18 24 C 21.5 24, 24 21, 24 17 C 24 12, 20 8, 14 9 Z"/>
        <path d="M14 9 C 14 7, 14.5 5, 16 4"/>
        <path d="M16 7 C 18.5 4.5, 21 5, 22 7.5 C 20 9, 17.5 8.5, 16 7 Z"/>
      </g>
      <circle cx="11" cy="16" r="1.6" fill="currentColor"/>
      <circle cx="17" cy="16" r="1.6" fill="currentColor"/>
      <circle cx="11.5" cy="15.5" r="0.45" fill="var(--film)"/>
      <circle cx="17.5" cy="15.5" r="0.45" fill="var(--film)"/>
      <path d="M11.5 19.5 C 12.5 21, 15.5 21, 16.5 19.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </g>
    <g class="mark-board">
      <g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M 4 25.5 L 24 25.5"/>
        <path d="M 3.5 25 C 3 25, 3 26, 3.5 26 L 24.5 26 C 25 26, 25 25, 24.5 25"/>
      </g>
      <circle cx="7" cy="26.5" r="1.2" fill="currentColor"/>
      <circle cx="21" cy="26.5" r="1.2" fill="currentColor"/>
    </g>`;
  document.querySelectorAll('[data-mark-svg]').forEach(svg => { svg.innerHTML = MARK; });

  /* when the homepage apple lands a trick, every logo on the page kickflips with it */
  let markTimer = 0;
  document.addEventListener('workcell:trick', () => {
    const marks = document.querySelectorAll('[data-mark-svg]');
    marks.forEach(svg => { svg.classList.remove('mark-trick'); svg.getBoundingClientRect(); svg.classList.add('mark-trick'); });
    clearTimeout(markTimer);
    markTimer = setTimeout(() => marks.forEach(svg => svg.classList.remove('mark-trick')), 900);
  });

  /* ---- title block: printed date (visitor's day) ---- */
  const printed = document.getElementById('printed-date');
  if (printed) {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    printed.textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* ---- title block: what Caleb is probably doing, on San Francisco time ---- */
  const nowEl = document.getElementById('now-state');
  if (nowEl) {
    let h, min, wd;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23'
      }).formatToParts(new Date());
      const get = t => (parts.find(x => x.type === t) || {}).value;
      h = +get('hour'); min = +get('minute'); wd = get('weekday');
    } catch (_) {
      const d = new Date(); h = d.getHours(); min = d.getMinutes(); wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    }
    const t = h * 60 + min;
    const weekend = wd === 'Sat' || wd === 'Sun';
    let m;
    if (weekend) {
      if (t < 7 * 60) m = 'Probably asleep';
      else if (t < 10 * 60) m = 'Making coffee and easing in';
      else if (t < 14 * 60) m = 'In the garden or on a trail';
      else if (t < 18 * 60) m = 'Out on an adventure';
      else if (t < 20 * 60) m = 'In the sauna';
      else m = 'Off the grid';
    } else {
      if (t < 5 * 60 + 30) m = 'Probably asleep';
      else if (t < 8 * 60) m = 'On a trail in West Marin';
      else if (t < 12 * 60) m = 'Probably on my second coffee';
      else if (t < 17 * 60) m = 'In back-to-back conversations';
      else if (t < 19 * 60) m = 'At the climbing gym';
      else if (t < 22 * 60) m = 'Cooking a complicated dinner';
      else m = 'Winding down';
    }
    nowEl.textContent = m;
  }

  /* ---- nav: mobile toggle ---- */
  const toggle = document.querySelector('.nav-toggle');
  const links = document.getElementById('nav-links');
  if (toggle && links) {
    const close = () => { toggle.setAttribute('aria-expanded', 'false'); links.classList.remove('open'); };
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      links.classList.toggle('open', !open);
    });
    links.addEventListener('click', e => { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  console.log('%cYou found the console. The arm is Matter.js plus a little inverse kinematics; the walker is a hand-rolled Verlet sim.', 'color:#1D2766;font:600 13px Archivo,sans-serif');
})();
