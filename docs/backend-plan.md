# Standalone backend implementation plan

The goal is [#1](https://github.com/cliophate/paper-reader/issues/1): one Paper
container that can collect feeds and manage reading state, with FreshRSS kept as
an optional backend. [#13](https://github.com/cliophate/paper-reader/issues/13)
owns folder and subscription organization. This document records the current
dependencies, the first change, and the requirements for the remaining stages.

## Current dependency audit

| Area | Current owner and dependency | First-stage treatment |
| --- | --- | --- |
| Reader, search, filters, progress | `PaperDatabase` and `PaperRepository` read SQLite after backfill. | Keep the database and local read path. |
| Initial and disabled-local reads | Server routes and the briefing CLI use FreshRSS before local reads activate, or when `PAPER_LOCAL_READS=false`. | Read through `ReaderBackend` selected by `createReaderBackend`. |
| Import | Synchronizer imports navigation, paged entries and entries by ID. It persists backfill continuation, uses a ten-minute arrival overlap and reconciles complete unread/starred ID sets. | Use the common contract. Keep checkpoints, scheduling and reconciliation behavior. |
| State writes | Synchronizer writes FreshRSS first, then local read/star flags, activity and events. It serializes writes and imports. | Keep remote authority and failure ordering. |
| Subscriptions | FreshRSS quick-add, rename/move, unsubscribe and the repair helper. Routes also know FreshRSS feed ID formats. | Keep operations and ID validation in the adapter. |
| Navigation and ordering | FreshRSS subscriptions/categories and unread counts, plus the optional health helper and its folder order. SQLite stores folder positions and memberships. | Preserve the same navigation payload and ordering. |
| Article identity | FreshRSS Google Reader IDs are SQLite primary keys. Numeric item references become canonical IDs inside `freshrss.ts`. | Preserve every existing ID. Backend operations pass IDs and continuations unchanged; remaining consumer assumptions are listed below. |
| References | Progress, discussions, briefings, collections, coverage, headline caches, reports, mute matches and undo data refer to entry IDs. Article extraction and Readwise saves also use URLs. | Change no keys or schemas. Migration must cover both foreign keys and serialized references. |
| Configuration | `loadConfig`, init/setup scripts, container examples and Settings guidance assume required FreshRSS credentials. | Keep the required configuration until standalone setup is implemented. |
| Feed parsing | `feed-repair.ts` previews a few RSS/Atom items using bounded fetches and URL checks. | Reuse its security policy later. It is not a collector or identity implementation. |
| Integration helpers | `integrations/paper-feed-health.php` and `paper-feed-repair.php` supply FreshRSS-specific health, ordering and URL repair. | Leave the helpers and protocol inside the FreshRSS integration. |
| Other integrations | AI, Readwise and Kirby have their own optional settings. | Keep them optional. Never expose saved credentials through backend contracts. |
| Shared content classification | SQLite imports an editorial-feed helper from `freshrss.ts`. | Move kind detection and that helper into `entry-kind.ts` so storage no longer imports the adapter. |
| Filter feed scope | `/api/filters` validates the FreshRSS `feed/` prefix. | Delegate validation to the adapter and preserve the existing `Unknown feed` response. |
| Briefing folder selection | `BriefingService.generate` resolves Writers through navigation. | #18 retains the selected ID for standalone folders and resolves the current title for FreshRSS, whose category IDs change on rename. |
| Client feed actions and copy | The article unsubscribe menu checks `feed/`; Settings and messages name FreshRSS. | #21 must use backend capabilities or opaque subscription IDs and update copy before standalone selection. |
| Parity arrival order | `PaperDatabase.syncEntryIds` sorts fixed-width hexadecimal FreshRSS IDs to compare arrival order. | Preserve current parity checks. #15 must define explicit arrival ordering or adapter-specific parity before new Paper IDs enter this path. |

## First stage

[#14](https://github.com/cliophate/paper-reader/issues/14) introduces
`backend.ts`. `EntrySource` describes common reads. `ReaderBackend` adds paged
imports, lookup by IDs, explicit state changes and existing subscription
operations. Feed repair remains optional. Adapter validation preserves the
current feed ID rules and HTTP 400 messages before network requests, including
feed-scoped filter validation.

`FreshRssClient` implements that contract. It still owns authentication,
Google Reader paths, canonicalization, content normalization, HTTP retries and
the PHP helper calls. `create-backend.ts` is the only production module that
constructs the client. Both the HTTP service and briefing CLI use that factory.

`BackendSynchronizer` uses the common operations. The repository remains a read
model, and `switchingEntrySource` keeps existing consumers working when the first
import completes. Backend pagination supports import date bounds; local read
pagination retains its own date strings, search and ordering behavior. The
FreshRSS adapter does not implement server-side text search. The existing route
continues scanning and filtering remote pages.

This stage adds no backend selector, schema migration, RSS collector or folder
controls. FreshRSS remains required. Existing protocol behavior, UI copy,
configuration names and sync markers remain compatible.

## Article identity requirements

[#15](https://github.com/cliophate/paper-reader/issues/15) implements these rules in
[Article identity and state ownership](article-identity.md), including migration
recovery and the design required before offline writes or backend switching.


Implement these in [#15](https://github.com/cliophate/paper-reader/issues/15)
before collecting feeds:

- An article ID is immutable. Keep existing FreshRSS IDs as valid Paper IDs.
  New standalone articles receive durable Paper IDs. Persist external aliases
  separately, scoped by backend instance, subscription and external ID.
- Subscription IDs survive title, URL and folder changes. A folder title or
  feed URL must never be the primary key of a new standalone subscription.
- Match a source item by its persisted alias first, then RSS GUID or Atom ID
  within that subscription. Define and test a deterministic fallback using
  available stable source fields for feeds without IDs. Do not use a mutable
  content hash as the article's permanent ID.
- Persist aliases when an unambiguous existing item changes external ID or URL.
  Record ambiguous matches for review. Shared URLs alone do not justify merging
  articles across subscriptions or destroying either article's state.
- Separate publication time, first arrival and fetch checkpoints. Backdated
  articles must arrive even when their publication date precedes the last fetch.
- Content updates must retain read/star flags, reading progress, discussions,
  briefing references, collection membership and coverage. Removing an item
  from a later feed response must not delete its history.
- Migration must preserve references stored in tables, JSON, browser links and
  undo actions. Keep URL-based extraction and Readwise associations valid when
  URLs change. Back up first, make migration resumable and validate references
  before enabling a new mode. Never match between accounts by an unscoped ID.

## State ownership and failure requirements

FreshRSS mode keeps remote authority. An acknowledged write precedes local
state, activity and events. Imports and writes use the same queue. A rejected
operation must leave local state alone and must not block later operations.
Complete unread/starred snapshots drive reconciliation; article content upserts
must not overwrite already stored state. A partial or failed snapshot must not
be interpreted as a complete empty set.

FreshRSS can partially apply a large batch before a later request fails. The
current local state remains unchanged for that failed operation and a later
sync reconciles it. This stage does not add atomic remote batches, durable
queued writes or offline write support.

Standalone mode must own read/star state in SQLite. Content imports must never
reconcile it against a remote feed's missing state. Commit a local state change,
its activity and any pending work atomically; publish events after commit.
Use explicit set-state operations so retries are idempotent. Define revisions
and conflict rules for concurrent devices and undo so stale work cannot silently
overwrite a later decision. Restart recovery must retain pending work.

The current synchronizer assumes a remote source with complete state snapshots.
A standalone collector must use its own ingestion/state workflow rather than
reconcile local state through an empty remote snapshot. Define backend-scoped
checkpoints and migration rules before sharing a database between modes.

## Organization requirements

[#18](https://github.com/cliophate/paper-reader/issues/18) implements the internal
standalone service and schema v8. [Folder and subscription organization](organization.md)
defines its commands, revision and bulk-result contract, migration recovery,
Writers resolution and the FreshRSS capability limits. It adds no sidebar
controls or standalone selector.

[#19](https://github.com/cliophate/paper-reader/issues/19) then adds sidebar,
drag-and-drop, mobile and keyboard controls using those operations and their
backend capabilities. FreshRSS folder writes and ordering remain unsupported
until its adapter can preserve those operations.

## Ordered work

| Order | Issue | Deliverable and dependency |
| --- | --- | --- |
| 1 | [#14](https://github.com/cliophate/paper-reader/issues/14) | Common backend operations and FreshRSS adapter. Merged in #23. |
| 2 | [#15](https://github.com/cliophate/paper-reader/issues/15) | Durable identity, aliases and local state ownership. Follows #14. |
| 3 | [#16](https://github.com/cliophate/paper-reader/issues/16) | RSS/Atom ingestion and repeatable content updates. Follows #15. |
| 4 | [#17](https://github.com/cliophate/paper-reader/issues/17) | Conditional fetching, bounded concurrency, timeouts, backoff and restart recovery. Follows #16. |
| 5 | [#13](https://github.com/cliophate/paper-reader/issues/13), [#18](https://github.com/cliophate/paper-reader/issues/18), [#19](https://github.com/cliophate/paper-reader/issues/19) | Organization storage follows #15 and can run alongside ingestion. Sidebar controls follow storage. |
| 6 | [#20](https://github.com/cliophate/paper-reader/issues/20) | Discovery and OPML with duplicate and folder policies. Follows ingestion and organization storage. |
| 7 | [#21](https://github.com/cliophate/paper-reader/issues/21) | Explicit backend selection, standalone setup, resumable migration, backup/restore docs and release verification. Follows fetching, organization UI and OPML. |
| 8 | [#22](https://github.com/cliophate/paper-reader/issues/22) | Separate rollout to a named private installation after authorization. A public PR or push does not deploy it. |

## Verification

Use synthetic fixtures for every stage. For this first stage, run type checks,
the unit suite, the production build, server smoke checks and the disposable
FreshRSS installation test described in [development.md](development.md).
Regression coverage must include backend failure ordering, serialization of
imports and writes, queue recovery, local-read activation, article-reference
preservation, remote reads and subscription ID validation. The installation
test covers real FreshRSS import, two-way state changes, repair, proxy
authentication, optional settings persistence and restore.

Future stages add feed-format and identity fixtures, conditional HTTP responses,
interrupted work, malformed or unsafe feeds, concurrent organization changes,
large subscription lists and migration rollback. Standalone release acceptance
requires a clean one-container setup without FreshRSS or optional credentials.
