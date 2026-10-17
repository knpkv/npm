(function () {
  // 10 Creature states: the M2 Flat-plus chef (09) with pose, lids, brows, mouth and squash. Needs relay-chef-modern.js first.
  const f = (n) => String(Math.round(n * 1000) / 1000);
  const SEEDS = { circle: { w: 24, h: 24, ex: 4.25, hx: 3.6, hr: -64 }, squircle: { w: 23, h: 23, ex: 4.4, hx: 2.4, hr: -82 }, pear: { w: 28, h: 24, ex: 4.25, hx: 6.6, hr: -68 }, star: { w: 27.4, h: 26, ex: 4.25, hx: 3.5, hr: -40, ey: 0.56 }, bean: { w: 27, h: 22, ex: 4.4, hx: 3, hr: -70, ey: 0.55 } };
  function cat(P) {
    const N = P.length;
    let d = 'M' + f(P[0][0]) + ' ' + f(P[0][1]);
    for (let i = 0; i < N; i++) {
      const p0 = P[(i + N - 1) % N], p1 = P[i], p2 = P[(i + 1) % N], p3 = P[(i + 2) % N];
      d += 'C' + f(p1[0] + (p2[0] - p0[0]) / 6) + ' ' + f(p1[1] + (p2[1] - p0[1]) / 6) + ' ' + f(p2[0] - (p3[0] - p1[0]) / 6) + ' ' + f(p2[1] - (p3[1] - p1[1]) / 6) + ' ' + f(p2[0]) + ' ' + f(p2[1]);
    }
    return d + 'Z';
  }
  function rpoly(P, rs) {
    const N = P.length, pt = (a, b, d) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return [a[0] + (dx / L) * d, a[1] + (dy / L) * d]; };
    let d = '';
    for (let i = 0; i < N; i++) {
      const p = P[i], a = pt(p, P[(i + N - 1) % N], rs[i]), b = pt(p, P[(i + 1) % N], rs[i]);
      d += (i ? 'L' : 'M') + f(a[0]) + ' ' + f(a[1]) + 'Q' + f(p[0]) + ' ' + f(p[1]) + ' ' + f(b[0]) + ' ' + f(b[1]);
    }
    return d + 'Z';
  }
  function shapeOf(seed, x0, y0, w, h, sq) {
    const cx = x0 + w / 2;
    if (seed === 'circle') return window.RelayChefModern.circ(cx, y0 + h / 2, w / 2, f);
    if (seed === 'squircle') return sq(x0, y0, w, h, 4.2, 0, 0);
    if (seed === 'star') {
      const R = w / 2 / Math.sin((72 * Math.PI) / 180), r = R * 0.62, cy = y0 + R, P = [];
      for (let i = 0; i < 10; i++) { const a = (-90 + i * 36) * Math.PI / 180, rr = i % 2 ? r : R; P.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
      return rpoly(P, P.map((_, i) => (i % 2 ? 1.6 : 3)));
    }
    if (seed === 'bean') {
      const N = 32, P = [];
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2, c0 = Math.cos(t), s0 = Math.sin(t);
        let x = Math.sign(c0) * Math.abs(c0) ** (2 / 2.6), y = Math.sign(s0) * Math.abs(s0) ** (2 / 2.6);
        y += 0.32 * Math.exp(-((t - 1.5 * Math.PI) ** 2) / 0.22);
        P.push([cx + x * w / 2, y0 + h / 2 + y * h / 2]);
      }
      return cat(P);
    }
    const t = w * 0.28;
    return rpoly([[cx - t, y0], [cx + t, y0], [x0 + w, y0 + h], [x0, y0 + h]], [6, 6, 6.5, 6.5]);
  }
  const BROWS = {
    idle: { p: [[1.9, 0.35], [0.2, -1.0], [-1.7, 0.45]], dy: 0 },
    up: { p: [[1.9, 0.35], [0.2, -1.1], [-1.7, 0.45]], dy: -0.8 },
    high: { p: [[1.9, 0.1], [0.1, -1.7], [-1.7, 0.2]], dy: -1.5 },
    focus: { p: [[1.6, 0.05], [-0.3, -0.35], [-2.1, 0.45]], dy: 0.55 },
    worried: { p: [[1.8, 0.85], [0, -0.45], [-1.6, -1.15]], dy: -0.5 },
    sleepy: { p: [[1.9, 0.15], [0.2, -0.45], [-1.7, 0.35]], dy: 0.45 },
    think: { p: [[1.7, 0.35], [-0.1, -0.8], [-2.0, 0.6]], dy: 0.15 },
  };
  const MOUTH = {
    smile: (c, w) => '<path d="M-1.6 -0.4Q0 1.3 1.6 -0.4" stroke="' + c.p26 + '" stroke-width="' + w + '" stroke-linecap="round"/>',
    closed: (c, w) => '<path d="M-1 -0.1Q0 0.5 1 -0.1" stroke="' + c.p26 + '" stroke-width="' + w + '" stroke-linecap="round"/>',
    line: (c, w) => '<path d="M-1.05 0.1H1.05" stroke="' + c.p26 + '" stroke-width="' + w + '" stroke-linecap="round"/>',
    hmm: (c, w) => '<path d="M-0.5 0.35Q0.5 -0.05 1.5 0.05" stroke="' + c.p26 + '" stroke-width="' + w + '" stroke-linecap="round"/>',
    wavy: (c, w) => '<path d="M-1.8 0.15Q-1.2 -0.55 -0.6 0.05Q0 0.65 0.6 0.05Q1.2 -0.55 1.8 0.15" stroke="' + c.p26 + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"/>',
    small: (c) => '<ellipse cx="0" cy="0.2" rx="0.9" ry="0.65" fill="' + c.p26 + '"/>',
    o: (c) => '<ellipse cx="0" cy="0.45" rx="0.85" ry="1.15" fill="' + c.p26 + '"/>',
    wide: (c, w, lvl, id) => '<clipPath id="' + id + 'mw"><path d="M-1.7 -0.5Q0 -0.8 1.7 -0.5Q1.6 2.1 0 2.1Q-1.6 2.1 -1.7 -0.5Z"/></clipPath><path d="M-1.7 -0.5Q0 -0.8 1.7 -0.5Q1.6 2.1 0 2.1Q-1.6 2.1 -1.7 -0.5Z" fill="' + c.p26 + '"/>' + (lvl >= 2 ? '<ellipse cx="0" cy="1.9" rx="1.05" ry="0.6" fill="' + c.blush + '" clip-path="url(#' + id + 'mw)"/>' : ''),
    openSmile: (c, w, lvl, id) => '<clipPath id="' + id + 'mo"><path d="M-2 -0.6Q0 -0.2 2 -0.6Q1.8 2.4 0 2.4Q-1.8 2.4 -2 -0.6Z"/></clipPath><path d="M-2 -0.6Q0 -0.2 2 -0.6Q1.8 2.4 0 2.4Q-1.8 2.4 -2 -0.6Z" fill="' + c.p26 + '"/>' + (lvl >= 2 ? '<ellipse cx="0" cy="2.15" rx="1.2" ry="0.7" fill="' + c.blush + '" clip-path="url(#' + id + 'mo)"/>' : ''),
  };
  const star = (cx, cy, r) => { const k = 0.24; return 'M' + f(cx) + ' ' + f(cy - r) + 'Q' + f(cx + r * k) + ' ' + f(cy - r * k) + ' ' + f(cx + r) + ' ' + f(cy) + 'Q' + f(cx + r * k) + ' ' + f(cy + r * k) + ' ' + f(cx) + ' ' + f(cy + r) + 'Q' + f(cx - r * k) + ' ' + f(cy + r * k) + ' ' + f(cx - r) + ' ' + f(cy) + 'Q' + f(cx - r * k) + ' ' + f(cy - r * k) + ' ' + f(cx) + ' ' + f(cy - r) + 'Z'; };

  function draw(o) {
    o = o || {};
    const CM = window.RelayChefModern, C = o.pal ? Object.assign({}, CM.colors, o.pal) : CM.colors, sq = (a, b, c, d, n, bw, tf) => CM.squircle(a, b, c, d, n, bw, tf, f);
    const lvl = o.lvl == null ? 3 : o.lvl, id = (o.idp || 'cs') + '-', size = o.size || 160;
    const seed = SEEDS[o.seed] ? o.seed : 'circle', S = SEEDS[seed], w = S.w, h = S.h, y1 = 30.75, x0 = 16 - w / 2, y0 = y1 - h, acc = o.acc || 'none', toq = !!o.toque, oy = toq ? y0 - 6.75 : y0 - 4 - (acc === 'hardhat' ? 2.5 : acc === 'headphones' ? 1.5 : 0);
    const sx = o.sx || 1, sy = o.sy || 1, dy = o.dy || 0, rot = o.rot || 0;
    const hair = lvl >= 2 ? 0.25 : 1, line = lvl >= 2 ? 0.85 : 1.1;
    const defs = [], out = [];
    const lift = Math.min(0.5, Math.abs(dy) * 0.07);
    if (o.ring) { const g = o.ring; out.push('<circle cx="16" cy="' + f(y0 + h / 2) + '" r="' + f(Math.max(w, h) / 2 + 2.25) + '" stroke="' + g.stroke + '" stroke-width="' + (g.width || 1) + '" stroke-opacity="' + (g.opacity == null ? 1 : g.opacity) + '"' + (g.dash ? ' pathLength="100" stroke-dasharray="' + g.dash + '" stroke-linecap="round"' : '') + (g.anim ? ' style="transform-box: fill-box; transform-origin: center; animation: ' + g.anim + '"' : '') + '/>'); }
    out.push('<ellipse cx="16" cy="' + f(y1) + '" rx="' + f(w * 0.36 * sx * (1 - lift)) + '" ry="1" fill="' + C.p26 + '" fill-opacity="' + f(0.16 * (1 - lift)) + '"/>');
    if (o.halo) out.push('<circle cx="16" cy="' + f(((toq ? oy + 1.25 : y0 - (acc === 'hardhat' ? 4.8 : acc === 'headphones' ? 3.2 : 0)) + y1) / 2 + dy) + '" r="' + f((y1 - (toq ? oy + 1.25 : y0 - (acc === 'hardhat' ? 4.8 : acc === 'headphones' ? 3.2 : 0))) / 2 + 0.5 + o.halo[0]) + '" stroke="' + C.p70 + '" stroke-opacity="' + o.halo[1] + '" stroke-width="' + (lvl >= 2 ? 0.6 : 1) + '"/>');
    const ox = o.ox === 'right' ? x0 + w : o.ox === 'left' ? x0 : 16;
    out.push('<g transform="translate(0 ' + f(dy) + ') rotate(' + rot + ' 16 ' + y1 + ') translate(' + f(ox) + ' ' + y1 + ') scale(' + sx + ' ' + sy + ') translate(' + f(-ox) + ' ' + -y1 + ')">');
    // body (M2: base step, lit field, band shadow, shoulder highlight)
    const body = shapeOf(seed, x0, y0, w, h, sq);
    defs.push('<clipPath id="' + id + 'b"><path d="' + body + '"/></clipPath>');
    out.push('<path d="' + body + '" fill="' + C.p46 + '"/>');
    out.push('<g clip-path="url(#' + id + 'b)"><path d="' + shapeOf(seed, x0 - 1.25, y0 - 1.5, w * 0.99, h * 0.99, sq) + '" fill="' + C.p58 + '"/>' + (toq ? '<ellipse cx="16" cy="' + f(y0 + 6) + '" rx="' + f(w * 0.36) + '" ry="1.35" fill="' + C.p46 + '"/>' : '') + '</g>');
    out.push('<rect x="-2.5" y="-0.8" width="5" height="1.6" rx="0.8" transform="translate(' + f(x0 + S.hx) + ' ' + f(y0 + h * 0.47) + ') rotate(' + S.hr + ')" fill="' + C.p70 + '"/>');
    // face
    const es = o.eyeS || 1, ew = 4.25 * es, eh = 5 * es, ey = y0 + h * (toq ? 0.583 : S.ey || 0.5), ey0 = ey - eh / 2, look = o.look || [0, 0];
    const cxs = [16 - S.ex, 16 + S.ex];
    out.push('<g clip-path="url(#' + id + 'b)"><g transform="translate(' + f(o.faceDx || 0) + ' 0)">');
    cxs.forEach((x, i) => out.push('<ellipse cx="' + f(x + (i ? 3.75 : -3.75)) + '" cy="' + f(ey + 3.4) + '" rx="1.8" ry="1" fill="' + C.blush + '" fill-opacity="0.5"/>'));
    cxs.forEach((ecx, i) => {
      const ex = ecx - ew / 2, lid = o.lid || 0, ew2 = lvl >= 2 ? line : 1.1;
      if (o.eyes === 'squeeze') {
        const a = i ? ex + ew - 0.4 : ex + 0.4, b = i ? ex + 0.4 : ex + ew - 0.4;
        out.push('<path d="M' + f(a) + ' ' + f(ey - 1.5) + 'L' + f(b) + ' ' + f(ey) + 'L' + f(a) + ' ' + f(ey + 1.5) + '" stroke="' + C.p26 + '" stroke-width="' + f(ew2) + '" stroke-linecap="round" stroke-linejoin="round"/>');
        return;
      }
      if (o.eyes === 'arc') {
        out.push('<path d="M' + f(ex + 0.2) + ' ' + f(ey + 0.9) + 'Q' + f(ecx) + ' ' + f(ey - 2.1) + ' ' + f(ex + ew - 0.2) + ' ' + f(ey + 0.9) + '" stroke="' + C.p26 + '" stroke-width="' + f(ew2) + '" stroke-linecap="round"/>');
        return;
      }
      if (lid >= 0.95) {
        out.push('<path d="M' + f(ex) + ' ' + f(ey) + 'Q' + f(ecx) + ' ' + f(ey + 1.3) + ' ' + f(ex + ew) + ' ' + f(ey) + '" stroke="' + C.p26 + '" stroke-width="' + f(line) + '" stroke-linecap="round"/>');
        return;
      }
      const shape = sq(ex, ey0, ew, eh, 2.4, 0, 0.12);
      defs.push('<clipPath id="' + id + 'e' + i + '"><path d="' + shape + '"/></clipPath>');
      out.push('<path d="' + shape + '" fill="' + C.sclera + '"/><g clip-path="url(#' + id + 'e' + i + ')">');
      const ir = (lvl >= 2 ? 0.37 : 0.4) * ew / es, icx = ecx + look[0] * ew * 0.2, icy = ey + 0.08 * eh + look[1] * eh * 0.17;
      out.push('<circle cx="' + f(icx) + '" cy="' + f(icy) + '" r="' + f(ir) + '" fill="' + (lvl >= 2 ? C.p46 : C.p26) + '"/>');
      if (lvl >= 2) out.push('<circle cx="' + f(icx) + '" cy="' + f(icy + ir * 0.06) + '" r="' + f(ir * 0.52) + '" fill="' + C.p26 + '"/>');
      if (o.sparkle) {
        out.push(lvl >= 2 ? '<path d="' + star(icx - ir * 0.3, icy - ir * 0.36, ir * 0.66) + '" fill="#ffffff"/><circle cx="' + f(icx + ir * 0.45) + '" cy="' + f(icy + ir * 0.4) + '" r="' + f(ir * 0.17) + '" fill="#ffffff"/>' : '<circle cx="' + f(icx - ir * 0.3) + '" cy="' + f(icy - ir * 0.35) + '" r="0.85" fill="#ffffff"/>');
      } else {
        out.push('<circle cx="' + f(icx - ir * 0.36) + '" cy="' + f(icy - ir * 0.4) + '" r="' + f(lvl >= 2 ? ir * 0.36 : 0.64) + '" fill="#ffffff"/>');
        if (lvl >= 2) out.push('<circle cx="' + f(icx + ir * 0.42) + '" cy="' + f(icy + ir * 0.38) + '" r="' + f(ir * 0.14) + '" fill="#ffffff"/>');
      }
      if (lid > 0) {
        const ly = ey0 + eh * lid, cv = o.lidFlat ? 0 : 0.5;
        out.push('<path d="M' + f(ex - 1) + ' ' + f(ey0 - 1) + 'H' + f(ex + ew + 1) + 'V' + f(ly) + 'Q' + f(ecx) + ' ' + f(ly + cv) + ' ' + f(ex - 1) + ' ' + f(ly) + 'Z" fill="' + C.p58 + '"/>');
        out.push('<path d="M' + f(ex - 0.5) + ' ' + f(ly + 0.05) + 'Q' + f(ecx) + ' ' + f(ly + cv + 0.05) + ' ' + f(ex + ew + 0.5) + ' ' + f(ly + 0.05) + '" stroke="' + C.p26 + '" stroke-width="' + f(lvl >= 2 ? 0.45 : 0.9) + '"/>');
      }
      if (o.lidLow) {
        const ly = ey0 + eh * (1 - o.lidLow);
        out.push('<path d="M' + f(ex - 1) + ' ' + f(ey0 + eh + 1) + 'V' + f(ly + 0.9) + 'Q' + f(ecx) + ' ' + f(ly - 0.9) + ' ' + f(ex + ew + 1) + ' ' + f(ly + 0.9) + 'V' + f(ey0 + eh + 1) + 'Z" fill="' + C.p58 + '"/>');
        if (lvl >= 2) out.push('<path d="M' + f(ex - 0.5) + ' ' + f(ly + 0.75) + 'Q' + f(ecx) + ' ' + f(ly - 0.85) + ' ' + f(ex + ew + 0.5) + ' ' + f(ly + 0.75) + '" stroke="' + C.p46 + '" stroke-width="0.4"/>');
      }
      out.push('</g>');
    });
    const B = BROWS[o.brow || 'idle'], bw = lvl >= 2 ? 1.15 : 1.1, by = ey - 2.5 - 2.1 + B.dy - (es - 1) * 2.5 - (acc === 'glasses' ? 0.7 : 0);
    cxs.forEach((ecx, i) => {
      const s = i ? 1 : -1, P = B.p.map(([dx, d]) => [ecx + s * dx, by + d]);
      out.push('<path d="M' + f(P[0][0]) + ' ' + f(P[0][1]) + 'Q' + f(P[1][0]) + ' ' + f(P[1][1]) + ' ' + f(P[2][0]) + ' ' + f(P[2][1]) + '" stroke="' + C.p26 + '" stroke-opacity="0.9" stroke-width="' + bw + '" stroke-linecap="round"/>');
    });
    if (o.mouth && MOUTH[o.mouth]) out.push('<g transform="translate(16 ' + f(ey + 4.8) + ')">' + MOUTH[o.mouth](C, line, lvl, id) + '</g>');
    out.push('</g></g>');
    if (o.sweat) {
      const [fx, fy, op] = o.sweat, x = x0 + w * fx, y = y0 + h * fy, r = lvl >= 2 ? 1.05 : 1.4;
      out.push('<path d="M' + f(x) + ' ' + f(y - 2.2 * r) + 'Q' + f(x + r) + ' ' + f(y - 0.6 * r) + ' ' + f(x + r) + ' ' + f(y) + 'A' + f(r) + ' ' + f(r) + ' 0 0 1 ' + f(x - r) + ' ' + f(y) + 'Q' + f(x - r) + ' ' + f(y - 0.6 * r) + ' ' + f(x) + ' ' + f(y - 2.2 * r) + 'Z" fill="#ffffff" fill-opacity="' + (op == null ? 0.92 : op) + '" stroke="' + C.p36 + '" stroke-opacity="' + (op == null ? 0.5 : op * 0.5) + '" stroke-width="0.3"/>');
      if (lvl >= 2) out.push('<circle cx="' + f(x - r * 0.35) + '" cy="' + f(y - r * 0.3) + '" r="' + f(r * 0.25) + '" fill="' + C.p70 + '" fill-opacity="' + (op == null ? 0.6 : op * 0.6) + '"/>');
    }
    if (toq) {
    // toque (M2: shade step, lit offset, pleats, band step, stitching, spark emblem)
    const tX0 = 7, tX1 = 25, bX0 = 8, bX1 = 24, bY0 = 9.5 + oy, bY1 = 12.75 + oy, top = 1.25 + oy, rs = 3.75, rc = 4.5;
    const puffs = [[tX0 + rs, 2.75 + oy + rs, rs], [16, top + rc, rc], [tX1 - rs, 2.75 + oy + rs, rs]];
    const minY = Math.min(...puffs.map((p) => p[1]));
    const shapes = (a) => puffs.map((p) => '<circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + p[2] + '" ' + a + '/>').join('') + '<rect x="' + (bX0 + 0.5) + '" y="' + f(minY) + '" width="' + (bX1 - bX0 - 1) + '" height="' + f(bY0 + 0.5 - minY) + '" ' + a + '/>';
    defs.push('<clipPath id="' + id + 'tq">' + shapes('') + '</clipPath>');
    const band = '<rect x="' + bX0 + '" y="' + f(bY0) + '" width="' + (bX1 - bX0) + '" height="' + f(bY1 - bY0) + '" rx="1.25"';
    defs.push('<clipPath id="' + id + 'bd">' + band + '/></clipPath>');
    out.push('<g transform="translate(' + f(o.toqueDx || 0) + ' ' + f(o.toqueDy || 0) + ') rotate(' + (o.toqueRot || 0) + ' 16 ' + f(bY1) + ') translate(16 ' + f(bY1) + ') scale(1 ' + (o.toqueSy || 1) + ') translate(-16 ' + f(-bY1) + ')">');
    out.push(shapes('fill="none" stroke="' + C.p46 + '" stroke-opacity="0.32" stroke-width="' + f(2 * hair) + '"'));
    out.push(shapes('fill="' + C.w3 + '"'));
    out.push('<g clip-path="url(#' + id + 'tq)"><g transform="translate(-0.9 -0.8)">' + shapes('fill="' + C.w + '"') + '</g></g>');
    if (lvl >= 2) [12.4, 16, 19.6].forEach((x) => out.push('<path d="M' + f(x) + ' ' + f(bY0 + 0.2) + 'Q' + f(x + (x - 16) * 0.12) + ' ' + f(bY0 - 2) + ' ' + f(x + (x - 16) * 0.06) + ' ' + f(bY0 - 3.8) + '" stroke="' + C.w4 + '" stroke-opacity="0.55" stroke-width="0.3" stroke-linecap="round"/>'));
    out.push(band + ' fill="' + C.w2 + '" stroke="' + C.p46 + '" stroke-opacity="0.32" stroke-width="' + f(hair) + '"/>');
    out.push('<rect x="' + bX0 + '" y="' + f(bY1 - (bY1 - bY0) * 0.38) + '" width="' + (bX1 - bX0) + '" height="' + f(bY1 - bY0) + '" fill="' + C.w3 + '" clip-path="url(#' + id + 'bd)"/>');
    if (lvl >= 2) {
      for (let x = bX0 + 1.4; x < bX1 - 1; x += 1.35) if (Math.abs(x - 16) > 2) out.push('<circle cx="' + f(x) + '" cy="' + f(bY0 + 0.75) + '" r="0.22" fill="' + C.w4 + '"/>');
      out.push('<path d="' + star(16 + (o.bandDx || 0), (bY0 + bY1) / 2, 1.3) + '" fill="' + C.p54 + '"/>');
    }
    out.push('</g>');
    } else if (acc !== 'none') {
      const ar = o.toqueRot || 0, adx = (o.toqueDx || 0) + (o.bandDx || 0), ady = o.toqueDy || 0, fdx = o.faceDx || 0;
      const G0 = '#2b2e37', G1 = '#4a4e5c', G2 = '#7a7f90', sw = lvl >= 2 ? 0.7 : 1.2;
      const side = (y, s) => seed === 'pear' ? 16 + s * (w * (0.28 + 0.22 * (y - y0) / h)) : seed === 'squircle' ? 16 + s * (w / 2 - 0.2) : 16 + s * Math.sqrt(Math.max(0, (w / 2) ** 2 - (y - (y0 + h / 2)) ** 2));
      let s = '';
      if (acc === 'glasses') {
        const fw = ew + 1.9, fh = eh + 1.5, L = cxs[0] + fdx, R = cxs[1] + fdx, rx = lvl >= 2 ? 1.6 : 1.3;
        s += '<g transform="translate(' + f(adx * 0.5) + ' ' + f(ady * 0.6) + ') rotate(' + f(ar * 0.4) + ' 16 ' + f(ey) + ')">';
        [L, R].forEach((cx) => { s += '<rect x="' + f(cx - fw / 2) + '" y="' + f(ey - fh / 2) + '" width="' + f(fw) + '" height="' + f(fh) + '" rx="' + rx + '" fill="#ffffff" fill-opacity="0.1" stroke="' + G0 + '" stroke-width="' + f(sw) + '"/>'; });
        s += '<path d="M' + f(L + fw / 2) + ' ' + f(ey - 0.5) + 'Q16 ' + f(ey - 1.6) + ' ' + f(R - fw / 2) + ' ' + f(ey - 0.5) + 'M' + f(L - fw / 2) + ' ' + f(ey - 0.9) + 'L' + f(side(ey, -1) + 0.4) + ' ' + f(ey - 1.4) + 'M' + f(R + fw / 2) + ' ' + f(ey - 0.9) + 'L' + f(side(ey, 1) - 0.4) + ' ' + f(ey - 1.4) + '" stroke="' + G0 + '" stroke-width="' + f(sw) + '" stroke-linecap="round"/>';
        if (lvl >= 2) [L, R].forEach((cx) => { s += '<path d="M' + f(cx - fw / 2 + 0.9) + ' ' + f(ey - fh / 2 + 1.6) + 'L' + f(cx - fw / 2 + 1.9) + ' ' + f(ey - fh / 2 + 0.7) + '" stroke="#ffffff" stroke-opacity="0.7" stroke-width="0.35" stroke-linecap="round"/>'; });
        s += '</g>';
      } else if (acc === 'headphones') {
        const cy = ey + 0.5, lx = side(cy, -1), rx2 = side(cy, 1), bw2 = lvl >= 2 ? 1.5 : 1.8;
        s += '<g transform="translate(' + f(adx) + ' ' + f(ady) + ') rotate(' + f(ar * 0.5) + ' 16 ' + f(cy) + ')">';
        s += '<path d="M' + f(lx + 1) + ' ' + f(cy - 1.5) + 'C' + f(lx + 1) + ' ' + f(y0 - 6) + ' ' + f(rx2 - 1) + ' ' + f(y0 - 6) + ' ' + f(rx2 - 1) + ' ' + f(cy - 1.5) + '" stroke="' + G1 + '" stroke-width="' + f(bw2) + '" stroke-linecap="round"/>';
        if (lvl >= 2) s += '<path d="M' + f(lx + 1.6) + ' ' + f(cy - 3.5) + 'C' + f(lx + 1.6) + ' ' + f(y0 - 4.6) + ' ' + f(rx2 - 1.6) + ' ' + f(y0 - 4.6) + ' ' + f(rx2 - 1.6) + ' ' + f(cy - 3.5) + '" stroke="' + G2 + '" stroke-opacity="0.6" stroke-width="0.35" stroke-linecap="round"/>';
        [[lx, -1], [rx2, 1]].forEach(([x, sg]) => {
          const cw = 3.2, ch = 6.2, X0 = sg < 0 ? x - cw + 1 : x - 1;
          s += '<rect x="' + f(X0) + '" y="' + f(cy - ch / 2) + '" width="' + cw + '" height="' + ch + '" rx="1.4" fill="' + G0 + '"/>';
          s += '<rect x="' + f(sg < 0 ? X0 + cw - 1.2 : X0) + '" y="' + f(cy - ch / 2 + 0.8) + '" width="1.2" height="' + f(ch - 1.6) + '" rx="0.6" fill="' + G2 + '"/>';
        });
        s += '</g>';
      } else if (acc === 'hardhat') {
        const b = y0 + 2.2, Y = '#f2b30c', Yd = '#c98700', Yl = '#ffd75e', Ys = '#7d5200';
        s += '<g transform="translate(' + f(adx) + ' ' + f(ady) + ') rotate(' + f(ar * 0.8) + ' 16 ' + f(b) + ')">';
        s += '<path d="M9 ' + f(b) + 'A7 7 0 0 1 23 ' + f(b) + 'Z" fill="' + Y + '" stroke="' + Ys + '" stroke-width="' + (lvl >= 2 ? 0.35 : 0.6) + '"/>';
        s += '<path d="M15.1 ' + f(b - 6.9) + 'Q16 ' + f(b - 7.1) + ' 16.9 ' + f(b - 6.9) + 'V' + f(b) + 'H15.1Z" fill="' + Yl + '"/>';
        s += '<rect x="6.5" y="' + f(b - 0.4) + '" width="19" height="2" rx="1" fill="' + Yd + '" stroke="' + Ys + '" stroke-width="' + (lvl >= 2 ? 0.35 : 0.6) + '"/>';
        if (lvl >= 2) s += '<path d="M11 ' + f(b - 3.2) + 'Q11.8 ' + f(b - 5.4) + ' 13.6 ' + f(b - 6.1) + '" stroke="#ffffff" stroke-opacity="0.6" stroke-width="0.45" stroke-linecap="round"/>';
        s += '</g>';
      } else if (acc === 'scarf') {
        const sy0 = y0 + h * 0.83, SC = '#efe5d3', SD = '#d4c5aa';
        s += '<g transform="translate(' + f(adx * 0.4) + ' ' + f(ady * 0.6) + ') rotate(' + f(ar * 0.3) + ' 16 ' + f(sy0) + ')">';
        s += '<g clip-path="url(#' + id + 'b)"><rect x="' + f(x0 - 1) + '" y="' + f(sy0) + '" width="' + f(w + 2) + '" height="2.6" fill="' + SC + '"/><rect x="' + f(x0 - 1) + '" y="' + f(sy0 + 1.9) + '" width="' + f(w + 2) + '" height="0.7" fill="' + SD + '"/>';
        if (lvl >= 2) s += '<rect x="' + f(x0 - 1) + '" y="' + f(sy0 + 0.8) + '" width="' + f(w + 2) + '" height="0.55" fill="' + C.p54 + '" fill-opacity="0.55"/>';
        s += '</g>';
        const kx = 16 + w * 0.22;
        s += '<rect x="-1.25" y="0" width="2.5" height="5.2" rx="0.8" transform="translate(' + f(kx) + ' ' + f(sy0 + 1.3) + ') rotate(-14)" fill="' + SC + '" stroke="' + SD + '" stroke-width="0.4"/>';
        s += '<rect x="' + f(kx - 1.7) + '" y="' + f(sy0 - 0.3) + '" width="3.4" height="3.2" rx="1.1" fill="' + SC + '" stroke="' + SD + '" stroke-width="0.4"/>';
        if (lvl >= 2) s += '<path d="M' + f(kx - 1.6) + ' ' + f(sy0 + 5.6) + 'l0.4 0.9M' + f(kx - 0.6) + ' ' + f(sy0 + 5.8) + 'l0.3 0.9M' + f(kx + 0.4) + ' ' + f(sy0 + 5.5) + 'l0.2 0.9" stroke="' + SD + '" stroke-width="0.4" stroke-linecap="round"/>';
        s += '</g>';
      }
      out.push(s);
    }
    out.push('</g>');
    // overlays outside the body transform
    const zw = lvl >= 2 ? 0.55 : 1;
    (o.z || []).forEach(([x, y, s, op]) => out.push('<path d="M' + f(x) + ' ' + f(y + oy) + 'h' + s + 'l' + -s + ' ' + s + 'h' + s + '" stroke="' + C.p62 + '" stroke-opacity="' + op + '" stroke-width="' + zw + '" stroke-linecap="round" stroke-linejoin="round"/>'));
    const ov = lvl >= 2 ? 0.55 : 1;
    if (o.tap) {
      const tx = x0 - 1.75, ty = y0 + h * 0.55, [r, op] = o.tap;
      out.push('<circle cx="' + f(tx) + '" cy="' + f(ty) + '" r="' + r + '" stroke="' + C.p54 + '" stroke-opacity="' + op + '" stroke-width="' + ov + '"/>');
      out.push('<circle cx="' + f(tx) + '" cy="' + f(ty) + '" r="' + (lvl >= 2 ? 0.75 : 1.1) + '" fill="' + C.p54 + '"/>');
      if (lvl >= 2) out.push('<path d="M' + f(tx - 3.6) + ' ' + f(ty) + 'H' + f(tx - 2.6) + 'M' + f(tx - 2.6) + ' ' + f(ty - 2.6) + 'L' + f(tx - 1.9) + ' ' + f(ty - 1.9) + 'M' + f(tx - 2.6) + ' ' + f(ty + 2.6) + 'L' + f(tx - 1.9) + ' ' + f(ty + 1.9) + '" stroke="' + C.p54 + '" stroke-opacity="' + op + '" stroke-width="' + ov + '" stroke-linecap="round"/>');
    }
    const tk = (x, y, ang, len) => { const t = (ang * Math.PI) / 180; return 'M' + f(x) + ' ' + f(y) + 'l' + f(Math.cos(t) * len) + ' ' + f(Math.sin(t) * len); };
    if (o.ticks) {
      const R = x0 + w + 0.75 + dy * 0, T = y0 + dy, L = lvl >= 2 ? 1.8 : 2.4;
      let d = tk(R, T + 3.5, -35, L) + tk(R + 0.9, T + 6.75, -5, L);
      if (o.ticks > 1) d += tk(x0 - 0.75, T + 3.5, -145, L) + tk(x0 - 1.65, T + 6.75, -175, L);
      out.push('<path d="' + d + '" stroke="' + C.p54 + '" stroke-width="' + ov + '" stroke-linecap="round"/>');
    }
    if (o.q) {
      const [qx, qy, qs, qo] = o.q, x = qx, y = qy + oy, s = qs;
      out.push('<g transform="translate(' + f(x) + ' ' + f(y) + ') scale(' + s + ')" opacity="' + qo + '"><path d="M-1.4 -1.3Q-1.4 -2.9 0 -2.9Q1.5 -2.9 1.5 -1.45Q1.5 -0.5 0.45 0Q0 0.25 0 1" stroke="' + C.p54 + '" stroke-width="' + (lvl >= 2 ? 0.85 : 1.25) + '" stroke-linecap="round" stroke-linejoin="round"/><circle cx="0" cy="2.5" r="' + (lvl >= 2 ? 0.55 : 0.8) + '" fill="' + C.p54 + '"/></g>');
    }
    if (o.glint) { const [gx, gy, gr] = o.glint; out.push('<path d="' + star(gx, gy + oy, gr) + '" fill="' + C.p70 + '"/>'); }
    (o.dots || []).forEach(([x, y, r]) => out.push('<circle cx="' + x + '" cy="' + f(y + oy) + '" r="' + r + '" fill="' + C.p62 + '"/>'));
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (o.vb || '-4 -8 40 40') + '" width="' + size + '" height="' + size + '" fill="none" aria-hidden="true" focusable="false"><defs>' + defs.join('') + '</defs>' + out.join('') + '</svg>';
  }
  const D1 = [24.5, 0.25, 0.9], D2 = [27.75, -2.75, 1.2], D3 = [31.25, -6.25, 1.5];
  const S0 = { happy: { brow: 'up', lidLow: 0.32, mouth: 'smile' }, focused: { brow: 'focus', lid: 0.38, lidFlat: true, mouth: 'line' }, worried: { brow: 'worried', eyeS: 1.12, mouth: 'wavy' }, sleepy: { brow: 'sleepy', mouth: 'closed' }, excited: { brow: 'high', eyeS: 1.12, sparkle: true, mouth: 'openSmile' }, waiting: { brow: 'idle', mouth: 'closed' }, speaking: { brow: 'idle' }, thinking: { brow: 'think', look: [0.75, -0.95], mouth: 'hmm' } };
  Object.assign(S0, { listening: { brow: 'up', mouth: 'closed' }, poke: { brow: 'high', mouth: 'openSmile', eyes: 'squeeze' }, stuck: { brow: 'worried', eyeS: 1.1, mouth: 'wavy', sx: 0.96, sy: 0.96 }, done: { brow: 'up', eyes: 'arc', mouth: 'smile' } });
  const X = (s, p) => Object.assign({}, S0[s], p);
  const STATES = [
    { key: 'happy', id: '10a', name: 'Happy', loop: 'Loop 1600 ms', kf: [
      ['Rest: smiling eyes (lower lids curve up), brows lifted, small smile', 0, X('happy', {})],
      ['Anticipate: squash 5%', 120, X('happy', { sx: 1.04, sy: 0.95 })],
      ['Bounce: up 6 px, stretch 3%', 260, X('happy', { dy: -1.5, sx: 0.98, sy: 1.03 })],
      ['Land and settle; accessory lags 2° (if any)', 460, X('happy', { sx: 1.02, sy: 0.98, toqueRot: 2 })]],
      rm: ['Smiling eyes, lifted brows and smile, no bounce', X('happy', {})] },
    { key: 'focused', id: '10b', name: 'Focused', loop: 'Loop 2400 ms (eye scan only)', kf: [
      ['Lids lower flat, brows level and drawn in, mouth a short line', 0, X('focused', { look: [0, 0.3] })],
      ['Lean in 3°, eyes down to the work', 200, X('focused', { rot: -3, look: [-0.2, 0.8] })],
      ['Eyes track left', 900, X('focused', { rot: -3, look: [-0.85, 0.6] })],
      ['Eyes track right', 1500, X('focused', { rot: -3, look: [0.85, 0.6] })]],
      rm: ['Flat lids, brows in, short mouth, leaning in', X('focused', { rot: -3, look: [-0.2, 0.8] })] },
    { key: 'worried', id: '10c', name: 'Worried', loop: 'Plays once, holds frame 2', kf: [
      ['Brows pinch up in the middle, eyes widen 12%, wavy mouth', 0, X('worried', {})],
      ['Shrinks to 95%; accessory slips askew (if any)', 180, X('worried', { sx: 0.95, sy: 0.95, toqueRot: 8 })],
      ['Glances away left', 520, X('worried', { sx: 0.95, sy: 0.95, toqueRot: 8, look: [-0.85, -0.2] })],
      ['Shivers ±1°, two 80 ms cycles, eyes back', 800, X('worried', { sx: 0.95, sy: 0.95, toqueRot: 8, rot: 1 })]],
      rm: ['Pinched brows, wide eyes, wavy mouth, smaller, accessory askew (if any)', X('worried', { sx: 0.95, sy: 0.95, toqueRot: 8 })] },
    { key: 'sleepy', id: '10d', name: 'Sleepy', loop: 'Loop 4800 ms, all eased slowly', kf: [
      ['Lids at half, still', 0, X('sleepy', { lid: 0.5 })],
      ['Lids drift to 70%, sway left 3°', 1200, X('sleepy', { lid: 0.7, rot: -3, toqueRot: -6 })],
      ['Accessory droops (if any), brows sag; sway right 3°', 2400, X('sleepy', { lid: 0.62, rot: 3, toqueRot: -14, toqueDy: 0.6, toqueSy: 0.94 })],
      ['A tiny “z” rises and fades', 3200, X('sleepy', { lid: 0.7, toqueRot: -14, toqueDy: 0.6, toqueSy: 0.94, z: [[25, 1.5, 2, 1], [28.5, -2.75, 1.4, 0.5]] })]],
      rm: ['Lids at 70%, accessory drooped (if any), one static “z”', X('sleepy', { lid: 0.7, toqueRot: -14, toqueDy: 0.6, toqueSy: 0.94, z: [[25, 1.5, 2, 1]] })] },
    { key: 'excited', id: '10e', name: 'Excited', loop: 'Plays once, 640 ms', kf: [
      ['Crouch: squash 8%; eyes wide with sparkle, brows high, open smile', 0, X('excited', { sx: 1.07, sy: 0.92 })],
      ['Hop 1: up 16 px, stretch 6%', 140, X('excited', { dy: -4, sx: 0.95, sy: 1.06, toqueDy: -0.4 })],
      ['Land: squash 10%, accessory bumps 3° (if any)', 320, X('excited', { sx: 1.09, sy: 0.9, toqueRot: -3 })],
      ['Hop 2: up 8 px, then settle at 640 ms', 460, X('excited', { dy: -2, sx: 0.97, sy: 1.03, toqueRot: 2 })]],
      rm: ['Sparkling wide eyes, high brows, open smile, no hop', X('excited', {})] },
    { key: 'waiting', id: '10f', name: 'Waiting', loop: 'Loop 4800 ms', kf: [
      ['Breathes in: stretch 2% over 1600 ms, out again', 0, X('waiting', { sy: 1.02, sx: 0.99 })],
      ['Blink: lids close for 120 ms', 1600, X('waiting', { lid: 1 })],
      ['Glances left, 300 ms', 2400, X('waiting', { look: [-0.9, 0] })],
      ['Glances right, then back to centre', 3400, X('waiting', { look: [0.9, 0] })]],
      rm: ['At rest, eyes open, centred', X('waiting', {})] },
    { key: 'speaking', id: '10g', name: 'Speaking', loop: 'Each shape holds 90–120 ms; follows the audio', kf: [
      ['Closed', 0, X('speaking', { mouth: 'closed' })],
      ['Small open', 90, X('speaking', { mouth: 'small' })],
      ['Wide open on a stressed syllable: up 4 px, stretch 2%, brows lift', 180, X('speaking', { mouth: 'wide', dy: -1, sx: 0.99, sy: 1.02, brow: 'up' })],
      ['Round “o”', 300, X('speaking', { mouth: 'o' })]],
      rm: ['Small open mouth, still; the words carry the speech', X('speaking', { mouth: 'small' })] },
    { key: 'speaking-line', id: '10h', name: 'Speaking, synced line', line: ['Two', 'jobs', 'need', 'you.'], loop: 'Line “Two jobs need you.” over 900 ms', kf: [
      ['“Two”: round “o”', 0, X('speaking', { mouth: 'o' })],
      ['“jobs” (stressed): wide open, up 4 px, brows lift', 200, X('speaking', { mouth: 'wide', dy: -1, sx: 0.99, sy: 1.02, brow: 'up' })],
      ['“need”: small open', 440, X('speaking', { mouth: 'small' })],
      ['“you.”: round “o”, closes to rest at 900 ms', 620, X('speaking', { mouth: 'o' })]],
      rm: ['Gentle closed smile beside the full line', X('speaking', { mouth: 'smile' })] },
    { key: 'thinking', id: '10i', name: 'Thinking', loop: 'Loop 1500 ms; dots fade out together', kf: [
      ['Gaze up and to the side, brows slightly in', 0, X('thinking', {})],
      ['Dot 1 rises above the head', 300, X('thinking', { dots: [D1] })],
      ['Dot 2', 600, X('thinking', { dots: [D1, D2] })],
      ['Dot 3', 900, X('thinking', { dots: [D1, D2, D3] })]],
      rm: ['Gaze up, all three dots shown at once', X('thinking', { dots: [D1, D2, D3] })] },
    { key: 'listening', id: '10j', name: 'Listening / hello', loop: 'Plays once, 720 ms, on open or when you speak to it', kf: [
      ['Face turned to the side: eyes (and accessory) offset left', 0, X('listening', { brow: 'idle', faceDx: -3, bandDx: -1.5, toqueDx: -0.5, look: [-0.9, 0] })],
      ['Turns to camera: face and accessory slide to centre, brows rise', 160, X('listening', { faceDx: -1.1, bandDx: -0.5, look: [-0.3, 0] })],
      ['Small hop: up 10 px, stretch 4%, little “hi” smile', 320, X('listening', { dy: -2.5, sx: 0.97, sy: 1.04, mouth: 'smile', look: [0, 0.1] })],
      ['Lands, squash 3%, settles to true shape at 720 ms', 520, X('listening', { sx: 1.03, sy: 0.97, mouth: 'smile' })]],
      rm: ['Facing you, brows up, “hi” smile', X('listening', { mouth: 'smile' })] },
    { key: 'poke', id: '10k', name: 'Poke reaction', loop: 'Plays once, 620 ms, from a tap on the creature', kf: [
      ['Tap lands on the left (marked); brows jump', 0, X('poke', { eyes: null, eyeS: 1.08, mouth: 'small', tap: [1.6, 1] })],
      ['Squish 12% from the tap side; eyes squeeze shut', 60, X('poke', { ox: 'right', sx: 0.88, sy: 1.04, tap: [2.8, 0.45] })],
      ['Giggle bounce 1: up 4 px, “hehe” ticks', 220, X('poke', { dy: -1, sx: 0.97, sy: 1.03, ticks: 1 })],
      ['Giggle bounce 2: up 2 px, ticks; springs back to true shape at 620 ms', 400, X('poke', { dy: -0.5, ticks: 2, mouth: 'smile' })]],
      rm: ['Squeezed eyes, open smile, ticks, true shape', X('poke', { ticks: 2, tap: [1.6, 1] })] },
    { key: 'stuck', id: '10l', name: 'Stuck / blocked', loop: 'Plays once, then holds frame 4 until resolved', kf: [
      ['Worried face; shrinks to 96%', 0, X('stuck', {})],
      ['Glances at the problem (left); a sweat drop appears', 300, X('stuck', { look: [-0.9, 0.35], rot: -2, sweat: [0.8, 0.3] })],
      ['Drop slides down; “?” pops above the head at 115%', 700, X('stuck', { look: [-0.9, 0.35], rot: -2, sweat: [0.8, 0.45], q: [24.5, -0.5, 1.15, 1] })],
      ['“?” settles; holds 96% and the glance until resolved', 1000, X('stuck', { look: [-0.9, 0.35], rot: -2, sweat: [0.8, 0.55, 0.55], q: [24.5, -0.5, 1, 1] })]],
      rm: ['Worried, 96%, glancing left, drop and “?” shown', X('stuck', { look: [-0.9, 0.35], sweat: [0.8, 0.4], q: [24.5, -0.5, 1, 1] })] },
    { key: 'done', id: '10m', name: 'Done / proud', loop: 'Plays once, 900 ms, then rests', kf: [
      ['Eyes close happy (upturned arcs); accessory still tilted from work (if any)', 0, X('done', { toqueRot: -6 })],
      ['Chest out: up 2 px, stretch 5%; accessory straightens (if any), spark glint', 200, X('done', { dy: -0.5, sx: 0.97, sy: 1.05, glint: [26, 0.75, 1.6], halo: [0, 0.55] })],
      ['Settles; halo pulses outward and fades', 480, X('done', { sx: 1.02, sy: 0.98, glint: [26, 0.75, 0.9], halo: [0.75, 0.22] })],
      ['Rests on a calm smile, eyes open happy, true shape', 900, X('done', { eyes: null, lidLow: 0.3 })]],
      rm: ['Happy closed eyes, calm smile, accessory straight (if any), faint halo', X('done', { halo: [0, 0.35] })] },
  ];
  const BUBBLE = {
    speak: X('speaking', { mouth: 'small' }),
    think: X('thinking', {}),
    long: X('speaking', { mouth: 'o' }),
  };
  // Forced colours: outlines in currentColor on the canvas colour, solid pupils and brows, no hue fills.
  function drawFc(o) {
    const CM = window.RelayChefModern, sq = (a, b, c, d, n, bw, tf) => CM.squircle(a, b, c, d, n, bw, tf, f);
    const seed = SEEDS[o.seed] ? o.seed : 'circle', S = SEEDS[seed], w = S.w, h = S.h, y1 = 30.75, x0 = 16 - w / 2, y0 = y1 - h, size = o.size || 40;
    const ey = y0 + h * (S.ey || 0.5), out = [], k = 'currentColor', bg = 'var(--rly-color-canvas, Canvas)';
    if (o.ring) out.push('<circle cx="16" cy="' + f(y0 + h / 2) + '" r="' + f(Math.max(w, h) / 2 + 2.25) + '" stroke="' + k + '" stroke-width="1"/>');
    out.push('<path d="' + shapeOf(seed, x0, y0, w, h, sq) + '" fill="' + bg + '" stroke="' + k + '" stroke-width="1.2" stroke-linejoin="round"/>');
    [16 - S.ex, 16 + S.ex].forEach((x, i) => {
      if (o.shut) out.push('<path d="M' + f(x - 2) + ' ' + f(ey) + 'Q' + f(x) + ' ' + f(ey + 1.2) + ' ' + f(x + 2) + ' ' + f(ey) + '" stroke="' + k + '" stroke-width="1.1" stroke-linecap="round"/>');
      else { out.push('<ellipse cx="' + f(x) + '" cy="' + f(ey) + '" rx="2.1" ry="2.5" fill="' + bg + '" stroke="' + k + '" stroke-width="0.8"/>'); out.push('<circle cx="' + f(x) + '" cy="' + f(ey + 0.3) + '" r="1.2" fill="' + k + '"/>'); }
      const s = i ? 1 : -1, by = ey - 4.6;
      out.push('<path d="M' + f(x + s * 1.9) + ' ' + f(by + 0.35) + 'Q' + f(x + s * 0.2) + ' ' + f(by - 1) + ' ' + f(x - s * 1.7) + ' ' + f(by + 0.45) + '" stroke="' + k + '" stroke-width="1.1" stroke-linecap="round"/>');
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (o.vb || '-4 -8 40 40') + '" width="' + size + '" height="' + size + '" fill="none" aria-hidden="true" focusable="false">' + out.join('') + '</svg>';
  }
  const api = { draw, drawFc, seeds: Object.keys(SEEDS), STATES, BUBBLE };
  if (typeof window !== 'undefined') window.RelayCreatureStates = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
