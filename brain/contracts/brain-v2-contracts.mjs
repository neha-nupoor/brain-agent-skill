import * as z from "zod/v4";

export const BRAIN_V2_CONTRACT_VERSION = "brain-v2";
export const KNOWLEDGE_TYPES = Object.freeze([
  "fact", "decision", "preference", "relationship", "context",
]);
export const RECONCILIATION_ACTIONS = Object.freeze([
  "capture", "confirm", "supersede", "archive", "ignore", "ask",
]);
export const RETENTION_CLASSES = Object.freeze([
  "pinned", "durable", "situational", "ephemeral",
]);
export const FRESHNESS_STATES = Object.freeze(["fresh", "stale", "degraded"]);
export const GOAL_STATUS = "NOT_IMPLEMENTED";

const nonEmpty = z.string().trim().min(1);
const isoDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO-8601 date")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a real calendar date");
const isoDateTime = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value)),
  "must be an ISO-8601 date-time with timezone",
);
const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, "must be a full Git commit SHA");

export const KnowledgeTypeSchema = z.enum(KNOWLEDGE_TYPES);
export const ReconciliationActionSchema = z.enum(RECONCILIATION_ACTIONS);
export const RetentionClassSchema = z.enum(RETENTION_CLASSES);
export const FreshnessStateSchema = z.enum(FRESHNESS_STATES);

function validateFreshnessTimes(value, context) {
  if (Date.parse(value.sourceAsOf) > Date.parse(value.generatedAt)) {
    context.addIssue({ code: "custom", path: ["sourceAsOf"], message: "cannot be after generatedAt" });
  }
  if (Date.parse(value.lastSuccessfulSync) > Date.parse(value.generatedAt)) {
    context.addIssue({
      code: "custom", path: ["lastSuccessfulSync"], message: "cannot be after generatedAt",
    });
  }
}

export const FreshnessSchema = z.object({
  generatedAt: isoDateTime,
  sourceAsOf: isoDateTime,
  commitSha,
  lastSuccessfulSync: isoDateTime,
  freshness: FreshnessStateSchema,
}).strict().superRefine(validateFreshnessTimes);

export const RetentionSchema = z.object({
  class: RetentionClassSchema,
  reviewAfter: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
  refreshOnConfirmation: z.boolean(),
  reason: nonEmpty,
}).strict().superRefine((value, context) => {
  if (["pinned", "durable"].includes(value.class) && value.expiresAt !== null) {
    context.addIssue({
      code: "custom", path: ["expiresAt"], message: `${value.class} knowledge cannot expire automatically`,
    });
  }
  if (value.class === "situational" && value.reviewAfter === null) {
    context.addIssue({ code: "custom", path: ["reviewAfter"], message: "situational knowledge requires reviewAfter" });
  }
  if (value.class === "ephemeral" && value.expiresAt === null) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "ephemeral knowledge requires expiresAt" });
  }
});

export const GitProvenanceSchema = z.object({
  sourceProvider: z.literal("git"),
  sourceRef: nonEmpty,
  repository: nonEmpty,
  path: nonEmpty,
  commitSha,
  schemaVersion: nonEmpty,
  period: nonEmpty,
  generatedAt: isoDateTime,
  sourceAsOf: isoDateTime,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.sourceAsOf) > Date.parse(value.generatedAt)) {
    context.addIssue({ code: "custom", path: ["sourceAsOf"], message: "cannot be after generatedAt" });
  }
});

export const BrainRecordSchema = z.object({
  memoryKey: nonEmpty,
  version: nonEmpty,
  title: nonEmpty.nullable(),
  content: nonEmpty,
  brainKind: z.enum(["knowledge", "task", "playground"]),
  lifecycle: z.enum([
    "active", "archived",
    "pending", "in_progress", "waiting", "parked", "completed", "cancelled",
    "open", "promoted", "closed",
  ]),
  knowledgeType: KnowledgeTypeSchema.nullable(),
  retention: RetentionSchema,
  provenance: GitProvenanceSchema,
  updatedAt: isoDateTime,
}).strict().superRefine((value, context) => {
  const states = {
    knowledge: ["active", "archived"],
    task: ["pending", "in_progress", "waiting", "parked", "completed", "cancelled"],
    playground: ["open", "parked", "promoted", "closed"],
  };
  if (!states[value.brainKind].includes(value.lifecycle)) {
    context.addIssue({
      code: "custom", path: ["lifecycle"], message: `is not valid for ${value.brainKind}`,
    });
  }
  if (value.brainKind === "knowledge" && value.knowledgeType === null) {
    context.addIssue({ code: "custom", path: ["knowledgeType"], message: "is required for knowledge" });
  }
  if (value.brainKind !== "knowledge" && value.knowledgeType !== null) {
    context.addIssue({
      code: "custom", path: ["knowledgeType"], message: "must be null for Task Queue and Playground",
    });
  }
});

