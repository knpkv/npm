import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js"

const renderValidationError = ({ instancePath, message }: ErrorObject): string =>
  `${instancePath || "/"} ${message ?? "is invalid"}`

const isSchema = (value: unknown): value is AnySchema =>
  typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))

/** Compile the published schema and return every components.json validation failure. */
export const validateComponentsRegistry = (schema: unknown, components: unknown): ReadonlyArray<string> => {
  if (!isSchema(schema)) return ["/ schema must be an object or boolean"]
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  const validate = ajv.compile(schema)
  if (validate(components)) return []
  return (validate.errors ?? []).map(renderValidationError)
}
