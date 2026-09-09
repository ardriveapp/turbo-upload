# Contributing

## Releasing

Publishing is tag-driven, so it is a deliberate act with a reviewable trigger
rather than a side effect of merging:

```bash
# after the version bump has merged to main
git tag v0.2.0 && git push origin v0.2.0
```

The workflow refuses a tag that disagrees with `package.json`, refuses a
version already on the registry, runs the tests, publishes with npm provenance,
and then confirms the registry actually serves it.

**There is no publish token and no repository secret.** npm verifies a
short-lived OIDC token that GitHub mints for this workflow in this repository.
A maintainer configures it once, on the package page under Settings, Trusted
Publisher, naming the organization `ardriveapp`, the repository
`turbo-upload`, and the workflow `publish.yml`.