export const KnowledgeRecordSchema = BrainRecordSchema.refine(
  (value) => value.brainKind === "knowledge",
  { path: ["brainKind"], message: "must be knowledge" },
);

export const HotBrainSchema = z.object({
  schemaVersion: z.literal("hot-brain-v2"),
  selectedAt: isoDateTime,
  items: z.array(BrainRecordSchema).max(50),
}).strict();

export const ReconciliationRecordSchema = z.object({
  reconciliationId: nonEmpty,
  memoryKey: nonEmpty.nullable(),
  action: ReconciliationActionSchema,
  reason: nonEmpty,
  detectedAt: isoDateTime,
  question: nonEmpty.nullable(),
}).strict().superRefine((value, context) => {
  if (value.action === "ask" && value.question === null) {
    context.addIssue({ code: "custom", path: ["question"], message: "ask requires a question" });
  }
  if (value.action !== "ask" && value.question !== null) {
    context.addIssue({ code: "custom", path: ["question"], message: "question is only valid for ask" });
  }
});

export const ForgettingDecisionSchema = z.object({
  memoryKey: nonEmpty,
  retentionClass: RetentionClassSchema,
  action: z.enum(["keep", "review", "expire", "archive"]),
  reason: nonEmpty,
  reviewAfter: isoDateTime.nullable(),
  expiresAt: isoDateTime.nullable(),
}).strict().superRefine((value, context) => {
  if (value.retentionClass === "pinned" && value.action !== "keep") {
    context.addIssue({ code: "custom", path: ["action"], message: "pinned knowledge must be kept" });
  }
  if (value.action === "expire" && value.expiresAt === null) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "expire requires expiresAt" });
  }
  if (value.action === "review" && value.reviewAfter === null) {
    context.addIssue({ code: "custom", path: ["reviewAfter"], message: "review requires reviewAfter" });
  }
});

export const ForgettingPlanSchema = z.object({
  schemaVersion: z.literal("forgetting-v1"),
  evaluatedAt: isoDateTime,
  decisions: z.array(ForgettingDecisionSchema),
}).strict();

export const GoalCapabilitySchema = z.object({
  status: z.literal(GOAL_STATUS),
  reason: z.literal("Goal is reserved for a future contract version."),
}).strict();

export const JournalReferenceSchema = z.object({
  schemaVersion: z.enum(["daily-v1", "weekly-v1"]),
  period: nonEmpty,
  path: nonEmpty,
}).strict();

export const BrainResponseMetadataSchema = z.object({
  truncated: z.boolean(),
  truncationReason: z.enum(["max-hot-items", "token-budget", "result-limit"]).nullable(),
  omittedCount: z.number().int().min(0),
  pendingMaterialization: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.truncationReason !== null)) {
    context.addIssue({
      code: "custom", path: ["truncationReason"],
      message: "must be present exactly when truncated is true",
    });
  }
  if (!value.truncated && value.omittedCount !== 0) {
    context.addIssue({ code: "custom", path: ["omittedCount"], message: "must be zero when not truncated" });
  }
  if (value.truncated && value.omittedCount === 0) {
    context.addIssue({ code: "custom", path: ["omittedCount"], message: "must be positive when truncated" });
  }
});

export const BrainBootstrapRequestSchema = z.object({
  schemaVersion: z.literal("brain.bootstrap.request.v2"),
  asOf: isoDateTime,
  includeJournal: z.boolean(),
  includeReconciliation: z.boolean(),
  includeForgetting: z.boolean(),
  maxHotItems: z.number().int().min(1).max(50),
}).strict();

export const BrainBootstrapResponseSchema = z.object({
  schemaVersion: z.literal("brain.bootstrap.response.v2"),
  contractVersion: z.literal(BRAIN_V2_CONTRACT_VERSION),
  hotBrain: HotBrainSchema,
  journal: z.array(JournalReferenceSchema),
  reconciliation: z.array(ReconciliationRecordSchema),
  forgetting: ForgettingPlanSchema,
  source: FreshnessSchema,
  metadata: BrainResponseMetadataSchema,
  capabilities: z.object({ goal: GoalCapabilitySchema }).strict(),
}).strict();

