/**
 * The version, in one place.
 *
 * Kept as a literal rather than read from `package.json`: the compiled CLI ends
 * up in `dist/`, and resolving the manifest relative to it differs between a
 * global install, a local `node_modules/.bin` and a `node dist/cli.js` run.
 * A release checks this against the manifest in CI.
 */
export const VERSION = '0.2.0';
