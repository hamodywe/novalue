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
 * A surrounding `if`, `with` or `hasKey` test also makes a value deliberately
 * optional — but only the value it actually tests. See `guardedPaths` below;
 * that distinction is most of this file.
 */

import type { ValueReference } from '../types.ts';

/** `.Values.a.b.c`, `.Values.a.b.c` inside a pipeline, and the index form. */
const REFERENCE = /\.Values\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;

/**
 * A field read off the current scope: the `.hostname` in `{{ .hostname }}`.
 *
 * Only meaningful inside `with`, where `.` has been rebound to a value path.
 * The lookbehind keeps it from firing on `.Values.x` (already matched above),
 * on `$var.field`, on `(index . "a").b`, and on the second dot of `a.b`.
 */
const SCOPED_FIELD = /(?<![\w$)\]."])\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;

/** Built-in objects. Reachable from the root, never fields of a values scope. */
const BUILT_INS = new Set([
  'Values', 'Release', 'Chart', 'Capabilities', 'Files', 'Template', 'Subcharts',
]);

/** Functions that make a missing value safe or loud. */
const GUARDS = /\b(default|required|hasKey|empty|coalesce|ternary|dig|get)\b/;

/** An opening block action, with the keyword and the rest of the expression. */
const OPENS = /\{\{-?\s*(if|with|range)\b([^}]*?)-?\}\}/g;
const ENDS = /\{\{-?\s*end\s*-?\}\}/g;

/** One open `if` / `with` / `range` block. */
interface Frame {
  /**
   * The values path `.` refers to inside this block, or `null` when it cannot
   * be known — inside `range`, `.` is an element of a list, so `.name` is a
   * field of that element and says nothing about any values path.
   */
  readonly scope: string | null;
  /** Values paths this block tests, which it therefore guards. */
  readonly tests: readonly string[];
}

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
  const stack: Frame[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const opened = openedOn(raw, currentScope(stack));

    // A reference inside the opening tag is the test, not a use of the result.
    const testing = new Set(opened.flatMap((frame) => frame.tests));
    const guards = guardedPaths(stack);
    const scope = currentScope(stack);

    const record = (path: string, at: number): void => {
      if (inComment(raw, at)) return;

      const expression = enclosingExpression(raw, at);

      references.push({
        path,
        file,
        line: index + 1,
        required: /\brequired\b/.test(expression),
        guarded: testing.has(path)
          || GUARDS.test(expression)
          || guards.some((guarded) => guarded === path || isAncestor(path, guarded)),
        context: line.length > 120 ? `${line.slice(0, 117)}…` : line,
      });
    };

    // A template is mostly YAML, and YAML is full of comments explaining the
    // values above them. Reading `.Values.x` out of prose would report a chart
    // as broken because somebody documented it.
    for (const match of raw.matchAll(REFERENCE)) {
      const path = match[1];
      if (path !== undefined) record(path, match.index ?? 0);
    }

    // `{{- with .Values.ingress }}` rebinds `.`, so the `{{ .hostname }}`
    // below it reads `.Values.ingress.hostname` — a reference that is invisible
    // if only `.Values.` is searched for, and one of the most common ways a
    // chart renders a blank field.
    if (scope !== null) {
      for (const match of raw.matchAll(SCOPED_FIELD)) {
        const field = match[1];
        const at = match.index ?? 0;

        if (field === undefined) continue;
        if (BUILT_INS.has(field.split('.')[0] ?? field)) continue;
        // Only inside an action. A bare `.foo` in YAML text is not a template.
        if (!withinAction(raw, at)) continue;

        // An opening tag's own expression is read against the outer scope,
        // which is the scope still on the stack here — so `{{- range .items }}`
        // inside `with .Values.a` is a genuine reference to `a.items`.
        record(`${scope}.${field}`, at);
      }
    }

    apply(stack, raw, opened);
  }

  return references;
}

/** The values path `.` currently refers to, or `null` if it is not a values path. */
function currentScope(stack: readonly Frame[]): string | null {
  return stack.length === 0 ? null : (stack[stack.length - 1] as Frame).scope;
}

/** Every path an enclosing block tests, and therefore guards. */
function guardedPaths(stack: readonly Frame[]): string[] {
  return stack.flatMap((frame) => frame.tests);
}

/**
 * True when `path` is an ancestor of `guarded`.
 *
 * `{{ if .Values.ingress.enabled }}` proves `ingress` exists, so a reference to
 * `ingress` inside the block is covered. It proves nothing about
 * `ingress.hostname`, which is the whole point: the sibling of a tested key is
 * exactly what renders blank, and treating the block as covering everything
 * inside it is what let this tool report such a chart as clean.
 */
function isAncestor(path: string, guarded: string): boolean {
  return guarded.startsWith(`${path}.`);
}

/** The blocks opened on one line, in order. */
function openedOn(raw: string, scope: string | null): Frame[] {
  const frames: Frame[] = [];

  for (const match of raw.matchAll(OPENS)) {
    const keyword = match[1] ?? 'if';
    const expression = match[2] ?? '';
    const tests = testedPaths(expression, scope);

    if (keyword === 'range') {
      // `.` becomes an element of the collection, not a values path.
      frames.push({ scope: null, tests });
      continue;
    }
    if (keyword === 'with') {
      // `with` rebinds `.` — but only when what it binds is a values path.
      frames.push({ scope: tests[0] ?? null, tests });
      continue;
    }
    frames.push({ scope, tests });
  }

  return frames;
}

/** The values paths an expression mentions, resolved against the current scope. */
function testedPaths(expression: string, scope: string | null): string[] {
  const paths: string[] = [];

  for (const match of expression.matchAll(REFERENCE)) {
    if (match[1] !== undefined) paths.push(match[1]);
  }

  if (scope !== null) {
    for (const match of expression.matchAll(SCOPED_FIELD)) {
      const field = match[1];
      if (field === undefined) continue;
      if (BUILT_INS.has(field.split('.')[0] ?? field)) continue;
      paths.push(`${scope}.${field}`);
    }
  }

  return paths;
}

/**
 * Push and pop the block stack for one line.
 *
 * Openings and `end`s are applied in the order they appear, so a block opened
 * and closed on the same line leaves the stack as it found it.
 */
function apply(stack: Frame[], raw: string, opened: readonly Frame[]): void {
  const events: { at: number; frame: Frame | null }[] = [];

  let position = 0;
  for (const match of raw.matchAll(OPENS)) {
    events.push({ at: match.index ?? 0, frame: opened[position] ?? null });
    position += 1;
  }
  for (const match of raw.matchAll(ENDS)) {
    events.push({ at: match.index ?? 0, frame: null });
  }

  events.sort((a, b) => a.at - b.at);

  for (const event of events) {
    if (event.frame === null) stack.pop();
    else stack.push(event.frame);
  }
}

/** True when a position sits between `{{` and `}}`. */
export function withinAction(line: string, at: number): boolean {
  const open = line.lastIndexOf('{{', at);
  if (open === -1) return false;

  const close = line.indexOf('}}', open);
  return close === -1 || close > at;
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
