// expansion_valve.js — ΔP→ṁ 역방향 유량 계산 + 실제 HEM 초크 플로우 제한 + 통일 개도 하한(5%) + TXV 정적과열도/비례 제어 + 물리적 내부 보유량
(function (global) {
  const MIN_OPEN_PCT = 5.0; // 문서(correlations_doc.js)와 코드 완전 일치 (기존 5%/8% 불일치 해소)

  function smoothClamp(x, lo, hi, k = 1.5) {
    // 경계 부근 매끄러운 클램핑 (뉴턴 야코비안 연속성 확보)
    const a = lo + Math.log(1 + Math.exp((x - lo) / k)) * k;
    const b = hi - Math.log(1 + Math.exp((hi - a) / k)) * k;
    return Math.min(hi, Math.max(lo, b));
  }

  function calcEffectiveCd(params, D_mm, rho_in, mu_uPas, m_dot, A_eff_m2, SC_K) {
    const cdBase = Math.max(0.15, Math.min(0.95, params.Cd || 0.65));
    const flowCorr = params.flow_corr || "re_diam_cd"; // "re_diam_cd" | "hem_choked" | "const_cd"
    if (flowCorr === "const_cd") return cdBase;

    const v_throat = Math.max(1e-4, m_dot) / Math.max(1e-8, Math.max(1.0, rho_in) * Math.max(1e-9, A_eff_m2));
    const mu_Pas = Math.max(1e-6, (mu_uPas || 140) * 1e-6);
    const D_m = Math.max(0.4, D_mm) * 1e-3;
    const Re_D = Math.max(100, (Math.max(1.0, rho_in) * v_throat * D_m) / mu_Pas);

    // 지름(D)·Re_D·과냉도(SC) 연동 유량계수 경험 보정
    const diamFactor = Math.pow(D_mm / 2.8, 0.14);
    const reFactor = 1 - 9.5 / Math.sqrt(Math.max(150, Re_D));
    const scFactor = 1 + 0.006 * Math.min(25, Math.max(0, SC_K || 0));
    return Math.min(0.92, Math.max(0.22, cdBase * diamFactor * reFactor * scFactor));
  }

  // 진성 HEM (Homogeneous Equilibrium Model) 임계 질량유속 G_crit 및 임계 초크압 P_choke 탐색
  // 등엔트로피 노즐 팽창 G(P_t) = ρ(P_t, s_in) * sqrt(2 * (h_in - h(P_t, s_in))) 의 최대값 탐색 (황금분할 16회)
  function calcHEMChoke(inS, refProp) {
    const P_in = Math.max(1.0, inS.P_bar);
    const h_in = inS.h_kJkg;
    const s_in = inS.s_kJkgK;
    if (!refProp || refProp.kind !== "two_phase" || !Number.isFinite(s_in)) {
      const P_c = P_in * 0.55;
      const G_c = Math.sqrt(2 * Math.max(1.0, inS.rho || 500) * Math.max(0.2, P_in - P_c) * 1e5);
      return { P_choke_bar: P_c, G_hem_ideal: G_c };
    }

    const pMinTable = refProp.sat.P[0];
    let a = Math.max(pMinTable, P_in * 0.08);
    let b = P_in * 0.985;
    const phi = 0.61803398875;

    const evalG = (Pt) => {
      const st = refProp.solvePS(Pt, s_in);
      const dh_J = Math.max(0, (h_in - st.h) * 1000);
      return st.rho * Math.sqrt(2 * dh_J);
    };

    let c = b - phi * (b - a);
    let d = a + phi * (b - a);
    let fc = evalG(c), fd = evalG(d);

    for (let i = 0; i < 34; i++) {
      if (fc < fd) {
        a = c; c = d; fc = fd;
        d = a + phi * (b - a);
        fd = evalG(d);
      } else {
        b = d; d = c; fd = fc;
        c = b - phi * (b - a);
        fc = evalG(c);
      }
    }
    const P_choke_bar = 0.5 * (a + b);
    const G_hem_ideal = Math.max(100, evalG(P_choke_bar));
    return { P_choke_bar, G_hem_ideal };
  }

  // 기존 호환용 초크압 헬퍼 (HEM 기반)
  function calcChokePressureBar(inS, refProp) {
    return calcHEMChoke(inS, refProp).P_choke_bar;
  }

  // [핵심 개선] ΔP → ṁ 방향 밸브 유량 평가 (전역 뉴턴 솔버 잔차 R_mass = (m_comp - m_valve)/m_ref 용)
  function calcMassFlow(inS, P_out_bar, params, refProp, sensorFeedback = null) {
    const mode = params.valve_mode || "txv_sh"; // "txv_sh" | "orifice" | "fixed_p"
    const flowCorr = params.flow_corr || "re_diam_cd"; // "re_diam_cd" | "hem_choked" | "const_cd"
    const D_mm = Math.max(0.4, params.orifice_D_mm || 2.8);
    const A_max_mm2 = (Math.PI * D_mm * D_mm) / 4;
    const A_max_m2 = A_max_mm2 * 1e-6;
    const rho_in = Math.max(1.0, inS.rho || 1000);
    const SC_in = Math.max(0, (inS.T_sat_C ?? inS.T_C) - inS.T_C);

    const P_out = Math.max(0.5, Math.min(inS.P_bar - 0.05, P_out_bar));
    const dP_bar = Math.max(0.05, inS.P_bar - P_out);

    const hem = calcHEMChoke(inS, refProp);
    const P_choke_bar = hem.P_choke_bar;

    let opening_pct, SH_meas = null;
    const sensor_connected = !!(sensorFeedback && sensorFeedback.connected);
    const SH_target = params.SH_target_K ?? 6.0;
    const Kp = params.Kp_sh ?? 6.0;
    const openBase = params.open_base_pct ?? 50.0;
    // 정적 과열도 (밸브가 최소 개도 5%에 도달하는 과열도)
    const SH_static = Math.max(0.5, SH_target - (openBase - MIN_OPEN_PCT) / Math.max(0.5, Kp));

    if (mode === "txv_sh") {
      SH_meas = sensor_connected ? sensorFeedback.SH : SH_target;
      const rawOpen = openBase + Kp * (SH_meas - SH_target);
      opening_pct = smoothClamp(rawOpen, MIN_OPEN_PCT, 100.0, 1.2);
    } else if (mode === "orifice") {
      opening_pct = Math.min(100, Math.max(MIN_OPEN_PCT, params.opening_pct ?? 50));
    } else {
      // fixed_p 모드: 압축기 유량 통과에 필요한 등가 개도 역산
      const m_ref = Math.max(1e-5, inS.m_dot || 0.05);
      const cd0 = calcEffectiveCd(params, D_mm, rho_in, inS.mu, m_ref, A_max_m2 * 0.5, SC_in);
      const G_sub0 = cd0 * Math.sqrt(2 * rho_in * dP_bar * 1e5);
      const G_eff0 = (flowCorr === "hem_choked" && P_out <= P_choke_bar) ? Math.min(G_sub0, cd0 * hem.G_hem_ideal) : G_sub0;
      const A_req = m_ref / Math.max(1.0, G_eff0);
      opening_pct = Math.min(100, Math.max(1.0, (A_req / A_max_m2) * 100));
    }

    const A_eff_m2 = A_max_m2 * (opening_pct / 100);
    const A_eff_mm2 = A_eff_m2 * 1e6;

    // Cd_eff 자기일관 2회 반복 (유량 ↔ Re_D 결합)
    let m_est = Math.max(1e-4, inS.m_dot || 0.06);
    let Cd_eff = params.Cd || 0.65;
    let G_sub = 0, G_crit = 0, G_actual = 0, is_choked = false;

    for (let it = 0; it < 2; it++) {
      Cd_eff = calcEffectiveCd(params, D_mm, rho_in, inS.mu, m_est, A_eff_m2, SC_in);
      G_sub = Cd_eff * Math.sqrt(2 * rho_in * dP_bar * 1e5);
      G_crit = Cd_eff * hem.G_hem_ideal;
      if (flowCorr === "hem_choked" && (P_out <= P_choke_bar || G_sub >= G_crit)) {
        is_choked = true;
        G_actual = Math.min(G_sub, G_crit); // 실제 초크 유량 상한 강제 적용!
      } else {
        is_choked = false;
        G_actual = G_sub;
      }
      m_est = Math.max(1e-5, G_actual * A_eff_m2);
    }

    const m_dot_valve = (mode === "fixed_p") ? Math.max(1e-5, inS.m_dot || m_est) : m_est;
    const m_choke_max = G_crit * A_eff_m2;
    const stOut = refProp.evalPH(P_out, inS.h_kJkg);

    // 밸브 바디 내부 체적(오리피스 지름 기반 근사 ~4~8 cm³) × 입출구 평균 밀도 (하드코딩 0.002 kg 제거)
    const V_valve_m3 = Math.max(2e-6, A_max_m2 * 0.06 + 3e-6);
    const rho_out_inv = (stOut.x > 0 && stOut.x < 1 && refProp.voidFractionDensity) ? refProp.voidFractionDensity(P_out, stOut.x) : stOut.rho;
    const mass_kg = V_valve_m3 * 0.5 * (rho_in + rho_out_inv);

    return {
      m_dot_valve,
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
        G_crit,
        is_choked,
        m_dot_valve,
        m_choke_max,
        dP_bar,
        opening_pct,
        SH_meas,
        SH_target,
        SH_static,
        sensor_connected,
        quality: stOut.x,
        T_evap: stOut.T,
        mass_kg
      }
    };
  }

  // 호환 진입점: P_out_override가 주어지면 역방향(ΔP→ṁ) 호출, 없으면 개회로용 ΔP 산출
  function run(inS, params, refProp, sensorFeedback = null, P_out_override = null) {
    if (P_out_override !== null && Number.isFinite(P_out_override)) {
      return calcMassFlow(inS, P_out_override, params, refProp, sensorFeedback);
    }
    const mode = params.valve_mode || "txv_sh";
    if (mode === "fixed_p") {
      const P_out = Math.min(inS.P_bar * 0.96, Math.max(0.8, params.P_out_bar || 3.6));
      return calcMassFlow(inS, P_out, params, refProp, sensorFeedback);
    }
    // 개회로(open-loop) 단독 패스용: m_dot_valve(P_out) = inS.m_dot 가 되는 P_out 이분법 역산
    const m_target = Math.max(1e-5, inS.m_dot);
    let lo = Math.max(0.8, (refProp.sat && refProp.sat.P) ? refProp.sat.P[0] : 0.8);
    let hi = Math.max(lo + 0.1, inS.P_bar - 0.1);
    for (let i = 0; i < 22; i++) {
      const mid = 0.5 * (lo + hi);
      const r = calcMassFlow(inS, mid, params, refProp, sensorFeedback);
      if (r.m_dot_valve > m_target) lo = mid; else hi = mid;
    }
    return calcMassFlow(inS, 0.5 * (lo + hi), params, refProp, sensorFeedback);
  }

  global.ValveModule = { run, calcMassFlow, calcEffectiveCd, calcChokePressureBar, calcHEMChoke, MIN_OPEN_PCT };
})(window);
