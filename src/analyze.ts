/**
 * The analysis.
 *
 * One question, asked in both directions: does every value a template reads
 * exist, and does every value defined get read?
 *
 * Helm answers neither. A missing value renders as the empty string — no error,
 * no warning — so `image: {{ .Values.image.repo }}:{{ .Values.image.tag }}`
 * becomes `image: repo:` and the failure surfaces as a pull error in a cluster,
 * long after the render that caused it. And a value nobody reads is accepted
 * in silence: `--set repicaCount=5` is not a typo Helm has any opinion about,
 * so the override does nothing and the deployment keeps its default.
 */

import path from 'node:path';
import { covers, distinctPaths, readReferences } from './chart/references.ts';
import { findCharts, readTemplate, readValuesFile } from './scan/chart.ts';
import type {
  Chart, Evidence, Finding, Options, Report, Severity, ValueDefinition, ValueReference,
} from './types.ts';

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { error: 3, warning: 2, info: 1 };
const MAX_LISTED = 10;

/**
 * Built-in objects that are not chart values.
 *
 * `.Values.global` is populated by the parent chart at install time, so a
 * subchart reading it is correct even when nothing local defines it.
 */
const PROVIDED_ELSEWHERE = new Set(['global']);

export async function analyze(options: Options): Promise<Report> {
  const root = path.resolve(options.root);
  const warnings: string[] = [];

  const charts = await findCharts(root);
  if (charts.length === 0) {
    return empty(['no Helm chart found — nothing here to check']);
  }

  if (charts.length > 1) {
    warnings.push(`${charts.length} charts found; reporting on ${charts[0]?.name ?? 'the first'} — run once per chart directory for the others`);
  }

  const chart = charts[0];
  if (chart === undefined) return empty(['no Helm chart could be read']);

  const references: ValueReference[] = [];
  for (const file of chart.templates) {
    const source = await readTemplate(root, chart, file);
    if (source === null) continue;
    references.push(...readReferences(source, file));
  }

  const definitions: ValueDefinition[] = [];
  for (const file of chart.valuesFiles) {
    definitions.push(...await readValuesFile(root, chart, file));
  }

  for (const extra of options.values ?? []) {
    definitions.push(...await readValuesFile(root, chart, extra));
  }

  const unresolved = findUnresolved(references, definitions, chart);
  const unread = findUnread(references, definitions, chart);

  const findings = [
    ...checkUnresolved(unresolved, chart),
    ...checkNullDefaults(references, definitions),
    ...checkUnread(unread, chart),
    ...checkNoValuesFile(chart, references),
  ];

  return {
    summary: {
      chart: chart.name,
      references: distinctPaths(references).length,
      defined: definitions.filter((definition) => !definition.isBranch).length,
      unresolved: distinctPaths(unresolved).length,
      unread: unread.length,
      templateCount: chart.templates.length,
    },
    unresolved,
    findings: findings.sort(bySeverityThenPlace),
    warnings,
  };
}

function empty(warnings: string[]): Report {
  return {
    summary: { chart: null, references: 0, defined: 0, unresolved: 0, unread: 0, templateCount: 0 },
    unresolved: [],
    findings: [],
    warnings,
  };
}

function bySeverityThenPlace(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  return a.line - b.line;
}

/**
 * References that nothing defines and nothing guards.
 *
 * A reference wrapped in `required` fails the render, which is loud and
 * correct. One wrapped in `default`, or inside an `if`, is deliberately
 * optional. Neither is reported — the finding is only for the ones that will
 * quietly become an empty string.
 */
export function findUnresolved(
  references: readonly ValueReference[],
  definitions: readonly ValueDefinition[],
  chart: Chart,
): ValueReference[] {
  const defined = definitions.map((definition) => definition.path);
  const subcharts = new Set([...chart.dependencies, ...PROVIDED_ELSEWHERE]);

  return references.filter((reference) => {
    if (reference.required || reference.guarded) return false;

    const head = reference.path.split('.')[0] ?? reference.path;
    // A subchart's values are supplied by the subchart's own defaults.
    if (subcharts.has(head)) return false;

    return !defined.some((entry) => covers(entry, reference.path));
  });
}

/** Definitions no template reads. */
export function findUnread(
  references: readonly ValueReference[],
  definitions: readonly ValueDefinition[],
  chart: Chart,
): ValueDefinition[] {
  const referenced = distinctPaths(references);
  const subcharts = new Set([...chart.dependencies, ...PROVIDED_ELSEWHERE]);

  return definitions.filter((definition) => {
    // A branch is read whenever any of its leaves is; reporting both would
    // double-count one key.
    if (definition.isBranch) return false;

    const head = definition.path.split('.')[0] ?? definition.path;
    if (subcharts.has(head)) return false;

    return !referenced.some((entry) => covers(definition.path, entry));
  });
}

function listOf(items: readonly { path: string; file: string; line: number }[]): Evidence[] {
  return items.slice(0, MAX_LISTED).map((item) => ({
    text: item.path,
    file: item.file,
    line: item.line,
  }));
}

