"""Rebuild the public, synthetic research Demo; never read a private workspace."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path

import yaml

from ai_persona.compiler import PersonaCompiler
from ai_persona.demo import DEMO_METADATA, DEMO_VERSION
from ai_persona.frontmatter import dump_markdown_record
from ai_persona.initialization import REQUIRED_DIRECTORIES
from ai_persona.models import (
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    Relation,
    SourceManifest,
    Tag,
)

STAMP = "2026-09-01T00:00:00Z"
TARGET = Path(__file__).resolve().parents[1] / "examples/demo-persona/persona-data"

# slug, title, role, domain, mastery, interest, summary, parent
# Fictional doctoral researcher: two-dimensional magnetic and topological materials.
# This catalog is authored independently; no private Persona is read or imported.
KNOWLEDGE = [
    ("condensed", "凝聚态物理", "domain", "physics", "familiar", "high",
     "以晶体中的电子、晶格和磁性自由度为主线，理解材料的集体性质。", None),
    ("crystal", "晶体结构与晶格动力学", "area", "physics", "proficient", "medium",
     "从周期结构、对称性和原子振动建立材料计算的几何基础。", "condensed"),
    ("bravais", "布拉菲晶格与原胞", "concept", "physics", "proficient", "medium",
     "区分平移晶格、基元和原胞，能从晶格矢量重建周期结构。", "crystal"),
    ("reciprocal", "倒易晶格与布里渊区", "concept", "physics", "proficient", "high",
     "构造倒易基矢和高对称路径，检查不同晶胞约定下的动量坐标。", "crystal"),
    ("bloch", "Bloch 定理", "theory", "physics", "proficient", "high",
     "用周期部分与平面波因子表示晶体电子态，理解能带的动量标记。", "crystal"),
    ("phonon", "声子与动力学矩阵", "concept", "physics", "familiar", "medium",
     "从谐近似下的动力学矩阵理解振动模式，检查虚频和结构稳定性。", "crystal"),
    ("electronic", "电子结构计算", "area", "physics", "proficient", "high",
     "把晶体结构、轨道成分与能带联系起来，关注二维材料的低能电子态。", "condensed"),
    ("tight_binding", "紧束缚模型", "model", "physics", "proficient", "high",
     "以局域轨道、在位能和跃迁参数建立有效 Hamiltonian，核对轨道与相位约定。", "electronic"),
    ("fermi_surface", "费米面", "concept", "physics", "familiar", "high",
     "在给定化学势下分析金属能带的费米面形状、电子口袋和空穴口袋。", "electronic"),
    ("dos", "态密度与轨道投影", "technique", "physics", "proficient", "high",
     "比较总态密度与轨道投影，区分展宽、采样和投影定义带来的差异。", "electronic"),
    ("dft", "密度泛函理论（DFT）", "method", "physics", "proficient", "high",
     "熟悉基态电子密度计算流程，能够检查泛函、赝势和数值收敛条件。", "electronic"),
    ("kohn_sham", "Kohn–Sham 方程", "theory", "physics", "familiar", "high",
     "理解有效单粒子问题的自洽求解，以及近似交换关联泛函的作用。", "electronic"),
    ("wannier", "Wannier 函数与能带插值", "method", "physics", "familiar", "high",
     "用局域化轨道构造有效模型，检查投影、能窗及插值对目标能带的再现。", "electronic"),
    ("magnetism", "局域磁矩与磁性", "area", "physics", "familiar", "high",
     "围绕二维磁性材料理解磁序、交换作用和低能自旋激发。", "condensed"),
    ("exchange", "交换相互作用", "concept", "physics", "familiar", "high",
     "区分有效交换参数的符号、邻接范围和拟合所采用的自旋归一化。", "magnetism"),
    ("heisenberg", "Heisenberg 自旋模型", "model", "physics", "familiar", "high",
     "以自旋之间的交换耦合描述磁性，比较不同磁构型及模型适用条件。", "magnetism"),
    ("spin_wave", "线性自旋波理论", "method", "physics", "aware", "high",
     "正在学习围绕有序态展开得到磁振子谱，并检查涨落较大时的适用边界。", "magnetism"),
    ("anisotropy", "磁各向异性", "concept", "physics", "familiar", "high",
     "分析不同磁化方向的能量差，区分单离子、交换和形状各向异性。", "magnetism"),
    ("topology", "拓扑能带理论", "area", "physics", "aware", "high",
     "正在从普通能带分析过渡到几何相位、拓扑不变量与边界态的描述。", "condensed"),
    ("berry", "Berry 相位与 Berry 曲率", "concept", "physics", "aware", "high",
     "了解参数空间中的几何相位，正在学习规范选择及离散动量网格的计算。", "topology"),
    ("chern", "Chern 数", "concept", "physics", "aware", "high",
     "学习二维能带拓扑不变量，核对占据子空间、能隙和数值积分收敛。", "topology"),
    ("quantum_hall", "整数量子霍尔效应", "topic", "physics", "familiar", "medium",
     "理解量子化霍尔响应的基本图景，继续学习其与能带拓扑的联系。", "topology"),
    ("topological_insulator", "时间反演对称拓扑绝缘体", "topic", "physics", "aware", "high",
     "学习体能隙、保护对称性及边界态的联系，区分 Z₂ 指标与 Chern 数。", "topology"),
    ("spin_orbit", "自旋轨道耦合", "concept", "physics", "familiar", "high",
     "在电子结构中考虑自旋与轨道自由度的耦合，分析能带劈裂与磁各向异性。", "topology"),
    ("superconductivity", "超导物理", "area", "physics", "aware", "medium",
     "作为拓展方向学习配对、序参量、准粒子与电磁响应。", "condensed"),
    ("cooper", "Cooper 配对", "concept", "physics", "aware", "medium",
     "学习费米面附近电子配对的基本图像，区分配对形成与宏观相干。", "superconductivity"),
    ("bcs", "BCS 理论", "theory", "physics", "aware", "high",
     "学习弱耦合配对的平均场描述，理解能隙、自洽条件和理论假设。", "superconductivity"),
    ("bdg", "Bogoliubov–de Gennes 方程", "method", "physics", "aware", "high",
     "学习用粒子与空穴组成的基底求解超导平均场准粒子问题。", "superconductivity"),
    ("ginzburg_landau", "Ginzburg–Landau 理论", "theory", "physics", "aware", "medium",
     "从序参量自由能理解超导的空间变化，注意现象学参数和适用温区。", "superconductivity"),
    ("vortex", "第二类超导体与磁通涡旋", "topic", "physics", "unspecified", "medium",
     "尚未系统学习，计划从穿透深度、相干长度和磁通量子化入手。", "superconductivity"),
]

ARTICLES = [
    ("crystal", "从原胞到声子谱：二维材料计算的起点",
     ["crystal", "bravais", "reciprocal", "bloch", "phonon"],
     "用晶胞、动量坐标和振动模式串起二维材料的结构检查。", """
