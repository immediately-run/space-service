// Text modules: wrangler.toml's Text rule bundles them on Cloudflare; the local build
// (scripts/run-ts.mjs) and the local test project load them as text too.
declare module '*.sql' {
  const text: string;
  export default text;
}
