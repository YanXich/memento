/**
 * Minimal zod → JSON Schema (draft-07 subset) converter.
 * Covers exactly the shapes our tools need — no sprawling dependency for a
 * 60-line problem. Unsupported constructs degrade to `{}` (accept anything)
 * rather than throwing, so a plugin's exotic schema never bricks the toolset.
 */
import { z } from "zod";
import type { ToolSchema } from "../llm/types.ts";

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string; description?: string; [k: string]: unknown };
  const description = (schema as { description?: string }).description;
  const withDesc = (out: Record<string, unknown>): Record<string, unknown> =>
    description ? { ...out, description } : out;

  switch (def.typeName) {
    case "ZodString": {
      const out: Record<string, unknown> = { type: "string" };
      const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? [];
      for (const check of checks) {
        if (check.kind === "min") out.minLength = check.value;
        if (check.kind === "max") out.maxLength = check.value;
      }
      return withDesc(out);
    }
    case "ZodNumber": {
      const out: Record<string, unknown> = { type: "number" };
      const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? [];
      for (const check of checks) {
        if (check.kind === "min") out.minimum = check.value;
        if (check.kind === "max") out.maximum = check.value;
        if (check.kind === "int") out.type = "integer";
      }
      return withDesc(out);
    }
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodLiteral":
      return withDesc({ const: def.value });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values });
    case "ZodNativeEnum":
      return withDesc({ enum: Object.values(def.values as Record<string, unknown>) });
    case "ZodArray": {
      const items = zodToJsonSchema(def.type as z.ZodTypeAny);
      const checks = (def.checks as { kind: string; value?: number }[] | undefined) ?? [];
      const out: Record<string, unknown> = { type: "array", items };
      for (const check of checks) {
        if (check.kind === "min") out.minItems = check.value;
        if (check.kind === "max") out.maxItems = check.value;
      }
      return withDesc(out);
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodBranded":
    case "ZodReadonly": {
      const inner = def.typeName === "ZodBranded" || def.typeName === "ZodReadonly" || def.typeName === "ZodCatch"
        ? (def as { type?: z.ZodTypeAny }).type
        : def.typeName === "ZodDefault"
          ? undefined
          : (def.type as z.ZodTypeAny | undefined);
      // ZodDefault stores its inner schema on `innerType`; optional/nullable on `type`.
      const target = (def.typeName === "ZodDefault" ? (def as { innerType?: z.ZodTypeAny }).innerType : inner) as
        | z.ZodTypeAny
        | undefined;
      const out = target ? zodToJsonSchema(target) : {};
      return withDesc(out);
    }
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(field);
        if (!field.isOptional()) required.push(key);
      }
      const out: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) out.required = required;
      return withDesc(out);
    }
    case "ZodRecord": {
      const valueSchema = zodToJsonSchema(def.valueSchema as z.ZodTypeAny);
      return withDesc({ type: "object", additionalProperties: valueSchema });
    }
    case "ZodUnion": {
      const options = (def.options as z.ZodTypeAny[]).map(zodToJsonSchema);
      return withDesc({ anyOf: options });
    }
    case "ZodDiscriminatedUnion": {
      const options = [...(def.options as Set<z.ZodTypeAny>)].map(zodToJsonSchema);
      return withDesc({ anyOf: options });
    }
    case "ZodAny":
    case "ZodUnknown":
      return withDesc({});
    case "ZodNull":
      return withDesc({ type: "null" });
    case "ZodEffects":
      return zodToJsonSchema(def.schema as z.ZodTypeAny);
    default:
      return withDesc({});
  }
}

/**
 * Minimal JSON Schema → zod converter — the reverse direction, needed to
 * bridge external MCP tool schemas into the ToolRegistry.
 *
 * Covers the common MCP surface (object/string/number/integer/boolean/
 * array/enum/anyOf). Unknown constructs degrade to `z.unknown()` so an
 * exotic external schema never bricks the toolset; objects pass through
 * extra keys so the bridge doesn't silently strip what a server expects.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.unknown();

  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map(jsonSchemaToZod);
    if (options.length > 0) return z.union([options[0]!, options[1]!, ...options.slice(2)]);
  }
  if (Array.isArray(schema.enum)) {
    if (schema.enum.every((v) => typeof v === "string")) {
      const values = schema.enum as string[];
      if (values.length > 0) return z.enum([values[0]!, ...values.slice(1)]);
    }
    return z.unknown();
  }

  switch (schema.type) {
    case "object": {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = Array.isArray(schema.required) ? new Set(schema.required as string[]) : new Set<string>();
      const shape: z.ZodRawShape = {};
      if (properties) {
        for (const [key, value] of Object.entries(properties)) {
          const inner = jsonSchemaToZod(value);
          shape[key] = required.has(key) ? inner : inner.optional();
        }
      }
      // Passthrough: a server may accept keys its schema doesn't advertise.
      return z.object(shape).passthrough();
    }
    case "string":
      return z.string();
    case "integer":
      return z.number().int();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array": {
      const items = schema.items as Record<string, unknown> | undefined;
      return z.array(items ? jsonSchemaToZod(items) : z.unknown());
    }
    default:
      // No `type` but `properties` present — treat as an open object.
      if (schema.properties && typeof schema.properties === "object") {
        return jsonSchemaToZod({ ...schema, type: "object" });
      }
      return z.unknown();
  }
}
