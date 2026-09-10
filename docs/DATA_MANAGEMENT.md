# Data, backup, and migration / 数据、备份与迁移

Run these commands from the repository root. Use paths in your own home directory, outside the source checkout. Keeping a separate workspace makes code updates and repository sharing independent of your personal data.

以下命令在仓库根目录执行。工作区应位于源码之外；更新或分享代码无需移动你的私人数据。

## What belongs to a persona / 数据组成

| Location / 位置 | Contents and handling / 内容与处理 |
| --- | --- |
| `<workspace>/persona-data/records` | Effective knowledge, courses, materials, preferences, tags, relations, and evidence / 正式记录 |
| `<workspace>/persona-data/sources` | Original source bundles and manifests / 原始材料与清单 |
| `<workspace>/persona-data/proposals`, `revisions`, `config` | Pending candidates, review history, revisions, and workspace configuration / 候选、审核历史、版本与配置 |
| `<workspace>/persona-data/evaluations` | Personal feedback cases, frozen suites, and saved evaluation artifacts / 个人反馈样例、测试集与评测数据 |
| `<workspace>/persona-data/generated` | Rebuildable projections / 可重建投影 |
| `<workspace>/persona-state` | Derived indexes **and durable state**, including unpublished AI conversations/drafts and prompt experiments / 索引与持久状态，包括未发布对话、草稿及提示词实验 |
| External learning directory | Conversation-learning state associated with the workspace. Legacy installations may store it below `~/.local/share/ai-persona/learning/` / 工作区对应的外部学习状态 |
| Model account directory | Shared real-workspace model connections, normally `~/.local/share/ai-persona/models`; override with `AI_PERSONA_MODEL_DATA_DIR` / 真实工作区共享的模型连接 |
| Runtime/model cache | Downloaded dependencies and embedding models; rebuildable, separate from personal records / 可重新安装的运行依赖与模型缓存 |

Do not delete `persona-state` as a blanket cleanup step: some of its content cannot be rebuilt from formal records. The standard workspace backup includes workspace data/state and the associated learning store; global model credentials are not included. On a new machine, configure or authorize your model connections again.

不要把整个 `persona-state` 当缓存删除，其中部分内容无法从正式记录重建。工作区备份包含工作区数据、状态及对应学习库，不包含全局模型凭据。换机器后请重新配置模型连接。

## Prepare a consistent copy / 备份前准备

Wait for active work to finish. Close MCP clients and other processes that write to this workspace, stop automatic learning, and stop Studio before backup or migration. A running client can reconnect or write after Studio exits; stopping only the browser window is insufficient.

```sh
PERSONA_WORKSPACE="$HOME/PersonaWorkspaces/main"
./scripts/ai-persona learning stop-worker --workspace "$PERSONA_WORKSPACE"
./scripts/ai-persona stop --workspace "$PERSONA_WORKSPACE"
```

If the old installation owns those processes, stop them using that installation. Keep the source workspace untouched until you have verified a restored copy. Backups contain private text, sources, drafts, and history; keep the archive private.

请等待运行中的任务完成，关闭会写入该工作区的 MCP 客户端和其他进程，再停止学习 Worker 与 Studio。旧安装启动的进程应通过旧入口停止。备份含私人正文、材料、草稿与历史，不要提交到 GitHub。

## Back up / 备份

```sh
mkdir -p "$HOME/PersonaBackups"
./scripts/ai-persona backup \
  --workspace "$PERSONA_WORKSPACE" \
  --output "$HOME/PersonaBackups/main.tar.gz"
```

Backups are for real workspaces; the Demo has its own isolated copy. Save the archive outside the workspace and learning directories. Existing output files are never overwritten. Only identified runtime process markers, runtime logs/locks, and journal files for known databases are excluded; durable attachments are preserved even when named with `.log` or `.lock`. Database content is copied consistently.

