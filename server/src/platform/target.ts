/**
 * Why a pasted target was refused, in the three terms a person's next move differs in.
 *
 * `Platform.resolveTarget` has no failure variant — the seam's types put every refusal in an exception
 * — and the route above it renders whatever sentence comes back **next to the box the person typed
 * into**. So the two things that matter are which of these three states the refusal is, and that its
 * `message` is already a sentence for that person.
 *
 * The three, and why they are worth three names rather than one "it failed":
 *
 *  - **`unreadable_input`** — the paste is not a shape this Platform reads a target out of. The person
 *    fixes it by typing differently, and the sentence should say what it is they pasted rather than
 *    repeating one generic line for every reason.
 *  - **`missing_room`** — the shape is right and the thing it names does not exist. Also the person's to
 *    fix, and a *different* sentence: 「this is not a link I understand」 and 「that room is not there」
 *    are two facts, and a person who is shown one of them for the other goes looking in the wrong place.
 *  - **`platform_unanswered`** — the Platform was asked and answered something this build cannot read as
 *    a room. Nothing about the paste is established, so the same paste may well work in a minute.
 *
 * **Grading belongs to the adapter, not to this module.** Which of the three a failure is, is a fact
 * about one Platform's endpoint and its own codes — `60004` means 「no such room」 on Bilibili's
 * `room_init` and nothing anywhere else — so each adapter decides and this class only carries the
 * verdict. Nothing here is thrown by the transport: a Platform's network fault keeps its own error
 * class, which is the coupling the seam exists to keep out of `routes/**`.
 */
export const TargetRefusalKind = {
  /** The paste is not a target shape this Platform understands. */
  UnreadableInput: 'unreadable_input',
  /** The shape is right and the Platform has no such target. */
  MissingRoom: 'missing_room',
  /** The Platform answered something this build cannot read as a target. */
  PlatformUnanswered: 'platform_unanswered'
} as const

export type TargetRefusalKind = (typeof TargetRefusalKind)[keyof typeof TargetRefusalKind]

/**
 * One refusal of a pasted target, with the sentence a person reads.
 *
 * `message` is the whole payload and it is **shown verbatim beside the input**, so it may name neither an
 * internal call of ours (`room_init failed for …` is what it replaces) nor a Platform identifier the
 * person did not type themselves. The number they typed is the one exception, and it belongs there: it is
 * how they check what they pasted.
 */
export class TargetRefusal extends Error {
  readonly kind: TargetRefusalKind

  constructor(kind: TargetRefusalKind, message: string) {
    super(message)
    this.name = 'TargetRefusal'
    this.kind = kind
  }
}
