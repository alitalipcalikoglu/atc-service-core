# Versioning and dependency strategy

`atc-service-core` is not published to npm or any private registry. Every consuming service installs it
directly from this GitHub repository, pinned to a semver git tag:

```json
"dependencies": {
  "@atc-web/atc-service-core": "github:alitalipcalikoglu/atc-service-core#v1.19.0"
}
```

`npm ci` resolves a git dependency by cloning the tagged commit and records its exact commit SHA in
`package-lock.json`, so installs stay reproducible without a registry — consistent with every other
atc-web service ("copy the folder, `npm ci`, run").

## Why a git tag, not a registry publish

- No private npm registry exists for this workspace, and standing one up purely to host one internal
  package would be new operational infrastructure this extraction does not need.
- A git tag gives every consumer the same reproducibility guarantee (`npm ci` pins to a commit SHA)
  without adding a publish step, an auth token for a registry, or a new thing to keep running.

## Why every service pins its own tag, not a floating range

Each service's `package.json` names one exact tag (for example `#v1.19.0`), never a range like
`^1.14.0` or `main`. A git dependency has no semver-range resolution the way a registry
dependency does — even if it did, floating every service on `main` would mean **a single commit to
this repository silently changes the runtime behavior of all 12 consuming services on their next
`npm ci`**, with no per-service review point. Pinning means:

- Adopting service-core into a new service, or upgrading an existing one to a newer core version, is
  its own commit in that service's own repository — reviewed, tested, and deployed independently.
- A bug fix or new capability in core does not reach any service until that service's own commit
  bumps its pin and its own test suite (plus this package's own test suite) passes.
- Two services can legitimately sit on different core versions for a while — there is no forced
  lockstep upgrade, and nothing here requires one.

## Compatibility rules for this package itself

Semantic versioning applies to the package's own public surface (the classes and functions each
`exports` subpath re-exports, and their documented behavior):

- **Patch** (`1.0.x`): bug fixes that do not change any documented behavior.
- **Minor** (`1.x.0`): new, additive capability (a new optional constructor option, a new exported
  function) that does not change existing behavior for a caller who passes nothing new.
- **Major** (`x.0.0`): anything that changes a documented behavior or a function/constructor
  signature in a way an existing caller must react to.

A service's adoption commit records which tag it pins; bumping it is a deliberate, separate act.
