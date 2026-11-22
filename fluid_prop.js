// fluid_prop.js — CoolProp 기반 2상(포화 1D log(P) PCHIP + 과냉/과열 2D) 및 단상(GW, Air 등) 물성치 엔진
// 개선: log(P) PCHIP 단조 3차 보간(2상 ρ 오차 대폭 축소), 범위 초과 플래그/경고, 과열 상한 외삽(Cp 기반), 표면장력 σ(T), DB 버전 관리
(function (global) {
  const FLUID_DB_VERSION = "2026.11.v2";

  const TABLE_KEYS = [
    { key: "h",   label: "엔탈피 (kJ/kg)" },
    { key: "T",   label: "온도 (°C)" },
    { key: "rho", label: "밀도 (kg/m³)" },
    { key: "s",   label: "엔트로피 (kJ/kg-K)" },
    { key: "mu",  label: "점성계수 (uPa-s)" },
    { key: "k",   label: "열전도도 (mW/m-K)" },
    { key: "Cp",  label: "정압비열 (kJ/kg-K)" }
  ];

  // 냉매별 임계온도/표면장력 상수 (Brock-Bird / Mulero 피팅, σ = σ0 * (1 - T/Tc)^mu [N/m])
  const SURFACE_TENSION_PARAMS = {
    R134a: { Tc_K: 374.21, sigma0: 0.0568, exp: 1.242 },
    R32:   { Tc_K: 351.255, sigma0: 0.0680, exp: 1.250 },
    Water: { Tc_K: 647.096, sigma0: 0.1280, exp: 1.256 }
  };

  function splitLine(line) {
    if (line.includes(",")) return line.split(",").map(s => s.trim());
    if (line.includes("\t")) return line.split("\t").map(s => s.trim());
    return line.trim().split(/\s+/);
  }

  function parseSatCSV(text) {
    const lines = (text || "").replace(/^\uFEFF/, "").replace(/^[\r\n]+|[\r\n]+$/g, "").split(/\r?\n/).filter(l => l.trim().length > 0);
    const rows = [];
    for (const line of lines) {
      const nums = splitLine(line).map(Number);
      if (nums.length >= 14 && !Number.isNaN(nums[0])) rows.push(nums);
    }
    if (rows.length < 2) throw new Error("포화선 CSV는 14열 이상, 최소 2행 필요합니다.");
    rows.sort((a, b) => a[0] - b[0]);
    const cols = ["P","T_sat","h_f","h_g","rho_f","rho_g","s_f","s_g","mu_f","mu_g","k_f","k_g","Cp_f","Cp_g"];
    const sat = {};
    cols.forEach((c, idx) => (sat[c] = rows.map(r => r[idx])));
    return sat;
  }

  function parseMatrixCSV(text) {
    const lines = (text || "").replace(/^\uFEFF/, "").replace(/^[\r\n]+|[\r\n]+$/g, "").split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 3) throw new Error("2D 매트릭스는 최소 3행 필요합니다.");
    const headerCols = splitLine(lines[0]);
    const firstDataCols = splitLine(lines[1]);
    const hStartIdx = (headerCols.length === firstDataCols.length - 1) ? 0 : 1;
    const rawDH = headerCols.slice(hStartIdx).map(v => Math.abs(Number(v)));
    const validIdx = rawDH.map((v, i) => ({ v, i })).filter(o => !Number.isNaN(o.v));
    if (validIdx.length < 2) throw new Error("1행 2열부터 유효한 Δh 축이 필요합니다.");
    validIdx.sort((a, b) => a.v - b.v);
    const dH = validIdx.map(o => o.v);

    const rowList = [];
    for (let r = 1; r < lines.length; r++) {
      const cols = splitLine(lines[r]);
      const pVal = Number(cols[0]);
      if (Number.isNaN(pVal)) continue;
      const vals = validIdx.map(o => Number(cols[o.i + 1]));
      if (vals.some(Number.isNaN)) continue;
      rowList.push({ P: pVal, vals });
    }
    if (rowList.length < 2) throw new Error("유효한 압력(Y축) 행이 최소 2행 필요합니다.");
    rowList.sort((a, b) => a.P - b.P);
    return { P: rowList.map(r => r.P), logP: rowList.map(r => Math.log(Math.max(1e-6, r.P))), dH, grid: rowList.map(r => r.vals) };
  }

  function parseSinglePhaseCSV(text) {
    const lines = (text || "").replace(/^\uFEFF/, "").replace(/^[\r\n]+|[\r\n]+$/g, "").split(/\r?\n/).filter(l => l.trim().length > 0);
    const rows = [];
    for (const line of lines) {
      const nums = splitLine(line).map(Number);
      if (nums.length >= 8 && !Number.isNaN(nums[0])) rows.push(nums);
    }
    if (rows.length < 2) throw new Error("단상 유체 CSV는 8열(T_C,P_bar,h,rho,s,mu,k,Cp), 최소 2행 필요합니다.");
    rows.sort((a, b) => a[0] - b[0]);
    const cols = ["T", "P", "h", "rho", "s", "mu", "k", "Cp"];
    const tbl = {};
    cols.forEach((c, idx) => (tbl[c] = rows.map(r => r[idx])));
    return tbl;
  }

  // Fritsch-Carlson 단조 3차 Hermite 스플라인(PCHIP) 기울기 사전 계산
  function buildPchipSlopes(xs, ys) {
    const n = xs.length;
    const d = new Array(n).fill(0);
    if (n < 2) return d;
    if (n === 2) {
      const s = (ys[1] - ys[0]) / (xs[1] - xs[0] || 1e-12);
      return [s, s];
    }
    const h = new Array(n - 1), del = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i] || 1e-12;
      del[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    for (let i = 1; i < n - 1; i++) {
      if (del[i - 1] * del[i] <= 0) {
        d[i] = 0;
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        d[i] = (w1 + w2) / (w1 / del[i - 1] + w2 / del[i]);
      }
    }
    // 끝점 기울기 (shape-preserving)
    let d0 = ((2 * h[0] + h[1]) * del[0] - h[0] * del[1]) / (h[0] + h[1]);
    if (d0 * del[0] <= 0) d0 = 0;
    else if (del[0] * del[1] <= 0 && Math.abs(d0) > Math.abs(3 * del[0])) d0 = 3 * del[0];
    d[0] = d0;

    let dn = ((2 * h[n - 2] + h[n - 3]) * del[n - 2] - h[n - 2] * del[n - 3]) / (h[n - 2] + h[n - 3]);
    if (dn * del[n - 2] <= 0) dn = 0;
    else if (del[n - 2] * del[n - 3] <= 0 && Math.abs(dn) > Math.abs(3 * del[n - 2])) dn = 3 * del[n - 2];
    d[n - 1] = dn;
    return d;
  }

  function evalPchip(xs, ys, ds, x) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const h = xs[hi] - xs[lo] || 1e-12;
    const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[lo] + h10 * h * ds[lo] + h01 * ys[hi] + h11 * h * ds[hi];
  }

  function interp1D(xs, ys, x) {
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1e-12);
    return ys[lo] + t * (ys[hi] - ys[lo]);
  }

  // log(P) 축을 사용한 2D 쌍선형 보간 (압력 방향 곡률 오차 축소 + 범위초과 여부 반환)
  function interp2D(mat, P, dH) {
    const Ps = mat.P, logPs = mat.logP, dHs = mat.dH, G = mat.grid;
    const pMin = Ps[0], pMax = Ps[Ps.length - 1];
    const hMin = dHs[0], hMax = dHs[dHs.length - 1];
    const pC = Math.min(pMax, Math.max(pMin, P));
    const hC = Math.min(hMax, Math.max(hMin, dH));
    const logPc = Math.log(Math.max(1e-6, pC));

    let i0 = 0, i1 = Ps.length - 1;
    while (i1 - i0 > 1) { const m = (i0 + i1) >> 1; if (Ps[m] <= pC) i0 = m; else i1 = m; }
    let j0 = 0, j1 = dHs.length - 1;
    while (j1 - j0 > 1) { const m = (j0 + j1) >> 1; if (dHs[m] <= hC) j0 = m; else j1 = m; }

    const tx = (hC - dHs[j0]) / (dHs[j1] - dHs[j0] || 1e-12);
    const ty = (logPc - logPs[i0]) / (logPs[i1] - logPs[i0] || 1e-12);
    const v0 = G[i0][j0] + tx * (G[i0][j1] - G[i0][j0]);
    const v1 = G[i1][j0] + tx * (G[i1][j1] - G[i1][j0]);
    return v0 + ty * (v1 - v0);
  }

  function buildFallbackR134aRaw() {
    const Ps = [1.0, 1.5, 2.0, 3.0, 4.0, 5.5, 7.5, 10.0, 13.0, 16.5, 21.0, 26.0, 32.0];
    const satLines = [];
    const satArr = Ps.map(P => {
      const T_sat = -26.4 + 28.5 * Math.log(P) + 1.8 * Math.pow(Math.log(P), 2);
      const h_f = 200 + 1.38 * T_sat, h_fg = Math.max(70, 198 - 1.35 * T_sat), h_g = h_f + h_fg;
      const rho_f = Math.max(750, 1295 - 3.3 * T_sat), rho_g = 4.9 * Math.pow(P, 1.03);
      const s_f = 1.0 + 0.0049 * T_sat, s_g = s_f + h_fg / (T_sat + 273.15);
      const mu_f = Math.max(70, 270 - 2.3 * T_sat), mu_g = 10.8 + 0.045 * T_sat;
      const k_f = Math.max(45, 92 - 0.45 * T_sat), k_g = 11.5 + 0.09 * T_sat;
      const Cp_f = 1.34 + 0.004 * T_sat, Cp_g = 0.85 + 0.005 * T_sat;
      satLines.push([P, T_sat, h_f, h_g, rho_f, rho_g, s_f, s_g, mu_f, mu_g, k_f, k_g, Cp_f, Cp_g].map(v => v.toFixed(4)).join(","));
      return { P, T_sat, h_f, h_g, rho_f, rho_g, s_f, s_g, mu_f, mu_g, k_f, k_g, Cp_f, Cp_g };
    });
    const dH_sub = [0, 10, 20, 35, 50, 70], dH_sup = [0, 10, 25, 45, 70, 100, 140];
    const sub = {}, sup = {};
    TABLE_KEYS.forEach(({ key }) => {
      const subRows = ["," + dH_sub.map(v => -v).join(",")], supRows = ["," + dH_sup.join(",")];
      satArr.forEach(s => {
        subRows.push(s.P.toFixed(2) + "," + dH_sub.map(dh => {
          const dT = dh / s.Cp_f, T = s.T_sat - dT;
          if (key === "h") return s.h_f - dh; if (key === "T") return T; if (key === "rho") return s.rho_f + 2.2 * dT;
          if (key === "s") return s.s_f - dh / (s.T_sat + 273.15); if (key === "mu") return s.mu_f + 2.0 * dT;
          if (key === "k") return s.k_f + 0.35 * dT; return Math.max(1.1, s.Cp_f - 0.002 * dT);
        }).map(v => v.toFixed(4)).join(","));
        supRows.push(s.P.toFixed(2) + "," + dH_sup.map(dh => {
          const dT = dh / s.Cp_g, T = s.T_sat + dT;
          if (key === "h") return s.h_g + dh; if (key === "T") return T; if (key === "rho") return s.rho_g * ((s.T_sat + 273.15) / (T + 273.15));
          if (key === "s") return s.s_g + dh / (T + 273.15); if (key === "mu") return s.mu_g + 0.04 * dT;
          if (key === "k") return s.k_g + 0.08 * dT; return s.Cp_g + 0.0015 * dT;
        }).map(v => v.toFixed(4)).join(","));
      });
      sub[key] = subRows.join("\n"); sup[key] = supRows.join("\n");
    });
    return { kind: "two_phase", sat: satLines.join("\n"), sub, sup };
  }

  function buildDefaultR134aRaw() {
    if (global.COOLPROP_FLUID_DB && global.COOLPROP_FLUID_DB.R134a) {
      return JSON.parse(JSON.stringify(global.COOLPROP_FLUID_DB.R134a));
    }
    return buildFallbackR134aRaw();
  }

  function getDefaultFluidDB() {
    if (global.COOLPROP_FLUID_DB) {
      return JSON.parse(JSON.stringify(global.COOLPROP_FLUID_DB));
    }
    return { "R134a": buildFallbackR134aRaw() };
  }

  class FluidTable {
    constructor(name = "R134a", raw = null) {
      this.name = name;
      this.raw = raw || buildDefaultR134aRaw();
      this._rangeWarnings = new Set();
      this.compile(this.raw);
    }

    resetWarnings() { this._rangeWarnings.clear(); }
    getWarnings() { return [...this._rangeWarnings]; }
    _warn(msg) { if (this._rangeWarnings.size < 12) this._rangeWarnings.add(msg); }

    compile(raw) {
      this.raw = raw;
      this.kind = raw.kind || (raw.sat ? "two_phase" : "single_phase");
      this.single = raw.single ? parseSinglePhaseCSV(raw.single) : null;
      if (this.kind === "two_phase") {
        this.sat = parseSatCSV(raw.sat);
        this.satLogP = this.sat.P.map(p => Math.log(Math.max(1e-6, p)));
        this.satLogRhoG = this.sat.rho_g.map(r => Math.log(Math.max(1e-6, r)));
        // 포화선 PCHIP 계수 사전 계산 (log P 축 기준 — 2상 밀도 및 T_sat 보간 정밀도 극대화)
        this.satSlopes = {};
        Object.keys(this.sat).forEach(k => {
          if (k === "P") return;
          if (k === "rho_g") {
            this.satSlopes.log_rho_g = buildPchipSlopes(this.satLogP, this.satLogRhoG);
          } else {
            this.satSlopes[k] = buildPchipSlopes(this.satLogP, this.sat[k]);
          }
        });
        this.tSatToLogPSlopes = buildPchipSlopes(this.sat.T_sat, this.satLogP);
        this.tSatToHfSlopes = buildPchipSlopes(this.sat.T_sat, this.sat.h_f);
        this.tSatToHgSlopes = buildPchipSlopes(this.sat.T_sat, this.sat.h_g);

        this.sub = {}; this.sup = {};
        TABLE_KEYS.forEach(({ key }) => {
          this.sub[key] = parseMatrixCSV(raw.sub[key]);
          this.sup[key] = parseMatrixCSV(raw.sup[key]);
        });
        this.isolines = this.buildIsolines(10, [5, 10, 20, 40, 80, 150, 300]);
      } else {
        this.sat = null;
        this.satLogP = null;
        this.satSlopes = null;
        this.sub = null;
        this.sup = null;
        this.isolines = null;
        if (!this.single) throw new Error("단상 유체 CSV 데이터가 비어 있습니다.");
      }
    }

    getSurfaceTension(P_bar) {
      if (this.kind !== "two_phase") return 0.05;
      const sp = SURFACE_TENSION_PARAMS[this.name] || SURFACE_TENSION_PARAMS.R134a;
      const T_K = this.tSatC(P_bar) + 273.15;
      const tr = Math.min(0.995, Math.max(0.1, T_K / sp.Tc_K));
      return Math.max(1e-4, sp.sigma0 * Math.pow(1 - tr, sp.exp));
    }

    evalSinglePhase(T_C, P_bar = 1.01325) {
      if (this.single) {
        const s = this.single;
        const tMin = s.T[0], tMax = s.T[s.T.length - 1];
        const outOfRange = T_C < tMin - 0.1 || T_C > tMax + 0.1;
        if (outOfRange) {
          this._warn(`${this.name} 단상 온도 범위 초과 (T=${T_C.toFixed(1)}°C, 테이블 ${tMin}~${tMax}°C)`);
        }
        const T = T_C;
        let rho = interp1D(s.T, s.rho, T);
        if (this.name === "Air" && P_bar > 0.1) {
          rho = rho * (P_bar / (s.P[0] || 1.01325));
        }
        return {
          T, P: P_bar,
          h: interp1D(s.T, s.h, T),
          rho,
          s: interp1D(s.T, s.s, T),
          mu: interp1D(s.T, s.mu, T),
          k: interp1D(s.T, s.k, T),
          Cp: interp1D(s.T, s.Cp, T),
          outOfRange
        };
      }
      if (this.kind === "two_phase") {
        const st = this.solvePT(Math.max(this.sat.P[0], P_bar), T_C);
        return { T: st.T, P: st.P, h: st.h, rho: st.rho, s: st.s, mu: st.mu, k: st.k, Cp: st.Cp, outOfRange: st.outOfRange };
      }
      return { T: T_C, P: P_bar, h: 300, rho: 1.2, s: 1.0, mu: 18.5, k: 26.0, Cp: 1.005, outOfRange: true };
    }

    getSatAtP(P) {
      const s = this.sat;
      const pMin = s.P[0], pMax = s.P[s.P.length - 1];
      const outOfRange = P < pMin * 0.999 || P > pMax * 1.001;
      if (outOfRange) {
        this._warn(`${this.name} 포화압력 범위 초과 (P=${P.toFixed(2)} bar, 테이블 ${pMin}~${pMax} bar)`);
      }
      const pC = Math.min(pMax, Math.max(pMin, P));
      const lp = Math.log(Math.max(1e-6, pC));
      const out = { P: pC, outOfRange };
      Object.keys(s).forEach(k => {
        if (k === "P") return;
        if (k === "rho_g") {
          out.rho_g = Math.exp(evalPchip(this.satLogP, this.satLogRhoG, this.satSlopes.log_rho_g, lp));
        } else {
          out[k] = evalPchip(this.satLogP, s[k], this.satSlopes[k], lp);
        }
      });
      return out;
    }

    tSatC(P) {
      const pMin = this.sat.P[0], pMax = this.sat.P[this.sat.P.length - 1];
      const lp = Math.log(Math.max(1e-6, Math.min(pMax, Math.max(pMin, P))));
      return evalPchip(this.satLogP, this.sat.T_sat, this.satSlopes.T_sat, lp);
    }
    pSatBar(T) {
      return Math.exp(evalPchip(this.sat.T_sat, this.satLogP, this.tSatToLogPSlopes, T));
    }
    hgKJ(T) { return evalPchip(this.sat.T_sat, this.sat.h_g, this.tSatToHgSlopes, T); }
    hfKJ(T) { return evalPchip(this.sat.T_sat, this.sat.h_f, this.tSatToHfSlopes, T); }

    evalPH(P, h) {
      if (this.kind !== "two_phase") {
        const s = this.single;
        const T = interp1D(s.h, s.T, h);
        const st = this.evalSinglePhase(T, P);
        return { ...st, x: 1, phase: "단상", SC: 0, SH: 0, T_sat: T };
      }
      const sat = this.getSatAtP(P);
      let outOfRange = !!sat.outOfRange;

      if (h < sat.h_f - 1e-6) {
        const dH = sat.h_f - h;
        const dHMax = this.sub.T.dH[this.sub.T.dH.length - 1];
        let T = interp2D(this.sub.T, P, dH);
        let rho = interp2D(this.sub.rho, P, dH);
        let s = interp2D(this.sub.s, P, dH);
        const mu = interp2D(this.sub.mu, P, dH);
        const k = interp2D(this.sub.k, P, dH);
        const Cp = Math.max(0.2, interp2D(this.sub.Cp, P, dH));
        if (dH > dHMax) {
          // 테이블 과냉 상한 초과 시 경계 Cp로 연속 선형 외삽 + 범위 경고
          outOfRange = true;
          const extra = dH - dHMax;
          const dT = extra / Cp;
          T -= dT;
          s -= extra / Math.max(150, T + 273.15);
          this._warn(`${this.name} 과냉 영역 Δh=${dH.toFixed(1)} kJ/kg 초과 (상한 ${dHMax})`);
        }
        return {
          P, T, h, rho, s, mu, k, Cp,
          x: 0, phase: "과냉액체", SC: Math.max(0, sat.T_sat - T), SH: 0, T_sat: sat.T_sat, outOfRange
        };
      }
      if (h > sat.h_g + 1e-6) {
        const dH = h - sat.h_g;
        const dHMax = this.sup.T.dH[this.sup.T.dH.length - 1];
        let T = interp2D(this.sup.T, P, dH);
        let rho = interp2D(this.sup.rho, P, dH);
        let s = interp2D(this.sup.s, P, dH);
        const mu = interp2D(this.sup.mu, P, dH);
        const k = interp2D(this.sup.k, P, dH);
        const Cp = Math.max(0.2, interp2D(this.sup.Cp, P, dH));
        if (dH > dHMax) {
          // 고온 토출 등 과열 상한 초과 시 이상기체/Cp 연속 외삽 (뉴턴 미분 연속성 보존) + 범위 경고
          outOfRange = true;
          const extra = dH - dHMax;
          const T_edge_K = T + 273.15;
          const dT = extra / Cp;
          T += dT;
          rho = rho * (T_edge_K / Math.max(200, T + 273.15));
          s += extra / Math.max(200, 0.5 * (T_edge_K + T + 273.15));
          this._warn(`${this.name} 과열 영역 Δh=${dH.toFixed(1)} kJ/kg 초과 (상한 ${dHMax}, 외삽 적용)`);
        }
        return {
          P, T, h, rho, s, mu, k, Cp,
          x: 1, phase: "과열증기", SC: 0, SH: Math.max(0, T - sat.T_sat), T_sat: sat.T_sat, outOfRange
        };
      }
      const x = Math.min(1, Math.max(0, (h - sat.h_f) / (sat.h_g - sat.h_f || 1e-9)));
      return {
        P, T: sat.T_sat, h, rho: 1 / ((1 - x) / sat.rho_f + x / sat.rho_g),
        s: sat.s_f + x * (sat.s_g - sat.s_f), mu: sat.mu_f + x * (sat.mu_g - sat.mu_f),
        k: sat.k_f + x * (sat.k_g - sat.k_f), Cp: sat.Cp_f + x * (sat.Cp_g - sat.Cp_f),
        x, phase: "포화 (2상)", SC: 0, SH: 0, T_sat: sat.T_sat, outOfRange
      };
    }

    solvePT(P, T) {
      if (this.kind !== "two_phase") {
        const st = this.evalSinglePhase(T, P);
        return { ...st, x: 1, phase: "단상", SC: 0, SH: 0, T_sat: T };
      }
      const sat = this.getSatAtP(P);
      if (Math.abs(T - sat.T_sat) < 1e-3) return this.evalPH(P, sat.h_g);
      if (T < sat.T_sat) {
        const dHMax = this.sub.T.dH[this.sub.T.dH.length - 1];
        const tEdge = interp2D(this.sub.T, P, dHMax);
        if (T < tEdge) {
          const cpEdge = Math.max(0.2, interp2D(this.sub.Cp, P, dHMax));
          return this.evalPH(P, sat.h_f - (dHMax + (tEdge - T) * cpEdge));
        }
        let lo = 0, hi = dHMax;
        for (let i = 0; i < 42; i++) { const m = (lo + hi) / 2; if (interp2D(this.sub.T, P, m) > T) lo = m; else hi = m; }
        return this.evalPH(P, sat.h_f - (lo + hi) / 2);
      } else {
        const dHMax = this.sup.T.dH[this.sup.T.dH.length - 1];
        const tEdge = interp2D(this.sup.T, P, dHMax);
        if (T > tEdge) {
          const cpEdge = Math.max(0.2, interp2D(this.sup.Cp, P, dHMax));
          return this.evalPH(P, sat.h_g + (dHMax + (T - tEdge) * cpEdge));
        }
        let lo = 0, hi = dHMax;
        for (let i = 0; i < 42; i++) { const m = (lo + hi) / 2; if (interp2D(this.sup.T, P, m) < T) lo = m; else hi = m; }
        return this.evalPH(P, sat.h_g + (lo + hi) / 2);
      }
    }

    solvePS(P, s) {
      if (this.kind !== "two_phase") {
        const st = this.evalSinglePhase(25, P);
        return { ...st, x: 1, phase: "단상", SC: 0, SH: 0, T_sat: 25 };
      }
      const sat = this.getSatAtP(P);
      if (s >= sat.s_f && s <= sat.s_g) {
        const x = (s - sat.s_f) / (sat.s_g - sat.s_f || 1e-9);
        return this.evalPH(P, sat.h_f + x * (sat.h_g - sat.h_f));
      }
      if (s < sat.s_f) {
        const dHMax = this.sub.s.dH[this.sub.s.dH.length - 1];
        let lo = 0, hi = dHMax;
        for (let i = 0; i < 42; i++) { const m = (lo + hi) / 2; if (interp2D(this.sub.s, P, m) > s) lo = m; else hi = m; }
        return this.evalPH(P, sat.h_f - (lo + hi) / 2);
      } else {
        const dHMax = this.sup.s.dH[this.sup.s.dH.length - 1];
        const sEdge = interp2D(this.sup.s, P, dHMax);
        if (s > sEdge) {
          const tEdgeK = interp2D(this.sup.T, P, dHMax) + 273.15;
          const extraH = (s - sEdge) * tEdgeK;
          return this.evalPH(P, sat.h_g + dHMax + extraH);
        }
        let lo = 0, hi = dHMax;
        for (let i = 0; i < 42; i++) { const m = (lo + hi) / 2; if (interp2D(this.sup.s, P, m) < s) lo = m; else hi = m; }
        return this.evalPH(P, sat.h_g + (lo + hi) / 2);
      }
    }

    // Zivi 기공률 기반 2상 평균 밀도 (냉매 충전량/질량보존 계산용)
    voidFractionDensity(P, x) {
      if (this.kind !== "two_phase") return this.evalSinglePhase(25, P).rho;
      const sat = this.getSatAtP(P);
      const xc = Math.min(1, Math.max(0, x));
      if (xc <= 1e-5) return sat.rho_f;
      if (xc >= 1 - 1e-5) return sat.rho_g;
      const slip = Math.pow(sat.rho_f / Math.max(0.1, sat.rho_g), 1 / 3);
      const alpha = 1 / (1 + ((1 - xc) / xc) * (sat.rho_g / sat.rho_f) * slip);
      return alpha * sat.rho_g + (1 - alpha) * sat.rho_f;
    }

    buildIsolines(tStep = 10, rhoList = [5, 10, 20, 40, 80, 150, 300]) {
      const Ps = this.sat.P, Ts = this.sat.T_sat, pMin = Ps[0], pMax = Ps[Ps.length - 1];
      const isotherms = [];
      const tMin = Math.ceil(Ts[0] / tStep) * tStep, tMax = Math.floor((Ts[Ts.length - 1] + 50) / tStep) * tStep;
      for (let T = tMin; T <= tMax && isotherms.length < 30; T += tStep) {
        const pts = [], inSat = T >= Ts[0] && T <= Ts[Ts.length - 1], pSat = inSat ? this.pSatBar(T) : null;
        if (inSat) { const s = this.getSatAtP(pSat); pts.push({ h: s.h_f, P: pSat }, { h: s.h_g, P: pSat }); }
        const pSupStart = inSat ? pSat * 0.99 : pMax;
        if (pSupStart > pMin) {
          for (let i = 0; i <= 12; i++) {
            const P = pSupStart * Math.pow(pMin / pSupStart, i / 12), sat = this.getSatAtP(P);
            if (T > sat.T_sat) {
              let lo = 0, hi = this.sup.T.dH[this.sup.T.dH.length - 1];
              if (interp2D(this.sup.T, P, hi) >= T) {
                for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (interp2D(this.sup.T, P, m) < T) lo = m; else hi = m; }
                pts.push({ h: sat.h_g + (lo + hi) / 2, P });
              }
            }
          }
        }
        if (pts.length >= 2) isotherms.push({ T, pts });
      }
      const isobars = [];
      [1, 2, 3, 5, 8, 12, 16, 20, 25, 30, 40, 50].filter(p => p >= pMin && p <= pMax).forEach(P => {
        const sat = this.getSatAtP(P), pts = [];
        const dHsub = this.sub.T.dH[this.sub.T.dH.length - 1], dHsup = this.sup.T.dH[this.sup.T.dH.length - 1];
        for (let i = 5; i >= 1; i--) pts.push({ s: interp2D(this.sub.s, P, dHsub * i / 5), T: interp2D(this.sub.T, P, dHsub * i / 5) });
        pts.push({ s: sat.s_f, T: sat.T_sat }, { s: sat.s_g, T: sat.T_sat });
        for (let i = 1; i <= 7; i++) pts.push({ s: interp2D(this.sup.s, P, dHsup * i / 7), T: interp2D(this.sup.T, P, dHsup * i / 7) });
        isobars.push({ P, pts });
      });
      const isochores = [];
      const pGrid = []; for (let i = 0; i <= 20; i++) pGrid.push(pMin * Math.pow(pMax / pMin, i / 20));
      rhoList.forEach(rhoT => {
        const pts = [];
        pGrid.forEach(P => {
          const sat = this.getSatAtP(P); let hVal = null;
          if (rhoT >= sat.rho_g && rhoT <= sat.rho_f) {
            const x = (1 / rhoT - 1 / sat.rho_f) / (1 / sat.rho_g - 1 / sat.rho_f || 1e-12);
            hVal = sat.h_f + x * (sat.h_g - sat.h_f);
          } else if (rhoT < sat.rho_g) {
            let lo = 0, hi = this.sup.rho.dH[this.sup.rho.dH.length - 1];
            if (interp2D(this.sup.rho, P, hi) <= rhoT) {
              for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (interp2D(this.sup.rho, P, m) > rhoT) lo = m; else hi = m; }
              hVal = sat.h_g + (lo + hi) / 2;
            }
          }
          if (hVal !== null) { const st = this.evalPH(P, hVal); pts.push({ h: st.h, P: st.P, s: st.s, T: st.T }); }
        });
        if (pts.length >= 2) isochores.push({ rho: rhoT, pts });
      });
      this.resetWarnings();
      return { isotherms, isobars, isochores };
    }
  }

  global.FluidPropModule = { FLUID_DB_VERSION, TABLE_KEYS, FluidTable, buildDefaultR134aRaw, getDefaultFluidDB };
})(window);