export const BrainSearchRequestSchema = z.object({
  schemaVersion: z.literal("brain.search.request.v2"),
  query: nonEmpty,
  asOf: isoDateTime,
  knowledgeTypes: z.array(KnowledgeTypeSchema).min(1).optional(),
  brainKinds: z.array(z.enum(["knowledge", "task", "playground"])).min(1).optional(),
  retentionClasses: z.array(RetentionClassSchema).min(1).optional(),
  limit: z.number().int().min(1).max(100),
  cursor: nonEmpty.nullable(),
}).strict();

export const BrainSearchResultSchema = z.object({
  record: BrainRecordSchema,
  score: z.number().min(0).max(1),
  matchedOn: z.array(z.enum(["content", "title", "knowledgeType", "provenance"])).min(1),
}).strict();

const searchTraceStep = (stage, sourceType) => z.object({
  stage: z.literal(stage),
  sourceType: z.literal(sourceType),
  sourceRef: nonEmpty,
  status: z.enum(["hit", "miss", "skipped", "degraded"]),
  resultCount: z.number().int().min(0),
}).strict();

export const BrainSearchTraceSchema = z.object({
  selectedStrategy: z.enum(["journal-grep", "exact-brain", "entity", "hybrid", "history"]).nullable(),
  steps: z.tuple([
    searchTraceStep("journal-grep", "journal"),
    searchTraceStep("exact-brain", "brain"),
    searchTraceStep("entity", "entity-index"),
    searchTraceStep("hybrid", "hybrid-index"),
    searchTraceStep("history", "history"),
  ]),
}).strict().superRefine((value, context) => {
  const hits = value.steps.filter(({ status }) => status === "hit");
  if (value.selectedStrategy === null && hits.length) {
    context.addIssue({ code: "custom", path: ["selectedStrategy"], message: "must identify a hit" });
  }
  if (value.selectedStrategy !== null) {
    const selected = value.steps.find(({ stage }) => stage === value.selectedStrategy);
    if (selected?.status !== "hit") {
      context.addIssue({
        code: "custom", path: ["selectedStrategy"], message: "must refer to a step with status hit",
      });
    }
  }
});

export const BrainSearchResponseSchema = z.object({
  schemaVersion: z.literal("brain.search.response.v2"),
  contractVersion: z.literal(BRAIN_V2_CONTRACT_VERSION),
  query: nonEmpty,
  results: z.array(BrainSearchResultSchema),
  nextCursor: nonEmpty.nullable(),
  trace: BrainSearchTraceSchema,
  source: FreshnessSchema,
  metadata: BrainResponseMetadataSchema,
  capabilities: z.object({ goal: GoalCapabilitySchema }).strict(),
}).strict();

const journalBaseShape = {
  repository: nonEmpty,
  path: nonEmpty,
  period: nonEmpty,
  generatedAt: isoDateTime,
  sourceAsOf: isoDateTime,
  commitSha,
  lastSuccessfulSync: isoDateTime,
  freshness: FreshnessStateSchema,
  containsRestrictedContacts: z.literal(false),
  containsSecrets: z.literal(false),
};

export const DailyJournalFrontmatterSchema = z.object({
  schemaVersion: z.literal("daily-v1"),
  documentType: z.literal("daily"),
  date: isoDate,
  ...journalBaseShape,
}).strict().superRefine(validateFreshnessTimes);

export const WeeklyJournalFrontmatterSchema = z.object({
  schemaVersion: z.literal("weekly-v1"),
  documentType: z.literal("weekly"),
  weekStart: isoDate,
  weekEnd: isoDate,
  ...journalBaseShape,
}).strict().superRefine((value, context) => {
  validateFreshnessTimes(value, context);
  if (Date.parse(`${value.weekEnd}T00:00:00Z`) < Date.parse(`${value.weekStart}T00:00:00Z`)) {
    context.addIssue({ code: "custom", path: ["weekEnd"], message: "cannot be before weekStart" });
  }
});