/** The headline: a template reads something that will render as nothing. */
export function checkUnresolved(
  unresolved: readonly ValueReference[],
  chart: Chart,
): Finding[] {
  if (unresolved.length === 0) return [];

  const paths = distinctPaths(unresolved);
  const first = unresolved[0];
  if (first === undefined) return [];

  return [{
    ruleId: 'value-renders-as-nothing',
    severity: 'error',
    title: `${paths.length} value${paths.length === 1 ? '' : 's'} the templates read ${paths.length === 1 ? 'is' : 'are'} defined nowhere`,
    consequence:
      'Helm renders a missing value as the empty string. There is no error and no warning: the manifest is produced, it is valid YAML, and a field that should have held an image tag or a host name holds nothing. The failure surfaces in the cluster — as an image that cannot be pulled, or a rule that matches no traffic — a long way from the template that caused it.',
    fix: chart.hasSchema
      ? 'Add these keys to values.yaml, or wrap the reference in `required "…"` so a missing value fails the render instead of rendering blank.'
      : 'Add these keys to values.yaml with a sensible default, or wrap the reference in `required "…"`. A `values.schema.json` would also catch the typo direction.',
    file: first.file,
    line: first.line,
    evidence: unresolved.slice(0, MAX_LISTED).map((reference) => ({
      text: `.Values.${reference.path} — ${reference.context}`,
      file: reference.file,
      line: reference.line,
    })),
  }];
}

/**
 * Keys defined as `null`, which is defined and still renders as nothing.
 *
 * This is the sharpest version of the bug, because the key *is* in values.yaml.
 * Somebody looking for it finds it, confirms it is there, and moves on.
 */
export function checkNullDefaults(
  references: readonly ValueReference[],
  definitions: readonly ValueDefinition[],
): Finding[] {
  const nulls = definitions.filter((definition) => definition.isNull);
  if (nulls.length === 0) return [];

  const dangerous = nulls.filter((definition) =>
    references.some((reference) =>
      reference.path === definition.path && !reference.required && !reference.guarded));

  if (dangerous.length === 0) return [];

  const first = dangerous[0];
  if (first === undefined) return [];

  return [{
    ruleId: 'null-value-read-unguarded',
    severity: 'error',
    title: `${dangerous.length} value${dangerous.length === 1 ? ' is' : 's are'} defined as null and read without a default`,
    consequence:
      'A null renders as the empty string, exactly like a key that is not there at all — but this one is in values.yaml, so anybody checking whether it is set finds it and concludes the chart is fine. It is the same failure as a missing key with the evidence pointing the other way.',
    fix: 'Give the key a real default, or wrap the reference in `required "…"` so an unset install fails loudly rather than deploying a blank field.',
    file: first.file,
    line: first.line,
    evidence: listOf(dangerous),
  }];
}

/**
 * Values defined and never read.
 *
 * Reported as a warning, because it breaks nothing on its own. It matters
 * because it is what a typo looks like from the other side: `repicaCount: 5`
 * in a values file is a key nothing reads, and Helm accepts it without a word.
 */
export function checkUnread(unread: readonly ValueDefinition[], chart: Chart): Finding[] {
  if (unread.length === 0) return [];

  const first = unread[0];
  if (first === undefined) return [];

  return [{
    ruleId: 'value-never-read',
    severity: 'warning',
    title: `${unread.length} value${unread.length === 1 ? ' is' : 's are'} defined and never read by any template`,
    consequence:
      'Nothing goes wrong at install time — Helm accepts any key you give it. That is the problem: a misspelled override is indistinguishable from a working one, so `--set repicaCount=5` reports success, changes nothing, and leaves somebody certain they have scaled the deployment.',
    fix: chart.hasSchema
      ? 'Remove the keys that are genuinely dead, and check the rest for a spelling that no longer matches the template.'
      : 'Remove the dead keys, and add a `values.schema.json` with `additionalProperties: false` so a misspelled override is rejected instead of ignored.',
    file: first.file,
    line: first.line,
    evidence: listOf(unread),
  }];
}

/** A chart with templates that read values and no values file at all. */
export function checkNoValuesFile(
  chart: Chart,
  references: readonly ValueReference[],
): Finding[] {
  if (chart.valuesFiles.length > 0 || references.length === 0) return [];

  return [{
    ruleId: 'no-values-file',
    severity: 'warning',
    title: 'the templates read values and the chart has no values.yaml',
    consequence:
      'Every reference resolves to nothing unless the installer supplies it, and nothing in the chart says which keys that is. The first install renders a set of manifests with blank fields, and the only way to discover the required keys is to read every template.',
    fix: 'Add a values.yaml documenting every key the templates read, with defaults where there is a sensible one.',
    file: chart.directory === '.' ? 'Chart.yaml' : `${chart.directory}/Chart.yaml`,
    line: 1,
    evidence: [{ text: `${distinctPaths(references).length} distinct values read across ${chart.templates.length} templates` }],
  }];
}
