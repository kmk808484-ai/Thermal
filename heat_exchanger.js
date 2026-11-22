// heat_exchanger.js — 세그먼트 이산화(6-Zone) + Chen 루버핀/플랫핀 + Shah 응축 + PHX(Yan-Lin/Han-Lee-Kim/Hsieh-Lin) + 모멘텀 ΔP + Zivi 충전량
(function (global) {
  const P_CRIT_MAP = { R134a: 40.59, R32: 57.82, Water: 220.64 };

  function getSecProps(secFluidName, T_sec_in, P_sec_bar, fluidTableDB) {
    if (fluidTableDB && fluidTableDB[secFluidName]) {
      return fluidTableDB[secFluidName].evalSinglePhase(T_sec_in, P_sec_bar);
    }
    if (secFluidName === "Water") return { T: T_sec_in, P: P_sec_bar, rho: 995, Cp: 4.18, mu: 800, k: 610 };
    if (secFluidName === "GW") return { T: T_sec_in, P: P_sec_bar, rho: 1065, Cp: 3.35, mu: 3500, k: 395 };
    return { T: T_sec_in, P: P_sec_bar, rho: 1.16, Cp: 1.006, mu: 18.6, k: 26.3 };
  }

  function calcGeometry(params) {
    const hxType = params.hxType || "fin_plate";
    if (hxType === "plate") {
      const W = Math.max(0.03, (params.plate_W_mm || 120) * 1e-3);
      const L = Math.max(0.05, (params.plate_L_mm || 320) * 1e-3);
      const b = Math.max(0.0008, (params.corr_depth_mm || 2.0) * 1e-3);
      const p_co = Math.max(0.002, (params.corr_pitch_mm || 7.0) * 1e-3);
      const Np = Math.max(4, Math.round(params.n_plates || 30));
      const beta = Math.min(75, Math.max(20, params.chevron_deg || 60));
      const tp = Math.max(0.0001, (params.plate_thick_mm || 0.4) * 1e-3);
      const kp = Math.max(1.0, params.plate_k_WmK || 16.0);
      const phi = Math.min(1.5, Math.max(1.0, params.phi_enlarge || 1.17));

      const n_ch_ref = Math.max(1, Math.floor((Np - 1) / 2));
      const n_ch_sec = Math.max(1, Np - 1 - n_ch_ref);
      const A_eff = Math.max(0.02, (Np - 2) * W * L * phi);
      const Dh_ref = 2 * b / phi;
      const Dh_sec = 2 * b / phi;
      const A_cross_ref = n_ch_ref * W * b;
      const A_cross_sec = n_ch_sec * W * b;
      const V_int_m3 = A_cross_ref * L;
      return { hxType, A_ref: A_eff, A_sec: A_eff, A_eff, Dh_ref, Dh_sec, A_cross_ref, A_cross_sec, V_int_m3, L_ref: L, L_sec: L, beta, b, p_co, phi, tp, kp, n_ch_ref, n_ch_sec };
    } else {
      const W = Math.max(0.05, (params.core_W_mm || 520) * 1e-3);
      const H = Math.max(0.05, (params.core_H_mm || 360) * 1e-3);
      const D = Math.max(0.008, (params.core_D_mm || 26) * 1e-3);
      const Fp = Math.max(0.0008, (params.fin_pitch_mm || 2.0) * 1e-3);
      const ft = Math.max(0.00005, (params.fin_thick_mm || 0.12) * 1e-3);
      const Lp = Math.max(0.0005, (params.louver_pitch_mm || 1.2) * 1e-3);
      const lAng = Math.min(45, Math.max(10, params.louver_angle_deg || 27));
      const Dh_ref = Math.max(0.0008, (params.ch_Dh_mm || 2.5) * 1e-3);
      const N_ch = Math.max(2, Math.round(params.n_channels || 32));
      const N_pass = Math.max(1, Math.min(N_ch, Math.round(params.n_passes || 2)));

      const ch_per_pass = Math.max(1, N_ch / N_pass);
      const A_cross_ref = ch_per_pass * (Math.PI * Dh_ref * Dh_ref / 4);
      const L_ref = W * N_pass;
      const V_int_m3 = N_ch * W * (Math.PI * Dh_ref * Dh_ref / 4);
      const A_ref = Math.max(0.05, N_ch * W * Math.PI * Dh_ref);

      const A_face = W * H;
      const free_ratio = Math.max(0.35, 1 - ft / Fp - 0.18);
      const A_cross_sec = A_face * free_ratio;
      const fin_H = Math.max(0.004, H / Math.max(6, N_ch * 0.6));
      const n_fins = W / Fp;
      const A_fin = 2 * n_fins * fin_H * D * Math.max(6, N_ch * 0.5);
      const A_sec = Math.max(0.2, A_fin + A_face * 0.35);
      const Af_ratio = A_fin / A_sec;
      const Dh_sec = Math.max(0.001, (2 * (Fp - ft) * fin_H) / ((Fp - ft) + fin_H));
      return { hxType, A_ref, A_sec, A_eff: A_sec, Dh_ref, Dh_sec, A_cross_ref, A_cross_sec, V_int_m3, L_ref, L_sec: D, Fp, ft, Lp, lAng, fin_H, Af_ratio, D, k_fin: 205 };
    }
  }

  // 외부/상대측 열전달계수 계산 (Chen 루버핀 / Wang 플랫핀 / Muley-Manglik / Martin)
  function calcSecHTC(params, geo, secFluid, secProp, m_sec) {
    const mu_s = Math.max(1e-6, (secProp.mu || 18.5) * 1e-6);
    const k_s = Math.max(0.005, (secProp.k || 26) * 1e-3);
    const Cp_s = Math.max(200, (secProp.Cp || 1.006) * 1000);
    const Pr_s = Math.max(0.5, (Cp_s * mu_s) / k_s);
    const G_s = Math.max(0.2, m_sec / Math.max(1e-5, geo.A_cross_sec));
    const Re_s = Math.max(10, (G_s * geo.Dh_sec) / mu_s);

    let h_sec = 80, f_sec = 0.05;

    if (geo.hxType === "plate") {
      const corr = params.sec_phe_corr || "muley_manglik";
      const beta = geo.beta;
      const betaRad = beta * Math.PI / 180;
      const C_tune = params.sec_corr_C || 1.0;

      if (corr === "martin") {
        const f0 = Re_s < 2000 ? 16 / Math.max(10, Re_s) : Math.pow(1.56 * Math.log(Re_s) - 3.0, -2);
        const f1 = Re_s < 2000 ? (149 / Math.max(10, Re_s) + 0.9625) : 9.75 / Math.pow(Re_s, 0.289);
        const cosB = Math.cos(betaRad);
        f_sec = Math.pow(cosB / Math.sqrt(0.045 * Math.tan(betaRad) + 0.09 * Math.sin(betaRad) + f0 / cosB) + (1 - cosB) / Math.sqrt(3.8 * f1), -2);
        const Nu = C_tune * 0.205 * Math.pow(Pr_s, 1 / 3) * Math.pow(Math.max(1, f_sec * Re_s * Re_s * Math.sin(2 * betaRad)), 0.374);
        h_sec = Math.max(30, (Nu * k_s) / geo.Dh_sec);
      } else {
        // Muley & Manglik (1999)
        const cBeta = Math.max(0.08, 0.2668 - 0.006967 * beta + 7.244e-5 * beta * beta);
        const phi = geo.phi;
        const cPhi = Math.max(0.7, 20.78 - 50.94 * phi + 41.16 * phi * phi - 10.51 * phi * phi * phi);
        const expRe = 0.728 + 0.0543 * Math.sin((2 * Math.PI * beta) / 90 + 3.7);
        const Nu = C_tune * cBeta * cPhi * Math.pow(Re_s, expRe) * Math.pow(Pr_s, 1 / 3);
        h_sec = Math.max(30, (Nu * k_s) / geo.Dh_sec);
        f_sec = (0.6 + 0.03 * beta) * Math.pow(Math.max(50, Re_s), -0.25);
      }
    } else {
      // 핀-플레이트 열교환기
      if (secFluid === "Air") {
        const finType = params.fin_type || "louver"; // "louver" (Chen/Chang-Wang) | "flat" (Wang-Chi)
        let h_bare;
        if (finType === "flat") {
          const C_j = params.fin_Cj || 0.145;
          const j = C_j * Math.pow(Math.max(50, Re_s), -0.38) * Math.pow(geo.Fp / geo.Dh_sec, -0.12);
          h_bare = j * G_s * Cp_s / Math.pow(Pr_s, 2 / 3);
          f_sec = 0.16 * Math.pow(Math.max(50, Re_s), -0.30);
        } else {
          // Chang-Wang / Chen Louver Fin Correlation
          const Re_Lp = Math.max(30, (G_s * geo.Lp) / mu_s);
          const C_j = params.fin_Cj || 0.267;
          const j = C_j * Math.pow(Re_Lp, -0.49)
            * Math.pow(geo.lAng / 90, 0.27)
            * Math.pow(geo.Fp / geo.Lp, -0.14)
            * Math.pow(geo.fin_H / geo.Lp, -0.29)
            * Math.pow(geo.D / geo.Lp, -0.23);
          h_bare = j * G_s * Cp_s / Math.pow(Pr_s, 2 / 3);
          f_sec = 0.54486 * Math.pow(Re_Lp, -0.3068) * Math.pow(geo.lAng / 90, 0.444) * Math.pow(geo.Fp / geo.Lp, -0.9925);
        }
        const m_fin = Math.sqrt((2 * Math.max(5, h_bare)) / (geo.k_fin * geo.ft));
        const mL = Math.max(0.05, m_fin * (geo.fin_H / 2));
        const eta_fin = Math.tanh(mL) / mL;
        const eta_o = 1 - geo.Af_ratio * (1 - eta_fin);
        h_sec = Math.max(10, h_bare * eta_o);
      } else {
        const Nu_s = Re_s < 2300 ? 4.36 : 0.023 * Math.pow(Re_s, 0.8) * Math.pow(Pr_s, 0.4);
        h_sec = Math.max(50, (Nu_s * k_s) / geo.Dh_sec);
        f_sec = 0.3164 * Math.pow(Math.max(50, Re_s), -0.25);
      }
    }

    const dP_sec_Pa = Math.min(50000, f_sec * (geo.L_sec / geo.Dh_sec) * (G_s * G_s) / (2 * Math.max(0.2, secProp.rho)));
    return { h_sec, Re_s, dP_sec_Pa };
  }

  // 국소 냉매측 열전달계수 계산 (Shah 응축 / Cavallini / Yan-Lin / Han-Lee-Kim / Hsieh-Lin / Dittus)
  function calcLocalRefHTC(st, sat, G_ref, Dh, params, isCondenser, qFlux_Wm2, fluidName) {
    const mu = Math.max(1e-6, (st.mu || 120) * 1e-6);
    const k = Math.max(0.005, (st.k || 65) * 1e-3);
    const Cp = Math.max(200, (st.Cp || 1.2) * 1000);
    const Pr = Math.max(0.5, (Cp * mu) / k);
    const Re = Math.max(10, (G_ref * Dh) / mu);

    // 단상 구간: Dittus-Boelter
    if (!sat || st.x <= 0.01 || st.x >= 0.99) {
      const Nu = Re < 2300 ? 4.36 : 0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, isCondenser ? 0.3 : 0.4);
      return Math.max(80, (Nu * k) / Dh);
    }

    const x = Math.min(0.98, Math.max(0.02, st.x));
    const mu_l = Math.max(1e-6, sat.mu_f * 1e-6);
    const mu_v = Math.max(1e-6, sat.mu_g * 1e-6);
    const k_l = Math.max(0.005, sat.k_f * 1e-3);
    const Cp_l = Math.max(200, sat.Cp_f * 1000);
    const Pr_l = Math.max(0.5, (Cp_l * mu_l) / k_l);
    const Re_LO = Math.max(10, (G_ref * Dh) / mu_l);
    const h_fg_J = Math.max(1e4, (sat.h_g - sat.h_f) * 1000);
    const C_ref = params.ref_corr_C || 1.0;

    if (isCondenser) {
      const corr = params.ref_cond_corr || "shah_cond";
      if (corr === "cavallini") {
        const Re_l = (G_ref * (1 - x) * Dh) / mu_l;
        const Re_v = (G_ref * x * Dh) / mu_v;
        const Re_eq = Math.max(10, Re_l + Re_v * (mu_v / mu_l) * Math.sqrt(sat.rho_f / Math.max(0.5, sat.rho_g)));
        const Nu = C_ref * 0.05 * Math.pow(Re_eq, 0.8) * Math.pow(Pr_l, 0.33);
        return Math.max(150, (Nu * k_l) / Dh);
      } else if (corr === "dittus") {
        const Nu = C_ref * 0.023 * Math.pow(Re_LO, 0.8) * Math.pow(Pr_l, 0.3);
        return Math.max(120, (Nu * k_l) / Dh);
      } else {
        // Shah (1979/2009) Condensation Correlation
        const P_crit = params.P_crit_bar || P_CRIT_MAP[fluidName] || 40.59;
        const P_r = Math.min(0.95, Math.max(0.01, st.P / P_crit));
        const h_LO = 0.023 * Math.pow(Re_LO, 0.8) * Math.pow(Pr_l, 0.4) * (k_l / Dh);
        const factor = Math.pow(1 - x, 0.8) + (3.8 * Math.pow(x, 0.76) * Math.pow(1 - x, 0.04)) / Math.pow(P_r, 0.38);
        return Math.max(200, C_ref * h_LO * factor);
      }
    } else {
      // 증발 상관식 (PHX 유명 상관식: Yan-Lin / Han-Lee-Kim / Hsieh-Lin)
      const corr = params.ref_evap_corr || (params.hxType === "plate" ? "yan_lin" : "yan_lin");
      const G_eq = G_ref * ((1 - x) + x * Math.sqrt(sat.rho_f / Math.max(0.5, sat.rho_g)));
      const Re_eq = Math.max(20, (G_eq * Dh) / mu_l);
      const q_eff = Math.max(800, qFlux_Wm2);
      const Bo_eq = Math.max(1e-6, q_eff / (G_eq * h_fg_J));

      if (corr === "han_lee_kim") {
        const betaRad = Math.min(75, Math.max(20, params.chevron_deg || 60)) * Math.PI / 180;
        const p_co = Math.max(0.002, (params.corr_pitch_mm || 7.0) * 1e-3);
        const ratio = p_co / Math.max(0.001, Dh);
        const Ge1 = 2.81 * Math.pow(ratio, -0.041) * Math.pow(Math.max(0.15, Math.PI / 2 - betaRad), -2.83);
        const Ge2 = 0.746 * Math.pow(ratio, -0.082) * Math.pow(Math.max(0.15, Math.PI / 2 - betaRad), 0.61);
        const Nu = C_ref * Math.min(80, Ge1) * Math.pow(Re_eq, Math.min(0.95, Ge2)) * Math.pow(Bo_eq, 0.3) * Math.pow(Pr_l, 0.4);
        return Math.max(200, Math.min(25000, (Nu * k_l) / Dh));
      } else if (corr === "hsieh_lin") {
        const h_l = 0.2092 * (k_l / Dh) * Math.pow(Re_LO, 0.78) * Math.pow(Pr_l, 1 / 3);
        const Bo = Math.max(1e-6, q_eff / (G_ref * h_fg_J));
        return Math.max(200, Math.min(25000, C_ref * h_l * 88 * Math.pow(Bo, 0.5)));
      } else if (corr === "dittus") {
        const Nu = C_ref * 0.023 * Math.pow(Re_LO, 0.8) * Math.pow(Pr_l, 0.4);
        return Math.max(150, (Nu * k_l) / Dh);
      } else {
        // Yan & Lin (1999) PHX Evaporation Correlation
        const Nu = C_ref * 1.926 * Math.pow(Re_eq, 0.5) * Math.pow(Pr_l, 1 / 3) * Math.pow(Bo_eq, 0.3);
        return Math.max(200, Math.min(25000, (Nu * k_l) / Dh));
      }
    }
  }

  function run(inS, params, refProp, fluidTableDB = null) {
    const hxType = params.hxType || "fin_plate";
    const secFluid = params.sec_fluid || (hxType === "plate" ? "GW" : "Air");
    const secMode = params.sec_mode || "fluid_temp";
    const T_sec_in = params.T_sec_in !== undefined ? params.T_sec_in : (params.T_air_in !== undefined ? params.T_air_in : 35.0);
    const m_sec = Math.max(0.005, params.m_sec_kgs !== undefined ? params.m_sec_kgs : (params.m_air_kgs || 1.2));
    const P_sec = Math.max(0.5, params.P_sec_bar || (secFluid === "Air" ? 1.013 : 2.0));

    const secProp = getSecProps(secFluid, T_sec_in, P_sec, fluidTableDB);
    const Cp_sec = Math.max(0.2, secProp.Cp);
    const C_sec = Math.max(0.005, m_sec * Cp_sec);
    const geo = calcGeometry(params);
    const m_ref = Math.max(1e-5, inS.m_dot);
    const G_ref = Math.max(5.0, m_ref / Math.max(1e-6, geo.A_cross_ref));
    const satIn = refProp.kind === "two_phase" ? refProp.getSatAtP(inS.P_bar) : null;
    const method = params.method || "GEO";

    const secInfo = calcSecHTC(params, geo, secFluid, secProp, m_sec);
    const h_sec_Wm2K = secInfo.h_sec;

    const isCondenser = secMode === "const_Q" ? ((params.Q_source_kW ?? -5) < 0) : (inS.T_sat_C >= T_sec_in);
    const role = isCondenser ? "응축기 (방열)" : "증발기 (흡열)";

    // 6-세그먼트 공간 이산화 계산 (실제 온도장 & 국소 상관식 적분)
    const N_SEG = 6;
    const segments = [];
    let h_cur = inS.h_kJkg;
    let P_cur = inS.P_bar;
    let Q_total = 0;
    let UA_sum = 0;
    let h_ref_sum = 0;
    let mass_total_kg = 0;
    let dP_f_total = 0;
    let T_sec_out_acc = 0;
    const qFluxGuess = Math.max(1500, (params.Q_est_kW || 6.0) * 1000 / Math.max(0.05, geo.A_ref));

    for (let i = 0; i < N_SEG; i++) {
      const stSeg = refProp.evalPH(P_cur, h_cur);
      const satSeg = refProp.kind === "two_phase" ? refProp.getSatAtP(P_cur) : null;
      let UA_seg, h_ref_seg = 1500;

      if (method === "GEO") {
        h_ref_seg = calcLocalRefHTC(stSeg, satSeg, G_ref, geo.Dh_ref, params, isCondenser, qFluxGuess, inS.fluid);
        if (hxType === "plate") {
          const R_wall = geo.tp / geo.kp;
          const U_seg = 1 / (1 / h_ref_seg + R_wall + 1 / h_sec_Wm2K);
          UA_seg = (U_seg * (geo.A_eff / N_SEG)) / 1000;
        } else {
          const R_r = 1 / (h_ref_seg * (geo.A_ref / N_SEG));
          const R_s = 1 / (h_sec_Wm2K * (geo.A_sec / N_SEG));
          UA_seg = (1 / (R_r + R_s)) / 1000;
        }
      } else if (method === "NTU") {
        UA_seg = ((Math.max(0.05, params.NTU_val || 1.2) * C_sec) / N_SEG);
      } else if (method === "CORR") {
        const mu_r = Math.max(1e-6, (stSeg.mu || 150) * 1e-6), k_r = Math.max(0.005, (stSeg.k || 75) * 1e-3), Cp_r = Math.max(200, (stSeg.Cp || 1.2) * 1000);
        const Pr_r = Math.max(0.5, (Cp_r * mu_r) / k_r), Re_r = Math.max(10, (G_ref * geo.Dh_ref) / mu_r);
        h_ref_seg = ((params.corr_C || 0.023) * Math.pow(Re_r, params.corr_m || 0.8) * Math.pow(Pr_r, params.corr_n || 0.4) * k_r) / geo.Dh_ref;
        const U_seg = 1 / (1 / Math.max(20, h_ref_seg) + 1 / Math.max(10, params.h_air_Wm2K || 80));
        UA_seg = (U_seg * (Math.max(0.05, params.area_m2 || 12.0) / N_SEG)) / 1000;
      } else {
        UA_seg = Math.max(0.01, params.UA_kWK || 1.2) / N_SEG;
      }

      const C_sec_seg = C_sec / N_SEG; // 직교류(Fin-Plate) 각 세그먼트 분담 공기열용량
      const NTU_seg = UA_seg / Math.max(1e-4, C_sec_seg);
      const eff_seg = 1 - Math.exp(-Math.min(10, NTU_seg));

      let Q_seg;
      if (secMode === "const_Q") {
        Q_seg = Math.abs(params.Q_source_kW ?? -5.0) / N_SEG;
      } else {
        const dT_drive = isCondenser ? Math.max(0, stSeg.T - T_sec_in) : Math.max(0, T_sec_in - stSeg.T);
        Q_seg = eff_seg * C_sec_seg * dT_drive;
      }

      const T_sec_out_seg = isCondenser ? (T_sec_in + Q_seg / C_sec_seg) : (T_sec_in - Q_seg / C_sec_seg);
      const h_next = isCondenser ? (h_cur - Q_seg / m_ref) : (h_cur + Q_seg / m_ref);

      // 세그먼트 마찰 압력강하 (모멘텀)
      let dP_seg_bar = (params.dP_bar || 0.2) / N_SEG;
      if (params.auto_dP !== false) {
        const mu_r = Math.max(1e-6, (stSeg.mu || 120) * 1e-6);
        const Re_r = Math.max(10, (G_ref * geo.Dh_ref) / mu_r);
        const f_r = hxType === "plate"
          ? (Re_r < 400 ? 40 / Re_r : (0.6 + 0.03 * geo.beta) * Math.pow(Re_r, -0.25))
          : (Re_r < 2300 ? 64 / Re_r : 0.3164 * Math.pow(Re_r, -0.25));
        const dP_f_seg = (f_r * ((geo.L_ref / N_SEG) / geo.Dh_ref) * G_ref * G_ref) / (2 * Math.max(1.0, stSeg.rho) * 1e5);
        dP_f_total += dP_f_seg;
        dP_seg_bar = Math.min(P_cur * 0.04, dP_f_seg);
      }

      const P_next = Math.max(0.5, P_cur - dP_seg_bar);
      const stNext = refProp.evalPH(P_next, h_next);

      // 세그먼트 Zivi 기공률 질량 적분
      const rho_inv = (stSeg.x > 0 && stSeg.x < 1) ? refProp.voidFractionDensity(P_cur, stSeg.x) : stSeg.rho;
      const rho_inv_n = (stNext.x > 0 && stNext.x < 1) ? refProp.voidFractionDensity(P_next, stNext.x) : stNext.rho;
      mass_total_kg += (geo.V_int_m3 / N_SEG) * 0.5 * (rho_inv + rho_inv_n);

      segments.push({
        idx: i, T_ref_in: stSeg.T, T_ref_out: stNext.T, x_mid: 0.5 * (stSeg.x + stNext.x),
        T_sec_in, T_sec_out: T_sec_out_seg, h_ref: h_ref_seg, Q_seg, phase: stSeg.phase
      });

      Q_total += Q_seg;
      UA_sum += UA_seg;
      h_ref_sum += h_ref_seg;
      T_sec_out_acc += T_sec_out_seg;
      h_cur = h_next;
      P_cur = P_next;
    }

    const stOutPre = refProp.evalPH(P_cur, h_cur);
    let dP_acc_bar = 0, dP_bar = Math.max(0.005, inS.P_bar - P_cur);
    if (params.auto_dP !== false) {
      dP_acc_bar = (G_ref * G_ref * (1 / Math.max(1.0, stOutPre.rho) - 1 / Math.max(1.0, inS.rho || 30))) / 1e5;
      dP_bar = Math.max(0.01, Math.min(inS.P_bar * 0.25, dP_f_total + dP_acc_bar));
    } else {
      dP_bar = params.dP_bar || 0.2;
      dP_f_total = dP_bar;
    }

    const P_out = Math.max(0.5, inS.P_bar - dP_bar);
    const stOut = refProp.evalPH(P_out, h_cur);
    const T_sec_out = T_sec_out_acc / N_SEG;
    const h_ref_avg = h_ref_sum / N_SEG;
    const U_Wm2K = (UA_sum * 1000) / Math.max(0.02, geo.A_eff);
    const NTU = UA_sum / C_sec;

    return {
      inlet: inS,
      outlet: {
        fluid: inS.fluid, P_bar: P_out, T_C: stOut.T, h_kJkg: stOut.h, s_kJkgK: stOut.s,
        rho: stOut.rho, mu: stOut.mu, k: stOut.k, Cp: stOut.Cp, m_dot: inS.m_dot,
        T_sat_C: stOut.T_sat, SC: stOut.SC, SH: stOut.SH, quality: stOut.x
      },
      metrics: {
        hxType, hxTypeLabel: hxType === "plate" ? "판형 (PHE)" : "핀-플레이트",
        finType: params.fin_type || "louver",
        secFluid, secMode, T_sec_in, m_sec_kgs: m_sec, T_air_out: T_sec_out, T_sec_out,
        Cp_sec, rho_sec: secProp.rho,
        role, isCondenser, method,
        Q_kW: Q_total, UA_eff: UA_sum, U_Wm2K, NTU, effectiveness: 1 - Math.exp(-Math.min(12, NTU)),
        h_ref_Wm2K: h_ref_avg, h_sec_Wm2K,
        A_ref_m2: geo.A_ref, A_sec_m2: geo.A_sec, V_int_L: geo.V_int_m3 * 1000,
        dP_bar, dP_f_bar: dP_f_total, dP_acc_bar, dP_sec_Pa: secInfo.dP_sec_Pa,
        mass_kg: mass_total_kg, segments,
        phase: stOut.phase, quality: stOut.x, SC: stOut.SC, SH: stOut.SH
      }
    };
  }

  global.HXModule = { run, calcGeometry, getSecProps, P_CRIT_MAP };
})(window);
