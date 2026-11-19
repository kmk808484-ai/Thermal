// expansion_valve.js — 팽창밸브(TXV/EEV) 계산 모듈
(function (global) {
  function run(inS, params, refProp) {
    const P_out = Math.min(inS.P_bar * 0.96, Math.max(0.5, params.P_out_bar));
    const T_evap = refProp.tSatC(P_out);
    const f = refProp.getConst();

    const h_out = inS.h_kJkg;
    const h_g = refProp.hgKJ(T_evap);
    const h_f = h_g - f.h_fg;
    const quality = Math.min(1.0, Math.max(0.0, (h_out - h_f) / (f.h_fg || 1)));

    return {
      inlet: inS,
      outlet: {
        fluid: inS.fluid,
        P_bar: P_out,
        T_C: T_evap,
        h_kJkg: h_out,
        m_dot: inS.m_dot,
        T_sat_C: T_evap,
        quality
      },
      metrics: {
        dP_bar: inS.P_bar - P_out,
        quality,
        T_evap
      }
    };
  }

  global.ValveModule = { run };
})(window);