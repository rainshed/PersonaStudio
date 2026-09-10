# 正例：可核查的计算计划

使用 Julia、ITensors.jl 与 ITensorMPS.jl，保存项目依赖与随机种子。先在可由 ED 处理的尺寸检查能量、边界与归一化，再逐项扫描键维数、截断阈值和时间步长。

Demo 虚构提交入口：scripts/submit_job.sh。先确认它存在并阅读参数说明；若支持 dry-run，再检查 configs/small.toml 对应的命令和资源。当前材料只描述流程，没有实际提交任务。结果以独立 run ID 保存，checkpoint 与参数一起校验。