# 从原胞到声子谱：二维材料计算的起点

> AI Persona 原创虚构示例。研究者、阅读记录和练习计划均为演示设定；本文不报告真实材料发现。

## 先把结构说清楚

这位研究者准备研究一类假想的二维磁性薄层。开始计算前，他先记录原胞的晶格矢量、基元中的原子位置，以及模拟薄层时使用的真空层厚度。晶格描述周期平移，基元描述附着在每个晶格点上的结构；蜂窝排列不能不加说明地当成单原子布拉菲晶格。

## 倒空间中的坐标约定

设 aᵢ 为实空间原胞基矢，bⱼ 为倒易基矢，采用 aᵢ·bⱼ=2πδᵢⱼ 的约定，其中 δᵢⱼ 为 Kronecker 符号。高对称点的分数坐标依赖选定的倒易基矢。更换晶胞后，沿用旧的标签而不检查实际路径，可能使两张能带图无法直接比较。

Bloch 定理把周期势中的电子态写成平面波因子与周期函数的乘积。它说明为何可以在布里渊区内组织能带，但不保证任意选取的一条高对称路径覆盖全部带边位置。

## 怎样处理声子虚频

在谐近似下，声子频率来自动力学矩阵的本征值问题。若出现虚频，先检查结构是否充分弛豫、力常数与采样是否收敛，再讨论可能的结构不稳定性。二维材料靠近 Γ 点的柔性振动需要仔细处理数值误差；不能只凭一小段负频就宣布发现新相。

