export const PROTOCOL = 'paper-radar-harness/v1';
export class BridgeError extends Error {
  constructor(code, message, retryable = false, httpStatus = 400) {
    super(message); this.code = code; this.retryable = retryable; this.httpStatus = httpStatus;
  }
}
