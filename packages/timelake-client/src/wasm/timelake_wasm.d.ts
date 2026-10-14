/* tslint:disable */
/* eslint-disable */

/**
 * One Parquet file, read through the byte ranges the host fetches.
 */
export class ParquetFile {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds fetched bytes starting at offset `start`.
     */
    addRange(start: number, bytes: Uint8Array): void;
    /**
     * Bytes needed from the end of the file for the footer, given at least its last 8 bytes.
     */
    static footerLength(tail: Uint8Array): number;
    /**
     * `tail` must contain the whole footer (the last `footerLength` bytes or more).
     */
    constructor(size: number, tail: Uint8Array);
    /**
     * Selects row groups and columns for `query`; returns the byte ranges to fetch,
     * `[[start, end), …]`.
     */
    plan(query: any): any;
}

/**
 * Collects a query's result across files: rows, time-bucket aggregates when `query.bucket` is
 * set, or the newest row per series when `query.latestBy` is.
 */
export class Query {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The result as a JSON array string.
     */
    finish(): string;
    constructor(query: any);
    /**
     * Decodes the file's planned ranges and adds its matching rows to the result.
     */
    push(file: ParquetFile): void;
}

/**
 * A table at one version: its metadata plus the data files of the current snapshot.
 */
export class Table {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Parses the manifest list; returns the paths of the data manifests to fetch and add.
     */
    addManifestList(bytes: Uint8Array): string[];
    /**
     * Adds the live data files of one data manifest.
     */
    addManifest(bytes: Uint8Array): void;
    /**
     * All live data files: `[{path, size, records, partition}]`.
     */
    files(): any;
    /**
     * Contract, schema and snapshot summary (a plain object).
     */
    info(): any;
    constructor(metadata_json: string);
    /**
     * Data files that may contain rows matching `query`, in the same shape as `files()`.
     */
    planFiles(query: any): any;
    /**
     * The current snapshot's last-value index (newest row per series), if it has one.
     */
    readonly lastValueIndex: string | undefined;
    /**
     * The current snapshot's manifest list, if the table has a snapshot.
     */
    readonly manifestList: string | undefined;
}

/**
 * Version of this crate.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_parquetfile_free: (a: number, b: number) => void;
    readonly __wbg_query_free: (a: number, b: number) => void;
    readonly __wbg_table_free: (a: number, b: number) => void;
    readonly parquetfile_addRange: (a: number, b: number, c: number, d: number) => [number, number];
    readonly parquetfile_footerLength: (a: number, b: number) => [number, number, number];
    readonly parquetfile_new: (a: number, b: number, c: number) => [number, number, number];
    readonly parquetfile_plan: (a: number, b: any) => [number, number, number];
    readonly query_finish: (a: number) => [number, number, number, number];
    readonly query_new: (a: any) => [number, number, number];
    readonly query_push: (a: number, b: number) => [number, number];
    readonly table_addManifest: (a: number, b: number, c: number) => [number, number];
    readonly table_addManifestList: (a: number, b: number, c: number) => [number, number, number, number];
    readonly table_files: (a: number) => [number, number, number];
    readonly table_info: (a: number) => [number, number, number];
    readonly table_lastValueIndex: (a: number) => [number, number];
    readonly table_manifestList: (a: number) => [number, number];
    readonly table_new: (a: number, b: number) => [number, number, number];
    readonly table_planFiles: (a: number, b: any) => [number, number, number];
    readonly version: () => [number, number];
    readonly rust_zstd_wasm_shim_calloc: (a: number, b: number) => number;
    readonly rust_zstd_wasm_shim_free: (a: number) => void;
    readonly rust_zstd_wasm_shim_malloc: (a: number) => number;
    readonly rust_zstd_wasm_shim_memcmp: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memcpy: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memmove: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memset: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_qsort: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
