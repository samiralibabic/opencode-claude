# Releasing

## Before every release

1. Confirm `package.json` contains the intended version and that `CHANGELOG.md` describes it.
2. Run `bun install --frozen-lockfile`, `npm test` and `npm run pack:check`.
3. Test the packed package in OpenCode 1 before tagging: unpack `npm pack` into a temporary folder, install its dependencies there, and load it through a temporary config (`XDG_CONFIG_HOME`) with a `file://` plugin entry.
4. Merge the release pull request into `local/0.14.0-fixes`, then push the tag `v<package version>` on that commit.
5. Verify the package from the npm registry before switching any OpenCode config to the new version.

The `publish.yml` workflow checks that the tag matches `package.json`, runs the tests and publishes with provenance. It skips the publish when the version is already on npm.

## Publishing

`0.15.0` was published once from a maintainer's machine with `npm publish`, because npm Trusted Publishing cannot create an unclaimed package. After that:

1. In the package settings on npmjs.com, configure GitHub Actions as a Trusted Publisher for `samiralibabic/opencode-claude` and workflow filename `publish.yml`.
2. Restrict traditional token publishing in the package settings once a tag-triggered publish has worked.

Later releases are published by pushing the tag; no npm token is stored in GitHub.
