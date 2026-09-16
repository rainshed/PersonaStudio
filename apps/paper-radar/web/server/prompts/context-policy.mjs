// Frozen with every new task; old snapshots keep their original input builder.
export const TASK_CONTEXT_POLICY = 'editable-task-instructions/v1';
export const usesEditableGoals = (snapshot) =>
  snapshot?.context_policy === TASK_CONTEXT_POLICY;
