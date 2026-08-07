/**
 * Finding every `.Values.…` a template reads.
 *
 * Helm renders a missing value as the empty string. Not an error, not a
 * warning — `image: {{ .Values.image.repo }}:{{ .Values.image.tag }}` with no
 * `tag` becomes `image: repo:`, which is a syntactically valid manifest that
 * the API server rejects hours later, or worse, accepts.
 *
 * Two constructs change that and both are recognised here, because reporting a
 * reference that is already handled is how a tool becomes noise:
 *
 *   `required "message" .Values.x`  fails the render loudly — the correct fix
 *   `default "v" .Values.x`         supplies a fallback
 *
 * So does a surrounding `if`, `with`, or `hasKey` test, which is the idiomatic
 * way to make a value optional.
 */

import type { ValueReference } from '../types.ts';

/** `.Values.a.b.c`, `.Values.a.b.c` inside a pipeline, and the index form. */
const REFERENCE = /\.Values\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;

/** Functions that make a missing value safe or loud. */
const GUARDS = /\b(default|required|hasKey|empty|coalesce|ternary|dig|get)\b/;

/**
 * Read the references in one template.
 *
 * A Helm template is not YAML until it is rendered, so it is scanned as text.
 * That is the honest approach: parsing it as YAML would fail on every chart,
 * and rendering it would mean executing the chart's own logic.
 */
export function readReferences(source: string, file: string): ValueReference[] {
  const references: ValueReference[] = [];
  const lines = source.split('\n');

  // Blocks opened by `if`, `with` or `range` guard everything inside them,
  // shallowly: a value tested by the block is not going to be rendered blank.
  const openGuards: string[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();

    const closes = /\{\{-?\s*end\s*-?\}\}/.test(line);
    const opens = /\{\{-?\s*(if|with|range)\b([\s\S]*?)-?\}\}/.exec(line);

    // A reference inside the opening tag itself is the test, not a use.
    const guardedByBlock = openGuards.length > 0;

    for (const match of raw.matchAll(REFERENCE)) {
      const path = match[1];
      if (path === undefined) continue;

      const at = match.index ?? 0;
      // A template is mostly YAML, and YAML is full of comments explaining the
      // values above them. Reading `.Values.x` out of prose would report a
      // chart as broken because somebody documented it.
      if (inComment(raw, at)) continue;

      const expression = enclosingExpression(raw, at);

      references.push({
        path,
        file,
        line: index + 1,
        required: /\brequired\b/.test(expression),
        guarded: guardedByBlock
          || GUARDS.test(expression)
          || (opens !== null && (opens[2] ?? '').includes(path)),
        context: line.length > 120 ? `${line.slice(0, 117)}…` : line,
      });
    }

    if (opens !== null) openGuards.push(opens[1] ?? 'if');
    if (closes) openGuards.pop();
  }

  return references;
}

/**
 * True when a position sits inside a comment.
 *
 * Two kinds matter. A YAML `#` comments out the rest of the line, unless it is
 * inside a `{{ … }}` action, where it is just a character. Helm also has its
 * own comment action, opened with a slash-star immediately after the braces,
 * which comments out everything the action spans.
 */
export function inComment(line: string, at: number): boolean {
  if (/\{\{-?\s*\/\*/.test(line.slice(0, at))) return true;

  let depth = 0;

  for (let index = 0; index < at; index += 1) {
    if (line.startsWith('{{', index)) { depth += 1; index += 1; continue; }
    if (line.startsWith('}}', index)) { depth = Math.max(0, depth - 1); index += 1; continue; }
    if (depth === 0 && line[index] === '#') return true;
  }

  return false;
}

/**
 * The `{{ … }}` expression a match sits inside.
 *
 * `default` and `required` apply within one action, so the whole action has to
 * be read rather than the line — a line can hold several, and crediting a guard
 * from a neighbouring action would suppress a real finding.
 */
export function enclosingExpression(line: string, at: number): string {
  const open = line.lastIndexOf('{{', at);
  if (open === -1) return line;

  const close = line.indexOf('}}', at);
  return line.slice(open, close === -1 ? line.length : close + 2);
}

/** Every distinct path a set of references covers, sorted. */
export function distinctPaths(references: readonly ValueReference[]): string[] {
  return [...new Set(references.map((reference) => reference.path))]
    .sort((a, b) => a.localeCompare(b));
}

/**
 * True when a defined key satisfies a reference.
 *
 * Exactly two cases, and the asymmetry between them is the point:
 *
 *   - the same path is defined; or
 *   - something *beneath* the referenced path is defined, because
 *     `{{ toYaml .Values.resources }}` reads the whole subtree and any leaf
 *     under it makes that subtree real.
 *
 * The reverse does **not** hold. A defined `image` branch does not satisfy a
 * reference to `image.tag`: the parent existing says nothing about the child,
 * and treating it as coverage hides the single most common form of this bug —
 * which is exactly what it did until the fixture caught it.
 */
export function covers(defined: string, referenced: string): boolean {
  return defined === referenced || defined.startsWith(`${referenced}.`);
}
