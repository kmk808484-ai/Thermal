// fan.js — 팬/블로워 성능곡선(P-Q Curve CSV) + 상사법칙(RPM & 공기밀도 ρ 보정) + HX 실제 ΔP_sec(Q) 직접 교차 운전점 해석 모듈
(function (global) {
  const DEFAULT_FAN_CSV =
    "Q_m3min,dP_Pa,eff\n" +
    "0.0,420,0.15\n" +
    "15.0,395,0.48\n" +
    "30.0,350,0.66\n" +
    "45.0,285,0.74\n" +
    "60.0,200,0.71\n" +
    "75.0,105,0.55\n" +
    "90.0,0,0.20";

  const RHO_REF_AIR = 1.20; // 표준 공기 기준 밀도 [kg/m³] (20°C, 101.325 kPa)

  function parseFanCurveCSV(csvText) {
    const lines = (csvText || "").replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const pts = [];
    for (const line of lines) {
      const cols = line.split(/[,\t;]+/).map(s => Number(s.replace(/%/g, "").trim()));
      if (cols.length >= 2 && !Number.isNaN(cols[0]) && !Number.isNaN(cols[1])) {
        const q = Math.max(0, cols[0]);
        const dp = Math.max(0, cols[1]);
        const eff = cols.length >= 3 && !Number.isNaN(cols[2])
          ? Math.min(0.95, Math.max(0.05, cols[2] > 1.5 ? cols[2] / 100 : cols[2]))
          : 0.65;
        pts.push({ q_m3min: q, dp_Pa: dp, eff });
      }
    }
    if (pts.length < 3) {
      throw new Error("팬 성능곡선 CSV는 최소 3행 이상의 (유량 Q[m³/min], 정압 ΔP[Pa], 효율 η) 데이터가 필요합니다.");
    }
    pts.sort((a, b) => a.q_m3min - b.q_m3min);
    if (pts[pts.length - 1].q_m3min <= pts[0].q_m3min) {
      throw new Error("팬 성능곡선 유량(Q) 축 범위가 유효하지 않습니다.");
    }
    return pts;
  }

  function evalCurveAtQ(pts, rpmRatio, q_m3min, rhoRatio = 1.0) {
    const r = Math.max(0.1, rpmRatio);
    const rr = Math.max(0.3, rhoRatio);
    // 상사법칙: Q = Q_ref * r,  dP = dP_ref * r^2 * (ρ / ρ_ref)
    const q_ref = q_m3min / r;
    const n = pts.length;
    if (q_ref <= pts[0].q_m3min) {
      return { dp_Pa: pts[0].dp_Pa * r * r * rr, eff: pts[0].eff };
    }
    if (q_ref >= pts[n - 1].q_m3min) {
      return { dp_Pa: Math.max(0, pts[n - 1].dp_Pa * r * r * rr), eff: pts[n - 1].eff };
    }
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      if (q_ref >= p0.q_m3min && q_ref <= p1.q_m3min) {
        const t = (q_ref - p0.q_m3min) / Math.max(1e-9, p1.q_m3min - p0.q_m3min);
        const dp = (p0.dp_Pa + t * (p1.dp_Pa - p0.dp_Pa)) * r * r * rr;
        const eff = p0.eff + t * (p1.eff - p0.eff);
        return { dp_Pa: Math.max(0, dp), eff };
      }
    }
    return { dp_Pa: 0, eff: 0.5 };
  }

  // 팬 P-Q 곡선과 열교환기 실제 공기측 ΔP_sec(Q) 곡선(또는 K_sys * Q^1.75)의 교차 운전점 탐색
  function run(params, hxResistanceOrFn = null, airRho = 1.15) {
    const pts = parseFanCurveCSV(params.curve_csv);
    const rpm = Math.max(100, params.rpm || 1800);
    const rpm_ref = Math.max(100, params.rpm_ref || 1800);
    const rpmRatio = rpm / rpm_ref;
    const rhoActual = Math.max(0.4, Number(airRho) || 1.15);
    const rhoRatio = rhoActual / RHO_REF_AIR;
    const qMax = pts[pts.length - 1].q_m3min * rpmRatio;

    const isDirectFn = typeof hxResistanceOrFn === "function";
    const K_fallback = (!isDirectFn && hxResistanceOrFn !== null && Number.isFinite(hxResistanceOrFn) && hxResistanceOrFn > 0)
      ? hxResistanceOrFn
      : (params.K_sys_default || 0.08);

    const evalSysDp = (q) => {
      if (q <= 1e-6) return 0;
      if (isDirectFn) {
        const v = hxResistanceOrFn(q);
        return Math.max(0, typeof v === "number" ? v : (v.dP_total_Pa || 0));
      }
      return K_fallback * Math.pow(q, 1.75);
    };

    // 이분법(34회)으로 dP_fan(Q) == dP_sys(Q) 교차점 계산
    let lo = 0.005 * qMax, hi = qMax * 1.02;
    for (let iter = 0; iter < 34; iter++) {
      const mid = 0.5 * (lo + hi);
      const fanDp = evalCurveAtQ(pts, rpmRatio, mid, rhoRatio).dp_Pa;
      const sysDp = evalSysDp(mid);
      if (fanDp >= sysDp) lo = mid;
      else hi = mid;
    }

    const Q_op_m3min = 0.5 * (lo + hi);
    const Q_op_m3s = Q_op_m3min / 60;
    const m_air_kgs = Math.max(0.02, Q_op_m3s * rhoActual);
    const op = evalCurveAtQ(pts, rpmRatio, Q_op_m3min, rhoRatio);
    const dP_op_Pa = op.dp_Pa;
    const dP_sys_detail = isDirectFn ? hxResistanceOrFn(Q_op_m3min) : null;
    const dP_core_Pa = (dP_sys_detail && typeof dP_sys_detail === "object") ? dP_sys_detail.dP_core_Pa : dP_op_Pa;
    const eff_op = Math.max(0.1, op.eff);
    const W_fan_kW = (Q_op_m3s * dP_op_Pa) / (eff_op * 1000);
    const K_sys_equiv = dP_op_Pa / Math.max(1e-6, Math.pow(Q_op_m3min, 1.75));

    // 그래프 시각화용 곡선 샘플링 (실제 HX ΔP_sec 곡선 그대로 표시)
    const curveSamples = [];
    for (let i = 0; i <= 20; i++) {
      const q = (qMax * i) / 20;
      const f = evalCurveAtQ(pts, rpmRatio, q, rhoRatio);
      const fRef = evalCurveAtQ(pts, 1.0, (pts[pts.length - 1].q_m3min * i) / 20, 1.0);
      curveSamples.push({
        q_m3min: q,
        dp_fan_Pa: f.dp_Pa,
        dp_sys_Pa: evalSysDp(q),
        eff: f.eff,
        q_ref_m3min: (pts[pts.length - 1].q_m3min * i) / 20,
        dp_ref_Pa: fRef.dp_Pa
      });
    }

    return {
      metrics: {
        rpm, rpm_ref, rpmRatio,
        airRho: rhoActual, rhoRatio,
        Q_op_m3min, Q_op_m3s, m_air_kgs,
        dP_op_Pa, dP_core_Pa, eff_op, W_fan_kW,
        K_sys: K_sys_equiv,
        directHxCoupled: isDirectFn,
        qMax_m3min: qMax,
        dpMax_Pa: pts[0].dp_Pa * rpmRatio * rpmRatio * rhoRatio,
        curveSamples
      }
    };
  }

  global.FanModule = { DEFAULT_FAN_CSV, RHO_REF_AIR, parseFanCurveCSV, evalCurveAtQ, run };
})(window);
