# Publishing checklist

Releases are published by CI. Every push to `main` runs the `release` workflow: release-please
opens or updates a release PR, and when that PR is merged the workflow builds the package, runs
`npm run package:check`, publishes the same `.vsix` to the Visual Studio Marketplace and Open VSX,
and attaches it to the GitHub release.

The steps below are the manual fallback, for when the workflow is unavailable or a maintainer needs
to publish by hand. The checklist under "Before publishing" also applies to the release PR.

## Before publishing

Check every item before building the release artifact:

- [ ] `package.json` `version` was bumped and matches the changelog entry.
- [ ] `CHANGELOG.md` has a dated entry for this version describing user-facing changes only.
- [ ] `README.md` describes only features that are actually implemented in this version.
- [ ] `engines.vscode` reflects the actual minimum API used (check for any new API calls since the
      last release).
- [ ] No dependency in `package.json` (`dependencies` or `devDependencies`) uses a `file:` or
      `link:` reference. `@vertracloud/api-types` in particular must point to a published npm
      version, not `file:../api-types`, or the packaged extension will fail to resolve it.
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass locally.

## Build the package

```
npm run package
```

This produces `dist/vertra-cloud-<version>.vsix`.

## Inspect the package

```
npm run package:check
```

The check fails when the package holds source, tests, source maps, `node_modules`, `.env` files or
local tooling guidance files. Also open the `.vsix` (it is a zip
archive) and confirm it contains only what should ship: compiled output, the manifest, localization
bundles, icons and license.

## Compute a checksum

```
shasum -a 256 dist/vertra-cloud-<version>.vsix
```

Record the checksum in the release notes so a user can verify the download.

## Publish to Visual Studio Marketplace

Requires a Personal Access Token with Marketplace publish rights, already logged in with
`vsce login <publisher>`.

```
vsce publish --packagePath dist/vertra-cloud-<version>.vsix
```

## Publish to Open VSX

Requires an Open VSX access token.

```
ovsx publish dist/vertra-cloud-<version>.vsix -p <open-vsx-token>
```

Publish the exact same `.vsix` file to both registries so the two listings never drift apart.

## After publishing

- [ ] Install the published version from each marketplace in a clean profile and confirm it
      activates and connects.
- [ ] Tag the release in git and attach the `.vsix` and its checksum to the release notes.
