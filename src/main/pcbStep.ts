import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

function isSha256(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]+$/i.test(value);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Verify the two explicitly selected files against the export record next to the STEP. */
export async function verifyPcbStepBinding(pcb: string, step: string): Promise<{ pcbMatches: boolean; stepMatches: boolean }> {
  if (!/\.kicad_pcb$/i.test(pcb) || !/\.st(?:e)?p$/i.test(step)) {
    throw new Error("Select a native .kicad_pcb and a STEP file.");
  }
  const record = JSON.parse(await readFile(`${step}.binding.json`, "utf8"));
  if (record?.format !== "pcb-step-binding/1" || !isSha256(record.pcb_source_sha256) || !isSha256(record.pcb_step_sha256)) {
    throw new Error("Invalid PCB–STEP export record.");
  }
  const [pcbHash, stepHash] = await Promise.all([sha256(pcb), sha256(step)]);
  return { pcbMatches: record.pcb_source_sha256.toLowerCase() === pcbHash, stepMatches: record.pcb_step_sha256.toLowerCase() === stepHash };
}
