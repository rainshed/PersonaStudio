import type { Localized } from './radar';
export type SingleSummarySection = {
  title: Localized;
  source: string;
  paragraphs: Localized[];
};
// Public paper, CC BY 4.0. Edited preview text; no private Persona records.
export const SINGLE_SUMMARY: SingleSummarySection[] = [
  {
    title: {
      zh: '研究问题',
      en: 'Research question',
    },
    source: 'https://arxiv.org/html/2501.12903v3#p2',
    paragraphs: [
      {
        zh: '论文研究一维、保持U(1)粒子数守恒且状态保持高斯性的自由费米子监测，短程但彼此不对易的两格测量能否产生通常扩散或局域化之外的纠缠标度。',
        en: 'The paper asks whether strictly local measurements in a one-dimensional free-fermion system can produce entanglement scaling beyond the familiar diffusive and localized regimes. It focuses on measurements of orbitals shared between neighboring sites. Their noncommutativity changes the monitored dynamics without introducing a long-range Hamiltonian or particle interactions.',
      },
      {
        zh: '核心问题是最大错位θ=π时，测量是否诱导量子信息的Lévy飞行和分形纠缠增长，并区分量子信息超扩散与Lindblad密度动力学的超扩散。',
        en: 'The central distinction concerns what actually spreads. The authors study quantum information and entanglement along measurement trajectories, while the Lindblad evolution describes averaged density dynamics. Superdiffusion in the former does not imply superdiffusive particle-density transport in the latter. Keeping this distinction explicit is essential when comparing the paper with other work on anomalous transport and long-lived quasiparticles.',
      },
      {
        zh: '这里的难点是区分微观局域性与有效理论中的非局域结构。哈密顿量和测量只作用于邻近格点，但轨迹平均后的某些非线性观测量可以由具有长时间记忆的有效理论描述。因此，研究问题不是人为加入远程跳跃能否加速输运，而是局域测量本身能否改变量子信息的渐近传播规律。',
        en: 'A useful reading question is why microscopic locality and an effective long-time memory kernel can coexist. The model does not add distant hopping by hand. Instead, averaging monitored trajectories and studying nonlinear observables produce a different effective description. The paper therefore addresses a mechanism question, not merely whether an explicitly long-range model can spread information quickly. Any comparison with conventional transport should identify the observable and the averaging procedure before comparing exponents.',
      },
      {
        zh: '常规一维密度监测在较大尺度上通常趋向面积律，之前可以出现对数增长区间。本文在保持局域作用和高斯性的条件下得到不同分数幂，因此需要解释测量几何怎样影响有效理论，而不能仅把现象归结为换了一个模型。',
        en: 'The motivation depends on what conventional monitored models usually do. In one-dimensional density monitoring, an intermediate logarithmic regime can precede area-law behavior at sufficiently large scales. Finding a different fractional law while retaining local operators and Gaussian states demands an explanation beyond changing a symmetry label. The construction isolates a specific measurement geometry and follows its consequences through the effective theory. It provides a controlled comparison without completing the broader classification of monitored systems. In particular, the result should not be generalized to all local measurements without checking their decay-rate structure.',
      },
    ],
  },
  {
    title: {
      zh: '模型方法',
      en: 'System and method',
    },
    source: 'https://arxiv.org/html/2501.12903v3#p4',
    paragraphs: [
      {
        zh: '系统是周期链上的L个格点，而非L个粒子；数值取粒子数N=L/2。',
        en: 'The system is a periodic chain with L lattice sites and nearest-neighbor hopping. The numerical calculations use half filling, N = L/2. Each monitored operator measures the occupation of an orbital combining two adjacent sites; a misalignment angle θ controls their relative weights. These measurements conserve particle number and preserve Gaussian states.',
      },
      {
        zh: '哈密顿量为最近邻跳跃H=J∑(c†i+1ci+h.c.)，连续监测Mi=d†idi，其中di=ci cos(θ/4)+ci+1 sin(θ/4)，测量强度为γ。作者用高斯态单粒子关联矩阵进行轨迹模拟，并以复制Keldysh非线性σ模型分析。复制对称的S²扇区描述Lindblad动力学，SU(R) replicon扇区描述密度矩阵非线性观测量，如纠缠和电荷涨落。',
        en: 'The authors evolve stochastic measurement trajectories using a single-particle correlation-matrix representation. Analytically, they develop a replicated Keldysh nonlinear sigma model. Its replica-symmetric sector describes Lindblad dynamics, while its replicon sector describes observables nonlinear in the density matrix. This supplies a framework for relating charge fluctuations to entanglement without treating a mixed, averaged density matrix as an individual pure trajectory.',
      },
      {
        zh: '测量角度为零时，监测接近通常的格点粒子数测量；角度变化后，相邻测量共享格点且不再对易。最大错位时被监测的轨道是两格点算符的等权叠加。数值方法利用高斯性降低计算规模，但这个便利也限定了直接适用的体系，不能把自由费米子的实现直接当作通用相互作用算法。',
        en: 'The Gaussian representation is valuable because it permits calculations at system sizes beyond a generic many-body state-vector treatment. Nevertheless, polynomial-time simulation does not eliminate finite-size and time-step checks. The initial filling, boundary conditions, measurement strength and precise monitored orbitals remain part of the experiment being simulated. An extension involving interactions would require revisiting the state representation and analysis rather than reusing the free-fermion calculation without modification.',
      },
      {
        zh: '复现时应区分链长、粒子数与计算纠缠的子系统长度，也要注明先在单条轨迹内计算再平均的顺序。对纠缠和连通关联，这一顺序与先求平均密度矩阵再计算一般不可互换，会影响结果的物理含义。',
        en: 'A careful replication would distinguish chain length, particle number and the subsystem length used to calculate entropy. Gaussianity means single-particle data determine the state’s properties, but it does not make all averages interchangeable. Products evaluated within individual trajectories and then averaged generally differ from products formed from an averaged state. This distinction matters for entanglement and connected correlations. A numerical implementation should therefore reproduce the specified ordering of trajectory averages and observables, as well as the monitoring operators, before comparing its results with the reported scaling curves.',
      },
    ],
  },
  {
    title: {
      zh: '具体工作',
      en: 'What the authors did',
    },
    source: 'https://arxiv.org/html/2501.12903v3#p9',
    paragraphs: [
      {
        zh: '作者推导动量依赖的准粒子衰减率γk=γ[1+sin(θ/2)cos k]及扩散系数D，并考察θ=π时k=±π处的衰减率零点。',
        en: 'The analysis first derives a momentum-dependent measurement-induced quasiparticle decay rate. At maximal misalignment, θ = π, this rate vanishes at the Brillouin-zone boundary. The authors then construct the low-frequency temporal kernel of the effective theory and calculate correlation functions and charge cumulants using saddle-point and Wiener–Hopf methods.',
      },
      {
        zh: '随后计算时间核B(ω)=∫dk/(γk−iω)，建立复制场论的长波描述，用鞍点和Wiener–Hopf方法求电荷关联C(q)、二阶累积量及半链纠缠熵，同时以有限尺寸数值检验交叉行为、远距粒子数协方差和局域长度。',
        en: 'The work combines this analytical construction with simulations across system sizes and measurement strengths. It examines half-chain entropy, charge fluctuations, spatial correlations, crossover scales and finite-size corrections. The decay-rate zero is the organizing mechanism: modes close to the special momentum are weakly affected by measurements. However, the ordinary spatial diffusion coefficient remains finite because the relevant velocity factors also vanish at that momentum.',
      },
      {
        zh: '衰减率零点附近的模会在较长时间内弱受测量影响。推导需要同时考虑这些模的寿命、群速度和测量引起的扩散项，单独观察寿命发散并不足以得出粒子密度超扩散。论文进一步将这些微观信息组织成有效作用量，并通过相关函数与涨落建立到纠缠标度的联系。',
        en: 'The passage from a decay-rate node to an entanglement law involves several linked steps. One must identify the low-frequency kernel, solve for the appropriate correlations, integrate the charge fluctuations for the chosen region and justify their relation to entropy. This sequence helps locate assumptions and possible failure points. It also explains why a visually similar node in another Hamiltonian does not by itself prove that the two systems share the same information dynamics.',
      },
      {
        zh: '非解析频率依赖是连接微观衰减率与最终纠缠标度的中间结果，并非临时选择的拟合形式。推广模型时，如果扰动移除了零点、改变群速度或更换观测量，应从相应步骤重新检查推导。',
        en: 'The nonanalytic frequency dependence is a central intermediate result rather than a fitting ansatz for the entropy. It connects the momentum-dependent decay rate to an effective temporal interaction. The resulting field theory then supplies predictions for comparison with simulations. An extension should revisit this chain at the step affected by its modification. If a perturbation removes the zero, changes a relevant velocity or alters the observable, retaining the final exponent without rechecking the derivation would be unjustified. This makes the intermediate kernel a useful diagnostic as well as an analytical construction.',
      },
    ],
  },
  {
    title: {
      zh: '主要结果',
      en: 'Results and evidence',
    },
    source: 'https://arxiv.org/html/2501.12903v3#p9',
    paragraphs: [
      {
        zh: 'θ=π时B(ω)∝ω^−1/2，replicon关联满足C(q)∝q^{2/3}，从而半链熵和二阶电荷累积量均呈S∼C_A^(2)∝L^{1/3}。',
        en: 'At θ = π, the temporal kernel has a nonanalytic low-frequency form and the charge correlation function scales as C(q) ∝ q^(2/3). The resulting half-chain entanglement entropy scales as S ∝ L^(1/3). This is a fractional, sub-volume-law scaling associated with superdiffusive spreading of quantum information.',
      },
      {
        zh: '这表示量子信息的超扩散或Lévy飞行；但复制对称扇区的空间扩散系数D仍有限，因此不是Lindblad密度的超扩散。小γ或L/ℓ0较小时先有弹道式S∼L，随后进入L^{1/3}。当δ=θ−π≠0时，超扩散只在长度ℓ*∼ℓ0|δ|^−3/2以内出现，之后转为对数扩散并最终局域化；局域长度在临界点附近按ℓloc∼ℓ0|δ|^−3/2 exp[2√2πℓ0/√|δ|]发散。',
        en: 'Away from maximal misalignment, increasing subsystem size produces successive superdiffusive, logarithmic and localized regimes. The crossover and localization lengths grow strongly near the special angle, making finite-size interpretation important. The density dynamics described by the Lindblad sector remain diffusive. The entropy and second charge cumulant have the same leading scaling, but their proportionality is approximate; higher cumulants are not identically zero.',
      },
      {
        zh: '数值验证不仅展示熵随尺寸增长的曲线，还检查不同测量强度、远距离区域的涨落及有限尺寸外推。小尺寸可能处于弹道式交叉区，偏离特殊角度的体系又可能尚未进入最终局域化区间。由此，一条有限区间中的幂律拟合不能替代对适用尺度和渐近行为的解释。',
        en: 'The simulations should be interpreted together with the theory of corrections, not by reading a single fitted slope as a universal exponent. A small system can remain in a crossover regime, while a slightly detuned measurement angle can delay the eventual localized behavior to much larger scales. The paper tests these distinctions using several observables. The reported numerical agreement is evidence for the proposed mechanism under the studied conditions, not an independent validation of every possible extension.',
      },
      {
        zh: '偏离最大错位角度后，低频处重新出现有限尺度。有限链仍可能看起来接近特殊点的行为，因此有限窗口给出的标度判断，需要连同测量角度、强度、子系统几何和观察尺度一起陈述。',
        en: 'The angle dependence tests the interpretation beyond the special point. Moving away from maximal misalignment restores a finite low-frequency scale and changes the long-distance behavior. A finite chain can still resemble the special-point regime if it remains shorter than the crossover scale. A phase label inferred from a numerical window may therefore not describe the ultimate large-system limit. Reporting the angle, measurement strength, subsystem geometry and observed length range is part of stating the result. These conditions should accompany any comparison with another simulation or with a different experimental monitoring protocol.',
      },
    ],
  },
  {
    title: {
      zh: '贡献范围',
      en: 'Contribution and scope',
    },
    source: 'https://arxiv.org/html/2501.12903v3#p13',
    paragraphs: [
      {
        zh: '论文展示了本征短程、自由费米子监测模型中的测量诱导Lévy飞行，并指出关键条件是测量使某个布里渊区点的γk消失；因此机制可能推广到具有类似衰减率零点的其他模型和对称类。',
        en: 'The result demonstrates that a short-range monitored free-fermion model can produce fractional entanglement scaling. The long-range structure arises in the effective description of information propagation, rather than being inserted as a long-range microscopic coupling. The effect also survives qualitatively in the measurement-only limit.',
      },
      {
        zh: '结果也适用于测量-only极限γ=∞：定性上仍有L^{1/3}标度且无局域化转变，但对称类由有限γ的AIII变为BDI，弱局域化修正更强。',
        en: 'The finite-hopping and measurement-only limits belong to different symmetry classes, with different quantum corrections. Thus a shared scaling law does not make their finite-size behavior identical. The authors suggest that a vanishing measurement-induced decay rate may support related mechanisms in other settings. That suggestion motivates further investigation; it does not establish a universal law for every monitored model containing a momentum-space node.',
      },
      {
        zh: '与节点杂质、退相干和节点相互作用等研究比较时，共同线索是特殊动量附近的长寿命模。不同之处在于传播的对象、是否存在测量轨迹以及有效方程的结构。把这种联系展示给读者有助于选择进一步阅读的材料，但是否存在相同指数关系或可迁移的推导仍需逐项检验。',
        en: 'The cited nodal-impurity, dephasing and nodal-interaction studies offer concrete comparison points. All involve unusually long-lived modes near special momenta, but they differ in the quantity transported, interactions, disorder and the role of monitoring. A productive comparison should tabulate those differences before transferring a kinetic equation or interpreting a common power law. Direct citation is established bibliographic evidence; a shared explanatory mechanism or a new research direction requires additional reasoning.',
      },
      {
        zh: '引用说明作者在相关节点输运研究的背景下讨论该机制，但不意味着被引体系之间都存在已证明的一一映射。进一步阅读应比较条件、观测量与推导中的差别，避免把类比直接写成等价关系。',
        en: 'A bibliographic connection should be distinguished from a new result. Citation shows that the authors place their mechanism alongside related nodal-transport studies. It does not prove a one-to-one mapping between every cited system and the monitored model. The value for a reader is to identify which assumptions can be compared, which observables differ and which argument would need an extension. Those questions guide further study without turning an analogy into an asserted equivalence. Establishing a shared exponent alone would likewise be insufficient to identify identical microscopic dynamics or identical responses to perturbations.',
      },
    ],
  },
  {
    title: {
      zh: '局限',
      en: 'Limitations and open questions',
    },
    source: 'https://arxiv.org/html/2501.12903v3#p12',
    paragraphs: [
      {
        zh: '解析结果主要依赖高斯鞍点和长波NLSM近似；大γ下是否严格不存在局域化转变，作者仍只给出重整化群论证和数值支持。',
        en: 'The analytical treatment uses long-wavelength and saddle-point approximations. Lattice-scale effects alter prefactors, and finite-size corrections decay slowly. Numerical slopes can therefore differ noticeably from the predicted one-third exponent even when the data are consistent with its asymptotic value. Large measurement strengths require particular care when interpreting perturbative arguments.',
      },
      {
        zh: '晶格尺度会修正前因子，γ=∞时BDI量子修正尤为明显。有限尺寸的主要修正衰减很慢，达到约5%和1%精度分别需L约10^4和10^6；数值表观指数可能偏离1/3。熵与二阶累积量的比例是标度近似并经数值检验，高阶累积量并非严格为零。',
        en: 'The supplement estimates that reaching a few-percent approximation to the asymptotic entropy can require very large systems; representative estimates for five-percent and one-percent accuracy are about L = 10^4 and L = 10^6. These estimates depend on the regime and are not blanket requirements for every observable. This preview uses the paper text, equations and captions; it does not claim to independently inspect the figure images or reproduce the simulations.',
      },
      {
        zh: '补充材料讨论了短距离关联对熵的边界修正，并比较带修正项的拟合与有效指数外推。这提醒读者将“数值曲线支持某种渐近解释”和“已在有限尺寸中精确达到该渐近值”分开。对潜在研究扩展，还应先确认目标问题是否已在正文或补充材料中得到回答，再提出新的可检验假设。',
        en: 'The finite-size analysis highlights a general methodological issue: numerical support for an asymptotic theory is not the same as directly reaching its asymptotic value. Corrections can be large even when their form is understood. A follow-up calculation should specify which observable, accuracy and parameter regime it targets. Likewise, a proposed crossover project should first check whether the paper or supplement already answers its central question, before presenting that question as an unresolved opportunity.',
      },
      {
        zh: '后续问题的新颖性仍需额外核实。例如平均密度与纠缠是否同样传播，原文已经给出关键区分。更有价值的扩展需要指出新的扰动、对称性条件或观测量，并区分解析预测、数值检验或实验建议。',
        en: 'The preview does not establish the novelty of every possible follow-up problem. Asking whether averaged density and entanglement spread identically overlaps a distinction that the paper already explains. A stronger extension should specify a new perturbation, symmetry condition or observable and identify what remains unaddressed. It should also separate an analytical prediction, a numerical consistency check and an experimental proposal. This preserves the limits of the evidence and prevents a broad suggestion from being mistaken for an established result. New calculations would still require their own convergence tests and source-based assessment.',
      },
    ],
  },
];
