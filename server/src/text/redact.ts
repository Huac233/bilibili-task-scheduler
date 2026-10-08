/**
 * Credential redaction: the one place a credential value is taken out of a
 * sentence before that sentence is logged, stored, or shown to a person.
 *
 * One home, because the copies had already disagreed. The same two ideas were
 * written five times — `withoutSecret` in `platform/bilibili/index.ts`,
 * `withoutSecrets` in `platform/douyu/index.ts` and again in
 * `platform/douyu/passport.ts`, `redact` in `bilibili/medal.ts`, and the
 * parameter-name pattern in `platform/douyu/errors.ts`. Each one was defensible
 * alone; together they meant a credential could be scrubbed from the URL on one
 * line and handed on untouched in the sentence built from the same exchange on
 * the next. Which values count as credentials is one fact, so it is stated once.
 *
 * Two rules, because they answer two different questions:
 *
 *   - `redactSecrets` knows the values. It is the stronger rule — it works even
 *     when the sentence says nothing about where the value came from — and it is
 *     the one to use whenever the caller holds the credential it just sent.
 *   - `redactCredentialParameters` does not. Use it on a string that may be a URL
 *     or a form body, where the only thing identifying a credential is the name of
 *     the parameter carrying it: the QR-login key and a one-time cross-domain
 *     ticket exist for a single exchange and are never in any jar.
 *
 * Beside them sits `credentialValuesOf`, and it is **not a third rule**: it decides no value by
 * itself and is meaningless without `redactSecrets`. It lives here because it is that rule's *input*,
 * and because the one-character contract below is a property of the list it produces — which is the
 * whole reason three modules had one private copy of the split and one copy each of that contract.
 */

/** What a removed credential is replaced with. Fixed, so a reader of an error can grep it. */
export const REDACTED = '<redacted>'

/**
 * `name=` for every parameter this project carries a credential in.
 *
 * The leading `\b` is load-bearing, not decoration: it is what keeps `csrf` from
 * matching `csrfToken=`, which is a different parameter that genuinely appears in
 * a `doSign` body and whose value is not a credential. The trailing `=` closes the
 * other side, so neither `csrfToken=` nor `_token=` matches a shorter name inside
 * it. The value stops at `&`, whitespace, a quote or `;` so that a URL, a form body
 * and a `Cookie:` header are all still readable around the hole.
 *
 * The name list is the union across Platforms rather than one Platform's subset:
 * `dy_token`/`jwt_token` for Douyu's composite token, `csrf`/`csrf_token` and
 * `ticket` for Bilibili's write endpoints and cross-domain login, `qrcode_key` for
 * the QR poll, `SESSDATA`/`bili_jct` for the session and CSRF cookies — plus the
 * three cookies Douyu carries an account credential *in* rather than *as* a
 * parameter: `dy_cookie` (`apiV2Headers`' own header, byte for byte) and the web
 * session's `acf_auth` and `acf_jwt_token`.
 *
 * Those last two are named rather than reached, and the boundary is the reason:
 * `acf_` ends in a word character, so no `\b`-anchored alternative can begin inside
 * `acf_auth`, while the looser anchor that would reach them re-admits `token=`
 * *inside* `csrfToken=` and `_token=` — both of which `tests/text-redact.test.ts`
 * pins as readable. An over-broad rule has already been rejected here once, for that
 * same over-reach (`errors.ts` keeps the `[?&]?` separator as the counter-example).
 * A name *known* to carry a credential can be listed; a shape that swallows its
 * neighbours cannot. `dy_cookie` was not in that class at all — it was simply
 * absent, and that is what leaked: the one gate that redacts a *business refusal's*
 * prose holds this rule and no values (`platform/douyu/protocol.ts`'s `settle`), so
 * a service echoing the request back has nothing else standing between its own
 * sentence and a credential.
 *
 * `cvl_csrf_token` is the third name of that class, and it is **in** the list. It was
 * argued out of it here on a premise this repo's own code contradicts: that the name
 * belongs to the `carnivalApi/*` family, "which this build never calls". This build
 * does call `carnivalApi/*` — `signActivity` posts `/japi/carnivalApi/sign/doSign`
 * and `readActivitySignStatus` reads `/japi/carnivalApi/nc/sign/getStatus` — so that
 * sentence was a claim about the call graph written in the voice of a measurement,
 * which is the failure this file is here to prevent.
 *
 * What survives of it is narrower, and it is about the **value** rather than about the
 * name. The one endpoint this build does not call is the one that mints it, an empty-body
 * `POST /japi/carnival/nc/common/generateCsrf` (one segment `carnival` where the family
 * spells `carnivalApi`), and the shape `signActivity` is measured to send is the one that
 * needs no such value: `csrfToken` **empty** and no cookie at all, both pinned in
 * `tests/douyu-wire.test.ts`. So "this build mints no `cvl_csrf_token`" is true of today's
 * call graph, and that is the whole of what the measurements carry. The old sentence drew
 * one conclusion further — that *no sentence here can carry its value* — and that needed a
 * premise nobody measured: that a sentence can only carry a value this build minted. It
 * cannot be assumed here, because several callers forward a stored `webCookies` blob as a
 * `Cookie:` header (`signFansHome`, `readFanBadges`) and nothing in this module reads which
 * names that blob carries. That is the `dy_cookie` lesson above applied one step earlier:
 * what has to catch a credential is the **name**, because the site doing the redacting may
 * be the one that holds no values.
 *
 * The call graph is not what decides this list, anyway. The anchor decides it, and it does
 * not move when a caller is added: the character before `csrf_token` in `cvl_csrf_token` is
 * `_`, a word character, so no `\b`-anchored alternative can begin inside the name — exactly
 * as for `acf_auth` and `acf_jwt_token` above. So this entry is **needed now** rather than
 * "not needed yet": a name the anchor provably cannot see has to be listed in full whoever
 * calls what, and it would still have to be listed if that mint were implemented tomorrow
 * and called hourly. `protocol.ts` says the neighbouring thing from the other side: a reader
 * who reaches for that cookie has the wrong one, not a missing one.
 *
 * The pair that keeps this rule narrow is pinned in `tests/text-redact.test.ts`:
 * `csrfToken=${token}` stays readable while `cvl_csrf_token=<value>` is masked, in one
 * string, because the two names arrive side by side in one exchange and a rule loose enough
 * to catch the cookie from a `\b` would redact the form field with it.
 *
 * Coverage, stated because a redactor may not widen in silence: this adds exactly one
 * name, `cvl_csrf_token`, to the parameter rule. The value rule (`redactSecrets`)
 * covers exactly what it covered before.
 *
 * It matches the `name=value` shape only, which is what a query string, a urlencoded
 * body and a `Cookie:` header use. It deliberately does **not** match the JSON shape
 * (`{"token":"…"}` separates with a colon) or the multipart shape (the name is a
 * quoted part header and the value is on a later line). Those two are the *value*
 * rule's job, at the call site that knows the value it just sent — `sendDanmaku`
 * sends its CSRF token in a multipart body, and redacting it there is the only rule
 * that can.
 */
