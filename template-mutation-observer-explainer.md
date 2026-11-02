# Explainer: Observing `<template for>` Lifecycle with `MutationObserver` (`template`)

## Introduction

When the HTML parser processes a `<template for="...">` patch (inline via [Interleaved HTML Streaming](./patching-explainer.md) or fetched via [`<template for="..." src="...">`](./fragment-include-explainer.md)), it consumes the `<template>` element itself and streams its contents directly into the targeted range (`<?start name="...">...<?end>` or `<?marker name="...">`) without inserting the `<template>` into the DOM.

Because standard `MutationObserver` records only report `addedNodes` and `removedNodes` on the target container—dropping the `<template>` wrapper's lifecycle and attributes—reconstructing patch state in userland is **easy to get wrong and leads directly to user-facing bugs**:
- **Lost input & focus (`"start"` / `"update"` / `"end"`):** Without knowing when a streamed patch begins clearing fallback content vs. finishes streaming, client code can clobber unsaved form input, drop keyboard focus, or run enhancement logic on half-streamed markup.
- **Misattributed mutations:** Client-side UI mutations on the same container can be confused with incoming server patches, and server metadata attributes on the `<template>` (`for`, `src`, `data-turn`, request IDs) are lost across network chunks.
- **Silent failures & hung loading states (`"abort"`):** When a stream truncates mid-response, a target marker is missing, or a `<template for src>` fetch fails CORS, CSP, `text/fragment` MIME, or `integrity` checks—often with zero DOM nodes inserted—applications get no signal to clear spinners or show retry UI.

This explainer proposes an opt-in `template: true` option on `MutationObserverInit` that surfaces `templateStatus` and `templateAttributes` on `MutationRecord`s produced by parser-consumed `<template for>` operations.

*(For batching `MutationObserver` records until an element finishes parsing, see [parse-end-mutation-observer-explainer.md](./parse-end-mutation-observer-explainer.md).)*

---

## Prior Discussions

