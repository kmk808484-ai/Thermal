// receiver.js — 어큐뮬레이터(기본) / 고압 액 리시버 모듈 (지름 D · 높이 H → 체적 자동계산 + 액위/충전량 버퍼링 + 모멘텀 ΔP)
(function (global) {
  function calcVolumeL(params) {
    const D = Math.max(20, params.diam_mm || 90);
    const H = Math.max(40, params.height_mm || 200);
    return (Math.PI * D * D / 4 * H) / 1e6; // mm³ -> L
  }

  function run(inS, params, refProp, assignedMassKg = null) {
    const recType = params.rec_type || "suction";
    const diam_mm = Math.max(20, params.diam_mm || 90);
    const height_mm = Math.max(40, params.height_mm || 200);
    const vol_L = calcVolumeL({ diam_mm, height_mm });
    const vol_m3 = Math.max(1e-4, vol_L * 1e-3);

    // 모멘텀 기반 입출구 노즐 압력강하 (내경 12mm 기준 국부손실 K=1.5)
    const A_port = Math.PI * Math.pow(0.012, 2) / 4;
    const v_in = inS.m_dot / Math.max(0.5, (inS.rho || 30) * A_port);
    const dP_dyn_bar = (1.5 * 0.5 * (inS.rho || 30) * v_in * v_in) / 1e5;
    const dP_bar = Math.max(params.dP_bar ?? 0.03, dP_dyn_bar);
    const P_out = Math.max(0.5, inS.P_bar - dP_bar);

    const sat = refProp.kind === "two_phase" ? refProp.getSatAtP(P_out) : null;
    const Q_loss = params.Q_loss_kW || 0;
    const m_ref = Math.max(1e-5, inS.m_dot);
    let h_out = inS.h_kJkg - Q_loss / m_ref;

    let mass_min_kg = vol_m3 * (inS.rho || 10);
    let mass_max_kg = mass_min_kg;
    let level_pct = 35;
    let mass_kg = mass_min_kg;
    let state_desc = "정상 버퍼링";

    if (sat) {
      mass_min_kg = vol_m3 * sat.rho_g;
      mass_max_kg = vol_m3 * sat.rho_f;

      if (assignedMassKg !== null && Number.isFinite(assignedMassKg)) {
        const clamped = Math.max(mass_min_kg, Math.min(mass_max_kg, assignedMassKg));
        level_pct = ((clamped - mass_min_kg) / Math.max(1e-6, mass_max_kg - mass_min_kg)) * 100;
        mass_kg = clamped;

        if (assignedMassKg > mass_max_kg * 1.005) {
          state_desc = "만충 (과충전)";
          level_pct = 100;
        } else if (assignedMassKg < mass_min_kg * 0.995) {
          state_desc = "고갈 (충전량 부족)";
          level_pct = 0;
        }
      } else {
        const stTmp = refProp.evalPH(P_out, h_out);
        level_pct = recType === "high_pressure"
          ? (stTmp.SC > 0.5 ? 65 : (1 - stTmp.x) * 60 + 10)
          : (stTmp.SH > 0.5 ? 25 : (1 - stTmp.x) * 45 + 20);
        level_pct = Math.max(5, Math.min(95, level_pct));
        mass_kg = mass_min_kg + (level_pct / 100) * (mass_max_kg - mass_min_kg);
      }

      // 기액 분리 거동: 어큐뮬레이터는 상부 증기 출구(액압축 방지), 고압 리시버는 바닥 액 출구
      if (recType === "high_pressure" && level_pct > 2 && level_pct < 99 && h_out > sat.h_f && h_out < sat.h_g) {
        h_out = sat.h_f;
      } else if (recType === "suction" && level_pct < 98 && h_out < sat.h_g && h_out > sat.h_f) {
        h_out = sat.h_g;
      }
    }

    const stOut = refProp.evalPH(P_out, h_out);

    return {
      inlet: inS,
      outlet: {
        fluid: inS.fluid, P_bar: P_out, T_C: stOut.T, h_kJkg: stOut.h, s_kJkgK: stOut.s,
        rho: stOut.rho, mu: stOut.mu, k: stOut.k, Cp: stOut.Cp, m_dot: inS.m_dot,
        T_sat_C: stOut.T_sat, SC: stOut.SC, SH: stOut.SH, quality: stOut.x
      },
      metrics: {
        rec_type: recType,
        role: recType === "high_pressure" ? "고압 액 리시버" : "저압 어큐뮬레이터",
        diam_mm, height_mm, vol_L, dP_bar,
        mass_kg, mass_min_kg, mass_max_kg, level_pct, state_desc, phase: stOut.phase
      }
    };
  }

  global.ReceiverModule = { run, calcVolumeL };
})(window);
