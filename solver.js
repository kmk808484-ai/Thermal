// solver.js — 지배방정식(3대 보존법칙) + 전역 Newton-Raphson(Armijo 라인서치) 결합 솔버
// 개선: 밸브 ΔP→ṁ 역방향 결합(무지연 TXV), 4변수 전역 뉴턴(P1,P2,h1,P4), 수동충전량 상태 구속,
//       엄격한 수렴판정(질량·에너지 1e-4·모멘텀·제2법칙), Churchill/Friedel/Zivi 배관모델(0.15bar 상한 제거),
//       팬-HX 직접 ΔP 연동, 연속법(Warm-Start), 반복별 보존/잔차 마일스톤 추적
(function (global) {
  const GOVERNING_DOCS = {
    mass: "질량보존 (Mass & Charge): 압축기-팽창밸브 질량유량 연속(ṁ_comp = ṁ_valve) 및 수동모드 총 충전량 상태구속(ΣM_i = M_charge) / 자동모드 설계과냉도(SC_target) 기반 충전량 산정",
    energy: "에너지보존 (1st Law Energy): 폐회로 엔탈피 폐합(h_fb = h_1) 및 Q_cond + Q_loss = Q_evap + W_gas_net (상대잔차 ≤ 0.01%) 엄격 검증 + 제2법칙(온도교차 금지) 검사",
    momentum: "모멘텀보존 (Momentum ΔP): Churchill/Friedel 배관 손실, 20-세그먼트 HX ΔP, 밸브 ΔP(HEM 초크 포함), 탱크 노즐 손실의 폐회로 압력 폐합(ΔP_comp = ΣΔP_loop)"
  };

  const NUMERICAL_DOCS = {
    newton_secant: {
      name: "전역 Newton-Raphson + Armijo 라인서치 (권장)",
      formula: "J(x_k)·Δx_k = −R(x_k),  x_{k+1} = Π_box(x_k + λ·Δx_k),  x = [P1, P2, h1, P4]",
      pros: "질량유량(ṁ_comp=ṁ_valve)·에너지(h_fb=h_1)·모멘텀(P_fb=P1)·충전/과냉 구속을 4×4 야코비안으로 동시 연립 풀이하여 TXV·오리피스·수동충전 모두 5~10회 내 2차 수렴합니다.",
      tip: "모든 회로(TXV, 오리피스, 수동충전)에서 기본 권장 알고리즘입니다."
    },
    fixed_point: {
      name: "안정화 고정점 완화법 (Damped Picard)",
      formula: "x_{k+1} = x_k − α · D⁻¹ · R(x_k)  (밸브 역방향 ΔP→ṁ 대각 민감도 적용)",
      pros: "밸브 유량 역방향 결합과 대각 야코비안 스케일링으로 기존 P1 발산 문제를 해소한 안정적 선형 수렴 기법입니다.",
      tip: "뉴턴법과 수렴 궤적을 비교하거나 완만한 초기 수렴 특성을 확인할 때 사용합니다."
    },
    aitken: {
      name: "표준 Steffensen / Aitken Δ² 가속법",
      formula: "y = G(x_k), z = G(y),  x_{k+1} = x_k − (y − x_k)² / (z − 2y + x_k)",
      pros: "동일 고정점 연산자 G의 연속 2회 평가(x, G(x), G(G(x)))로 표준 Aitken Δ² 공식을 엄밀 적용하고 잔차 감소 검증(Safeguard)을 수행합니다.",
      tip: "고정점 연산자의 선형 수렴을 가속할 때 사용합니다."
    }
  };

  function isHxType(type) { return type === "hx" || type === "hx_fin_plate" || type === "hx_plate"; }
  function isSensorType(type) { return type === "sensor_p" || type === "sensor_t" || type === "sensor_sh"; }
  function isSignalType(type) { return type === "sig_const" || type === "sig_step" || type === "sig_scenario"; }
  function isFlowNode(type) { return type === "compressor" || isHxType(type) || type === "valve" || type === "receiver"; }

  function evalSignalNode(sigNode, t_sec = 0) {
    const p = sigNode.params || {};
    if (sigNode.type === "sig_const") return Number(p.value ?? p.val ?? -5.5);
    if (sigNode.type === "sig_step") {
      const tStep = Number(p.t_step ?? 5.0);
      return t_sec >= tStep ? Number(p.val_final ?? 3600) : Number(p.val_init ?? 2400);
    }
    if (sigNode.type === "sig_scenario") {
      const rawCsv = p.scenario_csv || p.csv || "0,2400\n10,3600\n20,3000";
      const lines = rawCsv.trim().split(/\r?\n/).filter(Boolean);
      const pts = [];
      for (const line of lines) {
        const cols = line.split(/[,\t;]+/).map(Number);
        if (cols.length >= 2 && !Number.isNaN(cols[0]) && !Number.isNaN(cols[1])) pts.push({ t: cols[0], v: cols[1] });
      }
      if (pts.length === 0) return 0;
      pts.sort((a, b) => a.t - b.t);
      if (t_sec <= pts[0].t) return pts[0].v;
      if (t_sec >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
      for (let i = 0; i < pts.length - 1; i++) {
        if (t_sec >= pts[i].t && t_sec <= pts[i + 1].t) {
          const f = (t_sec - pts[i].t) / Math.max(1e-9, pts[i + 1].t - pts[i].t);
          return pts[i].v + f * (pts[i + 1].v - pts[i].v);
        }
      }
    }
    return 0;
  }

  function findConnectedSignal(targetNode, simNodes, simEdges) {
    const edge = (simEdges || []).find(e => e.to === targetNode.id && e.kind === "signal");
    if (edge) {
      const s = simNodes.find(n => n.id === edge.from && isSignalType(n.type));
      if (s) return s;
    }
    return null;
  }

  function findConnectedFan(hxNode, simNodes, simEdges) {
    const edge = (simEdges || []).find(e =>
      (e.to === hxNode.id && simNodes.some(n => n.id === e.from && n.type === "fan")) ||
      (e.from === hxNode.id && simNodes.some(n => n.id === e.to && n.type === "fan"))
    );
    if (edge) {
      return simNodes.find(n => (n.id === edge.from || n.id === edge.to) && n.type === "fan") || null;
    }
    return null;
  }

  // 배관 형상 기본값 추정 (역할별 현실적 내경 적용: 흡입관 16mm, 토출/팽창관 12mm, 액관 10mm)
  function getEdgePipeSpec(edge, simNodes) {
    const fromN = simNodes.find(n => n.id === edge.from);
    const toN = simNodes.find(n => n.id === edge.to);
    let defD = 12.0, defL = 0.8;
    if (toN && toN.type === "compressor") { defD = 16.0; defL = 0.8; }
    else if (fromN && fromN.type === "receiver" && (fromN.params.rec_type || "suction") === "suction") { defD = 16.0; defL = 0.8; }
    else if (toN && toN.type === "receiver" && (toN.params.rec_type || "suction") === "suction") { defD = 16.0; defL = 0.8; }
    else if (fromN && fromN.type === "compressor") { defD = 12.0; defL = 0.8; }
    else if (fromN && fromN.type === "valve") { defD = 12.0; defL = 0.5; }
    else if (toN && toN.type === "valve") { defD = 10.0; defL = 0.8; }

    const p = edge.pipe || {};
    return {
      L_m: Math.max(0.05, Number(p.L_m ?? defL)),
      D_mm: Math.max(3.0, Number(p.D_mm ?? defD)),
      eps_mm: Math.max(0, Number(p.eps_mm ?? 0.0015)), // 인발 동관 조도 1.5 μm
      dz_m: Number(p.dz_m ?? 0.0),
      UA_ins_WK: Math.max(0, Number(p.UA_ins_WK ?? 0.0))
    };
  }

  // Churchill(단상) + Friedel(2상) + 중력수두 + Zivi 보유량 + 배관 열손실 (임의 0.15 bar 상한 클램프 제거!)
  function calcPipeSegment(sIn, pipeSpec, refProp, govMomentum, T_amb_C = 35) {
    const HX = global.HXModule;
    const D_m = pipeSpec.D_mm * 1e-3;
    const L_m = pipeSpec.L_m;
    const A_pipe = (Math.PI * D_m * D_m) / 4;
    const V_pipe = A_pipe * L_m;
    const m_dot = Math.max(1e-5, sIn.m_dot);
    const G = m_dot / Math.max(1e-7, A_pipe);

    // 1. 배관 열교환 (절연 손실 UA_ins)
    let h_out = sIn.h_kJkg;
    let Q_pipe_kW = 0;
    if (pipeSpec.UA_ins_WK > 1e-6) {
      const Q_raw = (pipeSpec.UA_ins_WK * (sIn.T_C - T_amb_C)) / 1000; // 양수: 방열, 음수: 흡열
      const stAmb = refProp.solvePT(sIn.P_bar, T_amb_C);
      const Q_max = m_dot * (sIn.h_kJkg - stAmb.h);
      Q_pipe_kW = (Q_raw >= 0) ? Math.min(Q_raw, Math.max(0, Q_max)) : Math.max(Q_raw, Math.min(0, Q_max));
      h_out = sIn.h_kJkg - Q_pipe_kW / m_dot;
    }

    // 2. 모멘텀 마찰 + 중력 압력강하
    let dP_f_bar = 0, dP_g_bar = 0, dP_pipe_bar = 0, pipe_clamped = false;
    const sat = refProp.kind === "two_phase" ? refProp.getSatAtP(sIn.P_bar) : null;
    const x_in = sIn.quality ?? 1;
    const rho_zivi = (sat && x_in > 0 && x_in < 1 && refProp.voidFractionDensity)
      ? refProp.voidFractionDensity(sIn.P_bar, x_in)
      : Math.max(0.5, sIn.rho || 30);

    if (govMomentum) {
      const relRough = Math.max(1e-6, (pipeSpec.eps_mm * 1e-3) / D_m);
      const mu_Pas = Math.max(1e-6, (sIn.mu || 120) * 1e-6);
      const Re = Math.max(10, (G * D_m) / mu_Pas);
      const f_sp = HX ? HX.churchillFriction(Re, relRough) : 0.025;
      const dP_sp = (f_sp * (L_m / D_m) * G * G) / (2 * Math.max(0.5, sIn.rho || 30) * 1e5);

      if (sat && HX && x_in > 0.005 && x_in < 0.995) {
        const Re_lo = Math.max(10, (G * D_m) / Math.max(1e-6, sat.mu_f * 1e-6));
        const f_lo = HX.churchillFriction(Re_lo, relRough);
        const sigma = refProp.getSurfaceTension ? refProp.getSurfaceTension(sIn.P_bar) : 0.010;
        const phi2 = HX.friedelMultiplier(G, D_m, x_in, sat, sigma);
        const dP_tp = (f_lo * (L_m / D_m) * G * G * phi2) / (2 * Math.max(10, sat.rho_f) * 1e5);
        const t1 = Math.min(1, Math.max(0, x_in / 0.03));
        const t2 = Math.min(1, Math.max(0, (1 - x_in) / 0.03));
        const wTP = (t1 * t1 * (3 - 2 * t1)) * (t2 * t2 * (3 - 2 * t2));
        dP_f_bar = (1 - wTP) * dP_sp + wTP * dP_tp;
      } else {
        dP_f_bar = dP_sp;
      }
      dP_g_bar = (rho_zivi * 9.81 * pipeSpec.dz_m) / 1e5;
      const dP_raw = dP_f_bar + dP_g_bar;
      const dP_safe_max = sIn.P_bar * 0.45;
      if (dP_raw > dP_safe_max) { pipe_clamped = true; dP_pipe_bar = dP_safe_max; }
      else dP_pipe_bar = Math.max(-0.5, dP_raw);
    }

    const P_out = Math.max(0.5, sIn.P_bar - dP_pipe_bar);
    const stOut = (Math.abs(dP_pipe_bar) > 1e-5 || Math.abs(Q_pipe_kW) > 1e-6) ? refProp.evalPH(P_out, h_out) : null;
    const rho_out_zivi = stOut
      ? ((sat && stOut.x > 0 && stOut.x < 1 && refProp.voidFractionDensity) ? refProp.voidFractionDensity(P_out, stOut.x) : stOut.rho)
      : rho_zivi;
    const pipe_mass_kg = V_pipe * 0.5 * (rho_zivi + rho_out_zivi);

    if (stOut) {
      return {
        ...sIn, P_bar: P_out, T_C: stOut.T, h_kJkg: stOut.h, rho: stOut.rho, s_kJkgK: stOut.s,
        mu: stOut.mu, k: stOut.k, Cp: stOut.Cp, T_sat_C: stOut.T_sat, quality: stOut.x,
        SC: stOut.SC, SH: stOut.SH,
        pipe_dP_bar: dP_pipe_bar, pipe_dP_f_bar: dP_f_bar, pipe_dP_g_bar: dP_g_bar,
        pipe_Q_loss_kW: Q_pipe_kW, pipe_mass_kg, pipe_G: G, pipe_clamped, pipeSpec
      };
    }
    return {
      ...sIn, pipe_dP_bar: 0, pipe_dP_f_bar: 0, pipe_dP_g_bar: 0,
      pipe_Q_loss_kW: 0, pipe_mass_kg, pipe_G: G, pipe_clamped: false, pipeSpec
    };
  }

  function validateCircuit(nodes, edges, fluidTableDB = null) {
    const solverNode = nodes.find(n => n.type === "solver");
    const refNodes = nodes.filter(n => n.type === "refrigerant");
    const errors = [];
    const mismatchEdgeIds = new Set();

    if (!solverNode) errors.push("캔버스에 [솔버] 노드가 없습니다. 시스템 제어 폴더에서 솔버를 배치해 주세요.");
    if (refNodes.length === 0) errors.push("캔버스에 [냉매] 노드가 없습니다. 시스템 제어 폴더에서 냉매를 배치해 주세요.");

    const refIdSet = new Set(refNodes.map(r => r.id));
    const definedFluids = new Set(refNodes.map(r => r.params && r.params.fluid));

    // 유체 DB 존재 여부 확인 (무음 R134a 폴백 방지)
    if (fluidTableDB) {
      refNodes.forEach(r => {
        if (r.params && r.params.fluid && !fluidTableDB[r.params.fluid]) {
          errors.push(`[${r.modelName}]에 지정된 유체 '${r.params.fluid}'가 물성치 DB에 존재하지 않습니다.`);
        }
      });
    }

    nodes.filter(n => isFlowNode(n.type)).forEach(n => {
      if (!n.params.fluidNodeId || !refIdSet.has(n.params.fluidNodeId)) {
        errors.push(`[${n.modelName}]에 유효한 냉매/유체 노드가 지정되지 않았습니다.`);
      }
      if (isHxType(n.type) && n.params.sec_mode === "const_Q") {
        const sig = findConnectedSignal(n, nodes, edges);
        if (!sig) errors.push(`[${n.modelName}]가 고정 열부하(const_Q) 모드입니다. 신호 컴포넌트에서 직접 선을 연결해 주세요.`);
      }
      if (isHxType(n.type) && n.params.sec_mode !== "const_Q") {
        const secFluid = n.params.sec_fluid || (n.type === "hx_plate" ? "GW" : "Air");
        if (!definedFluids.has(secFluid)) {
          errors.push(`[${n.modelName}]의 상대측 유체 [${secFluid}]가 캔버스에 정의되어 있지 않습니다.`);
        }
      }
      if (n.type === "hx_fin_plate" && n.params.sec_mode !== "const_Q") {
        const fan = findConnectedFan(n, nodes, edges);
        if (!fan) errors.push(`[${n.modelName}]의 공기측 포트에 [팬 / 블로워]가 직접 선으로 연결되어 있지 않습니다.`);
      }
    });

    nodes.filter(n => isSignalType(n.type)).forEach(sig => {
      const hasWire = edges.some(e => e.from === sig.id && e.kind === "signal");
      if (!hasWire) errors.push(`[${sig.modelName}]가 어느 컴포넌트에도 선으로 연결되어 있지 않습니다.`);
    });

    const FM = global.FanModule;
    nodes.filter(n => n.type === "fan").forEach(fan => {
      try { if (FM) FM.parseFanCurveCSV(fan.params.curve_csv); }
      catch (err) { errors.push(`[${fan.modelName}] 팬/펌프 곡선 오류: ${err.message}`); }
      const hasAirWire = edges.some(e => (e.from === fan.id || e.to === fan.id) && e.kind === "air");
      if (!hasAirWire) errors.push(`[${fan.modelName}]가 핀-플레이트 열교환기의 공기측 포트에 연결되어 있지 않습니다.`);
    });

    edges.filter(e => !e.kind || e.kind === "flow").forEach(e => {
      const a = nodes.find(n => n.id === e.from), b = nodes.find(n => n.id === e.to);
      if (a && b && isFlowNode(a.type) && isFlowNode(b.type)) {
        if (a.params.fluidNodeId && b.params.fluidNodeId && a.params.fluidNodeId !== b.params.fluidNodeId) {
          mismatchEdgeIds.add(e.id);
          errors.push(`배관 냉매 불일치: [${a.modelName}]와 [${b.modelName}]의 냉매 노드가 다릅니다.`);
        }
      }
    });

    return { ok: errors.length === 0, errors, mismatchEdgeIds, solverNode, refNodes };
  }

  function applySimConfig(simNodes, simEdges, opts) {
    const cfg = opts.simConfig || {};
    const t_sec = Number(cfg.t_sec ?? 0);
    const govMomentum = opts.gov_momentum !== false;
    const FM = global.FanModule, HX = global.HXModule;
    const fluidTableDB = opts.fluidTableDB || null;
    const T_amb = cfg.T_amb_C !== undefined ? cfg.T_amb_C : 35.0;

    // 1. 신호 컴포넌트 출력값 계산
    simNodes.filter(n => isSignalType(n.type)).forEach(sig => {
      sig.result = { value: evalSignalNode(sig, t_sec), t_sec };
    });

    // 2. 팬 운전점 계산 — 연결된 HX의 실제 공기측 ΔP_sec(Q) 곡선 & 실제 ρ_air(T_amb) 직접 연동!
    simNodes.filter(n => n.type === "fan").forEach(fan => {
      const sig = findConnectedSignal(fan, simNodes, simEdges);
      if (sig && sig.result) fan.params.rpm = Math.max(100, sig.result.value);
      else if (cfg.fan_rpm !== undefined && fan.params.link_global !== false) fan.params.rpm = cfg.fan_rpm;

      const airEdge = (simEdges || []).find(e => (e.from === fan.id || e.to === fan.id) && e.kind === "air");
      const targetHx = airEdge ? simNodes.find(h => (h.id === airEdge.from || h.id === airEdge.to) && isHxType(h.type)) : null;

      const T_air_fan = (targetHx && !targetHx.params.link_ambient && targetHx.params.T_sec_in !== undefined) ? targetHx.params.T_sec_in : T_amb;
      const airProp = HX ? HX.getSecProps("Air", T_air_fan, 1.01325, fluidTableDB) : { rho: 1.15 };

      if (FM) {
        try {
          if (targetHx && HX && HX.calcAirPressureDrop) {
            const sysDpFn = (q_cmm) => HX.calcAirPressureDrop(targetHx.params, q_cmm, T_air_fan, fluidTableDB);
            fan.result = FM.run(fan.params, sysDpFn, airProp.rho);
          } else {
            fan.result = FM.run(fan.params, fan.params.K_sys || fan.params.K_sys_default || 0.08, airProp.rho);
          }
        } catch {}
      }
    });

    // 3. 압축기 및 열교환기 조건 반영
    simNodes.forEach(n => {
      if (n.type === "compressor") {
        const sig = findConnectedSignal(n, simNodes, simEdges);
        if (sig && sig.result) n.params.rpm = Math.max(300, sig.result.value);
        else if (cfg.comp_rpm !== undefined && n.params.link_global !== false) n.params.rpm = cfg.comp_rpm;
      } else if (isHxType(n.type)) {
        if (n.type === "hx_fin_plate") n.params.hxType = "fin_plate";
        if (n.type === "hx_plate") n.params.hxType = "plate";
        if (!govMomentum) { n.params.auto_dP = false; n.params.dP_bar = 0; }
        if (cfg.T_amb_C !== undefined && n.params.link_ambient) {
          n.params.T_sec_in = cfg.T_amb_C; n.params.T_air_in = cfg.T_amb_C;
        }
        const sig = findConnectedSignal(n, simNodes, simEdges);
        if (n.params.sec_mode === "const_Q" && sig && sig.result) n.params.Q_source_kW = sig.result.value;
        const linkedFan = findConnectedFan(n, simNodes, simEdges);
        if (linkedFan && linkedFan.result) {
          n.params.m_sec_kgs = linkedFan.result.metrics.m_air_kgs;
          n.params.m_air_kgs = linkedFan.result.metrics.m_air_kgs;
        } else if (cfg.fan_rpm !== undefined && n.params.link_fan) {
          const refRpm = Math.max(100, n.params.fan_rpm_ref || 1800);
          const refFlow = Math.max(0.05, n.params.m_sec_ref || n.params.m_sec_kgs || 1.2);
          const scaled = Math.max(0.05, refFlow * (Math.max(100, cfg.fan_rpm) / refRpm));
          n.params.m_sec_kgs = scaled; n.params.m_air_kgs = scaled;
        }
      } else if (n.type === "receiver" && !govMomentum) {
        n.params.dP_bar = 0;
      }
    });

    if (opts.override) {
      const comp = simNodes.find(n => n.type === "compressor");
      if (opts.override.rpm !== undefined && comp) comp.params.rpm = opts.override.rpm;
      if (opts.override.p2 !== undefined && comp) comp.params.P2_bar = opts.override.p2;
    }
  }

  function updateSensors(simNodes, simEdges) {
    const sensors = simNodes.filter(n => isSensorType(n.type));
    sensors.forEach(s => {
      let stream = null;
      const inSig = simEdges.find(e => e.to === s.id);
      if (inSig) {
        const src = simNodes.find(n => n.id === inSig.from);
        if (src && src.result && src.result.outStream) stream = src.result.outStream;
      }
      if (!stream && s.params.measureEdgeId) {
        const me = simEdges.find(e => e.id === s.params.measureEdgeId && e.stream);
        if (me) stream = me.stream;
      }
      if (!stream && s.params.measureNodeId) {
        const mn = simNodes.find(n => n.id === s.params.measureNodeId && n.result);
        if (mn) stream = mn.result.outStream || mn.result.outlet;
      }
      if (stream) {
        const sh = Math.max(0, stream.T_C - (stream.T_sat_C ?? stream.T_C));
        s.result = {
          connected: true, P_bar: stream.P_bar, T_C: stream.T_C,
          T_sat_C: stream.T_sat_C ?? stream.T_C, SH: sh,
          h_kJkg: stream.h_kJkg, quality: stream.quality ?? 1, m_dot: stream.m_dot
        };
      } else {
        s.result = { connected: false, P_bar: null, T_C: null, T_sat_C: null, SH: null };
      }
    });
  }

  function getValveSensorFeedbackLive(valveNode, simNodes, simEdges) {
    const sigEdge = simEdges.find(e => e.to === valveNode.id && e.kind === "signal");
    if (sigEdge) {
      const s = simNodes.find(n => n.id === sigEdge.from && isSensorType(n.type));
      if (s && s.result) return s.result;
    }
    if (valveNode.params.sensorNodeId) {
      const s = simNodes.find(n => n.id === valveNode.params.sensorNodeId && isSensorType(n.type));
      if (s && s.result) return s.result;
    }
    return null;
  }

  // 폐회로 1회 패스 (밸브 출구압 P4 지정 → 증발기·센서 즉시 계산 → 같은 패스 내 무지연 TXV 유량 m_valve 평가!)
  function runCoupledPass(simNodes, simEdges, fluid, refProp, opts = {}, stateVec = null, recAssignedMass = null) {
    const CM = global.CompressorModule, HX = global.HXModule, VM = global.ValveModule, RM = global.ReceiverModule;
    const fluidTableDB = opts.fluidTableDB || null;
    const govMomentum = opts.gov_momentum !== false;
    const T_amb = (opts.simConfig && opts.simConfig.T_amb_C !== undefined) ? opts.simConfig.T_amb_C : 35.0;

    simNodes.forEach(n => { if (isFlowNode(n.type)) n.result = null; });
    simEdges.filter(e => !e.kind || e.kind === "flow").forEach(e => (e.stream = null));

    const queue = [];
    const deferredValves = [];

    simNodes.filter(n => n.type === "compressor").forEach(comp => {
      const maps = comp._cachedMaps || (comp._cachedMaps = {
        is: new CM.EfficiencyMap2D(comp.params.csv_is),
        vol: new CM.EfficiencyMap2D(comp.params.csv_vol),
        mech: new CM.EfficiencyMap2D(comp.params.csv_mech)
      });
      const runParams = { fluid, ...comp.params };
      if (stateVec) {
        runParams.P1_bar = stateVec.P1;
        runParams.P2_bar = stateVec.P2;
        runParams.h1_override = stateVec.h1;
      }
      const res = CM.run(runParams, maps, refProp);
      comp.result = { ...res, outStream: res.outlet };
      queue.push(comp);
    });

    const visited = new Set(queue.map(n => n.id));
    let guard = 0;
    while (queue.length > 0 && guard++ < 80) {
      const cur = queue.shift();
      simEdges.filter(e => e.from === cur.id && (!e.kind || e.kind === "flow")).forEach(edge => {
        const sIn = cur.result.outStream;
        const pipeSpec = getEdgePipeSpec(edge, simNodes);
        const outStream = calcPipeSegment(sIn, pipeSpec, refProp, govMomentum, T_amb);
        edge.stream = outStream;

        const target = simNodes.find(n => n.id === edge.to);
        if (!target || visited.has(target.id) || !isFlowNode(target.type)) return;

        if (isHxType(target.type)) {
          const res = HX.run(edge.stream, target.params, refProp, fluidTableDB);
          target.result = { ...res, outStream: res.outlet };
        } else if (target.type === "valve") {
          if (stateVec && Number.isFinite(stateVec.P4)) {
            // 등엔탈피 팽창이므로 P4만으로 하류(증발기/센서)를 즉시 계산 가능 → 같은 패스에서 무지연 TXV 유량 산출!
            const P4_eff = Math.max(0.5, Math.min(edge.stream.P_bar - 0.05, stateVec.P4));
            const stOut = refProp.evalPH(P4_eff, edge.stream.h_kJkg);
            const prelimOut = {
              fluid: edge.stream.fluid, P_bar: P4_eff, T_C: stOut.T, h_kJkg: stOut.h, s_kJkgK: stOut.s,
              rho: stOut.rho, mu: stOut.mu, k: stOut.k, Cp: stOut.Cp, m_dot: edge.stream.m_dot,
              T_sat_C: stOut.T_sat, quality: stOut.x
            };
            target.result = { inlet: edge.stream, outlet: prelimOut, outStream: prelimOut, metrics: {} };
            deferredValves.push({ node: target, inStream: edge.stream, P4: P4_eff });
          } else {
            const res = VM.run(edge.stream, target.params, refProp, null, null);
            target.result = { ...res, outStream: res.outlet };
          }
        } else if (target.type === "receiver" && RM) {
          const assigned = recAssignedMass ? recAssignedMass.get(target.id) : null;
          const res = RM.run(edge.stream, target.params, refProp, assigned ?? null);
          target.result = { ...res, outStream: res.outlet };
        }

        if (target.result) {
          visited.add(target.id);
          queue.push(target);
        }
      });
    }

    // 동일 패스 내 센서 즉시 업데이트 (1회 반복 지연 완전 제거!)
    updateSensors(simNodes, simEdges);

    // 지연 평가된 밸브에서 최신 센서 과열도(SH_meas)로 역방향 유량 m_dot_valve 산출!
    deferredValves.forEach(({ node, inStream, P4 }) => {
      const fb = getValveSensorFeedbackLive(node, simNodes, simEdges);
      const res = VM.calcMassFlow(inStream, P4, node.params, refProp, fb);
      node.result = { ...res, outStream: res.outlet };
    });
  }

  function evaluateConservation(simNodes, simEdges, opts) {
    const refNode = simNodes.find(n => n.type === "refrigerant");
    const chargeMode = (refNode && refNode.params.charge_mode) || "auto";
    const autoRecLevel = (refNode && refNode.params.auto_rec_level_pct !== undefined) ? refNode.params.auto_rec_level_pct : 40;
    const manualCharge_g = (refNode && refNode.params.charge_g > 0) ? refNode.params.charge_g : 650;

    let M_comp = 0, M_hx = 0, M_valve = 0, M_rec = 0, M_pipe = 0, M_rec_auto_kg = 0;
    let Q_cond = 0, Q_evap = 0, W_gas = 0, W_gas_net = 0, Q_shell = 0, Q_rec_loss = 0, Q_pipe_loss = 0;
    let W_shaft = 0, W_elec = 0, W_fan = 0;
    let dP_comp = 0, dP_loop = 0;
    let m_comp_kgs = 0, m_valve_kgs = 0, hasValve = false;
    let secondLawOk = true;
    const warnings = [];

    simNodes.forEach(n => {
      if (n.type === "fan" && n.result) W_fan += n.result.metrics.W_fan_kW || 0;
      if (!n.result || !isFlowNode(n.type)) return;
      const m = n.result.metrics || {};
      if (n.type === "compressor") {
        M_comp += m.mass_kg || 0;
        W_gas += m.W_gas_kW || 0;
        W_gas_net += (m.W_gas_net_kW !== undefined ? m.W_gas_net_kW : (m.W_gas_kW || 0));
        Q_shell += m.Q_shell_kW || 0;
        W_shaft += m.W_shaft_kW || 0;
        W_elec += (m.W_elec_kW !== undefined ? m.W_elec_kW : (m.W_shaft_kW || 0));
        m_comp_kgs = n.result.outlet.m_dot || 0;
        dP_comp += Math.max(0, n.result.outlet.P_bar - n.result.inlet.P_bar);
        if (m.liquidSuction) warnings.push(`[${n.modelName}] 액흡입 감지 (x=${(m.suctionQuality ?? 0).toFixed(3)}) — 과열도 확보 필요`);
        if (m.outOfRange) warnings.push(`[${n.modelName}] 압축기 효율맵 범위 초과 (PR=${(m.PR || 0).toFixed(2)})`);
      } else if (isHxType(n.type)) {
        M_hx += m.mass_kg || 0;
        if (m.isCondenser) Q_cond += m.Q_kW || 0; else Q_evap += m.Q_kW || 0;
        dP_loop += m.dP_bar || 0;
        if (m.secondLawViolated) {
          secondLawOk = false;
          warnings.push(`[${n.modelName}] 열역학 제2법칙 위반(온도 교차) 감지`);
        }
        if (m.warnings && m.warnings.length) m.warnings.forEach(w => warnings.push(`[${n.modelName}] ${w}`));
      } else if (n.type === "valve") {
        hasValve = true;
        M_valve += m.mass_kg || 0;
        dP_loop += m.dP_bar || 0;
        m_valve_kgs = m.m_dot_valve !== undefined ? m.m_dot_valve : (n.result.outlet.m_dot || 0);
        if (m.is_choked) warnings.push(`[${n.modelName}] 초크 플로우(CHOKED) 도달 (P_choke=${(m.P_choke_bar || 0).toFixed(2)} bar)`);
      } else if (n.type === "receiver") {
        M_rec += m.mass_kg || 0;
        Q_rec_loss += m.Q_loss_kW || 0;
        const lvFrac = Math.min(0.95, Math.max(0.05, autoRecLevel / 100));
        M_rec_auto_kg += (m.mass_min_kg || 0) + lvFrac * Math.max(0, (m.mass_max_kg || 0) - (m.mass_min_kg || 0));
        dP_loop += m.dP_bar || 0;
        if (m.warnings && m.warnings.length) m.warnings.forEach(w => warnings.push(`[${n.modelName}] ${w}`));
      }
    });

    simEdges.filter(e => !e.kind || e.kind === "flow").forEach(e => {
      if (e.stream) {
        M_pipe += e.stream.pipe_mass_kg || 0;
        dP_loop += e.stream.pipe_dP_bar || 0;
        Q_pipe_loss += e.stream.pipe_Q_loss_kW || 0;
        if (e.stream.pipe_clamped) warnings.push(`배관(${e.id}) ΔP 안전 상한 도달`);
      }
    });

    const M_others_kg = M_comp + M_hx + M_valve + M_pipe;
    const autoTarget_kg = M_others_kg + M_rec_auto_kg;
    const targetCharge_kg = chargeMode === "auto" ? autoTarget_kg : (manualCharge_g / 1000);
    const M_total_kg = M_others_kg + M_rec;
    const resM_g = (M_total_kg - targetCharge_kg) * 1000;
    const flowDiff_kgs = hasValve ? (m_comp_kgs - m_valve_kgs) : 0;
    const flowRes_pct = (hasValve && m_comp_kgs > 1e-6) ? (Math.abs(flowDiff_kgs) / m_comp_kgs) * 100 : 0;

    // 1st Law 정확 에너지 회계: 냉매측 (Q_cond + Q_rec_loss + Q_pipe_loss) == (Q_evap + W_gas_net)
    // (전체 시스템 기준으로는 Q_cond + Q_shell + Q_rec_loss + Q_pipe_loss == Q_evap + W_gas)
    const Q_out_ref = Q_cond + Q_rec_loss + Q_pipe_loss;
    const Q_in_ref = Q_evap + W_gas_net;
    const resE_kW = Math.abs(Q_out_ref - Q_in_ref);
    const resE_pct = Math.max(Q_cond, Q_evap, 1e-3) > 1e-3 ? (resE_kW / Math.max(Q_cond, Q_evap, 1e-3)) * 100 : 0;
    const resMomentum_bar = Math.abs(dP_comp - dP_loop);

    const COP_comp = (W_shaft > 1e-6 && Q_evap > 0) ? (Q_evap / W_shaft) : 0;
    const COP_elec = (W_elec > 1e-6 && Q_evap > 0) ? (Q_evap / W_elec) : 0;
    const COP_sys = ((W_elec + W_fan) > 1e-6 && Q_evap > 0) ? (Q_evap / (W_elec + W_fan)) : 0;

    return {
      mass: {
        charge_mode: chargeMode, auto_rec_level_pct: autoRecLevel,
        target_g: targetCharge_kg * 1000, total_g: M_total_kg * 1000, others_kg: M_others_kg,
        hx_g: M_hx * 1000, rec_g: M_rec * 1000, pipe_g: M_pipe * 1000, comp_g: M_comp * 1000, valve_g: M_valve * 1000,
        residual_g: resM_g,
        m_comp_kgs, m_valve_kgs, flow_diff_kgs: flowDiff_kgs, flow_residual_pct: flowRes_pct
      },
      energy: {
        Q_cond, Q_evap, W_gas, W_gas_net, Q_shell, Q_rec_loss, Q_pipe_loss,
        W_shaft, W_elec, W_fan,
        COP_comp, COP_elec, COP_sys,
        residual_kW: resE_kW, residual_pct: resE_pct,
        secondLawOk
      },
      momentum: { dP_comp_bar: dP_comp, dP_loop_bar: dP_loop, residual_bar: resMomentum_bar },
      warnings
    };
  }

  // 자동(auto) 충전량 모드에서만 목표 액위를 탱크에 배정 (manual 모드에서는 물리 상태 기반 보유량 계산!)
  function buildAutoReceiverMap(simNodes, opts, refProp) {
    if (opts.gov_mass === false) return null;
    const refNode = simNodes.find(n => n.type === "refrigerant");
    const chargeMode = (refNode && refNode.params.charge_mode) || "auto";
    if (chargeMode !== "auto") return null; // manual 모드: receiver.js의 물리 보유량 모델 사용!
    const recs = simNodes.filter(n => n.type === "receiver");
    if (recs.length === 0) return null;
    const autoRecLevel = (refNode && refNode.params.auto_rec_level_pct !== undefined) ? refNode.params.auto_rec_level_pct : 40;
    const lvFrac = Math.min(0.95, Math.max(0.05, autoRecLevel / 100));
    const RM = global.ReceiverModule;
    const map = new Map();
    recs.forEach(r => {
      if (r.result && r.result.metrics) {
        const m = r.result.metrics;
        map.set(r.id, m.mass_min_kg + lvFrac * Math.max(0, m.mass_max_kg - m.mass_min_kg));
      } else if (RM && refProp.sat) {
        const vol_m3 = RM.calcVolumeL(r.params) * 1e-3;
        const pGuess = (r.params.rec_type === "high_pressure") ? 12.5 : 3.5;
        const sat = refProp.getSatAtP(pGuess);
        map.set(r.id, vol_m3 * (sat.rho_g + lvFrac * (sat.rho_f - sat.rho_g)));
      }
    });
    return map;
  }

  // 소형 n×n 선형계 풀이기 (부분 피벗 가우스 소거법)
  function solveLinearSystem(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
      const diag = M[col][col];
      for (let r = col + 1; r < n; r++) {
        const factor = M[r][col] / diag;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = M[i][n];
      for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
      x[i] = sum / M[i][i];
      if (!Number.isFinite(x[i])) return null;
    }
    return x;
  }

  function prepareState(nodes, edges, opts) {
    const simNodes = nodes.map(n => ({ ...n, params: { ...n.params }, result: null }));
    const simEdges = edges.map(e => ({ ...e, pipe: e.pipe ? { ...e.pipe } : undefined, stream: null }));
    applySimConfig(simNodes, simEdges, opts);
    const comp = simNodes.find(n => n.type === "compressor");
    const feedbackEdge = comp ? simEdges.find(e => e.to === comp.id && (!e.kind || e.kind === "flow")) : null;
    return { simNodes, simEdges, comp, feedbackEdge };
  }

  function normalizeOpts(opts) {
    return {
      loop_mode: opts.loop_mode || "closed",
      gov_mass: opts.gov_mass !== false,
      gov_energy: opts.gov_energy !== false,
      gov_momentum: opts.gov_momentum !== false,
      num_method: opts.num_method || "newton_secant",
      maxIter: opts.maxIter || 50,
      tolT: opts.tolT || 0.05,
      tolP: opts.tolP || 0.02,
      tolH: opts.tolH || 0.35,
      tolE: opts.tolE || 0.01, // 에너지 상대잔차 허용오차 [%] (기본 0.01% = 1e-4!)
      alpha: opts.alpha || 0.45,
      delayMs: opts.delayMs ?? 10,
      simConfig: opts.simConfig || {},
      fluidTableDB: opts.fluidTableDB || null,
      override: opts.override || null,
      warmStart: opts.warmStart || null
    };
  }

  // 반복 이력에서 3대 보존법칙 및 최종 솔버 잔차의 수렴 마일스톤(최초 지속 수렴 반복 번호) 추출
  function extractMilestones(history) {
    const firstSustained = (pred) => {
      if (!history.length || !pred(history[history.length - 1])) return null;
      let idx = history.length - 1;
      while (idx > 0 && pred(history[idx - 1])) idx--;
      return history[idx].iter;
    };
    const massIter = firstSustained(h => h.massOk);
    const energyIter = firstSustained(h => h.energyOk);
    const momentumIter = firstSustained(h => h.momOk);
    const solverResIter = firstSustained(h => h.massOk && h.energyOk && h.momOk && h.solverResOk && h.secondLawOk);

    const items = [
      { key: "mass", label: "질량보존", iter: massIter },
      { key: "energy", label: "에너지보존", iter: energyIter },
      { key: "momentum", label: "모멘텀보존", iter: momentumIter },
      { key: "solver", label: "최종 솔버 잔차", iter: solverResIter }
    ];
    const orderSorted = items.filter(x => x.iter !== null).sort((a, b) => a.iter - b.iter);
    return { massIter, energyIter, momentumIter, solverResIter, orderSorted };
  }

  // 통합 코어 솔버 (동기 & 비동기 공유)
  function createSolverRunner(nodes, edges, fluid, refProp, rawOpts = {}) {
    const opts = normalizeOpts(rawOpts);
    const { simNodes, simEdges, comp, feedbackEdge } = prepareState(nodes, edges, opts);
    if (refProp.resetWarnings) refProp.resetWarnings();

    const pMinLimit = (refProp.sat && refProp.sat.P) ? refProp.sat.P[0] * 1.02 : 0.85;
    const pMaxLimit = (refProp.sat && refProp.sat.P) ? refProp.sat.P[refProp.sat.P.length - 1] * 0.96 : 38.0;
    const refNode = simNodes.find(n => n.type === "refrigerant");
    const chargeMode = (refNode && refNode.params.charge_mode) || "auto";
    const hasHPReceiver = simNodes.some(n => n.type === "receiver" && n.params.rec_type === "high_pressure");
    const valveNode = simNodes.find(n => n.type === "valve");
    const solveP2 = opts.gov_energy !== false;
    const nVars = solveP2 ? 4 : 3; // [P1, P2, h1, P4] 또는 [P1, h1, P4]

    // 유체 포화곡선 역산 헬퍼: T_target [°C] → P_sat [bar] (이분법 24회)
    function pSatAtT(T_target) {
      if (!refProp || refProp.kind !== "two_phase") return 5.0;
      let lo = pMinLimit, hi = pMaxLimit;
      for (let k = 0; k < 24; k++) {
        const mid = 0.5 * (lo + hi);
        if (refProp.tSatC(mid) < T_target) lo = mid; else hi = mid;
      }
      return 0.5 * (lo + hi);
    }

    // 초기 추정값 설정 (유체 포화곡선 기반 자동 보정 + Warm-Start 연속법 지원!)
    let P1_0 = comp ? Math.max(pMinLimit, Math.min(pMaxLimit * 0.6, comp.params.P1_bar || 3.5)) : 3.5;
    let P2_0 = comp ? Math.max(P1_0 * 1.3, Math.min(pMaxLimit, comp.params.P2_bar || 12.5)) : 12.5;
    let T1_init = comp ? (comp.params.T1_C ?? 15.0) : 15.0;

    if (!opts.warmStart && refProp.kind === "two_phase") {
      // 회로 내 열교환기 2차유체 온도로부터 유체별(R134a, R32 등) 물리적 초기 압력 자동 검증·보정
      const hxNodes = simNodes.filter(n => isHxType(n.type) && n.params.sec_mode !== "const_Q");
      if (hxNodes.length > 0) {
        const temps = hxNodes.map(h => h.params.T_sec_in !== undefined ? h.params.T_sec_in : (h.params.T_air_in ?? 25.0));
        const T_hot = Math.max(...temps);
        const T_cold = Math.min(...temps);
        const Tsat2 = refProp.tSatC(P2_0);
        if (solveP2 && Tsat2 < T_hot + 6.0) {
          P2_0 = Math.min(pMaxLimit * 0.92, Math.max(pMinLimit * 1.5, pSatAtT(T_hot + 16.0)));
        }
        const Tsat1 = refProp.tSatC(P1_0);
        if (Tsat1 < T_cold - 25.0 || Tsat1 > T_cold - 1.0) {
          P1_0 = Math.max(pMinLimit, Math.min(P2_0 * 0.7, pSatAtT(T_cold - 10.0)));
          T1_init = refProp.tSatC(P1_0) + 6.0;
        }
        if (P2_0 < P1_0 * 1.35) P2_0 = Math.min(pMaxLimit * 0.95, P1_0 * 2.2);
      }
    }

    let stInit1 = refProp.solvePT(P1_0, T1_init);
    let h1_0 = stInit1.h;
    let P4_0 = (valveNode && valveNode.params.valve_mode === "fixed_p")
      ? Math.max(pMinLimit, Math.min(P2_0 - 0.5, valveNode.params.P_out_bar || 3.6))
      : Math.min(P2_0 - 0.5, P1_0 + 0.15);

    if (opts.warmStart && Number.isFinite(opts.warmStart.P1)) {
      P1_0 = opts.warmStart.P1;
      if (solveP2 && Number.isFinite(opts.warmStart.P2)) P2_0 = opts.warmStart.P2;
      if (Number.isFinite(opts.warmStart.h1)) h1_0 = opts.warmStart.h1;
      if (Number.isFinite(opts.warmStart.P4)) P4_0 = opts.warmStart.P4;
    }

    const fixedP2 = P2_0;

    function unpack(vec) {
      return solveP2
        ? { P1: vec[0], P2: vec[1], h1: vec[2], P4: vec[3] }
        : { P1: vec[0], P2: fixedP2, h1: vec[1], P4: vec[2] };
    }

    function projectBox(vec) {
      const s = unpack(vec);
      s.P1 = Math.max(pMinLimit, Math.min(pMaxLimit * 0.72, s.P1));
      if (solveP2) s.P2 = Math.max(s.P1 * 1.15 + 0.3, Math.min(pMaxLimit, s.P2));
      s.P4 = Math.max(pMinLimit, Math.min(s.P2 - 0.25, s.P4));
      const sat1 = refProp.kind === "two_phase" ? refProp.getSatAtP(s.P1) : null;
      const hLo = sat1 ? (sat1.h_f + 0.15 * (sat1.h_g - sat1.h_f)) : 150;
      const hHi = sat1 ? (sat1.h_g + 160) : 600;
      s.h1 = Math.max(hLo, Math.min(hHi, s.h1));
      return solveP2 ? [s.P1, s.P2, s.h1, s.P4] : [s.P1, s.h1, s.P4];
    }

    // 주어진 상태벡터 vec에서 1회 패스 실행 + 무차원 잔차 벡터 R 산출
    function evalVec(vec) {
      const sv = unpack(vec);
      const recMap = buildAutoReceiverMap(simNodes, opts, refProp);
      runCoupledPass(simNodes, simEdges, fluid, refProp, opts, sv, recMap);
      if (recMap) {
        // auto 모드에서 실제 운전 압력의 포화 밀도로 탱크 질량 1회 정렬
        const recMapExact = buildAutoReceiverMap(simNodes, opts, refProp);
        runCoupledPass(simNodes, simEdges, fluid, refProp, opts, sv, recMapExact);
      }

      const conservation = evaluateConservation(simNodes, simEdges, opts);
      const fb = feedbackEdge.stream;
      const stIn1 = comp.result.inlet;

      // 1) 질량 유량 연속 잔차 R_mass
      let R_mass = 0;
      if (valveNode && valveNode.result) {
        if (valveNode.params.valve_mode === "fixed_p") {
          const pTarget = Math.max(pMinLimit, valveNode.params.P_out_bar || 3.6);
          R_mass = (sv.P4 - pTarget) / 2.0;
        } else {
          const mComp = comp.result.outlet.m_dot;
          const mValv = valveNode.result.metrics.m_dot_valve;
          R_mass = (mComp - mValv) / Math.max(0.02, mComp);
        }
      } else {
        R_mass = (sv.P4 - sv.P1) / 2.0;
      }

      // 2) 에너지 폐합 잔차 R_energy (h_fb - h1 = 0)
      const e_h = fb.h_kJkg - stIn1.h_kJkg;
      const R_energy = e_h / 25.0;

      // 3) 모멘텀 폐합 잔차 R_mom (P_fb - P1 = 0 ⇔ ΔP_comp = ΣΔP_loop)
      const e_p = fb.P_bar - stIn1.P_bar;
      const R_mom = e_p / 1.0;

      // 4) 열역학/충전량 구속 잔차 R_closure (gov_energy 활성 시)
      let R = [R_mass, R_energy, R_mom];
      if (solveP2) {
        let R_closure = 0;
        if (chargeMode === "manual" && opts.gov_mass) {
          // 수동 충전량 모드: 총 냉매 질량 ΣM_i = M_charge 를 직접 방정식으로 풀이!
          const mTot = conservation.mass.total_g / 1000;
          const mTgt = Math.max(0.05, conservation.mass.target_g / 1000);
          R_closure = (mTot - mTgt) / mTgt;
        } else {
          // 자동 충전량 모드: 응축기 출구 설계 과냉도 SC_target (고압리시버 있으면 0.5K, 없으면 기본 5.0K)
          // 엔탈피 기준 (h_3 - h_target)/25 로 표현하여 2상 영역에서도 미분 연속·비특이!
          const cond = simNodes.find(n => isHxType(n.type) && n.result && n.result.metrics.isCondenser);
          if (cond && cond.params.sec_mode !== "const_Q") {
            const scTarget = (refNode && refNode.params.auto_sc_K !== undefined)
              ? Math.max(0, Number(refNode.params.auto_sc_K))
              : (hasHPReceiver ? 0.5 : 5.0);
            const satC = refProp.getSatAtP(cond.result.outlet.P_bar);
            const hTarget = satC.h_f - satC.Cp_f * scTarget;
            R_closure = (cond.result.outlet.h_kJkg - hTarget) / 25.0;
          } else {
            R_closure = (sv.P2 - fixedP2) / 5.0;
          }
        }
        R = [R_mass, R_closure, R_energy, R_mom];
      }

      const norm2 = Math.sqrt(R.reduce((acc, v) => acc + v * v, 0));
      const normInf = Math.max(...R.map(v => Math.abs(v)));
      const resT = Math.abs(fb.T_C - stIn1.T_C);
      const resP = Math.abs(e_p);
      const resH = Math.abs(e_h);
      const resMassFlow_pct = conservation.mass.flow_residual_pct;
      const resM_g = conservation.mass.residual_g;
      const resE_pct = conservation.energy.residual_pct;
      const resE_kW = conservation.energy.residual_kW;
      const resMom_bar = conservation.momentum.residual_bar;
      const secondLawOk = conservation.energy.secondLawOk;

      // 3대 보존법칙 + 최종 솔버 잔차 개별 판정
      const massChargeTol_g = Math.max(1.0, 0.005 * conservation.mass.target_g);
      const massOk = (!opts.gov_mass) || (
        resMassFlow_pct <= 0.1 &&
        (chargeMode !== "manual" || Math.abs(resM_g) <= massChargeTol_g)
      );
      const energyOk = (!opts.gov_energy) || (resE_pct <= opts.tolE && resH <= opts.tolH);
      const momOk = (!opts.gov_momentum) || (resMom_bar <= opts.tolP);
      const solverResOk = (resT <= opts.tolT && resP <= opts.tolP && (!opts.gov_energy || resH <= opts.tolH) && normInf <= 1e-3 && secondLawOk);

      return {
        vec, sv, R, norm2, normInf, conservation,
        T1_C: stIn1.T_C,
        resT, resP, resH, resMassFlow_pct, resM_g, resE_pct, resE_kW, resMom_bar,
        massOk, energyOk, momOk, secondLawOk, solverResOk,
        isDone: massOk && energyOk && momOk && solverResOk
      };
    }

    // 유한차분 n×n 야코비안 계산 (central=true 시 중앙차분으로 비매끄러움 회피)
    function computeJacobian(vec, R0, central = false) {
      const J = Array.from({ length: nVars }, () => new Array(nVars).fill(0));
      for (let j = 0; j < nVars; j++) {
        const baseStep = (j === (solveP2 ? 2 : 1)) ? 0.05 : 2e-3;
        const eps = Math.max(baseStep, 2e-4 * Math.abs(vec[j]));
        const vp = [...vec]; vp[j] += eps;
        const vpProj = projectBox(vp);
        const dp = vpProj[j] - vec[j];
        if (central) {
          const vm = [...vec]; vm[j] -= eps;
          const vmProj = projectBox(vm);
          const dm = vec[j] - vmProj[j];
          if (dp > 1e-7 && dm > 1e-7) {
            const Rp = evalVec(vpProj).R, Rm = evalVec(vmProj).R;
            for (let i = 0; i < nVars; i++) J[i][j] = (Rp[i] - Rm[i]) / (dp + dm);
            continue;
          }
        }
        if (Math.abs(dp) < 1e-7) {
          const vm = [...vec]; vm[j] -= eps;
          const vmProj = projectBox(vm);
          const actualEps = vmProj[j] - vec[j];
          const Rm = evalVec(vmProj).R;
          for (let i = 0; i < nVars; i++) J[i][j] = (Rm[i] - R0[i]) / (actualEps || -1e-6);
        } else {
          const Rp = evalVec(vpProj).R;
          for (let i = 0; i < nVars; i++) J[i][j] = (Rp[i] - R0[i]) / dp;
        }
      }
      return J;
    }

    function solveNewtonDir(J, R, norm2, extraReg = 0) {
      const negR = R.map(v => -v);
      let dx = extraReg > 0 ? null : solveLinearSystem(J, negR);
      if (!dx) {
        const JTJ = Array.from({ length: nVars }, () => new Array(nVars).fill(0));
        const JTr = new Array(nVars).fill(0);
        const reg = Math.max(1e-4, 1e-2 * norm2, extraReg);
        for (let i = 0; i < nVars; i++) {
          for (let j = 0; j < nVars; j++) {
            let s = 0; for (let k = 0; k < nVars; k++) s += J[k][i] * J[k][j];
            JTJ[i][j] = s + (i === j ? reg : 0);
          }
          let s2 = 0; for (let k = 0; k < nVars; k++) s2 += J[k][i] * negR[k];
          JTr[i] = s2;
        }
        dx = solveLinearSystem(JTJ, JTr) || new Array(nVars).fill(0);
      }
      const maxSteps = solveP2 ? [2.2, 5.5, 35.0, 2.2] : [2.2, 35.0, 2.2];
      let scale = 1.0;
      for (let i = 0; i < nVars; i++) {
        if (Math.abs(dx[i]) > maxSteps[i]) scale = Math.min(scale, maxSteps[i] / Math.abs(dx[i]));
      }
      return dx.map(v => v * scale);
    }

    // 전역 뉴턴 스텝 + Armijo 백트래킹 라인서치 (정체 시 중앙차분 + LM 보강)
    function newtonStep(curEval) {
      const { vec, R, norm2 } = curEval;
      const J = computeJacobian(vec, R, false);
      const dx = solveNewtonDir(J, R, norm2);

      let bestEval = null, bestLam = 1.0;
      const lambdas = [1.0, 0.5, 0.25, 0.125, 0.0625, 0.03125];
      for (const lam of lambdas) {
        const trialVec = projectBox(vec.map((v, i) => v + lam * dx[i]));
        const trialEval = evalVec(trialVec);
        if (!bestEval || trialEval.norm2 < bestEval.norm2) {
          bestEval = trialEval;
          bestLam = lam;
        }
        if (trialEval.norm2 < (1 - 1e-4 * lam) * norm2) {
          return { nextEval: trialEval, lambda: lam };
        }
      }
      // 전방차분 라인서치가 감소 실패 시 중앙차분 야코비안 + LM 스텝으로 즉시 회복
      const Jc = computeJacobian(vec, R, true);
      for (const reg of [0, 1e-3, 1e-1]) {
        const dxc = solveNewtonDir(Jc, R, norm2, reg);
        for (const lam of [1.0, 0.5, 0.25, 0.1]) {
          const trialEval = evalVec(projectBox(vec.map((v, i) => v + lam * dxc[i])));
          if (trialEval.norm2 < bestEval.norm2) {
            bestEval = trialEval;
            bestLam = lam;
          }
          if (trialEval.norm2 < (1 - 1e-4 * lam) * norm2) {
            return { nextEval: trialEval, lambda: lam };
          }
        }
      }
      return { nextEval: bestEval, lambda: bestLam };
    }

    // 안정화 고정점(Chord-Picard) 연산자 G(x) = x + α·Δx_chord (5회마다 기준 야코비안 갱신, 선형 수렴율 α 제어)
    let chordJ = null, chordAge = 0;
    function fixedPointOp(curEval, alphaEff, refreshChord = false) {
      if (!chordJ || refreshChord || chordAge >= 5) {
        chordJ = computeJacobian(curEval.vec, curEval.R);
        chordAge = 0;
      }
      chordAge++;
      const dx = solveNewtonDir(chordJ, curEval.R, curEval.norm2);
      const a = Math.min(1.0, Math.max(0.1, alphaEff));
      let trialEval = evalVec(projectBox(curEval.vec.map((v, i) => v + a * dx[i])));
      if (trialEval.norm2 > curEval.norm2 * 1.15) {
        // 비선형 구간에서 기준 야코비안이 오래되었으면 즉시 갱신 후 백트래킹
        chordJ = computeJacobian(curEval.vec, curEval.R);
        chordAge = 0;
        const dxFresh = solveNewtonDir(chordJ, curEval.R, curEval.norm2);
        for (const fac of [a, a * 0.5, a * 0.25]) {
          const cand = evalVec(projectBox(curEval.vec.map((v, i) => v + fac * dxFresh[i])));
          if (cand.norm2 < trialEval.norm2) trialEval = cand;
          if (cand.norm2 < curEval.norm2) break;
        }
      }
      return trialEval;
    }

    // 표준 Steffensen / Aitken Δ² 가속 스텝: y = G(x), z = G(y), x_acc = x - (y-x)^2 / (z - 2y + x)
    function aitkenStep(curEval, alphaEff) {
      // 동일 연산자 G(x)로 y=G(x), z=G(y) 연속 평가 (야코비안 고정!)
      const evalY = fixedPointOp(curEval, alphaEff, true);
      if (evalY.isDone) return { nextEval: evalY, lambda: alphaEff };
      const evalZ = fixedPointOp(evalY, alphaEff, false);
      if (evalZ.isDone) return { nextEval: evalZ, lambda: alphaEff };

      const x0 = curEval.vec, x1 = evalY.vec, x2 = evalZ.vec;
      const xAcc = projectBox(x0.map((v, i) => {
        const d1 = x1[i] - v;
        const d2 = x2[i] - 2 * x1[i] + v;
        if (Math.abs(d2) > 1e-8) {
          const cand = v - (d1 * d1) / d2;
          if (Math.abs(cand - x2[i]) < 4.0 * (Math.abs(d1) + 0.5)) return cand;
        }
        return x2[i];
      }));
      const evalAcc = evalVec(xAcc);
      const best = [evalAcc, evalZ, evalY].reduce((a, b) => (b.norm2 < a.norm2 ? b : a));
      return { nextEval: best, lambda: alphaEff };
    }

    const xInit = projectBox(solveP2 ? [P1_0, P2_0, h1_0, P4_0] : [P1_0, h1_0, P4_0]);
    return { opts, simNodes, simEdges, comp, feedbackEdge, xInit, evalVec, newtonStep, fixedPointOp, aitkenStep, refProp };
  }

  function finalizeResult(runner, curEval, converged, iter, history) {
    const { opts, simNodes, simEdges, comp, refProp } = runner;
    // 최종 수렴 상태로 모든 노드/엣지 확정 동기화
    const finalEval = runner.evalVec(curEval.vec);
    const propWarnings = (refProp && refProp.getWarnings) ? refProp.getWarnings() : [];
    const allWarnings = [...new Set([...(finalEval.conservation.warnings || []), ...propWarnings])];
    finalEval.conservation.warnings = allWarnings;

    const milestones = extractMilestones(history);
    const sv = finalEval.sv;
    return {
      simNodes,
      simEdges,
      convergence: {
        loop_mode: opts.loop_mode,
        num_method: opts.num_method,
        converged,
        iterations: Math.min(iter, opts.maxIter),
        maxIter: opts.maxIter,
        residualT: finalEval.resT,
        residualP: finalEval.resP,
        residualH: finalEval.resH,
        residualNorm: finalEval.normInf,
        convergedP1: sv.P1,
        convergedP2: sv.P2,
        solutionState: { P1: sv.P1, P2: sv.P2, h1: sv.h1, P4: sv.P4 },
        secondLawOk: finalEval.secondLawOk,
        milestones,
        warnings: allWarnings,
        conservation: finalEval.conservation,
        history
      }
    };
  }

  function pushHistory(history, iter, ev, lam) {
    history.push({
      iter,
      P1: ev.sv.P1,
      P2: ev.sv.P2,
      P4: ev.sv.P4,
      T1: ev.T1_C ?? 0,
      m_dot: ev.conservation.mass.m_comp_kgs,
      resT: ev.resT,
      resP: ev.resP,
      resH: ev.resH,
      resNorm: ev.normInf,
      resM: Math.abs(ev.resM_g),
      resMassFlow_pct: ev.resMassFlow_pct,
      resM_g: ev.resM_g,
      resE_pct: ev.resE_pct,
      resE_kW: ev.resE_kW,
      resMom_bar: ev.resMom_bar,
      massOk: ev.massOk,
      energyOk: ev.energyOk,
      momOk: ev.momOk,
      secondLawOk: ev.secondLawOk,
      solverResOk: ev.solverResOk,
      lambda: lam
    });
  }

  function solve(nodes, edges, fluid, refProp, rawOpts = {}) {
    const runner = createSolverRunner(nodes, edges, fluid, refProp, rawOpts);
    const { opts, simNodes, simEdges, comp, feedbackEdge } = runner;
    const history = [];

    if (opts.loop_mode === "open" || !comp || !feedbackEdge) {
      runCoupledPass(simNodes, simEdges, fluid, refProp, opts, null, null);
      const recMap = buildAutoReceiverMap(simNodes, opts, refProp);
      if (recMap) runCoupledPass(simNodes, simEdges, fluid, refProp, opts, null, recMap);
      const conservation = evaluateConservation(simNodes, simEdges, opts);
      return {
        simNodes, simEdges,
        convergence: {
          loop_mode: "open", num_method: opts.num_method, converged: true, iterations: 1, maxIter: opts.maxIter,
          residualT: 0, residualP: 0, residualH: 0, residualNorm: 0, secondLawOk: conservation.energy.secondLawOk,
          milestones: { massIter: 1, energyIter: 1, momentumIter: 1, solverResIter: 1, orderSorted: [] },
          warnings: conservation.warnings || [], conservation, history
        }
      };
    }

    let curEval = runner.evalVec(runner.xInit);
    let iter = 0, converged = false, lastLam = 1.0;

    for (iter = 1; iter <= opts.maxIter; iter++) {
      pushHistory(history, iter, curEval, lastLam);
      if (curEval.isDone) { converged = true; break; }
      if (iter === opts.maxIter) break;

      if (opts.num_method === "fixed_point") {
        curEval = runner.fixedPointOp(curEval, opts.alpha);
        lastLam = opts.alpha;
      } else if (opts.num_method === "aitken") {
        const st = runner.aitkenStep(curEval, opts.alpha);
        curEval = st.nextEval; lastLam = st.lambda;
      } else {
        const st = runner.newtonStep(curEval);
        curEval = st.nextEval; lastLam = st.lambda;
      }
    }

    return finalizeResult(runner, curEval, converged, iter, history);
  }

  async function solveAsync(nodes, edges, fluid, refProp, rawOpts = {}, onProgress = null) {
    const runner = createSolverRunner(nodes, edges, fluid, refProp, rawOpts);
    const { opts, simNodes, simEdges, comp, feedbackEdge } = runner;
    const history = [];

    if (opts.loop_mode === "open" || !comp || !feedbackEdge) {
      runCoupledPass(simNodes, simEdges, fluid, refProp, opts, null, null);
      const recMap = buildAutoReceiverMap(simNodes, opts, refProp);
      if (recMap) runCoupledPass(simNodes, simEdges, fluid, refProp, opts, null, recMap);
      const conservation = evaluateConservation(simNodes, simEdges, opts);
      return {
        simNodes, simEdges,
        convergence: {
          loop_mode: "open", num_method: opts.num_method, converged: true, iterations: 1, maxIter: opts.maxIter,
          residualT: 0, residualP: 0, residualH: 0, residualNorm: 0, secondLawOk: conservation.energy.secondLawOk,
          milestones: { massIter: 1, energyIter: 1, momentumIter: 1, solverResIter: 1, orderSorted: [] },
          warnings: conservation.warnings || [], conservation, history
        }
      };
    }

    let curEval = runner.evalVec(runner.xInit);
    let iter = 0, converged = false, lastLam = 1.0;

    for (iter = 1; iter <= opts.maxIter; iter++) {
      pushHistory(history, iter, curEval, lastLam);
      if (onProgress) {
        onProgress({
          iter, maxIter: opts.maxIter,
          P1: curEval.sv.P1, P2: curEval.sv.P2,
          resT: curEval.resT, resP: curEval.resP, resH: curEval.resH, resNorm: curEval.normInf,
          conservation: curEval.conservation,
          massOk: curEval.massOk, energyOk: curEval.energyOk, momOk: curEval.momOk,
          secondLawOk: curEval.secondLawOk, solverResOk: curEval.solverResOk
        });
      }
      if (curEval.isDone) { converged = true; break; }
      if (iter === opts.maxIter) break;

      if (opts.num_method === "fixed_point") {
        curEval = runner.fixedPointOp(curEval, opts.alpha);
        lastLam = opts.alpha;
      } else if (opts.num_method === "aitken") {
        const st = runner.aitkenStep(curEval, opts.alpha);
        curEval = st.nextEval; lastLam = st.lambda;
      } else {
        const st = runner.newtonStep(curEval);
        curEval = st.nextEval; lastLam = st.lambda;
      }

      if (opts.delayMs > 0) await new Promise(r => setTimeout(r, opts.delayMs));
    }

    return finalizeResult(runner, curEval, converged, iter, history);
  }

  function optimizeAlpha(nodes, edges, fluid, refProp, baseOpts = {}) {
    const candidates = [0.2, 0.35, 0.45, 0.55, 0.7, 0.85, 1.0];
    let best = null;
    for (const a of candidates) {
      const res = solve(nodes, edges, fluid, refProp, { ...baseOpts, alpha: a, loop_mode: "closed" });
      const c = res.convergence;
      const score = c.residualNorm + c.residualT + c.residualH * 0.1;
      if (!best || (c.converged && !best.converged) || (c.converged === best.converged && c.iterations < best.iter) || (c.converged === best.converged && c.iterations === best.iter && score < best.score)) {
        best = { alpha: a, converged: c.converged, iter: c.iterations, resT: c.residualT, resH: c.residualH, score };
      }
    }
    return { best };
  }

  global.SolverModule = {
    solve, solveAsync, optimizeAlpha, validateCircuit,
    evalSignalNode, findConnectedSignal, findConnectedFan,
    getEdgePipeSpec, calcPipeSegment,
    isHxType, isSensorType, isSignalType, isFlowNode,
    GOVERNING_DOCS, NUMERICAL_DOCS
  };
})(window);
