# Webhooks and push notifications

Open **Settings > Reading & connections > Webhooks and push notifications**.
Give the target a name, choose a service and select the events to send. Select
**Article scope** to limit delivery to one feed or folder. Paper checks the folders it knows
when it queues an article and again before delivery. With local reads on, a
feed you move in FreshRSS or Miniflux keeps its old folder for webhooks until
Paper's next sync.
If Paper cannot verify membership, the delivery log shows why it skipped the send.

- **Signed webhook** accepts an HTTPS endpoint. Copy the signing secret when
  you add the target. **Regenerate secret** replaces it immediately for future
  attempts, including retries. Update your receiver with the new value.
- **ntfy** accepts a topic URL and an optional access token. Paper posts the
  article title and URL as plain text, up to 1,024 characters. Use a topic
  with access controls if the articles are private.
- **Apprise API** accepts a notify URL and an optional configuration key.
  For a saved configuration, enter the URL ending in `/notify` and its key,
  or enter the complete notify endpoint. Without a key, configure the
  endpoint itself with default destinations. Paper posts JSON with a
  `body` string containing the title and URL. Add `?tag=alerts` to the notify
  URL to reach destinations tagged `alerts`. Without a tag, Apprise sends to
  the untagged destinations in the saved configuration. [Apprise API tag handling](https://github.com/caronc/apprise-api#plain-text-messages-and-headers)

Only signed webhooks receive new articles. All three services can receive
stars, manual sends and rule notifications. Choose **Notify** and a target in
**Settings > Article rules**. The target's feed or folder scope also applies to the rule. Open **Article options > Send to webhook** to queue
the selected article for every matching manual target. **Send test** queues
a sample without any article data. To change a destination URL or push
credential, add a replacement target and remove the old one. Removal deletes
that target's history and pending deliveries.

Private addresses and HTTP need the exact origin in
`PAPER_TRUSTED_SAVE_ORIGINS`, including any nondefault port. Separate origins
with commas. Save services and delivery targets share this setting because
both send article data to an administrator-approved server. Paper checks the
address on every attempt and treats redirects as failures.

Paper stores each target URL and credential in an owner-only file under
`STATE_DIR/webhooks/`. Back up this directory with the database. Queued jobs
hold article metadata in SQLite. Neither store encrypts its contents at rest.

## Webhook payload

Paper sends a UTF-8 JSON object with a [published JSON schema](webhook-payload.schema.json).
The event names and the single-entry and multiple-entry shapes follow the
[Miniflux webhook model](https://miniflux.app/docs/webhooks.html).

| Field | JSON type | Content |
| --- | --- | --- |
| `event_type` | string | `new_entries`, `starred_entry`, `save_entry`, `rule_entry` or `test` |
| `delivery_id` | string | Stable across retries of this delivery |
| `entries` | array of article objects | Present for `new_entries` |
| `entry` | article object | Present for `starred_entry`, `save_entry` and `rule_entry` |

Each article contains string fields `id`, `feed_id`, `title` and `url`.
Paper takes a snapshot when it queues the event. IDs and titles have a
512-character limit and URLs have a 2,048-character limit. An article can
have an empty URL. Test events contain only the event type and delivery ID.

```json
{
  "event_type": "new_entries",
  "delivery_id": "00000000000000000000000000000001",
  "entries": [
    {
      "id": "article-1",
      "feed_id": "feed-1",
      "title": "A new footbridge",
      "url": "https://example.test/footbridge"
    }
  ]
}
```

Paper records existing stars silently during the first import. Later star
transitions and stars you add in Paper can trigger notifications. New-article
batches include only articles dated at or after the target's creation.

A sync normally sends one new-article batch per matching target. A full
batch enters the queue at 100 articles or 32 KiB of article JSON. Each POST
fits in 64 KiB. Restarting Paper releases unfinished batches. The worker also
releases batches older than five minutes if a sync fails to finish.

## Verify a delivery

Read the raw request bytes before parsing JSON. Paper signs the Unix timestamp
in seconds, a literal period and the raw body, in that order. The key is the
displayed secret used as UTF-8 text. The signature is lowercase hexadecimal.
This Node.js example accepts timestamps within five minutes of the receiver's
clock.

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verified(headers, rawBody, secret) {
  const timestamp = headers['x-paper-timestamp']
  const signature = headers['x-paper-signature']
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false
  const expected = createHmac('sha256', secret)
    .update(timestamp + '.').update(rawBody).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}
```

After verification, record the delivery ID with your receiver's changes in
one transaction. A duplicate should return success without repeating the
action. Retries have fresh timestamps and the same delivery ID.

## Delivery log and retries

The log shows the 100 most recent deliveries. Select **Refresh log** to see
the HTTP status, attempt count, next retry and last error. Paper discards
response bodies. Any 2xx status completes delivery. A timeout after ten
seconds, a network error or another status schedules a retry.

After the first failure, Paper waits 10, 20, 40, 80, 160, 320 and 640 minutes
between attempts. After eight attempts it marks the job failed. **Retry now**
runs a scheduled retry early or gives an exhausted job one more attempt.
A receiver can see duplicates if it accepts a request just before Paper loses
the connection or restarts. Paper keeps up to 500 finished jobs for 30 days.
Pending jobs survive restarts and expire after 24 hours. A target can queue
256 deliveries or 1 MiB of article JSON. All targets together can queue
1,024 deliveries or 4 MiB. When either limit is reached, manual and test sends
report that the queue is full. The log counts dropped automatic events for
each target in five-minute windows. Successful jobs discard their article snapshots.