- [whatwg/html#13008](https://github.com/whatwg/html/issues/13008), [WICG/declarative-partial-updates#110](https://github.com/WICG/declarative-partial-updates/issues/110), [#104](https://github.com/WICG/declarative-partial-updates/issues/104), [#103](https://github.com/WICG/declarative-partial-updates/issues/103), [#21](https://github.com/WICG/declarative-partial-updates/issues/21), & [#26](https://github.com/WICG/declarative-partial-updates/pull/26): reflection, lifecycle, and failure semantics of `<template for>`
- [whatwg/html#11818](https://github.com/whatwg/html/pull/11818) & [#13075](https://github.com/whatwg/html/issues/13075): `<template for>` parser specification
- [whatwg/html#12744](https://github.com/whatwg/html/issues/12744): parser `Text` node data modification and `MutationObserver` batching
- [whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287) & [#1439](https://github.com/whatwg/dom/issues/1439): observing Declarative Shadow DOM attachment (see [Considered Extensions](#considered-extensions-not-currently-proposed))

---

## Use Cases & Goals

In streaming UIs that update regions via `<template for>` or `<template for src>`, client code needs to coordinate around patch boundaries without moving DOM rendering into JavaScript or embedding fragile sentinel nodes / inline `<script>` tags (which add wire overhead, require CSP nonces or `unsafe-inline`—impossible in default-sanitized `<template for src>` includes—and fail to fire on truncated or failed fetches):

1. **Form-state & focus preservation ([#103](https://github.com/WICG/declarative-partial-updates/issues/103)):** Inspecting `removedNodes` on `"start"` and `addedNodes` during `"update"` / `"end"` to preserve focus, selection, or unsaved input state across declarative partial updates.
2. **Metadata-driven routing & analytics ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** Reading custom attributes placed on `<template>` by the server (e.g., `<template for="chat" data-turn="3" data-request-id="abc">`) and correlating all multi-chunk DOM mutations belonging to that `<template>` invocation.
3. **Failure & truncation recovery ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)):** Surfacing retry UI or logging errors when a streamed `<template for>` response drops before `</template>`, when a target marker is missing or moved mid-stream, or when a `<template for src>` fetch fails.

### Goals & Non-Goals

- **Goals:** Expose `<template for>` lifecycle (`"start" | "update" | "end" | "abort"`) and attributes (frozen `record<DOMString, DOMString>`) alongside `addedNodes` and `removedNodes` on `MutationRecord` ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)); keep template-initiated records strictly separated from unrelated DOM mutations with **zero cost when `template: true` is unused**; preserve existing `MutationRecord.type` values (`"attributes" | "characterData" | "childList"`).
- **Non-Goals:** Exposing live detached `HTMLTemplateElement` nodes (attributes are exposed via a frozen plain object instead); batching element children until end tags (handled separately by [`delivery: "parse-end"`](./parse-end-mutation-observer-explainer.md)).

---

## Proposed Approach

Passing `template: true` in `MutationObserverInit` enables **per-observer record filtering and projection** for parser-consumed `<template for>` operations, populating two nullable fields on template-initiated `MutationRecord`s (and `null` on all other records):

- **`record.templateStatus`:** `"start" | "update" | "end" | "abort"`, or `null`.
- **`record.templateAttributes`:** A frozen plain object (`record<DOMString, DOMString>` snapshot of the `<template>` element's attributes, e.g. `{ for: "chat", "data-turn": "3" }`), or `null`. All records emitted by a single `<template>` invocation share the **same object identity** (`r1.templateAttributes === r2.templateAttributes`).

Observers registered without `template: true` never receive template-only empty `childList` lifecycle records, and always observe `templateStatus === null` and `templateAttributes === null`.

### Example Usage

```js
const observer = new MutationObserver((records) => {
  for (const r of records) {
    const attrs = r.templateAttributes;
    if (!attrs) continue;

    const targetName = attrs.for;
    const turn = attrs["data-turn"];

    switch (r.templateStatus) {
      case "start":
        onPatchStart(r.target, targetName, turn, r.removedNodes);
        break;
      case "update":
        if (r.type === "childList") onPatchNodes(r.addedNodes, turn);
        break;
      case "end":
        onPatchEnd(r.target, targetName, turn);
        break;
      case "abort":
        onPatchAbort(r.target, targetName, attrs.src);
        break;
    }
  }
});

observer.observe(document, {
  subtree: true,
  childList: true,
  characterData: true,
  template: true,
});
```

### Web IDL

```webidl
partial dictionary MutationObserverInit {
  boolean template = false;
};

enum TemplateStatus { "start", "update", "end", "abort" };

partial interface MutationRecord {
  readonly attribute TemplateStatus? templateStatus;
  readonly attribute object? templateAttributes; // Frozen record<DOMString, DOMString>
};
```

*(Note on Web IDL: because Web IDL forbids `record<K, V>` directly as an attribute type, `templateAttributes` has IDL type `object?` and returns a frozen plain object created once per `<template>` invocation by converting an ordered attribute map via Web IDL `record<DOMString, DOMString>` conversion, preserving `r1.templateAttributes === r2.templateAttributes`.)*

---

## Detailed Design

### Lifecycle Phases (`templateStatus`)

| Phase | When emitted | `record.target` & payload |
|---|---|---|
| **`"start"`** | When `<template for>` resolves its target and begins applying (for `<template for src>`, once response headers validate and streaming begins). | `childList` record on the patch target parent: removes `<?start>` and fallback nodes, or has empty `addedNodes`/`removedNodes` with `nextSibling: <?marker>`. |
| **`"update"`** | As nodes and text stream into the patch target across one or more chunks. | `childList` records (and parser-flushed `characterData` records, **pending [whatwg/html#12744](https://github.com/whatwg/html/issues/12744)**) inside the target subtree. |
| **`"end"`** | When the matching `</template>` (or end of a complete `<template for src>` stream) is reached. | `childList` record on the patch target parent removing `<?end>` or `<?marker>`. |
| **`"abort"`** | When a patch fails or terminates abnormally: EOF or stream abort before `</template>` ([#104](https://github.com/WICG/declarative-partial-updates/issues/104)), marker moved/removed mid-stream ([whatwg/html#11818](https://github.com/whatwg/html/pull/11818)), missing target marker, or `<template for src>` fetch/CORS/CSP/`text/fragment`/`integrity` failure. | `childList` record on the patch target parent (or on the fallback `<template>` insertion parent if target resolution failed). |

- **Attribution & separate batching:** Only mutations directly performed by the HTML parser as part of that `<template for>` operation carry non-null `templateStatus` and `templateAttributes`. Imperative script mutations on the target container during a paused stream (e.g., `section.append(node)`), custom-element constructor/upgrade side-effects, or sibling mutations have `templateStatus: null` and `templateAttributes: null`. Template-initiated records are **batched separately** from non-template records (and per `<template>` invocation) so they are never coalesced with unrelated mutations.
- **Why `type: "childList"` even when `addedNodes` and `removedNodes` are empty:** Lifecycle boundaries such as `"start"` on `<?marker>`, empty patches (`<template for="r"></template>`), or pre-stream `"abort"` use `type: "childList"` rather than inventing new `MutationRecord.type` strings. Reusing `"childList"` avoids confusion and extra type-branching in observer callbacks, and an opt-in empty `NodeList` (never delivered when `template: false`) is harmless compared to splitting metadata away from node-carrying `childList` records.
- **Dependency on [whatwg/html#12744](https://github.com/whatwg/html/issues/12744) for multi-chunk text:** HTML parsers currently append streamed characters to an open `Text` node without queueing `characterData` records. Emitting `characterData` `"update"` records when a `Text` node spans chunks depends on resolving [whatwg/html#12744](https://github.com/whatwg/html/issues/12744); until then, only `childList` `"update"` records fire.
- **Correlation identity ([#110](https://github.com/WICG/declarative-partial-updates/issues/110)):** Every `"start"`, `"update"`, `"end"`, and `"abort"` record from a single `<template>` invocation shares the exact same frozen `templateAttributes` object (`r1.templateAttributes === r2.templateAttributes`), making `WeakMap` per-patch state trivial.
- **Option validation & `subtree` scoping:** Passing `template: true` with `childList: false` throws a `TypeError`. Because `"start"`, `"end"`, and `"abort"` target the patch range's parent element (or fallback `<template>` parent), observing `document` or an ancestor above that parent requires `subtree: true` to receive patch records on descendant containers.
- **Sanitization & CSP nonces:** `templateAttributes` only exposes attributes that survived any active sanitizer ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)), and `nonce` attributes follow standard nonce-hiding rules ([WICG/declarative-partial-updates#111](https://github.com/WICG/declarative-partial-updates/issues/111)).

### Walkthrough A: `<template for>` across two network chunks

Given `<section><?start name="r">Loading…<?end></section>`, when `main.streamAppendHTML(...)` receives chunk 1 (`<template for="r" data-turn="3"><p>H`) and chunk 2 (`i<span>!</span></p></template>`) under `{ childList: true, characterData: true, subtree: true, template: true }`:

| # | Chunk | `type` | `target` | `removedNodes` | `addedNodes` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `childList` | `<section>` | `[<?start>, "Loading…"]` | `[]` | `{ for: "r", "data-turn": "3" }` | `"start"` |
| 2 | 1 | `childList` | `<section>` | `[]` | `[<p>]` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 3 | 1 | `childList` | `<p>` | `[]` | `["H"]` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 4* | 2 | `characterData` | `"Hi"` | `[]` | `[]` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 5 | 2 | `childList` | `<p>` | `[]` | `[<span>]` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 6 | 2 | `childList` | `<span>` | `[]` | `["!"]` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 7 | 2 | `childList` | `<section>` | `[<?end>]` | `[]` | `{ for: "r", "data-turn": "3" }` | `"end"` |

*(\*Record #4 requires [whatwg/html#12744](https://github.com/whatwg/html/issues/12744) for parser `Text` node data mutations.)*

### Walkthrough B: Single-point marker (`<?marker>`) with empty `childList` at `"start"`

When `<template for="r" data-turn="3"><p>Hi</p></template>` targets `<section><?marker name="r"></section>` in a single chunk, `<?marker>` stays in place as the insertion anchor until `</template>` removes it:

| # | `type` | `target` | `removedNodes` | `addedNodes` | `nextSibling` | `templateAttributes` | `templateStatus` |
|---|---|---|---|---|---|---|---|
| 1 | `childList` | `<section>` | `[]` | `[]` | `<?marker>` | `{ for: "r", "data-turn": "3" }` | `"start"` |
| 2 | `childList` | `<section>` | `[]` | `[<p>]` | `<?marker>` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 3 | `childList` | `<p>` | `[]` | `["Hi"]` | `null` | `{ for: "r", "data-turn": "3" }` | `"update"` |
| 4 | `childList` | `<section>` | `[<?marker>]` | `[]` | `null` | `{ for: "r", "data-turn": "3" }` | `"end"` |

*(Observers without `template: true` never receive record #1 or any record where `addedNodes` and `removedNodes` are both empty.)*

---

## Considered Extensions (Not Currently Proposed)

- **Observing Declarative Shadow DOM (`<template shadowrootmode="open">`):** Extending `template: true` to emit `"start"` / `"end"` / `"abort"` records on the shadow host for `<template shadowrootmode="open">` (never `"closed"`), or addressing shadow root discovery ([whatwg/dom#1287](https://github.com/whatwg/dom/issues/1287), [#1439](https://github.com/whatwg/dom/issues/1439)) via a non-parser-specific hook covering both `attachShadow()` and DSD.
- **Fragment Parsing Context (`record.parserContextElement`):** Exposing `readonly attribute Element? parserContextElement` on `MutationRecord` for `streamHTML*()` / `setHTML()` / `innerHTML` if use cases aren't already covered by `templateAttributes` and container-scoped observers.

---

## Alternatives Considered & FAQ

1. **New `MutationRecord.type` values (`"templateStart"`, `"templateEnd"`, `"templateAbort"`):** Separated `<template>` metadata from the `childList` records carrying `addedNodes` and `removedNodes`, causing callback confusion and forcing stateful tracking across records; keeping `type: "childList"` (even when `addedNodes`/`removedNodes` are empty under `template: true`) is simpler and harmless by comparison.
2. **Bespoke `TemplateAttributeMap` interface or detached `HTMLTemplateElement` (`record.template`):** Retaining a detached `<template>` leaks a bypassed parser node, while adding a new `maplike` interface adds unnecessary Web IDL surface when a frozen `record<DOMString, DOMString>` object gives direct property lookup (`attrs.for`, `attrs["data-turn"]`) and stable `===` identity.
3. **DOM Events (`templatestart`, `templateend`, `templateabort`) or a separate `PatchObserver`:** Hydration and form-state preservation ([#103](https://github.com/WICG/declarative-partial-updates/issues/103)) need `removedNodes` and `addedNodes` together with `<template>` metadata in the same microtask batch, without `MutationEvent` dispatch overhead.
4. **Combining `template: true` and `delivery: "parse-end"` into a single `parser: true` option:** `<template for>` observers want incremental per-chunk `"start"` / `"update"` / `"end"` records, whereas [`delivery: "parse-end"`](./parse-end-mutation-observer-explainer.md) buffers records until an observed target finishes parsing. If an observer sets both, they compose cleanly (`template: true` populates the fields while `delivery: "parse-end"` holds delivery until target parse end).

---

## [Self-Review Questionnaire: Security and Privacy](https://w3c.github.io/security-questionnaire/)

`template: true` exposes no new user or cross-origin information: it reflects only `<template for>` attributes that survived sanitization (with standard CSP `nonce` hiding) on a DOM subtree the caller can already observe, and reports failed `<template for src>` fetches via `templateStatus: "abort"` without leaking cross-origin response bodies or failure reasons.

<details>
<summary><strong>Full Security & Privacy Questionnaire Responses (1–22)</strong></summary>

1. **What information does this feature expose, and for what purposes?**
   No new user or cross-origin information. All state surfaced by `template: true` originates from `<template for>` markup parsed into a DOM subtree the caller can already observe (for external `<template for src>` includes, only after standard CORS, CSP `fragment-src`/`script-src`, and `text/fragment` checks; failed fetches report `templateStatus: "abort"` without exposing cross-origin response bodies or failure details).

2. **Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?**
   Yes: `templateAttributes` only reflects attributes that survived the sanitizer ([whatwg/html#12756](https://github.com/whatwg/html/pull/12756)), and `nonce` attributes follow standard nonce hiding ([WICG/declarative-partial-updates#111](https://github.com/WICG/declarative-partial-updates/issues/111)).

3. **Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?**
   No.

4. **How do the features in your specification deal with sensitive information?**
   N/A.

5. **Does data exposed by your specification carry related but distinct information that may not be obvious to users?**
   No.

6. **Do the features in your specification introduce state that persists across browsing sessions?**
   No.

7. **Do the features in your specification expose information about the underlying platform to origins?**
   No.

8. **Does this specification allow an origin to send data to the underlying platform?**
   No.

9. **Do features in this specification enable access to device sensors?**
   No.

10. **Do features in this specification enable new script execution/loading mechanisms?**
    No. `MutationObserver` callbacks run at the standard microtask checkpoint.

11. **Do features in this specification allow an origin to access other devices?**
    No.

12. **Do features in this specification allow an origin some measure of control over a user agent's native UI?**
    No.

13. **What temporary identifiers do the features in this specification create or expose to the web?**
    N/A.

14. **How does this specification distinguish between behavior in first-party and third-party contexts?**
    N/A (same-origin DOM observation only).

15. **How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?**
    Identically to normal browsing mode.

16. **Does this specification have both "Security Considerations" and "Privacy Considerations" sections?**
    It is intended to be integrated into the WHATWG DOM and HTML Standards.

17. **Do features in your specification enable origins to downgrade default security protections?**
    No.

18. **What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?**
    Nothing beyond existing `MutationObserver` behavior.

19. **What happens when a document that uses your feature gets disconnected?**
    Disconnecting the target document or container during an active `<template for>` / `<template for src>` halts the patch and surfaces `templateStatus: "abort"` per standard `MutationObserver` lifecycle rules.

20. **Does your spec define when and how new kinds of errors should be raised?**
    Parser-aborted or fetch-aborted `<template for>` operations are reported via `templateStatus: "abort"` rather than exceptions; passing `template: true` with `childList: false` throws a `TypeError`.

21. **Does your feature allow sites to learn about the user's use of assistive technology?**
    No.

22. **What should this questionnaire have asked?**
    Nothing.

</details>
