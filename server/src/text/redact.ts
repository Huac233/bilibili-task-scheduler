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
 * `cvl_csrf_token` is deliberately absent, and that omission is a measurement rather
 * than an oversight: the name belongs to `generateCsrf`'s `carnivalApi/*` family,
 * which this build never calls — `signActivity` sends `csrfToken: ''` and no cookie
 * at all — so no sentence here can carry its value. `protocol.ts` records the same
 * fact where it says a reader who reaches for that cookie has the wrong one, not a
 * missing one.
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
  /\b(dy_token|dy_cookie|acf_auth|acf_jwt_token|jwt_token|token|csrf|csrf_token|refresh_token|qrcode_key|ticket|SESSDATA|bili_jct)=[^&\s"';]*/gi

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

/** Removes the value of every credential-bearing parameter, whatever that value is. */
export function redactCredentialParameters(text: string): string {
  return text.replaceAll(CREDENTIAL_PARAMETERS, `$1=${REDACTED}`)
}
