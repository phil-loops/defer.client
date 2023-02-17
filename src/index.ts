/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Units } from "parse-duration";
// @ts-expect-error untyped dep
import getCronString from "@darkeyedevelopers/natural-cron.js";
import { DOMAIN, INTERNAL_VERSION, PATH, TOKEN_ENV_NAME } from "./constants.js";
import {
  DeferExecuteResponse,
  executeBackgroundFunction,
  poolForExecutionResult,
  serializeBackgroundFunctionArguments,
} from "./execute.js";
import { makeFetcher } from "./fetcher.js";

export type { DeferExecuteResponse } from "./execute.js";

interface Options {
  apiToken?: string;
  apiUrl?: string;
  debug?: boolean;
}

let token: string | undefined = process.env[TOKEN_ENV_NAME];
let apiEndpoint = `${DOMAIN}${PATH}`;

let debug = false;

let fetcher = token ? makeFetcher(apiEndpoint, token) : undefined;

export const init = ({ apiToken, apiUrl, debug: debugValue }: Options) => {
  token = apiToken || process.env[TOKEN_ENV_NAME];
  apiEndpoint = apiUrl || `${DOMAIN}${PATH}`;
  debug = debugValue || debug;
  fetcher = token ? makeFetcher(apiEndpoint, token) : undefined;
};

export type UnPromise<F> = F extends Promise<infer R> ? R : F;

export type DelayString = `${string}${Units}`;
export interface DeferExecutionOptions {
  delay: DelayString | Date;
}

export type DeferRetFnParameters<
  F extends (...args: any | undefined) => Promise<any>
> = [...first: Parameters<F>, options: DeferExecutionOptions];

export type RetryNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type Concurrency =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31
  | 32
  | 33
  | 34
  | 35
  | 36
  | 37
  | 38
  | 39
  | 40
  | 41
  | 42
  | 43
  | 44
  | 45
  | 46
  | 47
  | 48
  | 49
  | 50;

export interface HasDeferMetadata {
  __metadata: {
    version: number;
    cron?: string;
    retry?: RetryNumber;
    concurrency?: Concurrency;
  };
}

export interface DeferRetFn<
  F extends (...args: any | undefined) => Promise<any>
> extends HasDeferMetadata {
  (...args: Parameters<F>): ReturnType<F>;
  __fn: F;
  await: DeferAwaitRetFn<F>;
  /**
   * @deprecated use `delay(deferFn)` instead
   */
  delayed: (...args: DeferRetFnParameters<F>) => ReturnType<F>;
}
export interface DeferScheduledFn<F extends (...args: never) => Promise<any>>
  extends HasDeferMetadata {
  (...args: Parameters<F>): void;
  __fn: F;
}
export interface DeferAwaitRetFn<
  F extends (...args: any | undefined) => Promise<any>
> {
  (...args: Parameters<F>): Promise<UnPromise<ReturnType<F>>>;
}

export interface Defer {
  <F extends (...args: any | undefined) => Promise<any>>(
    fn: F,
    options?: DeferOptions
  ): DeferRetFn<F>;
  schedule: <F extends (args: never[]) => Promise<any>>(
    fn: F,
    schedule: string
  ) => DeferScheduledFn<F>;
}

export const isDeferExecution = (obj: any): obj is DeferExecuteResponse =>
  !!obj.__deferExecutionResponse;

export interface DeferOptions {
  retry?: boolean | RetryNumber;
  concurrency?: Concurrency;
}

