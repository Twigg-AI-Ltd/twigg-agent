# Releasing

All packages share one version number and are released together from a git tag.

1. On a branch, set the new version on every package (this also points the `twigg-agent` alias
   at the same `@twigg/agent`):
   ```sh
   node scripts/set-version.mjs 0.2.0
   ```
2. Open a pull request, and merge it once CI passes.
3. Tag the merge commit on `main` and push the tag:
   ```sh
   git switch main && git pull
   git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0
   ```
4. The [Release workflow](../.github/workflows/release.yml) checks the tag matches the package
   versions, runs the checks, and publishes each package that isn't on npm at that version yet,
   with provenance.
5. Add release notes on GitHub: `gh release create v0.2.0 --generate-notes`.

Versions can never be reused on npm, so a mistake is fixed by releasing the next patch version.

## One-time setup: trusted publishing

The workflow publishes through npm's trusted publishing, so there is no npm token to store or
rotate. Each package must trust it once: on npmjs.com open the package, then **Settings →
Trusted publishing → GitHub Actions**, and enter:

| Field | Value |
| --- | --- |
| Organization or user | `Twigg-AI-Ltd` |
| Repository | `twigg-agent` |
| Workflow filename | `release.yml` |
| Environment | leave empty |
| Allowed actions | tick **Allow npm publish** |

Without **Allow npm publish** the workflow may only stage a release, and publishing fails with
`403 Forbidden ... OIDC permission denied for this action`.

A new package has to be published by hand once (`npm publish --access public` in its folder)
before it can be set up.
