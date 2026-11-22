// correlations_doc.js — 열교환기·팽창밸브 상관식 상세 기술 문서 (? 도움말 모달용)
(function (global) {
  const CORR_DOCS = {
    chen_louver: {
      title: "Chang-Wang / Chen 루버 핀 (Louver Fin) 공기측 상관식",
      category: "핀-플레이트 열교환기 — 공기측 (외부)",
      mechanism: "루버(Louver) 절개면마다 열·속도 경계층이 주기적으로 초기화(Boundary-layer restart)되어, 동일 풍속에서 평판 핀 대비 대류 열전달계수(h_air)가 1.5~2.5배 향상됩니다. 루버 피치(Lp)가 좁고 루버 각도(θ)가 적절할수록(20~30°) 경계층 얇아짐 효과가 극대화되지만, 동시에 마찰 압력강하(f)도 증가합니다.",
      formula: "Re_Lp = G_air · L_p / μ_air\nj = C_j · Re_Lp^(-0.49) · (θ/90)^0.27 · (F_p/L_p)^(-0.14) · (F_h/L_p)^(-0.29) · (F_d/L_p)^(-0.23)\nh_bare = j · G_air · Cp_air / Pr^(2/3),   h_eff = η_o · h_bare",
      params: [
        "루버 피치 Lp [mm]: 루버 날개 간격 (일반적 0.9 ~ 1.7 mm)",
        "루버 각도 θ [°]: 루버 꺾임 각도 (일반적 22° ~ 30°)",
        "보정계수 C_j: 실험 보정 계수 (기본 0.267, Chang-Wang 기준)",
        "핀 효율 η_f = tanh(mL)/(mL), 표면효율 η_o = 1 - (A_f/A_tot)(1 - η_f)"
      ],
      implementation: "전면 유속에서 최소 자유단면적 기준 질량유속 G_air를 계산하고, CoolProp 공기 물성치(μ, k, Cp, Pr)로 루버 피치 기준 레이놀즈수 Re_Lp를 구합니다. 산출된 j-인자로 h_bare를 얻은 뒤 알루미늄 핀(k=205 W/m·K)의 핀 효율 η_f와 표면 효율 η_o를 곱해 최종 공기측 열전달계수를 적용합니다. 압력강하는 Chang-Wang f-인자 상관식으로 계산됩니다."
    },
    wang_flat: {
      title: "Wang-Chi 플랫 핀 (Plain / Flat Fin) 공기측 상관식",
      category: "핀-플레이트 열교환기 — 공기측 (외부)",
      mechanism: "절개(루버) 없이 평탄한 핀 판 사이를 공기가 통과하는 유동입니다. 입구에서 발달한 경계층이 코어 깊이(D)를 따라 계속 두꺼워지므로 루버 핀보다 열전달계수는 낮으나, 공기측 압력강하와 착상(Frosting)·오염 저항성이 우수하여 저온 증발기나 오염 환경에 유리합니다.",
      formula: "Re_Dh = G_air · D_h,air / μ_air\nj = C_j · Re_Dh^(-0.38) · (F_p / D_h,air)^(-0.12)\nh_bare = j · G_air · Cp_air / Pr^(2/3),   h_eff = η_o · h_bare",
      params: [
        "핀 피치 Fp [mm] & 두께 ft [mm]: 공기 통로 수력직경 D_h,air 결정",
        "보정계수 C_j: 평판 핀 기준 기본값 0.145"
      ],
      implementation: "핀 간격과 핀 높이로 공기 유로 수력직경 D_h,air를 산출하고, CoolProp 공기 물성치로 Re_Dh 및 Pr을 구해 Colburn j-인자와 핀 효율 η_o를 적용합니다."
    },
    shah_cond: {
      title: "Shah (1979 / 2009) 관내 2상 응축 열전달 상관식",
      category: "열교환기 — 냉매측 응축 (2상)",
      mechanism: "응축기 내부에서 고온 증기가 벽면에서 액막(Liquid film)을 형성하며 응축할 때, 증기 전단력(Shear-driven annular flow)과 중력(Stratified flow)이 복합 작용합니다. Shah 상관식은 전액 단상 대류 열전달계수(h_LO, Dittus-Boelter)에 건도(x)와 환산압력(P_r = P / P_crit)의 무차원 증진 인자를 곱해 2상 응축 열전달을 매우 정확히 예측합니다.",
      formula: "h_LO = 0.023 · Re_LO^0.8 · Pr_l^0.4 · (k_l / D_h)\nP_r = P / P_crit\nh_TP(x) = C_shah · h_LO · [ (1 - x)^0.8 + (3.8 · x^0.76 · (1 - x)^0.04) / P_r^0.38 ]",
      params: [
        "임계압력 P_crit [bar]: R134a=40.59, R32=57.82, Water=220.64 (자동 인식)",
        "보정계수 C_shah: 기본 1.0 (마이크로채널/내면그루브 보정 시 조정 가능)"
      ],
      implementation: "열교환기를 냉매 흐름 방향으로 6개 세그먼트로 이산화(Discretization)하여, 각 세그먼트의 국소 건도 x_i를 구합니다. 2상 구간(0 < x < 1)에서는 포화액 물성치(μ_f, k_f, Cp_f)로 h_LO를 계산한 뒤 Shah 식을 국소 적용하고, 과열증기·과냉액 구간에서는 단상 Dittus-Boelter 식을 자동 전환 적용합니다."
    },
    cavallini: {
      title: "Cavallini-Zecchin 관내 응축 상관식",
      category: "열교환기 — 냉매측 응축 (2상)",
      mechanism: "고속 환상류(Annular flow) 응축 영역에서 기-액 밀도비(ρ_l/ρ_v)로 정의되는 등가 질량유속(Equivalent Reynolds number Re_eq)을 사용해 계면 전단력에 의한 액막 박막화 효과를 모델링합니다.",
      formula: "Re_eq = Re_l + Re_v · (μ_v/μ_l) · (ρ_l/ρ_v)^0.5\nNu_TP = 0.05 · Re_eq^0.8 · Pr_l^0.33",
      params: [
        "보정계수 C_corr: 기본 0.05 (고속 환상류 응축 기준)"
      ],
      implementation: "각 세그먼트에서 국소 건도 x와 포화 액/증기 물성치(ρ_f, ρ_g, μ_f, μ_g)로 등가 레이놀즈수 Re_eq를 계산하여 국소 응축 열전달계수를 산출합니다."
    },
    yan_lin: {
      title: "Yan & Lin (1999) 판형 열교환기(PHX) 증발 상관식",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "브레이징 판형 열교환기(BPHE)의 좁은 주름(Chevron) 채널 내에서 일어나는 유동 비등(Flow Boiling)은 핵비등(Nucleate boiling, 열유속 q'' 지배)과 강제대류 비등(Convective boiling, 질량유속 G 지배)이 강하게 결합됩니다. Yan & Lin 상관식은 등가 레이놀즈수(Re_eq)와 등가 비등수(Bo_eq)로 이 두 메커니즘을 동시에 반영하는 가장 널리 쓰이는 PHX 증발 상관식입니다.",
      formula: "G_eq = G · [ (1 - x) + x · (ρ_l / ρ_v)^0.5 ]\nRe_eq = G_eq · D_h / μ_l,   Bo_eq = q'' / (G_eq · h_fg)\nNu = C_yl · Re_eq^0.5 · Pr_l^(1/3) · Bo_eq^0.3",
      params: [
        "상관계수 C_yl: 기본 1.926 (Yan & Lin 원논문 기준, R134a BPHE)",
        "수력직경 D_h = 2·b (주름 깊이 b의 2배), 열유속 q'' = Q / A_eff"
      ],
      implementation: "판형 지오메트리(W, L, b, Np)에서 유로단면적과 전열면적 A_eff를 구하고, 각 세그먼트의 국소 건도 x와 열유속 q''로부터 G_eq, Re_eq, Bo_eq를 산출해 국소 증발 열전달계수 h_ref를 계산합니다."
    },
    han_lee_kim: {
      title: "Han, Lee & Kim (2003) 쉐브론 각도 반영 PHX 증발 상관식",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "판형 열교환기의 쉐브론 각도(β)와 주름 피치/수력직경 비(p_co/D_h)가 유동 난류 강도와 기포 이탈(Bubble departure)에 미치는 기하학적 영향을 무차원 형상계수 Ge1, Ge2로 명시적으로 분리한 대표 상관식입니다. R410A, R22, R32, R134a 등 다양한 냉매에 적용성이 높습니다.",
      formula: "Ge1 = 2.81 · (p_co/D_h)^(-0.041) · (π/2 - β)^(-2.83)\nGe2 = 0.746 · (p_co/D_h)^(-0.082) · (π/2 - β)^0.61\nNu = C_hlk · Ge1 · Re_eq^Ge2 · Bo_eq^0.3 · Pr_l^0.4",
      params: [
        "쉐브론 각도 β [°]: 클수록(60°~70°) 난류·열전달 증가 및 ΔP 증가",
        "주름 피치 p_co [mm]: 기본 7.0 mm",
        "보정계수 C_hlk: 기본 1.0"
      ],
      implementation: "지오메트리의 쉐브론 각도 β(라디안 변환)와 주름 피치로 Ge1, Ge2를 계산하고, 각 세그먼트의 Re_eq 및 Bo_eq에 결합하여 국소 h_ref를 산출합니다."
    },
    hsieh_lin: {
      title: "Hsieh & Lin (2002) PHX 핵비등 지배 증발 상관식",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "비교적 낮은 질량유속 및 중·고 열유속 조건의 판형 증발기에서는 대류 비등보다 벽면 기포 생성에 의한 핵비등(Nucleate Boiling)이 지배적입니다. 단상 액체 열전달계수(h_l)에 비등수 Bo의 0.5제곱 항을 곱해 간결하면서도 직관적으로 예측합니다.",
      formula: "h_l = 0.2092 · (k_l / D_h) · Re_l^0.78 · Pr_l^(1/3)\nBo = q'' / (G · h_fg)\nh_TP = C_hl · h_l · 88 · Bo^0.5",
      params: [
        "보정계수 C_hl: 기본 1.0 (상수 88 기준)"
      ],
      implementation: "포화액 물성치로 단상 기준 열전달계수 h_l을 구한 뒤, 열유속 q''과 증발잠열 h_fg로부터 비등수 Bo를 계산해 증발 열전달계수를 도출합니다."
    },
    muley_manglik: {
      title: "Muley & Manglik (1999) 판형 단상 열전달 상관식",
      category: "판형 열교환기 (PHX) — 상대측 (Water / GW)",
      mechanism: "브레이징·가스켓 판형 열교환기의 단상 액체(물, 글리콜수) 채널에서 쉐브론 각도(β)와 주름 면적 확장계수(Φ)가 만드는 3차원 나선형 와류(Swirl flow)의 열전달 촉진 효과를 예측합니다.",
      formula: "Nu = [0.2668 - 0.006967·β + 7.244e-5·β²] · [20.78 - 50.94·Φ + 41.16·Φ² - 10.51·Φ³] · Re^(0.728 + 0.0543·sin(2πβ/90 + 3.7)) · Pr^(1/3)",
      params: [
        "쉐브론 각도 β [°]: 30° ~ 60° 범위에서 가장 정확",
        "면적 확장계수 Φ: 실제 주름면적 / 투영면적 (기본 1.17)"
      ],
      implementation: "상대측 유체(CoolProp Water/GW/Air)의 국소 물성치와 채널 유속으로 Re, Pr을 산출하고 β, Φ 다항식에 대입해 h_sec를 구합니다."
    },
    martin: {
      title: "Martin (1996) 일반화 Lévêque 판형 상관식",
      category: "판형 열교환기 (PHX) — 상대측 (Water / GW)",
      mechanism: "주름진 판 사이의 유동을 '교차(Crossing) 유동'과 '주름 방향(Furrow) 유동'의 조합으로 해석하여, 마찰계수(f)와 열전달(Nu) 사이의 일반화된 Lévêque 상사(Analogy)로 광범위한 Re 영역(층류~난류)을 매끄럽게 연결합니다.",
      formula: "Nu = 0.205 · Pr^(1/3) · (f · Re² · sin(2β))^0.374",
      params: [
        "쉐브론 각도 β [°] 및 마찰계수 f(Re, β) 자동 결합"
      ],
      implementation: "쉐브론 각도와 Re로부터 Martin의 마찰계수 f를 먼저 구하고, Lévêque 관계식으로 h_sec 및 상대측 압력강하 ΔP_sec를 동시에 일관되게 계산합니다."
    },
    dittus: {
      title: "Dittus-Boelter (단상 난류 강제대류 상관식)",
      category: "범용 단상 관내 열전달",
      mechanism: "원관 또는 덕트 내부의 완전 발달 난류 강제대류(Re > 10,000)에 대한 고전적 상관식입니다. 가열(증발) 시 Pr 지수 n=0.4, 냉각(응축) 시 n=0.3을 사용합니다.",
      formula: "Nu = C · Re^m · Pr^n   (기본 C=0.023, m=0.8, n=0.4/0.3)",
      params: [
        "계수 C (기본 0.023), 지수 m (0.8), 지수 n (0.4)"
      ],
      implementation: "수력직경 D_h와 냉매 물성치(μ, k, Cp)로 Re, Pr을 계산해 적용합니다."
    },
    txv_sh: {
      title: "TXV / EEV 과열도 피드백 + 오리피스 유량 상관식",
      category: "팽창밸브 — 센서 연동 자동 제어",
      mechanism: "증발기 출구~압축기 입구 배관에 부착된 감온통/센서(P, T)로부터 흡입 과열도(SH = T_meas - T_sat(P_meas))를 실시간 계측합니다. 계측 과열도가 목표 과열도(SH_target)보다 크면 밸브 개도를 열어 냉매 유량을 늘리고, 작으면 닫아 액압축을 방지합니다.",
      formula: "Opening [%] = clamp(Open_0 + K_p · (SH_meas - SH_target), 5, 100)\nA_eff = (π/4 · D_orifice²) · (Opening / 100)\nΔP = (m_dot / (Cd · A_eff))² / (2 · ρ_in)",
      params: [
        "오리피스 지름 D [mm]: 밸브 시트 내경 (최대 면적 A_max = πD²/4 자동 계산)",
        "목표 과열도 SH_target [K]: TXV/EEV 설정 과열도 (기본 6.0 K)",
        "비례 게인 K_p [%/K]: 과열도 편차 1K당 개도 변화율 (기본 6.0 %/K)",
        "유량계수 Cd: 오리피스 수축/마찰 계수 (기본 0.65)"
      ],
      implementation: "솔버 반복 중 센서가 측정한 흡입 과열도 SH_meas로 개도율을 갱신하고, 오리피스 모멘텀 방정식으로 밸브 압력강하 ΔP와 출구 압력 P_out을 계산한 뒤 등엔탈피(h_out = h_in) 팽창 상태를 CoolProp 테이블에서 평가합니다."
    },
    orifice: {
      title: "고정 개도 오리피스 모멘텀 유량 상관식",
      category: "팽창밸브 — 수동 개도 / 모세관·고정오리피스",
      mechanism: "밸브 개도율과 오리피스 지름(D)이 고정된 상태에서 베르누이-오리피스 모멘텀 방정식에 따라 질량유량과 입구 밀도로부터 압력강하 ΔP가 물리적으로 결정됩니다.",
      formula: "A_max = π/4 · D²,   A_eff = A_max · (Opening / 100)\nm_dot = Cd_eff · A_eff · √(2 · ρ_in · ΔP)",
      params: [
        "오리피스 지름 D [mm], 개도율 [%], 기준 유량계수 Cd_0"
      ],
      implementation: "압축기가 공급하는 질량유량 m_dot과 밸브 입구 밀도 ρ_in을 대입하여 ΔP를 직접 풀고, P_out = P_in - ΔP에서 등엔탈피 팽창 상태를 계산합니다."
    },
    re_diam_cd: {
      title: "지름(D)·레이놀즈수(Re)·과냉도 연동 가변 유량계수 Cd 상관식",
      category: "팽창밸브 — 오리피스 유량계수 상관식",
      mechanism: "실제 팽창밸브 오리피스에서 유량계수(Cd)는 상수가 아니라 오리피스 지름(D)에 따른 축류 수축비(Vena-contracta & L/D 효과), 목 레이놀즈수(Re_D)에 따른 점성 경계층 두께, 그리고 입구 과냉도(SC)에 따른 플래시 지연 효과에 의해 연속적으로 변합니다.",
      formula: "Re_D = (ρ_in · v_throat · D) / μ_in\nCd_eff = Cd_0 · (D / D_ref)^0.14 · (1 - 9.5 / √Re_D) · (1 + 0.006 · ΔT_sub)",
      params: [
        "오리피스 지름 D [mm]: 지름 변경 시 Cd_eff가 실시간으로 자동 재계산됨",
        "기준 유량계수 Cd_0: 기준 지름(2.8mm)에서의 공칭 유량계수 (기본 0.65)",
        "입구 과냉도 ΔT_sub [K]: 과냉도가 클수록 오리피스 목 내부 기포 발생이 억제되어 유효 Cd가 증가"
      ],
      implementation: "오리피스 지름 슬라이더나 운전 조건이 바뀔 때마다 Re_D와 과냉도를 평가해 유효 유량계수 Cd_eff를 산출하고 밸브 압력강하 및 개도율 계산에 즉시 반영합니다."
    },
    hem_choked: {
      title: "2상 초크 플로우 (Choked Flow, HEM / Kim-O'Neal) 임계유동 상관식",
      category: "팽창밸브 — 초크 플로우(임계유동) 상관식",
      mechanism: "냉매가 오리피스 목을 통과하며 급격히 감압될 때 포화압력 이하로 떨어지면 플래시 증기(Flash gas)가 발생하며 2상 음속(Two-phase speed of sound)이 급감합니다. 하류 압력(P_out)이 임계 초크 압력(P_choke) 이하로 내려가면 오리피스 목에서 마하수 M=1(초크 플로우)에 도달하여, 하류 압력을 더 낮추어도 유량이 더 이상 증가하지 않고 임계 질량유속(G_crit)으로 고정됩니다.",
      formula: "P_choke = P_sat(T_in) · (0.84 - 0.010 · ΔT_sub) + 0.14 · P_in\nG_crit = Cd_eff · √[ 2 · ρ_in · (P_in - P_choke) ]\nΔP_eff = min(P_in - P_out,  P_in - P_choke)  (P_out ≤ P_choke 시 CHOKED!)",
      params: [
        "임계 초크 압력 P_choke [bar]: 입구 온도의 포화압력 P_sat(T_in) 및 과냉도의 함수로 자동 산출",
        "임계 최대 유량 m_choke_max [kg/s]: 현재 개도에서 통과 가능한 물리적 상한 유량"
      ],
      implementation: "매 반복마다 입구 상태(P_in, T_in, ΔT_sub)로부터 P_choke와 임계 질량유속 G_crit을 계산합니다. P_out ≤ P_choke 조건이 되면 초크 플로우(CHOKED) 경고를 표시하고 유효 구동 압력차를 P_in - P_choke로 제한합니다."
    },
    const_cd: {
      title: "고정 유량계수 (Constant Cd) 단상 베르누이 오리피스 식",
      category: "팽창밸브 — 오리피스 유량계수 상관식",
      mechanism: "지름 변화나 레이놀즈수, 초크 플로우에 따른 보정 없이 사용자가 입력한 상수 Cd를 그대로 사용하는 기본 베르누이 오리피스 식입니다.",
      formula: "m_dot = Cd_0 · A_eff · √(2 · ρ_in · ΔP)",
      params: ["고정 유량계수 Cd_0 (기본 0.65)"],
      implementation: "단순 단상 비압축성 오리피스 공식을 그대로 적용합니다."
    },
    fan_curve: {
      title: "팬/펌프 성능곡선(P-Q Curve) + 상사법칙 & 시스템 저항 교차 해석",
      category: "팬 / 블로워 — 유체기계 운전점 해석",
      mechanism: "팬이나 펌프가 실제 공급하는 풍량(Q)은 임의의 고정값이 아니라, 회전수(RPM)에 따라 상사법칙(Q ∝ N, ΔP ∝ N²)으로 변환된 팬 정압 곡선 ΔP_fan(Q)과 열교환기 핀 코어의 공기측 유동 저항 곡선 ΔP_sys(Q) = K_hx · Q^1.75가 만나는 교차점(Operating Point)에서 물리적으로 결정됩니다.",
      formula: "Q(N) = Q_ref · (N / N_ref),   ΔP_fan(N) = ΔP_ref · (N / N_ref)²\nΔP_fan(Q_op) = ΔP_sys(Q_op) = K_hx · Q_op^1.75\nW_fan = (Q_op · ΔP_op) / η_fan(Q_op)",
      params: [
        "팬 성능곡선 CSV (Q [m³/min], ΔP [Pa], η_fan): 기준 회전수(N_ref)에서의 성능 테이블",
        "팬 회전수 RPM: 직접 입력하거나 신호 컴포넌트(상수/계단/시나리오)에서 입력"
      ],
      implementation: "연결된 핀-플레이트 열교환기의 핀 형상(루버/플랫), 핀 피치, 코어 깊이로부터 시스템 저항 계수 K_hx를 산출하고, 이분법(Bisection)으로 팬 곡선과의 교차 풍량 Q_op 및 공기 질량유량 m_air [kg/s]를 구해 열교환기 상대측 유량으로 자동 전달합니다."
    }
  };

  global.CorrDocsModule = { CORR_DOCS };
})(window);
