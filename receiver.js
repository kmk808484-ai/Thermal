// receiver.js — 어큐뮬레이터(저압) / 고압 액 리시버 모듈
// 개선: 정상상태 강제 상분리(허위 에너지 생성) 제거 → h_out = h_in - Q_loss/m_dot 엄격 보존,
//       수동 충전량 모드에서 상태(P, h, x, SC, SH) 연동 물리 보유량 모델 적용 (충전량 ↔ 압력·과냉도 실제 결합)
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

    // 정상상태 제1법칙 엄격 보존: 축적항 dU/dt = 0 이므로 강제 상분리(h_f / h_g 치환) 금지!
    const sat = refProp.kind === "two_phase" ? refProp.getSatAtP(P_out) : null;
    const Q_loss_kW = Number(params.Q_loss_kW || 0);
    const m_ref = Math.max(1e-5, inS.m_dot);
    const h_out = inS.h_kJkg - Q_loss_kW / m_ref;
    const stOut = refProp.evalPH(P_out, h_out);

    let mass_min_kg = vol_m3 * (stOut.rho || 10);
    let mass_max_kg = mass_min_kg;
    let level_pct = 0;
    let mass_kg = mass_min_kg;
    let state_desc = "정상 통과";
    const warnings = [];

    if (sat) {
      mass_min_kg = vol_m3 * sat.rho_g;
      mass_max_kg = vol_m3 * sat.rho_f;
      const dMass = Math.max(1e-6, mass_max_kg - mass_min_kg);

      if (assignedMassKg !== null && Number.isFinite(assignedMassKg)) {
        // 자동 충전량 산정(auto) 모드: 목표 액위 기준으로 탱크 보유 질량 산정
        const clamped = Math.max(mass_min_kg, Math.min(mass_max_kg, assignedMassKg));
        level_pct = ((clamped - mass_min_kg) / dMass) * 100;
        mass_kg = clamped;

        if (assignedMassKg > mass_max_kg * 1.005) {
          state_desc = "만충 (과충전)";
          level_pct = 100;
        } else if (assignedMassKg < mass_min_kg * 0.995) {
          state_desc = "고갈 (충전량 부족)";
          level_pct = 0;
        } else {
          state_desc = "설계 액위 (자동 산정)";
        }
      } else {
        // 물리 기반 보유량 모델 (manual 충전량 구속 모드 — h_out에 대해 C¹ 단조 연속!)
        if (recType === "high_pressure") {
          // 고압 액 리시버: SC=0(포화액)에서 50% 버퍼, 과냉도 증가 시 100% 만충, 2상 유입 시 0% 고갈
          let lvFrac;
          if (stOut.x <= 1e-5) {
            lvFrac = 0.50 + 0.49 * Math.tanh(Math.max(0, stOut.SC) / 5.0);
          } else if (stOut.x < 1 - 1e-5) {
            const rhoZ = refProp.voidFractionDensity ? refProp.voidFractionDensity(P_out, stOut.x) : stOut.rho;
            const liqFracZ = Math.min(1, Math.max(0, (rhoZ - sat.rho_g) / Math.max(1e-6, sat.rho_f - sat.rho_g)));
            lvFrac = 0.50 * liqFracZ;
          } else {
            lvFrac = 0.0;
          }
          level_pct = Math.max(0, Math.min(100, lvFrac * 100));
          mass_kg = mass_min_kg + lvFrac * dMass;
          state_desc = level_pct > 92 ? "만충 근접 (과냉 과다)" : (level_pct < 8 ? "고갈 (플래시가스 유입)" : "정상 액 버퍼링");
        } else {
          // 저압 어큐뮬레이터 (수직 중력 기액분리 탱크):
          // 과열증기 영역에서는 열평형·응축액막 꼬리(exp(-SH/3.5))로 0%에 수렴,
          // 2상 유입 시 중력 침강(Gravity-settled pool)으로 액위가 부드럽게 상승(0%→100%)
          if (stOut.x >= 1 - 1e-5) {
            const residualLiq = 0.08 * Math.exp(-Math.max(0, stOut.SH) / 3.5);
            level_pct = residualLiq * 100;
            mass_kg = vol_m3 * (stOut.rho + residualLiq * Math.max(0, sat.rho_f - sat.rho_g));
            state_desc = level_pct < 2 ? "건조 증기 통과 (정상)" : "포화 근접 (소량 액체 체류)";
          } else if (stOut.x > 1e-5) {
            // 중력 침강 수직 탱크 액위 모델: 배관 Zivi보다 큰 액체 체류 (x=1에서 8%→x=0에서 100% 연속)
            const liqGrav = Math.pow(1 - stOut.x, 0.55);
            const lvFrac = Math.min(1, 0.08 + 0.92 * liqGrav);
            level_pct = lvFrac * 100;
            mass_kg = mass_min_kg + lvFrac * dMass;
            state_desc = "2상 체류 (액유입 주의)";
          } else {
            level_pct = 100;
            mass_kg = vol_m3 * stOut.rho;
            state_desc = "액 만충 (액압축 위험!)";
          }
        }
      }

      // 강제 상분리 대신 물리적 경고 플래그만 보고 (에너지 보존 100% 유지)
      if (recType === "suction" && stOut.x < 0.995) {
        warnings.push(`어큐뮬레이터 출구 2상/액체 상태 (x=${stOut.x.toFixed(3)}) — 액압축 위험, 충전량 또는 TXV 과열도 점검 필요`);
      } else if (recType === "high_pressure" && stOut.x > 0.005) {
        warnings.push(`고압 리시버 출구 2상 증기 혼입 (x=${stOut.x.toFixed(3)}) — 충전량 부족 또는 응축 능력 부족`);
      }
    }

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
        diam_mm, height_mm, vol_L, dP_bar, Q_loss_kW,
        mass_kg, mass_min_kg, mass_max_kg, level_pct, state_desc, phase: stOut.phase,
        warnings
      }
    };
  }

  global.ReceiverModule = { run, calcVolumeL };
})(window);
