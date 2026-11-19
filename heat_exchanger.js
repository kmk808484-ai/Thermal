// heat_exchanger.js — 통합 열교환기 모듈 (응축/증발 자동판별 + UA / NTU / 상관식)
(function (global) {
  const CP_AIR = 1.005;

  function run(inS, params, refProp) {
    const f = refProp.getConst();
    const P_out = Math.max(0.5, inS.P_bar - (params.dP_bar || 0));
    const T_sat_out = refProp.tSatC(P_out);
    const C_air = Math.max(0.01, (params.m_air_kgs || 1.0) * CP_AIR);

    let NTU = 1.0;
    let UA_eff = 1.0;
    let h_ref_Wm2K = 0;

    if (params.method === "NTU") {
      NTU = Math.max(0.05, params.NTU_val || 1.2);
      UA_eff = NTU * C_air;
    } else if (params.method === "CORR") {
      const Dh = Math.max(0.001, (params.Dh_mm || 6.0) * 1e-3);
      const A_cross = Math.max(1e-5, (Math.PI * Dh * Dh) / 4 * 8);
      const mu = 1.8e-4;
      const k_cond = 0.085;
      const Pr = 3.2;

      const G = Math.max(1.0, inS.m_dot / A_cross);
      const Re = (G * Dh) / mu;
      const C = params.corr_C || 0.023;
      const m = params.corr_m || 0.8;
      const n = params.corr_n || 0.4;

      const Nu = C * Math.pow(Re, m) * Math.pow(Pr, n);
      h_ref_Wm2K = (Nu * k_cond) / Dh;
      const h_air = Math.max(5, params.h_air_Wm2K || 80);
      const U_Wm2K = 1 / (1 / Math.max(10, h_ref_Wm2K) + 1 / h_air);
      UA_eff = (U_Wm2K * Math.max(0.05, params.area_m2 || 12.0)) / 1000;
      NTU = UA_eff / C_air;
    } else {
      UA_eff = Math.max(0.01, params.UA_kWK || 1.2);
      NTU = UA_eff / C_air;
    }

    const effectiveness = 1 - Math.exp(-NTU);
    const isCondenser = inS.T_sat_C >= params.T_air_in;
    const role = isCondenser ? "응축기 (방열)" : "증발기 (흡열)";
    const dT_drive = Math.abs(inS.T_sat_C - params.T_air_in);
    const Q_kW = effectiveness * C_air * dT_drive;

    const m_ref = Math.max(1e-5, inS.m_dot);
    const h_out = isCondenser ? (inS.h_kJkg - Q_kW / m_ref) : (inS.h_kJkg + Q_kW / m_ref);

    const h_g = refProp.hgKJ(T_sat_out);
    const h_f = h_g - f.h_fg;

    let T_out = T_sat_out, phase = "2상", quality = 0.5, SC = 0, SH = 0;

    if (h_out > h_g) {
      phase = isCondenser ? "과열 (응축부족)" : "과열 증기";
      quality = 1.0;
      SH = (h_out - h_g) / (f.cp_v / 1000);
      T_out = isCondenser ? (T_sat_out + SH) : Math.min(params.T_air_in - 0.5, T_sat_out + SH);
      SH = Math.max(0, T_out - T_sat_out);
    } else if (h_out < h_f) {
      phase = "과냉 액체";
      quality = 0.0;
      SC = (h_f - h_out) / (f.cp_l / 1000);
      T_out = isCondenser ? Math.max(params.T_air_in + 0.5, T_sat_out - SC) : (T_sat_out - SC);
      SC = Math.max(0, T_sat_out - T_out);
    } else {
      phase = isCondenser ? "2상 (응축 중)" : "2상 (증발 중)";
      quality = (h_out - h_f) / (f.h_fg || 1);
      T_out = T_sat_out;
    }

    const T_air_out = isCondenser ? (params.T_air_in + Q_kW / C_air) : (params.T_air_in - Q_kW / C_air);

    return {
      inlet: inS,
      outlet: {
        fluid: inS.fluid,
        P_bar: P_out,
        T_C: T_out,
        h_kJkg: h_out,
        m_dot: inS.m_dot,
        T_sat_C: T_sat_out,
        SC,
        SH
      },
      metrics: {
        role, isCondenser, method: params.method || "UA",
        Q_kW, UA_eff, NTU, effectiveness, h_ref_Wm2K,
        T_air_out, phase, quality, SC, SH, dP_bar: params.dP_bar || 0
      }
    };
  }

  global.HXModule = { run };
})(window);