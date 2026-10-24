# Startup and delivery reliability

## Self-source runtime installation

`pappra runtime install --apply` defaults to the currently executing package (`source: self`). A self install still creates an npm tarball for source identity and keeps the existing stage, journal, lock, verification, and atomic-publish protocol. When every declared dependency is already installed beside the running package, the installer also copies the resolved dependency tree into the isolated staging package and materializes that package directly under the staging `node_modules` tree. This makes self-install independent of registry availability and the invoking user's npm cache while preserving the package versions already used by the executing CLI.

If a declared dependency is not locally installed, or the dependency manifest is unusable, the installer keeps the existing npm install path. Exact-version installs and local tarball installs also continue to use npm. The fast path does not edit the source package, its manifest, or its package-manager state; the runtime's content digest still covers the complete installed package tree.

The runtime regression test self-installs a bounded package fixture whose CLI imports a local dependency. It gives npm a fresh fixture `HOME`/cache and an unreachable registry, then validates the installed CLI with its version smoke check.

## Deterministic asset builds

The generated Pi/host bundles use `projectRoot` as esbuild's `absWorkingDir`. This keeps source-comment paths relative to the package root regardless of the caller's current working directory. A bounded scratch-package build invoked from the repository directory confirmed that, before the fix, esbuild comments contained the staging tree path; after the fix all five bundles contain root-relative source comments only.

## Verification deadlines

The selected-project package smoke test runs the installed CLI with a clean fixture home. Its runtime-install command now has a 150-second outer limit, derived from the installer's existing 120-second npm deadline plus a 30-second diagnostic/cleanup margin. This lets the installer report its bounded failure instead of having the package-check runner kill it first. Other selected-project commands and the full test-suite deadline are unchanged.
