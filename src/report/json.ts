/**
 * The JSON report.
 *
 * Versioned, because something will parse this in CI and a silent shape change
 * would break it without failing anything — which is the class of bug this
 * whole tool exists to find.
 */

import type { Report } from '../types.ts';
import { VERSION } from '../version.ts';

export function renderJson(report: Report): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      tool: { name: 'novalue', version: VERSION },
      summary: report.summary,
      unresolved: report.unresolved,
      findings: report.findings,
      warnings: report.warnings,
    },
    null,
    2,
  )}\n`;
}
