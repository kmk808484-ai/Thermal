// heat_exchanger.js — 20-세그먼트 이산화 + 일반 Cr ε-NTU + 판형 진성 역류(Counter-flow) + 제2법칙 엄격 강제
// 개선: Chang-Wang(1997) 8항 루버핀 j + Chang(2000) f, Martin(1996) Darcy ξ(0.122), Muley-Manglik(1999) f + Re<1000 자동 Martin 분기,
//       Han-Lee-Kim(기본)/Amalfi(2016)/수정 Yan-Lin(1999) + 국소 열유속 Bo 내부반복, Kim-Mudawar(2013) 응축, Gnielinski 연속 천이, Friedel 2상 ΔP
(function (global) {
  const P_CRIT_MAP = { R134a: 40.59, R32: 57.82, Water: 220.64 };

  function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(1e-12, edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  // Churchill (1977) 전 영역 연속 Darcy 마찰계수 (층류-천이-난류 + 조도 ε/D)
  function churchillFriction(Re, relRough = 1e-4) {
    const r = Math.max(10, Re);
    const term1 = Math.pow(8 / r, 12);
    const A = Math.pow(2.457 * Math.log(1 / (Math.pow(7 / r, 0.9) + 0.27 * relRough)), 16);
    const B = Math.pow(37530 / r, 16);
    return 8 * Math.pow(term1 + 1 / Math.pow(A + B, 1.5), 1 / 12);
  }

  // Friedel (1979) 2상 마찰 압력강하 증배계수 Φ_LO^2
  function friedelMultiplier(G, Dh, x, sat, sigma_Nm) {
    const xc = Math.min(0.999, Math.max(0.001, x));
    const rho_l = Math.max(10, sat.rho_f), rho_v = Math.max(0.2, sat.rho_g);
    const mu_l = Math.max(1e-6, sat.mu_f * 1e-6), mu_v = Math.max(1e-6, sat.mu_g * 1e-6);
    const Re_lo = Math.max(10, (G * Dh) / mu_l);
    const Re_go = Math.max(10, (G * Dh) / mu_v);
    const f_lo = churchillFriction(Re_lo, 5e-4);
    const f_go = churchillFriction(Re_go, 5e-4);

    const E = Math.pow(1 - xc, 2) + xc * xc * (rho_l * f_go) / Math.max(1e-9, rho_v * f_lo);
    const F = Math.pow(xc, 0.78) * Math.pow(1 - xc, 0.224);
    const H = Math.pow(rho_l / rho_v, 0.91) * Math.pow(mu_v / mu_l, 0.19) * Math.pow(Math.max(0.01, 1 - mu_v / mu_l), 0.7);
    const rho_h = 1 / (xc / rho_v + (1 - xc) / rho_l);
    const Fr_h = (G * G) / Math.max(1e-6, 9.81 * Dh * rho_h * rho_h);
    const We_l = (G * G * Dh) / Math.max(1e-6, Math.max(1e-4, sigma_Nm) * rho_h);
    const phi2 = E + (3.24 * F * H) / (Math.pow(Math.max(1e-4, Fr_h), 0.045) * Math.pow(Math.max(1e-4, We_l), 0.035));
    return Math.max(1.0, Math.min(80, phi2));
  }

  // 일반화 ε-NTU (2상 Cr=0 / 핀-플레이트 비혼합-비혼합 직교류 / 판형 진성 역류)
  function calcEffectiveness(NTU, Cr, flowArrangement) {
    const ntu = Math.max(0, Math.min(25, NTU));
    if (ntu < 1e-9) return 0;
    const cr = Math.max(0, Math.min(1, Cr));
    if (cr < 1e-4) return 1 - Math.exp(-ntu);
    if (flowArrangement === "counterflow") {
      if (cr > 0.999) return ntu / (1 + ntu);
      const e = Math.exp(-ntu * (1 - cr));
      return (1 - e) / (1 - cr * e);
    }
    // 비혼합-비혼합 직교류 (Incropera-DeWitt / ESDU 표준식)
    const expTerm = (Math.pow(ntu, 0.22) / cr) * (Math.exp(-cr * Math.pow(ntu, 0.78)) - 1);
    return Math.min(1, Math.max(0, 1 - Math.exp(expTerm)));
  }

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

      // 물리적 튜브-핀 기하학 (임의 상수 0.18 대신 실제 플랫 튜브 폐쇄율 기반 자유단면비 산출)
      const tube_H = Dh_ref + 0.0006; // 마이크로채널 플랫 튜브 외경 높이 (벽두께 0.3mm×2)
      const n_fin_rows = Math.max(6, Math.round(N_ch * 0.5));
      const Tp = params.tube_pitch_mm ? Math.max(tube_H + 0.003, params.tube_pitch_mm * 1e-3) : Math.max(tube_H + 0.004, H / n_fin_rows);
      const fin_H = Math.max(0.004, Tp - tube_H);
      const Ll = params.louver_len_mm ? Math.min(fin_H * 0.95, Math.max(0.002, params.louver_len_mm * 1e-3)) : (0.85 * fin_H);
      const Dm = D; // 플랫 튜브 장경 = 코어 깊이 D

      const A_face = W * H;
      const free_ratio = Math.max(0.35, (1 - tube_H / Tp) * (1 - ft / Fp));
      const A_cross_sec = A_face * free_ratio;
      const n_fins = W / Fp;
      const A_fin = 2 * n_fins * fin_H * D * n_fin_rows;
      const A_tube_ext = 2 * n_fin_rows * W * D * Math.max(0.2, 1 - ft / Fp);
      const A_sec = Math.max(0.2, A_fin + A_tube_ext);
      const Af_ratio = A_fin / A_sec;
      const Dh_sec = Math.max(0.001, (2 * (Fp - ft) * fin_H) / ((Fp - ft) + fin_H));
      return {
        hxType, A_ref, A_sec, A_eff: A_sec, A_face, free_ratio,
        Dh_ref, Dh_sec, A_cross_ref, A_cross_sec, V_int_m3, L_ref, L_sec: D,
        Fp, ft, Lp, lAng, fin_H, Ll, Tp, Dm, tube_H, n_fin_rows, Af_ratio, D, k_fin: 205
      };
    }
  }

  // Martin (1996) 일반화 Lévêque 판형 상관식 (원논문 Darcy 마찰계수 ξ, 계수 0.122, 층류↔난류 연속 블렌딩)
  function evalMartinPHE(Re_s, Pr_s, betaRad, C_tune) {
    const r = Math.max(10, Re_s);
    const xi0_lam = 64 / r;
    const xi1_lam = 597 / r + 3.85;
    const xi0_turb = Math.pow(1.8 * Math.log10(Math.max(100, r)) - 1.5, -2);
    const xi1_turb = 39 / Math.pow(Math.max(100, r), 0.289);
    const w = smoothstep(1700, 2300, r);
    const xi0 = (1 - w) * xi0_lam + w * xi0_turb;
    const xi1 = (1 - w) * xi1_lam + w * xi1_turb;

    const cosB = Math.cos(betaRad);
    const invSqrtXi = cosB / Math.sqrt(0.18 * Math.tan(betaRad) + 0.36 * Math.sin(betaRad) + xi0 / Math.max(0.1, cosB))
      + (1 - cosB) / Math.sqrt(3.8 * xi1);
    const xi_darcy = Math.pow(invSqrtXi, -2);
    const Nu = C_tune * 0.122 * Math.pow(Pr_s, 1 / 3) * Math.pow(Math.max(1, xi_darcy * r * r * Math.sin(2 * betaRad)), 0.374);
    return { Nu, f_darcy: xi_darcy };
  }

  // Chang et al. (2000) 루버핀 일반화 Fanning 마찰계수 (Re_Lp<150 / >=150 연속 블렌딩 → Darcy = 4*f_F)
  function evalChang2000Friction(Re_Lp, geo) {
    const Re = Math.max(30, Re_Lp);
    const th = Math.max(10, geo.lAng);
    const Fp = geo.Fp, ft = geo.ft, Lp = geo.Lp, Fh = geo.fin_H, Fd = geo.D, Ll = geo.Ll, Tp = geo.Tp, Dm = geo.Dm, Dh = geo.Dh_sec;

    // Low-Re branch (Re_Lp < 150)
    const ln1 = Math.max(0.05, Math.log(1.0 + Fp / Lp));
    const ln2_lo = Math.max(0.05, Math.log(Math.pow(ft / Fp, 0.48) + 0.9));
    const ln3_lo = Math.max(0.2, Math.log(Math.max(2, 0.5 * Re)));
    const f1_lo = 14.39 * Math.pow(Re, -0.805 * (Fp / Fh)) * Math.pow(ln1, 3.04);
    const f2_lo = Math.pow(ln2_lo, -1.435) * Math.pow(Dh / Lp, -3.01) * Math.pow(ln3_lo, -3.01);
    const f3_lo = Math.pow(Fp / Ll, -0.308) * Math.pow(Fd / Ll, -0.308) * Math.exp(-0.1167 * (Tp / Dm)) * Math.pow(th, 0.35);
    const fF_lo = f1_lo * f2_lo * f3_lo;

    // High-Re branch (Re_Lp >= 150)
    const ln2_hi = Math.max(0.05, Math.log(Math.pow(ft / Fp, 0.5) + 0.9));
    const ln3_hi = Math.max(0.2, Math.log(Math.max(2, 0.3 * Re)));
    const ln4_hi = Math.max(0.1, Math.log(1.2 + Math.pow(Lp / Fp, 1.4)));
    const f1_hi = 4.97 * Math.pow(Re, 0.6049 - 1.064 / Math.pow(th, 0.2)) * Math.pow(ln2_hi, -0.527);
    const f2_hi = Math.pow((Dh / Lp) * ln3_hi, -2.966) * Math.pow(Fp / Ll, -0.7931 * (Tp / Fh));
    const f3_hi = Math.pow(Tp / Dm, -0.0446) * Math.pow(ln4_hi, -3.553) * Math.pow(th, -0.477);
    const fF_hi = f1_hi * f2_hi * f3_hi;

    const w = smoothstep(120, 180, Re);
    const f_fanning = Math.max(0.015, Math.min(1.5, (1 - w) * fF_lo + w * fF_hi));
    return { f_fanning, f_darcy: 4 * f_fanning };
  }

  // 외부/상대측 열전달계수 & 압력강하 계산
  function calcSecHTC(params, geo, secFluid, secProp, m_sec) {
    const mu_s = Math.max(1e-6, (secProp.mu || 18.5) * 1e-6);
    const k_s = Math.max(0.005, (secProp.k || 26) * 1e-3);
    const Cp_s = Math.max(200, (secProp.Cp || 1.006) * 1000);
    const Pr_s = Math.max(0.5, (Cp_s * mu_s) / k_s);
    const G_s = Math.max(0.2, m_sec / Math.max(1e-5, geo.A_cross_sec));
    const Re_s = Math.max(10, (G_s * geo.Dh_sec) / mu_s);

    let h_sec = 80, f_darcy = 0.05, j_val = null, corrUsed = "", warnings = [];

    if (geo.hxType === "plate") {
      const corr = params.sec_phe_corr || "martin";
      const beta = geo.beta;
      const betaRad = beta * Math.PI / 180;
      const C_tune = params.sec_corr_C || 1.0;

      if (corr === "martin" || Re_s < 1000) {
        // Martin (1996): 층류~난류 전 영역 대응. Muley-Manglik 선택 시 Re<1000이면 자동 Martin 분기!
        if (corr === "muley_manglik" && Re_s < 1000) {
          warnings.push(`판형 2차측 Re=${Re_s.toFixed(0)} < 1000 (Muley-Manglik 범위 밖) → Martin(1996) 층류 분기 자동 적용`);
        }
        const mr = evalMartinPHE(Re_s, Pr_s, betaRad, C_tune);
        h_sec = Math.max(30, (mr.Nu * k_s) / geo.Dh_sec);
        f_darcy = mr.f_darcy;
        corrUsed = "martin";
      } else {
        // Muley & Manglik (1999) 원식 Nu 및 Fanning→Darcy 마찰계수 (Re >= 1000)
        const cBeta = Math.max(0.08, 0.2668 - 0.006967 * beta + 7.244e-5 * beta * beta);
        const phi = geo.phi;
        const cPhi = Math.max(0.7, 20.78 - 50.94 * phi + 41.16 * phi * phi - 10.51 * phi * phi * phi);
        const expRe = 0.728 + 0.0543 * Math.sin((2 * Math.PI * beta) / 90 + 3.7);
        const Nu = C_tune * cBeta * cPhi * Math.pow(Re_s, expRe) * Math.pow(Pr_s, 1 / 3);
        h_sec = Math.max(30, (Nu * k_s) / geo.Dh_sec);

        // Muley-Manglik (1999) 원논문 마찰계수 f_F → Darcy f_D = 4*f_F
        const fBeta = Math.max(0.2, 2.917 - 0.1277 * beta + 2.016e-3 * beta * beta);
        const fPhi = Math.max(0.5, 5.474 - 19.02 * phi + 18.93 * phi * phi - 5.341 * phi * phi * phi);
        const expF = 0.2 + 0.0577 * Math.sin((Math.PI * beta) / 45 + 2.1);
        const f_fanning = Math.max(0.02, fBeta * fPhi * Math.pow(Re_s, -expF));
        f_darcy = 4 * f_fanning;
        corrUsed = "muley_manglik";
      }
    } else {
      // 핀-플레이트 열교환기
      if (secFluid === "Air") {
        const finType = params.fin_type || "louver";
        let h_bare;
        if (finType === "flat") {
          const C_j = params.fin_Cj_flat || 0.145;
          j_val = C_j * Math.pow(Math.max(50, Re_s), -0.38) * Math.pow(geo.Fp / geo.Dh_sec, -0.12);
          h_bare = j_val * G_s * Cp_s / Math.pow(Pr_s, 2 / 3);
          const f_fanning = 0.16 * Math.pow(Math.max(50, Re_s), -0.30);
          f_darcy = 4 * f_fanning;
          corrUsed = "wang_flat";
        } else {
          // Chang & Wang (1997) 8항 전체 루버핀 Colburn j 상관식 + Chang et al. (2000) 마찰계수
          const Re_Lp = Math.max(30, (G_s * geo.Lp) / mu_s);
          // 보정 배수: 기존 기본값 0.267 레거시 호환 처리 (신규 fin_Cj_mult 기본 1.0)
          const C_tune = (params.fin_Cj_mult !== undefined && params.fin_Cj_mult !== null)
            ? Math.max(0.1, Number(params.fin_Cj_mult))
            : ((params.fin_Cj !== undefined && Math.abs(params.fin_Cj - 0.267) > 1e-4 && params.fin_Cj >= 0.4) ? Number(params.fin_Cj) : 1.0);

          j_val = C_tune
            * Math.pow(Re_Lp, -0.49)
            * Math.pow(geo.lAng / 90, 0.27)
            * Math.pow(geo.Fp / geo.Lp, -0.14)
            * Math.pow(geo.fin_H / geo.Lp, -0.29)
            * Math.pow(geo.D / geo.Lp, -0.23)
            * Math.pow(geo.Ll / geo.Lp, 0.68)
            * Math.pow(geo.Tp / geo.Lp, -0.28)
            * Math.pow(geo.ft / geo.Lp, -0.05);
          h_bare = j_val * G_s * Cp_s / Math.pow(Pr_s, 2 / 3);

          const ch = evalChang2000Friction(Re_Lp, geo);
          f_darcy = ch.f_darcy;
          corrUsed = "chang_wang_1997";
          if (Re_Lp < 100 || Re_Lp > 3000) {
            warnings.push(`루버핀 Re_Lp=${Re_Lp.toFixed(0)} (권장 적용범위 100~3000)`);
          }
        }
        const m_fin = Math.sqrt((2 * Math.max(5, h_bare)) / (geo.k_fin * geo.ft));
        const mL = Math.max(0.05, m_fin * (geo.fin_H / 2));
        const eta_fin = Math.tanh(mL) / mL;
        const eta_o = 1 - geo.Af_ratio * (1 - eta_fin);
        h_sec = Math.max(10, h_bare * eta_o);
      } else {
        // 단상 액체/기체 관외 대류 (Gnielinski + 층류 연속 천이)
        const f_ch = churchillFriction(Re_s, 1e-4);
        const Nu_lam = 4.36;
        const Nu_turb = ((f_ch / 8) * (Math.max(2500, Re_s) - 1000) * Pr_s) / (1 + 12.7 * Math.sqrt(f_ch / 8) * (Math.pow(Pr_s, 2 / 3) - 1));
        const w = smoothstep(2100, 3200, Re_s);
        const Nu_s = (1 - w) * Nu_lam + w * Nu_turb;
        h_sec = Math.max(50, (Nu_s * k_s) / geo.Dh_sec);
        f_darcy = f_ch;
        corrUsed = "gnielinski";
      }
    }

    // 코어 마찰 압력강하 + 핀-플레이트 공기측 입출구 수축/팽창 부차손실(K_c + K_e)
    const q_dyn = (G_s * G_s) / (2 * Math.max(0.2, secProp.rho));
    const K_io = (geo.hxType === "fin_plate" && secFluid === "Air") ? (0.4 * (1 - geo.free_ratio) + Math.pow(1 - geo.free_ratio, 2)) : 0;
    const dP_sec_Pa = Math.min(80000, (f_darcy * (geo.L_sec / geo.Dh_sec) + K_io) * q_dyn);
    return { h_sec, Re_s, f_darcy, j_val, dP_sec_Pa, corrUsed, warnings };
  }

  // 팬 운전점 해석과 완벽 일치시키기 위한 공기측 ΔP(Q_m3min) 함수
  function calcAirPressureDrop(params, Q_m3min, T_amb_C = 35, fluidTableDB = null) {
    const geo = calcGeometry(params);
    const secProp = getSecProps("Air", T_amb_C, 1.01325, fluidTableDB);
    const m_air = Math.max(0.005, (Math.max(0.1, Q_m3min) / 60) * secProp.rho);
    const secInfo = calcSecHTC(params, geo, "Air", secProp, m_air);
    // 팬-쉬라우드/그릴 부차손실 계수 (기본 0.35 * 면유속 동압, 사용자 조절 가능)
    const v_face = (Q_m3min / 60) / Math.max(0.02, geo.A_face || geo.A_cross_sec);
    const K_shroud = params.K_shroud !== undefined ? Math.max(0, Number(params.K_shroud)) : 0.35;
    const dP_shroud = K_shroud * 0.5 * secProp.rho * v_face * v_face;
    return { dP_total_Pa: secInfo.dP_sec_Pa + dP_shroud, dP_core_Pa: secInfo.dP_sec_Pa, dP_shroud_Pa: dP_shroud, airRho: secProp.rho };
  }

  // 단상 냉매측 열전달계수: Gnielinski(1976) + 층류(Nu=4.36) 매끄러운 블렌딩 (불연속 제거!)
  function calcSinglePhaseRefHTC(Re, Pr, k, Dh, hxType, betaRad) {
    if (hxType === "plate") {
      const mr = evalMartinPHE(Re, Pr, betaRad, 1.0);
      return Math.max(80, (mr.Nu * k) / Dh);
    }
    const f = churchillFriction(Re, 1e-4);
    const Nu_lam = 4.36;
    const Re_t = Math.max(2500, Re);
    const Nu_turb = ((f / 8) * (Re_t - 1000) * Pr) / (1 + 12.7 * Math.sqrt(f / 8) * (Math.pow(Pr, 2 / 3) - 1));
    const w = smoothstep(2000, 3500, Re);
    const Nu = (1 - w) * Nu_lam + w * Nu_turb;
    return Math.max(80, (Nu * k) / Dh);
  }

  // 국소 냉매측 2상 열전달계수 계산 (Shah / Cavallini / Kim-Mudawar / Han-Lee-Kim / Amalfi 2016 / Hsieh-Lin / 수정 Yan-Lin)
  function calcTwoPhaseRefHTC(st, sat, G_ref, Dh, params, isCondenser, qFlux_Wm2, fluidName, refProp, warnSet) {
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
      } else if (corr === "kim_mudawar") {
        // Kim & Mudawar (2013) 미니/마이크로채널 환상류 응축 상관식
        const Re_l = Math.max(10, (G_ref * (1 - x) * Dh) / mu_l);
        const X_tt = Math.pow((1 - x) / x, 0.9) * Math.pow(sat.rho_g / Math.max(1, sat.rho_f), 0.5) * Math.pow(mu_l / mu_v, 0.1);
        const phi_g = Math.sqrt(1 + 12 * X_tt + X_tt * X_tt);
        const Re_vo = Math.max(10, (G_ref * Dh) / mu_v);
        const Su_go = (sat.rho_g * (refProp ? refProp.getSurfaceTension(st.P) : 0.008) * Dh) / (mu_v * mu_v);
        const Nu_ann = 0.048 * Math.pow(Re_l, 0.69) * Math.pow(Pr_l, 0.34) * (phi_g / Math.max(0.05, X_tt));
        const Nu_slug = Math.pow(Math.pow(0.048 * Math.pow(Re_l, 0.69) * Math.pow(Pr_l, 0.34) * (phi_g / Math.max(0.05, X_tt)), 2)
          + Math.pow(3.2e-7 * Math.pow(Re_l, -0.38) * Math.pow(Math.max(1, Su_go), 1.39), 2), 0.5);
        const We_star = (Re_vo > 1250)
          ? 2.45 * (Math.pow(Re_vo, 0.64) / Math.pow(Math.max(1, Su_go), 0.3)) * Math.pow(X_tt / (1 + 1.09 * Math.pow(X_tt, 0.039)), 0.4)
          : 0.48 * Math.pow(Re_vo, 0.64) / Math.pow(Math.max(1, Su_go), 0.3);
        const w = smoothstep(5, 10, We_star);
        const Nu = C_ref * ((1 - w) * Nu_slug + w * Nu_ann);
        return Math.max(200, Math.min(35000, (Nu * k_l) / Dh));
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
      // 증발 상관식 (기본값: Han-Lee-Kim 2003, 옵션: Amalfi 2016 / Hsieh-Lin 2002 / 수정 Yan-Lin 1999)
      const corr = params.ref_evap_corr || "han_lee_kim";
      const densFac = (1 - x) + x * Math.sqrt(sat.rho_f / Math.max(0.5, sat.rho_g));
      const G_eq = G_ref * densFac;
      const Re_eq = Math.max(20, (G_eq * Dh) / mu_l);
      const q_eff = Math.max(400, qFlux_Wm2);
      const Bo_eq = Math.max(1e-6, q_eff / (G_eq * h_fg_J));
      const Bo = Math.max(1e-6, q_eff / (G_ref * h_fg_J));

      if (corr === "amalfi_2016") {
        // Amalfi, Vakili-Farahani & Thome (2016) PHE 일반화 증발 상관식 (Bd=4 연속 천이)
        const sigma = refProp ? refProp.getSurfaceTension(st.P) : 0.010;
        const beta = Math.min(75, Math.max(20, params.chevron_deg || 60));
        const betaStar = beta / 70.0;
        const rhoRatio = sat.rho_f / Math.max(0.5, sat.rho_g);
        const Bd = ((sat.rho_f - sat.rho_g) * 9.81 * Dh * Dh) / Math.max(1e-4, sigma);
        const rho_m = 1 / (x / sat.rho_g + (1 - x) / sat.rho_f);
        const We_m = (G_ref * G_ref * Dh) / Math.max(1e-5, rho_m * sigma);
        const Re_v = Math.max(10, (G_ref * x * Dh) / mu_v);

        const Nu_micro = 982 * Math.pow(betaStar, 1.101) * Math.pow(Math.max(1e-3, We_m), 0.315) * Math.pow(Bo, 0.320) * Math.pow(rhoRatio, -0.224);
        const Nu_macro = 18.495 * Math.pow(betaStar, 0.248) * Math.pow(Re_v, 0.135) * Math.pow(Re_LO, 0.351) * Math.pow(Math.max(0.1, Bd), 0.235) * Math.pow(Bo, 0.198) * Math.pow(rhoRatio, -0.223);
        const w = smoothstep(3.0, 5.0, Bd);
        const Nu = C_ref * ((1 - w) * Nu_micro + w * Nu_macro);
        return Math.max(200, Math.min(25000, (Nu * k_l) / Dh));
      } else if (corr === "hsieh_lin") {
        const h_l = 0.2092 * (k_l / Dh) * Math.pow(Re_LO, 0.78) * Math.pow(Pr_l, 1 / 3);
        return Math.max(200, Math.min(25000, C_ref * h_l * 88 * Math.pow(Bo, 0.5)));
      } else if (corr === "yan_lin") {
        // Yan & Lin (1999) 원논문 식: Nu = 1.926 * Pr_l^(1/3) * Bo_eq^0.3 * Re_l^0.5 * [(1-x) + x*(rho_l/rho_v)^0.5]
        // (수학적으로 1.926 * Pr_l^(1/3) * Bo_eq^0.3 * Re_eq^0.5 * densFac^0.5 와 동일)
        if (warnSet && (Re_eq < 2000 || G_ref < 50)) {
          warnSet.yanLinOutOfRange = true;
          warnSet.yanLinG = G_ref;
          warnSet.yanLinMinRe = Math.min(warnSet.yanLinMinRe ?? Infinity, Re_eq);
        }
        const Nu = C_ref * 1.926 * Math.pow(Re_LO, 0.5) * densFac * Math.pow(Pr_l, 1 / 3) * Math.pow(Bo_eq, 0.3);
        return Math.max(200, Math.min(25000, (Nu * k_l) / Dh));
      } else if (corr === "dittus") {
        const Nu = C_ref * 0.023 * Math.pow(Re_LO, 0.8) * Math.pow(Pr_l, 0.4);
        return Math.max(150, (Nu * k_l) / Dh);
      } else {
        // Han, Lee & Kim (2003) — PHX 증발 기본 권장 상관식
        const betaRad = Math.min(75, Math.max(20, params.chevron_deg || 60)) * Math.PI / 180;
        const p_co = Math.max(0.002, (params.corr_pitch_mm || 7.0) * 1e-3);
        const ratio = p_co / Math.max(0.001, Dh);
        const Ge1 = 2.81 * Math.pow(ratio, -0.041) * Math.pow(Math.max(0.15, Math.PI / 2 - betaRad), -2.83);
        const Ge2 = 0.746 * Math.pow(ratio, -0.082) * Math.pow(Math.max(0.15, Math.PI / 2 - betaRad), 0.61);
        const Nu = C_ref * Math.min(80, Ge1) * Math.pow(Re_eq, Math.min(0.95, Ge2)) * Math.pow(Bo_eq, 0.3) * Math.pow(Pr_l, 0.4);
        return Math.max(200, Math.min(25000, (Nu * k_l) / Dh));
      }
    }
  }

  // 상경계(x=0, x=1) 매끄러운 블렌딩을 포함한 국소 냉매측 HTC
  function calcLocalRefHTC(st, sat, G_ref, Dh, params, isCondenser, qFlux_Wm2, fluidName, refProp, warnSet) {
    const mu = Math.max(1e-6, (st.mu || 120) * 1e-6);
    const k = Math.max(0.005, (st.k || 65) * 1e-3);
    const Cp = Math.max(200, (st.Cp || 1.2) * 1000);
    const Pr = Math.max(0.5, (Cp * mu) / k);
    const Re = Math.max(10, (G_ref * Dh) / mu);
    const betaRad = Math.min(75, Math.max(20, params.chevron_deg || 60)) * Math.PI / 180;

    const h_sp = calcSinglePhaseRefHTC(Re, Pr, k, Dh, params.hxType || "fin_plate", betaRad);
    if (!sat || st.x <= 1e-4 || st.x >= 1 - 1e-4) return h_sp;

    const h_tp = calcTwoPhaseRefHTC(st, sat, G_ref, Dh, params, isCondenser, qFlux_Wm2, fluidName, refProp, warnSet);
    // 건도 0~0.03 및 0.97~1.0 구간 smoothstep 블렌딩 → 상경계 미분 연속성 확보!
    const wLo = smoothstep(0.0, 0.03, st.x);
    const wHi = smoothstep(0.0, 0.03, 1.0 - st.x);
    const wTP = wLo * wHi;
    return (1 - wTP) * h_sp + wTP * h_tp;
  }

  // 단일 서브-세그먼트 열전달 계산 (일반 Cr ε-NTU + 제2법칙 엄격 강제)
  function solveSubSegmentHeat(stIn, satSeg, P_cur, UA_sub, C_sec_sub, T_sec_in_local, m_ref, isCondenser, flowArrangement, refProp) {
    const dT_drive = isCondenser ? Math.max(0, stIn.T - T_sec_in_local) : Math.max(0, T_sec_in_local - stIn.T);
    if (dT_drive <= 1e-7 || UA_sub <= 1e-9) return 0;

    const isTwoPhase = !!(satSeg && stIn.x > 0 && stIn.x < 1);
    let C_min, Cr;
    if (isTwoPhase) {
      C_min = C_sec_sub;
      Cr = 0;
    } else {
      const C_ref = Math.max(1e-5, m_ref * Math.max(0.2, stIn.Cp));
      C_min = Math.min(C_sec_sub, C_ref);
      const C_max = Math.max(C_sec_sub, C_ref);
      Cr = C_min / Math.max(1e-9, C_max);
    }
    const NTU = UA_sub / Math.max(1e-6, C_min);
    const eff = calcEffectiveness(NTU, Cr, flowArrangement);
    let Q_sub = eff * C_min * dT_drive;

    // 제2법칙 상한 강제: 냉매 출구온도가 2차유체 입구온도를 절대 교차(Cross)할 수 없음!
    const stAtSecIn = refProp.solvePT(P_cur, T_sec_in_local);
    const Q_max_ref = isCondenser
      ? m_ref * Math.max(0, stIn.h - stAtSecIn.h)
      : m_ref * Math.max(0, stAtSecIn.h - stIn.h);
    const Q_max_sec = C_sec_sub * dT_drive;
    const Q_cap = Math.min(Q_max_ref, Q_max_sec);
    if (Q_sub > Q_cap) Q_sub = Q_cap;
    return Math.max(0, Q_sub);
  }

  // 세그먼트 1개 계산 (상경계 분할 + 증발 국소 열유속 Bo 내부반복 + 제2법칙 보장)
  function solveOneSegment(idx, h_cur, P_cur, T_sec_in_local, C_sec_seg, m_ref, G_ref, geo, params, refProp, isCondenser, secMode, method, h_sec_Wm2K, C_sec_total, N_SEG, flowArrangement, qFluxInit, fluidName, warnSet) {
    const stSeg = refProp.evalPH(P_cur, h_cur);
    const satSeg = refProp.kind === "two_phase" ? refProp.getSatAtP(P_cur) : null;
    const A_seg_ref = Math.max(1e-5, geo.A_ref / N_SEG);
    const hxType = geo.hxType;

    // 국소 열유속 Bo 내부 반복 (증발 2상 구간 최대 6회, <1e-5 상대수렴 시 조기종료 → 뉴턴 야코비안 노이즈 제거)
    const isEvapTwoPhase = (!isCondenser && method === "GEO" && satSeg && stSeg.x > 0.005 && stSeg.x < 0.995 && secMode !== "const_Q");
    const nBoIter = isEvapTwoPhase ? 6 : 1;
    let qFlux = Math.max(500, qFluxInit);
    let Q_seg = 0, UA_seg = 0, h_ref_seg = 1500;

    for (let bi = 0; bi < nBoIter; bi++) {
      if (method === "GEO") {
        h_ref_seg = calcLocalRefHTC(stSeg, satSeg, G_ref, geo.Dh_ref, params, isCondenser, qFlux, fluidName, refProp, warnSet);
        if (hxType === "plate") {
          const R_wall = geo.tp / geo.kp;
          const U_seg = 1 / (1 / h_ref_seg + R_wall + 1 / h_sec_Wm2K);
          UA_seg = (U_seg * (geo.A_eff / N_SEG)) / 1000;
        } else {
          const R_r = 1 / (h_ref_seg * A_seg_ref);
          const R_s = 1 / (h_sec_Wm2K * (geo.A_sec / N_SEG));
          UA_seg = (1 / (R_r + R_s)) / 1000;
        }
      } else if (method === "NTU") {
        UA_seg = ((Math.max(0.05, params.NTU_val || 1.2) * C_sec_total) / N_SEG);
      } else if (method === "CORR") {
        const mu_r = Math.max(1e-6, (stSeg.mu || 150) * 1e-6), k_r = Math.max(0.005, (stSeg.k || 75) * 1e-3), Cp_r = Math.max(200, (stSeg.Cp || 1.2) * 1000);
        const Pr_r = Math.max(0.5, (Cp_r * mu_r) / k_r), Re_r = Math.max(10, (G_ref * geo.Dh_ref) / mu_r);
        h_ref_seg = ((params.corr_C || 0.023) * Math.pow(Re_r, params.corr_m || 0.8) * Math.pow(Pr_r, params.corr_n || 0.4) * k_r) / geo.Dh_ref;
        const U_seg = 1 / (1 / Math.max(20, h_ref_seg) + 1 / Math.max(10, params.h_air_Wm2K || 80));
        UA_seg = (U_seg * (Math.max(0.05, params.area_m2 || 12.0) / N_SEG)) / 1000;
      } else {
        UA_seg = Math.max(0.01, params.UA_kWK || 1.2) / N_SEG;
      }

      if (secMode === "const_Q") {
        Q_seg = Math.abs(params.Q_source_kW ?? -5.0) / N_SEG;
      } else {
        // 1차 계산
        Q_seg = solveSubSegmentHeat(stSeg, satSeg, P_cur, UA_seg, C_sec_seg, T_sec_in_local, m_ref, isCondenser, flowArrangement, refProp);
        // 상경계(h_f 또는 h_g) 통과 시 2분할 서브-세그먼트 적분 (2상 Cr=0 + 단상 일반 Cr 정확 반영!)
        if (satSeg && Q_seg > 1e-6) {
          const h_tent = isCondenser ? (h_cur - Q_seg / m_ref) : (h_cur + Q_seg / m_ref);
          let h_bound = null;
          if (isCondenser && h_cur > satSeg.h_g && h_tent < satSeg.h_g) h_bound = satSeg.h_g;
          else if (isCondenser && h_cur > satSeg.h_f && h_tent < satSeg.h_f) h_bound = satSeg.h_f;
          else if (!isCondenser && h_cur < satSeg.h_g && h_tent > satSeg.h_g) h_bound = satSeg.h_g;
          else if (!isCondenser && h_cur < satSeg.h_f && h_tent > satSeg.h_f) h_bound = satSeg.h_f;

          if (h_bound !== null) {
            const Q1 = m_ref * Math.abs(h_cur - h_bound);
            const frac1 = Math.min(1.0, Math.max(0.0, Q1 / Math.max(1e-12, Q_seg)));
            const frac2 = 1.0 - frac1;
            let Q2 = 0;
            if (frac2 > 1e-9) {
              const stBound = refProp.evalPH(P_cur, h_bound + (isCondenser ? -1e-5 : 1e-5));
              const C_sec_2 = flowArrangement === "counterflow" ? C_sec_seg : (C_sec_seg * frac2);
              Q2 = solveSubSegmentHeat(stBound, satSeg, P_cur, UA_seg * frac2, C_sec_2, T_sec_in_local, m_ref, isCondenser, flowArrangement, refProp);
            }
            Q_seg = Q1 + Q2;
          }
        }
      }

      if (isEvapTwoPhase) {
        const qNew = Math.max(400, (Q_seg * 1000) / A_seg_ref);
        const relDiff = Math.abs(qNew - qFlux) / Math.max(100, qFlux);
        qFlux = 0.65 * qNew + 0.35 * qFlux;
        if (relDiff < 1e-5 && bi >= 1) break;
      }
    }

    const h_next = isCondenser ? (h_cur - Q_seg / m_ref) : (h_cur + Q_seg / m_ref);
    const T_sec_out_local = isCondenser ? (T_sec_in_local + Q_seg / C_sec_seg) : (T_sec_in_local - Q_seg / C_sec_seg);

    // 세그먼트 마찰 압력강하 (단상 Churchill / 2상 Friedel 증배계수, 불필요한 4% 클램프 제거!)
    let dP_f_seg = (params.dP_bar || 0.2) / N_SEG;
    if (params.auto_dP !== false) {
      const mu_r = Math.max(1e-6, (stSeg.mu || 120) * 1e-6);
      const Re_r = Math.max(10, (G_ref * geo.Dh_ref) / mu_r);
      let f_lo;
      if (hxType === "plate") {
        const mr = evalMartinPHE(Re_r, 3.0, geo.beta * Math.PI / 180, 1.0);
        f_lo = mr.f_darcy;
      } else {
        f_lo = churchillFriction(Re_r, 5e-4);
      }
      if (satSeg && stSeg.x > 0.005 && stSeg.x < 0.995) {
        const Re_lo = Math.max(10, (G_ref * geo.Dh_ref) / Math.max(1e-6, satSeg.mu_f * 1e-6));
        const f_l_only = hxType === "plate"
          ? evalMartinPHE(Re_lo, 3.0, geo.beta * Math.PI / 180, 1.0).f_darcy
          : churchillFriction(Re_lo, 5e-4);
        const sigma = refProp.getSurfaceTension ? refProp.getSurfaceTension(P_cur) : 0.010;
        const phi2 = friedelMultiplier(G_ref, geo.Dh_ref, stSeg.x, satSeg, sigma);
        const wTP = smoothstep(0.0, 0.03, stSeg.x) * smoothstep(0.0, 0.03, 1 - stSeg.x);
        const dP_tp = (f_l_only * ((geo.L_ref / N_SEG) / geo.Dh_ref) * G_ref * G_ref * phi2) / (2 * Math.max(10, satSeg.rho_f) * 1e5);
        const dP_sp = (f_lo * ((geo.L_ref / N_SEG) / geo.Dh_ref) * G_ref * G_ref) / (2 * Math.max(1.0, stSeg.rho) * 1e5);
        dP_f_seg = (1 - wTP) * dP_sp + wTP * dP_tp;
      } else {
        dP_f_seg = (f_lo * ((geo.L_ref / N_SEG) / geo.Dh_ref) * G_ref * G_ref) / (2 * Math.max(1.0, stSeg.rho) * 1e5);
      }
    }

    const dP_seg_safe = Math.min(P_cur * 0.25, Math.max(0, dP_f_seg));
    const P_next = Math.max(0.5, P_cur - dP_seg_safe);
    const stNext = refProp.evalPH(P_next, h_next);

    // 제2법칙 위반 검사 (단, 고정열부하 모드는 제외)
    let seg2ndLawViol = false;
    if (secMode !== "const_Q") {
      if (isCondenser && stNext.T < T_sec_in_local - 0.05) seg2ndLawViol = true;
      if (!isCondenser && stNext.T > T_sec_in_local + 0.05) seg2ndLawViol = true;
    }

    // Zivi 기공률 질량 적분
    const rho_inv = (stSeg.x > 0 && stSeg.x < 1) ? refProp.voidFractionDensity(P_cur, stSeg.x) : stSeg.rho;
    const rho_inv_n = (stNext.x > 0 && stNext.x < 1) ? refProp.voidFractionDensity(P_next, stNext.x) : stNext.rho;
    const seg_mass_kg = (geo.V_int_m3 / N_SEG) * 0.5 * (rho_inv + rho_inv_n);

    return {
      idx, h_next, P_next, stSeg, stNext,
      Q_seg, UA_seg, h_ref_seg, qFlux,
      T_sec_in_local, T_sec_out_local,
      dP_f_seg: dP_seg_safe, seg_mass_kg, seg2ndLawViol
    };
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
    const G_ref = Math.max(1.0, m_ref / Math.max(1e-6, geo.A_cross_ref));
    const method = params.method || "GEO";

    const secInfo = calcSecHTC(params, geo, secFluid, secProp, m_sec);
    const h_sec_Wm2K = secInfo.h_sec;
    const warnList = [...(secInfo.warnings || [])];
    const warnMeta = { yanLinOutOfRange: false, yanLinG: 0, yanLinMinRe: Infinity };

    const isCondenser = secMode === "const_Q" ? ((params.Q_source_kW ?? -5) < 0) : (inS.T_sat_C >= T_sec_in);
    const role = isCondenser ? "응축기 (방열)" : "증발기 (흡열)";

    // 20-세그먼트 이산화 (핀-플레이트: 직교류 / 판형 PHX: 진성 역류 Counter-flow!)
    const N_SEG = 20;
    const isCounterFlow = (hxType === "plate" && secMode !== "const_Q");
    const flowArrangement = isCounterFlow ? "counterflow" : "crossflow";
    const qFluxInit = Math.max(1500, (params.Q_est_kW || 8.0) * 1000 / Math.max(0.05, geo.A_ref));

    let segments = [];
    let h_cur = inS.h_kJkg, P_cur = inS.P_bar;
    let Q_total = 0, UA_sum = 0, h_ref_sum = 0, mass_total_kg = 0, dP_f_total = 0;
    let T_sec_out = T_sec_in;
    let secondLawViolated = false;

    if (isCounterFlow) {
      // 판형 HX 진성 역류(Counter-flow): 2차유체가 세그먼트 N(입구 T_sec_in) → 0(출구 T_sec_out)로 전 유량 C_sec 흐름!
      // 내부 반복으로 T_sec[0..N] 온도 분포 1e-6 K 정밀 수렴 (뉴턴 유한차분 노이즈 제거!)
      const T_sec_node = new Array(N_SEG + 1).fill(T_sec_in);
      const qFluxPrev = new Array(N_SEG).fill(qFluxInit);

      for (let sweep = 0; sweep < 26; sweep++) {
        segments = [];
        h_cur = inS.h_kJkg; P_cur = inS.P_bar;
        Q_total = 0; UA_sum = 0; h_ref_sum = 0; mass_total_kg = 0; dP_f_total = 0;
        secondLawViolated = false;
        const Q_arr = new Array(N_SEG).fill(0);

        for (let i = 0; i < N_SEG; i++) {
          const T_sec_in_seg = T_sec_node[i + 1];
          const r = solveOneSegment(i, h_cur, P_cur, T_sec_in_seg, C_sec, m_ref, G_ref, geo, params, refProp, isCondenser, secMode, method, h_sec_Wm2K, C_sec, N_SEG, "counterflow", qFluxPrev[i], inS.fluid, warnMeta);
          Q_arr[i] = r.Q_seg;
          qFluxPrev[i] = r.qFlux;
          segments.push({
            idx: i, T_ref_in: r.stSeg.T, T_ref_out: r.stNext.T, x_mid: 0.5 * (r.stSeg.x + r.stNext.x),
            T_sec_in: T_sec_in_seg, T_sec_out: r.T_sec_out_local, h_ref: r.h_ref_seg, Q_seg: r.Q_seg, phase: r.stSeg.phase
          });
          Q_total += r.Q_seg;
          UA_sum += r.UA_seg;
          h_ref_sum += r.h_ref_seg;
          mass_total_kg += r.seg_mass_kg;
          dP_f_total += r.dP_f_seg;
          if (r.seg2ndLawViol) secondLawViolated = true;
          h_cur = r.h_next;
          P_cur = r.P_next;
        }

        const T_sec_new = new Array(N_SEG + 1);
        T_sec_new[N_SEG] = T_sec_in;
        for (let i = N_SEG - 1; i >= 0; i--) {
          T_sec_new[i] = isCondenser
            ? (T_sec_new[i + 1] + Q_arr[i] / C_sec)
            : (T_sec_new[i + 1] - Q_arr[i] / C_sec);
        }
        let maxDiff = 0;
        const relax = sweep < 2 ? 0.7 : 0.85;
        for (let i = 0; i < N_SEG; i++) {
          const diff = Math.abs(T_sec_new[i] - T_sec_node[i]);
          if (diff > maxDiff) maxDiff = diff;
          T_sec_node[i] = T_sec_node[i] + relax * (T_sec_new[i] - T_sec_node[i]);
        }
        T_sec_out = T_sec_new[0];
        if (maxDiff < 1e-6 && sweep >= 2) break;
      }
      for (let i = 0; i < N_SEG; i++) {
        segments[i].T_sec_in = T_sec_node[i + 1];
        segments[i].T_sec_out = T_sec_node[i];
      }
    } else {
      const C_sec_seg = C_sec / N_SEG;
      let T_sec_out_acc = 0;
      let qLast = qFluxInit;
      for (let i = 0; i < N_SEG; i++) {
        const r = solveOneSegment(i, h_cur, P_cur, T_sec_in, C_sec_seg, m_ref, G_ref, geo, params, refProp, isCondenser, secMode, method, h_sec_Wm2K, C_sec, N_SEG, "crossflow", qLast, inS.fluid, warnMeta);
        qLast = r.qFlux;
        segments.push({
          idx: i, T_ref_in: r.stSeg.T, T_ref_out: r.stNext.T, x_mid: 0.5 * (r.stSeg.x + r.stNext.x),
          T_sec_in, T_sec_out: r.T_sec_out_local, h_ref: r.h_ref_seg, Q_seg: r.Q_seg, phase: r.stSeg.phase
        });
        Q_total += r.Q_seg;
        UA_sum += r.UA_seg;
        h_ref_sum += r.h_ref_seg;
        mass_total_kg += r.seg_mass_kg;
        dP_f_total += r.dP_f_seg;
        T_sec_out_acc += r.T_sec_out_local;
        if (r.seg2ndLawViol) secondLawViolated = true;
        h_cur = r.h_next;
        P_cur = r.P_next;
      }
      T_sec_out = T_sec_out_acc / N_SEG;
    }

    if (warnMeta.yanLinOutOfRange) {
      warnList.push(`Yan-Lin(1999) 적용범위 주의 (G=${warnMeta.yanLinG.toFixed(1)} kg/m²s, 최소 Re_eq=${warnMeta.yanLinMinRe.toFixed(0)} < 2000; Han-Lee-Kim 또는 Amalfi 권장)`);
    }

    const stOutPre = refProp.evalPH(P_cur, h_cur);
    let dP_acc_bar = 0, dP_bar = Math.max(0.002, inS.P_bar - P_cur), dP_clamped = false;
    if (params.auto_dP !== false) {
      dP_acc_bar = (G_ref * G_ref * (1 / Math.max(1.0, stOutPre.rho) - 1 / Math.max(1.0, inS.rho || 30))) / 1e5;
      const dP_raw = dP_f_total + dP_acc_bar;
      const dP_max_safe = inS.P_bar * 0.35;
      if (dP_raw > dP_max_safe) { dP_clamped = true; warnList.push(`HX 냉매 ΔP 안전상한 도달 (${dP_raw.toFixed(2)} bar)`); }
      dP_bar = Math.max(0.005, Math.min(dP_max_safe, dP_raw));
    } else {
      dP_bar = params.dP_bar || 0.2;
      dP_f_total = dP_bar;
    }

    const P_out = Math.max(0.5, inS.P_bar - dP_bar);
    const stOut = refProp.evalPH(P_out, h_cur);

    // 전체 HX 제2법칙 최종 검증
    if (secMode !== "const_Q") {
      if (isCondenser && (stOut.T < T_sec_in - 0.05 || T_sec_out > inS.T_C + 0.05)) secondLawViolated = true;
      if (!isCondenser && (stOut.T > T_sec_in + 0.05 || T_sec_out < inS.T_C - 0.05)) secondLawViolated = true;
    }

    // SVG 6-존 시각화 호환용 6구간 집계 배열
    const segments6 = [];
    for (let z = 0; z < 6; z++) {
      const i0 = Math.floor((z * N_SEG) / 6);
      const i1 = Math.max(i0 + 1, Math.floor(((z + 1) * N_SEG) / 6));
      const slice = segments.slice(i0, i1);
      const qZ = slice.reduce((a, s) => a + s.Q_seg, 0);
      const tSecOutZ = isCounterFlow ? slice[0].T_sec_out : (slice.reduce((a, s) => a + s.T_sec_out, 0) / slice.length);
      segments6.push({
        idx: z,
        T_ref_in: slice[0].T_ref_in,
        T_ref_out: slice[slice.length - 1].T_ref_out,
        T_sec_in: isCounterFlow ? slice[slice.length - 1].T_sec_in : T_sec_in,
        T_sec_out: tSecOutZ,
        Q_seg: qZ
      });
    }

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
        hxType, hxTypeLabel: hxType === "plate" ? "판형 (PHE · 역류)" : "핀-플레이트 (직교류)",
        flowArrangement,
        nSegments: N_SEG,
        finType: params.fin_type || "louver",
        secFluid, secMode, T_sec_in, m_sec_kgs: m_sec, T_air_out: T_sec_out, T_sec_out,
        Cp_sec, rho_sec: secProp.rho,
        role, isCondenser, method,
        Q_kW: Q_total, UA_eff: UA_sum, U_Wm2K, NTU, effectiveness: calcEffectiveness(NTU, 0, flowArrangement),
        h_ref_Wm2K: h_ref_avg, h_sec_Wm2K,
        Re_sec: secInfo.Re_s, j_sec: secInfo.j_val, secCorrUsed: secInfo.corrUsed,
        A_ref_m2: geo.A_ref, A_sec_m2: geo.A_sec, V_int_L: geo.V_int_m3 * 1000,
        dP_bar, dP_f_bar: dP_f_total, dP_acc_bar, dP_sec_Pa: secInfo.dP_sec_Pa,
        dP_clamped,
        secondLawViolated,
        warnings: [...new Set(warnList)],
        mass_kg: mass_total_kg, segments, segments6,
        phase: stOut.phase, quality: stOut.x, SC: stOut.SC, SH: stOut.SH
      }
    };
  }

  global.HXModule = {
    run, calcGeometry, calcSecHTC, calcAirPressureDrop, getSecProps,
    churchillFriction, friedelMultiplier, calcEffectiveness, P_CRIT_MAP
  };
})(window);