const RESTRICTED_JOURNAL_PATTERNS = Object.freeze([
  { label: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu },
  { label: "phone number", pattern: /(?:\+?\d[\s().-]*){10,}/u },
  { label: "postal address", pattern: /\b\d{1,6}\s+[A-Za-z0-9.' -]+\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct)\b/iu },
  { label: "contact field", pattern: /^\s*(?:email|phone|address|contact)\s*:/imu },
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { label: "secret assignment", pattern: /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*\S+/iu },
  { label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
]);

function scalar(value, lineNumber) {
  const trimmed = value.trim();
  if (!trimmed) throw new TypeError(`journal frontmatter line ${lineNumber} has an empty value`);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new TypeError(`journal frontmatter line ${lineNumber} has an invalid quoted string`);
    }
  }
  if (/^[\[{]|[\]}]$/u.test(trimmed)) {
    throw new TypeError(`journal frontmatter line ${lineNumber} must use a scalar value`);
  }
  return trimmed;
}

export function parseJournalMarkdown(markdown) {
  if (typeof markdown !== "string") throw new TypeError("journal must be Markdown text");
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/u);
  if (!match) throw new TypeError("journal must begin with YAML frontmatter delimited by ---");
  const frontmatter = {};
  for (const [index, line] of match[1].split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u);
    if (!entry) throw new TypeError(`journal frontmatter line ${index + 2} is invalid`);
    const [, key, value] = entry;
    if (Object.hasOwn(frontmatter, key)) throw new TypeError(`journal frontmatter repeats ${key}`);
    frontmatter[key] = scalar(value, index + 2);
  }
  return { frontmatter, body: match[2].trim() };
}

export function assertJournalContainsNoRestrictedData(markdown) {
  for (const { label, pattern } of RESTRICTED_JOURNAL_PATTERNS) {
    if (pattern.test(markdown)) throw new TypeError(`journal contains forbidden ${label}`);
  }
}

export function validateJournalMarkdown(markdown) {
  const parsed = parseJournalMarkdown(markdown);
  const schemaVersion = parsed.frontmatter.schemaVersion;
  const schema = schemaVersion === "daily-v1"
    ? DailyJournalFrontmatterSchema
    : schemaVersion === "weekly-v1"
      ? WeeklyJournalFrontmatterSchema
      : null;
  if (!schema) throw new TypeError("journal schemaVersion must be daily-v1 or weekly-v1");
  const frontmatter = parseWithSchema(schema, parsed.frontmatter, `${schemaVersion} frontmatter`);
  if (!/^#\s+\S/mu.test(parsed.body)) throw new TypeError("journal body must contain an H1 heading");
  assertJournalContainsNoRestrictedData(parsed.body);
  return { frontmatter, body: parsed.body };
}

export const BrainV2HarnessSchema = z.object({
  schemaVersion: z.literal("brain-v2-harness-v1"),
  clock: isoDateTime,
  bootstrapRequest: BrainBootstrapRequestSchema,
  bootstrapResponse: BrainBootstrapResponseSchema,
  searchRequest: BrainSearchRequestSchema,
  searchResponse: BrainSearchResponseSchema,
  expected: z.object({
    hotBrainKeys: z.array(nonEmpty),
    searchResultKeys: z.array(nonEmpty),
    reconciliationActions: z.array(ReconciliationActionSchema),
    forgettingActions: z.array(z.enum(["keep", "review", "expire", "archive"])),
    journalSchemas: z.tuple([z.literal("daily-v1"), z.literal("weekly-v1")]),
    goalStatus: z.literal(GOAL_STATUS),
  }).strict(),
}).strict();

export const BRAIN_V2_SCHEMAS = Object.freeze({
  "brain.bootstrap.request.v2": BrainBootstrapRequestSchema,
  "brain.bootstrap.response.v2": BrainBootstrapResponseSchema,
  "brain.search.request.v2": BrainSearchRequestSchema,
  "brain.search.response.v2": BrainSearchResponseSchema,
  "daily-v1": DailyJournalFrontmatterSchema,
  "weekly-v1": WeeklyJournalFrontmatterSchema,
  "hot-brain-v2": HotBrainSchema,
  "reconciliation-v2": z.array(ReconciliationRecordSchema),
  "forgetting-v1": ForgettingPlanSchema,
  "brain-v2-harness-v1": BrainV2HarnessSchema,
});

export function parseWithSchema(schema, value, label = "value") {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : label}: ${issue.message}`)
    .join("; ");
  throw new TypeError(`${label} failed validation: ${details}`);
}

export function validateBrainV2Contract(schemaName, value) {
  const schema = BRAIN_V2_SCHEMAS[schemaName];
  if (!schema) throw new TypeError(`unknown Brain V2 schema: ${schemaName}`);
  return parseWithSchema(schema, value, schemaName);
}

export function brainV2JsonSchema(schemaName) {
  const schema = BRAIN_V2_SCHEMAS[schemaName];
  if (!schema) throw new TypeError(`unknown Brain V2 schema: ${schemaName}`);
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  });
}
