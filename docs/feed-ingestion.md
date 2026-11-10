# Feed parsing and ingestion

[#16](https://github.com/cliophate/paper-reader/issues/16) adds internal feed
parsing and ingestion for the standalone backend planned in
[#1](https://github.com/cliophate/paper-reader/issues/1). FreshRSS remains the only
selectable backend. These modules do not fetch URLs, schedule work, reconcile
reading state or change subscription organization.

## Supported feeds

`parseFeed(xml, responseUrl)` accepts a decoded XML string and the final HTTP
response URL. It supports [RSS 2.0](https://www.rssboard.org/rss-specification),
the same channel/item structure in RSS 0.91 and 0.92,
[Atom 1.0](https://www.rfc-editor.org/rfc/rfc4287), and
[RSS/RDF 1.0](https://web.resource.org/rss/1.0/spec) and 0.90. It matches XML
namespace URIs, so publishers may choose their own prefixes. Unrelated extension
items and titles do not replace feed fields.

RSS imports GUIDs, links, titles, authors, publication dates, descriptions,
`content:encoded`, Dublin Core authors/dates, and image enclosures. RDF uses the
resolved `rdf:about` URI as its source ID. Atom imports IDs, alternate links,
authors inherited from source/feed, and text, HTML and XHTML content. External
Atom content is not fetched; an inline summary can supply the body. Atom
`updated` does not substitute for a missing `published` date.

Relative article and content URLs use the final response URL and inherited
`xml:base`. Nested XHTML bases apply to links and media. Article HTML passes
through Paper's existing sanitizer. URL fields accept HTTP and HTTPS without
embedded credentials. Image `srcset` candidates are removed; the ordinary `src`
remains. Parsing does not execute scripts or load external resources.

The parser rejects malformed XML, all document types and entity declarations,
unknown XML entities, and unsupported roots. Predefined XML entities and numeric
references remain supported. Limits are 5 MiB of UTF-8 decoded input, 64 nested
elements, 100,000 elements, and 5,000 entries. No truncated feed is committed.
The HTTP collector must separately bound response bytes during transfer and
decompression, decode the response encoding, check redirects and enforce the
network policy used by `feed-repair.ts`.

## Identity and state

`ingestFeed` takes an existing backend ID, opaque subscription ID and endpoint
generation. The caller creates or repairs the subscription through
`saveLocalSubscription`. Redirects affect URL resolution only. Feed metadata
never renames, recreates or moves a subscription during ingestion.

Each item goes through `PaperDatabase.importSourceEntries` and the existing
[article identity rules](article-identity.md). GUIDs and Atom IDs remain opaque.
RSS items without IDs use the persisted fallback fingerprint. Content is never
part of an article's permanent ID. A missing or invalid publication date stays
an empty string with chronology timestamp zero; fetch time never enters the
identity fingerprint. The identity store retains first arrival and insertion
order independently. Every response entry is considered, regardless of its
publication date or the previous successful fetch time.

Identical deliveries of one explicit source ID collapse within a response.
Conflicting duplicates reject the batch, avoiding an order-dependent overwrite.
Distinct IDs stay distinct even when URLs, dates and content match. A reused
URL alone cannot establish a GUID change. If a trusted caller has verified a
publisher ID change, it may supply `verifiedAliasChanges` with prior IDs and a
nonempty evidence description. This is an internal trust boundary, not feed
metadata or an API for untrusted clients. The caller must retain its evidence;
ingestion does not verify the claim or persist an evidence audit. Conflicting
known aliases produce an ambiguity outcome instead of merging articles.
Without evidence, changed IDs produce separate articles. An ID-free item whose
fallback fields all change may also become a separate article.

Content updates preserve read/star state, revisions, first arrival, progress,
discussions, briefings, collections and historical URL associations. Missing
items are retained. Ingestion never treats absent feed state as an unread or
starred snapshot.

## Successful fetch contract

The HTTP collector supplies `requestUrl`, final `responseUrl`, `fetchedAt`, and a
persisted opaque `endpointGeneration`. Change the generation whenever the
configured endpoint changes, including repairs back to a previously used URL.
Keep the subscription ID. Before committing a response, the collector must
verify that its subscription and generation are still current and serialize
fetch commits for that subscription. The
[standalone collector](feed-scheduling.md) enforces these checks and commits
conditional HTTP state with the ingestion transaction.

The ingestion module constructs a versioned checkpoint key from a structured
subscription/generation tuple under the existing backend scope. It stores the
successful fetch time and request/response URLs. `successfulFeedFetch` reads
that checkpoint after restart. HTTP validators must use the same endpoint
scope, but this checkpoint does not claim to implement ETags, Last-Modified,
retry state, stale-response fencing or 304 handling.

The optional fourth `importSourceEntries` argument supplies a checkpoint
key/value. The database commits it after entry resolution and content updates
inside the same transaction. Empty parsed feeds advance the checkpoint and
still run backend/subscription ownership checks. An item error rolls back the
whole batch. A checkpoint write failure also rolls back entries, aliases,
arrival rows and ambiguity records. The previous checkpoint remains intact.

Success means a parsed batch committed with explicit identity outcomes. It does
not mean every item resolved. Ambiguities persist through `IdentityStore` and
appear in the returned results/counts; unrelated resolved entries commit with
the successful-fetch checkpoint. A future collector must report those
ambiguities instead of treating them as silently imported content.

## Verification

Synthetic fixtures in `tests/fixtures/feeds` cover each feed family. Parser and
ingestion tests cover malformed and bounded XML, unsafe markup, namespaces,
relative URLs, duplicate IDs, missing dates, backdated arrivals, changed IDs and
URLs, repair, disappearance/reappearance, state and reference preservation,
restart persistence, explicit ambiguities and failed transactions. No schema
migration or changes to organization contracts are required.
