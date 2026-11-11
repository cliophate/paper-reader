# Alpha.3 publication review

Status: user GO received on 2026-11-11 to commit the inspected candidate, update
PR #31 and monitor review and CI through merge. Tagging and artifact publication
remain a separate step; this checklist does not authorize a live deployment.
The target remains `0.1.0-alpha.3`, an alpha prerelease.

## Candidate and evidence

The candidate is based on local commit
`727c70ab730f1a56c26e55daafa8486b75fc7c8d`. The parser and documentation patches
were integrated and reviewed before commit. The local review packet records
the inspected patch and file hashes. Public documentation now
describes the implemented cleanup fix and its limits.

The release handoff reports alpha.2 as the published release, public main at
`2ec429f600eabebb3346a598a3b7b1042dc33c47`, and the original release-prep PR #31 at
remote head `6c02c0bcdf337d9a109ddbbbcfc799b35fc711ce`. The main and PR heads were
rechecked before the authorized update. The updated PR includes the subsequent
schema 11, search worker, date, navigation, sidebar, edit-mode and parser changes.
Do not publish the old PR head as the final alpha.3 candidate.

Fresh integrated checks on 2026-11-11 passed: dependency installation, type checks,
623 tests across 63 files, production build, all three server smokes, and the
separate article-cleanup collection regression. Runtime and AI Linux amd64 builds
and disposable installation tests passed. Network-disabled CLI checks reported
Codex 0.167.0 and OpenCode 1.19.5. License notices were unchanged, both dependency
audits reported zero vulnerabilities, and Gitleaks 8.30.1 found no leaks in the
exported public source. Documentation link, example and version checks are also
recorded in the review packet. No private data or live service was used.

The parser regression retained the two-second health deadline. It collected the
synthetic malformed article in 93 ms, with maximum health latency of 51 ms.
The separate 200,000-article smoke passed collection, concurrent state writes,
search, cancellation and shutdown checks. These synthetic results do not promise
fixed latency on every installation. Deeply nested HTML retains parser and
sanitizer costs; the owner's 10,000-level paragraph fixture took about 1.4 seconds
on the shared test host and passed its five-second watchdog.

## Gates before GO

- [x] Inspect the complete documentation patch, including this new file. Confirm
  fresh standalone setup is the normal path and FreshRSS compatibility remains.
- [x] Integrate and review the parser CPU delta. Record its regression commands,
  results and limitations against the integrated candidate. Existing search and
  collection responsiveness results do not close this gate.
- [x] Review migration warnings in README, changelog, release notes, migration and
  recovery guides. Unknown publisher IDs can create historical unread copies on
  first collection despite preserved original state. Preview cannot predict all
  future duplicates. No general cleanup tool or reverse sync is promised.
- [x] Keep #32 through #37 open in the release notes, including #35 as unconfirmed.
  Do not describe the navigation fixes as resolving those reports.
- [x] Check version consumers against `0.1.0-alpha.3`: `package.json`, both root
  version fields in `package-lock.json`, runtime and AI Compose image tags,
  Docker's version label, `scripts/pull-image.sh`, README, recovery instructions,
  changelog and tag-specific release-note links. Schema remains 11.
- [x] Run the final candidate checks below with synthetic data. Save logs and the
  exact source revision or base plus patch hashes. Reconcile pending parser and
  validation wording in the public docs with those results, then recheck docs.
- [x] Review the final diff for private data, credentials and deployment history.
  Keep optional integrations usable without credentials. Review the proposed
  PR text, release notes and About text below.
- [x] Obtain explicit GO before creating any commit or changing GitHub. The user
  authorized the PR update and monitoring through merge on 2026-11-11.
  Deployment needs separate rollout authorization.

## Final candidate validation

