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
        <div class="draft">Slipstream</div>
      </div>

      <div class="hud-corner">
        <div class="arrow">&#8598;</div>
        <div class="tx">
          <div class="sev">Easy left</div>
          <div class="dist">200 m</div>
        </div>
      </div>

      <div class="hud-pit">
        <div class="ico">&#128295;</div>
        <div class="tx">
          <div class="what">Mechanic</div>
          <div class="deal">0 scrap</div>
        </div>
      </div>

      <div class="hud-flash"></div>

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
      speedBox: q('.hud-speed'),
      flash: q('.hud-flash'),
      pit: q('.hud-pit'),
      pitIcon: q('.hud-pit .ico'),
      pitWhat: q('.hud-pit .what'),
      pitDeal: q('.hud-pit .deal'),
      corner: q('.hud-corner'),
      cornerArrow: q('.hud-corner .arrow'),
      cornerSev: q('.hud-corner .sev'),
      cornerDist: q('.hud-corner .dist'),
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
        <span class="ammo"></span>
        <div class="cd"></div>
      `;
      this.nodes.skills.appendChild(el);
      return {
        el, cd: el.querySelector('.cd'), ammo: el.querySelector('.ammo'),
        skill: sk, _cd: -1, _poor: null, _ammo: null,
      };
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

    // Slipstream. A tow you cannot tell you are getting is a number the game
    // keeps to itself; the speed rising is the effect, this is the reason.
    const towed = (p.body?.draft ?? 0) > 0.3;
    if (towed !== prev.towed) {
      n.speedBox?.classList.toggle('towed', towed);
      prev.towed = towed;
    }

    // The pit lane ahead.
    //
    // The price has to arrive before the entry does, because entering is the
    // decision — there is no menu once you are in the lane. So this reads as
    // an offer rather than a marker: what it sells, what it would cost, and
    // whether the money is there.
    const pit = race.nextPit ? race.nextPit() : null;
    const pitDist = pit ? Math.round(pit.distance / 10) * 10 : -1;
    const pitKey = pit ? `${pit.service.id}${pit.price}${pitDist}${pit.inLane}` : '';
    if (pitKey !== prev.pit) {
      prev.pit = pitKey;
      n.pit.classList.toggle('on', !!pit);
      if (pit) {
        n.pitIcon.textContent = pit.service.icon;
        n.pitWhat.textContent = pit.inLane ? `In the pits — ${pit.service.name}` : pit.service.name;
        n.pitDeal.textContent = !pit.useful ? 'nothing to do'
          : !pit.affordable ? `${pit.price} scrap — no money`
            : pit.inLane ? `${pit.price} scrap` : `${pit.price} scrap · ${pitDist} m`;
        n.pit.classList.toggle('dead', !pit.useful || !pit.affordable);
        n.pit.classList.toggle('here', !!pit.inLane);
        n.pit.style.setProperty('--pit-color', pit.service.color);
      }
    }

    // The next corner, as a pace note.
    //
    // Rounded to ten metres before it is compared: the raw distance changes
    // every frame at ninety metres a second, and rewriting the DOM sixty times
    // a second to move a number nobody can read is the whole reason this file
    // caches every field it touches.
    const corner = race.nextCorner ? race.nextCorner() : null;
    const dist = corner ? Math.round(corner.distance / 10) * 10 : -1;
    const key = corner ? `${corner.severity}${corner.direction}${dist}` : '';
    if (key !== prev.corner) {
      prev.corner = key;
      n.corner.classList.toggle('on', !!corner);
      if (corner) {
        const left = corner.direction < 0;
        n.cornerArrow.innerHTML = left ? '&#8598;' : '&#8599;';
        n.cornerSev.textContent =
          `${corner.severity[0].toUpperCase()}${corner.severity.slice(1)} ${left ? 'left' : 'right'}`;
        n.cornerDist.textContent = `${dist} m`;
        // A hairpin at forty metres is a different message from an easy right
        // at two hundred, and the difference has to arrive before the corner.
        n.corner.classList.toggle('urgent', corner.radius < 48 && dist <= 90);
      }
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

      // What is left in the magazine.
      //
      // The count, not a bar: with four or five rounds in it the difference
      // between two and one is the whole decision, and a bar at 40% does not
      // say "one more". Empty is the state that has to be unmistakable, since
      // pressing the key then does nothing at all.
      const left = p.charges?.[i] ?? null;
      if (left !== slot._ammo) {
        slot.ammo.textContent = left == null ? '' : String(left);
        slot.el.classList.toggle('empty', left === 0);
        slot.el.classList.toggle('last', left === 1);
        slot._ammo = left;
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

  /**
   * A line that says something happened, then goes.
   *
   * The race does not stop for a pit stop, so what the stop bought has to be
   * legible without being read: a big line for a second and a half, gone
   * before the next corner needs the screen back.
   */
  flash(text, color = null) {
    const el = this.nodes.flash;
    if (!el) return;
    el.textContent = text;
    el.style.color = color || '';
    el.classList.remove('on');
    // Reflow, or a second flash inside the fade never restarts the animation.
    void el.offsetWidth;
    el.classList.add('on');
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => el.classList.remove('on'), 1600);
  }

  setQualityName(name) {
    this.qualityName = name;
  }

  show() { this.el.style.display = ''; }
  hide() { this.el.style.display = 'none'; }

  dispose() {
    clearTimeout(this._flashTimer);
    this.el.remove();
  }
}
