export class SyncError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LeaseLostError extends SyncError {
  constructor(key: string) {
    super(`Lease for sync '${key}' was lost or expired; checkpoint was not committed.`);
  }
}

export class InvalidPageError extends SyncError {}

export class CheckpointInvalidError extends SyncError {
  constructor(message: string, readonly recovery: "restart-scan" | "full-resync" | "application" = "application") {
    super(message);
  }
}

/** Throw from fetchPage() when the upstream provider returns a retryable response. */
export class HttpResponseError extends SyncError {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class AbortSyncError extends SyncError {
  constructor() {
    super("Sync was aborted");
  }
}
