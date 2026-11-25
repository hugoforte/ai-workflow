# Build your own: an agent work dashboard with a guarded action queue

One private page that shows what every agent thread is working on, and a queue through which a human can send a fixed, signed instruction back to one of those threads. This guide says how it works, read from the code and config it runs on, so you can build one like it. It does not say where any of it runs.

**Placeholders.** `<your-host>` is the one machine that builds and serves the page, `<your-domain>` the name the page answers on, `<agent-host>` the agent host whose threads do the work (here [T3 Code](https://github.com/pingdotgg/t3code)), and `<work-records>` the store of durable work state (here [rig](https://github.com/hugoforte/rig) data roots).

**What is built, and what is not.** Built and running: the reports, the snapshot, the refresh, the publisher and the private serving. Built, and run in **shadow** only, from drills: the broker's code (no listener runs), the dispatch queue, the dispatcher's scheduled task and the agent-host webhook task it posts to. **Proposed, not built:** wiring the page's buttons to the broker (section 11, decisions D1 to D6). No button on the page sends anything today.

The talk this belongs to, on how the agents themselves are organised: https://hugoforte.github.io/ai-workflow/

---

## 1. The whole system

```mermaid
flowchart TB
    subgraph agents["Agent threads"]
        CA["Chief engineer A"]
        CB["Chief engineer B"]
        CC["Chief engineer C"]
        PM["Coordinator thread"]
        CHILD["Short-lived child<br/>the coordinator delegates"]
        FALL["Scheduled fallback refresh<br/>every 15 min"]
    end

    subgraph host["your-host"]
        SNAP[("snapshot.json")]
        TPL["template.html"]
        REF["refresh script"]
        IDX["local page<br/>never served"]
        REC[("work records")]
        PUB["publisher<br/>sanitize, write, verify"]
        WEB[("webroot<br/>one index.html")]
        PROXY["reverse proxy<br/>loopback only"]
        NET["private-network listener<br/>:443, plain TCP"]
        subgraph aq["Action Queue, shadow only"]
            BRK["broker"]
            QD[("dispatch drop box")]
            DSP["dispatcher<br/>each minute"]
            QC[("callback drop box")]
            AUD[("hash-chained audit logs")]
        end
    end

    BROWSER["browser on the<br/>private network"]
    HOOK["agent-host webhook task"]
    DRILL["drill thread"]

    CA -->|WIP UPDATE| PM
    CB -->|WIP UPDATE| PM
    CC -->|WIP UPDATE| PM
    PM --> CHILD
    CHILD -->|edits| SNAP
    CHILD -->|runs| REF
    CHILD -->|runs| PUB
    FALL -->|runs| REF
    FALL -->|runs| PUB
    SNAP --> REF
    TPL --> REF
    REC -->|"read per data root"| REF
    REF --> IDX
    IDX --> PUB
    PUB -->|"atomic swap"| WEB
    PUB -.->|"fetch and compare bytes"| NET
    WEB --> PROXY
    BROWSER -->|HTTPS| NET
    NET --> PROXY
    BROWSER -->|"Open thread links"| CLIENT["agent-host web client"]
    BRK -->|"signed dispatch"| QD
    QD --> DSP
    DSP -->|"signed POST"| HOOK
    HOOK -->|"one fixed message"| DRILL
    DSP -->|"signed callback"| QC
    QC --> BRK
    BRK --> AUD
    DSP --> AUD
```

The path from the threads to the browser runs on every report. The Action Queue box runs only from a drill: nothing on the page can reach the broker yet, and the page's only working control is a link that opens a thread in the agent host's own web client.

The rule the whole design follows: **the agents supply judgement, the work records supply durable state, and only a reviewed publisher may put anything in front of a browser.**

---

## 2. Reports become a snapshot

- **One line per material change.** Each chief-engineer thread sends the coordinator thread a single line when something about its work changes, and nothing when nothing did:

  ```text
  WIP UPDATE | <org/project> | <work> | <change> | next: … | blocker/ask: … | links: … | observed: <ISO time>
  ```

- **The coordinator does not edit by hand.** It delegates a short-lived child thread that edits `snapshot.json`, runs the refresh and runs the publisher. Both of these are agent instructions, not code: no script makes a chief report or the coordinator delegate.
- **What the snapshot holds.** One source per chief: its name, owner, thread link, which work-record root to read, when it last reported, a notification note, and its items. Each item has `workId`, `key`, `project`, `title`, `status`, `category`, `next`, `blocker`, `hugoAction` (what the human must do, if anything), `observedAt` and `links`.
- **Judgement and state stay apart.** The snapshot is the chiefs' judgement. Whether a work is open, closed or abandoned, when it last moved and which repos it touches come from the work records, read fresh on every refresh.

---

## 3. The refresh builds the page

The refresh is one script beside `snapshot.json` and `template.html` in a folder that is in no repository: the combined view crosses several readerships, so it is never committed. It:

1. reads `snapshot.json` and `template.html`, and stops if either is missing;
2. for each source, reads the work records with `rig list --json --quick --data <root>`, and stops the refresh if a read fails (`-SkipRig` skips the reads);
3. matches each item to its work by `workId` and adds `rigRecordFound`, `rigActivityAt`, `rigRepos` and `rigWarning`, the last set when the records say the work closed or was abandoned;
4. serialises the payload, escapes `</script>`, and writes it as `window.__OVERVIEW__ = …` at the template's `/*__OVERVIEW_DATA__*/` marker, giving `index.html`.

The page renders only from that embedded payload and makes no request of its own. It reloads itself every 60 seconds, and marks a source stale when it has not reported for 24 hours.

**A fallback, for when nobody reports.** A scheduled agent-host task runs every 15 minutes in a fresh session. It runs the refresh, then the publisher, and treats `snapshot.json` as read-only, since only a report may change judgement. It compares only the derived fields (`rigRecordFound`, `rigActivityAt`, `rigRepos`, `rigWarning` and the read state), says `DASHBOARD UPDATE` with the works that changed or `DASHBOARD FAILURE` with the step that failed, and otherwise ends silently and settles its own thread.

```mermaid
sequenceDiagram
    autonumber
    participant Chief as Chief engineer
    participant PM as Coordinator
    participant Child as Coordinator's child
    participant Refresh as refresh script
    participant Rec as work records
    participant Pub as publisher
    participant Web as webroot
    participant Proxy as proxy via private network
    participant Browser as browser

    Chief->>PM: WIP UPDATE, one line
    PM->>Child: delegate the dashboard update
    Child->>Child: edit snapshot.json
    Child->>Refresh: run
    loop each source
        Refresh->>Rec: rig list --json --quick --data root
        Rec-->>Refresh: works, activity, repos, closed or abandoned
    end
    Refresh->>Refresh: embed the payload in the template
    Refresh-->>Child: local index.html
    Child->>Pub: publish index.html
    Pub->>Pub: sanitize, convert links, add the disabled queue
    Pub->>Web: write index.html.next, atomic replace
    Pub->>Proxy: GET the canonical URL, no redirect
    Proxy-->>Pub: status, bytes, headers
    Pub->>Pub: compare, print SHA-256
    Pub-->>Child: verified, or it throws
    Note over Browser,Proxy: within 60 s the open page reloads itself
    Browser->>Proxy: GET /
    Proxy-->>Browser: the new page
```

---

## 4. The publisher: sanitize, write, verify

The publisher takes one argument, the local page, and nothing else: its destination is fixed in the script, so no caller can point it somewhere new. It works on a temporary copy, which it deletes afterwards.

**Sanitize.** The sanitizer:

- refuses a page with no work-overview privacy marker, so an unrelated page cannot be published by mistake;
- relabels the page from "local only" to "network only" and swaps the local refresh command for a line saying updates are published automatically;
- refuses a page that still holds a drive path, a `file:` URL, a protocol-relative URL or a UNC path;
- marks the page's `<body>` as the hosted copy;
- converts each of the agent host's custom-scheme thread links (`t3-thread://v2/<environment>/<thread>`) to an HTTPS link to its web client, encoding both parts, and refuses the page if any such link is left unconverted. The conversion lives in one function, because the web route is an observed detail of the agent host and may change;
- injects the Action Queue preview (section 6) with every send control disabled.

**Write.** Under a named system mutex per webroot, the writer refuses a reparse point anywhere on the path, refuses a webroot holding any file but `index.html` and `index.html.next`, writes `index.html.next`, swaps it in with an atomic replace, and resets the file to inherit its permissions from the webroot, then checks the webroot again.

**Verify.** It requests the canonical `https://<your-domain>/` the way a reader would, with no redirect followed, and fails unless:

- the response came from that exact URL with HTTP 200;
- its bytes are exactly the sanitized bytes, so a write that landed anywhere else cannot pass while the real page is stale;
- it is valid UTF-8, has no raw custom-scheme thread link and the same number of HTTPS thread links as expected;
- it names no local path, shell command or script;
- it carries `Cache-Control: private, no-store`; a CSP with `default-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'` and a `connect-src` of `'none'` or `'self'`; `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; and a `Permissions-Policy` that turns off camera, microphone and geolocation.

It prints the SHA-256 of what was served.

---

## 5. Serving it on a private network

- **Declared once.** The site is one entry in the host's setup config: a static webroot, and an `Actions` entry naming the broker's loopback port and a mode. Setup refuses any mode but `disabled` or `shadow`, refuses `Actions` on anything but a static site that is not public, and writes the reverse proxy's config from the entry (here [Caddy](https://caddyserver.com/)). Today the mode is `disabled`.
- **The proxy listens on loopback only**, with its admin API off, automatic HTTPS off and its config not persisted. For this site it serves only `/` from the webroot, answers 404 to every other path, sets the headers the verifier checks, and drops its `Server` header. The CSP is `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **What `shadow` would change.** The generator adds a `/actions/v1/*` route that proxies to the broker, serves the page under a second handler, and loosens `connect-src` to `'self'`. With `disabled` there is no route at all.
- **The private network is the door.** The overlay network's listener (here [Tailscale Serve](https://tailscale.com/kb/1312/serve)) hands the network's port 443 to the proxy as plain TCP; the proxy holds the certificate and picks the site by the name asked for.
- **The name answers only there.** `<your-domain>` is a DNS A record at the host's address on the private network, so off that network it leads nowhere.

---

## 6. The Action Queue pattern

The pattern, in one line: **a page queues a request, a broker validates and signs it, a separate dispatcher re-validates it and posts a signed webhook to the agent host, and the agent host sends one fixed message to one allowlisted thread.** It runs in **shadow** first, where every delivery goes to a drill thread, and it goes **live** only behind a recorded human decision. Every action starts as a human's press on a card.

**On the page today: a preview.** The publisher injects a queue section built from the snapshot items that have a `hugoAction`. Each card shows why the human is needed, the context, the coordinator's recommendation and the evidence links. Its buttons (accept recommendation, hold, ask for update, skip, send now, add to batch) carry the HTML `disabled` attribute and have no handler; the one live control is an ordinary link that opens the thread in the agent host. `J`/`K` or the arrows move between cards and `Enter` opens the thread. The page has no `fetch`, and the CSP's `connect-src 'none'` would block one.

```mermaid
sequenceDiagram
    autonumber
    participant Browser as browser, future
    participant Broker as broker
    participant QD as dispatch drop box
    participant Disp as dispatcher
    participant Hook as agent-host webhook task
    participant Target as thread
    participant QC as callback drop box

    Note over Browser,Broker: needs the proxy route and a wired page, which are proposed
    Browser->>Broker: POST /actions/v1/actions
    Broker->>Broker: metadata, session, CSRF, schema, revisions, allowlist, replay, rate limit
    Broker->>Broker: audit, then sign with key A
    Broker->>QD: add eventId.json
    Broker-->>Browser: 202 queued, eventId
    Disp->>QD: take the oldest items, each minute
    Disp->>Disp: signature, expiry, replay, its own allowlist
    alt delivery mode shadow
        Disp->>Disp: target becomes the drill thread
        Disp->>Disp: audit accepted
        Disp->>Hook: signed POST, identifiers and a template id only
        Hook->>Hook: signature, filters, max age 5 min, replay key
        Hook->>Target: one fixed drill message to the drill thread
        Target-->>Hook: ACK deliveryId
    else delivery mode live, behind a recorded decision
        Disp->>Disp: refuse unless liveApproval links the decision
        Disp->>Hook: signed POST for an allowlisted chief
        Hook->>Target: one fixed live message to that chief
    end
    Disp->>Disp: audit the outcome
    Disp->>QC: signed callback with key B
    Broker->>QC: intake, checked against its own record
    Broker->>Broker: audit the callback
```

---

## 7. The broker

- **A loopback listener** on `/actions/v1/`, in one of two modes: `Disabled` or `Shadow`. There is no active mode. `GET /actions/v1/health` answers the mode and `actionsEnabled: false`; any other path but `/actions/v1/actions` is a 404; in `Disabled` every action is a 503. Request bodies are capped at 16 KiB.
- **Checks, in order, each failing closed:**
  1. the broker's target config is in `shadow`;
  2. request metadata: `POST` only, and the exact `Host`, `Origin`, `Referer` and `Content-Type: application/json`;
  3. a session: exactly one session cookie (`Path=/actions/v1; Secure; HttpOnly; SameSite=Strict`) and a CSRF token, both stored only as hashes and compared in fixed time, belonging to the configured manager's identity and not expired;
  4. a strict request: exactly the schema's fields, an action from a fixed list (`ask_for_update`, `hold`, `approve_low_impact`), a UUID request id, issued in the last 2 minutes and no more than 30 seconds ahead;
  5. the action snapshot the broker loaded at start (a file of works, each with its target, action revision and offered actions, under one revision and an expiry): it has not expired, its revision is the one the request names, the work is in it, the target owns that work, the work's action revision is current, and the action was offered for it;
  6. the allowlist: one of the three chief threads, or a child thread approved for that one work and those actions until its expiry;
  7. replay: a request id is used once;
  8. a rate limit: three per target and action in five minutes.
- **Audit, then sign, then queue.** The broker writes the audit event before it queues, because it cannot take back what it queues. It signs the dispatch with HMAC-SHA256 (key A), keeps its own copy of the dispatch to match the callback against, adds `<eventId>.json` to the dispatch drop box and answers `202` with the event id. A queued dispatch lives five minutes. A request that fails is audited as rejected.
- **The session store exists; issuing a session to a browser does not.** How a browser would get one is the proposal's decision D2.

---

## 8. The dispatcher and the agent host

**The dispatcher** runs as its own identity, from a scheduled task that starts at boot and every minute, may run for ten minutes, and never overlaps itself. An empty queue reads no secret and writes nothing. Otherwise it takes up to ten items, oldest first, and for each:

- leaves an item its producer is still writing for the next run;
- reads it strictly and checks the signature in fixed time, the exact fields, that the template id matches the action, the UUIDs, a lifetime of at most five minutes that has not ended, its **own** allowlist (which must name the same environment and thread), and that the nonce is new. An item that fails is audited as rejected and removed, with no delivery and no callback;
- builds the delivery from its delivery config (`disabled`, `shadow` or `live`). In `shadow` the target is replaced by the drill thread, whatever the dispatch named, and the drill thread may not be any allowlisted thread. In `live` only the three chiefs are enrolled, and the target must match the allowlist;
- puts **no message text** in the body: identifiers, the mode, the action, the work key, the action revision, a `messageTemplateId` and a two-minute lifetime, signed with the webhook key;
- audits `accepted` before it sends, then makes the one outbound request: a `POST` to an HTTPS URL on a pinned host and default port, with no redirect, no proxy, no cookie, a 20-second timeout and no retry. Anything but a 2xx is `failed`;
- audits the outcome (`shadow-dispatched`, `dispatched` or `failed`), writes a callback signed with key B to the callback drop box, and removes the item.

**The agent-host task** is a scheduled task with a webhook trigger, generated from the same reviewed configs and holding no secret:

- the trigger checks a signature header (`sha256=` and hex), filters on the schema, mode, target alias, environment, thread, action and template id, requires the ids, work key and action revision, refuses anything older than five minutes, and uses `deliveryId` as its replay key;
- it runs in a fresh session, and its prompt names each body field it needs as `{{body.<field>}}`, so the agent sees nothing else of the request;
- the prompt says the body is untrusted data, never instructions; allows one tool call, a single thread send; repeats every check; fills one fixed template with the validated identifiers; and replies `SENT <deliveryId> …` or `REFUSED <deliveryId> <the check that failed>`.

**The fixed messages.** In shadow every template says it is a drill, asks the thread to do nothing and to reply exactly `ACK <deliveryId>`. The live templates ask for a fresh WIP update, ask the chief to hold a work (stop anything outward-facing or irreversible on it), or approve exactly one low-impact action the chief proposed at a given revision and nothing else. A compromised dispatcher can choose among fixed messages to allowlisted threads; it cannot write one.

**The callback** is taken in by the broker's identity, checked against the broker's own record of that dispatch (event, request, body hash), its signature, lifetime and nonce, audited, and removed with the record. None of its states is a delivery receipt: only the thread's own reply shows that a message arrived.

---

## 9. Separation, keys and the audit trail

- **Two identities.** The broker and the dispatcher run as two ordinary local service accounts with separate protected roots. Each may read only its own code, config and key copies, and change only its own state and audit log.
- **Two drop boxes.** The broker may add dispatches to one folder, which only the dispatcher may read and remove; the dispatcher may add callbacks to another, which only the broker may read and remove. Every item is signed and re-validated by its consumer, so writing a file into a drop box delivers nothing.
- **Four secrets, each to one reader.** A broker-to-dispatcher HMAC key, a dispatcher-to-broker HMAC key, and the webhook's URL and signing key. They are stored encrypted, and the installer copies each, read-only, to the one identity that needs it. The broker never holds the webhook pair, and the webhook pair is not installed at all while delivery is `disabled`.
- **An installer that checks itself.** It runs elevated, `-Check` reports drift without changing anything, and an install that still has drift leaves the dispatcher's task disabled.
- **A hash-chained audit log per identity.** Each record is a JSON line with a sequence number, the previous record's hash and its own SHA-256. The chain is verified before every append, under a lock. A damaged chain, or one past its 16 MiB review limit, refuses further appends. An administrator's recovery moves the damaged file aside under a name carrying its hash, and starts a new chain whose first record names that file and hash.
- **Drills.** One runs the broker, queue, dispatcher, callback, replay and audit functions in a temporary folder with no network at all. A second, elevated, forges a dispatch that must be rejected, then has the broker's identity queue a genuine one that must reach the drill thread, while checking the broker cannot read, list, delete or re-permission what it queued.

---

## 10. Shadow before live

A message reaches a real thread only when every switch says so:

| Layer | Switch | Today |
|---|---|---|
| Route and CSP | the site's `Actions` mode: `disabled` or `shadow` | `disabled`: no route, `connect-src 'none'` |
| Broker | its target config's mode: `disabled` or `shadow` | `shadow`; the broker never chooses where a message goes |
| Delivery | the dispatcher's delivery config: `disabled`, `shadow` or `live` | `shadow`: the drill thread only |
| Agent host | the webhook task's filters and prompt, generated per mode from the delivery config | generated for shadow: the drill thread and the drill templates |

**Live needs a recorded decision.** The dispatcher refuses a `live` config unless it carries a `liveApproval` naming the configured manager, a link to the comment on an issue or pull request where the human decided, and a time not in the future; and it refuses a `liveApproval` in any other mode. So the switch is a reviewed config change that a reader can trace to the decision.

---

## 11. Proposed: making the buttons work

> **PROPOSED, not built.** Nothing in this section exists in code, config or the agent host. It is a design waiting on six decisions.

**Goal:** work through the Action Queue on the page: act on a card, move to the next, and send instructions to a thread now or in a batch.

- **Cards from the reviewed publisher.** One card per item with a `hugoAction`, with `cardId` = `<source>:<workId>`, `target` = that source's chief, and `cardRevision` = the SHA-256 of the card's canonical JSON, embedded in the page as a JSON block. The broker would validate against that same served block, so it checks exactly what the human saw, and an unchanged card survives a republish.
- **Controls stay `disabled` in the served bytes.** The page's script would enable them only after `/actions/v1/health` answers and a session exists, so a page whose broker is down reads as it does today.
- **Keys on the focused card:** `u` ask for update, `h` hold, `a` accept (when offered), `i` instruct or note (when offered), `s` skip for now (local only), `o` open in the agent host. A composer shows the inputs, an optional note of up to 1,000 characters and the exact message; `Enter` sends now, `b` adds to the batch, `Esc` cancels.
- **Batch:** a tray at the foot of the queue; "Review and send" runs a preflight (stale, conflict, paused, needs confirmation), then posts each ready item with its own request id, and one failure does not stop the rest. The 60-second reload pauses while a composer is open or the tray is not empty.
- **Status chips:** draft, sending, queued, rejected, sent to drill thread, sent, failed (or no callback within six minutes), and later acknowledged, polled from `/actions/v1/events`.
- **Tighter edges:** `connect-src` narrowed to exactly the action path, a hash for each inline script, the proxy route forwarding with a fixed `Host` and a body cap, and the broker's callback intake moved into its listener.

```mermaid
sequenceDiagram
    autonumber
    actor Human
    participant Pair as pairing script
    participant Page as page
    participant Proxy as proxy
    participant Broker as broker v2
    participant Disp as dispatcher
    participant Hook as agent-host webhook task
    participant Thread as drill thread

    Note over Human,Broker: once per browser
    Human->>Pair: run elevated
    Pair->>Broker: one-time code hash, 10 min expiry
    Pair-->>Human: the code, in the terminal only
    Human->>Page: pair this browser with the code
    Page->>Proxy: POST /actions/v1/session
    Proxy->>Broker: forwarded with a fixed Host
    Broker-->>Page: device session cookie
    Note over Human,Broker: every page load
    Page->>Broker: GET health and session
    Broker-->>Page: mode banner and CSRF token
    Page->>Page: enable the controls
    Note over Human,Thread: one action
    Human->>Page: u, then Enter
    Page->>Proxy: POST /actions/v1/actions with cardId, cardRevision, note
    Proxy->>Broker: forwarded, body capped
    Broker->>Broker: the checks of section 7, against the card revision
    Broker->>Disp: signed dispatch via the drop box
    Broker-->>Page: 202 queued
    Disp->>Hook: signed POST, note and inputs as JSON strings
    Hook->>Thread: one send in a fixed frame quoting the note
    Thread-->>Hook: ACK deliveryId
    Disp->>Broker: signed callback
    loop until the chip is final
        Page->>Broker: GET /actions/v1/events
        Broker-->>Page: sent to drill thread
    end
```

**The decisions it waits on (all open):**

| Decision | Recommended in the proposal |
|---|---|
| **D1. Scope** | Start the wiring as a new phase, replacing "the dashboard stays read-only" with "read-only unless a paired browser and the broker are both healthy; delivery stays shadow until the human enables it". |
| **D2. Sign-in** | A one-time pairing code issued by an elevated script, then a device session: 30 days at most, 12 hours idle, at most three sessions, revocable. |
| **D3. Free text** | (a) the note is the human's instruction to the chief, framed so it does not by itself authorise a merge, deploy, deletion, production change or anything outward-facing, capped at 1,000 characters; or (b) quoted data only; or (c) not in this phase. |
| **D4. Batch delivery** | One message per item, queued behind the thread's current turn, so a batch does not steer a running turn several times over. |
| **D5. Accept recommendation** | Offer it only on cards a chief marks approvable with low risk; none is marked today, so it stays hidden. |
| **D6. Rotation before live** | Whether to rotate the webhook URL, as well as its key, before the first live send. No recommendation. |

In the proposal, the human also merges each piece, approves each elevated step, and posts the "enable" comment that the live config's `liveApproval` links.

---

## 12. Build your own

1. **Pick the two sources of truth.** Agent judgement (a snapshot your coordinator thread keeps from one-line reports) and durable work state (whatever your `<work-records>` can list as JSON). Never let one overwrite the other.
2. **Generate one self-contained page.** Embed the payload in a template at a marker, escape `</script>`, make no requests from the page, and let it reload itself.
3. **Put a publisher between the page and the browser.** A fixed destination, a sanitizer that refuses rather than guesses, an atomic write into a webroot that may hold nothing else, and a check that fetches the real URL and compares bytes and headers.
4. **Serve it only on your private network.** A reverse proxy on loopback at `<your-host>`, the overlay network's listener in front of it, and `<your-domain>` resolving to the private address.
5. **Add a fallback refresh** on a schedule, which may move derived fields but never judgement, and which speaks only on a change or a failure.
6. **Only then, an action queue.** Two identities, two drop boxes, two directional keys, a fixed set of message templates, an agent-host task that treats the body as data, a hash-chained audit log for each side, and shadow delivery to a drill thread until a human records the decision to go live.

What this page leaves out on purpose: where any of it runs, the names of machines, networks, accounts and threads, the access rules in detail, and its known weak spots. Those stay in private notes.