## 留下可追溯的输入

本练习保存原始结构、弛豫后的结构、坐标约定和声子计算参数。绘图时标注路径与频率单位，便于后续比较应变和磁构型的影响。这里列出的是待执行的检查清单，没有伪造计算输出。
"""),
    ("bands", "从 DFT 能带到 Wannier 有效模型",
     ["electronic", "tight_binding", "fermi_surface", "dos", "dft", "kohn_sham", "wannier"],
     "演示怎样从自洽电子结构计算组织能带、态密度和局域轨道模型。", """
# 从 DFT 能带到 Wannier 有效模型

> AI Persona 原创虚构示例。软件文档链接用于方法参考，本文不含任何真实项目的参数或数据。

## 研究任务与已知背景

假想任务是理解某种二维材料费米能附近的轨道成分。研究者熟悉 DFT 操作，但仍在积累 Wannier 建模经验。note 应从他熟悉的能带图出发，解释为何还需要局域轨道表示，以及这种表示如何支持更密的动量采样。

## 自洽与后处理分开记录

DFT 的 Kohn–Sham 计算通过有效单粒子问题更新电子密度，直到满足指定的自洽条件。练习中记录交换关联泛函、赝势、自旋设置和收敛阈值。能带路径计算与态密度计算的采样目的不同；应在收敛的密度基础上安排后处理，而非仅使用高对称路径估计总态密度。

能量图统一写作 E−E_F，其中 E 为所画的能带能量，E_F 为本次结果采用的费米能参照。若比较不同计算，必须说明如何对齐能量；绝缘体的费米能位置也不能不加说明地当作普适基准。

## 从轨道投影到有效模型

紧束缚模型使用局域轨道、在位能与跃迁矩阵元。Wannier 函数提供从选定能带子空间构造局域表示的途径。研究者应记录初始投影和所用能窗，再把插值能带与原始计算重叠比较；仅看到局域函数的展宽减小，不能代替目标能窗内的精度检查。

对于金属，还需核对费米面附近的交叉与小口袋是否稳定；对于轨道投影态密度，应注明投影约定。模型只在已验证的能量和参数范围内用于后续分析。

## 练习交付物

本练习计划保存一份参数表、一张原始与插值能带对照图，以及拟合误差说明。它不指定未经验证的最优参数，也不声称已经运行软件。

