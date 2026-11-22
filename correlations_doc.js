// correlations_doc.js — 열교환기·팽창밸브·팬 상관식 상세 기술 문서 (실제 구현 코드와 100% 정합)
(function (global) {
  const CORR_DOCS = {
    chen_louver: {
      title: "Chang & Wang (1997) 8항 루버 핀 j + Chang et al. (2000) f 상관식",
      category: "핀-플레이트 열교환기 — 공기측 (외부)",
      mechanism: "루버(Louver) 절개면마다 열·속도 경계층이 주기적으로 초기화(Boundary-layer restart)되어, 동일 풍속에서 평판 핀 대비 대류 열전달계수(h_air)가 크게 향상됩니다. Chang & Wang(1997)의 8개 무차원 형상항(Lp, θ, Fp, Fh, Fd, Ll, Tp, δf)을 빠짐없이 반영하여 실제 자동차/공조용 루버핀 성능을 정확히 재현합니다.",
      formula: "Re_Lp = G_air · L_p / μ_air\nj = C_tune · Re_Lp^(-0.49) · (θ/90)^0.27 · (F_p/L_p)^(-0.14) · (F_h/L_p)^(-0.29)\n      · (F_d/L_p)^(-0.23) · (L_l/L_p)^0.68 · (T_p/L_p)^(-0.28) · (δ_f/L_p)^(-0.05)\nh_bare = j · G_air · Cp_air / Pr^(2/3),   h_eff = η_o · h_bare\nf_Darcy = 4 · f_Fanning,Chang2000(Re_Lp, θ, F_p, F_h, F_d, L_l, T_p, D_m, D_h)",
      params: [
        "루버 피치 Lp [mm], 루버 각도 θ [°], 루버 길이 Ll [mm], 튜브 피치 Tp [mm]",
        "보정 배수 C_tune: 원논문 기준 기본값 1.0 (기존 축약형 0.267 오류 완전 수정)",
        "핀 효율 η_f = tanh(mL)/(mL), 표면효율 η_o = 1 - (A_f/A_tot)(1 - η_f)",
        "권장 적용범위: 100 ≤ Re_Lp ≤ 3,000 (범위 초과 시 자동 경고)"
      ],
      implementation: "실제 플랫 튜브 폐쇄율 기반 자유단면비로 G_air와 Re_Lp를 구하고, Chang-Wang(1997) 8항 j-인자와 Chang et al.(2000) 마찰계수(Re_Lp=150 구간 연속 블렌딩)로 h_air 및 공기측 ΔP_sec를 계산합니다. 산출된 ΔP_sec(Q)는 팬 P-Q 곡선 교차점 해석에 직접 연결됩니다."
    },
    wang_flat: {
      title: "Wang-Chi 플랫 핀 (Plain / Flat Fin) 공기측 상관식",
      category: "핀-플레이트 열교환기 — 공기측 (외부)",
      mechanism: "절개(루버) 없이 평탄한 핀 판 사이를 공기가 통과하는 유동입니다. 루버 핀보다 열전달계수는 낮으나, 공기측 압력강하와 착상(Frosting)·오염 저항성이 우수합니다.",
      formula: "Re_Dh = G_air · D_h,air / μ_air\nj = C_j · Re_Dh^(-0.38) · (F_p / D_h,air)^(-0.12)\nf_Darcy = 4 · 0.16 · Re_Dh^(-0.30)\nh_bare = j · G_air · Cp_air / Pr^(2/3),   h_eff = η_o · h_bare",
      params: [
        "핀 피치 Fp [mm] & 두께 ft [mm]: 공기 유로 수력직경 D_h,air 결정",
        "보정계수 C_j: 평판 핀 기준 기본값 0.145"
      ],
      implementation: "공기 유로 수력직경 D_h,air와 CoolProp 공기 물성치로 Re_Dh 및 Pr을 구해 Colburn j-인자와 핀 효율 η_o, Darcy 마찰계수를 계산합니다."
    },
    shah_cond: {
      title: "Shah (1979 / 2009) 관내 2상 응축 열전달 상관식",
      category: "열교환기 — 냉매측 응축 (2상)",
      mechanism: "응축기 내부에서 고온 증기가 벽면 액막을 형성하며 응축할 때, 전액 단상 대류 열전달계수(h_LO)에 건도(x)와 환산압력(P_r = P / P_crit) 증진 인자를 곱해 국소 응축 열전달계수를 예측합니다.",
      formula: "h_LO = 0.023 · Re_LO^0.8 · Pr_l^0.4 · (k_l / D_h),   P_r = P / P_crit\nh_TP(x) = C_ref · h_LO · [ (1 - x)^0.8 + (3.8 · x^0.76 · (1 - x)^0.04) / P_r^0.38 ]",
      params: [
        "임계압력 P_crit [bar]: R134a=40.59, R32=57.82, Water=220.64 (자동 인식)",
        "보정계수 C_ref: 기본 1.0"
      ],
      implementation: "냉매 흐름 방향 20개 세그먼트로 이산화하고, 상경계(x=0, x=1)는 smoothstep으로 연속 블렌딩하며 단상 구간은 Gnielinski-층류 연속식을 적용합니다."
    },
    cavallini: {
      title: "Cavallini-Zecchin (1974) 관내 응축 상관식",
      category: "열교환기 — 냉매측 응축 (2상)",
      mechanism: "고속 환상류(Annular flow) 응축 영역에서 기-액 밀도비(ρ_l/ρ_v) 기반 등가 레이놀즈수 Re_eq로 계면 전단력에 의한 액막 박막화 효과를 모델링합니다.",
      formula: "Re_eq = Re_l + Re_v · (μ_v/μ_l) · (ρ_l/ρ_v)^0.5\nNu_TP = C_ref · 0.05 · Re_eq^0.8 · Pr_l^0.33",
      params: ["보정계수 C_ref: 기본 1.0"],
      implementation: "20개 세그먼트의 국소 건도 x와 포화 물성치로 Re_eq를 계산하여 국소 응축 열전달계수를 산출합니다."
    },
    kim_mudawar: {
      title: "Kim & Mudawar (2013) 미니/마이크로채널 응축 상관식",
      category: "열교환기 — 냉매측 응축 (D_h ≤ 2.5 mm 권장)",
      mechanism: "수력직경이 작은 다채널(마이크로채널) 응축기에서는 표면장력과 전단력이 지배적입니다. 수정 웨버수 We* 기준으로 환상류(Annular)와 슬러그/버블류(Slug/Bubbly) 영역을 구분하여 높은 정확도로 예측합니다.",
      formula: "We* = f(Re_vo, Su_go, X_tt)\nNu_ann = 0.048 · Re_l^0.69 · Pr_l^0.34 · (φ_g / X_tt)\nNu_slug = [ Nu_ann² + (3.2e-7 · Re_l^(-0.38) · Su_go^1.39)² ]^0.5",
      params: [
        "수력직경 D_h ≤ 2.5 mm 마이크로채널 응축기에 최적화",
        "표면장력 σ(T_sat): 냉매별 Brock-Bird/Mulero 상관식으로 자동 산출"
      ],
      implementation: "We* = 5~10 구간을 smoothstep으로 연속 블렌딩하여 환상류와 슬러그류 간 미분 불연속 없이 국소 응축 h_ref를 산출합니다."
    },
    han_lee_kim: {
      title: "Han, Lee & Kim (2003) 쉐브론 각도 반영 PHX 증발 상관식 (권장 기본)",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "판형 열교환기의 쉐브론 각도(β)와 주름 피치/수력직경 비(p_co/D_h)가 유동 난류 강도와 기포 이탈에 미치는 영향을 형상계수 Ge1, Ge2로 분리한 대표 상관식입니다. 저·중 질량유속(G ≈ 15~80 kg/m²s)에서도 안정적인 예측 성능을 보입니다.",
      formula: "Ge1 = 2.81 · (p_co/D_h)^(-0.041) · (π/2 - β)^(-2.83)\nGe2 = 0.746 · (p_co/D_h)^(-0.082) · (π/2 - β)^0.61\nNu = C_ref · Ge1 · Re_eq^Ge2 · Bo_eq^0.3 · Pr_l^0.4",
      params: [
        "쉐브론 각도 β [°], 주름 피치 p_co [mm]",
        "비등수 Bo_eq: 고정 추정값이 아니라 각 세그먼트 실제 열유속 q'' = Q_seg/A_seg로 내부 반복 수렴"
      ],
      implementation: "20-세그먼트 진성 역류(Counter-flow) 마칭 내에서 국소 열유속 q''를 내부 반복 갱신하여 Bo_eq와 h_ref의 자기일관성을 확보합니다."
    },
    amalfi_2016: {
      title: "Amalfi, Vakili-Farahani & Thome (2016) 일반화 PHX 증발 상관식",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "전 세계 19개 연구 그룹의 1,900여 개 판형 증발기 실험 데이터베이스로부터 도출된 최신 일반화 상관식입니다. 본드수(Bd)를 기준으로 미소채널(Bd<4, 표면장력·웨버수 지배)과 매크로채널(Bd≥4, 부력·관성 지배)을 구분합니다.",
      formula: "Bd = (ρ_l - ρ_g)·g·D_h² / σ,   β* = β / 70°\n(Bd < 4):  Nu = 982 · β*^1.101 · We_m^0.315 · Bo^0.320 · (ρ_l/ρ_g)^(-0.224)\n(Bd ≥ 4):  Nu = 18.495 · β*^0.248 · Re_v^0.135 · Re_lo^0.351 · Bd^0.235 · Bo^0.198 · (ρ_l/ρ_g)^(-0.223)",
      params: [
        "본드수 Bd, 웨버수 We_m, 비등수 Bo, 밀도비 ρ_l/ρ_g 자동 계산",
        "Bd = 3~5 구간 smoothstep 연속 블렌딩으로 미분 연속성 확보"
      ],
      implementation: "냉매 표면장력 σ(T_sat)와 세그먼트 실제 국소 열유속 q''를 내부 반복 결합하여 광범위한 냉매와 형상에서 일관된 h_ref를 예측합니다."
    },
    yan_lin: {
      title: "Yan & Lin (1999) 판형 열교환기(PHX) 증발 상관식 (원식 복원)",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "R-134a 60° 쉐브론 판형 증발기 실험에서 도출된 고전 상관식입니다. 원논문의 밀도비 증진항 [(1-x) + x(ρ_l/ρ_v)^0.5]을 정확히 포함하며, 적용범위(Re_eq ≥ 2000, G ≥ 50 kg/m²s)를 벗어날 경우 자동 경고를 표시합니다.",
      formula: "G_eq = G · [ (1 - x) + x · (ρ_l / ρ_v)^0.5 ]\nRe_l = G·D_h/μ_l,   Bo_eq = q'' / (G_eq · h_fg)\nNu = C_ref · 1.926 · Pr_l^(1/3) · Bo_eq^0.3 · Re_l^0.5 · [ (1 - x) + x · (ρ_l / ρ_v)^0.5 ]",
      params: [
        "원논문 계수 1.926, 권장 적용범위: 2,000 ≤ Re_eq ≤ 10,000 (G ≈ 55~70 kg/m²s)",
        "저유량(G < 50 kg/m²s) 조건에서는 Han-Lee-Kim 또는 Amalfi(2016) 사용 권장"
      ],
      implementation: "누락되었던 밀도비 항을 복원하고 국소 열유속 q'' 내부 반복을 적용했으며, Re_eq < 2000 시 솔버 경고 패널에 범위 주의 알림을 출력합니다."
    },
    hsieh_lin: {
      title: "Hsieh & Lin (2002) PHX 핵비등 지배 증발 상관식",
      category: "판형 열교환기 (PHX) — 냉매측 증발",
      mechanism: "단상 액체 열전달계수(h_l)에 비등수 Bo의 0.5제곱 항을 곱해 핵비등 지배 영역의 증발 열전달계수를 간결하게 예측합니다.",
      formula: "h_l = 0.2092 · (k_l / D_h) · Re_lo^0.78 · Pr_l^(1/3)\nBo = q'' / (G · h_fg),   h_TP = C_ref · h_l · 88 · Bo^0.5",
      params: ["보정계수 C_ref: 기본 1.0 (상수 88 기준), 국소 열유속 q'' 내부 반복 적용"],
      implementation: "각 세그먼트 실제 열유속으로 Bo를 반복 수렴시켜 h_TP를 계산합니다."
    },
    martin: {
      title: "Martin (1996) 일반화 Lévêque 판형 상관식 (권장 기본 — 층류~난류 전영역)",
      category: "판형 열교환기 (PHX) — 상대측 (GW / Water)",
      mechanism: "주름진 판 사이 유동을 교차 유동과 주름 방향 유동의 조합으로 해석하여, Darcy 마찰계수 ξ와 열전달(Nu)을 일반화된 Lévêque 상사로 연결합니다. 고점성 부동액(GW, Re ≈ 80 층류)부터 고속 물(난류)까지 전 영역을 매끄럽게 다룹니다.",
      formula: "(Re<2000): ξ_0 = 64/Re,  ξ_1 = 597/Re + 3.85\n(Re≥2000): ξ_0 = (1.8·log10(Re) - 1.5)^(-2),  ξ_1 = 39 / Re^0.289\n1/√ξ = cosβ / √(0.18·tanβ + 0.36·sinβ + ξ_0/cosβ) + (1 - cosβ) / √(3.8·ξ_1)\nNu = 0.122 · Pr^(1/3) · (ξ · Re² · sin(2β))^0.374",
      params: [
        "원논문 Darcy 마찰계수 ξ 및 계수 0.122 일치 (ΔP = ξ·(L/Dh)·G²/(2ρ) 정합)",
        "Re = 1,700~2,300 구간 smoothstep 연속 천이"
      ],
      implementation: "기존 Fanning/Darcy 혼용(0.205와 4배 낮은 ΔP) 오류를 원논문 Darcy 체계(0.122 + ξ)로 통일해 h_sec와 ΔP_sec를 동시에 일관 계산합니다."
    },
    muley_manglik: {
      title: "Muley & Manglik (1999) 판형 단상 난류 상관식 (Re ≥ 1000)",
      category: "판형 열교환기 (PHX) — 상대측 (Water / GW)",
      mechanism: "쉐브론 각도(β)와 주름 면적 확장계수(Φ)가 만드는 나선형 와류의 난류 열전달 및 마찰 증가를 예측합니다. 적용범위(Re ≥ 1,000) 미만(예: 고점성 GW Re=84)에서는 자동으로 Martin(1996) 층류 분기로 안전 전환하고 경고를 표시합니다.",
      formula: "Nu = [0.2668 - 0.006967β + 7.244e-5·β²]·[20.78 - 50.94Φ + 41.16Φ² - 10.51Φ³]·Re^p1·Pr^(1/3)\nf_F = [2.917 - 0.1277β + 2.016e-3·β²]·[5.474 - 19.02Φ + 18.93Φ² - 5.341Φ³]·Re^(-p2)\nf_Darcy = 4 · f_F   (적용범위: Re ≥ 1,000, 30° ≤ β ≤ 60°)",
      params: [
        "쉐브론 각도 β [°], 면적 확장계수 Φ (기본 1.17)",
        "원논문 마찰계수 f_F 적용 (기존 임의식 (0.6+0.03β)Re^-0.25 교체)"
      ],
      implementation: "Re ≥ 1000에서 원논문 Nu와 f_Darcy=4f_F를 적용하며, Re < 1000일 때는 Martin(1996) 층류식으로 자동 분기합니다."
    },
    dittus: {
      title: "Gnielinski (1976) / Dittus-Boelter (단상 관내 강제대류)",
      category: "범용 단상 관내 열전달",
      mechanism: "단상 구간(과열증기·과냉액)에서 층류(Nu=4.36)와 난류(Gnielinski 식)를 Re = 2,000~3,500 구간에서 smoothstep으로 연속 연결하여 솔버 미분 불연속을 제거합니다.",
      formula: "Nu_turb = (f/8)(Re - 1000)Pr / [ 1 + 12.7√(f/8)(Pr^(2/3) - 1) ]\nNu = (1 - w)·4.36 + w·Nu_turb   (w = smoothstep(2000, 3500, Re))",
      params: ["Churchill(1977) 전영역 마찰계수 f 자동 결합"],
      implementation: "단상 냉매 및 관외 유체 대류에 연속 천이식을 적용합니다."
    },
    txv_sh: {
      title: "TXV / EEV 과열도 피드백 + 역방향(ΔP→ṁ) 유량 결합 모델",
      category: "팽창밸브 — 센서 연동 자동 제어",
      mechanism: "증발기 출구 감온통 센서에서 계측한 흡입 과열도(SH)와 정적 과열도(SH_static)·비례 게인(Kp)으로부터 개도율(5~100%)을 결정하고, ΔP→ṁ 방향으로 밸브 통과 질량유량 ṁ_valve를 산출합니다. 전역 뉴턴 솔버가 ṁ_comp = ṁ_valve 질량 연속 잔차를 직접 0으로 수렴시킵니다.",
      formula: "Opening [%] = smoothClamp(Open_0 + K_p · (SH_meas - SH_target), 5, 100)\nA_eff = (π/4 · D_orifice²) · (Opening / 100)\nṁ_valve = Cd_eff · A_eff · √(2 · ρ_in · ΔP)   (초크 시 ≤ G_crit,HEM · A_eff)",
      params: [
        "개도 하한: 5% (문서·코드 완전 일치, 기존 5%/8% 불일치 해소)",
        "동일 패스 무지연 피드백: 등엔탈피 팽창 특성을 활용해 1회 반복 지연 제거"
      ],
      implementation: "기존 불안정 고정점(ṁ→ΔP→P1)을 ΔP→ṁ 방향의 4변수 전역 뉴턴 잔차로 역전시켜 TXV·오리피스 모드 모두 안정 수렴합니다."
    },
    orifice: {
      title: "고정 개도 오리피스 역방향(ΔP→ṁ) 모멘텀 유량 모델",
      category: "팽창밸브 — 수동 개도 / 고정 오리피스",
      mechanism: "지정된 오리피스 지름(D)과 고정 개도율(%)에서 상·하류 압력차 ΔP = P_in - P_out로부터 통과 질량유량 ṁ_valve를 계산하고, 전역 뉴턴 솔버가 압축기 유량 ṁ_comp와 일치하는 증발압력 P_1, P_4를 탐색합니다.",
      formula: "A_eff = (π/4 · D²) · (Opening / 100)\nṁ_valve = min(Cd_eff·√(2·ρ_in·ΔP), G_crit,HEM) · A_eff",
      params: ["오리피스 지름 D [mm], 고정 개도율 [5~100%], 기준 유량계수 Cd_0"],
      implementation: "전역 뉴턴 솔버의 질량 연속 방정식 R_mass = (ṁ_comp - ṁ_valve)/ṁ_ref = 0 으로 결합됩니다."
    },
    re_diam_cd: {
      title: "지름(D)·레이놀즈수(Re)·과냉도 연동 가변 유량계수 Cd 경험식",
      category: "팽창밸브 — 오리피스 유량계수 상관식",
      mechanism: "오리피스 지름, 목 레이놀즈수 Re_D, 입구 과냉도(SC)에 따라 유량계수 Cd를 보정하는 경험 상관식입니다(내부 2회 반복으로 ṁ과 Re_D의 자기일관성 유지).",
      formula: "Re_D = (ρ_in · v_throat · D) / μ_in\nCd_eff = Cd_0 · (D / 2.8)^0.14 · (1 - 9.5 / √Re_D) · (1 + 0.006 · SC)",
      params: [
        "오리피스 지름 D [mm], 기준 Cd_0 (기본 0.65)",
        "미리보기에서도 연결된 실제 냉매의 물성치를 사용 (R134a 하드코딩 제거)"
      ],
      implementation: "밸브 유량 계산 시 Re_D와 Cd_eff를 2회 반복 수렴시켜 반영합니다."
    },
    hem_choked: {
      title: "진성 HEM (Homogeneous Equilibrium Model) 2상 초크 플로우 모델",
      category: "팽창밸브 — 임계유동(Choked Flow) 물리 모델",
      mechanism: "오리피스 목에서 등엔트로피 팽창(s = s_in)을 가정하고, CoolProp 물성 테이블에서 질량유속 G(P_t) = ρ(P_t, s_in)·√[2(h_in - h(P_t, s_in))]의 물리적 최댓값 G_crit,HEM과 임계압력 P_choke를 황금분할 탐색(34회)으로 직접 구합니다. 하류 압력이 P_choke 이하이면 실제 밸브 유량을 G_crit·A_eff로 엄격 제한합니다.",
      formula: "G_HEM(P_t) = ρ(P_t, s_in) · √[ 2 · (h_in - h(P_t, s_in)) ]\nG_crit = Cd_eff · max_{P_t} G_HEM(P_t),   P_choke = argmax G_HEM(P_t)\nṁ_valve = min( Cd_eff·√(2ρ_inΔP), G_crit ) · A_eff   (P_out ≤ P_choke 시 CHOKED!)",
      params: [
        "경험식이 아닌 실제 CoolProp 등엔트로피(solvePS) 기반 진성 HEM 계산",
        "기존 플래그만 표시하던 결함 수정 → 실제 질량유량 상한 강제 적용"
      ],
      implementation: "초크 발생 시 TXV는 부족 유량을 보충하기 위해 자동으로 개도를 더 열며, 오리피스 모드에서는 임계 유량 상한에 맞게 압력이 물리적으로 재균형됩니다."
    },
    const_cd: {
      title: "고정 유량계수 (Constant Cd) 단상 베르누이 오리피스 식",
      category: "팽창밸브 — 오리피스 유량계수 상관식",
      mechanism: "지름·Re·과냉도 보정 없이 사용자가 지정한 상수 Cd를 그대로 사용하는 표준 오리피스 유량식입니다.",
      formula: "ṁ_valve = Cd_0 · A_eff · √(2 · ρ_in · ΔP)",
      params: ["고정 유량계수 Cd_0 (기본 0.65)"],
      implementation: "역방향 유량 잔차 계산에 상수 Cd_0를 직접 적용합니다."
    },
    fan_curve: {
      title: "팬 성능곡선(P-Q) + RPM/밀도 상사법칙 & HX 실제 ΔP_sec(Q) 직결 해석",
      category: "팬 / 블로워 — 유체기계 운전점 해석",
      mechanism: "팬 정압 곡선 ΔP_fan(Q)를 회전수(N²)와 외기온도 기반 실제 공기밀도(ρ_air(T_amb)/1.20) 상사법칙으로 변환하고, 연결된 핀-플레이트 열교환기의 실제 Chang(2000) 공기측 압력강하 곡선 ΔP_sec(Q) + 쉬라우드 손실과 만나는 정확한 교차 운전점을 이분법(34회)으로 산출합니다.",
      formula: "Q(N) = Q_ref·(N/N_ref),   ΔP_fan(N, ρ) = ΔP_ref·(N/N_ref)²·(ρ_air / 1.20)\nΔP_fan(Q_op) = ΔP_HX,core(Q_op) + ΔP_shroud(Q_op)\nW_fan = (Q_op · ΔP_op) / η_fan(Q_op)",
      params: [
        "기존 K_hx=0.02 하한 고정 및 ρ=1.15 고정 결함 완전 제거",
        "팬 상세 탭 미리보기와 솔버 운전점 100% 일치"
      ],
      implementation: "HXModule.calcAirPressureDrop(Q) 콜백을 FanModule.run에 직접 전달하여 팬 정압과 열교환기 공기측 압력강하가 정확히 일치하도록 결합합니다."
    }
  };

  global.CorrDocsModule = { CORR_DOCS };
})(window);
