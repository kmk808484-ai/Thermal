// compressor.js — 실제 냉매 물성치(FluidTable) 기반 압축기 계산 모듈
// 개선: 쌍선형(Bilinear) 효율맵 보간(IDW 평탄점 제거), 쉘 열손실 f_Q, 모터효율 η_motor, 액흡입 보호, AHRI 540 10계수 맵 옵션 + Dabiri-Rice SH 보정
(function (global) {
  const DEFAULT_EFF_CSV = {
    is: "PR,RPM,efficiency\n2.0,1500,0.74\n2.0,3000,0.79\n2.0,5000,0.75\n3.5,1500,0.78\n3.5,3000,0.84\n3.5,5000,0.80\n6.0,1500,0.70\n6.0,3000,0.76\n6.0,5000,0.71",
    vol: "PR,RPM,efficiency\n2.0,1500,0.89\n2.0,3000,0.92\n2.0,5000,0.87\n3.5,1500,0.84\n3.5,3000,0.88\n3.5,5000,0.83\n6.0,1500,0.75\n6.0,3000,0.79\n6.0,5000,0.74",
    mech: "PR,RPM,efficiency\n2.0,1500,0.90\n2.0,3000,0.93\n2.0,5000,0.91\n3.5,1500,0.91\n3.5,3000,0.94\n3.5,5000,0.92\n6.0,1500,0.89\n6.0,3000,0.92\n6.0,5000,0.90"
  };

  // AHRI 540 10계수 예시 (R134a 3000 RPM 기준 120cc 스크롤 근사, 단위: m_dot [kg/s], P_elec [kW], S=T_evap[°C], D=T_cond[°C])
  const DEFAULT_AHRI540 = {
    rated_rpm: 3000,
    rated_SH_K: 11.1,
    F_sh: 0.75,
    // C1..C10 for m_dot [kg/s]
    c_mass: [0.072, 0.0028, -0.00018, 3.8e-5, -1.2e-5, 1.5e-6, 1.5e-7, -1.0e-7, 4.0e-8, -5.0e-9],
    // C1..C10 for W_elec [kW]
    c_pow:  [0.85, -0.015, 0.032, -3.5e-4, 4.2e-4, 4.5e-4, -1.0e-6, 5.0e-6, -2.0e-6, 2.5e-6]
  };

  function evalAhri10(c, S, D) {
    return c[0] + c[1] * S + c[2] * D + c[3] * S * S + c[4] * S * D + c[5] * D * D
      + c[6] * S * S * S + c[7] * S * S * D + c[8] * S * D * D + c[9] * D * D * D;
  }

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
    constructor(csvText) {
      this.points = [];
      this.rawText = "";
      this.grid = null; // 정규 격자일 경우 쌍선형 보간 캐시
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
      this._buildRectGrid();
    }

    _buildRectGrid() {
      this.grid = null;
      const uniqPr = [...new Set(this.points.map(p => p.pr))].sort((a, b) => a - b);
      const uniqRpm = [...new Set(this.points.map(p => p.rpm))].sort((a, b) => a - b);
      if (uniqPr.length < 2 || uniqRpm.length < 2) return;
      if (uniqPr.length * uniqRpm.length !== this.points.length) return;
      const table = uniqPr.map(() => new Array(uniqRpm.length).fill(null));
      for (const p of this.points) {
        const i = uniqPr.indexOf(p.pr), j = uniqRpm.indexOf(p.rpm);
        if (i < 0 || j < 0 || table[i][j] !== null) return;
        table[i][j] = p.eff;
      }
      this.grid = { prs: uniqPr, rpms: uniqRpm, table };
    }

    interpolate(pr, rpm) {
      const prs = this.points.map(p => p.pr), rpms = this.points.map(p => p.rpm);
      const minPr = Math.min(...prs), maxPr = Math.max(...prs), minR = Math.min(...rpms), maxR = Math.max(...rpms);
      const outOfRange = pr < minPr || pr > maxPr || rpm < minR || rpm > maxR;
      const cPr = Math.min(maxPr, Math.max(minPr, pr)), cR = Math.min(maxR, Math.max(minR, rpm));

      // 정규 (PR × RPM) 격자: 쌍선형 보간(Bilinear)으로 격자점 평탄점(기울기 0) 제거!
      if (this.grid) {
        const { prs: gPr, rpms: gRpm, table } = this.grid;
        let i0 = 0, i1 = gPr.length - 1;
        while (i1 - i0 > 1) { const m = (i0 + i1) >> 1; if (gPr[m] <= cPr) i0 = m; else i1 = m; }
        let j0 = 0, j1 = gRpm.length - 1;
        while (j1 - j0 > 1) { const m = (j0 + j1) >> 1; if (gRpm[m] <= cR) j0 = m; else j1 = m; }
        const u = (cPr - gPr[i0]) / (gPr[i1] - gPr[i0] || 1e-12);
        const v = (cR - gRpm[j0]) / (gRpm[j1] - gRpm[j0] || 1e-12);
        const f0 = table[i0][j0] + v * (table[i0][j1] - table[i0][j0]);
        const f1 = table[i1][j0] + v * (table[i1][j1] - table[i1][j0]);
        return { eff: f0 + u * (f1 - f0), outOfRange, method: "bilinear" };
      }

      // 비정규 산점 데이터: 부드러운 IDW (p=2, 정규화 ε 포함)
      const sPr = (maxPr - minPr) || 1, sR = (maxR - minR) || 1;
      let num = 0, den = 0;
      for (const p of this.points) {
        const d2 = Math.pow((cPr - p.pr) / sPr, 2) + Math.pow((cR - p.rpm) / sR, 2);
        if (d2 < 1e-10) return { eff: p.eff, outOfRange, method: "idw" };
        const w = 1 / (d2 + 1e-6); num += w * p.eff; den += w;
      }
      return { eff: num / den, outOfRange, method: "idw" };
    }
  }

  function run(params, maps, refProp) {
    const P1 = Math.max(0.5, params.P1_bar);
    const P2 = Math.max(P1 * 1.02, params.P2_bar);
    const PR = P2 / P1;
    const f_Q = Math.min(0.35, Math.max(0, params.f_Q !== undefined ? Number(params.f_Q) : 0.05));
    const eta_motor = Math.min(1.0, Math.max(0.5, params.eta_motor !== undefined ? Number(params.eta_motor) : 0.92));
    const compModel = params.comp_model || "eff_map"; // "eff_map" | "ahri540"

    // 1. 실제 물성치로 흡입 상태 계산 (폐회로 h1 피드백 시 P-h로 직접 평가)
    const st1 = (params.h1_override !== undefined && params.h1_override !== null && Number.isFinite(params.h1_override))
      ? refProp.evalPH(P1, params.h1_override)
      : refProp.solvePT(P1, params.T1_C);

    // 2. 액흡입(Liquid Slugging) 판정 및 밀도 폭증 방지 보호
    const sat1 = refProp.kind === "two_phase" ? refProp.getSatAtP(P1) : null;
    const liquidSuction = !!(sat1 && st1.x < 0.999);
    let rho_eff = st1.rho;
    if (liquidSuction && sat1) {
      // 2상/액 흡입 시 유량 폭증(6.8 kg/s 등) 방지하면서 뉴턴 미분 연속성 유지
      rho_eff = sat1.rho_g * (1 + 0.25 * (1 - Math.max(0, st1.x)));
    }

    const rIs = maps.is.interpolate(PR, params.rpm);
    const rVol = maps.vol.interpolate(PR, params.rpm);
    const rMech = maps.mech.interpolate(PR, params.rpm);

    let m_dot, W_gas_kW, W_shaft_kW, W_elec_kW, Q_shell_kW, W_gas_net_kW, dh, st2s, st2;
    let eff_is = rIs.eff, eff_vol = rVol.eff, eff_mech = rMech.eff;

    st2s = refProp.solvePS(P2, st1.s);
    const dh_s = Math.max(0.1, st2s.h - st1.h);

    if (compModel === "ahri540" && sat1) {
      // AHRI 540 10계수 맵 + Dabiri-Rice 흡입 과열도 밀도 보정
      const ahri = params.ahri540 || DEFAULT_AHRI540;
      const S = sat1.T_sat;
      const D = refProp.tSatC(P2);
      const rpmRatio = Math.max(0.2, (params.rpm || 3000) / (ahri.rated_rpm || 3000));
      const stRated = refProp.solvePT(P1, S + (ahri.rated_SH_K || 11.1));
      const m_rated = Math.max(0.005, evalAhri10(ahri.c_mass, S, D)) * rpmRatio;
      const F_sh = ahri.F_sh ?? 0.75;
      const corrSH = Math.max(0.5, 1 + F_sh * (rho_eff / Math.max(0.5, stRated.rho) - 1));
      m_dot = m_rated * corrSH;
      W_elec_kW = Math.max(0.05, evalAhri10(ahri.c_pow, S, D)) * rpmRatio;
      W_shaft_kW = W_elec_kW * eta_motor;
      W_gas_kW = W_shaft_kW * eff_mech;
      Q_shell_kW = f_Q * W_gas_kW;
      W_gas_net_kW = Math.max(0.01, W_gas_kW - Q_shell_kW);
      dh = W_gas_net_kW / Math.max(1e-5, m_dot);
      eff_is = Math.min(0.95, Math.max(0.2, (m_dot * dh_s) / Math.max(1e-5, W_gas_kW)));
      eff_vol = Math.min(0.99, Math.max(0.2, m_dot / Math.max(1e-6, rho_eff * (params.vd_cc * 1e-6) * (params.rpm / 60))));
      st2 = refProp.evalPH(P2, st1.h + dh);
    } else {
      m_dot = rho_eff * (params.vd_cc * 1e-6) * (params.rpm / 60) * eff_vol;
      const dh_total = dh_s / eff_is;
      W_gas_kW = m_dot * dh_total;
      Q_shell_kW = f_Q * W_gas_kW;
      W_gas_net_kW = W_gas_kW - Q_shell_kW;
      dh = (1 - f_Q) * dh_total; // 쉘 열손실(f_Q) 제외 후 냉매에 실제 전달된 엔탈피 증가
      st2 = refProp.evalPH(P2, st1.h + dh);
      W_shaft_kW = W_gas_kW / eff_mech;
      W_elec_kW = W_shaft_kW / eta_motor;
    }

    // 압축기 내부 공간 보유 냉매량 (배기량 2.5배 가정)
    const mass_kg = (params.vd_cc * 1e-6 * 2.5) * 0.5 * (st1.rho + st2.rho);

    return {
      inlet:  { fluid: params.fluid, P_bar: P1, T_C: st1.T, h_kJkg: st1.h, s_kJkgK: st1.s, rho: st1.rho, mu: st1.mu, k: st1.k, Cp: st1.Cp, m_dot, T_sat_C: st1.T_sat, SH: st1.SH, quality: st1.x },
      outlet: { fluid: params.fluid, P_bar: P2, T_C: st2.T, h_kJkg: st2.h, s_kJkgK: st2.s, rho: st2.rho, mu: st2.mu, k: st2.k, Cp: st2.Cp, m_dot, T_sat_C: st2.T_sat, SH: st2.SH, quality: st2.x },
      metrics: {
        comp_model: compModel,
        PR, rho1: st1.rho, rho_eff, T2s_C: st2s.T, dh,
        W_gas_kW, W_gas_net_kW, Q_shell_kW, f_Q,
        W_shaft_kW, W_elec_kW, eta_motor,
        mass_kg,
        eff_is, eff_vol, eff_mech,
        interpMethod: rIs.method || "bilinear",
        liquidSuction,
        suctionQuality: st1.x,
        outOfRange: rIs.outOfRange || rVol.outOfRange || rMech.outOfRange || !!st1.outOfRange || !!st2.outOfRange
      }
    };
  }

  global.CompressorModule = { DEFAULT_EFF_CSV, DEFAULT_AHRI540, EfficiencyMap2D, run };
})(window);
