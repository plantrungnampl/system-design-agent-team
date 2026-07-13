import { parse } from "yaml";

export interface ParsedArtifact {
  metadata: Record<string, unknown>;
  body: string;
}

export interface ArtifactFinding {
  code: "INVALID_FRONT_MATTER" | "PROHIBITED_PLACEHOLDER" | "UNSUPPORTED_COMPLETION_CLAIM";
  message: string;
}

export interface ArtifactValidation {
  valid: boolean;
  findings: ArtifactFinding[];
}

const reviewReadyStatuses = new Set(["in_review", "approved", "approved_with_conditions"]);
const prohibitedPlaceholders = [
  ["Fake test evidence", /fake test evidence/i],
  ["Lorem ipsum", /lorem ipsum/i],
  ["Placeholder architecture", /^[ \t]*(?:(?:#{1,6}|[-*+]|\d+[.)])(?:[ \t]+\[[ x]\])?[ \t]+)?placeholder architecture[ \t]*$/im],
  ["Sample requirements", /^[ \t]*(?:(?:#{1,6}|[-*+]|\d+[.)])(?:[ \t]+\[[ x]\])?[ \t]+)?sample requirements?[ \t]*$/im],
  ["TBD", /^[ \t]*(?:(?:#{1,6}|[-*+]|\d+[.)])(?:[ \t]+\[[ x]\])?[ \t]+)?TBD(?:[ \t]*:[^\r\n]*)?[ \t]*$/im],
  ["TODO", /^[ \t]*(?:(?:#{1,6}|[-*+]|\d+[.)])(?:[ \t]+\[[ x]\])?[ \t]+)?TODO(?:[ \t]*:[^\r\n]*)?[ \t]*$/im],
  ["To be defined later", /^[ \t]*(?:(?:#{1,6}|[-*+]|\d+[.)])(?:[ \t]+\[[ x]\])?[ \t]+)?to be defined later(?:[ \t]*:[^\r\n]*)?[ \t]*$/im],
] as const;
const reservedEvidenceValues = new Set(["unknown", "none", "n/a", "na", "tbd", "todo"]);

function evidenceValue(line: string, label: string) {
  const match = new RegExp(`^${label}:\\s*(.+)$`, "i").exec(line);
  if (!match) return undefined;
  const value = match[1]!.trim();
  return value && !reservedEvidenceValues.has(value.toLowerCase()) ? value : undefined;
}

function isProjectRelativeFile(value: string) {
  if (value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) return false;
  const segments = value.split("/");
  return segments.length >= 2
    && segments.every((segment) => segment !== "." && segment !== ".." && /^[a-z0-9._-]+$/i.test(segment))
    && /^[a-z0-9_-]+\.[a-z0-9._-]+$/i.test(segments.at(-1)!);
}

function boundedFrontMatter(text: string): { yaml: string; body: string } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const closing = lines.indexOf("---", 1);
  if (closing < 0) return undefined;
  return {
    yaml: lines.slice(1, closing).join("\n"),
    body: lines.slice(closing + 1).join("\n"),
  };
}

export function parseArtifact(text: string): ParsedArtifact {
  const frontMatter = boundedFrontMatter(text);
  if (!frontMatter) return { metadata: {}, body: text };

  const value: unknown = parse(frontMatter.yaml);
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error("INVALID_FRONT_MATTER");
  }
  return { metadata: (value ?? {}) as Record<string, unknown>, body: frontMatter.body };
}

export function validateReviewReadyArtifact(text: string): ArtifactValidation {
  let artifact: ParsedArtifact;
  try {
    artifact = parseArtifact(text);
  } catch {
    return {
      valid: false,
      findings: [{ code: "INVALID_FRONT_MATTER", message: "Artifact front matter is invalid YAML" }],
    };
  }

  if (!reviewReadyStatuses.has(String(artifact.metadata.status ?? ""))) {
    return { valid: true, findings: [] };
  }

  const findings: ArtifactFinding[] = prohibitedPlaceholders
    .filter(([, pattern]) => pattern.test(artifact.body))
    .map(([name]) => ({
      code: "PROHIBITED_PLACEHOLDER",
      message: `Prohibited placeholder: ${name}`,
    }));
  const substantive = artifact.body.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s+/.test(line));
  const claimOnly = /^(?:everything|all (?:requirements|tests|checks|security checks)) (?:(?:has|have) )?(?:passed|(?:was|were) successful)[.!]?$/i;
  const hasCommand = substantive.some((line) => evidenceValue(line, "command") !== undefined);
  const hasSuccessfulExit = substantive.some((line) => /^exit code:\s*0$/i.test(line));
  const hasReceipt = substantive.some((line) =>
    /^RECEIPT-(?:[A-Z0-9]+-)+[A-Z0-9]+$/i.test(evidenceValue(line, "receipt") ?? ""));
  const hasProjectFile = substantive.some((line) => {
    const value = evidenceValue(line, "(?:artifact|path)");
    return value !== undefined && isProjectRelativeFile(value);
  });
  const hasDigest = substantive.some((line) =>
    /^(?:digest|checksum):\s*sha256:[a-f0-9]{64}$/i.test(line));
  const hasEvidence = (hasCommand && hasSuccessfulExit) || hasReceipt || hasProjectFile || hasDigest;
  if (substantive.some((line) => claimOnly.test(line)) && !hasEvidence) {
    findings.push({
      code: "UNSUPPORTED_COMPLETION_CLAIM",
      message: "Completion claims require concrete, reproducible evidence",
    });
  }
  findings.sort((left, right) => left.message.localeCompare(right.message));
  return { valid: findings.length === 0, findings };
}