export const defer: Defer = (fn, options) => {
  const ret: DeferRetFn<typeof fn> = (...args: Parameters<typeof fn>) => {
    if (debug) {
      console.log(`[defer.run][${fn.name}] invoked.`);
    }
    if (token && fetcher) {
      return executeBackgroundFunction(fn.name, args, fetcher, debug);
    } else {
      if (debug) {
        console.log(`[defer.run][${fn.name}] defer ignore, no token found.`);
      }
      // try to serialize arguments for develpment warning purposes
      serializeBackgroundFunctionArguments(fn.name, args);
      // FIX: do better
      return fn(...(args as any)) as any;
    }
  };
  ret.__fn = fn;
  let retryPolicy: RetryNumber = 0;
  if (options?.retry === true) {
    retryPolicy = 12;
  }
  if (typeof options?.retry === "number") {
    retryPolicy = options.retry;
  }
  ret.__metadata = { version: INTERNAL_VERSION, retry: retryPolicy };
  ret.await = async (...args) => {
    const executionResult = (await defer(fn)(...args)) as UnPromise<
      ReturnType<typeof fn>
    >;

    if (isDeferExecution(executionResult)) {
      return await poolForExecutionResult<UnPromise<ReturnType<typeof fn>>>(
        fn.name,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        executionResult.id!,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        fetcher!,
        debug
      );
    } else {
      return Promise.resolve(executionResult);
    }
  };
  ret.delayed = (...args) => {
    if (debug) {
      console.log(`[defer.run][${fn.name}] invoked.`);
    }
    const [options] = args.splice(-1);
    if (token && fetcher) {
      return executeBackgroundFunction(fn.name, args, fetcher, debug, options);
    } else {
      if (debug) {
        console.log(`[defer.run][${fn.name}] defer ignore, no token found.`);
      }
      // try to serialize arguments for develpment warning purposes
      serializeBackgroundFunctionArguments(fn.name, args);
      // FIX: do better
      return fn(...(args as any)) as any;
    }
  };
  return ret as any;
};

defer.schedule = (fn, schedule) => {
  const ret: DeferScheduledFn<typeof fn> = () => {
    throw new Error("`defer.scheduled()` functions should not be invoked.");
  };

  ret.__fn = fn;
  ret.__metadata = {
    version: INTERNAL_VERSION,
    cron: getCronString(schedule) as string,
  };

  return ret;
};

interface DeferDelay {
  <F extends (...args: any | undefined) => Promise<any>>(
    deferFn: DeferRetFn<F>,
    delay: DelayString | Date
  ): (...args: Parameters<F>) => ReturnType<F>;
}

/**
 * Delay the execution of a background function
 * @constructor
 * @param {Function} deferFn - A background function (`defer(...)` result)
 * @param {string|Date} delay - The delay (ex: "1h" or a Date object)
 * @returns Function
 */
export const delay: DeferDelay =
  (deferFn, delay) =>
  (...args) => {
    const fn = deferFn.__fn;
    if (debug) {
      console.log(`[defer.run][${fn.name}] invoked.`);
    }
    if (token && fetcher) {
      return executeBackgroundFunction(fn.name, args, fetcher, debug, {
        delay,
      });
    } else {
      if (debug) {
        console.log(`[defer.run][${fn.name}] defer ignore, no token found.`);
      }
      // try to serialize arguments for develpment warning purposes
      serializeBackgroundFunctionArguments(fn.name, args);
      // FIX: do better
      return fn(...(args as any)) as any;
    }
  };

// EXAMPLES:

// interface Contact {
//   id: string;
//   name: string;
// }

// const importContacts = (companyId: string, contacts: Contact[]) => {
//   return new Promise<{ imported: number; companyId: string }>((resolve) => {
//     console.log(`Start importing contacts for company#${companyId}`);
//     setTimeout(() => {
//       console.log(contacts);
//       console.log("Done.");
//       resolve({ imported: 10000, companyId });
//     }, 5000);
//   });
// };

// const importContactsD = defer(importContacts);

// async function myFunction() {
//   return 1;
// }

// defer.schedule(myFunction, "every day");

// async function test() {
//   await importContactsD("1", []); // fire and forget

//   await importContactsD.await("1", []); // wait for execution result

//   await importContactsD.delayed("1", [], { delay: "2 days" }); // scheduled
// }

// // Delayed

// const delayed = delay(importContactsD, "1h");
// delayed("", []);

// // Retry options

// const importContactsRetried = defer(importContacts, { retry: 3 });
