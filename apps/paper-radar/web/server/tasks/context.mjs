import { AsyncLocalStorage } from 'node:async_hooks';

// Context follows a task across optional tools and model calls without changing
// frozen model settings, prompt identities or the agent's reading strategy.
export const taskContext = new AsyncLocalStorage();
export const taskPriority = () => taskContext.getStore()?.priority ?? 10;
export const withTaskContext = (context, operation) =>
  taskContext.run(context, operation);
