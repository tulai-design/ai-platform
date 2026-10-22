# Distribution preparation

The two public package manifests are prepared for the `@tulai-design` scope.
This repository has not released these packages as part of extraction. A version
in `package.json` does not establish registry availability or a release promise.
The root is private; the two library packages have `publishConfig.access: public`.

Before a separately authorized release:

1. Review the source and API changes since the Momoki extraction baseline in the
   root README. Confirm MIT attribution and the intended package versions.
2. Verify ownership and npm access for the `@tulai-design` scope. Confirm each
   intended version is available; choose versions explicitly if necessary.
3. Update both package versions and the providers-to-core semver range together.
   Refresh the lockfile with the pinned pnpm and review its changes.
4. Run a frozen installation and `pnpm check` from a clean checkout. The packed
   consumer must compile and execute through installed emitted exports without
   workspace or source aliases; `pnpm verify:consumer` is the step that
   establishes this, and it must pass against the exact versions being released.
5. Review each `npm pack --dry-run --json` inventory. Packages should contain
   emitted JavaScript/declarations, README, LICENSE and the package manifest;
   exclude tests, product files, build receipts and local configuration.
6. Inspect the actual tarball manifests. Providers must depend on the intended
   released core semver range, with no `workspace:`, local `file:` or `link:`
   dependency. Release core before a dependent provider version.
7. Record the reviewed commit, artifact contents, validation and release notes
   before any explicitly authorized publication or tagging action.

The prepack lifecycle prepares emitted artifacts for ordinary packing. It does
not run the entire quality gate and does not replace step 4. No CI workflow
publishes, creates releases or changes consumer repositories.

After an actual release, migrate consumers in a separate change: update declared
versions, imports, lockfiles, workspace/build policies and integration tests, then
verify installed artifacts. Momoki remains on its private `@momoki/*` packages
until that coordinated change. Homepage integration and future services such as
`ai-proxy` are separately scoped.
