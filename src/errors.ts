// oxlint-disable max-classes-per-file -- The two error classes are one concept: how a command fails.

/** Invalid usage or an invalid manifest. The CLI exits with code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** A valid request that could not be completed. The CLI exits with code 1. */
export class OperationError extends Error {
  override name = "OperationError";
}
