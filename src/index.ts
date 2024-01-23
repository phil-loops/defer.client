import {
  Backend,
  CancelExecutionResult,
  EnqueueResult,
  GetExecutionResult,
  ReRunExecutionResult,
  RescheduleExecutionResult,
} from "./backend.js";
import * as localBackend from "./backend/local.js";
import * as remoteBackend from "./backend/remote.js";
import { info, warn } from "./logger.js";
import { Duration, fromDurationToDate, getEnv, stringify } from "./utils.js";

const INTERNAL_VERSION = 6;
const RETRY_MAX_ATTEMPTS_PLACEHOLDER = 13;

export let backend: Backend = remoteBackend;
if (getEnv("DEFER_TOKEN") === undefined) {
  backend = localBackend;
  if (getEnv("DEFER_NO_LOCAL_SCHEDULER") === undefined) localBackend.start();
}

export const deferEnabled = () => !!getEnv("DEFER_TOKEN");

export interface ExecutionMetadata {
  [key: string]: string;
}

// https://stackoverflow.com/questions/39494689/is-it-possible-to-restrict-number-to-a-certain-range/70307091#70307091
type Enumerate<
  N extends number,
  Acc extends number[] = []
> = Acc["length"] extends N
  ? Acc[number]
  : Enumerate<N, [...Acc, Acc["length"]]>;

type Range<F extends number, T extends number> = Exclude<
  Enumerate<T>,
  Enumerate<F>
>;

export type Concurrency = Range<0, 51>;

export type NextRouteString = `/api/${string}`;

export interface Manifest {
  name: string;
  version: number;
  cron?: string;
  retry?: RetryPolicy;
  concurrency?: Concurrency | undefined;
  maxDuration?: number | undefined;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialInterval: number;
  randomizationFactor: number;
  multiplier: number;
  maxInterval: number;
}

export type DeferableFunction = (...args: any) => Promise<any>;

export interface ExecutionOptions {
  delay?: Duration | Date;
  metadata?: ExecutionMetadata;
  discardAfter?: Duration | Date;
}

export interface DeferredFunction<F extends DeferableFunction> {
  (...args: Parameters<F>): Promise<EnqueueResult>;
  __metadata: Manifest;
  __fn: F;
  __execOptions?: ExecutionOptions;
}

export interface DeferredFunctionConfiguration {
  retry?: boolean | number | Partial<RetryPolicy>;
  concurrency?: Concurrency;
  maxDuration?: number;
  maxConcurrencyAction?: "keep" | "cancel";
}

function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 0,
    initialInterval: 30,
    randomizationFactor: 0.5,
    multiplier: 1.5,
    maxInterval: 60 * 10,
  };
}

function parseRetryPolicy(
  options?: DeferredFunctionConfiguration
): RetryPolicy {
  const retryPolicy: RetryPolicy = defaultRetryPolicy();
  switch (typeof options?.retry) {
    case "boolean": {
      if (options.retry) {
        retryPolicy.maxAttempts = RETRY_MAX_ATTEMPTS_PLACEHOLDER;
      }
      break;
    }
    case "number": {
      retryPolicy.maxAttempts = options.retry;
      break;
    }
    case "object": {
      if (options.retry.maxAttempts) {
        retryPolicy.maxAttempts = options.retry.maxAttempts;
      } else {
        options.retry.maxAttempts = RETRY_MAX_ATTEMPTS_PLACEHOLDER;
      }

      if (options.retry.initialInterval)
        retryPolicy.initialInterval = options.retry.initialInterval;

      if (options.retry.randomizationFactor)
        retryPolicy.randomizationFactor = options.retry.randomizationFactor;

      if (options.retry.multiplier)
        retryPolicy.multiplier = options.retry.multiplier;

      if (options.retry.maxInterval)
        retryPolicy.maxInterval = options.retry.maxInterval;

      break;
    }
    case "undefined": {
      retryPolicy.maxAttempts = 0;
      break;
    }
    default: {
      throw new Error("invalid retry options");
    }
  }

  return retryPolicy;
}

async function enqueue<F extends DeferableFunction>(
  func: DeferredFunction<F>,
  ...args: Parameters<F>
): Promise<EnqueueResult> {
  let scheduleFor: Date;
  let discardAfter: Date | undefined;

  const delay = func.__execOptions?.delay;
  if (delay instanceof Date) {
    scheduleFor = delay;
  } else if (delay) {
    const now = new Date();
    scheduleFor = fromDurationToDate(now, delay);
  } else {
    scheduleFor = new Date();
  }

  const after = func.__execOptions?.discardAfter;
  if (after instanceof Date) {
    discardAfter = after;
  } else if (after) {
    const now = new Date();
    discardAfter = fromDurationToDate(now, after);
  }

  const response = await backend.enqueue(
    func,
    stringify(args),
    scheduleFor,
    discardAfter
  );

  info("execution enqueued", { id: response.id, function: func.__fn.name });

  return response;
}

