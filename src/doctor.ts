// Core entrypoint for passive diagnostics.
//
// The implementation lives in `src/app/doctor.ts`; this barrel keeps the
// published `@phyzess/pappra/doctor` path independent of the internal `app/`
// layout.
export * from './app/doctor.js';