If your learning store uses a custom location, add `--learning-dir /path/to/learning-store`. Use a new archive filename for each backup. Links to persistent data are refused rather than followed; identified runtime-log links are excluded. The command reports any prerequisites that must be resolved before a consistent backup can be made.

备份针对真实工作区，Demo 使用独立副本。备份文件应保存在工作区与学习库之外，不会覆盖已有文件；仅排除明确识别的运行日志、运行锁、进程标记及已知数据库的日志文件；持久附件即使以 `.log` 或 `.lock` 命名也按原内容保留。

自定义学习库可通过 `--learning-dir /path/to/learning-store` 显式指定。每次备份使用新文件名，并处理命令报告的前置条件。

## Restore into a new workspace / 恢复到新工作区

```sh
./scripts/ai-persona restore "$HOME/PersonaBackups/main.tar.gz" \
  --workspace "$HOME/PersonaWorkspaces/restored"
./scripts/ai-persona validate --workspace "$HOME/PersonaWorkspaces/restored"
./scripts/ai-persona start --workspace "$HOME/PersonaWorkspaces/restored"
```

Choose a new destination. Restore does not overwrite an existing workspace. Inspect the knowledge and materials, review history, drafts, feedback cases, and learning history before making the restored copy your default. Application access and automatic features must be reviewed and re-enabled for the new location.

目标必须是新目录，不会覆盖已有工作区。验证知识材料、审核历史、草稿、反馈样例与学习历史后，再决定是否设为默认。恢复后的应用接入与自动功能需要按新位置重新启用。

```sh
./scripts/ai-persona configure --workspace "$HOME/PersonaWorkspaces/restored"
```

## Migrate an existing installation / 迁移旧安装

Migration makes a separate copy and leaves the source workspace in place. Point `--from` at the folder containing both `persona-data` and `persona-state`, not at the code package or just the records directory.

```sh
./scripts/ai-persona migrate \
  --from "$HOME/ExistingPersona" \
  --workspace "$HOME/PersonaWorkspaces/migrated"
./scripts/ai-persona validate --workspace "$HOME/PersonaWorkspaces/migrated"
./scripts/ai-persona start --workspace "$HOME/PersonaWorkspaces/migrated"
```

Add `--learning-dir /path/to/learning-store` when the old installation uses a custom learning directory. The learning data is associated with the new workspace path during migration. The original source is not deleted or renamed. Revisit **Settings → Application access** and **Automatic features** to reconnect and enable only the features you want.

迁移采用复制方式；`--from` 指向包含 `persona-data` 与 `persona-state` 的旧工作区。学习数据随新工作区重新关联，原数据不删除、不改名。新工作区需要重新检查接入与自动功能。若只是继续使用原目录，也可在设置向导中选择「打开现有工作区」，但这不会产生独立迁移副本。

## Update or remove the application / 更新与移除

Before updating, back up your workspace and stop active writers and services. Update the source checkout using your normal Git workflow, then run the launcher. It uses the application lockfile. Run `models-install` if diagnostics report that the optional runtime for the new version is missing; runtime dependencies and model accounts are stored outside the Python package.

```sh
./scripts/ai-persona doctor --workspace "$PERSONA_WORKSPACE"
./scripts/ai-persona models-install
./scripts/ai-persona start --workspace "$PERSONA_WORKSPACE"
```

There is no all-in-one uninstall command. To remove this checkout, first stop Studio, learning, the model service, and any remote tunnel. Remove only AI Persona's entries from the application clients you configured, preserving unrelated integrations. A separate global installation can be removed with the package manager that installed it. The source checkout, personal workspaces, model accounts, and caches are separate locations; removing code does not imply deleting personal data.

更新前先备份并停止写入；更新源码后由启动器使用锁定环境运行，诊断提示缺少新版模型依赖时再执行 `models-install`。本版没有一键卸载命令；移除代码前应停止相关服务，并只移除客户端中属于 AI Persona 的接入条目。代码、工作区、模型账号和缓存分别保存，不会因删除源码而自动删除私人数据。
