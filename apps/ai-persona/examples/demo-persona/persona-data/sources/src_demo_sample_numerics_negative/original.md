# 反例：不可复现的计算

直接运行最大尺寸，任意替换算法框架，不设置随机种子；假定服务器存在 submit_job.sh 并声称已经提交。所有结果覆盖到 results/latest，失败后不核对参数直接读取旧 checkpoint。
