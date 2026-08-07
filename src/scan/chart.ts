/**
 * Reading a Helm chart from disk.
 *
 * A chart is `Chart.yaml`, a `templates/` directory and one or more values
 * files. Subcharts matter because their values live under the dependency's
 * name — `.Values.postgresql.auth.password` is the subchart's business, not
 * this chart's, and reporting it as undefined would be wrong on every chart
 * that has a dependency.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { asArray, asMap, asString, isMap, parseYaml, type YamlMap, type YamlValue } from '../yaml.ts';
import type { Chart, ValueDefinition } from '../types.ts';

const MAX_DEPTH = 8;

/** Find every chart under a directory: a repository often holds several. */
export async function findCharts(root: string): Promise<Chart[]> {
  const charts: Chart[] = [];

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));

    if (names.has('Chart.yaml') || names.has('Chart.yml')) {
      const chart = await readChart(dir, prefix === '' ? '.' : prefix);
      if (chart !== null) charts.push(chart);
      // `charts/` holds dependencies, which are their own charts and not this
      // one's problem.
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      await walk(
        path.join(dir, entry.name),
        prefix === '' ? entry.name : `${prefix}/${entry.name}`,
        depth + 1,
      );
    }
  };

  await walk(root, '', 0);
  return charts;
}

async function readChart(directory: string, relative: string): Promise<Chart | null> {
  const manifest = await readFirst(directory, ['Chart.yaml', 'Chart.yml']);
  if (manifest === null) return null;

  const parsed = asMap(parseYaml(manifest).value);
  const name = asString(parsed?.['name']) ?? path.basename(directory);

  const dependencies: string[] = [];
  for (const entry of asArray(parsed?.['dependencies'])) {
    const map = asMap(entry);
    if (map === null) continue;
    // The alias is what the values are nested under, when there is one.
    const alias = asString(map['alias']) ?? asString(map['name']);
    if (alias !== null) dependencies.push(alias);
  }

  const templates = await listTemplates(path.join(directory, 'templates'));

  const valuesFiles: string[] = [];
  for (const candidate of ['values.yaml', 'values.yml']) {
    const info = await stat(path.join(directory, candidate)).catch(() => undefined);
    if (info?.isFile() === true) valuesFiles.push(candidate);
  }

  const schema = await stat(path.join(directory, 'values.schema.json')).catch(() => undefined);

  return {
    directory: relative,
    name,
    dependencies,
    templates,
    valuesFiles,
    hasSchema: schema?.isFile() === true,
  };
}

async function readFirst(directory: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const source = await readFile(path.join(directory, name), 'utf8').catch(() => null);
    if (source !== null) return source;
  }
  return null;
}

/** Template files, relative to the chart root, excluding the notes and helpers. */
async function listTemplates(templatesDir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ya?ml|tpl|txt)$/i.test(entry.name)) continue;

      found.push(`templates/${relative}`);
    }
  };

  await walk(templatesDir, '', 0);
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Every key a values file defines, as dotted paths.
 *
 * Both the leaves and the branches are recorded: a template can read
 * `.Values.resources` whole with `toYaml`, so the branch is a definition in its
 * own right, and a template can read `.Values.resources.limits.cpu`, so the
 * leaves are too.
 */
export function readDefinitions(source: string, file: string): ValueDefinition[] {
  const parsed = parseYaml(source);
  const root = asMap(parsed.value);
  if (root === null) return [];

  const definitions: ValueDefinition[] = [];

  const visit = (map: YamlMap, prefix: string, keyPath: string): void => {
    for (const [key, value] of Object.entries(map)) {
      const dotted = prefix === '' ? key : `${prefix}.${key}`;
      const nested = keyPath === '' ? key : `${keyPath}.${key}`;
      const line = parsed.lines.get(nested) ?? 1;

      if (isMap(value)) {
        const children = Object.keys(value).length;
        definitions.push({ path: dotted, file, line, isNull: false, isBranch: children > 0 });
        if (children > 0) visit(value, dotted, nested);
        continue;
      }

      definitions.push({
        path: dotted,
        file,
        line,
        isNull: value === null,
        isBranch: false,
      });
    }
  };

  visit(root, '', '');
  return definitions;
}

export async function readValuesFile(
  root: string,
  chart: Chart,
  file: string,
): Promise<ValueDefinition[]> {
  const absolute = chart.directory === '.'
    ? path.join(root, file)
    : path.join(root, chart.directory, file);

  const source = await readFile(absolute, 'utf8').catch(() => null);
  return source === null ? [] : readDefinitions(source, file);
}

export async function readTemplate(
  root: string,
  chart: Chart,
  file: string,
): Promise<string | null> {
  const absolute = chart.directory === '.'
    ? path.join(root, file)
    : path.join(root, chart.directory, file);

  return readFile(absolute, 'utf8').catch(() => null);
}

export type { YamlValue };
