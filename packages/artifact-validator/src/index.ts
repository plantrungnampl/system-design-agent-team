import { parse } from "yaml";

export interface ParsedArtifact {
  metadata: Record<string, unknown>;
  body: string;
}

export interface ArtifactFinding {
  code: "INVALID_FRONT_MATTER" | "PROHIBITED_PLACEHOLDER";
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
  ["Placeholder architecture", /^[ \t]*(?:[-*+][ \t]+)?placeholder architecture[ \t]*$/im],
  ["Sample requirements", /^[ \t]*(?:[-*+][ \t]+)?sample requirements?[ \t]*$/im],
  ["TBD", /^[ \t]*(?:[-*+][ \t]+)?TBD(?:[ \t]*:[^\r\n]*)?[ \t]*$/im],
  ["TODO", /^[ \t]*(?:[-*+][ \t]+)?TODO(?:[ \t]*:[^\r\n]*)?[ \t]*$/im],
  ["To be defined later", /^[ \t]*(?:[-*+][ \t]+)?to be defined later(?:[ \t]*:[^\r\n]*)?[ \t]*$/im],
] as const;

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
  findings.sort((left, right) => left.message.localeCompare(right.message));
  return { valid: findings.length === 0, findings };
}
