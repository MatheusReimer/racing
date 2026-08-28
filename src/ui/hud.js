import { clamp01, lerp } from '../core/math.js';
import { heatState } from '../stats/attributes.js';

// Race HUD.
//
// Built once as DOM, then updated by writing to cached nodes — never by
// re-rendering markup. A HUD that rebuilds its own innerHTML at 60 Hz will
// dominate the frame budget and defeat the CPU headroom the loop works to
// preserve, so every per-frame write here is a style property or a text node,
// guarded by a change check.

const ORDINALS = ['', 'st', 'nd', 'rd'];
const ordinal = (n) => n + (ORDINALS[n] || (n % 10 < 4 && Math.floor(n / 10) !== 1 ? ORDINALS[n % 10] : '') || 'th');

export class HUD {
  constructor(root) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-position">
        <div class="place"><span class="p">1</span><sup>st</sup></div>
        <div class="lap">Lap <span class="l">1</span> / <span class="lt">3</span></div>
      </div>

      <div class="hud-gauges">
        <div class="gauge g-dur">
          <div class="gauge-label"><span>Durability</span><span class="num">100</span></div>
          <div class="gauge-track"><div class="gauge-fill durability"></div></div>
        </div>
        <div class="gauge g-nrg">
          <div class="gauge-label"><span>Energy</span><span class="num">0</span></div>
          <div class="gauge-track"><div class="gauge-fill energy"></div></div>
        </div>
        <div class="gauge g-nos">
          <div class="gauge-label"><span>Nitrous</span><span class="num">100%</span></div>
          <div class="gauge-track"><div class="gauge-fill nos"></div></div>
        </div>
        <div class="gauge g-heat">
          <div class="gauge-label"><span class="hname">Heat</span><span class="num">0%</span></div>
          <div class="gauge-track"><div class="gauge-fill heat"></div></div>
        </div>
      </div>

      <div class="hud-speed">
        <div class="val">0</div>
        <div><span class="unit">KM/H</span></div>
      </div>

