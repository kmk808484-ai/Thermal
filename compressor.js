// compressor.js
(function (global) {
  const FLUID_CONST = {
    R134a:   { cp_v: 850, cp_l: 1420, h_fg: 165, k: 1.12, R: 81.49 },
    R410A:   { cp_v: 840, cp_l: 1800, h_fg: 170, k: 1.17, R: 114.6 },
    R1234yf: { cp_v: 900, cp_l: 1380, h_fg: 145, k: 1.09, R: 72.90 },
    R32:     { cp_v: 820, cp_l: 1950, h_fg: 240, k: 1.24, R: 159.8 }
  };

  const FLUID_CSV_PRESETS = {
    R134a: [
      "T_C,P_sat_bar,h_g_kJkg",
      "-20,1.327,386.6", "-10,2.006,392.7", "0,2.928,398.6",
      "10,4.146,404.2", "20,5.717,409.7", "30,7.702,414.9",
      "40,10.166,419.4", "50,13.179,423.4", "60,16.818,426.4", "70,21.168,428.0"
    ].join("\n"),
    R410A: [
      "T_C,P_sat_bar,h_g_kJkg",
      "-20,3.996,412.8", "-10,5.731,417.5", "0,7.987,421.7",
      "10,10.857,425.2", "20,14.442,427.8", "30,18.851,429.1",
      "40,24.207,428.6", "50,30.652,425.3", "60,38.369,417.3"
    ].join("\n"),
    R1234yf: [
      "T_C,P_sat_bar,h_g_kJkg",
      "-20,1.510,350.2", "-10,2.218,356.7", "0,3.158,363.2",
      "10,4.375,369.5", "20,5.917,375.6", "30,7.835,381.4",
      "40,10.184,386.8", "50,13.022,391.4", "60,16.415,394.9"
    ].join("\n"),
    R32: [
      "T_C,P_sat_bar,h_g_kJkg",
      "-20,4.060,504.3", "-10,5.830,510.1", "0,8.131,515.1",
      "10,11.069,519.1", "20,14.746,521.8", "30,19.275,522.9",
      "40,24.783,521.7", "50,31.412,517.2", "60,39.332,507.4"
    ].join("\n")
  };

  const DEFAULT_EFF_CSV = {
    is: "PR,RPM,efficiency\n2.0,1500,0.74\n2.0,3000,0.79\n2.0,5000,0.75\n3.5,1500,0.78\n3.5,3000,0.84\n3.5,5000,0.80\n6.0,1500,0.70\n6.0,3000,0.76\n6.0,5000,0.71",
    vol: "PR,RPM,efficiency\n2.0,1500,0.89\n2.0,3000,0.92\n2.0,5000,0.87\n3.5,1500,0.84\n3.5,3000,0.88\n3.5,5000,0.83\n6.0,1500,0.75\n6.0,3000,0.79\n6.0,5000,0.74",
    mech: "PR,RPM,efficiency\n2.0,1500,0.90\n2.0,3000,0.93\n2.0,5000,0.91\n3.5,1500,0.91\n3.5,3000,0.94\n3.5,5000,0.92\n6.0,1500,0.89\n6.0,3000,0.92\n6.0,5000,0.90"
  };

  function extractRows(text) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const cols = /[,\t;]/.test(line)
        ? (line.match(/(".*?"|[^,\t;]+)(?=\s*[,\t;]|\s*$)/g) || [])
        : line.split(/\s+/);
      const nums = cols
        .map(c => c.replace(/^"|"$/g, "").replace(/,/g, "").replace(/%/g, "").trim())
        .map(Number)
        .filter(n => !Number.isNaN(n));
      if (nums.length >= 3) rows.push(nums);
    }
    return rows;
  }

  function solvePoly2(xs, ys) {
    let s0 = xs.length, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i], x2 = x * x;
      s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
      b0 += y; b1 += x * y; b2 += x2 * y;
    }
    const M = [[s0, s1, s2, b0], [s1, s2, s3, b1], [s2, s3, s4, b2]];
    for (let i = 0; i < 3; i++) {
      let maxR = i;
      for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[maxR][i])) maxR = k;
      [M[i], M[maxR]] = [M[maxR], M[i]];
      for (let k = i + 1; k < 3; k++) {
        const f = M[k][i] / (M[i][i] || 1e-12);
        for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j];
      }
    }
    const c = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
      let sum = M[i][3];
      for (let j = i + 1; j < 3; j++) sum -= M[i][j] * c[j];
      c[i] = sum / (M[i][i] || 1e-12);
    }
    return c;
  }

  class EfficiencyMap2D {
    constructor(csvText) {
      this.points = [];
      this.rawText = "";
      if (csvText) this.parseCSV(csvText);
    }
    parseCSV(text) {
      const rows = extractRows(text);
      if (rows.length < 2) throw new Error("PR, RPM, efficiency 3열 데이터가 최소 2행 필요합니다.");
      this.points = rows.map(r => ({
        pr: r[0],
        rpm: r[1],
        eff: Math.min(0.995, Math.max(0.05, r[2] > 1.5 ? r[2] / 100 : r[2]))
      }));
      this.rawText = text;
    }
    interpolate(pr, rpm) {
      const prs = this.points.map(p => p.pr), rpms = this.points.map(p => p.rpm);
      const minPr = Math.min(...prs), maxPr = Math.max(...prs);
      const minR = Math.min(...rpms), maxR = Math.max(...rpms);
      const outOfRange = pr < minPr || pr > maxPr || rpm < minR || rpm > maxR;
      const cPr = Math.min(maxPr, Math.max(minPr, pr));
      const cR = Math.min(maxR, Math.max(minR, rpm));
      const sPr = (maxPr - minPr) || 1, sR = (maxR - minR) || 1;
      let num = 0, den = 0;
      for (const p of this.points) {
        const d2 = Math.pow((cPr - p.pr) / sPr, 2) + Math.pow((cR - p.rpm) / sR, 2);
        if (d2 < 1e-10) return { eff: p.eff, outOfRange };
        const w = 1 / (d2 * d2);
        num += w * p.eff; den += w;
      }
      return { eff: num / den, outOfRange };
    }
  }

  class RefrigerantProp {
    constructor(fluid = "R134a") {
      this.fluid = fluid;
      this.points = [];
      this.pCoeff = [0, 0, 0];
      this.hCoeff = [0, 0, 0];
      this.parseCSV(FLUID_CSV_PRESETS[fluid] || FLUID_CSV_PRESETS.R134a);
    }
    parseCSV(text) {
      const rows = extractRows(text);
      if (rows.length < 3) throw new Error("물성치(T_C, P_bar, h_g)는 최소 3행 필요합니다.");
      this.points = rows.map(r => ({ T_C: r[0], P_bar: Math.max(0.01, r[1]), h_g: r[2] }))
                        .sort((a, b) => a.T_C - b.T_C);
      this.pCoeff = solvePoly2(this.points.map(p => 1000 / (p.T_C + 273.15)), this.points.map(p => Math.log(p.P_bar)));
      this.hCoeff = solvePoly2(this.points.map(p => p.T_C), this.points.map(p => p.h_g));
      this.rawText = text;
    }
    pSatBar(T_C) {
      const x = 1000 / (T_C + 273.15);
      return Math.exp(this.pCoeff[0] + this.pCoeff[1] * x + this.pCoeff[2] * x * x);
    }
    tSatC(P_bar) {
      let lo = -80, hi = 150;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (this.pSatBar(mid) < P_bar) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }
    hgKJ(T_C) { return this.hCoeff[0] + this.hCoeff[1] * T_C + this.hCoeff[2] * T_C * T_C; }
    getConst() { return FLUID_CONST[this.fluid] || FLUID_CONST.R134a; }
  }

  function run(params, maps, refProp) {
    const fConst = refProp.getConst();
    const P1_Pa = params.P1_bar * 1e5;
    const P2_Pa = Math.max(P1_Pa * 1.02, params.P2_bar * 1e5);
    const P2_bar = P2_Pa / 1e5;
    const PR = P2_Pa / P1_Pa;
    const T1_K = params.T1_C + 273.15;

    const T_evap_C = refProp.tSatC(params.P1_bar);
    const T_cond_C = refProp.tSatC(P2_bar);
    const SH1 = params.T1_C - T_evap_C;

    const rIs = maps.is.interpolate(PR, params.rpm);
    const rVol = maps.vol.interpolate(PR, params.rpm);
    const rMech = maps.mech.interpolate(PR, params.rpm);

    const rho1 = P1_Pa / (fConst.R * T1_K);
    const m_dot = rho1 * (params.vd_cc * 1e-6) * (params.rpm / 60) * rVol.eff;
    const T2s_K = T1_K * Math.pow(PR, (fConst.k - 1) / fConst.k);
    const T2_K = T1_K + (T2s_K - T1_K) / rIs.eff;
    const T2_C = T2_K - 273.15;
    const SH2 = T2_C - T_cond_C;

    const h1 = refProp.hgKJ(T_evap_C) + (fConst.cp_v / 1000) * Math.max(0, SH1);
    const dh = (fConst.cp_v / 1000) * (T2_K - T1_K);
    const h2 = h1 + dh;
    const W_gas_kW = m_dot * dh;
    const W_shaft_kW = W_gas_kW / rMech.eff;

    return {
      inlet:  { fluid: params.fluid, P_bar: params.P1_bar, T_C: params.T1_C, h_kJkg: h1, m_dot, T_sat_C: T_evap_C, SH: SH1 },
      outlet: { fluid: params.fluid, P_bar: P2_bar,        T_C: T2_C,        h_kJkg: h2, m_dot, T_sat_C: T_cond_C, SH: SH2 },
      metrics: {
        PR, rho1, T2s_C: T2s_K - 273.15, dh, W_gas_kW, W_shaft_kW,
        eff_is: rIs.eff, eff_vol: rVol.eff, eff_mech: rMech.eff,
        outOfRange: rIs.outOfRange || rVol.outOfRange || rMech.outOfRange
      }
    };
  }

  global.CompressorModule = {
    FLUID_CONST,
    FLUID_CSV_PRESETS,
    DEFAULT_EFF_CSV,
    EfficiencyMap2D,
    RefrigerantProp,
    run
  };
})(window);