const CREDENTIAL_PARAMETERS =
  /\b(dy_token|dy_cookie|acf_auth|acf_jwt_token|cvl_csrf_token|jwt_token|token|csrf|csrf_token|refresh_token|qrcode_key|ticket|SESSDATA|bili_jct)=[^&\s"';]*/gi

/**
 * Removes each secret *value* from `text`.
 *
 * An empty value is skipped rather than replaced, and that guard is not cosmetic:
 * `replaceAll('', …)` splices the marker between every character and destroys the
 * sentence it was meant to protect.
 *
 * A caller must not add a **one-character** value to the list — `replaceAll('0', …)`
 * shreds a sentence just as thoroughly. The composite token's `ct` is exactly one
 * character, which is why it is deliberately absent from every list in this repo.
 */
export function redactSecrets(text: string, secrets: string | readonly string[]): string {
  const list = typeof secrets === 'string' ? [secrets] : secrets
  let safe = text
  for (const secret of list) {
    if (secret === '') continue
    safe = safe.replaceAll(secret, REDACTED)
  }
  return safe
}

/**
 * The credential values one call sent, ready to hand to `redactSecrets`.
 *
 * Every reader that scrubs a sentence about a call holds the same pair — the composite token it sent
 * and the jar it sent as a `Cookie:` header — and three modules had written both halves out for
 * themselves (`routes/douyu-backpack.ts`, `routes/douyu-options.ts`, `platform/douyu/options.ts`),
 * each followed by the same filter. **The filter is the contract above rather than a preference**, so
 * it is applied where the list is built instead of once per caller: a one-character value must never
 * reach the rule, and a fourth reader that forgot to filter would shred the sentence it was protecting
 * without anything going red.
 *
 * **A part with no `=` is taken whole**, which is harmless and the safe direction: it is a token in
 * the same sentence, and redacting it cannot hide anything a reader needs.
 *
 * It is deliberately *not* the name-shaped rule's job: `redactCredentialParameters` exists for
 * sentences whose caller holds no values at all, and this function is the opposite case — the caller
 * sent exactly these.
 *
 * **Coverage is what the three copies had, to the value**: the token, then each jar value, minus the
 * ones too short to redact. Nothing new is covered here and nothing that was covered is dropped.
 */
export function credentialValuesOf(token: string, webCookies: string): readonly string[] {
  const fromJar = webCookies === '' ? [] : webCookies.split(';').map(part => part.slice(part.indexOf('=') + 1).trim())
  return [token, ...fromJar].filter(value => value.length > 1)
}

/** Removes the value of every credential-bearing parameter, whatever that value is. */
export function redactCredentialParameters(text: string): string {
  return text.replaceAll(CREDENTIAL_PARAMETERS, `$1=${REDACTED}`)
}
