/**
 * The library surface.
 *
 * Everything the CLI does is reachable from here, so a pipeline can read
 * `summary.unresolved` directly, or take the reference list and generate the
 * values file the chart is missing.
 */

export {
  analyze,
  checkNoValuesFile,
  checkNullDefaults,
  checkUnread,
  checkUnresolved,
  findUnread,
  findUnresolved,
} from './analyze.ts';

export {
  covers,
  distinctPaths,
  enclosingExpression,
  readReferences,
} from './chart/references.ts';

export {
  findCharts,
  readDefinitions,
  readTemplate,
  readValuesFile,
} from './scan/chart.ts';

export { renderJson } from './report/json.ts';
export { renderTerminal, type TerminalOptions } from './report/terminal.ts';
export { VERSION } from './version.ts';

export type {
  Chart, Evidence, Finding, Options, Report, Severity, Summary,
  ValueDefinition, ValueReference,
} from './types.ts';
