// compressor.js — 실제 냉매 물성치(FluidTable) 기반 압축기 계산 모듈
(function (global) {
  const DEFAULT_EFF_CSV = {
    is: "PR,RPM,efficiency\n2.0,1500,0.74\n2.0,3000,0.79\n2.0,5000,0.75\n3.5,1500,0.78\n3.5,3000,0.84\n3.5,5000,0.80\n6.0,1500,0.70\n6.0,3000,0.76\n6.0,5000,0.71",
    vol: "PR,RPM,efficiency\n2.0,1500,0.89\n2.0,3000,0.92\n2.0,5000,0.87\n3.5,1500,0.84\n3.5,3000,0.88\n3.5,5000,0.83\n6.0,1500,0.75\n6.0,3000,0.79\n6.0,5000,0.74",
    mech: "PR,RPM,efficiency\n2.0,1500,0.90\n2.0,3000,0.93\n2.0,5000,0.91\n3.5,1500,0.91\n3.5,3000,0.94\n3.5,5000,0.92\n6.0,1500,0.89\n6.0,3000,0.92\n6.0,5000,0.90"
  };

  function extractRows(text) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const cols = /[,\t;]/.test(line) ? (line.match(/(".*?"|[^,\t;]+)(?=\s*[,\t;]|\s*$)/g) || []) : line.split(/\s+/);
      const nums = cols.map(c => c.replace(/^"|"$/g, "").replace(/,/g, "").replace(/%/g, "").trim()).map(Number).filter(n => !Number.isNaN(n));
      if (nums.length >= 3) rows.push(nums);
    }
    return rows;
  }

  class EfficiencyMap2D {
    constructor(csvText) { this.points = []; this.rawText = ""; if (csvText) this.parseCSV(csvText); }
    parseCSV(text) {
      const rows = extractRows(text);
      if (rows.length < 2) throw new Error("PR, RPM, efficiency 3열 데이터가 최소 2행 필요합니다.");
      this.points = rows.map(r => ({ pr: r[0], rpm: r[1], eff: Math.min(0.995, Math.max(0.05, r[2] > 1.5 ? r[2] / 100 : r[2])) }));
      this.rawText = text;
    }
    interpolate(pr, rpm) {
      const prs = this.points.map(p => p.pr), rpms = this.points.map(p => p.rpm);
      const minPr = Math.min(...prs), maxPr = Math.max(...prs), minR = Math.min(...rpms), maxR = Math.max(...rpms);
      const outOfRange = pr < minPr || pr > maxPr || rpm < minR || rpm > maxR;
      const cPr = Math.min(maxPr, Math.max(minPr, pr)), cR = Math.min(maxR, Math.max(minR, rpm));
      const sPr = (maxPr - minPr) || 1, sR = (maxR - minR) || 1;
      let num = 0, den = 0;
      for (const p of this.points) {
        const d2 = Math.pow((cPr - p.pr) / sPr, 2) + Math.pow((cR - p.rpm) / sR, 2);
        if (d2 < 1e-10) return { eff: p.eff, outOfRange };
        const w = 1 / (d2 * d2); num += w * p.eff; den += w;
      }
      return { eff: num / den, outOfRange };
    }
  }

  function run(params, maps, refProp) {
    const P1 = Math.max(0.5, params.P1_bar);
    const P2 = Math.max(P1 * 1.02, params.P2_bar);
    const PR = P2 / P1;

    // 1. 실제 물성치로 흡입 상태 계산 (폐회로 h1 피드백 시 P-h로 직접 평가해 열역학적 정합성 100% 유지)
    const st1 = (params.h1_override !== undefined && params.h1_override !== null && Number.isFinite(params.h1_override))
      ? refProp.evalPH(P1, params.h1_override)
      : refProp.solvePT(P1, params.T1_C);
    const rIs = maps.is.interpolate(PR, params.rpm);
    const rVol = maps.vol.interpolate(PR, params.rpm);
    const rMech = maps.mech.interpolate(PR, params.rpm);

    const m_dot = st1.rho * (params.vd_cc * 1e-6) * (params.rpm / 60) * rVol.eff;

    // 2. 등엔트로피 압축 (s2s = s1) -> 실제 토출 엔탈피 h2
    const st2s = refProp.solvePS(P2, st1.s);
    const dh_s = Math.max(0.1, st2s.h - st1.h);
    const dh = dh_s / rIs.eff;
    const h2 = st1.h + dh;
    const st2 = refProp.evalPH(P2, h2);

    const W_gas_kW = m_dot * dh;
    const W_shaft_kW = W_gas_kW / rMech.eff;
    // 압축기 내부 공간 보유 냉매량 (배기량 2.5배 가정)
    const mass_kg = (params.vd_cc * 1e-6 * 2.5) * 0.5 * (st1.rho + st2.rho);

    return {
      inlet:  { fluid: params.fluid, P_bar: P1, T_C: st1.T, h_kJkg: st1.h, s_kJkgK: st1.s, rho: st1.rho, mu: st1.mu, k: st1.k, Cp: st1.Cp, m_dot, T_sat_C: st1.T_sat, SH: st1.SH, quality: st1.x },
      outlet: { fluid: params.fluid, P_bar: P2, T_C: st2.T, h_kJkg: st2.h, s_kJkgK: st2.s, rho: st2.rho, mu: st2.mu, k: st2.k, Cp: st2.Cp, m_dot, T_sat_C: st2.T_sat, SH: st2.SH, quality: st2.x },
      metrics: {
        PR, rho1: st1.rho, T2s_C: st2s.T, dh, W_gas_kW, W_shaft_kW, mass_kg,
        eff_is: rIs.eff, eff_vol: rVol.eff, eff_mech: rMech.eff,
        outOfRange: rIs.outOfRange || rVol.outOfRange || rMech.outOfRange
      }
    };
  }

  global.CompressorModule = { DEFAULT_EFF_CSV, EfficiencyMap2D, run };
})(window);