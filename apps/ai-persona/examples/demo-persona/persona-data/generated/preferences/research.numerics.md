# Personal Preferences: 数值计算

- Context key: `research.numerics`
- Content hash: `sha256:9e31a6371c0efd7c089eee321fed85e8c19bc979b65632c1b5201033015f81e2`


## Required

- `pref_demo_numerics_02` — 大规模计算前先做小尺寸验证；在可行时与精确对角化对照能量或代表性观测量，并检查归一化和模型约定。
  - When: 新增算法实现或改变模型定义。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_numerics_03` — 分别检查键维数、截断阈值、时间步长和系统尺寸的收敛，报告实际执行的检查及残余误差。
  - When: 使用近似算法或据此解释物理结果。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_numerics_04` — 保存 Julia 版本、Project.toml、Manifest.toml、随机种子、参数文件和代码版本，让结果可以复现。
  - When: 运行并保存数值实验。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_numerics_05` — 按 Demo 的虚构协议，通过 scripts/submit_job.sh 与参数文件准备提交；先检查脚本和 dry-run 能力，说明资源与输出路径。脚本缺失时明确说明，不假定真实集群存在此入口。
  - When: 准备提交批量或长时间计算；脚本名仅为 Demo 示例，不代表实际服务器配置。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_numerics_06` — 使用独立 run ID 保存数据、日志和 checkpoint，不覆盖其他运行；恢复计算前核对模型、参数和依赖版本。
  - When: 保存结果或继续已有任务。
  - Why: 虚构的 Demo 用户偏好。

## Preferred

- `pref_demo_numerics_01` — 张量网络算法优先采用 Julia 的 ITensor 生态：基础张量操作使用 ITensors.jl，MPS/MPO 与相关算法使用 ITensorMPS.jl。
  - When: 没有明确指定其他语言或既有算法框架。
  - Why: 虚构的 Demo 用户偏好。

## Avoid

No active preferences.

## Reference Examples

- `pex_demo_numerics_negative` — 数值计算 · 反例 (negative)
  - File: `sources/src_demo_sample_numerics_negative/original.md`
  - Original filename: `src_demo_sample_numerics_negative`
  - Content hash: `sha256:cf5fd51711d857715695a87ef50affd9870059a227dfc32e4ffa16795914eed3`
  - When: 为凝聚态物理问题设计、编写、运行或检查数值计算，包含电子结构计算、张量网络模拟与计算任务准备。仅解释概念时不触发。
  - 对照本场景的规则检查信息、步骤与记录是否完整。
- `pex_demo_numerics_positive` — 数值计算 · 正例 (positive)
  - File: `sources/src_demo_sample_numerics_positive/original.md`
  - Original filename: `src_demo_sample_numerics_positive`
  - Content hash: `sha256:4478383effc9ec19f3f603bd3c473a750cc489f75635792dbc3796df043c4854`
  - When: 为凝聚态物理问题设计、编写、运行或检查数值计算，包含电子结构计算、张量网络模拟与计算任务准备。仅解释概念时不触发。
  - 对照本场景的规则检查信息、步骤与记录是否完整。

## Final Check

- [ ] 大规模计算前先做小尺寸验证；在可行时与精确对角化对照能量或代表性观测量，并检查归一化和模型约定。
- [ ] 分别检查键维数、截断阈值、时间步长和系统尺寸的收敛，报告实际执行的检查及残余误差。
- [ ] 保存 Julia 版本、Project.toml、Manifest.toml、随机种子、参数文件和代码版本，让结果可以复现。
- [ ] 按 Demo 的虚构协议，通过 scripts/submit_job.sh 与参数文件准备提交；先检查脚本和 dry-run 能力，说明资源与输出路径。脚本缺失时明确说明，不假定真实集群存在此入口。
- [ ] 使用独立 run ID 保存数据、日志和 checkpoint，不覆盖其他运行；恢复计算前核对模型、参数和依赖版本。