      <div class="hud-drift">Drift <span class="dq">0</span></div>
      <div class="hud-state"><span class="lbl"></span><span class="why"></span></div>
      <div class="hud-skills"></div>
      <div class="hud-countdown"></div>
      <div class="hud-perf"></div>
    `;
    root.appendChild(this.el);

    const q = (sel) => this.el.querySelector(sel);
    this.nodes = {
      place: q('.hud-position .p'),
      placeSup: q('.hud-position sup'),
      lap: q('.hud-position .l'),
      lapTotal: q('.hud-position .lt'),
      speed: q('.hud-speed .val'),
      durFill: q('.g-dur .gauge-fill'),
      durNum: q('.g-dur .num'),
      nrgFill: q('.g-nrg .gauge-fill'),
      nrgNum: q('.g-nrg .num'),
      nosGauge: q('.g-nos'),
      nosFill: q('.g-nos .gauge-fill'),
      nosNum: q('.g-nos .num'),
      heatGauge: q('.g-heat'),
      heatFill: q('.g-heat .gauge-fill'),
      heatNum: q('.g-heat .num'),
      heatName: q('.g-heat .hname'),
      drift: q('.hud-drift'),
      driftNum: q('.hud-drift .dq'),
      state: q('.hud-state'),
      stateLabel: q('.hud-state .lbl'),
      stateWhy: q('.hud-state .why'),
      skills: q('.hud-skills'),
      countdown: q('.hud-countdown'),
      perf: q('.hud-perf'),
    };

    this._prev = {};
    this.skillSlots = [];
    this.showPerf = false;
  }

  /** Rebuild the skill row. Called on race start and whenever the build changes. */
  setSkills(skills) {
    this.nodes.skills.innerHTML = '';
    this.skillSlots = skills.map((sk, i) => {
      const el = document.createElement('div');
      el.className = 'skill-slot';
      el.innerHTML = `
        <span class="key">${i + 1}</span>
        <span class="icon">${sk.icon || '✦'}</span>
        <span class="name">${sk.name}</span>
        <span class="lvl">${(sk.level ?? 1) > 1 ? 'L' + sk.level : ''}</span>
        <div class="cd"></div>
      `;
      this.nodes.skills.appendChild(el);
      return { el, cd: el.querySelector('.cd'), skill: sk, _cd: -1, _poor: null };
    });
  }

  setLapTotal(n) {
    this.nodes.lapTotal.textContent = n;
  }

  /** Per-frame. Every write is guarded so untouched nodes cost nothing. */
  update(race, loopStats) {
    const p = race.player;
    const n = this.nodes;
    const prev = this._prev;

    // Speed
    const kmh = Math.round(p.speedKmh);
    if (kmh !== prev.kmh) {
      n.speed.textContent = kmh;
      prev.kmh = kmh;
    }

    // Placing
    if (p.position !== prev.place) {
      n.place.textContent = p.position;
      n.placeSup.textContent = ordinal(p.position).replace(String(p.position), '');
      prev.place = p.position;
    }

    const lap = Math.min(race.config.laps, p.lap + 1);
    if (lap !== prev.lap) {
      n.lap.textContent = lap;
      prev.lap = lap;
    }

    // Durability
    const durPct = Math.round(p.durabilityFrac * 100);
    if (durPct !== prev.dur) {
      n.durFill.style.width = durPct + '%';
      n.durNum.textContent = Math.ceil(p.durability);
      // Bleed toward red as the car fails, so low health is felt peripherally.
      n.durFill.style.backgroundColor = durPct > 50 ? 'var(--durability)'
        : durPct > 22 ? 'var(--heat-hot)' : 'var(--danger)';
      prev.dur = durPct;
    }

    // Energy
    const nrgPct = Math.round(p.energyFrac * 100);
    if (nrgPct !== prev.nrg) {
      n.nrgFill.style.width = nrgPct + '%';
      n.nrgNum.textContent = Math.floor(p.energy);
      prev.nrg = nrgPct;
    }

    // Nitrous
    const nosPct = Math.round(p.nosFrac * 100);
    if (nosPct !== prev.nos || p.nosActive !== prev.nosOn) {
      n.nosFill.style.width = nosPct + '%';
      n.nosNum.textContent = nosPct + '%';
      // Lit while the bottle is open, so the bar reads as a thing being spent
      // rather than a number going down.
      n.nosGauge.classList.toggle('firing', !!p.nosActive);
      prev.nos = nosPct;
      prev.nosOn = p.nosActive;
    }

    // Heat
    const heatPct = Math.round(p.heat);
    if (heatPct !== prev.heat) {
      const st = heatState(p.heat);
      n.heatFill.style.width = Math.min(100, heatPct) + '%';
      n.heatFill.style.backgroundColor = st.color;
      n.heatNum.textContent = heatPct + '%';
      if (st.id !== prev.heatState) {
        n.heatName.textContent = st.id === 'normal' ? 'Heat' : st.name;
        n.heatGauge.classList.toggle('critical', heatPct >= 75);
        prev.heatState = st.id;
      }
      prev.heat = heatPct;
    }

    // Drift meter
    const drifting = p.body.drifting && p.body.driftQuality > 0.04;
    if (drifting !== prev.drifting) {
      n.drift.classList.toggle('on', drifting);
      prev.drifting = drifting;
    }
    if (drifting) {
      const dq = Math.round(p.body.driftQuality * 100);
      if (dq !== prev.dq) { n.driftNum.textContent = dq; prev.dq = dq; }
    }

    // Why the car is not answering, if it is not. Silence here is the failure
    // mode this replaces: every cause below feels identical from the seat.
    const cs = p.controlState(loopStats, race.track);
    const csKey = cs ? cs.id + cs.why : '';
    if (csKey !== prev.csKey) {
      if (cs) {
        n.stateLabel.textContent = cs.label;
        n.stateWhy.textContent = cs.why;
        n.state.classList.add('on');
        n.state.classList.toggle('severe', cs.severity >= 1);
      } else {
        n.state.classList.remove('on', 'severe');
      }
      prev.csKey = csKey;
    }

    // Skills
    for (let i = 0; i < this.skillSlots.length; i++) {
      const slot = this.skillSlots[i];
      const cd = Math.max(0, p.cooldowns[i] || 0);
      const total = slot.skill.cooldown || 1;
      const frac = clamp01(cd / total);
      if (Math.abs(frac - slot._cd) > 0.01) {
        slot.cd.style.transform = `scaleY(${frac})`;
        slot.el.classList.toggle('ready', frac <= 0);
        slot._cd = frac;
      }
      const poor = p.energy < (slot.skill.cost ?? 0);
      if (poor !== slot._poor) {
        slot.el.classList.toggle('poor', poor);
        slot._poor = poor;
      }
    }

    // Countdown
    if (race.state === 'countdown') {
      const c = Math.ceil(race.countdown);
      const txt = c > 0 ? String(c) : 'GO';
      if (txt !== prev.cd) { n.countdown.textContent = txt; prev.cd = txt; }
    } else if (prev.cd !== '') {
      n.countdown.textContent = '';
      prev.cd = '';
    }

    // Perf
    if (this.showPerf && loopStats) {
      const u = Math.round((loopStats.utilisation || 0) * 100);
      const pace = loopStats.pacing ?? 1;
      const ratio = loopStats.realtimeRatio ?? 1;
      // Real time is the line that matters: below 1.0 the game is in slow
      // motion, every control still works at a fraction of the rate, and the
      // player has no way to tell that from broken controls unless it is shown.
      const txt = `${loopStats.fps.toFixed(0)} fps  ${loopStats.p50.toFixed(1)}ms  p99 ${(loopStats.p99 ?? 0).toFixed(0)}ms
CPU ${u}%   pace ${pace.toFixed(2)}x
real time ${(ratio * 100).toFixed(0)}%${loopStats.pacingRelief ? '  [30fps relief]' : ''}
${this.qualityName || ''}`;
      if (txt !== prev.perf) {
        n.perf.textContent = txt;
        n.perf.classList.toggle('warn', u > 92 || pace > 1.3 || ratio < 0.9);
        prev.perf = txt;
      }
    } else if (prev.perf) {
      n.perf.textContent = '';
      prev.perf = '';
    }
  }

  setQualityName(name) {
    this.qualityName = name;
  }

  show() { this.el.style.display = ''; }
  hide() { this.el.style.display = 'none'; }

  dispose() {
    this.el.remove();
  }
}
