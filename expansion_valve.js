// expansion_valve.js — 오리피스 지름(D→면적 자동계산) + 지름·Re 연동 가변 Cd + 초크 플로우(Choked Flow) + TXV 과열도 센서 피드백
(function (global) {
  function calcEffectiveCd(params, D_mm, rho_in, mu_uPas, m_dot, A_eff_m2, SC_K) {
    const cdBase = Math.max(0.15, Math.min(0.95, params.Cd || 0.65));
    const flowCorr = params.flow_corr || "re_diam_cd"; // "re_diam_cd" | "hem_choked" | "const_cd"
    if (flowCorr === "const_cd") return cdBase;

    // 오리피스 목 유속 및 직경 기준 레이놀즈수 Re_D
    const v_throat = m_dot / Math.max(1e-8, rho_in * A_eff_m2);
    const mu_Pas = Math.max(1e-6, (mu_uPas || 140) * 1e-6);
    const D_m = D_mm * 1e-3;
    const Re_D = Math.max(100, (rho_in * v_throat * D_m) / mu_Pas);

    // 지름(D) 변화에 따른 유량계수 보정 ( vena-contracta & L/D 효과 ) + Re_D 점성 보정 + 과냉도(SC) 보정
    const diamFactor = Math.pow(D_mm / 2.8, 0.14);
    const reFactor = 1 - 9.5 / Math.sqrt(Math.max(150, Re_D));
    const scFactor = 1 + 0.006 * Math.min(25, Math.max(0, SC_K || 0));
    return Math.min(0.92, Math.max(0.22, cdBase * diamFactor * reFactor * scFactor));
  }

  function calcChokePressureBar(inS, refProp) {
    // 입구 온도 기준 포화압력 P_sat(T_in) 및 과냉도 기반 2상 플래시 초크 임계압력 P_choke
    const P_in = inS.P_bar;
    const SC = Math.max(0, (inS.T_sat_C ?? inS.T_C) - inS.T_C);
    const P_sat_Tin = (refProp && refProp.kind === "two_phase") ? refProp.pSatBar(inS.T_C) : P_in * 0.7;
    const P_choke = Math.max(0.85, Math.min(P_in * 0.82, P_sat_Tin * (0.84 - 0.010 * Math.min(30, SC)) + 0.14 * P_in));
    return P_choke;
  }

  function run(inS, params, refProp, sensorFeedback = null) {
    const mode = params.valve_mode || "txv_sh"; // "txv_sh" | "orifice" | "fixed_p"
    const flowCorr = params.flow_corr || "re_diam_cd"; // "re_diam_cd" | "hem_choked" | "const_cd"
    const D_mm = Math.max(0.4, params.orifice_D_mm || 2.8);
    const A_max_mm2 = (Math.PI * D_mm * D_mm) / 4;
    const A_max_m2 = A_max_mm2 * 1e-6;
    const rho_in = Math.max(1.0, inS.rho || 1000);
    const m_dot = Math.max(1e-5, inS.m_dot);
    const SC_in = Math.max(0, (inS.T_sat_C ?? inS.T_C) - inS.T_C);

    const P_choke_bar = calcChokePressureBar(inS, refProp);
    let P_out, opening_pct, dP_bar, Cd_eff, is_choked = false, G_crit = null;
    let SH_meas = null;
    const sensor_connected = !!(sensorFeedback && sensorFeedback.connected);

    if (mode === "txv_sh") {
      const SH_target = params.SH_target_K ?? 6.0;
      const Kp = params.Kp_sh ?? 3.5;
      const openBase = params.open_base_pct ?? 50.0;
      SH_meas = sensor_connected ? sensorFeedback.SH : SH_target;
      opening_pct = Math.min(100, Math.max(8, openBase + Kp * (SH_meas - SH_target)));
      const A_eff = A_max_m2 * (opening_pct / 100);
      Cd_eff = calcEffectiveCd(params, D_mm, rho_in, inS.mu, m_dot, A_eff, SC_in);
      const dP_Pa = Math.pow(m_dot / (Cd_eff * A_eff), 2) / (2 * rho_in);
      dP_bar = Math.max(0.4, Math.min(inS.P_bar - 0.8, dP_Pa / 1e5));
      P_out = Math.max(0.8, inS.P_bar - dP_bar);
    } else if (mode === "orifice") {
      opening_pct = Math.min(100, Math.max(5, params.opening_pct ?? 50));
      const A_eff = A_max_m2 * (opening_pct / 100);
      Cd_eff = calcEffectiveCd(params, D_mm, rho_in, inS.mu, m_dot, A_eff, SC_in);
      const dP_Pa = Math.pow(m_dot / (Cd_eff * A_eff), 2) / (2 * rho_in);
      dP_bar = Math.max(0.4, Math.min(inS.P_bar - 0.8, dP_Pa / 1e5));
      P_out = Math.max(0.8, inS.P_bar - dP_bar);
    } else {
      P_out = Math.min(inS.P_bar * 0.96, Math.max(0.8, params.P_out_bar || 3.6));
      dP_bar = Math.max(0.05, inS.P_bar - P_out);
      Cd_eff = calcEffectiveCd(params, D_mm, rho_in, inS.mu, m_dot, A_max_m2 * 0.5, SC_in);
      const dP_eff_for_area = (flowCorr === "hem_choked" && P_out < P_choke_bar)
        ? Math.max(0.2, inS.P_bar - P_choke_bar)
        : dP_bar;
      const A_req = m_dot / (Cd_eff * Math.sqrt(2 * rho_in * dP_eff_for_area * 1e5));
      opening_pct = Math.min(100, Math.max(1, (A_req / A_max_m2) * 100));
    }

    // 초크 플로우(Choked Flow) 판정 및 임계 질량유속 계산
    const dP_choke_max = Math.max(0.3, inS.P_bar - P_choke_bar);
    G_crit = Cd_eff * Math.sqrt(2 * rho_in * dP_choke_max * 1e5); // kg/(m²·s)
    if (flowCorr === "hem_choked" && P_out <= P_choke_bar) {
      is_choked = true;
    }

    const A_eff_mm2 = A_max_mm2 * (opening_pct / 100);
    const m_choke_max = G_crit * (A_eff_mm2 * 1e-6);
    const stOut = refProp.evalPH(P_out, inS.h_kJkg);

    return {
      inlet: inS,
      outlet: {
        fluid: inS.fluid, P_bar: P_out, T_C: stOut.T, h_kJkg: stOut.h, s_kJkgK: stOut.s,
        rho: stOut.rho, mu: stOut.mu, k: stOut.k, Cp: stOut.Cp, m_dot: inS.m_dot,
        T_sat_C: stOut.T_sat, quality: stOut.x
      },
      metrics: {
        valve_mode: mode,
        flow_corr: flowCorr,
        orifice_D_mm: D_mm,
        A_max_mm2,
        A_eff_mm2,
        Cd_base: params.Cd || 0.65,
        Cd_eff,
        P_choke_bar,
        is_choked,
        m_choke_max,
        dP_bar,
        opening_pct,
        SH_meas,
        SH_target: params.SH_target_K ?? 6.0,
        sensor_connected,
        quality: stOut.x,
        T_evap: stOut.T,
        mass_kg: 0.002
      }
    };
  }

  global.ValveModule = { run, calcEffectiveCd, calcChokePressureBar };
})(window);