参考：[Quantum ESPRESSO 电子结构计算指南](https://www.quantum-espresso.org/Doc/pw_user_guide/node10.html)；[Wannier90 局域化轨道教程](https://wannier90.readthedocs.io/en/latest/tutorials/tutorial_1/)。
"""),
    ("magnetism", "从磁构型能量到自旋波：一份建模笔记",
     ["magnetism", "exchange", "heisenberg", "spin_wave", "anisotropy"],
     "围绕交换参数、磁各向异性与自旋波整理一个假想二维磁体的模型。", """
# 从磁构型能量到自旋波：一份建模笔记

> AI Persona 原创虚构示例。以下磁构型比较和计算计划均未实际执行，不对应真实样品。

## 磁性模型从约定开始

研究者希望把若干磁构型的能量差映射为有效交换参数。他采用 H=∑⟨ij⟩Jᵢⱼ Sᵢ·Sⱼ，其中 H 为模型 Hamiltonian，Sᵢ 为第 i 个位置的自旋，每条选定的键只求和一次。在这个符号约定下，正 J 倾向反平行排列。若文献采用相反的 Hamiltonian 符号，不能直接照抄其交换参数的正负解释。

拟合前还应注明自旋长度和纳入的邻接范围。不同参数组可能解释同一组有限的能量差；增加独立构型并检查预测误差，才能判断有效模型是否足够。

## 二维磁体的各向异性

除各向同性交换外，示例还计划比较不同磁化方向的能量。磁各向异性可能来自多种机制，讨论时需区分单离子项、各向异性交换及形状效应。这里不把一个能量差自动等同于全部磁性机制，也不根据零温能量比较直接给出转变温度。

## 从有序态到自旋波

这位研究者对 Heisenberg 模型较熟悉，但对线性自旋波理论只达到入门程度。因此 note 先解释围绕候选有序态展开的思路，再介绍磁振子色散；若参考态不稳定或量子涨落很强，线性近似需要重新评估。

## 一个可执行的数值练习

先用小系统检查模型符号和边界条件。若选择张量网络方法，按 Demo 偏好使用 Julia ITensors.jl 与 ITensorMPS.jl，再做键维数、截断阈值和系统尺寸检查。只有涉及时间演化时才扫描时间步长。

假想项目约定用 scripts/submit_job.sh 读取 configs/small.toml。实际工作时应先确认文件存在并阅读参数说明；若支持 dry-run，再检查请求的资源与输出位置。本文没有安装提交脚本，也没有向任何集群提交任务。
"""),
    ("topology", "怎样判断一组能带是否拓扑非平庸",
     ["topology", "berry", "chern", "quantum_hall", "topological_insulator", "spin_orbit"],
     "从已有能带知识引入几何相位、占据子空间和保护对称性，避免凭外观判断拓扑。", """
# 怎样判断一组能带是否拓扑非平庸

> AI Persona 原创虚构示例。本文安排学习步骤，不对任何真实材料作拓扑分类。

## 从熟悉的能带到陌生的几何信息

研究者已经会看能带与轨道投影，但还不熟悉 Berry 几何。note 先说明：能量本征值并未包含本征态随动量变化的全部信息；几何相位关心的是态在参数空间中的变化。对一条孤立能带，可用局部规范定义 Berry 联络 Aₙ(k)=i⟨uₙₖ|∇ₖuₙₖ⟩，其中 k 为晶体动量、n 为能带编号、uₙₖ 为 Bloch 态的周期部分。

## 从曲率到拓扑指标

Berry 曲率由联络的旋度给出。在适当的二维有隙能带问题中，对整个布里渊区的占据态曲率积分可以构造 Chern 数。数值上应先说明占据子空间和能隙，再检查网格收敛及简并附近的处理。仅沿高对称路径画出曲率，不能替代整个布里渊区的积分。

## 对称性决定要问什么

整数量子霍尔效应帮助建立 Chern 拓扑与响应的联系。对于时间反演对称的自旋电子体系，还需要学习适用的 Z₂ 分类；总 Chern 数为零并不自动说明该体系在这种分类下平庸。自旋轨道耦合可以改变能带与对称性允许的结构，但“存在自旋轨道耦合”也不是拓扑判据。

## 如何形成一份可审核的判断

示例报告先列 Hamiltonian 或有效模型、填充和保护对称性，再选择相应不变量，最后检查边界谱是否与体性质一致。带反转与边界态图像提供线索，但应说明能隙、边界终止和稳定性检查。所有未执行的部分保留为学习计划。

参考：[Topology in condensed matter：Haldane 模型、Berry 曲率与 Chern 数](https://topocondmat.org/w4-haldane/haldane-model/)。
"""),
    ("superconductivity", "给能带研究者的超导入门路线",
     ["superconductivity", "cooper", "bcs", "bdg", "ginzburg_landau", "vortex"],
     "以配对、准粒子和序参量为线索逐步引入超导，体现不同掌握程度的解释需求。", """
# 给能带研究者的超导入门路线

> AI Persona 原创虚构示例。学习进度为人工设定，不代表任何真实用户的研究经历。

## 先确认学习起点

这位研究者熟悉 Bloch 态和电子结构计算，刚开始接触超导。他已经听过 Cooper 配对和 BCS 理论，但尚未系统学习磁通涡旋。因此这份 note 先连接费米面与配对，再介绍准粒子，最后留下电磁响应的进阶问题。

## 从配对到平均场

在最简单的均匀、单带 s 波 BCS 平均场描述中，准粒子能量写作 Eₖ=√(ξₖ²+|Δ|²)。这里 k 为动量，ξₖ 为相对于化学势的正常态能量，Δ 为配对能隙参数。这个表达式附带模型与近似条件，不能直接推广为所有超导材料的完整激发谱。

配对形成的图像与宏观相干是不同层次的问题。理解平均场结果后，应进一步学习何时需要考虑相位涨落，而不是把一个非零的输入 Δ 当成材料已经实现超导的证明。

## 为什么引入 BdG 方程

Bogoliubov–de Gennes 方法使用包含粒子与空穴分量的基底处理超导平均场问题。它方便研究空间不均匀的配对，但求解时仍要说明正常态模型、配对形式、边界条件，以及能隙是外部给定还是自洽求得。note 会先定义基底，再解释矩阵各块的含义。

## 序参量和磁通涡旋

Ginzburg–Landau 理论从序参量自由能组织超导的空间变化，在其适用范围内讨论相干长度与磁场穿透。第二类超导体和涡旋是本画像尚未记录掌握程度的主题，应补充序参量相位、磁通量子化等背景后再继续。本文不编造临界场、转变温度或数值结果。

下一步练习是对比一个均匀 BCS 模型与一个简单 BdG 模型的符号约定，并写清楚两者共享的假设。这是一项待完成计划，尚未执行计算。
"""),
]

CONTEXTS = [
    ("figure", "research.figure", "科研绘图",
     "为科研数据新建或实质性修改图表，包括比较曲线、标度分析和论文插图。仅讨论图中物理意义时不触发。",
     ["把有无自旋轨道耦合的能带画在同一张图上", "调整这张误差棒图的坐标轴和图例"],
     ["解释一张已有图片而不修改图片", "制作与科研数据无关的宣传插画"], ["png", "pdf", "svg"], [
         ("preferred", "未指定输出格式时，适合栅格呈现的科研图优先输出 PNG；论文排版或明确要求矢量时提供 PDF/SVG。", "用户没有明确指定格式。"),
         ("required", "标明坐标轴的物理量与单位；图例说明参数组，误差条说明其统计含义。", "图中包含数据、参数分组或误差估计。"),
         ("preferred", "同一物理量跨图保持一致配色，使用色觉友好的颜色并用线型辅助区分。", "需要比较多组数据或多幅图。"),
         ("required", "保留原始数据和独立制图脚本，说明筛选、归一化与拟合区间，不为美观隐藏不一致结果。", "涉及数据处理或拟合。"),
     ]),
    ("note", "research.note", "学术 note",
     "为用户撰写或实质性修改科研主题的 Markdown note，包含概念解释、方法推导或结果分析。",
     ["写一份从能带知识引入 Berry 曲率的 note", "把这次 Wannier 能带插值检查整理成学术笔记"],
     ["只翻译一个术语", "撰写面向完全不同读者的宣传文案"], ["markdown"], [
         ("required", "先查询与主题相关的 Persona 知识背景；对未记录或仅为 aware 的概念补充清楚的解释，并连接已有知识。", "为本 Demo 用户撰写专业 note。"),
         ("required", "新符号首次出现时给出定义，公式前后说明物理意义、假设和适用范围。", "出现公式、缩写或新记号。"),
         ("preferred", "用连贯段落展开论证，只在逻辑分组时使用列表，避免一句一行和不必要的换行。", "组织 note 正文。"),
         ("required", "分别说明来源中的结论、自己的推导和待验证的问题；引用材料时保留可定位的来源。", "汇总论文结论、数值结果或推测。"),
     ]),
    ("numerics", "research.numerics", "数值计算",
     "为凝聚态物理问题设计、编写、运行或检查数值计算，包含电子结构计算、张量网络模拟与计算任务准备。仅解释概念时不触发。",
     ["用张量网络计算自旋链的时间演化", "检查收敛后准备提交一组参数扫描任务"],
     ["只解释 MPS 的定义而不编写或运行计算", "只修改现有图片的字体与图例"], ["julia", "simulation-report"], [
         ("preferred", "张量网络算法优先采用 Julia 的 ITensor 生态：基础张量操作使用 ITensors.jl，MPS/MPO 与相关算法使用 ITensorMPS.jl。", "没有明确指定其他语言或既有算法框架。"),
         ("required", "大规模计算前先做小尺寸验证；在可行时与精确对角化对照能量或代表性观测量，并检查归一化和模型约定。", "新增算法实现或改变模型定义。"),
         ("required", "分别检查键维数、截断阈值、时间步长和系统尺寸的收敛，报告实际执行的检查及残余误差。", "使用近似算法或据此解释物理结果。"),
         ("required", "保存 Julia 版本、Project.toml、Manifest.toml、随机种子、参数文件和代码版本，让结果可以复现。", "运行并保存数值实验。"),
         ("required", "按 Demo 的虚构协议，通过 scripts/submit_job.sh 与参数文件准备提交；先检查脚本和 dry-run 能力，说明资源与输出路径。脚本缺失时明确说明，不假定真实集群存在此入口。", "准备提交批量或长时间计算；脚本名仅为 Demo 示例，不代表实际服务器配置。"),
         ("required", "使用独立 run ID 保存数据、日志和 checkpoint，不覆盖其他运行；恢复计算前核对模型、参数和依赖版本。", "保存结果或继续已有任务。"),
     ]),
]

SAMPLES = {
    "figure": (
        "# 正例：可重画的科研图\n\n输出 bands.png，横轴为注明晶胞约定的 Γ–M–K–Γ 路径，纵轴为 E−E_F（eV）。说明 E_F 的取值及能量对齐方式，有无自旋轨道耦合使用固定颜色并辅以线型。保留原始能带数据和 plot_bands.py。\n",
        "# 反例：信息缺失的科研图\n\n只交付一张截图，不标单位与误差含义；为使曲线重合删除不符合预期的点，也不保存处理与绘图代码。\n",
    ),
    "note": (
        "# 正例：从能带背景解释 BCS\n\n背景来源：Demo 的 Bloch 定理为 proficient，BCS 理论为 aware。材料来源：原创示例《给能带研究者的超导入门路线》“从配对到平均场”一节。先从正常态能带解释 ξₖ 是相对于化学势的能量，再定义 Δ 为配对能隙参数；公式 Eₖ=√(ξₖ²+|Δ|²) 仅针对这里的均匀单带 s 波平均场模型。这里没有执行新的计算，配对参数如何自洽求解保留为待学习问题。\n",
        "# 反例：跳过定义与证据\n\n显然所有系统都满足同一个标度。\n给任意能带加一个 Δ 就证明它是超导体。\n公式的符号无需解释。\n没有来源，但可以宣布已经验证。\n",
    ),
    "numerics": (
        "# 正例：可核查的计算计划\n\n使用 Julia、ITensors.jl 与 ITensorMPS.jl，保存项目依赖与随机种子。先在可由 ED 处理的尺寸检查能量、边界与归一化，再逐项扫描键维数、截断阈值和时间步长。\n\nDemo 虚构提交入口：scripts/submit_job.sh。先确认它存在并阅读参数说明；若支持 dry-run，再检查 configs/small.toml 对应的命令和资源。当前材料只描述流程，没有实际提交任务。结果以独立 run ID 保存，checkpoint 与参数一起校验。\n",
        "# 反例：不可复现的计算\n\n直接运行最大尺寸，任意替换算法框架，不设置随机种子；假定服务器存在 submit_job.sh 并声称已经提交。所有结果覆盖到 results/latest，失败后不核对参数直接读取旧 checkpoint。\n",
    ),
}


def base(model, identifier):
    return {"schema": model.expected_schema, "entity_type": model.expected_entity_type,
            "id": identifier, "status": "active", "revision": 1,
            "created_at": STAMP, "updated_at": STAMP}


def record(root, model, collection, identifier, body="", **values):
    item = model.model_validate({**base(model, identifier), **values})
    path = root / "records" / collection / f"{identifier}.md"
    path.write_text(dump_markdown_record(
        item.model_dump(mode="json", by_alias=True, exclude_none=True), body,
    ), encoding="utf-8")


def source(root, identifier, content, kind="article"):
    content = content.strip() + "\n"
    digest = hashlib.sha256(content.encode()).hexdigest()
    folder = root / "sources" / identifier
    folder.mkdir()
    (folder / "original.md").write_text(content, encoding="utf-8")
    manifest = SourceManifest.model_validate({
        "schema": "ai-persona.source-manifest/v2", "id": identifier,
        "source_type": kind, "imported_at": STAMP,
        "origin": {"provider": "ai-persona-synthetic-demo", "identifier": identifier,
                   "retrieved_at": STAMP},
        "canonical_file": "original.md", "content_hash": digest,
        "files": [{"path": "original.md", "role": "original",
                   "media_type": "text/markdown", "sha256": digest}],
    })
    (folder / "manifest.yaml").write_text(yaml.safe_dump(
        manifest.model_dump(mode="json", by_alias=True, exclude_none=True),
        allow_unicode=True, sort_keys=False,
    ), encoding="utf-8")
    return digest


def build(root):
    for directory in REQUIRED_DIRECTORIES:
        (root / directory).mkdir(parents=True, exist_ok=True)
    (root / "demo.json").write_text(json.dumps(DEMO_METADATA, indent=2) + "\n")
    (root / "config/persona.toml").write_text(
        f'[persona]\nid = "demo-{DEMO_VERSION}"\nrevision = 1\n'
        f'created_at = "{STAMP}"\ninclude_human_notes_in_snapshot = true\n',
    )
    (root / "revisions/changes.jsonl").write_text("")
    for slug, title in [("physics", "Physics")]:
        record(root, Tag, "tags", f"tag_{slug}", namespace="domain", slug=slug,
               label=title, aliases=["物理"])
    for slug, title, role, domain, level, interest, summary, parent in KNOWLEDGE:
        record(root, KnowledgeNode, "knowledge-nodes", f"kn_demo_{slug}",
               body="虚构画像：研究二维磁性与拓扑材料的博士生；熟悉晶体与 DFT，正在学习拓扑与超导。掌握程度和兴趣完全为演示设定。\n",
               title=title, semantic_role=role, knowledge_level=level,
               interest_level=interest, summary=summary, tags=[f"tag_{domain}"],
               scope_note="可在 Demo 中修改这一程度，观察 note 解释起点如何变化。")
        if parent:
            record(root, Relation, "relations", f"rel_demo_tree_{slug}",
                   source_id=f"kn_demo_{parent}", target_id=f"kn_demo_{slug}",
                   relation_type="broader_than")
    for src, dst in [("bloch", "reciprocal"), ("wannier", "bloch"), ("chern", "berry"),
                     ("spin_wave", "heisenberg"), ("bdg", "bcs")]:
        record(root, Relation, "relations", f"rel_demo_requires_{src}_{dst}",
               source_id=f"kn_demo_{src}", target_id=f"kn_demo_{dst}", relation_type="requires")
    for src, dst in [("wannier", "tight_binding"), ("spin_orbit", "anisotropy"),
                     ("berry", "quantum_hall"), ("tight_binding", "topology"),
                     ("ginzburg_landau", "vortex")]:
        record(root, Relation, "relations", f"rel_demo_applied_{src}_{dst}",
               source_id=f"kn_demo_{src}", target_id=f"kn_demo_{dst}", relation_type="applied_in")
    for i, (slug, title, covered, summary, content) in enumerate(ARTICLES):
        sid, mid, eid = f"src_demo_article_{slug}", f"mat_demo_{slug}", f"ev_demo_{slug}"
        digest = source(root, sid, content)
        record(root, Material, "materials", mid, body="原创示例文章，可公开体验阅读与审核。\n",
               material_type="article", title=title,
               bibliography={"authors": ["AI Persona Demo"], "language": "zh-CN",
                             "published_at": STAMP[:10], "venue": "原创演示短文"},
               user_relationships=["read" if i < 4 else "skimmed"],
               knowledge_level="familiar" if i in {0, 3} else "aware",
               preference_level="favorite" if i == 3 else "liked", summary=summary,
               preference_reasons=[{"aspect": "practicality", "note": "可用来练习科研阅读与任务组织。"}],
               tags=["tag_physics"],
               source_ref=sid, evidence_refs=[eid])
        record(root, Evidence, "evidence", eid,
               body="本条仅定位到原创 Demo 文章，不证明真实用户的掌握程度。\n",
               source_id=sid, source_hash=f"sha256:{digest}",
               locator={"file": "original.md", "line_start": 1,
                        "line_end": len(content.strip().splitlines())},
               supports=[mid], evidence_kind="authored_material", extraction_method="demo-seed")
        for j, topic in enumerate(covered):
            record(root, Relation, "relations", f"rel_demo_article_{slug}_{topic}",
                   source_id=mid, target_id=f"kn_demo_{topic}", relation_type="covers",
                   knowledge_role="topic" if j == 0 else "background",
                   salience="primary" if j < 2 else "secondary",
                   statement="本文用这个主题组织阅读或实践问题。")
    for slug, key, name, description, intents, excludes, artifact_types, rules in CONTEXTS:
        cid = f"pctx_demo_{slug}"
        record(root, PreferenceContext, "preference-contexts", cid, key=key, name=name,
               description=description, activation={"intents": intents, "excludes": excludes,
                                                     "artifact_types": artifact_types})
        for n, (behavior, instruction, condition) in enumerate(rules, 1):
            record(root, Preference, "preferences", f"pref_demo_{slug}_{n:02}",
                   scope="contexts", context_refs=[cid], behavior=behavior,
                   instruction=instruction, condition=condition, rationale="虚构的 Demo 用户偏好。")
        for polarity, content in zip(["positive", "negative"], SAMPLES[slug], strict=True):
            sid = f"src_demo_sample_{slug}_{polarity}"
            digest = source(root, sid, content, "other")
            record(root, PreferenceExample, "preference-examples", f"pex_demo_{slug}_{polarity}",
                   context_refs=[cid], example_type=polarity,
                   title=f"{name} · {'正例' if polarity == 'positive' else '反例'}",
                   condition=description, reasons=["对照本场景的规则检查信息、步骤与记录是否完整。"],
                   source_ref=sid, content_hash=f"sha256:{digest}")
    with tempfile.TemporaryDirectory(prefix="demo-compile-") as state:
        PersonaCompiler(root, Path(state)).build()


def main():
    # Refuse any existing data directory without the explicit Demo marker.
    if TARGET.exists() and not (TARGET / "demo.json").is_file():
        raise SystemExit("Refusing to replace a directory without a Demo marker")
    with tempfile.TemporaryDirectory(prefix="demo-seed-", dir=TARGET.parent) as staging:
        seed = Path(staging) / "persona-data"
        build(seed)
        if TARGET.exists():
            shutil.rmtree(TARGET)
        shutil.move(str(seed), TARGET)
    print(f"Built 30 knowledge nodes, 5 articles, 3 contexts, 14 rules and 6 samples: {TARGET}")


if __name__ == "__main__":
    main()
