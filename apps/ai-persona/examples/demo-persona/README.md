# Demo Persona

这里是 `condensed-matter-v3` 的只读分发模板，随 Python 安装包一起提供。应用将其复制到专用体验目录后运行。

## 虚构研究者

一位研究二维磁性与拓扑材料的博士生，熟悉晶体结构与 DFT，能建立紧束缚模型；正在补充 Berry 几何、自旋波和超导理论。文章、知识程度和阅读记录均为独立编写的虚构设定。

30 个知识点包括 1 个总领域和以下五个分支（分支标题也计为知识点）：

| 分支 | 数量 | 子知识点 |
| --- | ---: | --- |
| 晶体结构与晶格动力学 | 5 | 布拉菲晶格与原胞、倒易晶格与布里渊区、Bloch 定理、声子与动力学矩阵 |
| 电子结构计算 | 7 | 紧束缚模型、费米面、态密度与轨道投影、DFT、Kohn–Sham 方程、Wannier 函数与能带插值 |
| 局域磁矩与磁性 | 5 | 交换相互作用、Heisenberg 自旋模型、线性自旋波理论、磁各向异性 |
| 拓扑能带理论 | 6 | Berry 相位与曲率、Chern 数、整数量子霍尔效应、时间反演对称拓扑绝缘体、自旋轨道耦合 |
| 超导物理 | 6 | Cooper 配对、BCS 理论、BdG 方程、Ginzburg–Landau 理论、第二类超导体与磁通涡旋 |

## 内容

- 30 个知识点：以凝聚态物理为根，覆盖晶体与晶格动力学、电子结构、磁性、拓扑和超导；整套知识目录独立编写，掌握程度与兴趣为虚构配置。
- 5 篇原创示例文章，带完整 Markdown 原文、Source hash、材料关系与证据定位；不是私有论文的副本。
- 68 条关系，连接知识层级、前置方法、应用方向和文章主题。
- 3 个偏好场景，每个场景都有正例和反例，共 6 份参考样例。

| 场景 | 规则数 | 主要内容 |
| --- | ---: | --- |
| 科研绘图 | 4 | 输出格式、坐标与误差含义、配色、数据与制图脚本 |
| 学术 note | 4 | 根据知识背景组织解释、首次定义符号、连贯段落、来源与待验证问题 |
| 数值计算 | 6 | Julia ITensor、小尺寸基准、收敛、可复现环境、提交协议、运行记录 |

数值计算采用 `ITensors.jl` 与 `ITensorMPS.jl` 的分工，见 [ITensorMPS 官方教程](https://itensor.github.io/ITensorMPS.jl/stable/tutorials/DMRG.html)。`scripts/submit_job.sh`、`configs/small.toml` 等名称是**虚构的 Demo 项目约定**，并未安装任何集群提交脚本。规则明确要求先核实脚本与参数，不能假装已经提交任务。

## 体验

在安装本项目的环境中运行：

```bash
ai-persona start --demo
```

默认打开 <http://127.0.0.1:8766>。建议按下面的路线体验：

1. 在“我的知识”查看五个研究分支，以及 Wannier 函数、紧束缚模型和拓扑能带之间的关系，修改一个知识点的掌握程度。
2. 在“材料”打开《从 DFT 能带到 Wannier 有效模型》，查看原文和关联知识。
3. 在“我的偏好”查看三个场景的触发条件、规则及正反样例。
4. 配置独立的 Demo 模型连接后，打开 `/preferences/try`，输入“用张量网络计算自旋链的时间演化”，检查数值计算场景的匹配结果。
5. 在 AI 维护助手中提出一项修改，在反馈与审核中确认后，检查该变化已进入 Demo 记录。

## 隔离与数据位置

- 模板：本目录下的 `persona-data/`，交互操作不会修改它。
- 体验副本：默认 `~/.local/share/ai-persona/demo/condensed-matter-v3/`；`XDG_DATA_HOME` 和 `AI_PERSONA_DEMO_HOME` 可改变父目录。
- Demo 的数据、索引、草稿、评测、模型账号和运行日志均位于体验副本；通用模型权重缓存可与正式环境复用。
- 再次运行会保留当前版本的 Demo 修改，不会复制或覆盖正式人格。此版使用新的专用目录；旧版 `research-v2` 副本保留，不会混入新画像。
- Demo 不安装真实 Hook、不采集真实会话，也不继承正式 Studio 的远端访问配置；仍支持自己的 MCP 查询与待审核提案。
- `ai-persona stop --demo` 只停止 Demo Studio；`ai-persona models-stop --demo` 只停止 Demo 模型服务。
- Demo MCP 使用 `ai-persona-mcp --demo`，审核链接优先使用已验证的同一 Demo Studio 地址，未运行时默认指向 8766。也可显式传入 `--review-base-url`。

## 维护

在源码目录执行 `PYTHONPATH=src .venv/bin/python scripts/build_demo.py`，确定性重建分发模板。脚本只包含公开的虚构示例，不读取真实用户目录。旧的小型数据集保留在 `tests/fixtures/legacy-demo` 作为固定回归夹具，不参与 Demo 运行或 wheel 分发。
