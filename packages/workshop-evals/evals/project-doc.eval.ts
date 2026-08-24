import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

const DocumentSchema = z.object({
  revision: z.number().int().nonnegative(),
  title: z.string(),
  // Null means the document was created but never written to, which is distinct from empty.
  blocks: z.array(z.object({
    id: z.string(),
    html: z.string(),
    version: z.number().int().nonnegative(),
  }).loose()).nullable(),
}).loose();

type Document = z.infer<typeof DocumentSchema>;

interface DocsApi {
  getDocument(): Promise<Document>;
  setDocument(input: {
    blocks: { id: string; html: string; baseVersion?: number }[];
    title: string;
    senderId: string;
  }): Promise<Document>;
}

const TITLE = "Harbour Refit";

function text(document: Document): string {
  return (document.blocks ?? []).map(block => block.html).join("\n").toLowerCase();
}

/**
 * Docs are a standard platform output. The system prompt advertises the shipped blueprint, and a
 * real Doc appears on the outputs page and supports the collaborative Docs RPC. A custom notes
 * Gadget lacks both properties.
 *
 * No current-main baseline shows this task passing every check, so it remains frontier. Promote it
 * only after a repeated baseline establishes that result.
 */
const task = defineEvalTask({
  id: "project-doc",
  expectation: "frontier",
  turns: [{
    prompt: `I'm kicking off a project called Harbour Refit. Set me up a doc named exactly
"${TITLE}" for my running notes on it.

Start it off with a heading for the project and three bullet points, one each for scope, budget and
timeline. Put a sentence of placeholder detail under each — I'll replace them as things firm up.`,
    verify: async verifier => {
      await verifier.check("is-presented-as-a-document-output", async () => {
        const doc = verifier.workpieces.find(workpiece => workpiece.title === TITLE);
        return {
          pass: doc?.output?.id === "document",
          evidence: verifier.workpieces.map(workpiece =>
            ({ title: workpiece.title, output: workpiece.output ?? null })),
        };
      });

      await verifier.check("answers-the-docs-contract-with-real-content", async () => {
        using api = await verifier.connect<DocsApi>(TITLE);
        const document = DocumentSchema.parse(await api.getDocument());
        const body = text(document);
        return {
          pass: document.revision >= 1 && document.blocks !== null &&
            document.blocks.length >= 4 &&
            document.title.toLowerCase().includes("harbour") &&
            ["scope", "budget", "timeline"].every(word => body.includes(word)),
          evidence: {
            revision: document.revision,
            title: document.title,
            blockCount: document.blocks?.length ?? null,
            blocks: (document.blocks ?? []).slice(0, 8).map(block => block.html.slice(0, 120)),
          },
        };
      });

      await verifier.check("accepts-a-full-document-rewrite", async () => {
        using api = await verifier.connect<DocsApi>(TITLE);
        const before = DocumentSchema.parse(await api.getDocument());
        const written = DocumentSchema.parse(await api.setDocument({
          title: "Harbour Refit — revised",
          senderId: "eval",
          blocks: [
            { id: "h", html: "<h1>Harbour Refit</h1>" },
            { id: "b1", html: "<p>Scope: replace the decking.</p>" },
          ],
        }));
        const reread = DocumentSchema.parse(await api.getDocument());
        return {
          pass: written.revision > before.revision &&
            written.title === "Harbour Refit — revised" &&
            reread.revision === written.revision &&
            (reread.blocks ?? []).map(block => block.id).join() === "h,b1" &&
            (reread.blocks ?? []).every(block => block.version >= 1),
          evidence: { beforeRevision: before.revision, written, reread },
        };
      });
    },
  }],
});

defineTaskEval(task);
