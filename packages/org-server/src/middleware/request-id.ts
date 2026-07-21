import type { MiddlewareHandler } from "hono";

export const requestId: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id =
    incoming && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}
