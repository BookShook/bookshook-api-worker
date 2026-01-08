import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

import {
  TagsResponseSchema,
  BooksListResponseSchema,
  BookDetailResponseSchema,
  CollectionsListResponseSchema,
  CollectionDetailResponseSchema,
} from "../src/contracts/responses";

type Mode = "write" | "check";

function stableStringify(value: unknown): string {
  // Pretty + stable enough for our use (no timestamps, no random keys).
  // Zod v4 toJSONSchema output is deterministic for a fixed version.
  return JSON.stringify(value, null, 2) + "\n";
}

function readFileIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const mode: Mode = args.has("--check") ? "check" : "write";

  const outPath = path.resolve(process.cwd(), "contracts", "public.schema.json");

  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "BookShook Public API Contracts",
    type: "object",
    properties: {
      TagsResponse: z.toJSONSchema(TagsResponseSchema),
      BooksListResponse: z.toJSONSchema(BooksListResponseSchema),
      BookDetailResponse: z.toJSONSchema(BookDetailResponseSchema),
      CollectionsListResponse: z.toJSONSchema(CollectionsListResponseSchema),
      CollectionDetailResponse: z.toJSONSchema(CollectionDetailResponseSchema),
    },
    additionalProperties: false,
  } as const;

  const next = stableStringify(schema);
  const prev = readFileIfExists(outPath);

  if (mode === "check") {
    if (prev === null) {
      console.error(`Missing ${outPath}. Run: npx tsx scripts/generate-contracts.ts`);
      process.exit(1);
    }
    if (prev !== next) {
      console.error("Contract schema is out of date.");
      console.error("Run: npx tsx scripts/generate-contracts.ts");
      process.exit(1);
    }
    console.log("✅ Contract schema up to date.");
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, next, "utf8");
  console.log(`✅ Wrote ${outPath}`);
}

main();
