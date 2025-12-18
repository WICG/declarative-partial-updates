# Dynamic markup - revamped

## Overview
The web platform has multiple various ways to dynamically inject HTML into an existing document using script:
- `setHTML`
- `setHTMLUnsafe`
- `innerHTML` and `outerHTML` setters
- `createContextualFragment`
- `insertAdjacentHTML`

Additionally, there is emerging work to allow injecting markup via stream, with the `streamHTML` and `streamHTMLUnsafe` methods. See https://github.com/whatwg/html/issues/2142.

These methods all have explicit and implicit knobs and consideration:
- What is the insertion point (replace children? append? etc)
- Synchronous vs. streaming
- [Safe vs. unsafe](https://wicg.github.io/sanitizer-api/#safe-and-unsafe)
- Is there a sanitizer?
- Do scripts run? If so, when?
- Relationship with trusted types.
- Element creation side-effects (e.g. image preloading).

The purpose of this explainer is to set a coherent way forward with dynamic markup insertion, in a way that takes all of these considerations into account while remaining consistent in terms of API.

## API design

Following API decisions in the DOM spec, the direction of the APIs here is to expose separate methods for the following permutations:
- Synchronous vs. streaming, as those have different arguments and return values
- Insertion point (replaceChildren, replaceWith, before, after, append, prepend),
  as making a "positional" argument doesn't add much to readability and discoverability.
- Safe vs. unsafe, to have the differences explicit when looking at call sites.

The following are optional (or implicit):
- Sanitizer
- Do scripts run

## Script Execution

### `runScripts`

Currently, only `createContextualFragment` is capable of running scripts in dynamic markup.
The scripts are executed after the markup is inserted. Unlike regular parsing, classic external scripts are not
parser-blocking, as it's awkward to block a synchronous call on an asynchronous fetch.

The new proposal here is to add a `{runScripts: boolean}` option, false by default, to the `SetHTMLUnsafeOptions` dictionary.
This would allow any unsafe HTML setter to run scripts in a similar fashion to `createContextualFragment`.

Note that `runScripts` is not available for safe dynamic markup injection.

### Scripts & streaming

For streaming, the processing model would be different, as the streaming parser is not a synchronous call.
In the streaming case, script execution would behave more like the main parser, where classic scripts block furher parsing,
and scripts with `defer` (including `module` scripts) are executed when the stream is closed and the parser finishes
processing the entire markup.

## Sanitizer integration

Both safe and unafe variants can receive a `sanitizer` option. As per the sanitizer spec,
the safe variants ensure that the sanitizer config has a few baseline features. See https://wicg.github.io/sanitizer-api/.

## Trusted types integration

The current API for trusted types policies rely on transforming HTML strings before they are passed to the parser.
This is incompatible with how the sanitizer works, and also doesn't work well with streaming, as userspace sanitation
libraries such as `DOMPurify` would have to support streaming as well.

The proposal is that trusted types would be able to participate in a flow that involves streaming and/or sanitizer
by transforming or "blessing" a parser options dictionary ([`SetHTMLOptions`](https://wicg.github.io/sanitizer-api/#dictdef-sethtmloptions) or [`SetHTMLUnsafeOptions`](https://wicg.github.io/sanitizer-api/#dictdef-sethtmlunsafeoptions)):

```webidl
interface TrustedTypePolicy {
  TrustedHTMLParserOptions createHTMLParserOptions((SetHTMLOptions or SetHTMLUnsafeOptions) options = {});
}
```

By providing a method as such, the policy can:
- Modify a sanitizer, or inject one if it doesn't exist
- Change the `runScripts` option
- Bless the options as-is, e.g. to allow first-party scripts to inject unsafe and non-sanitized markup.

Passing a (non-fungible) `TrustedHTMLParserOptions` to one of the HTML setting/streaming methods would bypass the default policy,
and unlike `createHTML`, would also allow streaming.
If this method is provided in the default policy, it would transform any incoming options, after also going through the `createHTML` call.
(Alternatively, they can be mutually exclusive, using `createHTML` as graceful degradation).

See [discussion](https://github.com/w3c/trusted-types/issues/594).

## Node-creation side effects

Currently, `createContextualFragment` has a somewhat quirky side-effect of preloading images, even before the fragment is connected.
See https://github.com/whatwg/html/issues/12010.

This is intended to stay as a quirk specific to `createContextualFragment`, as no other API separates between the fragment creation and insertion.

## Special template behavior

Some new features such as declarative shadow DOM and out-of-order streaming allows template elements to be "active" and have a side effect when encountered.
This is another difference between APIs, as older APIs might rely on userspace sanitizers that don't know about the existence of these features.

Open issue: define how this should behave going forward.

## Resulting API

This results in the following API, which includes 24 methods:

```webidl
enum SanitizerPresets { "default" };
dictionary SetHTMLOptions {
  (Sanitizer or SanitizerConfig or SanitizerPresets) sanitizer = "default";
};
dictionary SetHTMLUnsafeOptions {
  (Sanitizer or SanitizerConfig or SanitizerPresets) sanitizer = {};
  boolean runScripts = false;
};

interface TrustedSetHTMLOptions {
  (Sanitizer or SanitizerConfig or SanitizerPresets) sanitizer;
}

interface TrustedSetHTMLUnsafeOptions {
  (Sanitizer or SanitizerConfig or SanitizerPresets) sanitizer;  
  boolean runScripts;
}

typedef (SetHTMLUnsafeOptions or TrustedSetHTMLUnsafeOptions) UnsafeHTMLSetterOptions;
typedef (SetHTMLOptions or TrustedSetHTMLOptions) SafeHTMLSetterOptions;

[Exposed=Window]
mixin interface ElementOrShadowRoot {
  void setHTML((DOMString or TrustedHTML) html, SafeHTMLSetterOptions options);
  void setHTMLUnsafe((DOMString or TrustedHTML) html, optional UnsafeHTMLSetterOptions options = {});
  void beforeHTML((DOMString or TrustedHTML) html, SafeHTMLSetterOptions options);
  void beforeHTMLUnsafe((DOMString or TrustedHTML) html, optional UnsafeHTMLSetterOptions options = {});
  void afterHTML((DOMString or TrustedHTML) html, SafeHTMLSetterOptions options);
  void afterHTMLUnsafe((DOMString or TrustedHTML) html, optional UnsafeHTMLSetterOptions options = {});
  void appendHTML((DOMString or TrustedHTML) html, SafeHTMLSetterOptions options);
  void appendHTMLUnsafe((DOMString or TrustedHTML) html, optional UnsafeHTMLSetterOptions options = {});
  void prependHTML((DOMString or TrustedHTML) html, SafeHTMLSetterOptions options);
  void prependHTMLUnsafe((DOMString or TrustedHTML) html, optional UnsafeHTMLSetterOptions options = {});
  void replaceWithHTML((DOMString or TrustedHTML) html, SafeHTMLSetterOptions options);
  void replaceWithHTMLUnsafe((DOMString or TrustedHTML) html, optional UnsafeHTMLSetterOptions options = {});
  WritableStream streamHTML(SafeHTMLSetterOptions options);
  WritableStream streamHTMLUnsafe(optional UnsafeHTMLSetterOptions options = {});
  WritableStream streamBeforeHTML(SafeHTMLSetterOptions options);
  WritableStream streamBeforeHTMLUnsafe(optional UnsafeHTMLSetterOptions options = {});
  WritableStream streamAfterHTML(SafeHTMLSetterOptions options);
  WritableStream streamAfterHTMLUnsafe(optional UnsafeHTMLSetterOptions options = {});
  WritableStream streamAppendHTML(SafeHTMLSetterOptions options);
  WritableStream streamAppendHTMLUnsafe(optional UnsafeHTMLSetterOptions options = {});
  WritableStream streamPrependHTML(SafeHTMLSetterOptions options);
  WritableStream streamPrependHTMLUnsafe(optional UnsafeHTMLSetterOptions options = {});
  WritableStream streamReplaceWithHTML(SafeHTMLSetterOptions options);
  WritableStream streamReplaceWithHTMLUnsafe(optional UnsafeHTMLSetterOptions options = {});
};
```

## Existing methods

Apart from the `createContextualFragment` quirk and special template behavior like declarative shadow roots,
all of the existing APIs can be expressed in terms of the above APIs,
implicitly being unsafe, having a false `runScripts` and no sanitizer:

```js
class Element {
  set innerHTML(html) {
     this.setHTMLUnsafe(html);
  }

  set outerHTML(html) {
     this.replaceWithHTMLUnsafe(html);
  }

  insertAdjacentHTML(html, insertion_point) {
    switch (insertion_point) {
      case "beforebegin":
         this.beforeHTMLUnsafe(html);
         break;
      case "afterbegin":
         this.prependHTMLUnsafe(html);
         break;
      case "beforeend":
         this.appendHTMLUnsafe(html);
         break;
      case "afterend":
         this.afterHTMLUnsafe(html);
         break;
    }
  }
};

```

## Security & Privacy Questionnaire

1. What information does this feature expose, and for what purposes?
It does not expose new information.

2. Do features in your specification expose the minimum amount of information necessary to implement the intended functionality?
N/A

3. Do the features in your specification expose personal information, personally-identifiable information (PII), or information derived from either?
No

4. How do the features in your specification deal with sensitive information?
N/A 

5. Does data exposed by your specification carry related but distinct information that may not be obvious to users?

No

6. Do the features in your specification introduce state that persists across browsing sessions?
No

7. Do the features in your specification expose information about the underlying platform to origins?
No

8. Does this specification allow an origin to send data to the underlying platform?
No

9. Do features in this specification enable access to device sensors?
No

10. Do features in this specification enable new script execution/loading mechanisms?
Yes, and this is handled specifically and deliberately by integrating with the sanitizer, trusted types, and the `runScripts` option.

11. Do features in this specification allow an origin to access other devices?
No.

12. Do features in this specification allow an origin some measure of control over a user agent's native UI?
No.

13. What temporary identifiers do the features in this specification create or expose to the web?
N/A

14. How does this specification distinguish between behavior in first-party and third-party contexts?
It integrates with trusted types. The 1st party can create separate trusted-types policies for 1st party and 3rd party contexts.

15. How do the features in this specification work in the context of a browser’s Private Browsing or Incognito mode?
N/A

16. Does this specification have both "Security Considerations" and "Privacy Considerations" sections?
It is intended to be part of the HTML standard, so yes.

117. Do features in your specification enable origins to downgrade default security protections?
No

18. What happens when a document that uses your feature is kept alive in BFCache (instead of getting destroyed) after navigation, and potentially gets reused on future navigations back to the document?
Nothing in particular.

19. What happens when a document that uses your feature gets disconnected?
Being connected/disconnected doesn't affect this feature atm.

20. Does your spec define when and how new kinds of errors should be raised?
It will.

21. Does your feature allow sites to learn about the user's use of assistive technology?
No

22. What should this questionnaire have asked?
Does this feature allow new ways of changing the DOM/injecting HTML.




