import type { NextFunction, Response } from "express";

/**
 * Separates a rejected request from a broken server, at the boundary.
 *
 * Several routes ended in `catch (error: any) { response.status(400).json({ error: error.message }) }`.
 * That shape is wrong in both directions at once:
 *
 * - A database outage, a driver bug or a provider timeout answered **400**, telling the caller
 *   it had sent something invalid. The dashboard duly rendered "Client has encountered a
 *   connection error" as though the user had mistyped a field, and nothing was logged, because
 *   the request never reached `errorHandler`.
 * - `error.message` went to the browser verbatim, so a Postgres failure could put a connection
 *   string, a schema name or a driver stack hint on the wire.
 *
 * Converting every one of them to `next(error)` would trade the bug for its mirror image: these
 * routes really do rely on domain functions throwing for things the caller can fix -- an
 * unknown account, insufficient capital, a lot-size violation -- and those deserve their 4xx and
 * their message.
 *
 * So the discriminator is the error's *origin*, not its text. `pg` stamps every server-side
 * failure with a five-character SQLSTATE in `code`, and connection failures surface as
 * `Error` with a `code` from Node's networking layer. Anything carrying one of those is
 * infrastructure and goes to `errorHandler` as a 500; anything else is treated as the domain
 * rejection the route was already reporting.
 */

/** SQLSTATE is five alphanumerics. Node's socket errors are shouty identifiers like ECONNREFUSED. */
function isInfrastructureFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return /^[0-9A-Z]{5}$/.test(code) || /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/.test(code);
}

/**
 * Answers a domain rejection with `status`, or hands an infrastructure failure to `errorHandler`.
 *
 * `fallbackMessage` is used when the thrown value carries no usable message, so a caller never
 * receives an empty error body.
 */
export function respondToRouteError(
  error: unknown,
  response: Response,
  next: NextFunction,
  status: number,
  fallbackMessage: string,
): void {
  if (isInfrastructureFailure(error)) {
    next(error);
    return;
  }
  const message = error instanceof Error && error.message !== "" ? error.message : fallbackMessage;
  response.status(status).json({ error: message });
}
