# Preferences

## Contexts

- **学术 note** — `research.note`; 为用户撰写或实质性修改科研主题的 Markdown note，包含概念解释、方法推导或结果分析。
- **数值计算** — `research.numerics`; 为凝聚态物理问题设计、编写、运行或检查数值计算，包含电子结构计算、张量网络模拟与计算任务准备。仅解释概念时不触发。
- **科研绘图** — `research.figure`; 为科研数据新建或实质性修改图表，包括比较曲线、标度分析和论文插图。仅讨论图中物理意义时不触发。

## Preferences

### 未指定输出格式时，适合栅格呈现的科研图优先输出 PNG；论文排版或明确要求矢量时提供 PDF/SVG。

- Behavior: `preferred`
- Scope: 科研绘图
- Status: `active`
- Condition: 用户没有明确指定格式。
- Rationale: 虚构的 Demo 用户偏好。
### 标明坐标轴的物理量与单位；图例说明参数组，误差条说明其统计含义。

- Behavior: `required`
- Scope: 科研绘图
- Status: `active`
- Condition: 图中包含数据、参数分组或误差估计。
- Rationale: 虚构的 Demo 用户偏好。
### 同一物理量跨图保持一致配色，使用色觉友好的颜色并用线型辅助区分。

- Behavior: `preferred`
- Scope: 科研绘图
- Status: `active`
- Condition: 需要比较多组数据或多幅图。
- Rationale: 虚构的 Demo 用户偏好。
### 保留原始数据和独立制图脚本，说明筛选、归一化与拟合区间，不为美观隐藏不一致结果。

- Behavior: `required`
- Scope: 科研绘图
- Status: `active`
- Condition: 涉及数据处理或拟合。
- Rationale: 虚构的 Demo 用户偏好。
### 先查询与主题相关的 Persona 知识背景；对未记录或仅为 aware 的概念补充清楚的解释，并连接已有知识。

- Behavior: `required`
- Scope: 学术 note
- Status: `active`
- Condition: 为本 Demo 用户撰写专业 note。
- Rationale: 虚构的 Demo 用户偏好。
### 新符号首次出现时给出定义，公式前后说明物理意义、假设和适用范围。

- Behavior: `required`
- Scope: 学术 note
- Status: `active`
- Condition: 出现公式、缩写或新记号。
- Rationale: 虚构的 Demo 用户偏好。
### 用连贯段落展开论证，只在逻辑分组时使用列表，避免一句一行和不必要的换行。

- Behavior: `preferred`
- Scope: 学术 note
- Status: `active`
- Condition: 组织 note 正文。
- Rationale: 虚构的 Demo 用户偏好。
### 分别说明来源中的结论、自己的推导和待验证的问题；引用材料时保留可定位的来源。

- Behavior: `required`
- Scope: 学术 note
- Status: `active`
- Condition: 汇总论文结论、数值结果或推测。
- Rationale: 虚构的 Demo 用户偏好。
### 张量网络算法优先采用 Julia 的 ITensor 生态：基础张量操作使用 ITensors.jl，MPS/MPO 与相关算法使用 ITensorMPS.jl。

- Behavior: `preferred`
- Scope: 数值计算
- Status: `active`
- Condition: 没有明确指定其他语言或既有算法框架。
- Rationale: 虚构的 Demo 用户偏好。
### 大规模计算前先做小尺寸验证；在可行时与精确对角化对照能量或代表性观测量，并检查归一化和模型约定。

- Behavior: `required`
- Scope: 数值计算
- Status: `active`
- Condition: 新增算法实现或改变模型定义。
- Rationale: 虚构的 Demo 用户偏好。
### 分别检查键维数、截断阈值、时间步长和系统尺寸的收敛，报告实际执行的检查及残余误差。

- Behavior: `required`
- Scope: 数值计算
- Status: `active`
- Condition: 使用近似算法或据此解释物理结果。
- Rationale: 虚构的 Demo 用户偏好。
### 保存 Julia 版本、Project.toml、Manifest.toml、随机种子、参数文件和代码版本，让结果可以复现。

- Behavior: `required`
- Scope: 数值计算
- Status: `active`
- Condition: 运行并保存数值实验。
- Rationale: 虚构的 Demo 用户偏好。
### 按 Demo 的虚构协议，通过 scripts/submit_job.sh 与参数文件准备提交；先检查脚本和 dry-run 能力，说明资源与输出路径。脚本缺失时明确说明，不假定真实集群存在此入口。

- Behavior: `required`
- Scope: 数值计算
- Status: `active`
- Condition: 准备提交批量或长时间计算；脚本名仅为 Demo 示例，不代表实际服务器配置。
- Rationale: 虚构的 Demo 用户偏好。
### 使用独立 run ID 保存数据、日志和 checkpoint，不覆盖其他运行；恢复计算前核对模型、参数和依赖版本。

- Behavior: `required`
- Scope: 数值计算
- Status: `active`
- Condition: 保存结果或继续已有任务。
- Rationale: 虚构的 Demo 用户偏好。

## Reference Examples

- **科研绘图 · 反例** — `negative`; contexts=科研绘图; file=`src_demo_sample_figure_negative`; status=`active` (`pex_demo_figure_negative`)
- **科研绘图 · 正例** — `positive`; contexts=科研绘图; file=`src_demo_sample_figure_positive`; status=`active` (`pex_demo_figure_positive`)
- **学术 note · 反例** — `negative`; contexts=学术 note; file=`src_demo_sample_note_negative`; status=`active` (`pex_demo_note_negative`)
- **学术 note · 正例** — `positive`; contexts=学术 note; file=`src_demo_sample_note_positive`; status=`active` (`pex_demo_note_positive`)
- **数值计算 · 反例** — `negative`; contexts=数值计算; file=`src_demo_sample_numerics_negative`; status=`active` (`pex_demo_numerics_negative`)
- **数值计算 · 正例** — `positive`; contexts=数值计算; file=`src_demo_sample_numerics_positive`; status=`active` (`pex_demo_numerics_positive`)
