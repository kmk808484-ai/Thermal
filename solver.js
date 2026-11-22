// solver.js — 지배방정식(보존법칙) + 수치해석 기법 분리 솔버 + 센서/TXV 피드백 + 신호 컴포넌트(상수/계단/시나리오) + 팬 성능곡선 연동
(function (global) {
  const GOVERNING_DOCS = {
    mass: "질량보존 (Mass & Charge): 전 구간 질량유량 연속성(m_dot = const)과 총 냉매 충전량(ΣM_i = M_charge) 및 어큐뮬레이터·리시버 액위 균형",
    energy: "에너지보존 (1st Law Energy): 폐회로 엔탈피 폐합(h_1' - h_1 = 0)을 만족하도록 토출압(P2) 자동 탐색 및 Q_cond = Q_evap + W_gas 검증",
    momentum: "모멘텀보존 (Momentum ΔP): 열교환기 마찰+가속 ΔP, 어큐뮬레이터·배관 손실, 팽창밸브 오리피스 유량-ΔP의 폐회로 압력 폐합(ΔP_comp = ΣΔP_i)"
  };

  const NUMERICAL_DOCS = {
    newton_secant: {
      name: "준-뉴턴 / 할선법 (Quasi-Newton / Secant)",
      formula: "x_{k+1} = x_k - α · F(x_k) / [ (F(x_k) - F(x_{k-1})) / (x_k - x_{k-1}) ]",
      pros: "에너지 잔차(e_h)에 대한 토출압(P2) 민감도(기울기)를 수치 미분해 가장 빠르게 평형점에 수렴합니다.",
      tip: "에너지보존(P2 자동 탐색) 및 TXV 과열도 제어를 함께 풀 때 기본 권장 알고리즘입니다."
    },
    fixed_point: {
      name: "고정점 완화법 (Picard Under-Relaxation)",
      formula: "x_{k+1} = x_k + α · (x_fb - x_k)",
      pros: "비선형 2상 경계나 급격한 조건 변화에서도 발산하지 않고 매우 안정적으로 수렴합니다.",
      tip: "초기 조건이 크게 어긋나거나 진동이 발생할 때 완화계수 α를 0.3~0.5로 낮춰 사용하세요."
    },
    aitken: {
      name: "Aitken Δ² 가속법 (Steffensen Acceleration)",
      formula: "x_next = x_0 - (x_1 - x_0)² / (x_2 - 2x_1 + x_0)",
      pros: "연속 3회 고정점 궤적으로 선형 수렴 속도를 2차 수렴에 가깝게 가속합니다.",
      tip: "고정점 반복이 완만하게 수렴할 때 반복 횟수를 줄이기 위해 사용합니다."
    }
  };

  function isHxType(type) {
    return type === "hx" || type === "hx_fin_plate" || type === "hx_plate";
  }
  function isSensorType(type) {
    return type === "sensor_p" || type === "sensor_t" || type === "sensor_sh";
  }
  function isSignalType(type) {
    return type === "sig_const" || type === "sig_step" || type === "sig_scenario";
  }
  function isFlowNode(type) {
    return type === "compressor" || isHxType(type) || type === "valve" || type === "receiver";
  }

  // 신호 컴포넌트(상수 / 계단함수 / 시나리오함수) 시각 t [s]에서의 출력값 평가
  function evalSignalNode(sigNode, t_sec = 0) {
    const p = sigNode.params || {};
    if (sigNode.type === "sig_const") {
      return Number(p.value ?? p.val ?? -5.5);
    }
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
        if (cols.length >= 2 && !Number.isNaN(cols[0]) && !Number.isNaN(cols[1])) {
          pts.push({ t: cols[0], v: cols[1] });
        }
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

  // 신호 컴포넌트는 반드시 실제 선(edge.kind === "signal")으로 연결되어야 함!
  function findConnectedSignal(targetNode, simNodes, simEdges) {
    const edge = (simEdges || []).find(e => e.to === targetNode.id && e.kind === "signal");
    if (edge) {
      const s = simNodes.find(n => n.id === edge.from && isSignalType(n.type));
      if (s) return s;
    }
    return null;
  }

  // 핀-플레이트 열교환기에 실제 보조 배관(edge.kind === "air" 또는 fan->hx 연결선)으로 부착된 팬 탐색!
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

  function validateCircuit(nodes, edges) {
    const solverNode = nodes.find(n => n.type === "solver");
    const refNodes = nodes.filter(n => n.type === "refrigerant");
    const errors = [];
    const mismatchEdgeIds = new Set();

    if (!solverNode) errors.push("캔버스에 [솔버] 노드가 없습니다. 시스템 제어 폴더에서 솔버를 배치해 주세요.");
    if (refNodes.length === 0) errors.push("캔버스에 [냉매] 노드가 없습니다. 시스템 제어 폴더에서 냉매를 배치해 주세요.");

    const refIdSet = new Set(refNodes.map(r => r.id));
    const definedFluids = new Set(refNodes.map(r => r.params && r.params.fluid));

    nodes.filter(n => isFlowNode(n.type)).forEach(n => {
      if (!n.params.fluidNodeId || !refIdSet.has(n.params.fluidNodeId)) {
        errors.push(`[${n.modelName}]에 유효한 냉매/유체 노드가 지정되지 않았습니다.`);
      }
      // 고정 열부하 모드일 때 신호 컴포넌트 선 연결 필수 검증
      if (isHxType(n.type) && n.params.sec_mode === "const_Q") {
        const sig = findConnectedSignal(n, nodes, edges);
        if (!sig) {
          errors.push(`[${n.modelName}]가 고정 열부하(const_Q) 모드입니다. 신호 컴포넌트(상수/계단/시나리오)에서 직접 선을 끌어 연결해 주세요.`);
        }
      }
      // 상대측 유체(Air, Water, GW 등)를 쓸 때 해당 유체 노드가 캔버스에 정의되어 있는지 검증!
      if (isHxType(n.type) && n.params.sec_mode !== "const_Q") {
        const secFluid = n.params.sec_fluid || (n.type === "hx_plate" ? "GW" : "Air");
        if (!definedFluids.has(secFluid)) {
          errors.push(`[${n.modelName}]의 상대측 유체 [${secFluid}]가 캔버스의 유체(냉매) 노드에 정의되어 있지 않습니다. [${secFluid}] 유체 노드를 배치해 주세요.`);
        }
      }
      // 핀-플레이트 열교환기(공기측 유체 모드)는 팬이 보조 포트에 직접 선으로 연결되어야 함!
      if (n.type === "hx_fin_plate" && n.params.sec_mode !== "const_Q") {
        const fan = findConnectedFan(n, nodes, edges);
        if (!fan) {
          errors.push(`[${n.modelName}]의 공기측 포트(상/하단 하늘색 포트)에 [팬 / 블로워]가 직접 선으로 연결되어 있지 않습니다.`);
        }
      }
    });

    // 캔버스에 배치된 신호 컴포넌트가 아무 컴포넌트에도 선으로 연결되지 않았으면 실행 불가!
    nodes.filter(n => isSignalType(n.type)).forEach(sig => {
      const hasWire = edges.some(e => e.from === sig.id && e.kind === "signal");
      if (!hasWire) {
        errors.push(`[${sig.modelName}]가 어느 컴포넌트에도 선으로 연결되어 있지 않습니다. 출력 포트에서 대상 컴포넌트(열교환기/압축기/팬)로 선을 연결해 주세요.`);
      }
    });

    // 팬 컴포넌트 성능곡선(P-Q Curve CSV) 및 핀-플레이트 HX 직접 선 연결 필수 검증!
    const FM = global.FanModule;
    nodes.filter(n => n.type === "fan").forEach(fan => {
      try {
        if (FM) FM.parseFanCurveCSV(fan.params.curve_csv);
      } catch (err) {
        errors.push(`[${fan.modelName}] 팬/펌프 곡선 오류: ${err.message}`);
      }
      const hasAirWire = edges.some(e => (e.from === fan.id || e.to === fan.id) && e.kind === "air");
      if (!hasAirWire) {
        errors.push(`[${fan.modelName}]가 핀-플레이트 열교환기의 공기측 포트에 직접 선으로 부착되어 있지 않습니다.`);
      }
    });

    edges.filter(e => !e.kind || e.kind === "flow").forEach(e => {
      const a = nodes.find(n => n.id === e.from);
      const b = nodes.find(n => n.id === e.to);
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
    const FM = global.FanModule;
    const HX = global.HXModule;

    // 1. 모든 신호 컴포넌트 출력값 계산
    simNodes.filter(n => isSignalType(n.type)).forEach(sig => {
      const val = evalSignalNode(sig, t_sec);
      sig.result = { value: val, t_sec };
    });

    // 2. 팬 컴포넌트 운전점 계산 (신호 컴포넌트 RPM 또는 전역 팬 RPM + 연결된 열교환기 시스템 저항)
    simNodes.filter(n => n.type === "fan").forEach(fan => {
      const sig = findConnectedSignal(fan, simNodes, simEdges);
      if (sig && sig.result) {
        fan.params.rpm = Math.max(100, sig.result.value);
      } else if (cfg.fan_rpm !== undefined && fan.params.link_global !== false) {
        fan.params.rpm = cfg.fan_rpm;
      }

      // 직접 선(edge.kind === "air")으로 연결된 열교환기 탐색 후 공기측 저항 계수 K_hx 계산
      let K_hx = fan.params.K_sys || fan.params.K_sys_default || 0.14;
      const airEdge = (simEdges || []).find(e => (e.from === fan.id || e.to === fan.id) && e.kind === "air");
      const targetHx = airEdge ? simNodes.find(h => (h.id === airEdge.from || h.id === airEdge.to) && isHxType(h.type)) : null;
      if (targetHx && HX) {
        const geo = HX.calcGeometry(targetHx.params);
        const f_air = (targetHx.params.fin_type || "louver") === "flat" ? 0.042 : 0.078;
        const dP_at_45 = f_air * (geo.L_sec / Math.max(0.001, geo.Dh_sec)) * Math.pow((45 / 60 * 1.15) / Math.max(0.02, geo.A_cross_sec), 2) / (2 * 1.15);
        K_hx = Math.max(0.02, dP_at_45 / Math.pow(45, 1.75));
      }
      if (FM) {
        try {
          fan.result = FM.run(fan.params, K_hx, 1.15);
        } catch {}
      }
    });

    // 3. 압축기 및 열교환기 조건 반영
    simNodes.forEach(n => {
      if (n.type === "compressor") {
        const sig = findConnectedSignal(n, simNodes, simEdges);
        if (sig && sig.result) {
          n.params.rpm = Math.max(300, sig.result.value);
        } else if (cfg.comp_rpm !== undefined && n.params.link_global !== false) {
          n.params.rpm = cfg.comp_rpm;
        }
      } else if (isHxType(n.type)) {
        if (n.type === "hx_fin_plate") n.params.hxType = "fin_plate";
        if (n.type === "hx_plate") n.params.hxType = "plate";
        if (!govMomentum) { n.params.auto_dP = false; n.params.dP_bar = 0; }
        if (cfg.T_amb_C !== undefined && n.params.link_ambient) {
          n.params.T_sec_in = cfg.T_amb_C; n.params.T_air_in = cfg.T_amb_C;
        }
        // 고정 열부하 모드: 연결된 신호 컴포넌트에서 열부하 Q [kW] 주입!
        const sig = findConnectedSignal(n, simNodes, simEdges);
        if (n.params.sec_mode === "const_Q" && sig && sig.result) {
          n.params.Q_source_kW = sig.result.value;
        }
        // 직접 선으로 연결된 팬 컴포넌트가 있으면 팬 곡선 교차 운전점 풍량(m_air_kgs) 주입!
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

  function getValveSensorFeedback(valveNode, simNodes, simEdges, prevSensorMap) {
    const sigEdge = simEdges.find(e => e.to === valveNode.id && e.kind === "signal");
    if (sigEdge && prevSensorMap && prevSensorMap.has(sigEdge.from)) {
      return prevSensorMap.get(sigEdge.from);
    }
    if (valveNode.params.sensorNodeId && prevSensorMap && prevSensorMap.has(valveNode.params.sensorNodeId)) {
      return prevSensorMap.get(valveNode.params.sensorNodeId);
    }
    return null;
  }

  function runSinglePass(simNodes, simEdges, fluid, refProp, opts = {}, h1Feedback = null, recAssignedMass = null, prevSensorMap = null) {
    const CM = global.CompressorModule, HX = global.HXModule, VM = global.ValveModule, RM = global.ReceiverModule;
    const fluidTableDB = opts.fluidTableDB || null;
    const govMomentum = opts.gov_momentum !== false;

    simNodes.forEach(n => { if (isFlowNode(n.type)) n.result = null; });
    simEdges.filter(e => !e.kind || e.kind === "flow").forEach(e => (e.stream = null));

    const queue = [];
    simNodes.filter(n => n.type === "compressor").forEach(comp => {
      const maps = {
        is: new CM.EfficiencyMap2D(comp.params.csv_is),
        vol: new CM.EfficiencyMap2D(comp.params.csv_vol),
        mech: new CM.EfficiencyMap2D(comp.params.csv_mech)
      };
      const res = CM.run({ fluid, ...comp.params, h1_override: h1Feedback }, maps, refProp);
      comp.result = { ...res, outStream: res.outlet };
      queue.push(comp);
    });

    const visited = new Set(queue.map(n => n.id));
    let guard = 0;
    while (queue.length > 0 && guard++ < 80) {
      const cur = queue.shift();
      simEdges.filter(e => e.from === cur.id && (!e.kind || e.kind === "flow")).forEach(edge => {
        const sIn = cur.result.outStream;
        const pipeVol_m3 = 0.00006;
        let dP_pipe_bar = 0;
        if (govMomentum) {
          const A_pipe = Math.PI * 0.01 * 0.01 / 4;
          const G_pipe = sIn.m_dot / A_pipe;
          dP_pipe_bar = Math.min(0.15, (0.025 * (0.8 / 0.01) * G_pipe * G_pipe) / (2 * Math.max(1.0, sIn.rho || 30) * 1e5));
        }
        const P_pipe_out = Math.max(0.5, sIn.P_bar - dP_pipe_bar);
        const stPipe = dP_pipe_bar > 1e-4 ? refProp.evalPH(P_pipe_out, sIn.h_kJkg) : null;
        const outStream = stPipe ? {
          ...sIn, P_bar: P_pipe_out, T_C: stPipe.T, rho: stPipe.rho, s_kJkgK: stPipe.s,
          mu: stPipe.mu, k: stPipe.k, Cp: stPipe.Cp, T_sat_C: stPipe.T_sat, quality: stPipe.x,
          pipe_dP_bar: dP_pipe_bar, pipe_mass_kg: pipeVol_m3 * stPipe.rho
        } : { ...sIn, pipe_dP_bar: 0, pipe_mass_kg: pipeVol_m3 * (sIn.rho || 30) };

        edge.stream = outStream;
        const target = simNodes.find(n => n.id === edge.to);
        if (!target || visited.has(target.id) || !isFlowNode(target.type)) return;

        if (isHxType(target.type)) {
          const res = HX.run(edge.stream, target.params, refProp, fluidTableDB);
          target.result = { ...res, outStream: res.outlet };
        } else if (target.type === "valve") {
          const fb = getValveSensorFeedback(target, simNodes, simEdges, prevSensorMap);
          const res = VM.run(edge.stream, target.params, refProp, fb);
          target.result = { ...res, outStream: res.outlet };
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

    updateSensors(simNodes, simEdges);
  }

  function snapshotSensors(simNodes) {
    const map = new Map();
    simNodes.filter(n => isSensorType(n.type) && n.result).forEach(s => map.set(s.id, { ...s.result }));
    return map;
  }

  function evaluateConservation(simNodes, simEdges, opts) {
    const refNode = simNodes.find(n => n.type === "refrigerant");
    const chargeMode = (refNode && refNode.params.charge_mode) || "auto";
    const autoRecLevel = (refNode && refNode.params.auto_rec_level_pct !== undefined) ? refNode.params.auto_rec_level_pct : 45;
    const manualCharge_g = (refNode && refNode.params.charge_g > 0) ? refNode.params.charge_g : 650;

    let M_comp = 0, M_hx = 0, M_valve = 0, M_rec = 0, M_pipe = 0, M_rec_auto_kg = 0;
    let Q_cond = 0, Q_evap = 0, W_gas = 0, W_shaft = 0, W_fan = 0;
    let dP_comp = 0, dP_loop = 0;

    simNodes.forEach(n => {
      if (n.type === "fan" && n.result) {
        W_fan += n.result.metrics.W_fan_kW || 0;
      }
      if (!n.result || !isFlowNode(n.type)) return;
      const m = n.result.metrics || {};
      if (n.type === "compressor") {
        M_comp += m.mass_kg || 0; W_gas += m.W_gas_kW || 0; W_shaft += m.W_shaft_kW || 0;
        dP_comp += Math.max(0, n.result.outlet.P_bar - n.result.inlet.P_bar);
      } else if (isHxType(n.type)) {
        M_hx += m.mass_kg || 0;
        if (m.isCondenser) Q_cond += m.Q_kW || 0; else Q_evap += m.Q_kW || 0;
        dP_loop += m.dP_bar || 0;
      } else if (n.type === "valve") {
        M_valve += m.mass_kg || 0; dP_loop += m.dP_bar || 0;
      } else if (n.type === "receiver") {
        M_rec += m.mass_kg || 0;
        const lvFrac = Math.min(0.95, Math.max(0.05, autoRecLevel / 100));
        M_rec_auto_kg += (m.mass_min_kg || 0) + lvFrac * Math.max(0, (m.mass_max_kg || 0) - (m.mass_min_kg || 0));
        dP_loop += m.dP_bar || 0;
      }
    });

    simEdges.filter(e => !e.kind || e.kind === "flow").forEach(e => {
      if (e.stream) { M_pipe += e.stream.pipe_mass_kg || 0; dP_loop += e.stream.pipe_dP_bar || 0; }
    });

    const M_others_kg = M_comp + M_hx + M_valve + M_pipe;
    const autoTarget_kg = M_others_kg + M_rec_auto_kg;
    const targetCharge_kg = chargeMode === "auto" ? autoTarget_kg : (manualCharge_g / 1000);
    const M_total_kg = M_others_kg + M_rec;
    const resM_g = (M_total_kg - targetCharge_kg) * 1000;
    const resE_kW = Math.abs(Q_cond - (Q_evap + W_gas));
    const resE_pct = Q_cond > 1e-3 ? (resE_kW / Q_cond) * 100 : 0;
    const resMomentum_bar = Math.abs(dP_comp - dP_loop);

    return {
      mass: { charge_mode: chargeMode, auto_rec_level_pct: autoRecLevel, target_g: targetCharge_kg * 1000, total_g: M_total_kg * 1000, others_kg: M_others_kg, hx_g: M_hx * 1000, rec_g: M_rec * 1000, pipe_g: M_pipe * 1000, comp_g: M_comp * 1000, residual_g: resM_g },
      energy: { Q_cond, Q_evap, W_gas, W_shaft, W_fan, residual_kW: resE_kW, residual_pct: resE_pct },
      momentum: { dP_comp_bar: dP_comp, dP_loop_bar: dP_loop, residual_bar: resMomentum_bar }
    };
  }

  function computeReceiverAssignment(simNodes, simEdges, opts) {
    if (opts.gov_mass === false) return null;
    const recs = simNodes.filter(n => n.type === "receiver" && n.result);
    if (recs.length === 0) return null;
    const cons = evaluateConservation(simNodes, simEdges, opts);
    const map = new Map();
    if (cons.mass.charge_mode === "auto") {
      const lvFrac = Math.min(0.95, Math.max(0.05, cons.mass.auto_rec_level_pct / 100));
      recs.forEach(r => {
        const m = r.result.metrics;
        map.set(r.id, m.mass_min_kg + lvFrac * Math.max(0, m.mass_max_kg - m.mass_min_kg));
      });
      return map;
    }
    const target_kg = cons.mass.target_g / 1000;
    const rem_kg = target_kg - cons.mass.others_kg;
    const totalVol = recs.reduce((acc, r) => acc + (r.result.metrics.vol_L || 1.2), 0) || 1;
    recs.forEach(r => { map.set(r.id, rem_kg * ((r.result.metrics.vol_L || 1.2) / totalVol)); });
    return map;
  }

  function prepareState(nodes, edges, opts) {
    const simNodes = nodes.map(n => ({ ...n, params: { ...n.params }, result: null }));
    const simEdges = edges.map(e => ({ ...e, stream: null }));
    applySimConfig(simNodes, simEdges, opts);
    const comp = simNodes.find(n => n.type === "compressor");
    const feedbackEdge = comp ? simEdges.find(e => e.to === comp.id && (!e.kind || e.kind === "flow")) : null;
    return { simNodes, simEdges, comp, feedbackEdge };
  }

  function stepUpdate(numMethod, govEnergy, comp, feedbackEdge, history, state, alpha) {
    const prevT = comp.params.T1_C, prevP = comp.params.P1_bar, prevP2 = comp.params.P2_bar;
    const T_fb = feedbackEdge.stream.T_C, P_fb = feedbackEdge.stream.P_bar, h_fb = feedbackEdge.stream.h_kJkg;
    const h_in = comp.result.inlet.h_kJkg;
    const e_h = h_fb - h_in;

    if (numMethod === "aitken" && history.length >= 3) {
      const h0 = history[history.length - 3], h1 = history[history.length - 2];
      const dT = T_fb - 2 * h1.T1 + h0.T1, dP = P_fb - 2 * h1.P1 + h0.P1;
      const nextT = Math.abs(dT) > 1e-4 ? h0.T1 - Math.pow(h1.T1 - h0.T1, 2) / dT : prevT + alpha * (T_fb - prevT);
      const nextP = Math.abs(dP) > 1e-4 ? h0.P1 - Math.pow(h1.P1 - h0.P1, 2) / dP : prevP + alpha * (P_fb - prevP);
      comp.params.T1_C = Math.max(-50, Math.min(120, nextT));
      comp.params.P1_bar = Math.max(0.6, Math.min(35, nextP));
    } else {
      comp.params.T1_C = prevT + alpha * (T_fb - prevT);
      comp.params.P1_bar = Math.max(0.6, prevP + alpha * (P_fb - prevP));
    }

    if (govEnergy) {
      let dP2 = 0;
      if (numMethod === "newton_secant" && state.lastP2 !== null && Math.abs(prevP2 - state.lastP2) > 1e-4) {
        const slope = (e_h - state.lastEh) / (prevP2 - state.lastP2);
        dP2 = Math.abs(slope) > 1e-3 ? (-e_h / slope) : Math.sign(e_h) * 0.4;
      } else {
        dP2 = Math.max(-1.5, Math.min(1.5, e_h * 0.04));
      }
      dP2 = Math.max(-2.5, Math.min(2.5, dP2)) * Math.max(0.25, alpha);
      state.lastP2 = prevP2; state.lastEh = e_h;
      const minP2 = comp.params.P1_bar * 1.18, maxP2 = state.pMaxLimit || 45.0;
      comp.params.P2_bar = Math.max(minP2, Math.min(maxP2, prevP2 + dP2));
    }

    state.h1Cur = h_in + alpha * (h_fb - h_in);
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
      alpha: opts.alpha || 0.45,
      delayMs: opts.delayMs ?? 10,
      simConfig: opts.simConfig || {},
      fluidTableDB: opts.fluidTableDB || null,
      override: opts.override || null
    };
  }

  function solve(nodes, edges, fluid, refProp, rawOpts = {}) {
    const opts = normalizeOpts(rawOpts);
    const { simNodes, simEdges, comp, feedbackEdge } = prepareState(nodes, edges, opts);
    const history = [];
    const pMaxLimit = (refProp.sat && refProp.sat.P) ? refProp.sat.P[refProp.sat.P.length - 1] * 0.98 : 45.0;

    if (opts.loop_mode === "open" || !comp || !feedbackEdge) {
      runSinglePass(simNodes, simEdges, fluid, refProp, opts, null, null, null);
      const recMap = computeReceiverAssignment(simNodes, simEdges, opts);
      if (recMap) runSinglePass(simNodes, simEdges, fluid, refProp, opts, null, recMap, snapshotSensors(simNodes));
      const conservation = evaluateConservation(simNodes, simEdges, opts);
      return { simNodes, simEdges, convergence: { loop_mode: "open", num_method: opts.num_method, converged: true, iterations: 1, maxIter: opts.maxIter, residualT: 0, residualP: 0, residualH: 0, conservation, history } };
    }

    const state = { h1Cur: null, lastP2: null, lastEh: null, recMap: null, sensorMap: null, pMaxLimit };
    let iter = 0, resT = 999, resP = 999, resH = 999, converged = false, conservation = null;

    for (iter = 1; iter <= opts.maxIter; iter++) {
      const prevT = comp.params.T1_C, prevP = comp.params.P1_bar;
      runSinglePass(simNodes, simEdges, fluid, refProp, opts, state.h1Cur, state.recMap, state.sensorMap);
      if (!feedbackEdge.stream) break;

      state.sensorMap = snapshotSensors(simNodes);
      state.recMap = computeReceiverAssignment(simNodes, simEdges, opts);
      conservation = evaluateConservation(simNodes, simEdges, opts);

      resT = Math.abs(feedbackEdge.stream.T_C - prevT);
      resP = Math.abs(feedbackEdge.stream.P_bar - prevP);
      resH = Math.abs(feedbackEdge.stream.h_kJkg - comp.result.inlet.h_kJkg);
      history.push({ iter, T1: prevT, P1: prevP, P2: comp.params.P2_bar, resT, resP, resH, resM: Math.abs(conservation.mass.residual_g) });

      const isDone = opts.gov_energy ? (resT <= opts.tolT && resP <= opts.tolP && resH <= opts.tolH) : (resT <= opts.tolT && resP <= opts.tolP);
      if (isDone) { converged = true; break; }
      stepUpdate(opts.num_method, opts.gov_energy, comp, feedbackEdge, history, state, opts.alpha);
    }

    if (state.recMap) {
      runSinglePass(simNodes, simEdges, fluid, refProp, opts, state.h1Cur, state.recMap, state.sensorMap);
      conservation = evaluateConservation(simNodes, simEdges, opts);
    }
    return { simNodes, simEdges, convergence: { loop_mode: opts.loop_mode, num_method: opts.num_method, converged, iterations: Math.min(iter, opts.maxIter), maxIter: opts.maxIter, residualT: resT, residualP: resP, residualH: resH, convergedP2: comp.params.P2_bar, conservation, history } };
  }

  async function solveAsync(nodes, edges, fluid, refProp, rawOpts = {}, onProgress = null) {
    const opts = normalizeOpts(rawOpts);
    const { simNodes, simEdges, comp, feedbackEdge } = prepareState(nodes, edges, opts);
    const history = [];
    const pMaxLimit = (refProp.sat && refProp.sat.P) ? refProp.sat.P[refProp.sat.P.length - 1] * 0.98 : 45.0;

    if (opts.loop_mode === "open" || !comp || !feedbackEdge) {
      runSinglePass(simNodes, simEdges, fluid, refProp, opts, null, null, null);
      const recMap = computeReceiverAssignment(simNodes, simEdges, opts);
      if (recMap) runSinglePass(simNodes, simEdges, fluid, refProp, opts, null, recMap, snapshotSensors(simNodes));
      const conservation = evaluateConservation(simNodes, simEdges, opts);
      return { simNodes, simEdges, convergence: { loop_mode: "open", num_method: opts.num_method, converged: true, iterations: 1, maxIter: opts.maxIter, residualT: 0, residualP: 0, residualH: 0, conservation, history } };
    }

    const state = { h1Cur: null, lastP2: null, lastEh: null, recMap: null, sensorMap: null, pMaxLimit };
    let iter = 0, resT = 999, resP = 999, resH = 999, converged = false, conservation = null;

    for (iter = 1; iter <= opts.maxIter; iter++) {
      const prevT = comp.params.T1_C, prevP = comp.params.P1_bar;
      runSinglePass(simNodes, simEdges, fluid, refProp, opts, state.h1Cur, state.recMap, state.sensorMap);
      if (!feedbackEdge.stream) break;

      state.sensorMap = snapshotSensors(simNodes);
      state.recMap = computeReceiverAssignment(simNodes, simEdges, opts);
      conservation = evaluateConservation(simNodes, simEdges, opts);

      resT = Math.abs(feedbackEdge.stream.T_C - prevT);
      resP = Math.abs(feedbackEdge.stream.P_bar - prevP);
      resH = Math.abs(feedbackEdge.stream.h_kJkg - comp.result.inlet.h_kJkg);
      history.push({ iter, T1: prevT, P1: prevP, P2: comp.params.P2_bar, resT, resP, resH, resM: Math.abs(conservation.mass.residual_g) });

      if (onProgress) onProgress({ iter, maxIter: opts.maxIter, resT, resP, resH, P2: comp.params.P2_bar });
      const isDone = opts.gov_energy ? (resT <= opts.tolT && resP <= opts.tolP && resH <= opts.tolH) : (resT <= opts.tolT && resP <= opts.tolP);
      if (isDone) { converged = true; break; }
      stepUpdate(opts.num_method, opts.gov_energy, comp, feedbackEdge, history, state, opts.alpha);
      if (opts.delayMs > 0) await new Promise(r => setTimeout(r, opts.delayMs));
    }

    if (state.recMap) {
      runSinglePass(simNodes, simEdges, fluid, refProp, opts, state.h1Cur, state.recMap, state.sensorMap);
      conservation = evaluateConservation(simNodes, simEdges, opts);
    }
    return { simNodes, simEdges, convergence: { loop_mode: opts.loop_mode, num_method: opts.num_method, converged, iterations: Math.min(iter, opts.maxIter), maxIter: opts.maxIter, residualT: resT, residualP: resP, residualH: resH, convergedP2: comp.params.P2_bar, conservation, history } };
  }

  function optimizeAlpha(nodes, edges, fluid, refProp, baseOpts = {}) {
    const candidates = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85];
    let best = null;
    for (const a of candidates) {
      const res = solve(nodes, edges, fluid, refProp, { ...baseOpts, alpha: a, loop_mode: "closed" });
      const c = res.convergence;
      const score = c.residualT + c.residualH * 0.1;
      if (!best || (c.converged && !best.converged) || (c.converged === best.converged && c.iterations < best.iter) || (c.converged === best.converged && c.iterations === best.iter && score < best.score)) {
        best = { alpha: a, converged: c.converged, iter: c.iterations, resT: c.residualT, resH: c.residualH, score };
      }
    }
    return { best };
  }

  global.SolverModule = { solve, solveAsync, optimizeAlpha, validateCircuit, evalSignalNode, findConnectedSignal, findConnectedFan, isHxType, isSensorType, isSignalType, isFlowNode, GOVERNING_DOCS, NUMERICAL_DOCS };
})(window);
