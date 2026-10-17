(function () {
  const hex = (L, C, H) => {
    const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    return '#' + rgb.map((v) => { v = Math.max(0, Math.min(1, v)); v = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(v * 255).toString(16).padStart(2, '0'); }).join('');
  };
  const H = 330;
  const T = {
    p78: hex(0.78, 0.11, H + 6), p70: hex(0.7, 0.14, H + 2), p62: hex(0.63, 0.165, H), p58: hex(0.58, 0.17, H), p54: hex(0.54, 0.17, H - 2),
    p46: hex(0.46, 0.15, H - 4), p36: hex(0.36, 0.115, H - 4), p30: hex(0.3, 0.09, H - 4), p26: hex(0.25, 0.07, H - 6),
    rim: hex(0.82, 0.12, 352), w: '#ffffff', w2: hex(0.955, 0.01, 320), w3: hex(0.89, 0.022, 315), w4: hex(0.74, 0.04, 315),
    sclera: hex(0.985, 0.006, H), blush: hex(0.72, 0.15, 8),
  };
  const EXPR = {
    idle: { brow: 'idle' },
    working: { brow: 'focus', look: [-0.7, 0.7], orbit: true, rot: -4 },
    success: { brow: 'up', happy: true, halo: true, lift: 1.25 },
    worried: { brow: 'worried', look: [0.35, -0.6], lid: 0.14, toqueRot: 9, rot: 3 },
  };
  function smooth(P, f) {
    const N = P.length;
    let d = 'M' + f(P[0][0]) + ' ' + f(P[0][1]);
    for (let i = 0; i < N; i++) {
      const p0 = P[(i + N - 1) % N], p1 = P[i], p2 = P[(i + 1) % N], p3 = P[(i + 2) % N];
      d += 'C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + f(p1[1] + (p2[1] - p0[1]) / 6) + ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + f(p2[1] - (p3[1] - p1[1]) / 6) + ' ' + f(p2[0]) + ' ' + f(p2[1]);
    }
    return d + 'Z';
  }
  function circ(cx, cy, r, f) { return 'M' + f(cx - r) + ' ' + f(cy) + 'A' + f(r) + ' ' + f(r) + ' 0 1 0 ' + f(cx + r) + ' ' + f(cy) + 'A' + f(r) + ' ' + f(r) + ' 0 1 0 ' + f(cx - r) + ' ' + f(cy) + 'Z'; }
  function squircle(x0, y0, w, h, n, bw, tf, f) {
    const N = 36, raw = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      let x = Math.sign(c) * Math.abs(c) ** (2 / n), y = Math.sign(s) * Math.abs(s) ** (2 / n);
      if (y > 0) x *= 1 + bw * y;
      if (y < 0) y *= 1 - tf;
      raw.push([x, y]);
    }
    const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
    const a = Math.min(...xs), b = Math.max(...xs), c = Math.min(...ys), d = Math.max(...ys);
    return smooth(raw.map(([x, y]) => [x0 + ((x - a) / (b - a)) * w, y0 + ((y - c) / (d - c)) * h]), f);
  }

  function inner(style, o) {
    const sz = o.size, k = sz / 32, fc = !!o.fc, id = (o.idp || 'cm') + '-', cv = o.canvas || 'Canvas';
    const lvl = sz < 20 ? 0 : sz < 64 ? 1 : sz < 128 ? 2 : 3, big = sz >= 32;
    const E = EXPR[o.expr || 'idle'];
    const f = (n) => String(Math.round(n * 1000) / 1000), px = (n) => n / k, sn = (v) => Math.round(v * k) / k;
    const defs = [], out = [];
    const sw = lvl === 0 ? px(1) : lvl === 1 ? px(1.5) : lvl === 2 ? px(2) : Math.max(0.5, px(2));
    const lw = lvl <= 1 ? px(1) : lvl === 2 ? px(1.5) : 0.8;
    const hair = Math.max(px(1), 0.22);
    // body: one whole-pixel diameter, centred, bottom on a pixel
    const Dp = 2 * Math.round(12 * k), D = Dp / k, x0 = (sz / 2 - Dp / 2) / k, y1 = Math.floor(30.75 * k) / k, y0 = y1 - D;
    const body = circ(16, y1 - D / 2, D / 2, f);
    // toque
    const bX0 = sn(8), bX1 = 32 - bX0, bY0 = sn(9.5), bY1 = sn(12.75), tX0 = sn(7), tX1 = 32 - tX0, top = Math.max(sn(1.25), 0);
    let puffs;
    if (lvl === 0) { const r = 4; puffs = [[11.5, top + r, r], [20.5, top + r, r]]; }
    else { const rs = 3.75, rc = 4.5, cyS = sn(2.75) + rs; puffs = [[tX0 + rs, cyS, rs], [16, top + rc, rc], [tX1 - rs, cyS, rs]]; }
    const pTop = Math.max(...puffs.map((p) => p[1]));
    const base = [bX0 + 0.5, Math.min(...puffs.map((p) => p[1])), bX1 - bX0 - 1, bY0 + 0.5 - Math.min(...puffs.map((p) => p[1]))];
    const shapes = (a) => puffs.map((p) => '<circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + f(p[2]) + '" ' + a + '/>').join('') + '<rect x="' + f(base[0]) + '" y="' + f(base[1]) + '" width="' + f(base[2]) + '" height="' + f(base[3]) + '" ' + a + '/>';
    // eyes
    const ew = Math.max(2, Math.round(4.25 * k)) / k, eh = Math.max(3, Math.round(5 * k)) / k;
    const exL = Math.round((11.75 - ew / 2) * k) / k, ey0 = Math.round((20.75 - eh / 2) * k) / k;
    const eyes = [exL, 32 - exL - ew];
    const ink = fc ? 'currentColor' : T.p26;
    const lift = E.lift || 0;

    defs.push('<clipPath id="' + id + 'body"><path d="' + body + '"/></clipPath>');
    defs.push('<clipPath id="' + id + 'toq">' + shapes('') + '</clipPath>');

    if (E.halo && !fc) {
      out.push('<circle cx="16" cy="17" r="14.25" stroke="' + T.p78 + '" stroke-opacity="0.55" stroke-width="0.75"/>');
      out.push('<circle cx="16" cy="17" r="12.75" stroke="' + T.p78 + '" stroke-opacity="0.25" stroke-width="0.5"/>');
    }
    if (big && !fc) {
      const rx = lift ? 7 : 8.75;
      if (style === 'm1') {
        defs.push('<radialGradient id="' + id + 'sh"><stop offset="0" stop-color="' + T.p26 + '" stop-opacity="0.32"/><stop offset="1" stop-color="' + T.p26 + '" stop-opacity="0"/></radialGradient>');
        out.push('<ellipse cx="16" cy="' + f(y1) + '" rx="' + (rx + 1.5) + '" ry="1.6" fill="url(#' + id + 'sh)"/>');
      } else out.push('<ellipse cx="16" cy="' + f(y1) + '" rx="' + rx + '" ry="1" fill="' + T.p26 + '" fill-opacity="0.16"/>');
    }
    const oc = 23, orx = 14.75, ory = 4, dots = [[25, T.p62], [148, T.p78], [204, T.p54]];
    const dot = (a, c) => { const t = (a * Math.PI) / 180; return '<circle cx="' + f(16 + orx * Math.cos(t)) + '" cy="' + f(oc + ory * Math.sin(t)) + '" r="1.2" fill="' + c + '"/>'; };
    if (E.orbit && !fc) {
      out.push('<ellipse cx="16" cy="' + oc + '" rx="' + orx + '" ry="' + ory + '" stroke="' + T.p70 + '" stroke-opacity="0.45" stroke-width="0.3" stroke-dasharray="0.9 0.7"/>');
      dots.filter(([a]) => Math.sin((a * Math.PI) / 180) < 0).forEach(([a, c]) => out.push(dot(a, c)));
    }

    out.push('<g transform="translate(0 ' + f(-lift) + ') rotate(' + (E.rot || 0) + ' 16 ' + f(y1) + ')">');
    // body
    if (fc) out.push('<path d="' + body + '" stroke="currentColor" stroke-width="' + f(sw) + '" stroke-linejoin="round"/>');
    else if (style === 'm1') {
      defs.push('<linearGradient id="' + id + 'bg" gradientUnits="userSpaceOnUse" x1="0" y1="' + f(y0) + '" x2="0" y2="' + f(y1) + '"><stop offset="0" stop-color="' + T.p78 + '"/><stop offset="0.45" stop-color="' + T.p58 + '"/><stop offset="1" stop-color="' + T.p46 + '"/></linearGradient>');
      out.push('<path d="' + body + '" fill="url(#' + id + 'bg)"/>');
      if (lvl >= 1) {
        defs.push('<radialGradient id="' + id + 'tl"><stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>');
        defs.push('<radialGradient id="' + id + 'ao"><stop offset="0" stop-color="' + T.p26 + '" stop-opacity="0.42"/><stop offset="1" stop-color="' + T.p26 + '" stop-opacity="0"/></radialGradient>');
        out.push('<g clip-path="url(#' + id + 'body)"><ellipse cx="11" cy="' + f(y0 + 9) + '" rx="10" ry="8" fill="url(#' + id + 'tl)"/><ellipse cx="16" cy="' + f(bY1 + 0.25) + '" rx="10" ry="2.75" fill="url(#' + id + 'ao)"/>');
        if (big) {
          defs.push('<linearGradient id="' + id + 'rim" gradientUnits="userSpaceOnUse" x1="8" y1="' + f(y0 + 6) + '" x2="26" y2="' + f(y1) + '"><stop offset="0" stop-color="' + T.rim + '" stop-opacity="0"/><stop offset="0.55" stop-color="' + T.rim + '" stop-opacity="0"/><stop offset="1" stop-color="' + T.rim + '" stop-opacity="0.9"/></linearGradient>');
          out.push('<path d="' + body + '" stroke="url(#' + id + 'rim)" stroke-width="' + f(Math.max(px(1.5), 1.3)) + '"/>');
        }
        out.push('</g>');
      }
    } else if (style === 'm2') {
      if (lvl === 0) out.push('<path d="' + body + '" fill="' + T.p58 + '"/>');
      else {
        out.push('<path d="' + body + '" fill="' + T.p46 + '"/>');
        out.push('<g clip-path="url(#' + id + 'body)"><path d="' + circ(16 - 1.25, y1 - D / 2 - 1.5, D / 2 * 0.99, f) + '" fill="' + T.p58 + '"/><ellipse cx="16" cy="' + f(bY1) + '" rx="8.5" ry="1.35" fill="' + T.p46 + '"/></g>');
        if (big) out.push('<rect x="-2.5" y="-0.8" width="5" height="1.6" rx="0.8" transform="translate(' + f(x0 + 3.6) + ' 18) rotate(-64)" fill="' + T.p70 + '"/>');
      }
    } else {
      out.push('<path d="' + body + '" stroke="' + T.p26 + '" stroke-width="' + f(2 * lw) + '" stroke-linejoin="round"/>');
      out.push('<path d="' + body + '" fill="' + T.p58 + '"/>');
      if (big) out.push('<path d="M' + f(x0 + 2.4) + ' 22.5Q' + f(x0 + 2.4) + ' 18 ' + f(x0 + 4.4) + ' 15.25" stroke="#ffffff" stroke-opacity="0.6" stroke-width="' + f(lw * 0.85) + '" stroke-linecap="round"/>');
    }
    // blush
    if (big && !fc && !E.halo) {
      const by = ey0 + eh + 0.9;
      [16 - 8, 16 + 8].forEach((x) => {
        if (style === 'm1') {
          if (!defs.some((d) => d.includes(id + 'bl"'))) defs.push('<radialGradient id="' + id + 'bl"><stop offset="0" stop-color="' + T.blush + '" stop-opacity="0.75"/><stop offset="1" stop-color="' + T.blush + '" stop-opacity="0"/></radialGradient>');
          out.push('<ellipse cx="' + x + '" cy="' + f(by) + '" rx="2.6" ry="1.5" fill="url(#' + id + 'bl)"/>');
        } else out.push('<ellipse cx="' + x + '" cy="' + f(by) + '" rx="1.8" ry="1" fill="' + T.blush + '" fill-opacity="' + (style === 'm2' ? 0.5 : 0.55) + '"/>');
      });
    } else if (E.halo && big && !fc) {
      [8, 24].forEach((x) => out.push('<ellipse cx="' + x + '" cy="' + f(ey0 + eh + 0.6) + '" rx="2" ry="1.1" fill="' + T.blush + '" fill-opacity="0.6"/>'));
    }
    // eyes
    const look = E.look || [0, 0];
    eyes.forEach((ex, i) => {
      const ecx = ex + ew / 2, ecy = ey0 + eh / 2;
      if (E.happy && lvl >= 1) {
        out.push('<path d="M' + f(ex) + ' ' + f(ecy + 0.6) + 'Q' + f(ecx) + ' ' + f(ecy - eh * 0.6) + ' ' + f(ex + ew) + ' ' + f(ecy + 0.6) + '" stroke="' + ink + '" stroke-width="' + f(Math.max(px(1), 1.1)) + '" stroke-linecap="round"/>');
        return;
      }
      if (lvl === 0) {
        out.push('<rect x="' + f(ex) + '" y="' + f(ey0) + '" width="' + f(ew) + '" height="' + f(eh) + '" rx="' + f(ew / 2) + '" fill="' + ink + '"/>');
        if (!fc) out.push('<rect x="' + f(ex) + '" y="' + f(ey0 + px(0.5)) + '" width="' + f(px(1)) + '" height="' + f(px(1)) + '" rx="' + f(px(0.5)) + '" fill="#ffffff"/>');
        return;
      }
      const shape = squircle(ex, ey0, ew, eh, 2.4, 0, 0.12, f);
      defs.push('<clipPath id="' + id + 'e' + i + '"><path d="' + shape + '"/></clipPath>');
      out.push(fc ? '<path d="' + shape + '" fill="' + cv + '" stroke="currentColor" stroke-width="' + f(sw * 0.75) + '"/>' : '<path d="' + shape + '" fill="' + T.sclera + '"/>');
      const ir = (lvl === 1 ? 0.4 : 0.37) * ew, icx = ecx + look[0] * ew * 0.18, icy = ecy + 0.08 * eh + look[1] * eh * 0.15;
      out.push('<g clip-path="url(#' + id + 'e' + i + ')">');
      let irisFill = ink;
      if (!fc && lvl >= 2) {
        if (style === 'm1') { if (i === 0) defs.push('<radialGradient id="' + id + 'ir" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="' + T.p62 + '"/><stop offset="1" stop-color="' + T.p36 + '"/></radialGradient>'); irisFill = 'url(#' + id + 'ir)'; }
        else irisFill = T.p46;
      }
      out.push('<circle cx="' + f(icx) + '" cy="' + f(icy) + '" r="' + f(ir) + '" fill="' + irisFill + '"/>');
      if (!fc && lvl >= 2) out.push('<circle cx="' + f(icx) + '" cy="' + f(icy + ir * 0.06) + '" r="' + f(ir * 0.52) + '" fill="' + T.p26 + '"/>');
      if (!fc) {
        const hr = lvl === 1 ? Math.max(px(0.6), 0.15 * ew) : ir * 0.36;
        out.push('<circle cx="' + f(icx - ir * 0.36) + '" cy="' + f(icy - ir * 0.4) + '" r="' + f(hr) + '" fill="#ffffff"/>');
        if (lvl === 3) out.push('<circle cx="' + f(icx + ir * 0.42) + '" cy="' + f(icy + ir * 0.38) + '" r="' + f(ir * 0.14) + '" fill="#ffffff"/>');
        if (lvl === 3 && style === 'm1') out.push('<ellipse cx="' + f(ecx) + '" cy="' + f(ey0 - 0.2) + '" rx="' + f(ew * 0.6) + '" ry="' + f(eh * 0.22) + '" fill="' + T.p46 + '" fill-opacity="0.14"/>');
      }
      if (E.lid) {
        const ly = ey0 + eh * E.lid;
        out.push('<path d="M' + f(ex - 1) + ' ' + f(ey0 - 1) + 'H' + f(ex + ew + 1) + 'V' + f(ly) + 'Q' + f(ecx) + ' ' + f(ly + 0.6) + ' ' + f(ex - 1) + ' ' + f(ly) + 'Z" fill="' + (fc ? cv : style === 'm1' ? T.p62 : T.p58) + '"/>');
        out.push('<path d="M' + f(ex - 0.5) + ' ' + f(ly + 0.05) + 'Q' + f(ecx) + ' ' + f(ly + 0.65) + ' ' + f(ex + ew + 0.5) + ' ' + f(ly + 0.05) + '" stroke="' + ink + '" stroke-width="' + f(Math.max(px(1), 0.45)) + '"/>');
      }
      out.push('</g>');
    });
    // brows
    if (lvl >= 1) {
      const bw = lvl === 3 ? 1.15 : Math.max(1, Math.round(1.2 * k)) / k;
      eyes.forEach((ex, i) => {
        const s = i ? 1 : -1, ecx = ex + ew / 2;
        let by = ey0 - 2.1 - (E.brow === 'up' ? 0.6 : 0) - (lvl >= 2 && s === 1 && E.brow === 'idle' ? 0.25 : 0);
        const B = {
          idle: [[1.9, 0.35], [0.2, -1.0], [-1.7, 0.45]],
          focus: [[1.9, 0.2], [0.1, -0.8], [-1.7, 0.3]],
          up: [[1.9, -0.1], [0.1, -1.5], [-1.7, 0.1]],
          worried: [[1.8, 0.7], [0, -0.5], [-1.6, -0.9]],
        }[E.brow];
        const P = B.map(([dx, dy]) => [ecx + s * dx, by + dy]);
        out.push('<path d="M' + f(P[0][0]) + ' ' + f(P[0][1]) + 'Q' + f(P[1][0]) + ' ' + f(P[1][1]) + ' ' + f(P[2][0]) + ' ' + f(P[2][1]) + '" stroke="' + ink + '" stroke-opacity="' + (fc ? 1 : 0.9) + '" stroke-width="' + f(bw) + '" stroke-linecap="round"/>');
      });
    }
    // toque
    out.push('<g transform="rotate(' + (E.toqueRot || 0) + ' 16 ' + f(bY1) + ')">');
    if (fc) {
      out.push(shapes('fill="none" stroke="currentColor" stroke-width="' + f(2 * sw) + '"'));
      out.push(shapes('fill="' + cv + '"'));
    } else {
      out.push(style === 'm3' ? shapes('fill="none" stroke="' + T.p26 + '" stroke-width="' + f(2 * lw) + '" stroke-linejoin="round"') : shapes('fill="none" stroke="' + T.p46 + '" stroke-opacity="0.32" stroke-width="' + f(2 * hair) + '"'));
      if (style === 'm1') {
        defs.push('<linearGradient id="' + id + 'tq" gradientUnits="userSpaceOnUse" x1="' + f(tX0) + '" y1="' + f(top) + '" x2="' + f(tX1) + '" y2="' + f(bY0) + '"><stop offset="0" stop-color="' + T.w + '"/><stop offset="0.45" stop-color="' + T.w + '"/><stop offset="1" stop-color="' + T.w3 + '"/></linearGradient>');
        out.push(shapes('fill="url(#' + id + 'tq)"'));
        if (lvl >= 1) {
          defs.push('<linearGradient id="' + id + 'tu" gradientUnits="userSpaceOnUse" x1="0" y1="' + f(pTop) + '" x2="0" y2="' + f(bY0 + 0.5) + '"><stop offset="0" stop-color="' + T.w4 + '" stop-opacity="0"/><stop offset="1" stop-color="' + T.w4 + '" stop-opacity="0.4"/></linearGradient>');
          out.push('<rect x="' + f(tX0) + '" y="' + f(pTop) + '" width="' + f(tX1 - tX0) + '" height="' + f(bY0 + 0.5 - pTop) + '" fill="url(#' + id + 'tu)" clip-path="url(#' + id + 'toq)"/>');
        }
      } else if (style === 'm2' && lvl >= 1) {
        out.push(shapes('fill="' + T.w3 + '"'));
        out.push('<g clip-path="url(#' + id + 'toq)"><g transform="translate(-0.9 -0.8)">' + shapes('fill="' + T.w + '"') + '</g></g>');
      } else out.push(shapes('fill="' + T.w + '"'));
      const pc = style === 'm3' ? T.p26 : T.w4, po = style === 'm3' ? 1 : 0.55, pw = style === 'm3' ? lw * 0.6 : lvl === 2 ? px(1) : 0.3;
      if (lvl >= 2) {
        [16 - 3.6, 16, 16 + 3.6].forEach((x) => out.push('<path d="M' + f(x) + ' ' + f(bY0 + 0.2) + 'Q' + f(x + (x - 16) * 0.12) + ' ' + f(bY0 - 2) + ' ' + f(x + (x - 16) * 0.06) + ' ' + f(bY0 - 3.8) + '" stroke="' + pc + '" stroke-opacity="' + po + '" stroke-width="' + f(pw) + '" stroke-linecap="round"/>'));
      }
      if (lvl === 3 && style !== 'm2' && puffs.length === 3) {
        const [L, , R] = puffs;
        [[L, 1], [R, -1]].forEach(([p, s]) => out.push('<path d="M' + f(p[0] + s * p[2] * 0.62) + ' ' + f(p[1] - p[2] * 0.78) + 'Q' + f(p[0] + s * p[2] * 1.02) + ' ' + f(p[1] + p[2] * 0.1) + ' ' + f(p[0] + s * p[2] * 0.7) + ' ' + f(bY0 - 0.6) + '" stroke="' + pc + '" stroke-opacity="' + (style === 'm3' ? 1 : 0.45) + '" stroke-width="' + f(pw) + '" stroke-linecap="round"/>'));
      }
    }
    const brx = lvl === 0 ? px(0.5) : Math.min(1.25, (bY1 - bY0) / 2.5), bmid = (bY0 + bY1) / 2;
    const band = '<rect x="' + f(bX0) + '" y="' + f(bY0) + '" width="' + f(bX1 - bX0) + '" height="' + f(bY1 - bY0) + '" rx="' + f(brx) + '"';
    if (fc) out.push(band + ' fill="' + cv + '" stroke="currentColor" stroke-width="' + f(sw) + '"/>');
    else if (style === 'm1') {
      defs.push('<linearGradient id="' + id + 'bd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + T.w + '"/><stop offset="1" stop-color="' + T.w3 + '"/></linearGradient>');
      out.push(band + ' fill="url(#' + id + 'bd)" stroke="' + T.p46 + '" stroke-opacity="0.32" stroke-width="' + f(hair) + '"/>');
    } else if (style === 'm2') {
      defs.push('<clipPath id="' + id + 'bc">' + band + '/></clipPath>');
      out.push(band + ' fill="' + T.w2 + '" stroke="' + T.p46 + '" stroke-opacity="0.32" stroke-width="' + f(hair) + '"/>');
      if (lvl >= 1) out.push('<rect x="' + f(bX0) + '" y="' + f(bY1 - (bY1 - bY0) * 0.38) + '" width="' + f(bX1 - bX0) + '" height="' + f(bY1 - bY0) + '" fill="' + T.w3 + '" clip-path="url(#' + id + 'bc)"/>');
    } else out.push(band + ' fill="' + T.w2 + '" stroke="' + T.p26 + '" stroke-width="' + f(lw) + '"/>');
    if (lvl >= 2) {
      const sc = fc ? 'currentColor' : style === 'm3' ? T.p26 : T.w4, sw2 = lvl === 2 ? px(1) : 0.28;
      if (style === 'm2' && !fc) {
        if (lvl === 3) for (let x = bX0 + 1.4; x < bX1 - 1; x += 1.35) if (Math.abs(x - 16) > 2) out.push('<circle cx="' + f(x) + '" cy="' + f(bY0 + 0.75) + '" r="0.22" fill="' + T.w4 + '"/>');
      } else {
        const da = lvl === 2 ? f(px(2)) + ' ' + f(px(1.5)) : '0.7 0.5';
        out.push('<path d="M' + f(bX0 + 1) + ' ' + f(bmid) + 'H' + f(14.1) + 'M' + f(17.9) + ' ' + f(bmid) + 'H' + f(bX1 - 1) + '" stroke="' + sc + '" stroke-width="' + f(sw2) + '" stroke-dasharray="' + da + '" stroke-linecap="round"/>');
      }
      const ec = fc ? 'currentColor' : style === 'm3' ? T.p26 : T.p54;
      if (lvl === 2) out.push('<circle cx="16" cy="' + f(bmid) + '" r="0.9" fill="' + ec + '"/>');
      else {
        const rx = 1.25, ry = 1.35, kk = 0.22;
        out.push('<path d="M16 ' + f(bmid - ry) + 'Q' + f(16 + rx * kk) + ' ' + f(bmid - ry * kk) + ' ' + f(16 + rx) + ' ' + f(bmid) + 'Q' + f(16 + rx * kk) + ' ' + f(bmid + ry * kk) + ' 16 ' + f(bmid + ry) + 'Q' + f(16 - rx * kk) + ' ' + f(bmid + ry * kk) + ' ' + f(16 - rx) + ' ' + f(bmid) + 'Q' + f(16 - rx * kk) + ' ' + f(bmid - ry * kk) + ' 16 ' + f(bmid - ry) + 'Z" fill="' + ec + '"/>');
      }
    }
    out.push('</g></g>');
    if (E.orbit && !fc) {
      out.push('<path d="M' + f(16 - orx) + ' ' + oc + 'A' + orx + ' ' + ory + ' 0 0 0 ' + f(16 + orx) + ' ' + oc + '" stroke="' + T.p70 + '" stroke-opacity="0.6" stroke-width="0.3" stroke-dasharray="0.9 0.7"/>');
      dots.filter(([a]) => Math.sin((a * Math.PI) / 180) >= 0).forEach(([a, c]) => out.push(dot(a, c)));
    }
    return '<defs>' + defs.join('') + '</defs>' + out.join('');
  }
  const head = (sz, cls) => '<svg xmlns="http://www.w3.org/2000/svg"' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 32 32" width="' + sz + '" height="' + sz + '" fill="none" aria-hidden="true" focusable="false">';
  function draw(style, o) { o = Object.assign({ size: 32 }, o || {}); return head(o.size, o.cls) + inner(style, o) + '</svg>'; }
  function tile512(style, o) {
    o = o || {};
    const sz = o.size || 512, id = (o.idp || 'ct') + '-t';
    return '<svg xmlns="http://www.w3.org/2000/svg"' + (o.cls ? ' class="' + o.cls + '"' : '') + ' viewBox="0 0 512 512" width="' + sz + '" height="' + sz + '" fill="none" aria-hidden="true" focusable="false"><rect width="512" height="512" rx="115.2" fill="' + hex(0.33, 0.1, H - 4) + '"/><g transform="translate(64 64) scale(12)">' + inner(style, { size: Math.round(sz * 0.75), idp: id }) + '</g></svg>';
  }
  function tile(style, o) {
    o = o || {};
    const sz = o.size || 180, pad = Math.round(sz / 8), c = sz - 2 * pad, id = (o.idp || 'ct') + '-t';
    const fill = style === 'm1' ? 'url(#' + id + 'g)' : hex(0.33, 0.1, H - 4);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + sz + ' ' + sz + '" width="' + sz + '" height="' + sz + '" fill="none" aria-hidden="true" focusable="false"><defs><linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + hex(0.38, 0.11, H - 2) + '"/><stop offset="1" stop-color="' + hex(0.27, 0.08, H - 6) + '"/></linearGradient></defs><rect width="' + sz + '" height="' + sz + '" rx="' + Math.round(sz * 0.225) + '" fill="' + fill + '"/><g transform="translate(' + pad + ' ' + pad + ') scale(' + Math.round((c / 32) * 10000) / 10000 + ')">' + inner(style, { size: c, idp: o.idp || 'ct' }) + '</g></svg>';
  }
  const api = { draw, tile, tile512, colors: T, squircle, circ };
  if (typeof window !== 'undefined') window.RelayChefModern = api;
  if (typeof module !== 'undefined') module.exports = api;
  return api;
})();
