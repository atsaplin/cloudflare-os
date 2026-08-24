import type { RpcCompatible, RpcStub } from "capnweb";
import type { AgentSession } from "@gadgets/integration-tests/agent-session";
import type { WorkpieceId, WorkpieceSummary } from "@gadgets/workshop-shared/api";
import { toJsonValue } from "vitest-evals";
import type { EvalCheck, EvalCheckOutcome } from "./task.js";

const EVIDENCE_LIMIT = 2_000;

/** Recorded when a check's `id` was never reached because the verifier body itself threw. */
const VERIFIER_THREW = "verifier.threw";

// `toJsonValue` answers undefined for anything it cannot represent, which would otherwise be
// indistinguishable from an author who supplied no evidence at all.
const UNSERIALIZABLE_EVIDENCE = "<evidence was not JSON-serializable>";

function truncateError(message: string): string {
  return message.length > EVIDENCE_LIMIT ? `${message.slice(0, EVIDENCE_LIMIT)}...` : message;
}

/** The session capabilities a verifier needs, which is far less than a whole agent session. */
export type VerifierSession = Pick<AgentSession, "connectToGadget">;

// Declared signature plus an untyped implementation, matching `connectTyped` in agent-session.ts:
// capnweb's recursive `RpcStub` generic does not survive being forwarded through another generic.
function connectTyped<Session extends RpcCompatible<Session>>(
    session: VerifierSession, id: WorkpieceId): Promise<RpcStub<Session>>;
function connectTyped(session: VerifierSession, id: WorkpieceId) {
  return session.connectToGadget(id);
}

/**
 * Task prompts require an exact Gadget title. A mismatch error includes the titles the agent
 * created, which makes naming failures diagnosable from the report.
 */
export function resolveGadget(
    workpieces: readonly WorkpieceSummary[], title: string): WorkpieceId {
  const matches = workpieces.filter(
      workpiece => workpiece.type === "gadget" && workpiece.title === title);
  const match = matches.at(0);
  if (matches.length !== 1 || match === undefined) {
    const built = workpieces.map(workpiece => JSON.stringify(workpiece.title)).join(", ");
    throw new Error(`Expected exactly one Gadget titled ${JSON.stringify(title)}, ` +
      `found ${matches.length} among [${built}]`);
  }
  return match.id;
}

/**
 * Verifies the agent's provisional branch before a user accepts it. Checks retain registration
 * order, and one failed observation does not hide later evidence from the same trial.
 */
export class EvalVerifier {
  /** Workpieces visible after the turn settled. */
  readonly workpieces: readonly WorkpieceSummary[];
  readonly #session: VerifierSession;
  readonly #checks: EvalCheck[] = [];
  readonly #pending: Promise<void>[] = [];

  constructor(session: VerifierSession, workpieces: readonly WorkpieceSummary[]) {
    this.#session = session;
    this.workpieces = workpieces;
  }

  /**
   * Isolates RPC and schema failures to one observation. An expensive trial still reports every
   * independent check it can run.
   */
  async check(id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    if (this.#checks.some(check => check.id === id)) {
      throw new Error(`Duplicate eval check ID ${JSON.stringify(id)} within one turn`);
    }
    const index = this.#checks.length;
    this.#checks.push({ id, pass: false, evidence: "check did not complete" });
    const settled = this.#run(index, id, body);
    this.#pending.push(settled);
    await settled;
  }

  async #run(index: number, id: string, body: () => Promise<EvalCheckOutcome>): Promise<void> {
    try {
      const outcome = await body();
      const evidence = outcome.evidence === undefined
        ? undefined
        : toJsonValue(outcome.evidence) ?? UNSERIALIZABLE_EVIDENCE;
      const check: EvalCheck = { id, pass: outcome.pass };
      if (evidence !== undefined) check.evidence = evidence;
      this.#checks[index] = check;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#checks[index] = { id, pass: false, evidence: truncateError(message) };
    }
  }

  /**
   * Connects a typed stub to the provisional server of the Gadget with this exact title. The caller
   * owns the stub, so bind it with `using`. Throws when no Gadget matches, or when several do.
   */
  connect<Session extends RpcCompatible<Session>>(gadgetTitle: string): Promise<RpcStub<Session>> {
    return connectTyped<Session>(this.#session, resolveGadget(this.workpieces, gadgetTitle));
  }


  /**
   * Preserves checks recorded before an error escapes the verifier body. The escaped error becomes
   * a final failed check instead of erasing the trial's earlier evidence.
   */
  async collect(verify: (verifier: EvalVerifier) => Promise<void>): Promise<EvalCheck[]> {
    try {
      await verify(this);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#checks.push({ id: VERIFIER_THREW, pass: false, evidence: truncateError(message) });
    }
    await Promise.all(this.#pending);
    return this.#checks;
  }
}
