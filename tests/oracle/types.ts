export type OracleJson = null | boolean | number | string | OracleJson[] | { [key: string]: OracleJson };

export type OracleMode = 'normal' | 'visual' | 'operator-pending' | 'insert';

export interface OracleManifest {
  readonly schemaVersion: number;
  readonly oracle: {
    readonly name: string;
    readonly version: string;
    readonly tag: string;
    readonly releaseUrl: string;
    readonly platform: string;
    readonly asset: {
      readonly fileName: string;
      readonly url: string;
      readonly sha256: string;
    };
    readonly binaryPath: string;
    readonly binarySha256: string;
    readonly versionOutput: readonly string[];
    readonly runtimePath: string;
    readonly runtimeDocs: {
      readonly path: string;
      readonly fileCount: number;
      readonly sha256: string;
      readonly criticalFiles: Readonly<Record<string, string>>;
    };
  };
  readonly runtimeProfile: {
    readonly config: string;
    readonly locale: string;
    readonly filetype: string;
    readonly encoding: string;
    readonly fileformat: string;
    readonly ambiwidth: string;
    readonly input: string;
  };
}

export interface OracleSnapshot {
  readonly label: string;
  readonly lines: readonly string[];
  readonly cursor: {
    readonly line: number;
    readonly byteColumn: number;
    readonly coladd: number;
    readonly virtualColumn: number;
    readonly desiredColumn: number;
    readonly screenRow: number;
    readonly screenColumn: number;
  };
  readonly mode: string;
  readonly blocking: boolean;
  readonly geometry: {
    readonly columns: number;
    readonly lines: number;
    readonly windowWidth: number;
    readonly windowHeight: number;
  };
  readonly view: OracleJson;
  readonly options: Readonly<Record<string, OracleJson>>;
  readonly buffer: Readonly<Record<string, OracleJson>>;
  readonly registers: Readonly<Record<string, OracleJson>>;
  readonly marks: Readonly<Record<string, OracleJson>>;
  readonly jumpList: OracleJson;
  readonly changeList: OracleJson;
  readonly search: Readonly<Record<string, OracleJson>>;
  readonly commandLine: string;
  readonly error: string;
}

export interface OracleMapping {
  readonly mode: string;
  readonly lhs: string;
  readonly rhs: string;
  readonly remap?: boolean;
  readonly nowait?: boolean;
}

export interface OracleRegisterSeed {
  readonly lines: readonly string[];
  readonly type: string;
}

export interface OracleInputStep {
  readonly label: string;
  readonly keys?: string;
  readonly drain?: boolean;
  readonly barrier?: boolean;
  readonly expected?: Readonly<Record<string, unknown>>;
}

export interface OracleHostFile {
  readonly path: string;
  readonly lines: readonly string[];
}

export interface OracleFixture {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly modes: readonly OracleMode[];
  readonly lines: readonly string[];
  /** Optional raw file bytes loaded into Neovim for NUL and code-point buffer probes. */
  readonly rawBufferBytes?: readonly number[];
  readonly endOfLine?: boolean;
  readonly fileFormat?: 'unix' | 'dos' | 'mac';
  readonly cursor?: {
    readonly line: number;
    readonly byteColumn0: number;
  };
  readonly options?: Readonly<Record<string, string | number | boolean>>;
  /** Fixture-local +/* registers; the harness never consults the host clipboard. */
  readonly clipboard?: {
    readonly plus?: OracleRegisterSeed;
    readonly star?: OracleRegisterSeed;
  };
  /** Optional headless/UI search register seed used by focused rendering fixtures. */
  readonly searchPattern?: string;
  readonly mappings?: readonly OracleMapping[];
  /** Optional temporary files used by host-dependent navigation fixtures. */
  readonly initialFile?: string;
  readonly hostFiles?: readonly OracleHostFile[];
  readonly steps: readonly OracleInputStep[];
}

export interface OracleFixtureResult {
  readonly fixtureId: string;
  readonly snapshots: readonly OracleSnapshot[];
}

export interface OracleUiResult {
  readonly fixtureId: string;
  readonly snapshot: OracleSnapshot;
  readonly pty: { readonly rows: number; readonly columns: number };
  readonly terminalRestored: boolean;
  readonly transcriptPath: string;
}

export interface OracleIndexEntry {
  readonly id: string;
  readonly key: string;
  readonly helpTag: string;
  readonly description: string;
  readonly modes: readonly OracleMode[];
  readonly options: readonly string[];
  readonly optionMatrix: {
    readonly profile: 'strict';
    readonly baseline: 'pinned-defaults';
    readonly candidateOptions: readonly string[];
    readonly review: 'unexpanded';
  };
  readonly dependencies: readonly string[];
  readonly dependencyReview: 'seed-unverified';
  readonly fixtureIds: readonly string[];
  readonly implementingTicket: string;
  readonly status: 'unimplemented';
}
