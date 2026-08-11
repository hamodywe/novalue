#!/usr/bin/env node
/**
 * The command line.
 *
 * Exit codes are the contract: 0 clean, 1 findings at or above the threshold,
 * 2 the tool could not run. A gate that exits 2 when it meant 1 is the same
 * class of silent failure this tool reports, so the two are kept distinct.
 */

import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { analyze } from './analyze.ts';
import { renderJson } from './report/json.ts';
import { renderTerminal } from './report/terminal.ts';
import type { Severity } from './types.ts';
import { VERSION } from './version.ts';

interface CliOptions {
  readonly root: string;
  readonly values: string[];
  readonly json: boolean;
  readonly verbose: boolean;
  readonly failOn: Severity;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { error: 3, warning: 2, info: 1 };

const HELP = `novalue — the Helm values that render as nothing

Helm renders a missing value as the empty string. Not an error, not a warning:

    image: {{ .Values.image.repo }}:{{ .Values.image.tag }}

with no 'tag' in values.yaml becomes:

    image: myapp:

which is valid YAML, a valid manifest, and a pod that never starts. The failure
shows up in a cluster, a long way from the template that caused it.

The same silence works in reverse. Helm accepts any key you give it, so
'--set repicaCount=5' reports success, changes nothing, and leaves somebody
certain they have scaled the deployment.

USAGE
  novalue [path] [options]

OPTIONS
  --values <file>      an extra values file, as supplied at install (repeatable)
  --json               machine-readable report
  --verbose            list every value that will render as nothing
  --fail-on <level>    error | warning | info        (default: error)
  -h, --help
  -v, --version

EXIT CODES
  0  clean, or nothing at or above the threshold
  1  findings at or above the threshold
  2  bad usage, or a path that could not be read

Reads Chart.yaml, templates/ and values.yaml. No cluster, no network, nothing
rendered or executed.

https://github.com/hamodywe/novalue
`;

export function parseArgs(argv: readonly string[]): CliOptions | 'help' | 'version' {
  let root: string | undefined;
  const values: string[] = [];
  let json = false;
  let verbose = false;
  let failOn: Severity = 'error';

  const cursor = { current: 0 };
  const valueFor = (argument: string, flag: string): string => {
    const value = argument.startsWith(`${flag}=`)
      ? argument.slice(flag.length + 1)
      : argv[++cursor.current];

    if (value === undefined || value === '') throw new Error(`${flag} needs a value`);
    return value;
  };

  for (cursor.current = 0; cursor.current < argv.length; cursor.current += 1) {
    const argument = argv[cursor.current] as string;

    if (argument === '-h' || argument === '--help') return 'help';
    if (argument === '-v' || argument === '--version') return 'version';

    if (argument === '--json') { json = true; continue; }
    if (argument === '--verbose') { verbose = true; continue; }

    if (argument === '--values' || argument.startsWith('--values=')) {
      values.push(valueFor(argument, '--values'));
      continue;
    }

    if (argument === '--fail-on' || argument.startsWith('--fail-on=')) {
      const value = valueFor(argument, '--fail-on');
      if (value !== 'error' && value !== 'warning' && value !== 'info') {
        throw new Error(`unknown level for --fail-on: ${value} (expected error, warning or info)`);
      }
      failOn = value;
      continue;
    }

    if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`);

    if (root !== undefined) throw new Error(`unexpected second path: ${argument}`);
    root = argument;
  }

  return { root: root ?? '.', values, json, verbose, failOn };
}

async function main(): Promise<number> {
  let options: CliOptions | 'help' | 'version';

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`novalue: ${(error as Error).message}\n\n`);
    process.stderr.write('Run `novalue --help` for usage.\n');
    return 2;
  }

  if (options === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (options === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  let report;
  try {
    report = await analyze({ root: options.root, values: options.values, failOn: options.failOn });
  } catch (error) {
    process.stderr.write(`novalue: ${(error as Error).message}\n`);
    return 2;
  }

  process.stdout.write(
    options.json
      ? renderJson(report)
      : `${renderTerminal(report, process.stdout, { verbose: options.verbose })}\n`,
  );

  const threshold = SEVERITY_ORDER[options.failOn];
  const triggered = report.findings.filter(
    (finding) => SEVERITY_ORDER[finding.severity] >= threshold,
  );

  if (triggered.length === 0) return 0;

  const { unresolved, references } = report.summary;
  process.stderr.write(
    unresolved > 0
      ? `novalue: fail — ${unresolved} of ${references} values the templates read are defined nowhere
`
      : `novalue: fail — ${triggered.length} finding${triggered.length === 1 ? '' : 's'} at or above ${options.failOn}
`,
  );

  return 1;
}

// Run only when invoked as a program: the tests import `parseArgs` from here,
// and without this guard that import runs the CLI against the test runner's own
// arguments, setting `process.exitCode` and failing a suite in which every
// assertion passed. `pathToFileURL` is what makes the comparison correct on
// Windows.
const entryPoint = process.argv[1];
// npm installs bins as symlinks and Node resolves the main module to its real
// path, so comparing against the raw argv[1] would never match on Linux or
// macOS — the CLI would print nothing and exit 0.
const entryUrl = (): string => {
  try {
    return pathToFileURL(realpathSync(entryPoint as string)).href;
  } catch {
    return pathToFileURL(entryPoint as string).href;
  }
};

if (entryPoint !== undefined && import.meta.url === entryUrl()) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`novalue: ${(error as Error).message}\n`);
      process.exitCode = 2;
    });
}
