// solver.js — 1D 열유체 네트워크 수렴 솔버 (에너지 평형 P2 자동 조절 포함)
(function (global) {
  const SOLVER_DOCS = {
    energy_balance: {
      name: "폐회로 — 에너지 평형 솔버 (P2 자동 조절)",
      formula: "P2_{k+1} = P2_k - α · e_h / (∂e_h / ∂P2),  e_h = h_1' - h_1",
      pros: "토출압력(P2)을 자동으로 찾아 ΔT, ΔP뿐만 아니라 엔탈피 잔차(Δh)까지 0으로 완전히 닫힌 P-h 사이클을 계산합니다.",
      cons: "외기온도·UA·RPM 조합에 따라 물리적 평형점이 극단적일 경우 반복 횟수가 다소 늘어날 수 있습니다.",
      tip: "실제 냉동시스템처럼 외기온도나 풍량 변화에 따른 응축압(P2) 자동 상승·하강을 모사할 때 사용하세요."
    },
    fixed_point: {
      name: "폐회로 — 고정점 반복법 (P2 고정, Under-Relaxation)",
      formula: "x_{k+1} = x_k + α · (x_feedback - x_k)",
      pros: "압축기 토출압(P2)을 고정한 상태에서 매우 안정적으로 흡입 상태(T1, P1)를 수렴시킵니다.",
      cons: "P2가 고정이므로 열교환기 방열량과 압축기 동력 사이에 엔탈피 불균형(Δh)이 남을 수 있습니다.",
      tip: "특정 설계 응축압(P2)을 고정하고 단품 성능을 비교할 때 적합합니다."
    },
    aitken: {
      name: "폐회로 — Aitken Δ² 가속법 (P2 고정)",
      formula: "x_next = x_0 - (x_1 - x_0)² / (x_2 - 2x_1 + x_0)",
      pros: "연속 2회 계산의 기울기로 해를 외삽해 고정점 반복법보다 빠르게 수렴합니다.",
      cons: "2상 경계에서 기울기가 급변하면 진동할 수 있습니다.",
      tip: "P2 고정 조건에서 빠른 수렴이 필요할 때 사용하세요."
    },
    open_loop: {
      name: "개회로 — 단순 순차 계산 (1회 패스)",
      formula: "Comp → HX(Cond) → Valve → HX(Evap) (피드백 무시)",
      pros: "반복 없이 1회만 실행되어 즉각 결과가 나옵니다.",
      cons: "증발기 출구(1')와 압축기 입구(1)가 일치하지 않습니다.",
      tip: "초기 회로 구성 중이거나 입구 조건을 강제 고정할 때 사용하세요."
    }
  };

  function runSinglePass(simNodes, simEdges, fluid, refProp, h1Feedback = null) {
    const CM = global.CompressorModule;
    const HX = global.HXModule;
    const VM = global.ValveModule;

    simNodes.forEach(n => (n.result = null));
    simEdges.forEach(e => (e.stream = null));

    const queue = [];
    simNodes.filter(n => n.type === "compressor").forEach(comp => {
      const maps = {
        is: new CM.EfficiencyMap2D(comp.params.csv_is),
        vol: new CM.EfficiencyMap2D(comp.params.csv_vol),
        mech: new CM.EfficiencyMap2D(comp.params.csv_mech)
      };
      const res = CM.run({ fluid, ...comp.params }, maps, refProp);

      if (h1Feedback !== null && Number.isFinite(h1Feedback)) {
        const dh = res.metrics.dh;
        res.inlet.h_kJkg = h1Feedback;
        res.outlet.h_kJkg = h1Feedback + dh;
      }

      comp.result = { ...res, outStream: res.outlet };
      queue.push(comp);
    });

    const visited = new Set(queue.map(n => n.id));
    let guard = 0;
    while (queue.length > 0 && guard++ < 60) {
      const cur = queue.shift();
      simEdges.filter(e => e.from === cur.id).forEach(edge => {
        edge.stream = cur.result.outStream;
        const target = simNodes.find(n => n.id === edge.to);
        if (!target || visited.has(target.id)) return;

        if (target.type === "hx") {
          const res = HX.run(edge.stream, target.params, refProp);
          target.result = { ...res, outStream: res.outlet };
        } else if (target.type === "valve") {
          const res = VM.run(edge.stream, target.params, refProp);
          target.result = { ...res, outStream: res.outlet };
        }
        if (target.result) {
          visited.add(target.id);
          queue.push(target);
        }
      });
    }
  }

  function prepareState(nodes, edges, opts) {
    const simNodes = nodes.map(n => ({ ...n, params: { ...n.params }, result: null }));
    const simEdges = edges.map(e => ({ ...e, stream: null }));
    if (opts.override) {
      const comp = simNodes.find(n => n.type === "compressor");
      if (opts.override.rpm !== undefined && comp) comp.params.rpm = opts.override.rpm;
      if (opts.override.p2 !== undefined && comp) comp.params.P2_bar = opts.override.p2;
    }
    const comp = simNodes.find(n => n.type === "compressor");
    const feedbackEdge = comp ? simEdges.find(e => e.to === comp.id) : null;
    return { simNodes, simEdges, comp, feedbackEdge };
  }

  function stepUpdate(method, comp, feedbackEdge, history, state, alpha) {
    const prevT = comp.params.T1_C;
    const prevP = comp.params.P1_bar;
    const prevP2 = comp.params.P2_bar;

    const T_fb = feedbackEdge.stream.T_C;
    const P_fb = feedbackEdge.stream.P_bar;
    const h_fb = feedbackEdge.stream.h_kJkg;
    const h_in = comp.result.inlet.h_kJkg;

    const e_h = h_fb - h_in;

    if (method === "aitken" && history.length >= 3) {
      const h0 = history[history.length - 3], h1 = history[history.length - 2];
      const dT = T_fb - 2 * h1.T1 + h0.T1;
      const dP = P_fb - 2 * h1.P1 + h0.P1;
      const nextT = Math.abs(dT) > 1e-4 ? h0.T1 - Math.pow(h1.T1 - h0.T1, 2) / dT : prevT + alpha * (T_fb - prevT);
      const nextP = Math.abs(dP) > 1e-4 ? h0.P1 - Math.pow(h1.P1 - h0.P1, 2) / dP : prevP + alpha * (P_fb - prevP);
      comp.params.T1_C = Math.max(-50, Math.min(120, nextT));
      comp.params.P1_bar = Math.max(0.5, Math.min(35, nextP));
    } else {
      comp.params.T1_C = prevT + alpha * (T_fb - prevT);
      comp.params.P1_bar = Math.max(0.5, prevP + alpha * (P_fb - prevP));
    }

    if (method === "energy_balance") {
      let dP2 = 0;
      if (state.lastP2 !== null && Math.abs(prevP2 - state.lastP2) > 1e-4) {
        const slope = (e_h - state.lastEh) / (prevP2 - state.lastP2);
        if (Math.abs(slope) > 1e-3) {
          dP2 = -e_h / slope;
        } else {
          dP2 = Math.sign(e_h) * 0.4;
        }
      } else {
        dP2 = Math.max(-1.5, Math.min(1.5, e_h * 0.04));
      }

      dP2 = Math.max(-2.5, Math.min(2.5, dP2)) * Math.max(0.25, alpha);
      state.lastP2 = prevP2;
      state.lastEh = e_h;

      const minP2 = comp.params.P1_bar * 1.15;
      comp.params.P2_bar = Math.max(minP2, Math.min(45.0, prevP2 + dP2));
    }

    state.h1Cur = h_in + alpha * (h_fb - h_in);
  }

  function solve(nodes, edges, fluid, refProp, opts = {}) {
    const method = opts.method || "energy_balance";
    const maxIter = opts.maxIter || 50;
    const tolT = opts.tolT || 0.05;
    const tolP = opts.tolP || 0.02;
    const tolH = opts.tolH || 0.3;
    const alpha = opts.alpha || 0.5;

    const { simNodes, simEdges, comp, feedbackEdge } = prepareState(nodes, edges, opts);
    const history = [];

    if (method === "open_loop" || !comp || !feedbackEdge) {
      runSinglePass(simNodes, simEdges, fluid, refProp, null);
      return {
        simNodes, simEdges,
        convergence: { method: !feedbackEdge ? "open_loop" : method, converged: true, iterations: 1, maxIter, residualT: 0, residualP: 0, residualH: 0, history }
      };
    }

    const state = { h1Cur: null, lastP2: null, lastEh: null };
    let iter = 0, resT = 999, resP = 999, resH = 999, converged = false;

    for (iter = 1; iter <= maxIter; iter++) {
      const prevT = comp.params.T1_C, prevP = comp.params.P1_bar;
      runSinglePass(simNodes, simEdges, fluid, refProp, state.h1Cur);
      if (!feedbackEdge.stream) break;

      resT = Math.abs(feedbackEdge.stream.T_C - prevT);
      resP = Math.abs(feedbackEdge.stream.P_bar - prevP);
      resH = Math.abs(feedbackEdge.stream.h_kJkg - comp.result.inlet.h_kJkg);
      history.push({ iter, T1: prevT, P1: prevP, P2: comp.params.P2_bar, resT, resP, resH });

      const isDone = method === "energy_balance"
        ? (resT <= tolT && resP <= tolP && resH <= tolH)
        : (resT <= tolT && resP <= tolP);

      if (isDone) { converged = true; break; }
      stepUpdate(method, comp, feedbackEdge, history, state, alpha);
    }

    return {
      simNodes, simEdges,
      convergence: { method, converged, iterations: Math.min(iter, maxIter), maxIter, residualT: resT, residualP: resP, residualH: resH, convergedP2: comp.params.P2_bar, history }
    };
  }

  async function solveAsync(nodes, edges, fluid, refProp, opts = {}, onProgress = null) {
    const method = opts.method || "energy_balance";
    const maxIter = opts.maxIter || 50;
    const tolT = opts.tolT || 0.05;
    const tolP = opts.tolP || 0.02;
    const tolH = opts.tolH || 0.3;
    const alpha = opts.alpha || 0.5;
    const delayMs = opts.delayMs ?? 15;

    const { simNodes, simEdges, comp, feedbackEdge } = prepareState(nodes, edges, opts);
    const history = [];

    if (method === "open_loop" || !comp || !feedbackEdge) {
      runSinglePass(simNodes, simEdges, fluid, refProp, null);
      return {
        simNodes, simEdges,
        convergence: { method: !feedbackEdge ? "open_loop" : method, converged: true, iterations: 1, maxIter, residualT: 0, residualP: 0, residualH: 0, history }
      };
    }

    const state = { h1Cur: null, lastP2: null, lastEh: null };
    let iter = 0, resT = 999, resP = 999, resH = 999, converged = false;

    for (iter = 1; iter <= maxIter; iter++) {
      const prevT = comp.params.T1_C, prevP = comp.params.P1_bar;
      runSinglePass(simNodes, simEdges, fluid, refProp, state.h1Cur);
      if (!feedbackEdge.stream) break;

      resT = Math.abs(feedbackEdge.stream.T_C - prevT);
      resP = Math.abs(feedbackEdge.stream.P_bar - prevP);
      resH = Math.abs(feedbackEdge.stream.h_kJkg - comp.result.inlet.h_kJkg);
      history.push({ iter, T1: prevT, P1: prevP, P2: comp.params.P2_bar, resT, resP, resH });

      if (onProgress) onProgress({ iter, maxIter, resT, resP, resH, P2: comp.params.P2_bar });

      const isDone = method === "energy_balance"
        ? (resT <= tolT && resP <= tolP && resH <= tolH)
        : (resT <= tolT && resP <= tolP);

      if (isDone) { converged = true; break; }
      stepUpdate(method, comp, feedbackEdge, history, state, alpha);

      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }

    return {
      simNodes, simEdges,
      convergence: { method, converged, iterations: Math.min(iter, maxIter), maxIter, residualT: resT, residualP: resP, residualH: resH, convergedP2: comp.params.P2_bar, history }
    };
  }

  function optimizeAlpha(nodes, edges, fluid, refProp, baseOpts = {}) {
    const candidates = [0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
    let best = null;
    for (const a of candidates) {
      const res = solve(nodes, edges, fluid, refProp, {
        ...baseOpts,
        alpha: a,
        method: baseOpts.method === "open_loop" ? "energy_balance" : baseOpts.method
      });
      const c = res.convergence;
      const score = c.residualT + c.residualH * 0.1;
      if (!best ||
          (c.converged && !best.converged) ||
          (c.converged === best.converged && c.iterations < best.iter) ||
          (c.converged === best.converged && c.iterations === best.iter && score < best.score)) {
        best = { alpha: a, converged: c.converged, iter: c.iterations, resT: c.residualT, resH: c.residualH, score };
      }
    }
    return { best };
  }

  global.SolverModule = { solve, solveAsync, optimizeAlpha, SOLVER_DOCS };
})(window);