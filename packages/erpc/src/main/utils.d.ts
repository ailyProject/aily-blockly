export declare function isObject(value: unknown): value is Record<string, unknown>
export declare function isAsyncIterable<TValue>(value: unknown): value is AsyncIterable<TValue>
/**
 * Takes a value and an async dispose function and returns a new object that implements the AsyncDisposable interface.
 * The returned object is the original value augmented with a Symbol.asyncDispose method.
 * @param thing The value to make async disposable
 * @param dispose Async function to call when disposing the resource
 * @returns The original value with Symbol.asyncDispose method added
 */
export declare function makeAsyncResource<T>(thing: T, dispose: () => Promise<void>): T & AsyncDisposable
export declare function iteratorResource<TYield, TReturn, TNext>(
	iterable: AsyncIterable<TYield, TReturn, TNext>
): AsyncIterator<TYield, TReturn, TNext> & AsyncDisposable
/**
 * Run an IIFE
 */
export declare const run: <TValue>(fn: () => TValue) => TValue