export function defer<F extends DeferableFunction>(
  fn: F,
  config?: DeferredFunctionConfiguration
): DeferredFunction<F> {
  const wrapped = async (
    ...args: Parameters<typeof fn>
  ): Promise<EnqueueResult> => enqueue(wrapped, ...args);
  wrapped.__fn = fn;
  wrapped.__metadata = {
    name: fn.name,
    version: INTERNAL_VERSION,
    retry: parseRetryPolicy(config),
    concurrency: config?.concurrency,
    maxDuration: config?.maxDuration,
    maxConcurrencyAction: config?.maxConcurrencyAction,
  };

  return wrapped;
}

defer.cron = function (
  fn: DeferableFunction,
  cronExpr: string,
  config?: DeferredFunctionConfiguration
): DeferredFunction<typeof fn> {
  const wrapped = async (
    ...args: Parameters<typeof fn>
  ): Promise<EnqueueResult> => enqueue(wrapped, ...args);

  wrapped.__fn = fn;
  wrapped.__metadata = {
    name: fn.name,
    version: INTERNAL_VERSION,
    retry: parseRetryPolicy(config),
    cron: cronExpr,
    concurrency: config?.concurrency,
    maxDuration: config?.maxDuration,
    maxConcurrencyAction: config?.maxConcurrencyAction,
  };

  return wrapped;
};

/**
 * Delay an execution
 * @param fn Duration
 * @param delay Duration | Date
 * @deprecated Prefer `assignOptions()` (https://www.defer.run/docs/references/defer-client/assign-options)
 * @returns
 */
export function delay<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  delay: Duration | Date
): DeferredFunction<F> {
  return assignOptions(fn, { delay });
}

/**
 * Add metadata to an execution
 * @param fn Duration
 * @param metadata Object
 * @deprecated Prefer `assignOptions()` (https://www.defer.run/docs/references/defer-client/assign-options)
 * @returns
 */
export function addMetadata<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  metadata: ExecutionMetadata
): DeferredFunction<F> {
  return assignOptions(fn, { metadata });
}

/**
 * Discard an execution if not started after a given interval
 * @param fn Duration
 * @param value Duration | Date
 * @deprecated Prefer `assignOptions()` (https://www.defer.run/docs/references/defer-client/assign-options)
 * @returns
 */
export function discardAfter<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  value: Duration | Date
): DeferredFunction<F> {
  return assignOptions(fn, { discardAfter: value });
}

export function assignOptions<F extends DeferableFunction>(
  fn: DeferredFunction<F>,
  options: ExecutionOptions
): DeferredFunction<F> {
  const wrapped = async (
    ...args: Parameters<typeof fn>
  ): Promise<EnqueueResult> => enqueue(wrapped, ...args);

  wrapped.__fn = fn.__fn;
  wrapped.__metadata = fn.__metadata;
  wrapped.__execOptions = { ...fn.__execOptions, ...options };
  return wrapped;
}

export function awaitResult<F extends DeferableFunction>(
  fn: DeferredFunction<F>
): (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>>> {
  return async function (
    ...args: Parameters<F>
  ): Promise<Awaited<ReturnType<F>>> {
    const originalFunction = fn.__fn;
    const functionArguments = sanitizeFunctionArguments(args);
    const httpClient = getHTTPClient();

    let response: client.FetchExecutionResponse;
    if (httpClient) {
      const { id } = await client.enqueueExecution(httpClient, {
        name: originalFunction.name,
        arguments: functionArguments,
        scheduleFor: new Date(),
        metadata: {},
      });
      response = await client.waitExecutionResult(httpClient, { id: id });
    } else {
      const id = randomUUID();
      __database.set(id, { id: id, state: "started" });
      response = await execLocally(id, fn, functionArguments);
    }

    if (response.state === "failed") {
      let error = new DeferError("Defer execution failed");
      if (response.result?.message) {
        error = new DeferError(response.result.message);
        error.stack = response.result.stack;
      } else if (response.result) {
        error = response.result;
      }
      throw error;
    }

    return response.result;
  };
}

export async function getExecution(id: string): Promise<GetExecutionResult> {
  return backend.getExecution(id);
}

export async function cancelExecution(
  id: string,
  force = false
): Promise<CancelExecutionResult> {
  return backend.cancelExecution(id, force);
}

export async function rescheduleExecution(
  id: string,
  value: Duration | Date | undefined
): Promise<RescheduleExecutionResult> {
  const now = new Date();
  let scheduleFor: Date;

  if (value instanceof Date) {
    scheduleFor = value;
  } else if (value) {
    scheduleFor = fromDurationToDate(now, value);
  } else {
    scheduleFor = now;
  }

  return backend.rescheduleExecution(id, scheduleFor);
}

export async function reRunExecution(
  id: string
): Promise<ReRunExecutionResult> {
  return backend.reRunExecution(id);
}

export async function getExecutionTries(id: string): Promise<any> {
  warn(
    `"getExecutionTries/1" is deprecated and will be removed in future versions. Please use "listExecutionAttempts/2" instead.`
  );
  listExecutionAttemps(id);
}

export async function listExecutionAttemps(id: string): Promise<any> {
  console.log(id);
}

export async function listExecutions(): Promise<any> {}
