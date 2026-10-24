// Core entrypoint for workspace initialization.
//
// The implementation lives in `src/app/init.ts`; this barrel keeps the
// published `@phyzess/pappra/init` path independent of the internal `app/`
// layout.
export * from './app/init.js';
