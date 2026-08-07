/** Public types. Everything crossing a module boundary is declared here. */

export type Severity = 'error' | 'warning' | 'info';

/** One `.Values.…` path a template reads. */
export interface ValueReference {
  /** Dotted path without the `.Values.` prefix: `image.tag`. */
  readonly path: string;
  /** The template file it appears in, relative to the chart root. */
  readonly file: string;
  readonly line: number;
  /** True when the reference is wrapped in `required`, which fails the render loudly. */
  readonly required: boolean;
  /** True when it is guarded by `default`, `if`, `with`, `hasKey` or a similar test. */
  readonly guarded: boolean;
  /** The surrounding line, trimmed, for reporting. */
  readonly context: string;
}

/** One key defined in a values file. */
export interface ValueDefinition {
  readonly path: string;
  readonly file: string;
  readonly line: number;
  /** True when the value is `null` — defined, and still renders as nothing. */
  readonly isNull: boolean;
  /** True when it is a map with children, which is a namespace rather than a value. */
  readonly isBranch: boolean;
}

export interface Chart {
  /** Chart directory, relative to the scan root. `.` for a single chart. */
  readonly directory: string;
  readonly name: string;
  /** Names of dependencies declared in Chart.yaml, whose values live under their alias. */
  readonly dependencies: readonly string[];
  readonly templates: readonly string[];
  readonly valuesFiles: readonly string[];
  readonly hasSchema: boolean;
}

export interface Evidence {
  readonly text: string;
  readonly file?: string;
  readonly line?: number;
}

export interface Finding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly title: string;
  /** Why this matters — the consequence, not a restatement of the title. */
  readonly consequence: string;
  /** What to change, in one sentence. */
  readonly fix: string;
  readonly file: string;
  readonly line: number;
  readonly evidence: readonly Evidence[];
}

export interface Summary {
  readonly chart: string | null;
  /** Distinct `.Values.…` paths the templates read. */
  readonly references: number;
  /** Keys defined across the values files. */
  readonly defined: number;
  /** References that resolve to nothing at render time. */
  readonly unresolved: number;
  /** Defined keys no template reads. */
  readonly unread: number;
  readonly templateCount: number;
}

export interface Report {
  readonly summary: Summary;
  readonly unresolved: readonly ValueReference[];
  readonly findings: readonly Finding[];
  readonly warnings: readonly string[];
}

export interface Options {
  readonly root: string;
  /** Extra values files to treat as supplied at install time. */
  readonly values?: readonly string[];
  readonly failOn?: Severity;
}
