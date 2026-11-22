// component_views.js — 상세 컴포넌트 설계 탭 (무지연 오리피스/가변Cd/초크 · 핀-플레이트/PHX 지오메트리 도해 애니메이션 · 팬 P-Q 곡선 · 상관식 ?)
(function (global) {
  function tempToCFDColor(T_C) {
    if (T_C === null || T_C === undefined || Number.isNaN(T_C)) return "#64748b";
    const t = Math.max(0, Math.min(1, (T_C - (-20)) / (85 - (-20))));
    const stops = [
      [0.00, [29, 78, 216]],
      [0.25, [6, 182, 212]],
      [0.50, [34, 197, 94]],
      [0.75, [245, 158, 11]],
      [1.00, [220, 38, 38]]
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * f)},${Math.round(c0[1] + (c1[1] - c0[1]) * f)},${Math.round(c0[2] + (c1[2] - c0[2]) * f)})`;
      }
    }
    return "rgb(220,38,38)";
  }

  function helpBtnHTML(corrKey) {
    return `<button type="button" class="help-q-btn" data-corr="${corrKey}" title="상관식 메커니즘 및 구현 상세 설명">?</button>`;
  }

  // ================= 1. 팽창밸브 내부 컷어웨이 SVG (지름 D · 가변 Cd · 초크플로우 · 개도율 무지연 반응) =================
  function buildValveCutawaySVG(n) {
    const p = n.params, res = n.result;
    const D_mm = Math.max(0.4, Number(p.orifice_D_mm) || 2.8);
    const A_max = (Math.PI * D_mm * D_mm) / 4;
    const openPct = p.valve_mode === "orifice"
      ? Math.min(100, Math.max(5, Number(p.opening_pct) || 50))
      : (res ? res.metrics.opening_pct : (Number(p.open_base_pct) || 50));
    const A_eff = A_max * (openPct / 100);

    // 지름 변경 시 솔버 실행 전에도 즉시 가변 Cd_eff 계산
    const VM = global.ValveModule;
    const Cd_eff = VM && VM.calcEffectiveCd
      ? VM.calcEffectiveCd(p, D_mm, res ? res.inlet.rho : 1120, res ? res.inlet.mu : 150, res ? res.inlet.m_dot : 0.08, Math.max(1e-7, A_eff * 1e-6), res ? res.inlet.SC : 4.0)
      : (p.Cd || 0.65);
    const isChoked = res ? !!res.metrics.is_choked : false;
    const P_choke = res && res.metrics.P_choke_bar ? res.metrics.P_choke_bar : 4.2;

    const colIn = res ? tempToCFDColor(res.inlet.T_C) : "#22c55e";
    const colOut = res ? tempToCFDColor(res.outlet.T_C) : "#06b6d4";
    const qual = res ? res.metrics.quality : 0.25;
    const dP = res ? res.metrics.dP_bar : 8.5;
    const isTxv = p.valve_mode === "txv_sh";
    const sensorOk = res && res.metrics.sensor_connected;

    // D_mm (0.4 ~ 8.0 mm) -> seatGap (8px ~ 64px) 연속 비례
    const seatGap = Math.max(8, Math.min(64, 8 + ((D_mm - 0.4) / 7.6) * 56));
    const seatLeftW = Math.max(8, 44 - seatGap / 2);
    const needleLift = (openPct / 100) * 26;
    const needleY = 236 - needleLift;
    const flowDur = Math.max(0.38, 2.0 - (openPct / 100) * 1.35).toFixed(2);
    const springScale = Math.max(0.62, 1.0 - (openPct / 100) * 0.30);

    let springD = "M 185 88";
    const coils = 7, sTop = 88, sBot = 88 + 90 * springScale;
    for (let i = 0; i < coils; i++) {
      const y1 = sTop + ((i + 0.25) / coils) * (sBot - sTop);
      const y2 = sTop + ((i + 0.75) / coils) * (sBot - sTop);
      springD += ` L 214 ${y1.toFixed(1)} L 156 ${y2.toFixed(1)}`;
    }
    springD += ` L 185 ${sBot.toFixed(1)}`;

    const bubbleCount = Math.max(3, Math.min(12, Math.round(qual * 12)));
    let bubbles = "";
    for (let i = 0; i < bubbleCount; i++) {
      const delay = ((i / bubbleCount) * parseFloat(flowDur)).toFixed(2);
      const r = (2.2 + (i % 3) * 1.1).toFixed(1);
      const cy = 197 + ((i % 3) - 1) * 5;
      bubbles += `<circle cx="245" cy="${cy}" r="${r}" fill="#ffffff" stroke="${colOut}" stroke-width="1.4" opacity="0.92">
        <animate attributeName="cx" from="210" to="458" dur="${flowDur}s" begin="${delay}s" repeatCount="indefinite"/>
      </circle>`;
    }

    const txvBulbSvg = isTxv ? `
      <path d="M 185 44 L 185 22 L 305 22" fill="none" stroke="#475569" stroke-width="2.2"/>
      <rect x="305" y="10" width="142" height="24" rx="12" fill="${sensorOk ? '#dbeafe' : '#fef2f2'}" stroke="${sensorOk ? '#0284c7' : '#ef4444'}" stroke-width="2"/>
      <text x="376" y="26" text-anchor="middle" font-size="10.5" font-weight="700" fill="${sensorOk ? '#0369a1' : '#dc2626'}">${sensorOk && res.metrics.SH_meas !== null ? `감온통 SH: ${res.metrics.SH_meas.toFixed(1)}K` : '감온통 센서 미연결'}</text>` : "";

    const chokeBadge = p.flow_corr === "hem_choked" ? `
      <rect x="276" y="18" width="198" height="24" rx="6" fill="${isChoked ? '#fef2f2' : '#f0fdf4'}" stroke="${isChoked ? '#dc2626' : '#16a34a'}" stroke-width="1.6"/>
      <text x="375" y="34" text-anchor="middle" font-size="10.5" font-weight="800" fill="${isChoked ? '#dc2626' : '#15803d'}">${isChoked ? `⚠️ 초크 플로우 발생 (P_out ≤ ${P_choke.toFixed(1)}b)` : `아음속 유동 (P_choke=${P_choke.toFixed(1)}b)`}</text>` : "";

    return `<svg viewBox="0 0 490 345" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <defs>
        <linearGradient id="vBodyGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#d97706"/><stop offset="50%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/>
        </linearGradient>
        <linearGradient id="vFluidGrad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stop-color="${colIn}"/><stop offset="100%" stop-color="${colOut}"/>
        </linearGradient>
      </defs>
      ${ isTxv ? txvBulbSvg : chokeBadge }
      <path d="M 112 72 Q 185 32 258 72 L 258 84 L 112 84 Z" fill="#e2e8f0" stroke="#475569" stroke-width="2.4"/>
      <path d="M 124 72 Q 185 ${56 - needleLift * 0.35} 246 72" fill="${colOut}" fill-opacity="0.38" stroke="#ef4444" stroke-width="2.2"/>
      <text x="185" y="53" text-anchor="middle" font-size="10.5" font-weight="700" fill="#334155">${isTxv ? "TXV 다이어프램" : "EEV 구동부"}</text>

      <path d="M 128 84 L 242 84 L 242 180 L 462 180 L 462 220 L 242 220 L 242 280 L 210 280 L 210 335 L 160 335 L 160 280 L 128 280 Z"
            fill="url(#vBodyGrad)" stroke="#78350f" stroke-width="2.4" stroke-linejoin="round"/>
      <rect x="141" y="90" width="88" height="90" rx="4" fill="#e0f2fe" stroke="#64748b" stroke-width="1.5"/>

      <rect x="171" y="234" width="28" height="101" fill="${colIn}" fill-opacity="0.82"/>
      <rect x="141" y="234" width="88" height="38" fill="${colIn}" fill-opacity="0.72"/>
      <rect x="141" y="186" width="321" height="28" fill="${colOut}" fill-opacity="0.65"/>

      <!-- 오리피스 시트 (D_mm 변경 시 구멍 크기 seatGap 연속 변화!) -->
      <rect x="141" y="214" width="${seatLeftW.toFixed(1)}" height="20" fill="#16a34a" stroke="#14532d" stroke-width="1.8"/>
      <rect x="${(229 - seatLeftW).toFixed(1)}" y="214" width="${seatLeftW.toFixed(1)}" height="20" fill="#16a34a" stroke="#14532d" stroke-width="1.8"/>
      <rect x="${(185 - seatGap / 2).toFixed(1)}" y="214" width="${seatGap.toFixed(1)}" height="20" fill="url(#vFluidGrad)" opacity="0.92"/>
      ${isChoked ? `<line x1="${(185 - seatGap/2).toFixed(1)}" y1="214" x2="${(185 + seatGap/2).toFixed(1)}" y2="214" stroke="#dc2626" stroke-width="3" stroke-dasharray="3 2"/>` : ""}

      <!-- 오리피스 지름 치수선 -->
      <line x1="${(185 - seatGap / 2).toFixed(1)}" y1="248" x2="${(185 + seatGap / 2).toFixed(1)}" y2="248" stroke="#dc2626" stroke-width="2.2"/>
      <text x="185" y="263" text-anchor="middle" font-size="11" font-weight="800" fill="#dc2626">Ø D = ${D_mm.toFixed(2)} mm</text>

      <!-- 스프링 & 테이퍼 니들 -->
      <path d="${springD}" fill="none" stroke="#d97706" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="185" y1="76" x2="185" y2="${needleY.toFixed(1)}" stroke="#334155" stroke-width="4.5" stroke-linecap="round"/>
      <polygon points="${(185 - seatGap * 0.46).toFixed(1)},${(needleY - 12).toFixed(1)} ${(185 + seatGap * 0.46).toFixed(1)},${(needleY - 12).toFixed(1)} 185,${(needleY + 20).toFixed(1)}"
               fill="#94a3b8" stroke="#1e293b" stroke-width="2"/>

      <line x1="185" y1="330" x2="185" y2="242" stroke="#ffffff" stroke-width="2.5" stroke-dasharray="6 8" opacity="0.88">
        <animate attributeName="stroke-dashoffset" from="0" to="14" dur="${flowDur}s" repeatCount="indefinite"/>
      </line>
      ${bubbles}

      <g font-size="11" font-family="Malgun Gothic, sans-serif">
        <rect x="274" y="68" width="204" height="100" rx="7" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
        <text x="285" y="87" font-weight="700" fill="#0f172a">개도율: <tspan fill="#7c3aed">${openPct.toFixed(1)}%</tspan> | 지름: <tspan fill="#dc2626">${D_mm.toFixed(2)}mm</tspan></text>
        <text x="285" y="105" fill="#334155">유효/최대 면적: <tspan font-weight="700">${A_eff.toFixed(2)} / ${A_max.toFixed(2)} mm²</tspan></text>
        <text x="285" y="123" fill="#334155">유효 유량계수 Cd: <tspan font-weight="700" fill="#0284c7">${Cd_eff.toFixed(3)}</tspan> (${p.flow_corr==='const_cd'?'고정':'D·Re 연동'})</text>
        <text x="285" y="141" fill="#334155">ΔP: <tspan font-weight="700" fill="#ea580c">${dP.toFixed(2)} bar</tspan> | 건도: <tspan font-weight="700" fill="#0284c7">${(qual*100).toFixed(1)}%</tspan></text>
        <text x="285" y="158" font-size="10" fill="${isChoked ? '#dc2626' : '#16a34a'}" font-weight="700">${isChoked ? `⚠️ CHOKED (P_choke=${P_choke.toFixed(2)} bar)` : `P_choke=${P_choke.toFixed(2)} bar (비초크)`}</text>

        <text x="115" y="318" text-anchor="end" font-weight="700" fill="#0f172a">입구</text>
        <text x="115" y="333" text-anchor="end" fill="#475569">${res ? `${res.inlet.P_bar.toFixed(1)}b / ${res.inlet.T_C.toFixed(1)}°C` : "-"}</text>
        <text x="458" y="238" text-anchor="end" font-weight="700" fill="#0f172a">출구</text>
        <text x="458" y="253" text-anchor="end" fill="#475569">${res ? `${res.outlet.P_bar.toFixed(1)}b / ${res.outlet.T_C.toFixed(1)}°C` : "-"}</text>
      </g>
    </svg>`;
  }

  // ================= 2. 압축기 내부 컷어웨이 SVG =================
  function buildCompressorCutawaySVG(n, simCfg) {
    const res = n.result;
    const rpm = res ? (n.params.rpm || simCfg.comp_rpm) : ((n.params.link_global !== false && simCfg) ? simCfg.comp_rpm : (n.params.rpm || 3000));
    const dur = Math.max(0.28, 4500 / Math.max(400, rpm)).toFixed(2);
    const colIn = res ? tempToCFDColor(res.inlet.T_C) : "#06b6d4";
    const colOut = res ? tempToCFDColor(res.outlet.T_C) : "#dc2626";

    return `<svg viewBox="0 0 490 320" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <defs><linearGradient id="cChamberGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${colIn}" stop-opacity="0.78"/><stop offset="100%" stop-color="${colOut}" stop-opacity="0.88"/></linearGradient></defs>
      <rect x="20" y="138" width="95" height="44" fill="${colIn}" fill-opacity="0.82" stroke="#334155" stroke-width="2"/>
      <rect x="375" y="138" width="95" height="44" fill="${colOut}" fill-opacity="0.86" stroke="#334155" stroke-width="2"/>
      <rect x="110" y="54" width="270" height="212" rx="46" fill="#e2e8f0" stroke="#334155" stroke-width="3"/>
      <circle cx="245" cy="160" r="82" fill="url(#cChamberGrad)" stroke="#475569" stroke-width="2.5"/>
      <g style="transform-origin:245px 160px; animation: spin ${dur}s linear infinite;">
        <circle cx="245" cy="160" r="56" fill="none" stroke="#1e293b" stroke-width="4" stroke-dasharray="28 12"/>
        <circle cx="245" cy="160" r="32" fill="#f8fafc" stroke="#1e293b" stroke-width="3"/>
        <line x1="245" y1="104" x2="245" y2="216" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>
        <line x1="189" y1="160" x2="301" y2="160" stroke="#1e293b" stroke-width="4" stroke-linecap="round"/>
        <circle cx="245" cy="160" r="10" fill="#ea580c"/>
      </g>
      <line x1="26" y1="160" x2="112" y2="160" stroke="#ffffff" stroke-width="3" stroke-dasharray="7 7"><animate attributeName="stroke-dashoffset" from="14" to="0" dur="${dur}s" repeatCount="indefinite"/></line>
      <line x1="378" y1="160" x2="464" y2="160" stroke="#ffffff" stroke-width="3" stroke-dasharray="7 7"><animate attributeName="stroke-dashoffset" from="14" to="0" dur="${dur}s" repeatCount="indefinite"/></line>
      <g font-size="11.5" font-family="Malgun Gothic, sans-serif">
        <text x="65" y="128" text-anchor="middle" font-weight="700" fill="#0f172a">흡입</text>
        <text x="65" y="198" text-anchor="middle" fill="#334155">${res ? `${res.inlet.P_bar.toFixed(2)}b / ${res.inlet.T_C.toFixed(1)}°C` : "-"}</text>
        <text x="425" y="128" text-anchor="middle" font-weight="700" fill="#0f172a">토출</text>
        <text x="425" y="198" text-anchor="middle" fill="#334155">${res ? `${res.outlet.P_bar.toFixed(2)}b / ${res.outlet.T_C.toFixed(1)}°C` : "-"}</text>
        <text x="245" y="34" text-anchor="middle" font-weight="700" fill="#0f172a">회전수: ${Math.round(rpm)} RPM | 배기량: ${n.params.vd_cc} cc/rev | PR: ${res ? res.metrics.PR.toFixed(2) : "-"}</text>
        <text x="245" y="294" text-anchor="middle" fill="#475569">${res ? `질량유량: ${res.outlet.m_dot.toFixed(4)} kg/s | 축동력: ${res.metrics.W_shaft_kW.toFixed(2)} kW | η_is: ${(res.metrics.eff_is*100).toFixed(1)}%` : "시뮬레이션 실행 후 결과 표시"}</text>
      </g>
    </svg>`;
  }

  // ================= 3. 핀-플레이트 열교환기 지오메트리 도해(코어 W/H/D + 핀 피치 Fp/두께 ft/채널 Dh 확대도) & 6-세그먼트 온도장 애니메이션 =================
  function buildFinPlateCutawaySVG(n) {
    const p = n.params, res = n.result;
    const isLouver = (p.fin_type || "louver") === "louver";
    const W_mm = Math.max(150, Number(p.core_W_mm) || 520);
    const H_mm = Math.max(120, Number(p.core_H_mm) || 360);
    const D_mm = Math.max(10, Number(p.core_D_mm) || 26);
    const Fp_mm = Math.max(0.8, Number(p.fin_pitch_mm) || 2.0);
    const ft_mm = Math.max(0.05, Number(p.fin_thick_mm) || 0.12);
    const Dh_mm = Math.max(0.8, Number(p.ch_Dh_mm) || 2.5);
    const Lp_mm = Math.max(0.5, Number(p.louver_pitch_mm) || 1.2);
    const lAng = Math.min(45, Math.max(10, Number(p.louver_angle_deg) || 27));

    const segs = (res && res.metrics.segments && res.metrics.segments.length) ? res.metrics.segments : null;
    const colIn = res ? tempToCFDColor(res.inlet.T_C) : "#f97316";
    const colOut = res ? tempToCFDColor(res.outlet.T_C) : "#22c55e";
    const T_air_in = res ? res.metrics.T_sec_in : (Number(p.T_sec_in) || 35);
    const airDur = Math.max(0.42, 2.1 / Math.max(0.3, res ? res.metrics.m_sec_kgs : (p.m_sec_kgs || 1.0))).toFixed(2);

    // [좌측 뷰] 코어 폭 W(150~900mm -> 135~215px), 높이 H(120~650mm -> 95~168px), 깊이 D(10~65mm -> 6~22px) 실시간 스케일!
    const cW = Math.max(135, Math.min(215, 135 + ((W_mm - 200) / 700) * 80));
    const cH = Math.max(95, Math.min(168, 95 + ((H_mm - 150) / 500) * 73));
    const cD = Math.max(6, Math.min(22, 6 + ((D_mm - 10) / 55) * 16));
    const cx0 = 36 + (215 - cW) / 2, cy0 = 64 + (168 - cH) / 2;

    const N = 6, segW = cW / N;
    const nTubes = Math.max(3, Math.min(7, Math.round((p.n_channels || 32) / 6)));
    let defs = "", zonesSvg = "", airArrows = "";

    for (let i = 0; i < N; i++) {
      const sx = cx0 + i * segW;
      const tRef = segs ? 0.5 * (segs[i].T_ref_in + segs[i].T_ref_out) : (60 - i * 5);
      const tAirOut = segs ? segs[i].T_sec_out : (T_air_in + 6 - i * 0.6);
      const cRef = tempToCFDColor(tRef), cAirIn = tempToCFDColor(T_air_in), cAirOut = tempToCFDColor(tAirOut);
      defs += `<linearGradient id="fpAirG${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${cAirIn}"/><stop offset="100%" stop-color="${cAirOut}"/></linearGradient>`;
      zonesSvg += `<rect x="${sx.toFixed(1)}" y="${cy0.toFixed(1)}" width="${segW.toFixed(1)}" height="${cH.toFixed(1)}" fill="url(#fpAirG${i})" fill-opacity="0.26" stroke="#cbd5e1" stroke-width="0.6"/>`;

      for (let t = 0; t < nTubes; t++) {
        const ty = cy0 + 8 + (t / (nTubes - 1)) * (cH - 22);
        zonesSvg += `<rect x="${sx.toFixed(1)}" y="${ty.toFixed(1)}" width="${segW.toFixed(1)}" height="6" fill="${cRef}" stroke="#334155" stroke-width="0.7"/>`;
      }
      const ax = sx + segW / 2;
      airArrows += `<line x1="${ax.toFixed(1)}" y1="${(cy0 - 16).toFixed(1)}" x2="${ax.toFixed(1)}" y2="${(cy0 + cH + 14).toFixed(1)}" stroke="url(#fpAirG${i})" stroke-width="2.6" stroke-dasharray="6 8" opacity="0.88">
        <animate attributeName="stroke-dashoffset" from="14" to="0" dur="${airDur}s" repeatCount="indefinite"/>
      </line><text x="${ax.toFixed(1)}" y="${(cy0 + cH + 25).toFixed(1)}" text-anchor="middle" font-size="8.5" font-weight="700" fill="${cAirOut}">${tAirOut.toFixed(1)}°</text>`;
    }

    // [우측 뷰: x=302..482] 핀 피치(Fp), 핀 두께(ft), 채널 직경(Dh), 루버 각도(θ)/피치(Lp) 실시간 확대 단면도!
    const zBoxX = 304, zBoxY = 44, zBoxW = 176, zBoxH = 236;
    // Fp_mm (0.8 ~ 4.5 mm) -> 확대 핀 간격 (18px ~ 54px)
    const fpPx = Math.max(18, Math.min(54, 14 + (Fp_mm / 3.5) * 36));
    // ft_mm (0.05 ~ 0.40 mm) -> 확대 핀 두께 (2px ~ 11px)
    const ftPx = Math.max(2, Math.min(11, 1.5 + (ft_mm / 0.35) * 9));
    // Dh_mm (0.8 ~ 6.0 mm) -> 마이크로채널 구멍 크기 (6px ~ 22px)
    const dhPx = Math.max(6, Math.min(22, 5 + (Dh_mm / 5.0) * 16));

    let zoomFinsSvg = "";
    const finStartX = zBoxX + 24;
    const numZoomFins = Math.max(2, Math.min(6, Math.floor(132 / fpPx)));
    for (let k = 0; k < numZoomFins; k++) {
      const fx = finStartX + k * fpPx;
      // 핀 플레이트 본체 (두께 ftPx 실시간 반영!)
      zoomFinsSvg += `<rect x="${(fx - ftPx / 2).toFixed(1)}" y="96" width="${ftPx.toFixed(1)}" height="96" fill="#94a3b8" stroke="#334155" stroke-width="1"/>`;
      if (isLouver) {
        // 루버 절개 슬롯 (각도 lAng 및 피치 Lp 반영!)
        const tilt = Math.tan((lAng * Math.PI) / 180) * 10;
        const stepY = Math.max(12, Math.min(28, 10 + Lp_mm * 8));
        for (let ly = 108; ly < 182; ly += stepY) {
          zoomFinsSvg += `<line x1="${(fx - 7).toFixed(1)}" y1="${(ly + tilt * 0.5).toFixed(1)}" x2="${(fx + 7).toFixed(1)}" y2="${(ly - tilt * 0.5).toFixed(1)}" stroke="#0284c7" stroke-width="2.2" stroke-linecap="round"/>`;
        }
      }
    }
    const f0x = finStartX, f1x = finStartX + fpPx;

    // 상/하 마이크로채널 튜브 포트 (Dh 실시간 반영!)
    let zoomPortsSvg = "";
    const portStep = Math.max(18, dhPx + 8);
    for (let px = zBoxX + 24; px < zBoxX + zBoxW - 20; px += portStep) {
      zoomPortsSvg += `<rect x="${(px - dhPx/2).toFixed(1)}" y="${(82 - dhPx/2).toFixed(1)}" width="${dhPx.toFixed(1)}" height="${dhPx.toFixed(1)}" rx="2.5" fill="${colIn}" stroke="#1e293b" stroke-width="1.2"/>`;
      zoomPortsSvg += `<rect x="${(px - dhPx/2).toFixed(1)}" y="${(204 - dhPx/2).toFixed(1)}" width="${dhPx.toFixed(1)}" height="${dhPx.toFixed(1)}" rx="2.5" fill="${colOut}" stroke="#1e293b" stroke-width="1.2"/>`;
    }

    return `<svg viewBox="0 0 490 330" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <defs>${defs}</defs>
      <!-- 좌측: 전체 코어(W, H, D) & 6-세그먼트 온도장 -->
      <text x="150" y="20" text-anchor="middle" font-size="11" font-weight="800" fill="#0f172a">1. 코어 전체 형상 (W×H×D) &amp; 6-존 온도장</text>
      <!-- 3D 코어 깊이(D) 입체 투영 -->
      <polygon points="${cx0},${cy0} ${cx0+cD},${cy0-cD} ${cx0+cW+cD},${cy0-cD} ${cx0+cW},${cy0}" fill="#cbd5e1" stroke="#475569" stroke-width="1.2"/>
      <polygon points="${cx0+cW},${cy0} ${cx0+cW+cD},${cy0-cD} ${cx0+cW+cD},${cy0+cH-cD} ${cx0+cW},${cy0+cH}" fill="#94a3b8" stroke="#475569" stroke-width="1.2"/>
      <text x="${(cx0+cW+cD/2+10).toFixed(1)}" y="${(cy0-cD/2+2).toFixed(1)}" font-size="9.5" font-weight="800" fill="#7c3aed">깊이 D=${D_mm}mm</text>

      <!-- 좌/우 헤더 탱크 -->
      <rect x="${(cx0 - 14).toFixed(1)}" y="${(cy0 - 3).toFixed(1)}" width="14" height="${(cH + 6).toFixed(1)}" rx="5" fill="${colIn}" stroke="#334155" stroke-width="1.6"/>
      <rect x="${(cx0 + cW).toFixed(1)}" y="${(cy0 - 3).toFixed(1)}" width="14" height="${(cH + 6).toFixed(1)}" rx="5" fill="${colOut}" stroke="#334155" stroke-width="1.6"/>
      ${zonesSvg}
      ${airArrows}

      <!-- 코어 폭(W) 및 높이(H) 치수선 -->
      <line x1="${cx0.toFixed(1)}" y1="${(cy0 + cH + 34).toFixed(1)}" x2="${(cx0 + cW).toFixed(1)}" y2="${(cy0 + cH + 34).toFixed(1)}" stroke="#dc2626" stroke-width="1.8"/>
      <text x="${(cx0 + cW / 2).toFixed(1)}" y="${(cy0 + cH + 47).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="800" fill="#dc2626">← 코어 폭 W = ${W_mm} mm (${p.n_passes||2}패스) →</text>
      <line x1="${(cx0 - 20).toFixed(1)}" y1="${cy0.toFixed(1)}" x2="${(cx0 - 20).toFixed(1)}" y2="${(cy0 + cH).toFixed(1)}" stroke="#0284c7" stroke-width="1.8"/>
      <text x="${(cx0 - 23).toFixed(1)}" y="${(cy0 + cH / 2).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="800" fill="#0284c7">높이 H=${H_mm}</text>

      <!-- 우측: 핀 피치(Fp) · 핀 두께(ft) · 채널(Dh) · 루버 확대 단면도 -->
      <rect x="${zBoxX}" y="${zBoxY}" width="${zBoxW}" height="${zBoxH}" rx="8" fill="#ffffff" stroke="#0284c7" stroke-width="1.8"/>
      <text x="${zBoxX + zBoxW/2}" y="${zBoxY - 7}" text-anchor="middle" font-size="11" font-weight="800" fill="#0284c7">2. 핀·채널 지오메트리 확대 단면</text>

      <!-- 상/하 마이크로채널 튜브 슬랩 -->
      <rect x="${zBoxX + 10}" y="68" width="${zBoxW - 20}" height="28" rx="4" fill="#cbd5e1" stroke="#334155" stroke-width="1.6"/>
      <rect x="${zBoxX + 10}" y="190" width="${zBoxW - 20}" height="28" rx="4" fill="#cbd5e1" stroke="#334155" stroke-width="1.6"/>
      ${zoomPortsSvg}
      ${zoomFinsSvg}

      <!-- 확대도 치수 지시선 (Fp, ft, Dh, 루버) -->
      <line x1="${f0x.toFixed(1)}" y1="145" x2="${f1x.toFixed(1)}" y2="145" stroke="#dc2626" stroke-width="2"/>
      <text x="${((f0x + f1x)/2).toFixed(1)}" y="139" text-anchor="middle" font-size="9.5" font-weight="800" fill="#dc2626">피치 Fp=${Fp_mm}mm</text>
      <text x="${zBoxX + zBoxW/2}" y="236" text-anchor="middle" font-size="9.5" font-weight="700" fill="#334155">핀 두께 ft = <tspan fill="#0284c7">${ft_mm} mm</tspan> | 유로 Dh = <tspan fill="#ea580c">${Dh_mm} mm</tspan></text>
      <text x="${zBoxX + zBoxW/2}" y="253" text-anchor="middle" font-size="9.5" font-weight="700" fill="#15803d">${isLouver ? `루버 핀 (Lp=${Lp_mm}mm, 각도 θ=${lAng}°)` : "플랫 핀 (평판 직선 핀)"}</text>
      <text x="${zBoxX + zBoxW/2}" y="270" text-anchor="middle" font-size="9" fill="#64748b">전열면적 A_sec=${res ? res.metrics.A_sec_m2.toFixed(2) : "-"}m² | V=${res ? res.metrics.V_int_L.toFixed(2) : "-"}L</text>

      <text x="245" y="318" text-anchor="middle" font-size="10.5" fill="#475569">${res ? `h_ref: ${res.metrics.h_ref_Wm2K.toFixed(0)} | h_sec: ${res.metrics.h_sec_Wm2K.toFixed(0)} W/m²K | Q: ${res.metrics.Q_kW.toFixed(2)} kW | ΔP: ${res.metrics.dP_bar.toFixed(3)} bar` : "지오메트리 값을 바꾸면 코어 크기와 핀 간격·두께·채널이 실시간으로 변합니다."}</text>
    </svg>`;
  }

  // ================= 4. 판형 열교환기(PHX) 지오메트리 도해(정면 W·L·쉐브론 β·피치 p_co + 측면 매수 Np·주름깊이 b·두께 tp) 애니메이션 =================
  function buildPlateHxCutawaySVG(n) {
    const p = n.params, res = n.result;
    const W_mm = Math.max(50, Number(p.plate_W_mm) || 120);
    const L_mm = Math.max(120, Number(p.plate_L_mm) || 320);
    const beta = Math.min(75, Math.max(20, Number(p.chevron_deg) || 60));
    const b_mm = Math.max(0.8, Number(p.corr_depth_mm) || 2.0);
    const pco_mm = Math.max(3.0, Number(p.corr_pitch_mm) || 7.0);
    const Np = Math.max(4, Math.round(Number(p.n_plates) || 30));
    const tp_mm = Math.max(0.2, Number(p.plate_thick_mm) || 0.4);

    const colIn = res ? tempToCFDColor(res.inlet.T_C) : "#06b6d4";
    const colOut = res ? tempToCFDColor(res.outlet.T_C) : "#22c55e";
    const secIn = res ? tempToCFDColor(res.metrics.T_sec_in) : "#22c55e";
    const secOut = res ? tempToCFDColor(res.metrics.T_sec_out) : "#0284c7";

    // [좌측 뷰] 플레이트 정면도: 폭 W(60~260mm -> 78~148px), 길이 L(150~600mm -> 130~215px) 실시간 비례!
    const pW = Math.max(78, Math.min(148, 78 + ((W_mm - 60) / 200) * 70));
    const pL = Math.max(130, Math.min(215, 130 + ((L_mm - 150) / 450) * 85));
    const px0 = 42 + (148 - pW) / 2, py0 = 48 + (215 - pL) / 2;
    const pMidX = px0 + pW / 2;

    // 쉐브론 주름 V-패턴: 각도 beta(20~75°) 및 주름 피치 pco_mm(3~15mm -> 간격 9~26px) 실시간 반영!
    const stepPco = Math.max(9, Math.min(26, 7 + (pco_mm / 12) * 18));
    // 중심축 대비 쉐브론 기울기(beta가 클수록 가파른 V자)
    const dyChev = Math.tan(((90 - beta) * Math.PI) / 180) * (pW / 2 - 10);
    let chevLines = "";
    for (let y = py0 + 24; y < py0 + pL - 20; y += stepPco) {
      chevLines += `<polyline points="${(px0 + 8).toFixed(1)},${(y + dyChev * 0.5).toFixed(1)} ${pMidX.toFixed(1)},${(y - dyChev * 0.5).toFixed(1)} ${(px0 + pW - 8).toFixed(1)},${(y + dyChev * 0.5).toFixed(1)}" fill="none" stroke="#1e293b" stroke-width="1.6" opacity="0.75"/>`;
    }

    // [우측 뷰] 적층 측면 단면도: 매수 Np(4~80매 -> 4~14채널), 주름깊이 b(0.8~5mm), 판두께 tp(0.2~1.2mm) 실시간 반영!
    const visCh = Math.max(4, Math.min(14, Math.round(Np / 3)));
    const chGapPx = Math.max(7, Math.min(18, 6 + (b_mm / 4.0) * 11));
    const wallPx = Math.max(1.2, Math.min(4.5, 1.0 + (tp_mm / 1.0) * 3.2));
    const stackW = Math.min(176, visCh * (chGapPx + wallPx));
    const sx0 = 365 - stackW / 2;
    const realChW = stackW / visCh;

    let stackSvg = "";
    for (let i = 0; i < visCh; i++) {
      const cx = sx0 + i * realChW;
      const isRef = (i % 2 === 0);
      stackSvg += `<rect x="${cx.toFixed(1)}" y="54" width="${Math.max(3, realChW - wallPx).toFixed(1)}" height="${pL.toFixed(1)}" fill="url(#${isRef ? 'pheRefG' : 'pheSecG'})" fill-opacity="0.8"/>`;
      // 플레이트 벽면 (두께 tp 반영)
      stackSvg += `<rect x="${(cx + realChW - wallPx).toFixed(1)}" y="54" width="${wallPx.toFixed(1)}" height="${pL.toFixed(1)}" fill="#475569"/>`;
      const midCh = (cx + (realChW - wallPx) / 2).toFixed(1);
      stackSvg += `<line x1="${midCh}" y1="${isRef ? (54 + pL - 6).toFixed(1) : 60}" x2="${midCh}" y2="${isRef ? 60 : (54 + pL - 6).toFixed(1)}" stroke="#ffffff" stroke-width="1.8" stroke-dasharray="5 8" opacity="0.88">
        <animate attributeName="stroke-dashoffset" from="13" to="0" dur="1.0s" repeatCount="indefinite"/>
      </line>`;
    }

    return `<svg viewBox="0 0 490 330" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <defs>
        <linearGradient id="pheRefG" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="${colIn}"/><stop offset="100%" stop-color="${colOut}"/></linearGradient>
        <linearGradient id="pheSecG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${secIn}"/><stop offset="100%" stop-color="${secOut}"/></linearGradient>
      </defs>

      <!-- 1. 좌측: 플레이트 정면 (폭 W, 길이 L, 쉐브론 각도 β, 주름 피치 p_co) -->
      <text x="122" y="20" text-anchor="middle" font-size="11" font-weight="800" fill="#0f172a">1. 플레이트 정면 (W × L · 쉐브론 β · 피치 p_co)</text>
      <rect x="${px0.toFixed(1)}" y="${py0.toFixed(1)}" width="${pW.toFixed(1)}" height="${pL.toFixed(1)}" rx="10" fill="url(#pheRefG)" fill-opacity="0.32" stroke="#334155" stroke-width="2.4"/>
      ${chevLines}
      <!-- 4코너 포트 홀 -->
      <circle cx="${(px0 + 14).toFixed(1)}" cy="${(py0 + 14).toFixed(1)}" r="6.5" fill="${colOut}" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="${(px0 + pW - 14).toFixed(1)}" cy="${(py0 + 14).toFixed(1)}" r="6.5" fill="${secIn}" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="${(px0 + 14).toFixed(1)}" cy="${(py0 + pL - 14).toFixed(1)}" r="6.5" fill="${colIn}" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="${(px0 + pW - 14).toFixed(1)}" cy="${(py0 + pL - 14).toFixed(1)}" r="6.5" fill="${secOut}" stroke="#1e293b" stroke-width="1.5"/>

      <!-- 쉐브론 각도 β & 피치 p_co 콜아웃 -->
      <rect x="${(pMidX - 46).toFixed(1)}" y="${(py0 + pL/2 - 11).toFixed(1)}" width="92" height="22" rx="5" fill="#ffffffee" stroke="#dc2626" stroke-width="1.4"/>
      <text x="${pMidX.toFixed(1)}" y="${(py0 + pL/2 + 4).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="800" fill="#dc2626">β=${beta}° | p_co=${pco_mm}mm</text>

      <!-- 폭 W & 길이 L 치수선 -->
      <line x1="${px0.toFixed(1)}" y1="${(py0 + pL + 14).toFixed(1)}" x2="${(px0 + pW).toFixed(1)}" y2="${(py0 + pL + 14).toFixed(1)}" stroke="#dc2626" stroke-width="1.8"/>
      <text x="${pMidX.toFixed(1)}" y="${(py0 + pL + 27).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="800" fill="#dc2626">← 폭 W = ${W_mm} mm →</text>
      <line x1="${(px0 - 12).toFixed(1)}" y1="${py0.toFixed(1)}" x2="${(px0 - 12).toFixed(1)}" y2="${(py0 + pL).toFixed(1)}" stroke="#0284c7" stroke-width="1.8"/>
      <text x="${(px0 - 15).toFixed(1)}" y="${(py0 + pL/2).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="800" fill="#0284c7">L=${L_mm}</text>

      <!-- 2. 우측: 적층 측면 단면 (매수 Np, 주름 깊이 b, 판 두께 tp) -->
      <text x="365" y="20" text-anchor="middle" font-size="11" font-weight="800" fill="#0284c7">2. 적층 측면 단면 (매수 Np · 깊이 b · 두께 tp)</text>
      <rect x="${(sx0 - 8).toFixed(1)}" y="48" width="8" height="${(pL + 12).toFixed(1)}" rx="2" fill="#334155"/>
      <rect x="${(sx0 + stackW).toFixed(1)}" y="48" width="8" height="${(pL + 12).toFixed(1)}" rx="2" fill="#334155"/>
      ${stackSvg}
      <line x1="${(sx0 - 8).toFixed(1)}" y1="${(68 + pL).toFixed(1)}" x2="${(sx0 + stackW + 8).toFixed(1)}" y2="${(68 + pL).toFixed(1)}" stroke="#16a34a" stroke-width="1.8"/>
      <text x="365" y="${(82 + pL).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="800" fill="#15803d">매수 Np = ${Np}매 | 주름깊이 b = ${b_mm}mm | 두께 tp = ${tp_mm}mm</text>

      <text x="245" y="318" text-anchor="middle" font-size="10.5" fill="#475569">${res ? `전열면적 A_eff: ${res.metrics.A_ref_m2.toFixed(2)} m² | h_ref: ${res.metrics.h_ref_Wm2K.toFixed(0)} | h_sec: ${res.metrics.h_sec_Wm2K.toFixed(0)} W/m²K | Q: ${res.metrics.Q_kW.toFixed(2)} kW` : "W, L, 쉐브론 각도(β), 주름 피치(p_co), 깊이(b), 매수(Np) 변경 시 실시간 반영됩니다."}</text>
    </svg>`;
  }

  // ================= 5. 어큐뮬레이터 / 리시버 컷어웨이 SVG =================
  function buildReceiverCutawaySVG(n) {
    const p = n.params, res = n.result;
    const D_mm = Math.max(20, Number(p.diam_mm) || 90);
    const H_mm = Math.max(40, Number(p.height_mm) || 200);
    const vol_L = (Math.PI * D_mm * D_mm / 4 * H_mm) / 1e6;
    const lv = res ? Math.min(100, Math.max(0, res.metrics.level_pct)) : 35;
    const isSuction = (p.rec_type || "suction") === "suction";
    const colLiq = res ? tempToCFDColor(res.outlet.T_C) : (isSuction ? "#06b6d4" : "#22c55e");

    const vW = Math.max(64, Math.min(200, 64 + ((D_mm - 30) / 170) * 136));
    const vH = Math.max(95, Math.min(220, 95 + ((H_mm - 80) / 320) * 125));
    const vx = 245 - vW / 2, vy = 162 - vH / 2;
    const rx = Math.min(46, vW * 0.32);
    const innerPad = 8, inH = vH - innerPad * 2;
    const hLiq = Math.round(inH * (lv / 100));
    const ySurf = (vy + vH - innerPad) - hLiq;
    const pipeY = vy + Math.min(42, vH * 0.28);

    return `<svg viewBox="0 0 490 330" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <rect x="40" y="${(pipeY - 9).toFixed(1)}" width="${(vx - 38).toFixed(1)}" height="18" fill="${colLiq}" fill-opacity="0.72" stroke="#334155" stroke-width="1.8"/>
      <rect x="${(vx + vW - 2).toFixed(1)}" y="${(pipeY - 9).toFixed(1)}" width="${(450 - (vx + vW)).toFixed(1)}" height="18" fill="${colLiq}" fill-opacity="0.88" stroke="#334155" stroke-width="1.8"/>
      <rect x="${vx.toFixed(1)}" y="${vy.toFixed(1)}" width="${vW.toFixed(1)}" height="${vH.toFixed(1)}" rx="${rx.toFixed(1)}" fill="#e2e8f0" stroke="#334155" stroke-width="3"/>
      <clipPath id="recDynClip"><rect x="${(vx + innerPad).toFixed(1)}" y="${(vy + innerPad).toFixed(1)}" width="${(vW - innerPad * 2).toFixed(1)}" height="${inH.toFixed(1)}" rx="${Math.max(10, rx - 6).toFixed(1)}"/></clipPath>
      <g clip-path="url(#recDynClip)">
        <rect x="${(vx + innerPad).toFixed(1)}" y="${(vy + innerPad).toFixed(1)}" width="${(vW - innerPad * 2).toFixed(1)}" height="${inH.toFixed(1)}" fill="#e0f2fe"/>
        <rect x="${(vx + innerPad).toFixed(1)}" y="${ySurf.toFixed(1)}" width="${(vW - innerPad * 2).toFixed(1)}" height="${(hLiq + 20).toFixed(1)}" fill="${colLiq}" fill-opacity="0.68"/>
        <path d="M ${(vx - 10).toFixed(1)} ${ySurf.toFixed(1)} Q 245 ${(ySurf - 5).toFixed(1)} ${(vx + vW + 10).toFixed(1)} ${ySurf.toFixed(1)}" fill="none" stroke="#ffffff" stroke-width="2.5" opacity="0.85">
          <animateTransform attributeName="transform" type="translate" values="-6,0; 6,0; -6,0" dur="2.2s" repeatCount="indefinite"/>
        </path>
        ${isSuction
          ? `<path d="M ${(vx + vW - 20).toFixed(1)} ${pipeY.toFixed(1)} L ${(vx + vW - 20).toFixed(1)} ${(vy + vH - 28).toFixed(1)} Q 245 ${(vy + vH - 12).toFixed(1)} ${(vx + 22).toFixed(1)} ${(vy + vH - 28).toFixed(1)} L ${(vx + 22).toFixed(1)} ${(vy + 26).toFixed(1)}" fill="none" stroke="#334155" stroke-width="6.5" stroke-linecap="round"/>`
          : `<path d="M ${(vx + vW).toFixed(1)} ${pipeY.toFixed(1)} L ${(vx + vW - 26).toFixed(1)} ${pipeY.toFixed(1)} L ${(vx + vW - 26).toFixed(1)} ${(vy + vH - 20).toFixed(1)}" fill="none" stroke="#334155" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>`}
      </g>
      <line x1="${vx.toFixed(1)}" y1="${(vy + vH + 14).toFixed(1)}" x2="${(vx + vW).toFixed(1)}" y2="${(vy + vH + 14).toFixed(1)}" stroke="#dc2626" stroke-width="1.8"/>
      <text x="245" y="${(vy + vH + 28).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">Ø ${D_mm.toFixed(0)} mm (체적 ${vol_L.toFixed(2)} L)</text>
      <line x1="${(vx - 16).toFixed(1)}" y1="${vy.toFixed(1)}" x2="${(vx - 16).toFixed(1)}" y2="${(vy + vH).toFixed(1)}" stroke="#0284c7" stroke-width="1.8"/>
      <text x="${(vx - 22).toFixed(1)}" y="166" text-anchor="end" font-size="11" font-weight="700" fill="#0284c7">H ${H_mm.toFixed(0)} mm</text>
      <g font-size="11.5" font-family="Malgun Gothic, sans-serif">
        <text x="245" y="24" text-anchor="middle" font-weight="700" fill="#0f172a">${isSuction ? "저압 어큐뮬레이터 (U-Tube 기액분리)" : "고압 액 리시버 (Dip-Tube)"}</text>
        <text x="245" y="${Math.max(vy + 28, Math.min(vy + vH - 18, ySurf + 20)).toFixed(1)}" text-anchor="middle" font-weight="700" fill="#0f172a">액위 ${lv.toFixed(1)}%</text>
        <text x="245" y="316" text-anchor="middle" fill="#475569">${res ? `상태: ${res.metrics.state_desc} | 보유량: ${(res.metrics.mass_kg*1000).toFixed(0)} g` : "시뮬레이션 실행 후 액위 계산"}</text>
      </g>
    </svg>`;
  }

  // ================= 6. 팬(Fan) 컷어웨이 & P-Q 성능곡선 교차 운전점 SVG =================
  function buildFanCutawaySVG(n, simCfg) {
    const p = n.params;
    const FM = global.FanModule;
    let res = n.result;
    if (!res && FM) {
      try { res = FM.run({ ...p, rpm: (p.link_global !== false && simCfg) ? simCfg.fan_rpm : (p.rpm || 1800) }); } catch {}
    }
    const rpm = res ? res.metrics.rpm : (p.rpm || 1800);
    const dur = Math.max(0.22, 2400 / Math.max(200, rpm)).toFixed(2);

    // 우측 P-Q 곡선 그래프 좌표 매핑 (x: 205..468, y: 45..255)
    const gx0 = 212, gy0 = 44, gW = 252, gH = 210;
    let fanPath = "", refPath = "", sysPath = "", opDot = "";
    if (res && res.metrics.curveSamples) {
      const sam = res.metrics.curveSamples;
      const qMax = Math.max(10, res.metrics.qMax_m3min * 1.1, ...sam.map(s => s.q_ref_m3min));
      const dpMax = Math.max(50, res.metrics.dpMax_Pa * 1.15, ...sam.map(s => s.dp_ref_Pa));
      const xOf = q => gx0 + (q / qMax) * gW;
      const yOf = dp => (gy0 + gH) - (Math.min(dpMax * 1.05, dp) / dpMax) * gH;

      sam.forEach((s, i) => {
        fanPath += (i === 0 ? "M " : " L ") + `${xOf(s.q_m3min).toFixed(1)} ${yOf(s.dp_fan_Pa).toFixed(1)}`;
        refPath += (i === 0 ? "M " : " L ") + `${xOf(s.q_ref_m3min).toFixed(1)} ${yOf(s.dp_ref_Pa).toFixed(1)}`;
        sysPath += (i === 0 ? "M " : " L ") + `${xOf(s.q_m3min).toFixed(1)} ${yOf(s.dp_sys_Pa).toFixed(1)}`;
      });
      const ox = xOf(res.metrics.Q_op_m3min), oy = yOf(res.metrics.dP_op_Pa);
      opDot = `<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="6" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
        <text x="${Math.min(gx0 + gW - 50, ox + 8).toFixed(1)}" y="${Math.max(gy0 + 16, oy - 8).toFixed(1)}" font-size="10" font-weight="800" fill="#dc2626">운전점 (${res.metrics.Q_op_m3min.toFixed(1)}m³/m, ${res.metrics.dP_op_Pa.toFixed(0)}Pa)</text>`;
    }

    return `<svg viewBox="0 0 490 325" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <!-- 좌측: 축류 팬 회전 애니메이션 -->
      <text x="95" y="24" text-anchor="middle" font-size="11" font-weight="800" fill="#0f172a">팬 블레이드 (${Math.round(rpm)} RPM)</text>
      <circle cx="95" cy="150" r="68" fill="#e0f2fe" stroke="#0284c7" stroke-width="3"/>
      <g style="transform-origin:95px 150px; animation: spin ${dur}s linear infinite;">
        <ellipse cx="95" cy="106" rx="16" ry="36" fill="#0284c7" fill-opacity="0.75" transform="rotate(15 95 106)"/>
        <ellipse cx="95" cy="194" rx="16" ry="36" fill="#0284c7" fill-opacity="0.75" transform="rotate(15 95 194)"/>
        <ellipse cx="51" cy="150" rx="36" ry="16" fill="#0284c7" fill-opacity="0.75" transform="rotate(15 51 150)"/>
        <ellipse cx="139" cy="150" rx="36" ry="16" fill="#0284c7" fill-opacity="0.75" transform="rotate(15 139 150)"/>
        <circle cx="95" cy="150" r="14" fill="#1e293b"/>
      </g>
      <text x="95" y="246" text-anchor="middle" font-size="10.5" font-weight="700" fill="#0369a1">${res ? `풍량: ${res.metrics.m_air_kgs.toFixed(2)} kg/s` : "-"}</text>
      <text x="95" y="264" text-anchor="middle" font-size="10" fill="#475569">${res ? `팬 동력: ${(res.metrics.W_fan_kW*1000).toFixed(0)} W (η=${(res.metrics.eff_op*100).toFixed(0)}%)` : ""}</text>

      <!-- 우측: 팬 P-Q 곡선 vs 시스템 저항 곡선 -->
      <text x="${gx0 + gW/2}" y="24" text-anchor="middle" font-size="11" font-weight="800" fill="#0f172a">팬 P-Q 성능곡선 vs HX 공기측 저항곡선</text>
      <rect x="${gx0}" y="${gy0}" width="${gW}" height="${gH}" fill="#ffffff" stroke="#334155" stroke-width="1.5"/>
      <path d="${refPath}" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="4 4"/>
      <path d="${fanPath}" fill="none" stroke="#0284c7" stroke-width="2.6"/>
      <path d="${sysPath}" fill="none" stroke="#ea580c" stroke-width="2.4"/>
      ${opDot}
      <text x="${gx0 + gW/2}" y="${gy0 + gH + 18}" text-anchor="middle" font-size="10" fill="#334155">풍량 Q [m³/min] (파랑: 현재RPM 팬곡선 / 주황: 열교환기 저항곡선)</text>
    </svg>`;
  }

  // ================= 7. 센서 계기판 컷어웨이 SVG =================
  function buildSensorCutawaySVG(n) {
    const res = n.result;
    const isP = n.type === "sensor_p", isT = n.type === "sensor_t";
    const valStr = !res || !res.connected ? "미연결" : (isP ? `${res.P_bar.toFixed(2)} bar` : (isT ? `${res.T_C.toFixed(1)} °C` : `SH ${res.SH.toFixed(1)} K`));
    const ratio = !res || !res.connected ? 0.1 : Math.max(0, Math.min(1, isP ? res.P_bar / 25 : (isT ? (res.T_C + 20) / 100 : res.SH / 20)));
    const ang = -125 + ratio * 250;
    const col = !res || !res.connected ? "#94a3b8" : (isP ? "#0284c7" : (isT ? "#ea580c" : "#16a34a"));

    return `<svg viewBox="0 0 490 300" width="100%" height="100%" style="background:#f8fafc;border-radius:8px;border:1px solid #cbd5e1;">
      <circle cx="245" cy="145" r="95" fill="#ffffff" stroke="${col}" stroke-width="6"/>
      <circle cx="245" cy="145" r="82" fill="none" stroke="#e2e8f0" stroke-width="8" stroke-dasharray="14 6"/>
      <g transform="rotate(${ang.toFixed(1)} 245 145)"><line x1="245" y1="145" x2="245" y2="70" stroke="#dc2626" stroke-width="4" stroke-linecap="round"/></g>
      <circle cx="245" cy="145" r="10" fill="#1e293b"/>
      <rect x="170" y="180" width="150" height="32" rx="6" fill="#0f172a"/>
      <text x="245" y="201" text-anchor="middle" font-size="14" font-weight="700" fill="#38bdf8">${valStr}</text>
      <text x="245" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#0f172a">${n.modelName} — 실시간 계측 게이지</text>
      <text x="245" y="274" text-anchor="middle" font-size="11.5" fill="#475569">${res && res.connected ? `P: ${res.P_bar.toFixed(2)} bar | T: ${res.T_C.toFixed(1)}°C | T_sat: ${res.T_sat_C.toFixed(1)}°C | 과열도 SH: ${res.SH.toFixed(2)} K` : "측정 위치(배관/노드)를 연결하고 시뮬레이션을 실행하세요."}</text>
    </svg>`;
  }

  function buildCutawayByNode(node, simCfg) {
    if (node.type === "valve") return buildValveCutawaySVG(node);
    if (node.type === "compressor") return buildCompressorCutawaySVG(node, simCfg);
    if (node.type === "hx_fin_plate" || (node.type === "hx" && node.params.hxType !== "plate")) return buildFinPlateCutawaySVG(node);
    if (node.type === "hx_plate" || (node.type === "hx" && node.params.hxType === "plate")) return buildPlateHxCutawaySVG(node);
    if (node.type === "receiver") return buildReceiverCutawaySVG(node);
    if (node.type === "fan") return buildFanCutawaySVG(node, simCfg);
    if (global.SolverModule.isSensorType(node.type)) return buildSensorCutawaySVG(node);
    return "";
  }

  // DOM 이벤트를 절대 건드리지 않는 순수 KPI HTML 생성 함수!
  function buildKpiByNode(node) {
    const res = node.result;
    if (node.type === "valve") {
      return `<div class="kpi"><div class="lbl">유효 개도율</div><div class="val" style="color:var(--purple)">${res ? res.metrics.opening_pct.toFixed(1)+'%' : '-'}</div><div class="sub">${res && res.metrics.SH_meas !== null ? `SH ${res.metrics.SH_meas.toFixed(1)}K` : ''}</div></div>
        <div class="kpi"><div class="lbl">유효 Cd / 초크</div><div class="val" style="color:var(--accent);font-size:14.5px;">${res ? res.metrics.Cd_eff.toFixed(3) : '-'}</div><div class="sub">${res ? (res.metrics.is_choked ? '⚠️ CHOKED' : '아음속 정상') : ''}</div></div>
        <div class="kpi"><div class="lbl">압력강하 ΔP</div><div class="val" style="color:var(--hot)">${res ? res.metrics.dP_bar.toFixed(2)+' bar' : '-'}</div></div>
        <div class="kpi"><div class="lbl">출구 T4 / 건도</div><div class="val" style="color:var(--green);font-size:14.5px;">${res ? `${res.outlet.T_C.toFixed(1)}°C / x=${res.metrics.quality.toFixed(2)}` : '-'}</div></div>`;
    }
    if (node.type === "compressor") {
      return `<div class="kpi"><div class="lbl">압력비 PR</div><div class="val" style="color:var(--accent)">${res ? res.metrics.PR.toFixed(2) : '-'}</div></div>
        <div class="kpi"><div class="lbl">질량유량</div><div class="val" style="color:var(--green)">${res ? res.outlet.m_dot.toFixed(4)+' kg/s' : '-'}</div></div>
        <div class="kpi"><div class="lbl">토출온도 T2</div><div class="val" style="color:var(--hot)">${res ? res.outlet.T_C.toFixed(1)+' °C' : '-'}</div></div>
        <div class="kpi"><div class="lbl">축동력 W</div><div class="val" style="color:var(--warn)">${res ? res.metrics.W_shaft_kW.toFixed(2)+' kW' : '-'}</div></div>`;
    }
    if (global.SolverModule.isHxType(node.type)) {
      return `<div class="kpi"><div class="lbl">열교환량 Q</div><div class="val" style="color:var(--accent)">${res ? res.metrics.Q_kW.toFixed(2)+' kW' : '-'}</div><div class="sub">${res ? res.metrics.role : ''}</div></div>
        <div class="kpi"><div class="lbl">h_ref / h_sec</div><div class="val" style="color:var(--green);font-size:14px;">${res ? `${res.metrics.h_ref_Wm2K.toFixed(0)} / ${res.metrics.h_sec_Wm2K.toFixed(0)}` : '-'}</div><div class="sub">W/m²K</div></div>
        <div class="kpi"><div class="lbl">모멘텀 ΔP</div><div class="val" style="color:var(--hot)">${res ? res.metrics.dP_bar.toFixed(3)+' bar' : '-'}</div></div>
        <div class="kpi"><div class="lbl">냉매 보유량</div><div class="val" style="color:var(--purple)">${res ? (res.metrics.mass_kg*1000).toFixed(0)+' g' : '-'}</div><div class="sub">${res ? `V ${res.metrics.V_int_L.toFixed(2)} L` : ''}</div></div>`;
    }
    if (node.type === "receiver") {
      return `<div class="kpi"><div class="lbl">액위</div><div class="val" style="color:var(--accent)">${res ? res.metrics.level_pct.toFixed(1)+' %' : '-'}</div><div class="sub">${res ? res.metrics.state_desc : ''}</div></div>
        <div class="kpi"><div class="lbl">보유 냉매량</div><div class="val" style="color:var(--green)">${res ? (res.metrics.mass_kg*1000).toFixed(0)+' g' : '-'}</div></div>
        <div class="kpi"><div class="lbl">출구 온도</div><div class="val" style="color:var(--hot)">${res ? res.outlet.T_C.toFixed(1)+' °C' : '-'}</div><div class="sub">${res ? res.metrics.phase : ''}</div></div>
        <div class="kpi"><div class="lbl">모멘텀 ΔP</div><div class="val" style="color:var(--purple)">${res ? res.metrics.dP_bar.toFixed(3)+' bar' : '-'}</div></div>`;
    }
    if (node.type === "fan") {
      return `<div class="kpi"><div class="lbl">운전 풍량 Q</div><div class="val" style="color:var(--accent)">${res ? res.metrics.Q_op_m3min.toFixed(1)+' m³/m' : '-'}</div><div class="sub">${res ? res.metrics.m_air_kgs.toFixed(2)+' kg/s' : ''}</div></div>
        <div class="kpi"><div class="lbl">운전 정압 ΔP</div><div class="val" style="color:var(--hot)">${res ? res.metrics.dP_op_Pa.toFixed(0)+' Pa' : '-'}</div></div>
        <div class="kpi"><div class="lbl">팬 효율 η</div><div class="val" style="color:var(--green)">${res ? (res.metrics.eff_op*100).toFixed(1)+' %' : '-'}</div></div>
        <div class="kpi"><div class="lbl">팬 소비동력</div><div class="val" style="color:var(--warn)">${res ? (res.metrics.W_fan_kW*1000).toFixed(0)+' W' : '-'}</div></div>`;
    }
    return "";
  }

  // ================= 상세 탭 통합 렌더러 (container.querySelector 사용으로 DOM 충돌 원천 차단!) =================
  function renderComponentDetailTab(container, node, ctx) {
    const { nodes, edges, fluidRawDB, fluidTableDB, lastConvergence, simConfig, onParamChange, onFluidAction, onSolverAction, onPointLookupInit, onShowCorrHelp } = ctx;
    const q = sel => container.querySelector(sel);
    const refNodes = nodes.filter(x => x.type === "refrigerant");
    const sigNodes = nodes.filter(x => global.SolverModule.isSignalType(x.type));
    const fluidSelectHTML = (n) => {
      if (!refNodes.length) return `<div style="color:var(--danger);font-size:11.5px;margin-bottom:8px;">⚠️ 캔버스에 냉매 노드가 없습니다.</div>`;
      return `<div class="field"><div class="field-row"><label>연결 냉매 노드</label><select id="dtFluidNode" style="width:155px;">${refNodes.map(r => `<option value="${r.id}" ${n.params.fluidNodeId===r.id?"selected":""}>${r.modelName} (${r.params.fluid})</option>`).join("")}</select></div></div>`;
    };
    const sigSelectHTML = (n, labelTxt = "입력 신호 컴포넌트") => {
      const connSig = global.SolverModule.findConnectedSignal(n, nodes, edges);
      return `<div class="field"><div class="field-row"><label>${labelTxt}</label><b style="color:${connSig?'#d97706':'var(--muted)'};font-size:11.5px;">${connSig ? `⚡ ${connSig.modelName} (선 연결됨)` : "(캔버스에서 신호선 직접 연결)"}</b></div></div>`;
    };
    const bindHelpBtns = () => {
      container.querySelectorAll(".help-q-btn").forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); if (onShowCorrHelp) onShowCorrHelp(btn.dataset.corr); };
      });
    };

    // 1) 솔버 상세 탭
    if (node.type === "solver") {
      const p = node.params, c = lastConvergence;
      container.innerHTML = `<div class="single-layout">
        <div>
          <div class="card">
            <h2>1. 지배방정식 (보존법칙 — Physics)</h2>
            <div class="field"><div class="field-row"><label>해석 루프</label><select id="dtLoopMode" style="width:185px;"><option value="closed" ${p.loop_mode!=='open'?'selected':''}>폐회로 (반복 수렴)</option><option value="open" ${p.loop_mode==='open'?'selected':''}>개회로 (1회 순차 패스)</option></select></div></div>
            <label class="chk-line"><input type="checkbox" id="dtGovMass" ${p.gov_mass!==false?'checked':''}/> <b>질량보존</b> (유량 연속 + 충전량·액위)</label>
            <label class="chk-line"><input type="checkbox" id="dtGovEnergy" ${p.gov_energy!==false?'checked':''}/> <b>에너지보존</b> (h_1'=h_1 폐합, P2 자동 탐색)</label>
            <label class="chk-line"><input type="checkbox" id="dtGovMom" ${p.gov_momentum!==false?'checked':''}/> <b>모멘텀보존</b> (지오메트리 마찰·가속·오리피스 ΔP)</label>
            <div class="sec-hdr">2. 수치해석 기법 (Numerical Method — How to Solve)</div>
            <div class="field"><div class="field-row"><label>반복 수렴 알고리즘</label><select id="dtNumMethod" style="width:205px;">
              <option value="newton_secant" ${p.num_method==='newton_secant'?'selected':''}>준-뉴턴 / 할선법 (Quasi-Newton)</option>
              <option value="fixed_point" ${p.num_method==='fixed_point'?'selected':''}>고정점 완화법 (Picard)</option>
              <option value="aitken" ${p.num_method==='aitken'?'selected':''}>Aitken Δ² 가속법</option>
            </select></div></div>
            <div class="field"><div class="field-row"><label>최대 반복 횟수 (maxIter)</label><input type="number" id="dtSvMaxIter" value="${p.maxIter}" min="5" max="200" step="5"></div></div>
            <div class="field"><div class="field-row"><label>허용오차 tolT [K] / tolP [bar]</label><div style="display:flex;gap:4px;"><input type="number" id="dtSvTolT" value="${p.tolT}" step="0.01" style="width:56px;"><input type="number" id="dtSvTolP" value="${p.tolP}" step="0.01" style="width:56px;"></div></div></div>
            <div class="field"><div class="field-row"><label>완화 계수 α (0.1~1.0)</label><input type="number" id="dtSvAlpha" value="${p.alpha}" min="0.1" max="1.0" step="0.05"></div></div>
            <button class="primary" id="dtSvRun" style="width:100%;margin-top:8px;">▶ 현재 회로로 솔버 실행</button>
            <button class="green" id="dtSvOpt" style="width:100%;margin-top:6px;">⚡ 완화계수(α) 자동 최적화</button>
          </div>
          <div class="card">
            <h2>수치해석 기법 비교</h2>
            ${Object.entries(global.SolverModule.NUMERICAL_DOCS).map(([k, d]) => `<div class="doc-card" style="${k===p.num_method?'border-color:var(--accent);':''}"><h3>${d.name}</h3><div><code>${d.formula}</code></div><div>${d.pros}</div></div>`).join("")}
          </div>
        </div>
        <div>
          <div class="kpi-grid">
            <div class="kpi"><div class="lbl">수렴 상태</div><div class="val" style="color:${c&&c.converged?'var(--green)':'var(--danger)'}">${c?(c.converged?'수렴 완료':'미수렴'):'대기'}</div><div class="sub">${c?`${c.iterations}/${c.maxIter}회`:'-'}</div></div>
            <div class="kpi"><div class="lbl">ΔT 잔차</div><div class="val" style="color:var(--accent)">${c?c.residualT.toFixed(4)+' K':'-'}</div></div>
            <div class="kpi"><div class="lbl">ΔP 잔차</div><div class="val" style="color:var(--hot)">${c?c.residualP.toFixed(4)+' bar':'-'}</div></div>
            <div class="kpi"><div class="lbl">Δh 잔차</div><div class="val" style="color:var(--purple)">${c?c.residualH.toFixed(3)+' kJ/kg':'-'}</div><div class="sub">${c&&c.convergedP2?`P2: ${c.convergedP2.toFixed(2)} bar`:''}</div></div>
          </div>
          <div class="card">
            <h2>3대 보존법칙 검증 리포트</h2>
            <div style="font-size:12.5px;line-height:1.85;">${c && c.conservation ? (() => {
              const m = c.conservation.mass, en = c.conservation.energy, mo = c.conservation.momentum;
              return `• <b>질량보존 (${m.charge_mode==='auto'?'자동':'수동'})</b>: 총 <b>${m.total_g.toFixed(1)} g</b> / 목표 <b>${m.target_g.toFixed(1)} g</b> (잔차 ${m.residual_g.toFixed(1)} g) — HX ${m.hx_g.toFixed(0)}g + 탱크 ${m.rec_g.toFixed(0)}g + 배관 ${m.pipe_g.toFixed(0)}g + 압축기 ${m.comp_g.toFixed(0)}g<br>
              • <b>에너지보존</b>: 방열 Q_cond <b>${en.Q_cond.toFixed(2)} kW</b> vs (Q_evap <b>${en.Q_evap.toFixed(2)} kW</b> + W_gas <b>${en.W_gas.toFixed(2)} kW</b>) → 잔차 <b>${en.residual_kW.toFixed(3)} kW (${en.residual_pct.toFixed(2)}%)</b><br>
              • <b>모멘텀보존</b>: 압축기 ΔP <b>${mo.dP_comp_bar.toFixed(3)} bar</b> vs 회로 ΣΔP <b>${mo.dP_loop_bar.toFixed(3)} bar</b> → 잔차 <b>${mo.residual_bar.toFixed(4)} bar</b>`;
            })() : "시뮬레이션을 실행하면 보존법칙 검증 결과가 표시됩니다."}</div>
          </div>
          <div class="card" style="height:310px;display:flex;flex-direction:column;">
            <h2>반복 횟수별 잔차 수렴 곡선 (ΔT, Δh, ΔP)</h2>
            <div style="flex:1;min-height:0;"><canvas id="dtSolverCanvas" style="width:100%;height:100%;display:block;"></canvas></div>
          </div>
        </div>
      </div>`;
      q("#dtLoopMode").onchange = e => { p.loop_mode = e.target.value; onParamChange(true); };
      q("#dtGovMass").onchange = e => { p.gov_mass = e.target.checked; onParamChange(true); };
      q("#dtGovEnergy").onchange = e => { p.gov_energy = e.target.checked; onParamChange(true); };
      q("#dtGovMom").onchange = e => { p.gov_momentum = e.target.checked; onParamChange(true); };
      q("#dtNumMethod").onchange = e => { p.num_method = e.target.value; onParamChange(true); };
      ["#dtSvMaxIter:maxIter","#dtSvTolT:tolT","#dtSvTolP:tolP","#dtSvAlpha:alpha"].forEach(s => { const [id, k] = s.split(":"); q(id).oninput = e => { p[k] = +e.target.value; onParamChange(false); }; });
      q("#dtSvRun").onclick = () => onSolverAction("run");
      q("#dtSvOpt").onclick = () => onSolverAction("optimize");
      if (c && ctx.drawSolverChart) ctx.drawSolverChart(c.history, "dtSolverCanvas");
      return;
    }

    // 2) 냉매 상세 탭
    if (node.type === "refrigerant") {
      const p = node.params;
      const twoPhaseList = Object.keys(fluidTableDB).filter(k => fluidTableDB[k].kind === "two_phase");
      const allFluids = Object.keys(fluidRawDB);
      const editF = p.editFluid || p.fluid || "R134a";
      const raw = fluidRawDB[editF] || fluidRawDB["R134a"];
      const isSingle = raw && raw.kind === "single_phase";
      const consMass = lastConvergence && lastConvergence.conservation ? lastConvergence.conservation.mass : null;

      container.innerHTML = `<div class="prop-layout">
        <div class="grid-2">
          <div class="card">
            <h2>❄️ ${node.modelName} — 작동 유체(냉매/2차유체) &amp; 충전량 설정</h2>
            <div class="field"><div class="field-row"><label>유체 종류 (냉매 / Air / Water / GW)</label><select id="dtRefFluid" style="width:160px;">${allFluids.map(k => `<option value="${k}" ${k===p.fluid?"selected":""}>${k}</option>`).join("")}</select></div></div>
            <div class="field"><div class="field-row"><label>충전량 결정 방식</label><select id="dtChargeMode" style="width:160px;"><option value="auto" ${p.charge_mode==='auto'?'selected':''}>자동 계산 (Auto)</option><option value="manual" ${p.charge_mode!=='auto'?'selected':''}>수동 입력 (Manual)</option></select></div></div>
            ${p.charge_mode === "auto"
              ? `<div class="field"><div class="field-row"><label>목표 탱크 액위 [%]</label><input type="number" id="dtAutoLv" value="${p.auto_rec_level_pct ?? 40}" min="10" max="90" step="5"></div></div>`
              : `<div class="field"><div class="field-row"><label>수동 냉매 충전량 [g]</label><input type="number" id="dtChargeG" value="${p.charge_g ?? 650}" min="50" max="5000" step="25"></div></div>`}
            <div class="res-box"><h3>현재 냉매 보유량 분포</h3>${consMass ? `총 충전량: <b style="color:var(--accent)">${consMass.total_g.toFixed(1)} g</b> (${consMass.charge_mode==='auto'?'자동':'수동'})<br>• HX: <b>${consMass.hx_g.toFixed(1)} g</b> | 탱크: <b>${consMass.rec_g.toFixed(1)} g</b> | 배관: <b>${consMass.pipe_g.toFixed(1)} g</b> | 압축기: <b>${consMass.comp_g.toFixed(1)} g</b>` : "실행 후 표시됩니다."}</div>
          </div>
          <div class="card">
            <h2>📐 자동 충전량(Auto Charge) 계산 방식 상세</h2>
            <div style="font-size:12px;line-height:1.7;">
              <b>1. 열교환기 6-세그먼트 Zivi 기공률 적분</b>: 슬립비 <code>S=(ρ_f/ρ_g)^(1/3)</code> 기반 2상 밀도 <code>ρ_2ph = α·ρ_g + (1-α)·ρ_f</code>를 체적 적분합니다.<br>
              <b>2. 어큐뮬레이터/리시버 목표 액위</b>: 목표 액위(<code>f_lv</code>)에 해당하는 <code>V_tank·(f_lv·ρ_f + (1-f_lv)·ρ_g)</code>를 배정합니다.<br>
              <b>3. 배관 및 압축기 합산</b>: 배관(<code>60cc/ea × ρ</code>)과 압축기(<code>2.5·Vd × ρ_avg</code>)를 합산해 <code>M_auto</code>를 결정합니다.
            </div>
          </div>
        </div>
        <div class="card">
          <h2><span>🔍 특정 상태점 물성치 조회 (CoolProp 정확도 검증)</span><span id="ptFluidBadge" style="font-size:11.5px;color:var(--muted);"></span></h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <div class="cfg-item"><label>조회 유체</label><select id="dtLookupFluid">${allFluids.map(k => `<option value="${k}" ${k===editF?"selected":""}>${k}</option>`).join("")}</select></div>
            <div class="cfg-item"><label>입력 방식</label><select id="ptMode"><option value="PT">P - T</option><option value="PH">P - h</option><option value="PS">P - s</option><option value="PX">P - x</option><option value="TSAT">T_sat (포화)</option></select></div>
            <div class="cfg-item" id="ptBox1"><label id="ptLbl1">압력 P [bar]</label><input type="number" id="ptIn1" value="10.0" step="0.5" style="width:86px;"></div>
            <div class="cfg-item" id="ptBox2"><label id="ptLbl2">온도 T [°C]</label><input type="number" id="ptIn2" value="45.0" step="1.0" style="width:86px;"></div>
            <button class="primary sm" id="ptCalcBtn">조회</button>
          </div>
          <div id="ptResult"></div>
        </div>
        <div class="card">
          <h2>CoolProp / 2D CSV 원본 테이블 (${editF}) <span style="display:flex;gap:6px;"><button class="green sm" id="dtApplyCsv">CSV 파싱 적용</button><button class="sm" id="dtResetCp">CoolProp 복원</button></span></h2>
          <div id="dtPropStatus" style="font-size:11.5px;color:var(--green);margin-bottom:6px;">CoolProp 8.0.0 물성치가 로드되어 있습니다.</div>
          ${isSingle ? `<textarea id="dtSingleCsv" style="height:200px;">${raw.single || ""}</textarea>`
            : `<textarea id="dtSatCsv" style="height:105px;">${raw.sat || ""}</textarea>
               <div class="grid-2" style="margin-top:8px;">
                 <div><div class="sub-tabs" id="dtSubTabs">${global.FluidPropModule.TABLE_KEYS.map(t => `<button class="sub-btn ${(p.subKey||'h')===t.key?'active':''}" data-k="${t.key}">${t.key}</button>`).join("")}</div><textarea id="dtSubCsv">${(raw.sub && raw.sub[p.subKey||'h']) || ""}</textarea></div>
                 <div><div class="sub-tabs" id="dtSupTabs">${global.FluidPropModule.TABLE_KEYS.map(t => `<button class="sub-btn ${(p.supKey||'h')===t.key?'active':''}" data-k="${t.key}">${t.key}</button>`).join("")}</div><textarea id="dtSupCsv">${(raw.sup && raw.sup[p.supKey||'h']) || ""}</textarea></div>
               </div>`}
        </div>
      </div>`;
      q("#dtRefFluid").onchange = e => { p.fluid = e.target.value; p.editFluid = e.target.value; onParamChange(true); };
      q("#dtChargeMode").onchange = e => { p.charge_mode = e.target.value; onParamChange(true); };
      const lvEl = q("#dtAutoLv"); if (lvEl) lvEl.oninput = e => { p.auto_rec_level_pct = +e.target.value || 40; onParamChange(false); };
      const cgEl = q("#dtChargeG"); if (cgEl) cgEl.oninput = e => { p.charge_g = +e.target.value || 650; onParamChange(false); };
      q("#dtLookupFluid").onchange = e => { p.editFluid = e.target.value; onFluidAction("refreshTab", node); };
      q("#dtResetCp").onclick = () => onFluidAction("resetCoolprop", node);
      q("#dtApplyCsv").onclick = () => {
        if (isSingle) raw.single = q("#dtSingleCsv").value;
        else { raw.sat = q("#dtSatCsv").value; raw.sub[p.subKey || "h"] = q("#dtSubCsv").value; raw.sup[p.supKey || "h"] = q("#dtSupCsv").value; }
        onFluidAction("applyCsv", node, editF);
      };
      if (!isSingle) {
        container.querySelectorAll("#dtSubTabs .sub-btn").forEach(b => b.onclick = () => { raw.sub[p.subKey || "h"] = q("#dtSubCsv").value; p.subKey = b.dataset.k; onFluidAction("refreshTab", node); });
        container.querySelectorAll("#dtSupTabs .sub-btn").forEach(b => b.onclick = () => { raw.sup[p.supKey || "h"] = q("#dtSupCsv").value; p.supKey = b.dataset.k; onFluidAction("refreshTab", node); });
      }
      if (onPointLookupInit) onPointLookupInit(editF);
      return;
    }

    // 3) 팽창밸브 상세 탭 (오리피스 지름 D 무제한 애니메이션 + 지름연동 가변 Cd + 초크 플로우 선택)
    if (node.type === "valve") {
      const p = node.params;
      const D_mm = Math.max(0.4, Number(p.orifice_D_mm) || 2.8);
      const A_max = (Math.PI * D_mm * D_mm) / 4;
      const flowCorr = p.flow_corr || "re_diam_cd";
      const sensors = nodes.filter(x => global.SolverModule.isSensorType(x.type));
      const VM = global.ValveModule;
      const liveCd = VM ? VM.calcEffectiveCd(p, D_mm, 1120, 150, 0.08, A_max * 0.5e-6, 4.0) : (p.Cd || 0.65);

      container.innerHTML = `<div class="single-layout">
        <div>
          <div class="card">
            <h2>🔧 ${node.modelName} — 상세 모델링</h2>
            ${fluidSelectHTML(node)}
            <div class="field"><div class="field-row"><label>제어 모드 ${helpBtnHTML(p.valve_mode==='txv_sh'?'txv_sh':'orifice')}</label>
              <select id="dtVMode" style="width:170px;">
                <option value="txv_sh" ${p.valve_mode==='txv_sh'?'selected':''}>TXV 과열도 피드백 (센서)</option>
                <option value="orifice" ${p.valve_mode==='orifice'?'selected':''}>수동 개도 오리피스</option>
                <option value="fixed_p" ${p.valve_mode==='fixed_p'?'selected':''}>목표 저압 지정</option>
              </select></div></div>
            ${p.valve_mode === "txv_sh" ? `
              <div class="field"><div class="field-row"><label>연결 과열도 센서</label><select id="dtVSensor" style="width:160px;"><option value="">(미지정)</option>${sensors.map(s => `<option value="${s.id}" ${p.sensorNodeId===s.id?'selected':''}>${s.modelName}</option>`).join("")}</select></div></div>
              <div class="field"><div class="field-row"><label>목표 과열도 SH_target [K]</label><input type="number" id="dtVSH" value="${p.SH_target_K ?? 6.0}" step="0.5" min="1" max="25"></div></div>
              <div class="field"><div class="field-row"><label>비례 게인 Kp / 기준개도 [%]</label><div style="display:flex;gap:4px;"><input type="number" id="dtVKp" value="${p.Kp_sh ?? 3.5}" step="0.5" style="width:52px;"><input type="number" id="dtVBase" value="${p.open_base_pct ?? 50}" step="2" style="width:52px;"></div></div></div>`
            : p.valve_mode === "orifice" ? `
              <div class="field"><div class="field-row"><label>수동 밸브 개도율 [%]</label><input type="number" id="dtVOpen" value="${p.opening_pct ?? 50}" min="5" max="100" step="1"></div>
              <input type="range" id="dtVOpenRange" min="5" max="100" step="1" value="${p.opening_pct ?? 50}" style="width:100%;"></div>`
            : `<div class="field"><div class="field-row"><label>목표 출구압 P_out [bar]</label><input type="number" id="dtVPout" value="${p.P_out_bar}" step="0.1" min="0.8"></div></div>`}
            <div class="sec-hdr">오리피스 지오메트리 &amp; 초크/유량계수 상관식</div>
            <div class="field"><div class="field-row"><label>오리피스 지름 D [mm]</label><input type="number" id="dtVDiam" value="${D_mm.toFixed(2)}" step="0.1" min="0.4" max="8.0"></div>
              <input type="range" id="dtVDiamRange" min="0.4" max="8.0" step="0.1" value="${D_mm}" style="width:100%;"></div>
            <div class="field"><div class="field-row"><label>자동 계산 최대 면적 A_max</label><b id="dtVAreaDisp" style="color:var(--accent);">${A_max.toFixed(3)} mm²</b></div></div>
            <div class="field"><div class="field-row"><label>유량·초크 상관식 ${helpBtnHTML(flowCorr)}</label>
              <select id="dtVFlowCorr" style="width:170px;">
                <option value="re_diam_cd" ${flowCorr==='re_diam_cd'?'selected':''}>지름·Re 연동 가변 Cd</option>
                <option value="hem_choked" ${flowCorr==='hem_choked'?'selected':''}>2상 초크 플로우 (HEM)</option>
                <option value="const_cd" ${flowCorr==='const_cd'?'selected':''}>고정 Cd 베르누이</option>
              </select></div></div>
            <div class="field"><div class="field-row"><label>기준 Cd_0 / 실시간 유효 Cd</label><span><input type="number" id="dtVCd" value="${p.Cd || 0.65}" step="0.02" min="0.2" max="0.95" style="width:62px;"> → <b id="dtVCdEffDisp" style="color:#0284c7;">${liveCd.toFixed(3)}</b></span></div></div>
          </div>
        </div>
        <div>
          <div class="card" style="height:375px;display:flex;flex-direction:column;">
            <h2>팽창밸브 내부 단면 &amp; 오리피스 지름·니들 실시간 애니메이션</h2>
            <div id="dtCutawayWrap" style="flex:1;min-height:0;">${buildValveCutawaySVG(node)}</div>
          </div>
          <div class="kpi-grid">${buildKpiByNode(node)}</div>
        </div>
      </div>`;
      bindHelpBtns();
      const fSel = q("#dtFluidNode"); if (fSel) fSel.onchange = e => { p.fluidNodeId = e.target.value; onParamChange(true); };
      q("#dtVMode").onchange = e => { p.valve_mode = e.target.value; onParamChange(true); };
      q("#dtVFlowCorr").onchange = e => { p.flow_corr = e.target.value; onParamChange(true); };
      const sSel = q("#dtVSensor"); if (sSel) sSel.onchange = e => { p.sensorNodeId = e.target.value; onParamChange(true); };
      ["#dtVSH:SH_target_K","#dtVKp:Kp_sh","#dtVBase:open_base_pct","#dtVPout:P_out_bar","#dtVCd:Cd"].forEach(s => {
        const [id, k] = s.split(":"), el = q(id);
        if (el) el.oninput = e => {
          p[k] = +e.target.value;
          const cdDisp = q("#dtVCdEffDisp");
          if (cdDisp && VM) cdDisp.textContent = VM.calcEffectiveCd(p, p.orifice_D_mm || 2.8, 1120, 150, 0.08, 1.5e-6, 4.0).toFixed(3);
          onParamChange(false);
        };
      });
      const bindPair = (nSel, rSel, key, extra) => {
        const ne = q(nSel), re = q(rSel);
        const upd = v => { p[key] = +v; if (extra) extra(p[key]); onParamChange(false); };
        if (ne) ne.oninput = e => { if (re) re.value = e.target.value; upd(e.target.value); };
        if (re) re.oninput = e => { if (ne) ne.value = e.target.value; upd(e.target.value); };
      };
      bindPair("#dtVOpen", "#dtVOpenRange", "opening_pct");
      bindPair("#dtVDiam", "#dtVDiamRange", "orifice_D_mm", d => {
        const aEl = q("#dtVAreaDisp"); if (aEl) aEl.textContent = ((Math.PI * d * d) / 4).toFixed(3) + " mm²";
        const cdDisp = q("#dtVCdEffDisp"); if (cdDisp && VM) cdDisp.textContent = VM.calcEffectiveCd(p, d, 1120, 150, 0.08, (Math.PI * d * d / 4) * 0.5e-6, 4.0).toFixed(3);
      });
      return;
    }

    // 4) 압축기 상세 탭
    if (node.type === "compressor") {
      const p = node.params, tabKey = p._csvTab || "is";
      container.innerHTML = `<div class="single-layout">
        <div><div class="card"><h2>⚙️ ${node.modelName} — 상세 모델링</h2>${fluidSelectHTML(node)}${sigSelectHTML(node, "RPM 제어 신호 컴포넌트")}
          <label class="chk-line"><input type="checkbox" id="dtCLink" ${p.link_global!==false?'checked':''}/> 전역 압축기 RPM 연동 (${simConfig.comp_rpm} RPM)</label>
          <div class="field"><div class="field-row"><label>초기 입구압 P1 [bar]</label><input type="number" id="dtCP1" value="${p.P1_bar}" step="0.1"></div></div>
          <div class="field"><div class="field-row"><label>초기 출구압 P2 [bar]</label><input type="number" id="dtCP2" value="${p.P2_bar}" step="0.2"></div></div>
          <div class="field"><div class="field-row"><label>초기 입구온도 T1 [°C]</label><input type="number" id="dtCT1" value="${p.T1_C}" step="0.5"></div></div>
          <div class="field"><div class="field-row"><label>개별 회전수 [RPM]</label><input type="number" id="dtCRpm" value="${p.rpm}" step="100" ${p.link_global!==false?'disabled':''}></div></div>
          <div class="field"><div class="field-row"><label>배기량 Vd [cc/rev]</label><input type="number" id="dtCVd" value="${p.vd_cc}" step="5"></div></div>
          <div class="sec-hdr">효율맵 2D CSV (PR, RPM, eff)</div>
          <div class="sub-tabs" id="dtCCsvTabs"><button class="sub-btn ${tabKey==='is'?'active':''}" data-t="is">η_is</button><button class="sub-btn ${tabKey==='vol'?'active':''}" data-t="vol">η_v</button><button class="sub-btn ${tabKey==='mech'?'active':''}" data-t="mech">η_m</button></div>
          <textarea id="dtCCsv">${p["csv_" + tabKey]}</textarea><button class="primary sm" id="dtCApplyCsv" style="width:100%;margin-top:4px;">효율맵 적용</button>
        </div></div>
        <div>
          <div class="card" style="height:355px;display:flex;flex-direction:column;"><h2>압축기 내부 구조 &amp; 회전 애니메이션</h2><div id="dtCutawayWrap" style="flex:1;min-height:0;">${buildCompressorCutawaySVG(node, simConfig)}</div></div>
          <div class="kpi-grid">${buildKpiByNode(node)}</div>
        </div>
      </div>`;
      const fSel = q("#dtFluidNode"); if (fSel) fSel.onchange = e => { p.fluidNodeId = e.target.value; onParamChange(true); };
      const gSel = q("#dtSigNode"); if (gSel) gSel.onchange = e => { p.sigNodeId = e.target.value; onParamChange(true); };
      q("#dtCLink").onchange = e => { p.link_global = e.target.checked; onParamChange(true); };
      ["#dtCP1:P1_bar","#dtCP2:P2_bar","#dtCT1:T1_C","#dtCRpm:rpm","#dtCVd:vd_cc"].forEach(s => { const [id, k] = s.split(":"); q(id).oninput = e => { p[k] = +e.target.value; onParamChange(false); }; });
      container.querySelectorAll("#dtCCsvTabs .sub-btn").forEach(b => b.onclick = () => { p._csvTab = b.dataset.t; onFluidAction("refreshTab", node); });
      q("#dtCApplyCsv").onclick = () => { p["csv_" + tabKey] = q("#dtCCsv").value; onParamChange(true); };
      return;
    }

    // 5) 핀-플레이트 / 판형 열교환기 상세 탭
    if (global.SolverModule.isHxType(node.type)) {
      const p = node.params;
      const isPlate = node.type === "hx_plate" || p.hxType === "plate";
      const finType = p.fin_type || "louver";
      const condCorr = p.ref_cond_corr || "shah_cond";
      const evapCorr = p.ref_evap_corr || "yan_lin";
      const secPheCorr = p.sec_phe_corr || "muley_manglik";
      const fans = nodes.filter(x => x.type === "fan");

      const corrSectionHTML = isPlate ? `
        <div class="sec-hdr">판형(PHX) 열전달 상관식 &amp; 보정계수</div>
        <div class="field"><div class="field-row"><label>냉매 증발 상관식 ${helpBtnHTML(evapCorr)}</label><select id="dtHEvapCorr" style="width:155px;"><option value="yan_lin" ${evapCorr==='yan_lin'?'selected':''}>Yan &amp; Lin (1999)</option><option value="han_lee_kim" ${evapCorr==='han_lee_kim'?'selected':''}>Han-Lee-Kim (2003)</option><option value="hsieh_lin" ${evapCorr==='hsieh_lin'?'selected':''}>Hsieh &amp; Lin (2002)</option><option value="dittus" ${evapCorr==='dittus'?'selected':''}>Dittus-Boelter</option></select></div></div>
        <div class="field"><div class="field-row"><label>냉매 응축 상관식 ${helpBtnHTML(condCorr)}</label><select id="dtHCondCorr" style="width:155px;"><option value="shah_cond" ${condCorr==='shah_cond'?'selected':''}>Shah 응축 상관식</option><option value="cavallini" ${condCorr==='cavallini'?'selected':''}>Cavallini-Zecchin</option><option value="dittus" ${condCorr==='dittus'?'selected':''}>Dittus-Boelter</option></select></div></div>
        <div class="field"><div class="field-row"><label>상대측(단상) 상관식 ${helpBtnHTML(secPheCorr)}</label><select id="dtHSecCorr" style="width:155px;"><option value="muley_manglik" ${secPheCorr==='muley_manglik'?'selected':''}>Muley-Manglik (1999)</option><option value="martin" ${secPheCorr==='martin'?'selected':''}>Martin Lévêque (1996)</option></select></div></div>
        <div class="field"><div class="field-row"><label>보정계수 C_ref / C_sec</label><div style="display:flex;gap:4px;"><input type="number" id="dtHCref" value="${p.ref_corr_C ?? 1.0}" step="0.05" style="width:54px;"><input type="number" id="dtHCsec" value="${p.sec_corr_C ?? 1.0}" step="0.05" style="width:54px;"></div></div></div>`
      : `
        <div class="sec-hdr">핀-플레이트 상관식 (공기측 · 냉매측)</div>
        <div class="field"><div class="field-row"><label>핀 형상 &amp; 공기측 식 ${helpBtnHTML(finType==='flat'?'wang_flat':'chen_louver')}</label><select id="dtHFinType" style="width:155px;"><option value="louver" ${finType==='louver'?'selected':''}>루버 핀 (Chen/Chang-Wang)</option><option value="flat" ${finType==='flat'?'selected':''}>플랫 핀 (Wang-Chi)</option></select></div></div>
        ${finType === "louver" ? `<div class="field"><div class="field-row"><label>루버 피치 Lp [mm] / 각도 θ [°]</label><div style="display:flex;gap:4px;"><input type="number" id="dtHLp" value="${p.louver_pitch_mm ?? 1.2}" step="0.1" style="width:54px;"><input type="number" id="dtHLa" value="${p.louver_angle_deg ?? 27}" step="1" style="width:54px;"></div></div></div>` : ""}
        <div class="field"><div class="field-row"><label>공기측 j-계수 C_j</label><input type="number" id="dtHCj" value="${p.fin_Cj ?? (finType==='flat'?0.145:0.267)}" step="0.01"></div></div>
        <div class="field"><div class="field-row"><label>냉매 응축 상관식 ${helpBtnHTML(condCorr)}</label><select id="dtHCondCorr" style="width:155px;"><option value="shah_cond" ${condCorr==='shah_cond'?'selected':''}>Shah 응축 상관식</option><option value="cavallini" ${condCorr==='cavallini'?'selected':''}>Cavallini-Zecchin</option><option value="dittus" ${condCorr==='dittus'?'selected':''}>Dittus-Boelter</option></select></div></div>
        <div class="field"><div class="field-row"><label>냉매측 보정계수 C_ref</label><input type="number" id="dtHCref" value="${p.ref_corr_C ?? 1.0}" step="0.05"></div></div>`;

      container.innerHTML = `<div class="single-layout">
        <div>
          <div class="card">
            <h2>🌡️ ${node.modelName} (${isPlate ? "판형 PHX" : "핀-플레이트"})</h2>
            ${fluidSelectHTML(node)}
            <div class="field"><div class="field-row"><label>열전달 모델</label><select id="dtHMethod" style="width:170px;">
              <option value="GEO" ${p.method==='GEO'?'selected':''}>지오메트리 + 상관식 (6-Zone)</option>
              <option value="UA" ${p.method==='UA'?'selected':''}>UA 직접 입력</option>
              <option value="NTU" ${p.method==='NTU'?'selected':''}>NTU 직접 입력</option>
            </select></div></div>
            ${corrSectionHTML}
            <div class="sec-hdr">상대측 유체 &amp; 열원 조건</div>
            <div class="field"><div class="field-row"><label>상대측 유체</label><select id="dtHSecF"><option value="Air" ${p.sec_fluid==='Air'?'selected':''}>Air</option><option value="Water" ${p.sec_fluid==='Water'?'selected':''}>Water</option><option value="GW" ${p.sec_fluid==='GW'?'selected':''}>GW (50%)</option></select></div></div>
            <div class="field"><div class="field-row"><label>열원 모드</label><select id="dtHSecM"><option value="fluid_temp" ${p.sec_mode!=='const_Q'?'selected':''}>유체 온도·유량</option><option value="const_Q" ${p.sec_mode==='const_Q'?'selected':''}>고정 열부하 Q (신호 입력)</option></select></div></div>
            ${p.sec_mode === "const_Q"
              ? `${sigSelectHTML(node, "열부하 Q [kW] 신호 소스")}<div style="font-size:11px;color:var(--warn);margin-bottom:6px;">※ 고정 열부하 모드는 캔버스에서 신호 컴포넌트(상수/계단/시나리오)를 선으로 직접 연결해야 실행됩니다.</div>`
              : `${!isPlate ? `<div class="field"><div class="field-row"><label>공기측 부착 팬(Fan)</label><b style="color:#0891b2;font-size:11.5px;">${(() => { const fn = global.SolverModule.findConnectedFan(node, nodes, edges); return fn ? `🌀 ${fn.modelName} (포트 직결됨)` : "⚠️ 미연결 (상/하 공기포트에 팬 연결 필수)"; })()}</b></div></div>` : ""}
                 <label class="chk-line"><input type="checkbox" id="dtHAmb" ${p.link_ambient?'checked':''}/> 전역 외기온도 연동 (${simConfig.T_amb_C}°C)</label>
                 <div class="field"><div class="field-row"><label>상대측 입구온도 [°C]</label><input type="number" id="dtHTsec" value="${p.T_sec_in}" step="0.5" ${p.link_ambient?'disabled':''}></div></div>
                 <div class="field"><div class="field-row"><label>수동 상대측 유량 [kg/s]</label><input type="number" id="dtHMsec" value="${p.m_sec_kgs}" step="0.05" ${!isPlate?'disabled':''}></div></div>`}
            <div class="sec-hdr">${isPlate ? "판형(PHX) 지오메트리 (W, L, β, p_co, b, Np)" : "핀-플레이트 지오메트리 (코어 W/H/D, 피치 Fp, 두께 ft, Dh)"}</div>
            ${ctx.hxGeoFieldsHTML(p, "dtH")}
            ${ctx.hxMethodFieldsHTML(p, "dtH")}
            <label class="chk-line"><input type="checkbox" id="dtHAutoDP" ${p.auto_dP!==false?'checked':''}/> 모멘텀 기반 ΔP 자동 계산</label>
          </div>
        </div>
        <div>
          <div class="card" style="height:375px;display:flex;flex-direction:column;">
            <h2>${isPlate ? "판형 열교환기(PHX) 정면·적층 지오메트리 도해 &amp; 대향류 애니메이션" : "핀-플레이트 코어·확대 지오메트리 도해 &amp; 6-세그먼트 온도장 애니메이션"}</h2>
            <div id="dtCutawayWrap" style="flex:1;min-height:0;">${isPlate ? buildPlateHxCutawaySVG(node) : buildFinPlateCutawaySVG(node)}</div>
          </div>
          <div class="kpi-grid">${buildKpiByNode(node)}</div>
        </div>
      </div>`;
      bindHelpBtns();
      const fSel = q("#dtFluidNode"); if (fSel) fSel.onchange = e => { p.fluidNodeId = e.target.value; onParamChange(true); };
      const gSel = q("#dtSigNode"); if (gSel) gSel.onchange = e => { p.sigNodeId = e.target.value; onParamChange(true); };
      const fnSel = q("#dtHFanNode"); if (fnSel) fnSel.onchange = e => { p.fanNodeId = e.target.value; onParamChange(true); };
      q("#dtHMethod").onchange = e => { p.method = e.target.value; onParamChange(true); };
      const ftEl = q("#dtHFinType"); if (ftEl) ftEl.onchange = e => { p.fin_type = e.target.value; p.fin_Cj = e.target.value === "flat" ? 0.145 : 0.267; onParamChange(true); };
      const evEl = q("#dtHEvapCorr"); if (evEl) evEl.onchange = e => { p.ref_evap_corr = e.target.value; onParamChange(true); };
      const cdEl = q("#dtHCondCorr"); if (cdEl) cdEl.onchange = e => { p.ref_cond_corr = e.target.value; onParamChange(true); };
      const scEl = q("#dtHSecCorr"); if (scEl) scEl.onchange = e => { p.sec_phe_corr = e.target.value; onParamChange(true); };
      ["#dtHLp:louver_pitch_mm","#dtHLa:louver_angle_deg","#dtHCj:fin_Cj","#dtHCref:ref_corr_C","#dtHCsec:sec_corr_C","#dtHTsec:T_sec_in"].forEach(s => {
        const [id, k] = s.split(":"), el = q(id);
        if (el) el.oninput = e => { p[k] = +e.target.value; onParamChange(false); };
      });
      q("#dtHSecF").onchange = e => { p.sec_fluid = e.target.value; onParamChange(true); };
      q("#dtHSecM").onchange = e => { p.sec_mode = e.target.value; onParamChange(true); };
      const ambEl = q("#dtHAmb"); if (ambEl) ambEl.onchange = e => { p.link_ambient = e.target.checked; onParamChange(true); };
      q("#dtHAutoDP").onchange = e => { p.auto_dP = e.target.checked; onParamChange(true); };
      const msEl = q("#dtHMsec"); if (msEl) msEl.oninput = e => { const v = +e.target.value; p.m_sec_kgs = v; p.m_sec_ref = v; onParamChange(false); };
      ctx.bindHxGeoAndMethodInputs(p, "dtH", () => onParamChange(false), container);
      return;
    }

    // 6) 어큐뮬레이터 / 리시버 상세 탭
    if (node.type === "receiver") {
      const p = node.params;
      const D_mm = Math.max(20, Number(p.diam_mm) || 90), H_mm = Math.max(40, Number(p.height_mm) || 200);
      const vol_L = (Math.PI * D_mm * D_mm / 4 * H_mm) / 1e6;
      container.innerHTML = `<div class="single-layout">
        <div><div class="card"><h2>🛢️ ${node.modelName} — 상세 모델링</h2>${fluidSelectHTML(node)}
          <div class="field"><div class="field-row"><label>탱크 종류</label><select id="dtRType"><option value="suction" ${p.rec_type!=='high_pressure'?'selected':''}>저압 어큐뮬레이터 (기본)</option><option value="high_pressure" ${p.rec_type==='high_pressure'?'selected':''}>고압 액 리시버</option></select></div></div>
          <div class="sec-hdr">탱크 치수 (지름 · 높이 → 체적 자동 계산)</div>
          <div class="field"><div class="field-row"><label>내부 지름 D [mm]</label><input type="number" id="dtRDiam" value="${D_mm}" step="5" min="30" max="200"></div><input type="range" id="dtRDiamRng" min="30" max="200" step="5" value="${D_mm}" style="width:100%;"></div>
          <div class="field"><div class="field-row"><label>내부 높이 H [mm]</label><input type="number" id="dtRHeight" value="${H_mm}" step="10" min="80" max="400"></div><input type="range" id="dtRHeightRng" min="80" max="400" step="10" value="${H_mm}" style="width:100%;"></div>
          <div class="field"><div class="field-row"><label>자동 계산 내부 체적 V</label><b id="dtRVolDisp" style="color:var(--accent);">${vol_L.toFixed(3)} L</b></div></div>
          <div class="field"><div class="field-row"><label>최소 압력강하 ΔP [bar]</label><input type="number" id="dtRDP" value="${p.dP_bar ?? 0.03}" step="0.01" min="0"></div></div>
          <div class="field"><div class="field-row"><label>열손실 Q_loss [kW]</label><input type="number" id="dtRQ" value="${p.Q_loss_kW||0}" step="0.05"></div></div>
        </div></div>
        <div>
          <div class="card" style="height:365px;display:flex;flex-direction:column;"><h2>탱크 내부 단면 &amp; 치수·액위 실시간 애니메이션</h2><div id="dtCutawayWrap" style="flex:1;min-height:0;">${buildReceiverCutawaySVG(node)}</div></div>
          <div class="kpi-grid">${buildKpiByNode(node)}</div>
        </div>
      </div>`;
      const fSel = q("#dtFluidNode"); if (fSel) fSel.onchange = e => { p.fluidNodeId = e.target.value; onParamChange(true); };
      q("#dtRType").onchange = e => { p.rec_type = e.target.value; onParamChange(true); };
      const updVol = () => { const vEl = q("#dtRVolDisp"); if (vEl) vEl.textContent = ((Math.PI * (p.diam_mm||90) * (p.diam_mm||90) / 4 * (p.height_mm||200)) / 1e6).toFixed(3) + " L"; };
      const bindP = (nSel, rSel, k) => {
        const ne = q(nSel), re = q(rSel);
        if (ne) ne.oninput = e => { p[k] = +e.target.value; if (re) re.value = p[k]; updVol(); onParamChange(false); };
        if (re) re.oninput = e => { p[k] = +e.target.value; if (ne) ne.value = p[k]; updVol(); onParamChange(false); };
      };
      bindP("#dtRDiam", "#dtRDiamRng", "diam_mm");
      bindP("#dtRHeight", "#dtRHeightRng", "height_mm");
      q("#dtRDP").oninput = e => { p.dP_bar = +e.target.value || 0; onParamChange(false); };
      q("#dtRQ").oninput = e => { p.Q_loss_kW = +e.target.value || 0; onParamChange(false); };
      return;
    }

      // 7) 팬(Fan) 상세 탭 (팬/펌프 성능곡선 CSV 필수 입력 + 상사법칙 + 시스템 저항 교차점)
    if (node.type === "fan") {
      const p = node.params;
      const airEdge = (edges || []).find(e => (e.from === node.id || e.to === node.id) && e.kind === "air");
      const linkedHx = airEdge ? nodes.find(h => (h.id === airEdge.from || h.id === airEdge.to) && global.SolverModule.isHxType(h.type)) : null;
      container.innerHTML = `<div class="single-layout">
        <div><div class="card"><h2>🌀 ${node.modelName} — 팬/펌프 성능곡선 모델링 ${helpBtnHTML("fan_curve")}</h2>
          ${sigSelectHTML(node, "팬 RPM 신호 컴포넌트")}
          <div class="field"><div class="field-row"><label>직결된 핀-플레이트 HX</label><b style="color:#0891b2;font-size:11.5px;">${linkedHx ? `🌡️ ${linkedHx.modelName} (선 연결됨)` : "⚠️ 미연결 (캔버스에서 핀-플레이트 공기포트에 연결 필수)"}</b></div></div>
          <label class="chk-line"><input type="checkbox" id="dtFLink" ${p.link_global!==false?'checked':''}/> 전역 팬 RPM 연동 (${simConfig.fan_rpm} RPM)</label>
          <div class="field"><div class="field-row"><label>운전 회전수 [RPM]</label><input type="number" id="dtFRpm" value="${p.rpm || 1800}" step="100" ${p.link_global!==false?'disabled':''}></div></div>
          <div class="field"><div class="field-row"><label>성능곡선 기준 회전수 N_ref [RPM]</label><input type="number" id="dtFRefRpm" value="${p.rpm_ref || 1800}" step="100"></div></div>
          <div class="sec-hdr">팬 성능곡선 P-Q CSV (필수: Q[m³/min], ΔP[Pa], η)</div>
          <textarea id="dtFCsv" style="height:135px;">${p.curve_csv || global.FanModule.DEFAULT_FAN_CSV}</textarea>
          <button class="primary sm" id="dtFApplyCsv" style="width:100%;margin-top:4px;">팬 성능곡선 적용</button>
          <div id="dtFStatus" style="font-size:11px;color:var(--green);margin-top:4px;">유효한 팬 성능곡선이 입력되어 있습니다.</div>
        </div></div>
        <div>
          <div class="card" style="height:365px;display:flex;flex-direction:column;"><h2>팬 블레이드 &amp; P-Q 성능곡선 교차 운전점</h2><div id="dtCutawayWrap" style="flex:1;min-height:0;">${buildFanCutawaySVG(node, simConfig)}</div></div>
          <div class="kpi-grid">${buildKpiByNode(node)}</div>
        </div>
      </div>`;
      bindHelpBtns();
      q("#dtFLink").onchange = e => { p.link_global = e.target.checked; onParamChange(true); };
      q("#dtFRpm").oninput = e => { p.rpm = +e.target.value || 1800; onParamChange(false); };
      q("#dtFRefRpm").oninput = e => { p.rpm_ref = +e.target.value || 1800; onParamChange(false); };
      q("#dtFApplyCsv").onclick = () => {
        p.curve_csv = q("#dtFCsv").value;
        try {
          global.FanModule.parseFanCurveCSV(p.curve_csv);
          q("#dtFStatus").style.color = "var(--green)";
          q("#dtFStatus").textContent = "팬 성능곡선 파싱 및 운전점 갱신 완료!";
          onParamChange(false);
        } catch (err) {
          q("#dtFStatus").style.color = "var(--danger)";
          q("#dtFStatus").textContent = err.message;
        }
      };
      return;
    }

    // 8) 센서 상세 탭
    if (global.SolverModule.isSensorType(node.type)) {
      const p = node.params, res = node.result;
      const flowNodes = nodes.filter(x => global.SolverModule.isFlowNode(x.type));
      const flowEdges = (edges || []).filter(e => e.kind !== "signal");
      const edgeLabel = e => { const a = nodes.find(x => x.id === e.from), b = nodes.find(x => x.id === e.to); return `${a ? a.modelName : e.from} → ${b ? b.modelName : e.to}`; };
      container.innerHTML = `<div class="single-layout">
        <div><div class="card"><h2>📡 ${node.modelName} — 센서 계측 설정</h2>
          <div class="field"><div class="field-row"><label>측정 대상 배관</label><select id="dtSMedge" style="width:185px;"><option value="">(직접 선택 안함)</option>${flowEdges.map(e => `<option value="${e.id}" ${p.measureEdgeId===e.id?'selected':''}>${edgeLabel(e)}</option>`).join("")}</select></div></div>
          <div class="field"><div class="field-row"><label>또는 측정 컴포넌트 출구</label><select id="dtSMnode" style="width:185px;"><option value="">(없음)</option>${flowNodes.map(n => `<option value="${n.id}" ${p.measureNodeId===n.id?'selected':''}>${n.modelName} 출구</option>`).join("")}</select></div></div>
        </div></div>
        <div>
          <div class="card" style="height:330px;display:flex;flex-direction:column;"><h2>실시간 계측 계기판</h2><div id="dtCutawayWrap" style="flex:1;min-height:0;">${buildSensorCutawaySVG(node)}</div></div>
          <div class="kpi-grid">
            <div class="kpi"><div class="lbl">압력 P</div><div class="val" style="color:var(--accent)">${res&&res.connected ? res.P_bar.toFixed(2)+' bar' : '-'}</div></div>
            <div class="kpi"><div class="lbl">온도 T</div><div class="val" style="color:var(--hot)">${res&&res.connected ? res.T_C.toFixed(1)+' °C' : '-'}</div></div>
            <div class="kpi"><div class="lbl">포화온도 T_sat</div><div class="val" style="color:var(--muted)">${res&&res.connected ? res.T_sat_C.toFixed(1)+' °C' : '-'}</div></div>
            <div class="kpi"><div class="lbl">과열도 SH</div><div class="val" style="color:var(--green)">${res&&res.connected ? res.SH.toFixed(2)+' K' : '-'}</div></div>
          </div>
        </div>
      </div>`;
      q("#dtSMedge").onchange = e => { p.measureEdgeId = e.target.value; onParamChange(true); };
      q("#dtSMnode").onchange = e => { p.measureNodeId = e.target.value; onParamChange(true); };
    }
  }

  global.ComponentViewsModule = { tempToCFDColor, buildCutawayByNode, buildKpiByNode, renderComponentDetailTab };
})(window);