These application commands passed in the integrated public worktree with
synthetic fixtures. Logs and patch hashes are in the local review packet.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:smoke
node scripts/article-cleanup-responsiveness-test.mjs
npm run licenses
git diff --exit-code -- THIRD_PARTY_NOTICES.md licenses
npm audit --omit=dev --audit-level=moderate
npm audit --audit-level=moderate
```

`test:smoke` runs all three scripts: `smoke-test.mjs`, `standalone-smoke-test.mjs`
and `collection-responsiveness-test.mjs`. The collection regression needs about
6 GiB of temporary storage. The separate article-cleanup command above exercises
production collection of malformed markup. The normal test suite runs six
cleanup fixtures in killable subprocesses.

Build and exercise both Linux amd64 images, substituting the reviewed candidate's
full SHA for `REVIEWED_CANDIDATE_SHA` after an authorized commit exists. The local
builds passed using an explicit uncommitted-candidate revision label. Publication
images must use the actual approved commit:

```sh
docker build --target runtime --build-arg SOURCE_REVISION=REVIEWED_CANDIDATE_SHA -t paper-public:test .
python3 scripts/test-installation.py
docker build --target ai --build-arg SOURCE_REVISION=REVIEWED_CANDIDATE_SHA -t paper-public:ai-test .
docker run --rm --network none paper-public:ai-test codex --version
docker run --rm --network none paper-public:ai-test opencode --version
PAPER_TEST_IMAGE=paper-public:ai-test python3 scripts/test-installation.py
```

These installation checks use disposable FreshRSS and proxy containers. They
cover fresh standalone startup, FreshRSS compatibility, reviewed snapshot cutover,
rollback, settings persistence, proxy authentication and restoration. The migration
fixture uses reviewed publisher identity evidence. It does not establish safe
identity for arbitrary real-world snapshots or promise an unchanged unread count.
AI version checks run without provider access and do not validate authentication.

Review the CI secret scan as well. Recheck relative links and anchors locally,
validate embedded JSON and shell syntax, and compare command options with the
migration CLI and install helpers. Do not execute migration examples against an
installation as part of documentation validation.

## Publication order after explicit GO

1. Confirm the integrated candidate and its evidence with the coordinator. Commit
   only the inspected changes after GO. Reconcile PR #31 with the approved local
   history so its head includes the final implementation, docs and parser fix.
2. Publish or update the PR only within GO's scope, using the draft below after
   replacing its validation status with final evidence. Review final CI results,
   including image checks, before an authorized merge.
3. Confirm the exact reviewed merge or release SHA and version pins. Creating and
   pushing `v0.1.0-alpha.3` starts publication automatically. Do not push a tag as a
   test: `.github/workflows/release.yml` verifies the tag, runs checks, builds and
   tests images, pushes them and creates a GitHub prerelease.
4. After an authorized tag push, confirm the workflow succeeded for that SHA.
   Verify the two GHCR tags `0.1.0-alpha.3` and `0.1.0-alpha.3-ai`, their revision
   and version labels, and Linux amd64 architecture. Record registry digests.
5. Verify the GitHub prerelease title is `Paper 0.1.0-alpha.3` and the notes match
   the reviewed `.github/alpha-release-notes.md`. Check the runtime archive
   `paper-reader-0.1.0-alpha.3-linux-amd64.tar.gz` and its `.sha256` asset. Verify
   the checksum and loaded image label in a disposable install. There is no AI
   archive fallback; the AI variant uses its registry image or a source build.
6. Verify the published quick-start tag and links, a fresh standalone install,
   and the helper's registry and archive paths with disposable storage. Check the
   GitHub prerelease flag. Update About only if explicitly included in GO.
7. Report implementation, publication and deployment separately. A released image
   does not deploy an installation. Keep any live rollout outside this checklist
   unless the user separately authorizes it.

The workflow's `verify` job checks dependencies, types, tests, build, all three
smokes, notices and tag/package agreement. Its `publish` job tests runtime and AI
installations before pushing. The regular CI AI job checks CLI versions but does
not run the AI installation script; the release job does. No workflow behavior
changes are proposed here. A failure can leave some artifacts published, so inspect
existing tags, images and assets before any recovery attempt; do not replace them
silently.

## Draft PR description

Title: Prepare Paper 0.1.0-alpha.3 standalone release

Paper can run without FreshRSS. New installs select standalone, with local
subscriptions, article state and search. Alpha.3 adds feed discovery and OPML,
sidebar organization through the + menu and pencil/Done edit mode, schema 11
search indexing, a search worker and structural article cleanup. It also fixes missing-date crashes and
stale navigation responses after pending reader actions or page restoration.

Keep FreshRSS compatibility and optional AI, Readwise Reader and Kirby. Make fresh
standalone installation the normal alpha path. Document snapshot migration as
advanced and experimental: unknown publisher IDs can create historical copies as
new unread articles despite preserved original state. Require backups, reviewed
identity evidence and preview, with explicit rollback limits and no reverse sync.

The release uses Linux amd64 runtime and optional AI images, with a checksum-checked
runtime archive fallback. It remains a single-user alpha without built-in login.
Refresh collects due feeds only. Issues #32 through #37 remain open; the header
blur report in #35 is unconfirmed.

Local validation passed: 623 tests, type checks, production build, all three
smokes, the article-cleanup collection regression, runtime and AI builds and
disposable installations, network-disabled CLI checks, licenses, both dependency
audits and a public-source secret scan. Record the approved commit SHA and fresh
GitHub checks before merge. No release or live rollout is part of this draft.

## Draft GitHub About text

A self-hosted feed reader with standalone and FreshRSS modes, full-text articles,
search and offline reading. Early single-user alpha. Optional AI, Readwise Reader
and Kirby. Entirely AI-coded. If this steals kittens, don't blame me.

This replaces the FreshRSS-only description after approval. It has not been sent
to GitHub. Keep existing website and topics unless separately reviewed.
