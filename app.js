/**
 * TradingTimeTable — session clock, sort, quotes, timeline (Beijing time)
 */
(function () {
  'use strict';

  const TZ = 'Asia/Shanghai';
  const STATUS = {
    open: { key: 'open', label: '交易中', chip: 'chip-open' },
    lunch: { key: 'lunch', label: '午间休市', chip: 'chip-lunch' },
    pre: { key: 'pre', label: '盘前', chip: 'chip-pre' },
    post: { key: 'post', label: '盘后', chip: 'chip-post' },
    overnight: { key: 'overnight', label: '隔夜休市', chip: 'chip-overnight' },
    weekend: { key: 'weekend', label: '周末休市', chip: 'chip-weekend' },
    holiday: { key: 'holiday', label: '休市（节假日）', chip: 'chip-holiday' },
  };

  const holidaySets = Object.create(null);
  Object.keys(HOLIDAYS).forEach((k) => {
    holidaySets[k] = new Set(HOLIDAYS[k]);
  });
  const halfDaySets = Object.create(null);
  Object.keys(HALF_DAYS || {}).forEach((k) => {
    halfDaySets[k] = new Set(HALF_DAYS[k]);
  });
  const earlyCloseSets = Object.create(null);
  Object.keys(EARLY_CLOSE || {}).forEach((k) => {
    earlyCloseSets[k] = new Set(EARLY_CLOSE[k]);
  });

  const quoteCache = Object.create(null);
  const cardState = Object.create(null);
  let lastOrderKey = '';
  let marketsRoot = null;

  const bjPartsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const clockDateFmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  function getBeijingParts(date) {
    const bag = {};
    for (const p of bjPartsFmt.formatToParts(date)) {
      if (p.type !== 'literal') bag[p.type] = p.value;
    }
    const year = +bag.year;
    const month = +bag.month;
    const day = +bag.day;
    const hour = +bag.hour;
    const minute = +bag.minute;
    const second = +bag.second;
    const wd = bag.weekday; // Sun Mon ...
    const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd];
    return {
      year,
      month,
      day,
      hour,
      minute,
      second,
      weekday,
      minutes: hour * 60 + minute,
      ymd: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function fmtHM(minutes) {
    const m = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
    return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  }

  function addDaysYmd(ymd, delta) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }

  function weekdayOfYmd(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  /** 2nd Sunday of March → 1st Sunday of November (US DST). */
  function isUsDstByYmd(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const secondSunMar = nthWeekdayOfMonth(y, 3, 0, 2);
    const firstSunNov = nthWeekdayOfMonth(y, 11, 0, 1);
    const key = y * 10000 + m * 100 + d;
    const start = y * 10000 + 3 * 100 + secondSunMar;
    const end = y * 10000 + 11 * 100 + firstSunNov;
    return key >= start && key < end;
  }

  function nthWeekdayOfMonth(year, month, weekday, n) {
    let count = 0;
    for (let day = 1; day <= 31; day++) {
      const dt = new Date(Date.UTC(year, month - 1, day));
      if (dt.getUTCMonth() !== month - 1) break;
      if (dt.getUTCDay() === weekday) {
        count += 1;
        if (count === n) return day;
      }
    }
    return null;
  }

  function isHoliday(key, ymd) {
    return !!(key && holidaySets[key] && holidaySets[key].has(ymd));
  }

  function isHalfDay(key, ymd) {
    return !!(key && halfDaySets[key] && halfDaySets[key].has(ymd));
  }

  function isEarlyClose(key, ymd) {
    return !!(key && earlyCloseSets[key] && earlyCloseSets[key].has(ymd));
  }

  function usWindows(dst, early) {
    // DST BJT: pre 16:00–21:30, open 21:30–04:00, post 04:00–08:00
    // Standard: +1h
    const shift = dst ? 0 : 60;
    const preStart = 16 * 60 + shift;
    const openStart = 21 * 60 + 30 + shift;
    // open end / post start crosses midnight
    let openEnd = 4 * 60 + shift; // next calendar day
    const postEnd = 8 * 60 + shift;
    if (early) {
      // 13:00 ET → DST 01:00 BJT, EST 02:00 BJT
      openEnd = 1 * 60 + shift;
    }
    return { preStart, openStart, openEnd, postEnd, crossesMidnight: true };
  }

  /**
   * US session anchor date in BJT calendar:
   * early morning (before postEnd) belongs to previous day's US session.
   */
  function usAnchorYmd(parts, dst) {
    const postEnd = (dst ? 8 : 9) * 60;
    if (parts.minutes < postEnd) return addDaysYmd(parts.ymd, -1);
    return parts.ymd;
  }

  function buildEquityTimeline(sessions, halfDay) {
    const segs = [];
    if (sessions.continuous) {
      const [a, b] = sessions.continuous;
      segs.push({ type: 'open', start: a, end: b });
      return segs;
    }
    const [m0, m1] = sessions.morning;
    segs.push({ type: 'open', start: m0, end: m1 });
    if (halfDay) return segs;
    if (sessions.lunch) {
      const [l0, l1] = sessions.lunch;
      segs.push({ type: 'lunch', start: l0, end: l1 });
    }
    if (sessions.afternoon) {
      const [a0, a1] = sessions.afternoon;
      segs.push({ type: 'open', start: a0, end: a1 });
    }
    return segs;
  }

  function buildUsTimeline(dst, early) {
    const w = usWindows(dst, early);
    const segs = [];
    // Pre on anchor day
    segs.push({ type: 'pre', start: w.preStart, end: w.openStart, day: 0 });
    // Open may cross midnight
    if (w.openStart < 24 * 60) {
      if (w.openEnd > w.openStart) {
        segs.push({ type: 'open', start: w.openStart, end: w.openEnd, day: 0 });
      } else {
        segs.push({ type: 'open', start: w.openStart, end: 24 * 60, day: 0 });
        segs.push({ type: 'open', start: 0, end: w.openEnd, day: 1 });
      }
    }
    segs.push({ type: 'post', start: w.openEnd, end: w.postEnd, day: 1 });
    return { segs, windows: w };
  }

  function nextOpenMs(market, now, parts) {
    if (market.alwaysOpen) return 0;

    // Scan forward up to 14 days for next open minute
    for (let dayOffset = 0; dayOffset < 16; dayOffset++) {
      const ymd = addDaysYmd(parts.ymd, dayOffset);
      const wd = weekdayOfYmd(ymd);

      if (market.usMarket) {
        const dst = isUsDstByYmd(ymd);
        if (wd === 0 || wd === 6) continue;
        if (isHoliday(market.holidayKey, ymd)) continue;
        const early = isEarlyClose(market.earlyCloseKey, ymd);
        const w = usWindows(dst, early);
        // open starts on anchor evening
        const openMinuteOfDay = w.openStart;
        const openDate = new Date(now.getTime());
        // Construct BJT datetime for ymd + openMinuteOfDay
        const target = bjtToUtcApprox(ymd, openMinuteOfDay);
        if (target > now.getTime()) return target - now.getTime();
        // If we're already past open start on this anchor but still before open end next morning
        const openEndTarget = bjtToUtcApprox(addDaysYmd(ymd, 1), w.openEnd);
        if (now.getTime() < openEndTarget && dayOffset === 0) return 0;
        continue;
      }

      if (wd === 0 || wd === 6) continue;
      if (isHoliday(market.holidayKey, ymd)) continue;
      const half = isHalfDay(market.halfDayKey, ymd);
      const segs = buildEquityTimeline(market.sessions, half).filter((s) => s.type === 'open');
      for (const seg of segs) {
        if (dayOffset === 0 && parts.minutes >= seg.start && parts.minutes < seg.end) return 0;
        if (dayOffset === 0 && parts.minutes >= seg.end) continue;
        if (dayOffset === 0 && parts.minutes < seg.start) {
          return bjtToUtcApprox(ymd, seg.start) - now.getTime();
        }
        if (dayOffset > 0) {
          return bjtToUtcApprox(ymd, seg.start) - now.getTime();
        }
      }
    }
    return 7 * 24 * 60 * 60 * 1000;
  }

  /** Approximate UTC ms for a Beijing wall-clock ymd + minutes (CST, no DST). */
  function bjtToUtcApprox(ymd, minutes) {
    const [y, m, d] = ymd.split('-').map(Number);
    const hh = Math.floor(minutes / 60);
    const mm = minutes % 60;
    // Asia/Shanghai = UTC+8 year-round
    return Date.UTC(y, m - 1, d, hh - 8, mm, 0);
  }

  function evaluateMarket(market, now, parts) {
    if (market.alwaysOpen) {
      return {
        status: STATUS.open,
        countdownLabel: '24小时交易',
        countdownText: '持续开放',
        minutesToEvent: 0,
        sortKey: -1,
        timelineSegs: market.timeline.slice(),
        boundaryMinutes: [0, 24 * 60],
        structureKey: 'crypto-24',
      };
    }

    if (market.usMarket) {
      return evaluateUs(market, now, parts);
    }

    const ymd = parts.ymd;
    const half = isHalfDay(market.halfDayKey, ymd);
    const segs = buildEquityTimeline(market.sessions, half);
    const structureKey = `${market.id}|${ymd}|${half ? 'h' : 'f'}|${segs.map((s) => s.type + s.start + s.end).join(',')}`;

    if (isHoliday(market.holidayKey, ymd)) {
      return closedResult(STATUS.holiday, market, now, parts, segs, structureKey);
    }
    if (parts.weekday === 0 || parts.weekday === 6) {
      return closedResult(STATUS.weekend, market, now, parts, segs, structureKey);
    }

    const min = parts.minutes;
    let status = STATUS.overnight;
    let eventMin = null;
    let countdownLabel = '距开盘';

    for (const seg of segs) {
      if (min >= seg.start && min < seg.end) {
        if (seg.type === 'open') {
          status = STATUS.open;
          eventMin = seg.end;
          // if next seg is lunch, label 距午休; else 距收盘
          const idx = segs.indexOf(seg);
          const next = segs[idx + 1];
          countdownLabel = next && next.type === 'lunch' ? '距午休' : '距收盘';
        } else if (seg.type === 'lunch') {
          status = STATUS.lunch;
          eventMin = seg.end;
          countdownLabel = '距开盘';
        }
        break;
      }
    }

    if (status.key === 'overnight') {
      // before first open or after last close
      const opens = segs.filter((s) => s.type === 'open');
      if (opens.length && min < opens[0].start) {
        eventMin = opens[0].start;
        countdownLabel = '距开盘';
      } else {
        // after close → next day's open
        const ms = nextOpenMs(market, now, parts);
        return {
          status: STATUS.overnight,
          countdownLabel: '距开盘',
          countdownText: formatCountdown(ms),
          minutesToEvent: Math.max(0, Math.round(ms / 60000)),
          sortKey: ms,
          timelineSegs: segs,
          boundaryMinutes: uniqueBoundaries(segs),
          structureKey,
        };
      }
    }

    const msLeft = Math.max(0, (eventMin - min) * 60000 - parts.second * 1000);
    const sortKey = status.key === 'open' ? msLeft : nextOpenMs(market, now, parts);

    return {
      status,
      countdownLabel,
      countdownText: formatCountdown(msLeft),
      minutesToEvent: Math.max(0, Math.round(msLeft / 60000)),
      sortKey: status.key === 'open' ? -1e15 + msLeft : sortKey,
      timelineSegs: segs,
      boundaryMinutes: uniqueBoundaries(segs),
      structureKey,
    };
  }

  function closedResult(status, market, now, parts, segs, structureKey) {
    const ms = nextOpenMs(market, now, parts);
    return {
      status,
      countdownLabel: '距开盘',
      countdownText: formatCountdown(ms),
      minutesToEvent: Math.max(0, Math.round(ms / 60000)),
      sortKey: ms,
      timelineSegs: segs,
      boundaryMinutes: uniqueBoundaries(segs),
      structureKey,
    };
  }

  function evaluateUs(market, now, parts) {
    // Determine which US session we're in relative to BJT
    // Check both possible anchors: today and yesterday
    const candidates = [];
    for (const offset of [0, -1]) {
      const anchor = addDaysYmd(parts.ymd, offset);
      const dst = isUsDstByYmd(anchor);
      const wd = weekdayOfYmd(anchor);
      const early = isEarlyClose(market.earlyCloseKey, anchor);
      const w = usWindows(dst, early);
      const { segs } = buildUsTimeline(dst, early);

      // Map "now" onto anchor-relative minutes
      // day0 = anchor date, day1 = anchor+1
      let relDay = null;
      let relMin = parts.minutes;
      if (parts.ymd === anchor) {
        relDay = 0;
      } else if (parts.ymd === addDaysYmd(anchor, 1)) {
        relDay = 1;
      } else {
        continue;
      }

      const holiday = isHoliday(market.holidayKey, anchor);
      const weekend = wd === 0 || wd === 6;

      candidates.push({ anchor, dst, early, w, segs, relDay, relMin, holiday, weekend });
    }

    // Prefer the candidate whose window currently covers "now"
    let active = null;
    for (const c of candidates) {
      if (c.holiday || c.weekend) continue;
      for (const seg of c.segs) {
        if (seg.day === c.relDay && c.relMin >= seg.start && c.relMin < seg.end) {
          active = { ...c, seg };
          break;
        }
      }
      if (active) break;
    }

    // Timeline display: show today's BJT strip for the session that owns "now",
    // or the upcoming session's evening piece + overnight piece.
    const displayDst = isUsDstByYmd(parts.ymd);
    const displayEarly = isEarlyClose(market.earlyCloseKey, usAnchorYmd(parts, displayDst));
    const display = buildUsTimeline(displayDst, displayEarly);
    // Flatten to single-day BJT bar for *today*
    const todaySegs = flattenUsDaySegs(display.segs, display.windows, parts.ymd, displayDst);
    const structureKey = `us|${parts.ymd}|${displayDst}|${displayEarly}|${todaySegs.map((s) => s.type + s.start + s.end).join(',')}`;

    if (active) {
      const seg = active.seg;
      let status = STATUS.open;
      let countdownLabel = '距收盘';
      let eventAbs;

      if (seg.type === 'pre') {
        status = STATUS.pre;
        countdownLabel = '距开盘';
        eventAbs = bjtToUtcApprox(active.anchor, active.w.openStart);
      } else if (seg.type === 'post') {
        status = STATUS.post;
        countdownLabel = '距开盘';
        // next open
        const ms = nextOpenMs(market, now, parts);
        return {
          status,
          countdownLabel,
          countdownText: formatCountdown(ms),
          minutesToEvent: Math.max(0, Math.round(ms / 60000)),
          sortKey: ms,
          timelineSegs: todaySegs,
          boundaryMinutes: uniqueBoundaries(todaySegs),
          structureKey,
        };
      } else {
        status = STATUS.open;
        countdownLabel = '距收盘';
        eventAbs = bjtToUtcApprox(addDaysYmd(active.anchor, 1), active.w.openEnd);
        // if openEnd is same calendar interpretation...
        if (active.w.openEnd > active.w.openStart) {
          eventAbs = bjtToUtcApprox(active.anchor, active.w.openEnd);
        }
      }

      const msLeft = Math.max(0, eventAbs - now.getTime());
      return {
        status,
        countdownLabel,
        countdownText: formatCountdown(msLeft),
        minutesToEvent: Math.max(0, Math.round(msLeft / 60000)),
        sortKey: status.key === 'open' ? -1e15 + msLeft : msLeft,
        timelineSegs: todaySegs,
        boundaryMinutes: uniqueBoundaries(todaySegs),
        structureKey,
      };
    }

    // Not in an active window — holiday / weekend / overnight for the relevant anchor
    const anchor = usAnchorYmd(parts, isUsDstByYmd(parts.ymd));
    const aWd = weekdayOfYmd(anchor);
    let status = STATUS.overnight;
    if (isHoliday(market.holidayKey, anchor)) status = STATUS.holiday;
    else if (aWd === 0 || aWd === 6) status = STATUS.weekend;

    // Also: if "today" is weekend/holiday and we're not in previous session's leftover
    if (!active) {
      const today = parts.ymd;
      if (isHoliday(market.holidayKey, today) && parts.minutes >= (isUsDstByYmd(today) ? 8 * 60 : 9 * 60)) {
        status = STATUS.holiday;
      } else if ((parts.weekday === 0 || parts.weekday === 6) && parts.minutes >= (isUsDstByYmd(today) ? 8 * 60 : 9 * 60)) {
        // careful: Friday night session extends into Saturday morning — already handled by active
        if (!(parts.weekday === 6 && parts.minutes < (isUsDstByYmd(addDaysYmd(today, -1)) ? 8 * 60 : 9 * 60))) {
          status = STATUS.weekend;
        }
      }
    }

    const ms = nextOpenMs(market, now, parts);
    return {
      status,
      countdownLabel: '距开盘',
      countdownText: formatCountdown(ms),
      minutesToEvent: Math.max(0, Math.round(ms / 60000)),
      sortKey: ms,
      timelineSegs: todaySegs,
      boundaryMinutes: uniqueBoundaries(todaySegs),
      structureKey,
    };
  }

  function flattenUsDaySegs(segs, windows, todayYmd, dst) {
    // Paint segments that fall on today's BJT date
    const out = [];
    const postEnd = windows.postEnd;
    const preStart = windows.preStart;

    // Morning leftover from previous session: 00:00–openEnd (open) and openEnd–postEnd (post)
    // if today continues yesterday's session
    const yAnchor = addDaysYmd(todayYmd, -1);
    const yDst = isUsDstByYmd(yAnchor);
    const yEarly = isEarlyClose('us', yAnchor);
    const yw = usWindows(yDst, yEarly);
    const yWd = weekdayOfYmd(yAnchor);
    if (yWd !== 0 && yWd !== 6 && !isHoliday('us', yAnchor)) {
      out.push({ type: 'open', start: 0, end: yw.openEnd });
      out.push({ type: 'post', start: yw.openEnd, end: yw.postEnd });
    }

    // Evening of today if today is a US trading day
    const tWd = weekdayOfYmd(todayYmd);
    if (tWd !== 0 && tWd !== 6 && !isHoliday('us', todayYmd)) {
      const tEarly = isEarlyClose('us', todayYmd);
      const tw = usWindows(dst, tEarly);
      out.push({ type: 'pre', start: tw.preStart, end: tw.openStart });
      out.push({ type: 'open', start: tw.openStart, end: 24 * 60 });
    }

    return mergeSegs(out);
  }

  function mergeSegs(segs) {
    return segs
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);
  }

  function uniqueBoundaries(segs) {
    const set = new Set([0, 24 * 60]);
    for (const s of segs) {
      set.add(s.start);
      set.add(s.end);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  function formatCountdown(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const totalMin = Math.floor(ms / 60000);
    const days = Math.floor(totalMin / (60 * 24));
    const hours = Math.floor((totalMin % (60 * 24)) / 60);
    const mins = totalMin % 60;
    if (days > 0) return `${days}天${hours}小时${mins}分`;
    if (hours > 0) return `${hours}小时${mins}分`;
    return `${mins}分`;
  }

  /* -------------------- DOM -------------------- */

  function ensureCards(order) {
    const key = order.map((m) => m.id).join('|');
    if (key === lastOrderKey && marketsRoot.children.length === order.length) {
      return false;
    }
    lastOrderKey = key;
    const frag = document.createDocumentFragment();
    for (const market of order) {
      let el = cardState[market.id] && cardState[market.id].el;
      if (!el) {
        el = createCard(market);
        cardState[market.id] = { el, structureKey: '', quoteHash: '' };
      }
      frag.appendChild(el);
    }
    marketsRoot.innerHTML = '';
    marketsRoot.appendChild(frag);
    return true;
  }

  function createCard(market) {
    const article = document.createElement('article');
    article.className = 'market-card';
    article.dataset.market = market.id;

    article.innerHTML = `
      <div class="market-head">
        <div>
          <div class="market-title-row">
            <h2 class="market-name"></h2>
            <span class="market-short"></span>
            <span class="market-exchange"></span>
          </div>
        </div>
        <div class="market-status-wrap">
          <span class="chip status-chip"></span>
          <div class="countdown"><span class="cd-label"></span> <strong class="cd-value"></strong></div>
        </div>
      </div>
      <div class="quotes"></div>
      <div class="timeline-wrap">
        <div class="timeline"></div>
        <div class="timeline-labels"></div>
      </div>
    `;

    article.querySelector('.market-name').textContent = market.name;
    article.querySelector('.market-short').textContent = market.short;
    article.querySelector('.market-exchange').textContent = market.exchange;

    const quotesEl = article.querySelector('.quotes');
    for (const q of market.quotes) {
      const div = document.createElement('div');
      div.className = 'quote flat';
      div.dataset.quote = q.id;
      div.innerHTML = `
        <span class="quote-label"></span>
        <div class="quote-row">
          <span class="quote-price">--</span>
          <span class="quote-chg">--</span>
        </div>
      `;
      div.querySelector('.quote-label').textContent = q.label;
      quotesEl.appendChild(div);
    }

    return article;
  }

  function updateCard(market, state) {
    const cs = cardState[market.id];
    if (!cs) return;
    const el = cs.el;
    el.dataset.status = state.status.key;

    const chip = el.querySelector('.status-chip');
    chip.className = `chip status-chip ${state.status.chip}`;
    chip.textContent = state.status.label;

    el.querySelector('.cd-label').textContent = state.countdownLabel;
    el.querySelector('.cd-value').textContent = state.countdownText;

    // Timeline: rebuild only when structure changes
    if (cs.structureKey !== state.structureKey) {
      cs.structureKey = state.structureKey;
      renderTimeline(el, state);
    } else {
      moveNowLine(el, getBeijingParts(new Date()).minutes);
    }

    // Quotes
    for (const q of market.quotes) {
      const qEl = el.querySelector(`[data-quote="${q.id}"]`);
      if (!qEl) continue;
      const data = quoteCache[q.id];
      applyQuote(qEl, data);
    }
  }

  function renderTimeline(el, state) {
    const bar = el.querySelector('.timeline');
    const labels = el.querySelector('.timeline-labels');
    bar.innerHTML = '';
    labels.innerHTML = '';

    const day = 24 * 60;
    for (const seg of state.timelineSegs) {
      const div = document.createElement('div');
      div.className = `timeline-seg ${seg.type}`;
      div.style.left = `${(seg.start / day) * 100}%`;
      div.style.width = `${((seg.end - seg.start) / day) * 100}%`;
      bar.appendChild(div);
    }

    const nowLine = document.createElement('div');
    nowLine.className = 'timeline-now';
    bar.appendChild(nowLine);

    const bounds = state.boundaryMinutes.filter((m) => m >= 0 && m <= day);
    bounds.forEach((m, i) => {
      const lab = document.createElement('span');
      lab.className = 'timeline-label';
      if (i === bounds.length - 1) lab.classList.add('edge-end');
      lab.textContent = m === day ? '24:00' : fmtHM(m);
      lab.style.left = `${(m / day) * 100}%`;
      labels.appendChild(lab);
    });

    moveNowLine(el, getBeijingParts(new Date()).minutes);
  }

  function moveNowLine(el, minutes) {
    const nowLine = el.querySelector('.timeline-now');
    if (!nowLine) return;
    nowLine.style.left = `${(minutes / (24 * 60)) * 100}%`;
  }

  function applyQuote(qEl, data) {
    const priceEl = qEl.querySelector('.quote-price');
    const chgEl = qEl.querySelector('.quote-chg');
    if (!data) {
      qEl.className = 'quote flat';
      priceEl.textContent = '--';
      chgEl.textContent = '--';
      return;
    }
    const price = pickPrice(data);
    const prev = data.prev;
    let chgPct = data.chgPct;
    if (chgPct == null && price != null && prev != null && prev !== 0) {
      chgPct = ((price - prev) / prev) * 100;
    }
    priceEl.textContent = price == null ? '--' : formatPrice(price);
    if (chgPct == null || Number.isNaN(chgPct)) {
      chgEl.textContent = '--';
      qEl.className = 'quote flat';
    } else {
      const sign = chgPct > 0 ? '+' : '';
      chgEl.textContent = `${sign}${chgPct.toFixed(2)}%`;
      qEl.className = 'quote ' + (chgPct > 0 ? 'up' : chgPct < 0 ? 'down' : 'flat');
    }
  }

  function pickPrice(data) {
    if (data.last != null && data.last !== 0) return data.last;
    if (data.prev != null && data.prev !== 0) return data.prev;
    return null;
  }

  function formatPrice(n) {
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  /* -------------------- Quotes -------------------- */

  function loadJsonp(url) {
    return new Promise((resolve, reject) => {
      const cb = `_em_cb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('jsonp timeout'));
      }, 12000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = (data) => {
        cleanup();
        resolve(data);
      };
      const script = document.createElement('script');
      script.src = url + (url.includes('?') ? '&' : '?') + 'cb=' + cb;
      script.onerror = () => {
        cleanup();
        reject(new Error('jsonp error'));
      };
      document.head.appendChild(script);
    });
  }

  async function refreshQuotes() {
    const em = [];
    const bin = [];
    for (const market of MARKETS) {
      for (const q of market.quotes) {
        if (q.source === 'eastmoney') em.push(q);
        else if (q.source === 'binance') bin.push(q);
      }
    }

    try {
      if (em.length) await fetchEastMoney(em);
    } catch (err) {
      console.warn('East Money quotes failed', err);
    }

    try {
      if (bin.length) await fetchBinance(bin);
    } catch (err) {
      console.warn('Binance quotes failed', err);
    }
  }

  async function fetchEastMoney(list) {
    const secids = list.map((q) => q.secid).join(',');
    const query =
      '?fields=f2,f3,f12,f14,f18&secids=' + encodeURIComponent(secids);
    const hosts = [
      'https://push2.eastmoney.com/api/qt/ulist.np/get',
      'https://push2delay.eastmoney.com/api/qt/ulist.np/get',
    ];
    let data = null;
    let lastErr = null;
    for (const host of hosts) {
      try {
        // Prefer CORS fetch (hosts advertise *); fall back to JSONP.
        const res = await fetch(host + query, { mode: 'cors' });
        if (!res.ok) throw new Error('http ' + res.status);
        data = await res.json();
        break;
      } catch (err) {
        lastErr = err;
        try {
          data = await loadJsonp(host + query);
          break;
        } catch (err2) {
          lastErr = err2;
        }
      }
    }
    if (!data) throw lastErr || new Error('eastmoney empty');
    const rows = (data && data.data && data.data.diff) || [];
    const byCode = Object.create(null);
    for (const row of rows) {
      byCode[String(row.f12)] = row;
    }
    for (const q of list) {
      const code = q.secid.split('.').pop();
      const row = byCode[code];
      if (!row) continue;
      // Spec: divide by 100 (API returns 0.01 units without fltt)
      const lastRaw = row.f2;
      const prevRaw = row.f18;
      const chgRaw = row.f3;
      const last = lastRaw == null || lastRaw === '-' ? null : Number(lastRaw) / 100;
      const prev = prevRaw == null || prevRaw === '-' ? null : Number(prevRaw) / 100;
      const chgPct = chgRaw == null || chgRaw === '-' ? null : Number(chgRaw) / 100;
      quoteCache[q.id] = { last, prev, chgPct };
    }
  }

  async function fetchBinance(list) {
    const url = 'https://data-api.binance.vision/api/v3/ticker/24hr';
    const res = await fetch(url);
    if (!res.ok) throw new Error('binance http ' + res.status);
    const all = await res.json();
    const map = Object.create(null);
    for (const row of all) map[row.symbol] = row;
    for (const q of list) {
      const row = map[q.symbol];
      if (!row) continue;
      const last = Number(row.lastPrice);
      const prev = Number(row.prevClosePrice);
      const chgPct = Number(row.priceChangePercent);
      quoteCache[q.id] = {
        last: Number.isFinite(last) ? last : null,
        prev: Number.isFinite(prev) ? prev : null,
        chgPct: Number.isFinite(chgPct) ? chgPct : null,
      };
    }
  }

  /* -------------------- Tick -------------------- */

  function tick() {
    const now = new Date();
    const parts = getBeijingParts(now);

    document.getElementById('clock-time').textContent =
      `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
    document.getElementById('clock-date').textContent = clockDateFmt.format(now);

    const banner = document.getElementById('year-banner');
    if (parts.year !== DATA_YEAR) {
      banner.hidden = false;
      document.getElementById('banner-year').textContent = String(DATA_YEAR);
    } else {
      banner.hidden = true;
    }

    const evaluated = MARKETS.map((market) => {
      const state = evaluateMarket(market, now, parts);
      return { market, state };
    });

    evaluated.sort((a, b) => {
      if (a.market.pinFirst && !b.market.pinFirst) return -1;
      if (!a.market.pinFirst && b.market.pinFirst) return 1;
      if (a.market.pinFirst && b.market.pinFirst) return 0;
      // already open first (sortKey negative large), then by time-to-next-open
      return a.state.sortKey - b.state.sortKey;
    });

    ensureCards(evaluated.map((e) => e.market));
    for (const { market, state } of evaluated) {
      updateCard(market, state);
    }
  }

  function initSources() {
    const parts = Object.keys(HOLIDAY_SOURCES).map((k) => {
      const s = HOLIDAY_SOURCES[k];
      return `${s.name}（核验 ${s.verified}）`;
    });
    document.getElementById('sources').textContent =
      `行情：东方财富 · Binance Vision　日历：${parts.join(' · ')}　本页日历年份 ${DATA_YEAR}`;
  }

  function boot() {
    marketsRoot = document.getElementById('markets');
    initSources();
    tick();
    setInterval(tick, 1000);
    refreshQuotes();
    setInterval(refreshQuotes, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
