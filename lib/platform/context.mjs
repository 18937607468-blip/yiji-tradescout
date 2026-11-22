import { AsyncLocalStorage } from "node:async_hooks";
export const platformContext = new AsyncLocalStorage();
export function currentContext() {
  const context = platformContext.getStore();
  if (!context) throw new Error("Platform request context is missing.");
  return context;
}
export function withPlatformContext(context, callback) { return platformContext.run(context, callback); }
